"""Small read-only pullers for the existing V1 feed producers."""

from __future__ import annotations

import base64
import json
import re
import subprocess
import zipfile
from collections import defaultdict
from collections.abc import Mapping
from datetime import UTC, datetime
from pathlib import Path
from typing import TypedDict, cast

from .models import FeedComment


class _CapturedComment(TypedDict):
    text: str
    cid: int | None
    author: str | None
    is_original_poster: bool
    published_at: str | None
    reply_to_cid: int | None
    reply_to_author: str | None
    reply_to_text: str | None


_SSH_ALIAS = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}$")

_AI_DAILY_SCRIPT = """
import json
from pathlib import Path
root = Path('/srv/ai-daily/bridge/outbox')
prefixes = {
    'hotspot': 'china-hotspots-',
    'news': 'ai-news-',
    'learning': 'ai-learning-',
}
documents = []
for stream, prefix in prefixes.items():
    candidates = sorted(root.glob(prefix + '*.md'))
    if candidates:
        path = candidates[-1]
        documents.append({'stream': stream, 'name': path.name, 'markdown': path.read_text()})
print(json.dumps({'documents': documents}, ensure_ascii=False))
""".strip()

_TREEHOLE_SCRIPT = """
import base64
import json
from pathlib import Path
root = Path('/srv/pkuhole-observer-data/outbox/ready')
candidates = sorted(root.glob('*/*/*/*.json'))
if not candidates:
    raise SystemExit('no TreeHole snapshots')
path = candidates[-1]
captures = path.with_name(path.stem + '-captures.zip')
print(json.dumps({
    'payload': json.loads(path.read_text()),
    'captures_name': captures.name,
    'captures_zip': base64.b64encode(captures.read_bytes()).decode('ascii'),
}, ensure_ascii=False))
""".strip()


def _object(raw: str, *, label: str) -> dict[str, object]:
    loaded = cast(object, json.loads(raw))
    if not isinstance(loaded, dict):
        raise ValueError(f"{label} did not return a JSON object")
    return cast(dict[str, object], loaded)


class RemoteFeedPuller:
    def __init__(self, state: Path) -> None:
        self.state = state.resolve()

    def _python(self, alias: str, script: str, *, sudo: bool = False) -> str:
        if not _SSH_ALIAS.fullmatch(alias):
            raise ValueError(f"unsafe SSH alias: {alias!r}")
        encoded = base64.b64encode(script.encode("utf-8")).decode("ascii")
        prefix = "sudo -n " if sudo else ""
        command = f"{prefix}python3 -c \"import base64;exec(base64.b64decode('{encoded}'))\""
        result = subprocess.run(
            [
                "ssh",
                "-o",
                "BatchMode=yes",
                "-o",
                "ConnectTimeout=10",
                alias,
                command,
            ],
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=60,
        )
        if result.returncode != 0:
            detail = (
                result.stderr.strip().splitlines()[-1] if result.stderr.strip() else "SSH failed"
            )
            raise RuntimeError(f"{alias}: {detail}")
        return result.stdout

    def ai_daily(self, alias: str) -> tuple[tuple[str, str], ...]:
        payload = _object(self._python(alias, _AI_DAILY_SCRIPT, sudo=True), label="AI Daily")
        documents = payload.get("documents")
        if not isinstance(documents, list):
            raise ValueError("AI Daily producer returned no documents")
        result: list[tuple[str, str]] = []
        for value in cast(list[object], documents):
            if not isinstance(value, dict):
                continue
            item = cast(Mapping[str, object], value)
            stream = item.get("stream")
            markdown = item.get("markdown")
            if isinstance(stream, str) and isinstance(markdown, str):
                result.append((stream, markdown))
        if not result:
            raise ValueError("AI Daily producer returned no readable stream")
        return tuple(result)

    def treehole(self, alias: str) -> tuple[dict[str, object], Path]:
        result = _object(self._python(alias, _TREEHOLE_SCRIPT), label="TreeHole")
        payload = result.get("payload")
        encoded = result.get("captures_zip")
        name = result.get("captures_name")
        if (
            not isinstance(payload, dict)
            or not isinstance(encoded, str)
            or not isinstance(name, str)
        ):
            raise ValueError("TreeHole producer returned an incomplete snapshot")
        snapshot = cast(Mapping[str, object], payload).get("snapshot")
        snapshot_id = (
            str(cast(Mapping[str, object], snapshot).get("id"))
            if isinstance(snapshot, dict)
            else Path(name).stem.removesuffix("-captures")
        )
        if not snapshot_id or any(value in snapshot_id for value in ("/", "\\", "..")):
            raise ValueError("TreeHole producer returned an unsafe snapshot id")
        target = self.state / "feed-producer-input" / "treehole" / f"{snapshot_id}.zip"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(base64.b64decode(encoded, validate=True))
        return cast(dict[str, object], payload), target


def treehole_capture_context(
    archive: Path,
) -> tuple[dict[int, tuple[FeedComment, ...]], dict[int, tuple[str, ...]]]:
    comments: defaultdict[int, list[_CapturedComment]] = defaultdict(list)
    post_media: defaultdict[int, list[str]] = defaultdict(list)
    comment_media: defaultdict[int, list[str]] = defaultdict(list)
    with zipfile.ZipFile(archive) as bundle:
        names = set(bundle.namelist())
        for line in bundle.read("captures/comments.ndjson").splitlines():
            value = cast(object, json.loads(line))
            if not isinstance(value, dict):
                continue
            item = cast(Mapping[str, object], value)
            pid = item.get("pid")
            raw = item.get("raw")
            raw_values: Mapping[str, object] = (
                cast(Mapping[str, object], raw) if isinstance(raw, dict) else {}
            )
            text = raw_values.get("text")
            if isinstance(pid, int) and isinstance(text, str) and text.strip():
                timestamp = raw_values.get("timestamp")
                cid_value = item.get("cid")
                author_value = raw_values.get("name_tag")
                parent_value = raw_values.get("comment_id")
                quote = raw_values.get("quote")
                quote_values: Mapping[str, object] = (
                    cast(Mapping[str, object], quote) if isinstance(quote, dict) else {}
                )
                quote_cid = quote_values.get("cid")
                quote_author = quote_values.get("name_tag")
                quote_text = quote_values.get("text")
                comments[pid].append(
                    {
                        "text": text.strip(),
                        "cid": cid_value if isinstance(cid_value, int) else None,
                        "author": author_value if isinstance(author_value, str) else None,
                        "is_original_poster": raw_values.get("is_lz") == 1,
                        "published_at": (
                            datetime.fromtimestamp(timestamp, UTC).isoformat()
                            if isinstance(timestamp, (int, float))
                            and not isinstance(timestamp, bool)
                            else None
                        ),
                        "reply_to_cid": (
                            parent_value
                            if isinstance(parent_value, int)
                            and not isinstance(parent_value, bool)
                            else quote_cid
                            if isinstance(quote_cid, int) and not isinstance(quote_cid, bool)
                            else None
                        ),
                        "reply_to_author": (
                            quote_author.strip()
                            if isinstance(quote_author, str) and quote_author.strip()
                            else None
                        ),
                        "reply_to_text": (
                            quote_text.strip()
                            if isinstance(quote_text, str) and quote_text.strip()
                            else None
                        ),
                    }
                )
        index_value = cast(object, json.loads(bundle.read("media/index.json")))
        if isinstance(index_value, dict):
            items = cast(Mapping[str, object], index_value).get("items")
            if isinstance(items, list):
                for value in cast(list[object], items):
                    if not isinstance(value, dict):
                        continue
                    item = cast(Mapping[str, object], value)
                    pid = item.get("pid")
                    path = item.get("path")
                    mime = item.get("mime_type")
                    if (
                        isinstance(pid, int)
                        and isinstance(path, str)
                        and isinstance(mime, str)
                        and path in names
                    ):
                        encoded = base64.b64encode(bundle.read(path)).decode("ascii")
                        reference = f"data:{mime};base64,{encoded}"
                        owner_type = item.get("owner_type")
                        owner_id = item.get("owner_id")
                        if owner_type == "comment" and isinstance(owner_id, int):
                            comment_media[owner_id].append(reference)
                        else:
                            post_media[pid].append(reference)
    return (
        {
            pid: tuple(
                FeedComment(
                    text=str(value["text"]),
                    cid=value["cid"],
                    author=value["author"],
                    is_original_poster=value["is_original_poster"],
                    published_at=value["published_at"],
                    reply_to_cid=value["reply_to_cid"],
                    reply_to_author=value["reply_to_author"],
                    reply_to_text=value["reply_to_text"],
                    media=tuple(
                        dict.fromkeys(
                            comment_media.get(value["cid"] if value["cid"] is not None else -1, [])
                        )
                    ),
                )
                for value in values
            )
            for pid, values in comments.items()
        },
        {pid: tuple(dict.fromkeys(values)) for pid, values in post_media.items()},
    )
