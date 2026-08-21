"""Content-addressed immutable Original storage outside the Vault."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import tempfile
from collections.abc import Mapping
from pathlib import Path
from typing import cast
from urllib.parse import quote

from .models import OriginalRecord
from .routing import SUPPORTED_EXTENSIONS


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


class OriginalStore:
    def __init__(self, root: Path) -> None:
        self.root = root.resolve()

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
                    raise OSError("Original copy hash mismatch")
                os.replace(temporary, stored)
            finally:
                temporary.unlink(missing_ok=True)
        metadata = directory / "manifest.json"
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
                        value for value in cast(list[object], filenames) if isinstance(value, str)
                    )
        names.add(original_name)
        metadata.write_text(
            json.dumps(
                {
                    "sha256": digest,
                    "extension": extension,
                    "size_bytes": source.stat().st_size,
                    "filenames": sorted(names),
                },
                ensure_ascii=False,
                indent=2,
            )
            + "\n",
            encoding="utf-8",
            newline="\n",
        )
        resource = f"okf-original://sha256/{digest}/{quote(original_name, safe='-._~')}"
        return OriginalRecord(
            sha256=digest,
            filename=original_name,
            extension=extension,
            size_bytes=source.stat().st_size,
            stored_path=stored,
            resource=resource,
        )
