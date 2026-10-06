"""Explicit, repeatable migration from external Originals into a synced Vault.

Old bytes are retained for rollback. No network access or deletion is performed.
Run with Engine stopped and after backing up Vault and State.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path
from typing import cast
from urllib.parse import unquote

from okf_workspace.okf.file_io import atomic_write_bytes
from okf_workspace.okf.frontmatter import parse_document, render_document

from .originals import OriginalStore, VaultOriginalStore

RESOURCE = re.compile(r"okf-original://sha256/([0-9a-f]{64})/([^\s/?#)\]\"']+)")


def migrate_originals(vault: Path, originals: Path, state: Path) -> dict[str, object]:
    vault = vault.resolve()
    legacy = OriginalStore(originals)
    destination = VaultOriginalStore(vault, state)
    names: dict[str, str] = {}
    notes: list[Path] = []
    for root in ("sources", "learning", "knowledge", "projects", "inbox", "system/imports"):
        for path in (vault / root).rglob("*.md"):
            if not path.resolve().is_relative_to(vault):
                continue
            text = path.read_text(encoding="utf-8")
            matches = list(RESOURCE.finditer(text))
            if matches:
                notes.append(path)
                for match in matches:
                    names.setdefault(match[1], unquote(match[2]))
    for manifest in legacy.root.glob("sha256/*/*/manifest.json"):
        if not manifest.resolve().is_relative_to(legacy.root):
            raise ValueError("External Original manifest escapes its store")
        fields = cast(dict[str, object], json.loads(manifest.read_text(encoding="utf-8")))
        values = fields.get("filenames")
        if isinstance(values, list) and values and isinstance(values[0], str):
            names.setdefault(manifest.parent.name, values[0])
    resources: dict[str, str] = {}
    total_bytes = 0
    # Complete and verify the copy phase before changing any references.
    for digest, name in names.items():
        try:
            source = legacy.resolve(digest, verify=True)
        except FileNotFoundError:
            source = destination.resolve(digest, verify=True)
        record = destination.ingest(source, filename=name)
        resources[digest] = record.resource
        total_bytes += record.size_bytes

    def rewrite(value: object) -> object:
        if isinstance(value, str):
            return RESOURCE.sub(lambda match: resources.get(match[1], match[0]), value)
        if isinstance(value, list):
            return [rewrite(item) for item in cast(list[object], value)]
        if isinstance(value, dict):
            return {key: rewrite(item) for key, item in cast(dict[str, object], value).items()}
        return value

    changed: list[str] = []
    for path in notes:
        before = path.read_bytes()
        document = parse_document(before.decode("utf-8"))
        fields = cast(dict[str, object], rewrite(document.frontmatter))
        body = cast(str, rewrite(document.body))
        # Native wikilink for the old generated plain-text Original row.
        for resource in resources.values():
            body = body.replace(f"- 原件：{resource}\n", f"- 原件：[[{resource[1:]}]]\n")
        after = render_document(fields, body).encode("utf-8")
        if after != before:
            atomic_write_bytes(path, after, expected_sha256=hashlib.sha256(before).hexdigest())
            changed.append(path.relative_to(vault).as_posix())
    rebound = 0
    for path in (state / "conversions").glob("*/status.json"):
        before = path.read_bytes()
        fields = cast(dict[str, object], json.loads(before))
        resource = resources.get(str(fields.get("source_sha256")))
        if resource is None:
            continue
        target = str(vault / resource[1:])
        if fields.get("original_path") != target:
            fields["original_path"] = target
            payload = (json.dumps(fields, ensure_ascii=False, indent=2) + "\n").encode()
            atomic_write_bytes(path, payload, expected_sha256=hashlib.sha256(before).hexdigest())
            rebound += 1
    return {"originals": len(resources), "bytes": total_bytes, "updated_notes": changed,
            "updated_conversions": rebound, "resources": resources, "legacy_files_retained": True}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--vault", type=Path, required=True)
    parser.add_argument("--originals", type=Path, required=True)
    parser.add_argument("--state", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(migrate_originals(args.vault, args.originals, args.state), ensure_ascii=False))


if __name__ == "__main__":
    main()
