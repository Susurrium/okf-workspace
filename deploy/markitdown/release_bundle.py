#!/usr/bin/env python3
"""Verify/extract a MarkItDown release archive and prepare upgrade config."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import sys
import tarfile
from pathlib import Path, PurePosixPath

CHECKSUM_RE = re.compile(r"^([0-9a-f]{64})  ([A-Za-z0-9._-]+)\n?$")
SAFE_MEMBER_RE = re.compile(r"^[A-Za-z0-9_./-]+$")
ENV_ASSIGNMENT_RE = re.compile(r"^(MARKITDOWN_[A-Z0-9_]+)=(.*)$")
MAX_ARCHIVE_MEMBERS = 512
MAX_ARCHIVE_BYTES = 256 * 1024 * 1024
REQUIRED_MEMBERS = {
    "deploy/markitdown/compose.yaml",
    "deploy/markitdown/.env.example",
    "deploy/markitdown/deploy.sh",
    "deploy/markitdown/rollback.sh",
    "deploy/markitdown/rollback-release-bundle.sh",
    "deploy/markitdown/verify-release.sh",
    "release-manifest.sha256",
    "release-metadata.json",
    "services/markitdown/Dockerfile",
}
RELEASE_MANAGED_ENV_KEYS = {
    "MARKITDOWN_IMAGE",
    "MARKITDOWN_PYTHON_IMAGE",
    "MARKITDOWN_ENGINE_BUILD_ID",
    "MARKITDOWN_BUNDLE_MANIFEST_SHA256",
    "MARKITDOWN_RELEASE_MANIFEST_SHA256",
}
REQUIRED_PREVIOUS_ENV_KEYS = {
    "MARKITDOWN_IMAGE",
    "MARKITDOWN_ENGINE_BUILD_ID",
    "MARKITDOWN_UID",
    "MARKITDOWN_GID",
    "MARKITDOWN_HOST_PORT",
    "MARKITDOWN_DATA_ROOT",
    "MARKITDOWN_TOKEN_FILE",
    "MARKITDOWN_EXPECTED_MOUNT",
    "MARKITDOWN_EXPECTED_SOURCE",
    "MARKITDOWN_TAILNET_FQDN",
    "MARKITDOWN_BUNDLE_MANIFEST_SHA256",
    "MARKITDOWN_RELEASE_MANIFEST_SHA256",
}


class ReleaseBundleError(RuntimeError):
    """Raised when a release bundle is not safe to install."""


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _regular_file(path: Path, *, label: str) -> None:
    try:
        metadata = path.lstat()
    except FileNotFoundError as exc:
        raise ReleaseBundleError(f"{label} is missing: {path}") from exc
    if not stat.S_ISREG(metadata.st_mode):
        raise ReleaseBundleError(f"{label} must be a regular, non-linked file: {path}")


def _normalized_member(member: tarfile.TarInfo) -> str | None:
    raw_name = member.name
    if "\\" in raw_name or not SAFE_MEMBER_RE.fullmatch(raw_name):
        raise ReleaseBundleError(f"archive member has an unsafe name: {raw_name!r}")
    while raw_name.startswith("./"):
        raw_name = raw_name[2:]
    if raw_name in {"", "."}:
        if not member.isdir():
            raise ReleaseBundleError("archive root member is not a directory")
        return None
    path = PurePosixPath(raw_name)
    if path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
        raise ReleaseBundleError(f"archive member traverses outside the release: {raw_name}")
    if path.parts[0] not in {
        "deploy",
        "services",
        "release-metadata.json",
        "release-manifest.sha256",
    }:
        raise ReleaseBundleError(f"archive member is outside the release allowlist: {raw_name}")
    if not (member.isdir() or member.isreg()):
        raise ReleaseBundleError(f"archive member is not a regular file/directory: {raw_name}")
    return path.as_posix()


def verify_and_extract(archive: Path, checksum: Path, destination: Path) -> str:
    _regular_file(archive, label="release archive")
    _regular_file(checksum, label="release archive checksum")
    checksum_match = CHECKSUM_RE.fullmatch(checksum.read_text(encoding="utf-8"))
    if checksum_match is None:
        raise ReleaseBundleError("checksum file must contain one strict SHA-256 entry")
    expected_digest, expected_name = checksum_match.groups()
    if expected_name != archive.name:
        raise ReleaseBundleError("checksum filename does not match the selected archive")
    if _sha256(archive) != expected_digest:
        raise ReleaseBundleError("release archive SHA-256 mismatch")

    try:
        destination_metadata = destination.lstat()
    except FileNotFoundError as exc:
        raise ReleaseBundleError("destination must be an existing empty directory") from exc
    if not stat.S_ISDIR(destination_metadata.st_mode):
        raise ReleaseBundleError("destination must be a regular, non-linked directory")
    if any(destination.iterdir()):
        raise ReleaseBundleError("destination directory must be empty")

    with tarfile.open(archive, "r:gz") as release:
        members = release.getmembers()
        if len(members) > MAX_ARCHIVE_MEMBERS:
            raise ReleaseBundleError("release archive contains too many members")
        normalized_members: dict[str, tarfile.TarInfo] = {}
        total_bytes = 0
        for member in members:
            normalized = _normalized_member(member)
            if normalized is None:
                continue
            if normalized in normalized_members:
                raise ReleaseBundleError(f"release archive repeats a member: {normalized}")
            normalized_members[normalized] = member
            if member.isreg():
                if member.size < 0:
                    raise ReleaseBundleError("release archive contains a negative file size")
                total_bytes += member.size
                if total_bytes > MAX_ARCHIVE_BYTES:
                    raise ReleaseBundleError("release archive expands beyond the size limit")

        missing = REQUIRED_MEMBERS - normalized_members.keys()
        if missing:
            raise ReleaseBundleError(
                "release archive is incomplete: " + ", ".join(sorted(missing))
            )

        for relative_name, member in sorted(
            normalized_members.items(), key=lambda item: (item[0].count("/"), item[0])
        ):
            target = destination.joinpath(*PurePosixPath(relative_name).parts)
            if member.isdir():
                target.mkdir(mode=0o755, parents=True, exist_ok=True)
                continue
            target.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
            source = release.extractfile(member)
            if source is None:
                raise ReleaseBundleError(f"cannot read archive member: {relative_name}")
            try:
                descriptor = os.open(
                    target,
                    os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                    0o644,
                )
                with os.fdopen(descriptor, "wb") as destination_handle:
                    shutil.copyfileobj(source, destination_handle)
            finally:
                source.close()

    metadata_path = destination / "release-metadata.json"
    try:
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ReleaseBundleError("release metadata is not valid UTF-8 JSON") from exc
    if not isinstance(metadata, dict) or metadata.get("schema") != "okf-markitdown-release/v1":
        raise ReleaseBundleError("release metadata schema is unsupported")
    return _sha256(destination / "release-manifest.sha256")


def _parse_env(path: Path) -> tuple[list[str], dict[str, str]]:
    _regular_file(path, label="environment file")
    lines = path.read_text(encoding="utf-8").splitlines()
    values: dict[str, str] = {}
    for line in lines:
        if not line or line.startswith("#"):
            continue
        match = ENV_ASSIGNMENT_RE.fullmatch(line)
        if match is None:
            raise ReleaseBundleError(f"environment file has an unsupported line: {line!r}")
        key, value = match.groups()
        if key in values:
            raise ReleaseBundleError(f"environment file repeats {key}")
        if not value:
            raise ReleaseBundleError(f"environment file has an empty {key}")
        values[key] = value
    return lines, values


def prepare_upgrade_env(
    example: Path,
    previous: Path,
    output: Path,
    manifest_sha256: str,
) -> None:
    if not re.fullmatch(r"[0-9a-f]{64}", manifest_sha256):
        raise ReleaseBundleError("bundle manifest digest is invalid")
    example_lines, example_values = _parse_env(example)
    _previous_lines, previous_values = _parse_env(previous)
    missing = REQUIRED_PREVIOUS_ENV_KEYS - previous_values.keys()
    if missing:
        raise ReleaseBundleError(
            "previous environment is incomplete: " + ", ".join(sorted(missing))
        )
    unknown = previous_values.keys() - example_values.keys()
    if unknown:
        raise ReleaseBundleError(
            "new release cannot safely preserve environment keys: "
            + ", ".join(sorted(unknown))
        )

    selected: dict[str, str] = {}
    for key, new_default in example_values.items():
        if key in {
            "MARKITDOWN_BUNDLE_MANIFEST_SHA256",
            "MARKITDOWN_RELEASE_MANIFEST_SHA256",
        }:
            selected[key] = manifest_sha256
        elif key in RELEASE_MANAGED_ENV_KEYS:
            selected[key] = new_default
        else:
            selected[key] = previous_values.get(key, new_default)

    rendered: list[str] = []
    for line in example_lines:
        match = ENV_ASSIGNMENT_RE.fullmatch(line)
        rendered.append(f"{match.group(1)}={selected[match.group(1)]}" if match else line)
    output.write_text("\n".join(rendered) + "\n", encoding="utf-8", newline="\n")


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)

    extract = subparsers.add_parser("verify-extract")
    extract.add_argument("--archive", type=Path, required=True)
    extract.add_argument("--checksum", type=Path, required=True)
    extract.add_argument("--destination", type=Path, required=True)

    environment = subparsers.add_parser("prepare-upgrade-env")
    environment.add_argument("--example", type=Path, required=True)
    environment.add_argument("--previous", type=Path, required=True)
    environment.add_argument("--output", type=Path, required=True)
    environment.add_argument("--manifest-sha256", required=True)
    return parser


def main() -> int:
    args = _parser().parse_args()
    try:
        if args.command == "verify-extract":
            digest = verify_and_extract(args.archive, args.checksum, args.destination)
            print(digest)
        else:
            prepare_upgrade_env(
                args.example,
                args.previous,
                args.output,
                args.manifest_sha256,
            )
    except (OSError, ReleaseBundleError, tarfile.TarError) as exc:
        print(f"RELEASE BUNDLE FAILED: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
