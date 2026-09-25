from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest

from okf_workspace.feeds.decisions import FeedDecisionStore
from okf_workspace.feeds.models import DecisionAction, DecisionResult, FeedItem, FeedKind


def test_failed_receipt_replacement_preserves_previous_decision(tmp_path: Path) -> None:
    item = FeedItem(
        item_id="feed:item",
        feed=FeedKind.AI_DAILY,
        edition_id="2026-09-25-news",
        title="News",
        body="Content",
    )
    store = FeedDecisionStore(tmp_path)
    store.save(
        item,
        DecisionAction.IGNORE,
        result=DecisionResult(item.item_id, DecisionAction.IGNORE),
    )

    with patch("okf_workspace.okf.file_io.os.replace", side_effect=OSError("disk failure")):
        with pytest.raises(OSError, match="disk failure"):
            store.save(
                item,
                DecisionAction.SOURCE_ONLY,
                result=DecisionResult(item.item_id, DecisionAction.SOURCE_ONLY),
            )
        with pytest.raises(OSError, match="disk failure"):
            store.attach_semantic_operation(item, "operation-1")

    receipt = store.load(item)
    assert receipt is not None
    assert receipt["action"] == DecisionAction.IGNORE.value
    assert "semantic_operation_id" not in receipt
