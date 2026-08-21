from __future__ import annotations

import json
import zipfile
from pathlib import Path

from okf_workspace.feeds.remote import treehole_capture_context


def test_treehole_capture_context_preserves_comment_identity_and_media(
    tmp_path: Path,
) -> None:
    archive = tmp_path / "captures.zip"
    comment = {
        "pid": 8456471,
        "cid": 39015797,
        "raw": {
            "text": "第一行\n第二行",
            "name_tag": "Alice",
            "is_lz": 1,
            "timestamp": 1786804657,
        },
    }
    media = {
        "items": [
            {
                "pid": 8456471,
                "owner_type": "comment",
                "owner_id": 39015797,
                "mime_type": "image/jpeg",
                "path": "media/comment-image",
            },
            {
                "pid": 8456471,
                "owner_type": "post",
                "owner_id": 8456471,
                "mime_type": "image/png",
                "path": "media/post-image",
            },
        ]
    }
    with zipfile.ZipFile(archive, "w") as bundle:
        bundle.writestr("captures/comments.ndjson", json.dumps(comment, ensure_ascii=False))
        bundle.writestr("media/index.json", json.dumps(media))
        bundle.writestr("media/comment-image", b"comment")
        bundle.writestr("media/post-image", b"post")

    comments, post_media = treehole_capture_context(archive)

    captured = comments[8456471][0]
    assert captured.text == "第一行\n第二行"
    assert captured.cid == 39015797
    assert captured.author == "Alice"
    assert captured.is_original_poster is True
    assert captured.published_at == "2026-08-15T14:37:37+00:00"
    assert captured.media == ("data:image/jpeg;base64,Y29tbWVudA==",)
    assert post_media[8456471] == ("data:image/png;base64,cG9zdA==",)
