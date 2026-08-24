"""Small read-only pullers for the existing V1 feed producers."""

from __future__ import annotations

import base64
import hashlib
import json
import re
import subprocess
import uuid
import zipfile
from collections import defaultdict
from collections.abc import Mapping, Sequence
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
_AI_DAILY_SOURCE_ID = re.compile(r"^[a-z0-9][a-z0-9._-]{1,79}$")
_REGISTRY_REVISION = re.compile(r"^[0-9a-f]{64}$")
_SOURCE_ADMIN_RESPONSE_MAX_BYTES = 512 * 1024
_FEED_EXPORT_RESPONSE_MAX_BYTES = 16 * 1024 * 1024
_REMOTE_ERROR_CODE = re.compile(r"^[a-z][a-z0-9_]{0,79}$")
_SOURCE_ADMIN_ACTIONS = {
    "get",
    "list",
    "preview",
    "add",
    "enable",
    "disable",
    "remove",
}
AI_DAILY_REGISTRY_PATHS = (
    "/opt/ai-daily-bridge/config/bridge-sources.yaml",
    "/srv/ai-daily/bridge/config/sources.yaml",
)

_AI_DAILY_SCRIPT = """
import json
from pathlib import Path
root = Path('/srv/ai-daily/bridge/outbox')
registry_paths = tuple(Path(value) for value in __REGISTRY_PATHS__)
prefixes = {
    'hotspot': 'china-hotspots-',
    'news': 'ai-news-',
    'learning': 'ai-learning-',
}
sources = []
registry_errors = []
try:
    import yaml
except Exception as error:
    if any(path.is_file() for path in registry_paths):
        registry_errors.append('PyYAML unavailable: ' + error.__class__.__name__)
else:
    for registry_path in registry_paths:
        if not registry_path.is_file():
            continue
        try:
            registry = yaml.safe_load(registry_path.read_text())
            if not isinstance(registry, dict) or not isinstance(registry.get('sources', []), list):
                raise ValueError('registry must contain a sources list')
            for source in registry.get('sources', []):
                if not isinstance(source, dict):
                    continue
                if source.get('collection') == 'ai_learning':
                    sources.append({
                        'source_id': source.get('id'),
                        'source_name': source.get('name'),
                    })
        except Exception as error:
            registry_errors.append(
                str(registry_path) + ': ' + error.__class__.__name__
            )
documents = []
for stream, prefix in prefixes.items():
    candidates = sorted(root.glob(prefix + '*.md'))
    if candidates:
        path = candidates[-1]
        documents.append({'stream': stream, 'name': path.name, 'markdown': path.read_text()})
print(json.dumps({
    'documents': documents,
    'sources': sources,
    'registry_errors': registry_errors,
}, ensure_ascii=False))
""".replace("__REGISTRY_PATHS__", repr(AI_DAILY_REGISTRY_PATHS)).strip()

_AI_DAILY_HISTORY_HINTS_SCRIPT = """
import hashlib
import json
import re
from pathlib import Path
root = Path('/srv/ai-daily/bridge/outbox')
requested = set(__URL_DIGESTS__)
allowed_sources = set(__SOURCE_NAMES__)
item_heading = re.compile(
    r'^(?:#{2,4}\\s+)?\\d+\\.\\s+\\[(?P<title>.+)\\]\\((?P<url>https?://.+)\\)\\s*$'
)
markdown_heading = re.compile(r'^(?P<marks>#{2,4})\\s+(?P<title>.+?)\\s*$')
matches = {}
warnings = []
for history_path in reversed(sorted(root.glob('ai-learning-*.md'))):
    try:
        lines = history_path.read_text(encoding='utf-8').splitlines()
    except Exception as error:
        warnings.append(
            history_path.name + ': ' + error.__class__.__name__
        )
        continue
    source_name = None
    for line in lines:
        item_match = item_heading.fullmatch(line)
        if item_match is not None:
            digest = hashlib.sha256(item_match.group('url').encode('utf-8')).hexdigest()
            if source_name and digest in requested:
                matches.setdefault(digest, set()).add(source_name)
            continue
        heading = markdown_heading.fullmatch(line)
        if heading is not None and len(heading.group('marks')) == 2:
            candidate = heading.group('title').strip()
            source_name = candidate if candidate.casefold() in allowed_sources else None
print(json.dumps({
    'hints': [
        {'url_digest': digest, 'source_name': source_name}
        for digest, names in sorted(matches.items())
        for source_name in sorted(names)
    ],
    'warnings': warnings[:20],
}, ensure_ascii=False))
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


class RemoteProtocolError(RuntimeError):
    """A sanitized, structured failure from a fixed remote Feed command."""

    def __init__(
        self,
        code: str,
        message: str = "remote Feed request failed",
        *,
        retryable: bool = False,
        registry_revision: str | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.retryable = retryable
        self.registry_revision = registry_revision


class RemoteFeedPuller:
    def __init__(self, state: Path) -> None:
        self.state = state.resolve()
        self._ai_daily_source_ids_by_name: dict[str, str] = {}
        self._ai_daily_registry_warnings: tuple[str, ...] = ()
        self._ai_daily_registry_complete = True

    @property
    def ai_daily_source_ids_by_name(self) -> Mapping[str, str]:
        return dict(self._ai_daily_source_ids_by_name)

    @property
    def ai_daily_registry_warnings(self) -> tuple[str, ...]:
        return self._ai_daily_registry_warnings

    @property
    def ai_daily_registry_complete(self) -> bool:
        return self._ai_daily_registry_complete

    def _python(self, alias: str, script: str, *, sudo: bool = False) -> str:
        if not _SSH_ALIAS.fullmatch(alias):
            raise ValueError(f"unsafe SSH alias: {alias!r}")
        encoded = base64.b64encode(script.encode("utf-8")).decode("ascii")
        prefix = "sudo -n " if sudo else ""
        command = f"{prefix}python3 -c \"import base64;exec(base64.b64decode('{encoded}'))\""
        try:
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
        except subprocess.TimeoutExpired as exc:
            raise RuntimeError(
                f"{alias}: remote Feed request timed out after 60 seconds"
            ) from exc
        if result.returncode != 0:
            detail = (
                result.stderr.strip().splitlines()[-1] if result.stderr.strip() else "SSH failed"
            )
            raise RuntimeError(f"{alias}: {detail}")
        return result.stdout

    def _forced_json(
        self,
        alias: str,
        *,
        protocol: str,
        action: str,
        payload: Mapping[str, object],
        max_response_bytes: int,
    ) -> tuple[dict[str, object], str | None]:
        """Call an SSH forced command without supplying any remote shell text."""

        if not _SSH_ALIAS.fullmatch(alias):
            raise ValueError("unsafe SSH alias")
        request_id = uuid.uuid4().hex
        request = {
            **dict(payload),
            "protocol": protocol,
            "request_id": request_id,
            "action": action,
        }
        encoded = json.dumps(
            request,
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        )
        try:
            completed = subprocess.run(
                [
                    "ssh",
                    "-o",
                    "BatchMode=yes",
                    "-o",
                    "ConnectTimeout=10",
                    alias,
                ],
                check=False,
                capture_output=True,
                text=True,
                encoding="utf-8",
                timeout=90,
                input=encoded + "\n",
                shell=False,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise RemoteProtocolError(
                "remote_unavailable",
                "remote Feed service is unavailable",
                retryable=True,
            ) from exc
        stdout = completed.stdout
        if len(stdout.encode("utf-8")) > max_response_bytes:
            raise RemoteProtocolError(
                "response_too_large",
                "remote Feed response exceeds its transport limit",
            )
        lines = [line for line in stdout.splitlines() if line.strip()]
        if len(lines) != 1:
            if completed.returncode != 0:
                raise RemoteProtocolError(
                    "remote_unavailable",
                    "remote Feed service is unavailable",
                    retryable=True,
                )
            raise RemoteProtocolError(
                "invalid_response",
                "remote Feed service returned an invalid response",
            )
        try:
            response = _object(lines[0], label="remote Feed service")
        except (json.JSONDecodeError, ValueError) as exc:
            if completed.returncode != 0:
                raise RemoteProtocolError(
                    "remote_unavailable",
                    "remote Feed service is unavailable",
                    retryable=True,
                ) from exc
            raise RemoteProtocolError(
                "invalid_response",
                "remote Feed service returned an invalid response",
            ) from exc
        response_protocol = response.get("protocol")
        response_request_id = response.get("request_id")
        ok = response.get("ok")
        if (
            response_protocol != protocol
            or response_request_id != request_id
            or not isinstance(ok, bool)
            or (ok and completed.returncode != 0)
            or (not ok and completed.returncode not in {1, 2})
        ):
            raise RemoteProtocolError(
                "invalid_response",
                "remote Feed service returned an invalid response",
            )
        revision_value = response.get("registry_revision")
        if revision_value is not None and (
            not isinstance(revision_value, str)
            or _REGISTRY_REVISION.fullmatch(revision_value) is None
        ):
            raise RemoteProtocolError(
                "invalid_response",
                "remote Feed service returned an invalid response",
            )
        revision = (
            revision_value
            if isinstance(revision_value, str)
            and _REGISTRY_REVISION.fullmatch(revision_value)
            else None
        )
        if ok:
            result = response.get("result")
            if not isinstance(result, dict):
                raise RemoteProtocolError(
                    "invalid_response",
                    "remote Feed service returned an invalid response",
                )
            return cast(dict[str, object], result), revision
        error_value = response.get("error")
        if not isinstance(error_value, dict):
            raise RemoteProtocolError(
                "invalid_response",
                "remote Feed service returned an invalid response",
            )
        error = cast(Mapping[str, object], error_value)
        code = error.get("code")
        retryable = error.get("retryable")
        if (
            not isinstance(code, str)
            or _REMOTE_ERROR_CODE.fullmatch(code) is None
            or not isinstance(retryable, bool)
        ):
            raise RemoteProtocolError(
                "invalid_response",
                "remote Feed service returned an invalid response",
            )
        raise RemoteProtocolError(
            code[:80],
            f"remote Feed request failed ({code[:80]})",
            retryable=retryable,
            registry_revision=revision,
        )

    def source_admin(
        self,
        alias: str,
        action: str,
        payload: Mapping[str, object],
    ) -> tuple[dict[str, object], str]:
        if action not in _SOURCE_ADMIN_ACTIONS:
            raise ValueError("unsupported source-admin action")
        result, revision = self._forced_json(
            alias,
            protocol="source-admin.v1",
            action=action,
            payload=payload,
            max_response_bytes=_SOURCE_ADMIN_RESPONSE_MAX_BYTES,
        )
        if revision is None:
            raise RemoteProtocolError(
                "invalid_response",
                "source-admin response has no registry revision",
            )
        return result, revision

    def feed_export(
        self,
        alias: str,
        *,
        after: Mapping[str, str] | None,
        streams: Sequence[str] | None = None,
        limit: int = 30,
        include_registry: bool = True,
    ) -> dict[str, object]:
        if not 1 <= limit <= 30:
            raise ValueError("Feed export limit must be between 1 and 30")
        requested_streams = tuple(streams or ("hotspot", "news", "learning"))
        if (
            not requested_streams
            or len(set(requested_streams)) != len(requested_streams)
            or any(
                stream not in {"hotspot", "news", "learning", "papers"}
                for stream in requested_streams
            )
        ):
            raise ValueError("Feed export streams are invalid")
        result, _revision = self._forced_json(
            alias,
            protocol="feed-export.v1",
            action="sync",
            payload={
                "after": dict(after) if after is not None else None,
                "streams": list(requested_streams),
                "limit": limit,
                "include_registry": include_registry,
            },
            max_response_bytes=_FEED_EXPORT_RESPONSE_MAX_BYTES,
        )
        return result

    def ai_daily(self, alias: str) -> tuple[tuple[str, str], ...]:
        self._ai_daily_source_ids_by_name = {}
        self._ai_daily_registry_warnings = ()
        self._ai_daily_registry_complete = True
        payload = _object(self._python(alias, _AI_DAILY_SCRIPT, sudo=True), label="AI Daily")
        documents = payload.get("documents")
        if not isinstance(documents, list):
            raise ValueError("AI Daily producer returned no documents")
        source_candidates: defaultdict[str, set[str]] = defaultdict(set)
        sources = payload.get("sources", [])
        warnings: list[str] = []
        registry_errors = payload.get("registry_errors", [])
        if isinstance(registry_errors, list):
            self._ai_daily_registry_complete = not registry_errors
            warnings.extend(
                str(value).strip()[:300]
                for value in cast(list[object], registry_errors)
                if isinstance(value, str) and value.strip()
            )
        else:
            self._ai_daily_registry_complete = False
            warnings.append("registry_errors must be a list")
        if isinstance(sources, list):
            for value in cast(list[object], sources):
                if not isinstance(value, dict):
                    continue
                source = cast(Mapping[str, object], value)
                source_id = source.get("source_id")
                source_name = source.get("source_name")
                if (
                    isinstance(source_id, str)
                    and _AI_DAILY_SOURCE_ID.fullmatch(source_id.strip())
                    and isinstance(source_name, str)
                    and source_name.strip()
                ):
                    source_candidates[source_name.strip().casefold()].add(source_id.strip())
        if self._ai_daily_registry_complete:
            self._ai_daily_source_ids_by_name = {
                name: next(iter(source_ids))
                for name, source_ids in source_candidates.items()
                if len(source_ids) == 1
            }
        warnings.extend(
            f"source name maps to multiple ids: {name}"
            for name, source_ids in source_candidates.items()
            if len(source_ids) > 1
        )
        self._ai_daily_registry_warnings = tuple(dict.fromkeys(warnings))
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

    def ai_daily_history_source_hints(
        self,
        alias: str,
        urls: set[str],
    ) -> tuple[Mapping[str, tuple[str, str]], bool, tuple[str, ...]]:
        """Resolve a bounded set of exact legacy URLs only during cache migration."""

        normalized_urls = {
            url.strip()
            for url in urls
            if url.strip().startswith(("http://", "https://")) and len(url.strip()) <= 4096
        }
        if not normalized_urls:
            return {}, True, ()
        if len(normalized_urls) > 512:
            raise ValueError("AI Daily source migration has more than 512 unresolved URLs")
        urls_by_digest = {
            hashlib.sha256(url.encode("utf-8")).hexdigest(): url
            for url in normalized_urls
        }
        script = _AI_DAILY_HISTORY_HINTS_SCRIPT.replace(
            "__URL_DIGESTS__",
            repr(tuple(sorted(urls_by_digest))),
        ).replace(
            "__SOURCE_NAMES__",
            repr(tuple(sorted(self._ai_daily_source_ids_by_name))),
        )
        payload = _object(
            self._python(alias, script, sudo=True),
            label="AI Daily history hints",
        )
        warnings = list(self._ai_daily_registry_warnings)
        raw_warnings = payload.get("warnings", [])
        if isinstance(raw_warnings, list):
            warnings.extend(
                str(value).strip()[:300]
                for value in cast(list[object], raw_warnings)
                if isinstance(value, str) and value.strip()
            )
        candidates: defaultdict[str, set[tuple[str, str]]] = defaultdict(set)
        raw_hints = payload.get("hints", [])
        if isinstance(raw_hints, list):
            for value in cast(list[object], raw_hints):
                if not isinstance(value, dict):
                    continue
                hint = cast(Mapping[str, object], value)
                digest = hint.get("url_digest")
                source_name = hint.get("source_name")
                normalized_name = (
                    source_name.strip()
                    if isinstance(source_name, str) and source_name.strip()
                    else ""
                )
                stable_id = (
                    self._ai_daily_source_ids_by_name.get(normalized_name.casefold())
                    if normalized_name
                    else None
                )
                if (
                    isinstance(digest, str)
                    and digest in urls_by_digest
                    and stable_id is not None
                ):
                    candidates[digest].add((stable_id, normalized_name))
        warnings.extend(
            f"item URL hash maps to multiple sources: {digest[:16]}"
            for digest, identities in candidates.items()
            if len(identities) > 1
        )
        warnings.extend(
            f"item URL hash has no stable source: {digest[:16]}"
            for digest in urls_by_digest
            if digest not in candidates
        )
        self._ai_daily_registry_warnings = tuple(dict.fromkeys(warnings))
        unresolved_hashes = tuple(
            sorted(
                digest
                for digest in urls_by_digest
                if len(candidates.get(digest, ())) != 1
            )
        )
        return (
            {
                urls_by_digest[digest]: next(iter(identities))
                for digest, identities in candidates.items()
                if len(identities) == 1
            },
            not raw_warnings,
            unresolved_hashes,
        )

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
