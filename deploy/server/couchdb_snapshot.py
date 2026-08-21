#!/usr/bin/env python3
"""Create and restore logical CouchDB snapshots including attachments."""

from __future__ import annotations

import argparse
import base64
import gzip
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, cast
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen


def _credentials(path: Path) -> tuple[str, str]:
    loaded = cast(object, json.loads(path.read_text(encoding="utf-8")))
    if not isinstance(loaded, dict):
        raise ValueError("credential file must contain a JSON object")
    user = loaded.get("username")
    password = loaded.get("password")
    if not isinstance(user, str) or not isinstance(password, str) or not user or not password:
        raise ValueError("credential file requires username and password")
    return user, password


def _request(
    base_url: str,
    path: str,
    credentials: tuple[str, str],
    *,
    method: str = "GET",
    body: object | None = None,
) -> object:
    raw = None if body is None else json.dumps(body, separators=(",", ":")).encode("utf-8")
    token = base64.b64encode(f"{credentials[0]}:{credentials[1]}".encode()).decode()
    request = Request(
        f"{base_url.rstrip('/')}{path}",
        data=raw,
        method=method,
        headers={
            "authorization": f"Basic {token}",
            "content-type": "application/json",
            "accept": "application/json",
        },
    )
    with urlopen(request, timeout=120) as response:
        return cast(object, json.loads(response.read().decode("utf-8")))


def dump_database(base_url: str, database: str, credential_file: Path, output: Path) -> int:
    credentials = _credentials(credential_file)
    encoded = quote(database, safe="")
    payload = _request(
        base_url,
        f"/{encoded}/_all_docs?include_docs=true&attachments=true&update_seq=true",
        credentials,
    )
    if not isinstance(payload, dict):
        raise ValueError("unexpected CouchDB response")
    rows = payload.get("rows")
    if not isinstance(rows, list):
        raise ValueError("CouchDB response does not contain rows")
    docs = [
        row.get("doc")
        for row in rows
        if isinstance(row, dict) and isinstance(row.get("doc"), dict)
    ]
    snapshot = {
        "database": database,
        "update_seq": payload.get("update_seq"),
        "dumped_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "documents": docs,
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(output, "wt", encoding="utf-8") as handle:
        json.dump(snapshot, handle, ensure_ascii=False, separators=(",", ":"))
    return len(docs)


def _restorable_documents(documents: list[object]) -> list[dict[str, Any]]:
    restored: list[dict[str, Any]] = []
    for item in documents:
        if not isinstance(item, dict):
            continue
        document = dict(cast(dict[str, Any], item))
        document.pop("_rev", None)
        restored.append(document)
    return restored


def restore_database(base_url: str, credential_file: Path, snapshot_file: Path) -> int:
    credentials = _credentials(credential_file)
    with gzip.open(snapshot_file, "rt", encoding="utf-8") as handle:
        snapshot = cast(object, json.load(handle))
    if not isinstance(snapshot, dict):
        raise ValueError("snapshot root must be an object")
    database = snapshot.get("database")
    documents = snapshot.get("documents")
    if not isinstance(database, str) or not isinstance(documents, list):
        raise ValueError("snapshot is missing database or documents")
    encoded = quote(database, safe="")
    try:
        _request(base_url, f"/{encoded}", credentials, method="PUT")
    except HTTPError as exc:
        if exc.code != 412:
            raise
    restored = _restorable_documents(documents)
    response = _request(
        base_url,
        f"/{encoded}/_bulk_docs",
        credentials,
        method="POST",
        body={"docs": restored},
    )
    if not isinstance(response, list):
        raise ValueError("unexpected CouchDB bulk response")
    failures = [item for item in response if isinstance(item, dict) and item.get("error")]
    if failures:
        raise RuntimeError(f"CouchDB restore returned {len(failures)} document errors")
    return len(restored)


def main() -> int:
    parser = argparse.ArgumentParser()
    subcommands = parser.add_subparsers(dest="command", required=True)
    dump = subcommands.add_parser("dump")
    dump.add_argument("--url", required=True)
    dump.add_argument("--database", required=True)
    dump.add_argument("--credentials", type=Path, required=True)
    dump.add_argument("--output", type=Path, required=True)
    restore = subcommands.add_parser("restore")
    restore.add_argument("--url", required=True)
    restore.add_argument("--credentials", type=Path, required=True)
    restore.add_argument("--snapshot", type=Path, required=True)
    args = parser.parse_args()
    if args.command == "dump":
        count = dump_database(args.url, args.database, args.credentials, args.output)
        print(f"dumped {count} documents to {args.output}")
    else:
        count = restore_database(args.url, args.credentials, args.snapshot)
        print(f"restored {count} documents from {args.snapshot}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
