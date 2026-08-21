from __future__ import annotations

import importlib.util
from pathlib import Path
from types import ModuleType


def _module() -> ModuleType:
    path = Path(__file__).parents[3] / "deploy" / "server" / "couchdb_snapshot.py"
    spec = importlib.util.spec_from_file_location("couchdb_snapshot", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_restored_couchdb_documents_keep_ids_and_attachments_but_drop_revisions() -> None:
    module = _module()

    documents = module._restorable_documents(
        [
            {
                "_id": "note-1",
                "_rev": "3-private-revision",
                "path": "knowledge/wiki/a.md",
                "_attachments": {"data": {"data": "YWJj", "content_type": "text/plain"}},
            }
        ]
    )

    assert documents[0]["_id"] == "note-1"
    assert "_rev" not in documents[0]
    assert documents[0]["_attachments"]["data"]["data"] == "YWJj"
