#!/usr/bin/env python3
"""Generate and verify a content manifest for the local MinerU models."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import stat
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


class ManifestError(RuntimeError):
    pass


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(8 * 1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def model_roots(config_path: Path, base: Path) -> list[Path]:
    config = json.loads(config_path.read_text(encoding="utf-8"))
    roots: list[Path] = []
    for key in ("pipeline", "vlm"):
        raw = config.get("models-dir", {}).get(key)
        if not raw:
            raise ManifestError(f"models-dir.{key} is missing")
        root = Path(raw).resolve(strict=True)
        try:
            root.relative_to(base)
        except ValueError as exc:
            raise ManifestError(f"model root escaped MINERU_BASE: {root}") from exc
        roots.append(root)
    return roots


def files_below(roots: list[Path], base: Path) -> list[Path]:
    files: set[Path] = set()
    for root in roots:
        for path in root.rglob("*"):
            metadata = path.lstat()
            if stat.S_ISLNK(metadata.st_mode):
                raise ManifestError(f"model tree contains a symlink: {path}")
            if stat.S_ISREG(metadata.st_mode):
                resolved = path.resolve(strict=True)
                resolved.relative_to(base)
                files.add(resolved)
    if not files:
        raise ManifestError("model directories contain no files")
    return sorted(files)


def generate(config_path: Path, base: Path, manifest_path: Path) -> None:
    roots = model_roots(config_path, base)
    entries = []
    for index, path in enumerate(files_below(roots, base), start=1):
        size = path.stat().st_size
        print(f"hashing_model_file={index} size={size} path={path.name}", file=sys.stderr)
        entries.append(
            {
                "path": path.relative_to(base).as_posix(),
                "size": size,
                "sha256": sha256(path),
            }
        )
    payload: dict[str, Any] = {
        "schema": 1,
        "generated_at": datetime.now(UTC).isoformat(),
        "roots": [root.relative_to(base).as_posix() for root in roots],
        "files": entries,
    }
    manifest_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary = manifest_path.with_name(f".{manifest_path.name}.{os.getpid()}.tmp")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    fd = os.open(temporary, flags, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, manifest_path)
    finally:
        temporary.unlink(missing_ok=True)
    print(f"model_manifest_files={len(entries)}")


def load_manifest(manifest_path: Path) -> dict[str, Any]:
    metadata = manifest_path.lstat()
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
        raise ManifestError("model manifest must be a regular file")
    payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    if payload.get("schema") != 1 or not isinstance(payload.get("files"), list):
        raise ManifestError("unsupported or invalid model manifest")
    return payload


def verify(config_path: Path, base: Path, manifest_path: Path, *, full: bool) -> None:
    payload = load_manifest(manifest_path)
    roots = model_roots(config_path, base)
    actual = {path.relative_to(base).as_posix(): path for path in files_below(roots, base)}
    expected_entries = payload["files"]
    expected_names = {entry.get("path") for entry in expected_entries}
    if expected_names != set(actual):
        missing = sorted(expected_names - set(actual))
        extra = sorted(set(actual) - expected_names)
        raise ManifestError(f"model file set changed; missing={missing}, extra={extra}")
    for entry in expected_entries:
        relative = entry.get("path")
        size = entry.get("size")
        digest = entry.get("sha256")
        if (
            not isinstance(relative, str)
            or not isinstance(size, int)
            or not isinstance(digest, str)
        ):
            raise ManifestError("invalid model-manifest entry")
        path = actual[relative]
        if path.stat().st_size != size:
            raise ManifestError(f"model size changed: {relative}")
        if full and sha256(path) != digest:
            raise ManifestError(f"model checksum changed: {relative}")
    mode = "full" if full else "quick"
    print(f"model_manifest={mode}-verified files={len(expected_entries)}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("generate", "verify"))
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--base", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--full", action="store_true")
    args = parser.parse_args()
    base = args.base.resolve(strict=True)
    config = args.config.resolve(strict=True)
    if args.action == "generate":
        generate(config, base, args.manifest)
    else:
        verify(config, base, args.manifest, full=args.full)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ManifestError, OSError, ValueError, json.JSONDecodeError) as error:
        print(f"model-manifest: {error}", file=sys.stderr)
        raise SystemExit(2) from error
