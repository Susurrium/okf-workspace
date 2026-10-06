"""Vault attachments, plus a reader for the retired external Original store."""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import tempfile
from collections.abc import Mapping
from pathlib import Path
from typing import cast
from urllib.parse import quote

from okf_workspace.okf.file_io import atomic_write_bytes, document_lock

from .models import OriginalRecord
from .routing import SUPPORTED_EXTENSIONS


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


class OriginalStore:
    """Legacy external layout; used only by migration and old backup tooling."""
    def __init__(self, root: Path) -> None:
        self.root = root.resolve()

    def resolve(self, digest: str, *, verify: bool = False) -> Path:
        if not re.fullmatch(r"[0-9a-f]{64}", digest):
            raise ValueError("Invalid Original SHA-256")
        directory = self.root / "sha256" / digest[:2] / digest
        if not directory.resolve().is_relative_to(self.root):
            raise ValueError("Original is outside its store")
        changed = False
        for path in sorted(directory.glob("original.*")):
            if (path.suffix in SUPPORTED_EXTENSIONS and path.resolve().is_relative_to(directory)
                    and path.is_file()):
                if not verify or sha256_file(path) == digest:
                    return path
                changed = True
        if changed:
            raise ValueError("原件内容已改变，已保留现有文件；请将修改后的文件另存并重新导入")
        raise FileNotFoundError("Original is unavailable or damaged")

    def ingest(self, source: Path, *, filename: str | None = None) -> OriginalRecord:
        source = source.resolve()
        if not source.is_file():
            raise FileNotFoundError(source)
        original_name = Path(filename).name if filename is not None else source.name
        if not original_name or original_name in {".", ".."}:
            raise ValueError("Original filename is empty")
        extension = source.suffix.casefold()
        if Path(original_name).suffix.casefold() != extension:
            raise ValueError("Original filename extension does not match uploaded file")
        if extension not in SUPPORTED_EXTENSIONS:
            raise ValueError(f"unsupported Original extension: {extension}")
        digest = sha256_file(source)
        directory = self.root / "sha256" / digest[:2] / digest
        stored = directory / f"original{extension}"
        directory.mkdir(parents=True, exist_ok=True)
        metadata = directory / "manifest.json"
        with document_lock(metadata):
            if stored.exists() and sha256_file(stored) != digest:
                raise ValueError(
                    "Stored Original changed; preserve and reimport it as a new version"
                )
            if not stored.exists():
                descriptor, temporary_name = tempfile.mkstemp(
                    prefix=".original.",
                    suffix=extension,
                    dir=directory,
                )
                os.close(descriptor)
                temporary = Path(temporary_name)
                try:
                    shutil.copyfile(source, temporary)
                    if sha256_file(temporary) != digest:
                        raise OSError("Original copy hash mismatch") from None
                    os.replace(temporary, stored)
                finally:
                    temporary.unlink(missing_ok=True)
            names: set[str] = set()
            if metadata.exists():
                loaded_object = cast(
                    object,
                    json.loads(metadata.read_text(encoding="utf-8")),
                )
                if isinstance(loaded_object, dict):
                    loaded = cast(Mapping[str, object], loaded_object)
                    filenames = loaded.get("filenames")
                    if isinstance(filenames, list):
                        names.update(
                            value
                            for value in cast(list[object], filenames)
                            if isinstance(value, str)
                        )
            names.add(original_name)
            atomic_write_bytes(
                metadata,
                (
                    json.dumps(
                        {
                            "sha256": digest,
                            "extension": extension,
                            "size_bytes": stored.stat().st_size,
                            "filenames": sorted(names),
                        },
                        ensure_ascii=False,
                        indent=2,
                    )
                    + "\n"
                ).encode("utf-8"),
            )
        resource = f"okf-original://sha256/{digest}/{quote(original_name, safe='-._~')}"
        return OriginalRecord(
            sha256=digest,
            filename=original_name,
            extension=extension,
            size_bytes=stored.stat().st_size,
            stored_path=stored,
            resource=resource,
        )


class VaultOriginalStore(OriginalStore):
    """Ordinary Vault files, replicated and opened by Obsidian itself.

    The digest directory prevents collisions between same-name documents. No
    manifest, credentials, download cache or second transport is needed.
    """

    def __init__(self, vault: Path, state: Path) -> None:
        self.vault = vault.resolve()
        self.root = self.vault / "sources" / "originals"
        self.locks = state.resolve() / "original-locks"

    def _directory(self, digest: str) -> Path:
        if not re.fullmatch(r"[0-9a-f]{64}", digest):
            raise ValueError("Invalid Original SHA-256")
        directory = self.root / digest
        if not directory.resolve().is_relative_to(self.vault):
            raise ValueError("Original is outside the Vault")
        return directory

    def resolve(self, digest: str, *, verify: bool = False) -> Path:
        directory = self._directory(digest)
        changed = False
        for path in sorted(directory.glob("*")):
            if (path.is_file() and path.suffix.lower() in SUPPORTED_EXTENSIONS
                    and path.resolve().is_relative_to(directory.resolve())):
                if not verify or sha256_file(path) == digest:
                    return path
                changed = True
        if changed:
            raise ValueError("原件内容已改变，已保留现有文件；请另存并重新导入")
        raise FileNotFoundError("原件尚未同步到本机")

    def ingest(self, source: Path, *, filename: str | None = None) -> OriginalRecord:
        source = source.resolve()
        if not source.is_file():
            raise FileNotFoundError(source)
        name = re.sub(r'[<>:"/\\|?*\x00-\x1f\[\]#^]', "_", filename or source.name).rstrip(". ")
        extension = source.suffix.lower()
        if not name or Path(name).suffix.lower() != extension:
            raise ValueError("Original filename extension does not match uploaded file")
        if extension not in SUPPORTED_EXTENSIONS:
            raise ValueError(f"unsupported Original extension: {extension}")
        digest = sha256_file(source)
        directory = self._directory(digest)
        with document_lock(self.locks / digest):
            try:
                stored = self.resolve(digest, verify=True)
            except FileNotFoundError:
                stored = directory / name
                contents = source.read_bytes()
                if hashlib.sha256(contents).hexdigest() != digest:
                    raise OSError("Original changed while being copied") from None
                atomic_write_bytes(stored, contents, create_only=True)
                if sha256_file(stored) != digest:
                    raise OSError("Original copy hash mismatch") from None
        return OriginalRecord(
            sha256=digest, filename=name, extension=extension,
            size_bytes=stored.stat().st_size, stored_path=stored,
            resource="/" + stored.relative_to(self.vault).as_posix(),
        )
