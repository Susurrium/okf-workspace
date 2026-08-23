"""Durable local state and remote administration for Reading subscriptions."""

from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
from collections.abc import Generator, Mapping, Sequence
from contextlib import contextmanager
from dataclasses import asdict, dataclass, replace
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal, cast
from urllib.parse import urlsplit

from .cache import exclusive_feed_cache_lock
from .remote import RemoteFeedPuller, RemoteProtocolError

_REVISION = re.compile(r"^[0-9a-f]{64}$")
_SOURCE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
_ADDABLE_ADAPTERS = {"rss", "github_repository", "github_releases"}
_MANAGEMENT_ADAPTERS = {*_ADDABLE_ADAPTERS, "ruanyf_weekly"}
_CONTENT_MODES = {"summary", "full"}
_MAX_SOURCES = 2_000
_ERROR_TYPE = re.compile(r"^[A-Za-z0-9._-]{1,120}$")
_SENSITIVE_ERROR_MARKERS = (
    "://",
    "?",
    "token",
    "secret",
    "password",
    "authorization",
    "credential",
)


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _parse_time(value: object, *, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field} must be a timestamp")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError(f"{field} must be a timestamp") from exc
    if parsed.tzinfo is None:
        raise ValueError(f"{field} must include a timezone")
    return value


def _optional_time(value: object, *, field: str) -> str | None:
    return None if value is None else _parse_time(value, field=field)


def _required_string(value: object, *, field: str, limit: int) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field} must be a non-empty string")
    normalized = value.strip()
    if len(normalized) > limit:
        raise ValueError(f"{field} exceeds {limit} characters")
    return normalized


def _canonical_url(value: object) -> str:
    url = _required_string(value, field="canonical_url", limit=4096)
    parsed = urlsplit(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("canonical_url must be an HTTP(S) URL")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("canonical_url must not contain credentials")
    return url


def _projected_url(value: object) -> str:
    url = _canonical_url(value)
    parsed = urlsplit(url)
    if parsed.query or parsed.fragment:
        raise ValueError("projected canonical_url must not contain query or fragment")
    return url


def _projected_source_origin(value: object) -> str:
    url = _projected_url(value)
    parsed = urlsplit(url)
    if parsed.path not in {"", "/"}:
        raise ValueError("projected source URL must contain only its origin")
    return url


def safe_remote_error_summary(value: object) -> str | None:
    if value is None:
        return None
    summary = _required_string(value, field="last_error", limit=500)
    folded = summary.casefold()
    if any(marker in folded for marker in _SENSITIVE_ERROR_MARKERS):
        return "来源更新失败，详情已隐藏"
    return summary


def safe_remote_error_type(value: object) -> str | None:
    if value is None:
        return None
    error_type = _required_string(value, field="last_error_type", limit=120)
    return error_type if _ERROR_TYPE.fullmatch(error_type) is not None else None


def _revision(value: object) -> str:
    if not isinstance(value, str) or _REVISION.fullmatch(value) is None:
        raise ValueError("registry revision must be a SHA-256 digest")
    return value


def _atomic_json(path: Path, payload: Mapping[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, name = tempfile.mkstemp(
        prefix=f".{path.name}.",
        suffix=".tmp",
        dir=path.parent,
    )
    temporary = Path(name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _json_object(path: Path) -> dict[str, object]:
    loaded = cast(object, json.loads(path.read_text(encoding="utf-8")))
    if not isinstance(loaded, dict):
        raise ValueError("subscription state must contain a JSON object")
    return cast(dict[str, object], loaded)


@dataclass(frozen=True, slots=True)
class ManagementSource:
    source_id: str
    source_name: str
    canonical_url: str
    url_redacted: bool
    adapter: str
    enabled: bool
    required: bool
    added_at: str | None
    content_mode: str
    content_max_chars: int
    status: Literal["enabled", "disabled", "error", "removed"]
    last_success_at: str | None
    last_error_at: str | None
    last_error_type: str | None
    last_error: str | None

    @classmethod
    def parse(
        cls,
        value: Mapping[str, object],
        *,
        allow_removed: bool = False,
    ) -> ManagementSource:
        source_id = _required_string(value.get("source_id"), field="source_id", limit=128)
        if _SOURCE_ID.fullmatch(source_id) is None:
            raise ValueError("source_id contains unsupported characters")
        adapter = _required_string(value.get("adapter"), field="adapter", limit=40)
        if adapter not in _MANAGEMENT_ADAPTERS:
            raise ValueError("source adapter is unsupported")
        enabled = value.get("enabled")
        required = value.get("required")
        if not isinstance(enabled, bool) or not isinstance(required, bool):
            raise ValueError("source enabled/required fields must be booleans")
        content_mode = _required_string(
            value.get("content_mode"), field="content_mode", limit=20
        )
        if content_mode not in _CONTENT_MODES:
            raise ValueError("source content_mode is unsupported")
        content_max_chars = value.get("content_max_chars")
        url_redacted_value = value.get("url_redacted")
        if url_redacted_value is None:
            # Old local mirrors may contain the original URL. Be conservative
            # until the next source-admin refresh supplies the explicit flag.
            url_redacted = True
        elif isinstance(url_redacted_value, bool):
            url_redacted = url_redacted_value
        else:
            raise ValueError("source url_redacted must be a boolean")
        if (
            isinstance(content_max_chars, bool)
            or not isinstance(content_max_chars, int)
            or not 100 <= content_max_chars <= 20_000
        ):
            raise ValueError("source content_max_chars is out of range")
        status_value = value.get("status")
        valid_statuses = {"enabled", "disabled", "error"}
        if allow_removed:
            valid_statuses.add("removed")
        if not isinstance(status_value, str) or status_value not in valid_statuses:
            raise ValueError("source status is unsupported")
        return cls(
            source_id=source_id,
            source_name=_required_string(
                value.get("source_name"), field="source_name", limit=300
            ),
            canonical_url=_projected_source_origin(value.get("canonical_url")),
            url_redacted=url_redacted,
            adapter=adapter,
            enabled=enabled,
            required=required,
            added_at=_optional_time(value.get("added_at"), field="added_at"),
            content_mode=content_mode,
            content_max_chars=content_max_chars,
            status=cast(
                Literal["enabled", "disabled", "error", "removed"], status_value
            ),
            last_success_at=_optional_time(
                value.get("last_success_at"), field="last_success_at"
            ),
            last_error_at=_optional_time(value.get("last_error_at"), field="last_error_at"),
            last_error_type=safe_remote_error_type(value.get("last_error_type")),
            last_error=safe_remote_error_summary(value.get("last_error")),
        )


@dataclass(frozen=True, slots=True)
class RegistryMirrorSnapshot:
    registry_revision: str | None
    updated_at: str | None
    sources: tuple[ManagementSource, ...]


class _LockedSourceRegistryMirror:
    def __init__(self, owner: SourceRegistryMirror) -> None:
        self.owner = owner

    def load(self) -> RegistryMirrorSnapshot:
        return self.owner.load_locked()

    def replace(
        self,
        registry_revision: str,
        sources: Sequence[Mapping[str, object] | ManagementSource],
    ) -> RegistryMirrorSnapshot:
        return self.owner.replace_locked(registry_revision, sources)

    def upsert(
        self,
        registry_revision: str,
        source: Mapping[str, object] | ManagementSource,
    ) -> RegistryMirrorSnapshot:
        current = self.load()
        parsed = (
            source
            if isinstance(source, ManagementSource)
            else ManagementSource.parse(source)
        )
        values = {
            value.source_id: value
            for value in current.sources
            if value.source_id != parsed.source_id
        }
        values[parsed.source_id] = parsed
        return self.owner.write_locked(registry_revision, tuple(values.values()))

    def remove(self, registry_revision: str, source_id: str) -> RegistryMirrorSnapshot:
        current = self.load()
        prior = next((value for value in current.sources if value.source_id == source_id), None)
        if prior is None:
            raise KeyError(source_id)
        removed = replace(prior, enabled=False, status="removed")
        values = {
            value.source_id: value
            for value in current.sources
            if value.source_id != source_id
        }
        values[source_id] = removed
        return self.owner.write_locked(registry_revision, tuple(values.values()))


class SourceRegistryMirror:
    """Atomic State mirror of the remote source registry, including tombstones."""

    def __init__(self, state: Path) -> None:
        self.state = state.resolve()
        self.root = self.state / "feed-subscriptions"
        self.path = self.root / "registry-mirror.json"
        self.lock_path = self.root / ".registry.lock"

    @contextmanager
    def locked(self) -> Generator[_LockedSourceRegistryMirror]:
        with exclusive_feed_cache_lock(self.lock_path):
            yield _LockedSourceRegistryMirror(self)

    def load_locked(self) -> RegistryMirrorSnapshot:
        if not self.path.is_file():
            return RegistryMirrorSnapshot(None, None, ())
        value = _json_object(self.path)
        if value.get("version") != 1:
            raise ValueError("subscription registry mirror version is unsupported")
        revision_value = value.get("registry_revision")
        revision = None if revision_value is None else _revision(revision_value)
        updated_at = _optional_time(value.get("updated_at"), field="updated_at")
        sources_value = value.get("sources")
        if not isinstance(sources_value, list):
            raise ValueError("subscription registry mirror sources are invalid")
        raw_sources = cast(list[object], sources_value)
        if len(raw_sources) > _MAX_SOURCES:
            raise ValueError("subscription registry mirror sources are invalid")
        sources: list[ManagementSource] = []
        seen: set[str] = set()
        for item in raw_sources:
            if not isinstance(item, dict):
                raise ValueError("subscription registry source must be an object")
            source = ManagementSource.parse(
                cast(Mapping[str, object], item), allow_removed=True
            )
            if source.source_id in seen:
                raise ValueError("subscription registry mirror contains duplicate ids")
            seen.add(source.source_id)
            sources.append(source)
        return RegistryMirrorSnapshot(revision, updated_at, tuple(sources))

    def write_locked(
        self,
        registry_revision: str,
        sources: Sequence[ManagementSource],
    ) -> RegistryMirrorSnapshot:
        revision = _revision(registry_revision)
        if len(sources) > _MAX_SOURCES:
            raise ValueError("subscription registry contains too many sources")
        ordered = tuple(sorted(sources, key=lambda value: value.source_id))
        updated_at = _now()
        _atomic_json(
            self.path,
            {
                "version": 1,
                "registry_revision": revision,
                "updated_at": updated_at,
                "sources": [asdict(source) for source in ordered],
            },
        )
        return RegistryMirrorSnapshot(revision, updated_at, ordered)

    def replace_locked(
        self,
        registry_revision: str,
        sources: Sequence[Mapping[str, object] | ManagementSource],
    ) -> RegistryMirrorSnapshot:
        parsed = tuple(
            value if isinstance(value, ManagementSource) else ManagementSource.parse(value)
            for value in sources
        )
        if len({value.source_id for value in parsed}) != len(parsed):
            raise ValueError("subscription registry contains duplicate ids")
        incoming_ids = {value.source_id for value in parsed}
        tombstones = tuple(
            value
            for value in self.load_locked().sources
            if value.status == "removed" and value.source_id not in incoming_ids
        )
        return self.write_locked(registry_revision, (*parsed, *tombstones))

    def load(self) -> RegistryMirrorSnapshot:
        with self.locked() as locked:
            return locked.load()

    def replace(
        self,
        registry_revision: str,
        sources: Sequence[Mapping[str, object] | ManagementSource],
    ) -> RegistryMirrorSnapshot:
        with self.locked() as locked:
            return locked.replace(registry_revision, sources)

    def upsert(
        self,
        registry_revision: str,
        source: Mapping[str, object] | ManagementSource,
    ) -> RegistryMirrorSnapshot:
        with self.locked() as locked:
            return locked.upsert(registry_revision, source)

    def remove(self, registry_revision: str, source_id: str) -> RegistryMirrorSnapshot:
        with self.locked() as locked:
            return locked.remove(registry_revision, source_id)


class SubscriptionError(RuntimeError):
    def __init__(
        self,
        status_code: int,
        code: str,
        message: str,
        *,
        retryable: bool = False,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message
        self.retryable = retryable

    def public(self) -> dict[str, object]:
        return {
            "code": self.code,
            "message": self.message,
            "retryable": self.retryable,
        }


def _remote_error(error: RemoteProtocolError) -> SubscriptionError:
    code = error.code
    if code in {"remote_unavailable", "timeout"}:
        return SubscriptionError(
            503, code, "订阅服务暂时不可用", retryable=True
        )
    if code in {
        "stale_preview",
        "stale_registry",
        "revision_conflict",
        "registry_revision_conflict",
    }:
        return SubscriptionError(409, code, "订阅列表已更新，请刷新后重试")
    if code in {"idempotency_conflict", "conflict"}:
        return SubscriptionError(409, code, "操作标识已被另一项请求使用")
    if code == "source_exists":
        return SubscriptionError(409, code, "这个来源已经订阅")
    if code == "source_name_conflict":
        return SubscriptionError(409, code, "来源名称已存在，请修改名称后重试")
    if code == "protected_source":
        return SubscriptionError(409, code, "这个内置来源不能移除")
    if code == "preview_expired":
        return SubscriptionError(410, code, "订阅预览已过期，请重新预览")
    if code in {"preview_not_found", "source_not_found", "not_found"}:
        return SubscriptionError(404, code, "没有找到对应的订阅或预览")
    if code in {
        "invalid_request",
        "invalid_json",
        "unsupported_action",
        "unsupported_protocol",
        "unsupported_content_mode",
        "confirmation_required",
        "invalid_cursor",
        "unsafe_url",
    }:
        return SubscriptionError(400, code, "订阅请求无效")
    if code in {"discovery_failed", "detection_failed", "preview_invalid"}:
        return SubscriptionError(422, code, "无法识别这个订阅地址")
    if code == "invalid_source_name":
        return SubscriptionError(422, code, "来源名称无效，请修改名称后重试")
    if code in {
        "lock_busy",
        "registry_unavailable",
        "idempotency_unavailable",
        "internal_error",
    }:
        return SubscriptionError(503, code, "订阅服务暂时繁忙", retryable=True)
    if code == "command_rejected":
        return SubscriptionError(403, code, "远端拒绝了这项订阅操作")
    return SubscriptionError(
        502,
        code,
        "订阅服务返回了无法识别的响应",
        retryable=error.retryable,
    )


class SubscriptionService:
    def __init__(self, state: Path) -> None:
        self.state = state.resolve()
        self.config_path = self.state / "feed-producers.json"
        self.mirror = SourceRegistryMirror(self.state)
        self.previews = self.mirror.root / "previews"
        self.receipts = self.mirror.root / "receipts"
        self.puller = RemoteFeedPuller(self.state)

    def _alias(self) -> str:
        if not self.config_path.is_file():
            raise SubscriptionError(503, "unconfigured", "尚未配置订阅服务")
        try:
            loaded = cast(object, json.loads(self.config_path.read_text(encoding="utf-8")))
        except (OSError, json.JSONDecodeError) as exc:
            raise SubscriptionError(503, "unconfigured", "订阅服务配置不可用") from exc
        if not isinstance(loaded, dict):
            raise SubscriptionError(503, "unconfigured", "订阅服务配置不可用")
        feed = cast(Mapping[str, object], loaded).get("ai-daily")
        alias = (
            cast(Mapping[str, object], feed).get("source_admin_ssh_alias")
            if isinstance(feed, dict)
            else None
        )
        if not isinstance(alias, str) or not alias.strip():
            raise SubscriptionError(503, "unconfigured", "尚未配置订阅服务")
        return alias.strip()

    @staticmethod
    def _opaque_path(root: Path, value: str) -> Path:
        digest = hashlib.sha256(value.encode("utf-8")).hexdigest()
        return root / f"{digest}.json"

    def _admin(
        self,
        action: str,
        payload: Mapping[str, object],
    ) -> tuple[dict[str, object], str]:
        try:
            return self.puller.source_admin(self._alias(), action, payload)
        except RemoteProtocolError as error:
            raise _remote_error(error) from error
        except (OSError, TypeError, ValueError) as error:
            raise SubscriptionError(
                502, "invalid_response", "订阅服务返回了无法识别的响应"
            ) from error

    def list_sources(self) -> dict[str, object]:
        try:
            with self.mirror.locked() as locked:
                result, revision = self._admin("list", {})
                raw_sources = result.get("sources")
                count = result.get("count")
                if not isinstance(raw_sources, list):
                    raise SubscriptionError(
                        502, "invalid_response", "订阅服务返回了无法识别的响应"
                    )
                source_values = cast(list[object], raw_sources)
                if (
                    isinstance(count, bool)
                    or not isinstance(count, int)
                    or count != len(source_values)
                ):
                    raise SubscriptionError(
                        502, "invalid_response", "订阅服务返回了无法识别的响应"
                    )
                mappings: list[Mapping[str, object]] = []
                for value in source_values:
                    if not isinstance(value, dict):
                        raise SubscriptionError(
                            502, "invalid_response", "订阅服务返回了无法识别的响应"
                        )
                    mappings.append(cast(Mapping[str, object], value))
                try:
                    snapshot = locked.replace(revision, mappings)
                except ValueError as validation_error:
                    raise SubscriptionError(
                        502,
                        "invalid_response",
                        "订阅服务返回了无法识别的响应",
                    ) from validation_error
            return self._list_payload(snapshot, remote_status="current")
        except SubscriptionError as error:
            try:
                snapshot = self.mirror.load()
            except (OSError, ValueError) as state_error:
                raise error from state_error
            if not snapshot.sources:
                raise error
            remote_status: Literal["stale", "unconfigured"] = (
                "unconfigured" if error.code == "unconfigured" else "stale"
            )
            payload = self._list_payload(snapshot, remote_status=remote_status)
            payload["error"] = error.public()
            return payload

    @staticmethod
    def _list_payload(
        snapshot: RegistryMirrorSnapshot,
        *,
        remote_status: Literal["current", "stale", "unconfigured"],
    ) -> dict[str, object]:
        return {
            "registry_revision": snapshot.registry_revision,
            "sources": [asdict(source) for source in snapshot.sources],
            "count": len(snapshot.sources),
            "mirror_updated_at": snapshot.updated_at,
            "remote_status": remote_status,
        }

    def preview(self, payload: Mapping[str, object]) -> dict[str, object]:
        result, revision = self._admin("preview", payload)
        if set(result) != {
            "preview_id",
            "expires_at",
            "detected_adapter",
            "detected_from",
            "canonical_url",
            "url_redacted",
            "source_id",
            "source_name",
            "existing_source_id",
            "entries",
            "defaults",
            "capabilities",
            "warnings",
        }:
            raise SubscriptionError(502, "invalid_response", "订阅预览内容无效")
        try:
            preview_id = _required_string(
                result.get("preview_id"), field="preview_id", limit=300
            )
            expires_at = _parse_time(result.get("expires_at"), field="expires_at")
            canonical_url = _projected_source_origin(result.get("canonical_url"))
            url_redacted = result.get("url_redacted")
            if not isinstance(url_redacted, bool):
                raise ValueError("url_redacted must be a boolean")
            source_id = _required_string(
                result.get("source_id"), field="source_id", limit=128
            )
            detected_adapter = _required_string(
                result.get("detected_adapter"), field="detected_adapter", limit=40
            )
            _required_string(
                result.get("detected_from"), field="detected_from", limit=120
            )
            _required_string(result.get("source_name"), field="source_name", limit=300)
            existing_source_id = result.get("existing_source_id")
            if existing_source_id is not None:
                existing_source_id = _required_string(
                    existing_source_id,
                    field="existing_source_id",
                    limit=128,
                )
                if _SOURCE_ID.fullmatch(existing_source_id) is None:
                    raise ValueError("existing_source_id contains unsupported characters")
        except ValueError as error:
            raise SubscriptionError(
                502, "invalid_response", "订阅预览内容无效"
            ) from error
        if _SOURCE_ID.fullmatch(source_id) is None:
            raise SubscriptionError(502, "invalid_response", "订阅预览内容无效")
        if detected_adapter not in _ADDABLE_ADAPTERS:
            raise SubscriptionError(502, "invalid_response", "订阅预览内容无效")
        entries = result.get("entries")
        defaults = result.get("defaults")
        capabilities = result.get("capabilities")
        warnings = result.get("warnings")
        if not isinstance(entries, list) or not isinstance(warnings, list):
            raise SubscriptionError(502, "invalid_response", "订阅预览内容无效")
        entry_values = cast(list[object], entries)
        warning_values = cast(list[object], warnings)
        if (
            len(entry_values) > 3
            or len(warning_values) > 20
            or not isinstance(defaults, dict)
            or not isinstance(capabilities, dict)
        ):
            raise SubscriptionError(502, "invalid_response", "订阅预览内容无效")
        try:
            safe_warnings: list[str] = []
            for index, warning in enumerate(warning_values):
                normalized_warning = safe_remote_error_summary(warning)
                if normalized_warning is None:
                    raise ValueError(f"warnings[{index}] must not be null")
                safe_warnings.append(normalized_warning)
        except ValueError as error:
            raise SubscriptionError(
                502, "invalid_response", "订阅预览内容无效"
            ) from error
        for entry_value in entry_values:
            if not isinstance(entry_value, dict):
                raise SubscriptionError(502, "invalid_response", "订阅预览内容无效")
            entry = cast(Mapping[str, object], entry_value)
            if set(entry) != {"title", "url", "published_at"}:
                raise SubscriptionError(502, "invalid_response", "订阅预览内容无效")
            try:
                _required_string(entry.get("title"), field="entry.title", limit=500)
                _projected_url(entry.get("url"))
                _optional_time(entry.get("published_at"), field="entry.published_at")
            except ValueError as error:
                raise SubscriptionError(
                    502, "invalid_response", "订阅预览内容无效"
                ) from error
        defaults_value = cast(Mapping[str, object], defaults)
        capabilities_value = cast(Mapping[str, object], capabilities)
        if set(defaults_value) != {
            "include_existing",
            "content_mode",
            "content_max_chars",
        } or set(capabilities_value) != {
            "content_modes",
            "can_include_existing",
        }:
            raise SubscriptionError(502, "invalid_response", "订阅预览内容无效")
        default_include = defaults_value.get("include_existing")
        default_mode = defaults_value.get("content_mode")
        default_max = defaults_value.get("content_max_chars")
        modes = capabilities_value.get("content_modes")
        can_include = capabilities_value.get("can_include_existing")
        if not isinstance(modes, list):
            raise SubscriptionError(502, "invalid_response", "订阅预览内容无效")
        mode_values = cast(list[object], modes)
        if (
            not isinstance(default_include, bool)
            or default_mode not in _CONTENT_MODES
            or isinstance(default_max, bool)
            or not isinstance(default_max, int)
            or not 100 <= default_max <= 20_000
            or not mode_values
            or len(mode_values) > 2
            or any(mode not in _CONTENT_MODES for mode in mode_values)
            or len(set(cast(list[str], mode_values))) != len(mode_values)
            or not isinstance(can_include, bool)
            or (
                detected_adapter == "github_repository"
                and (default_include is not True or can_include is not False)
            )
            or (
                detected_adapter != "github_repository"
                and (default_include is not False or can_include is not True)
            )
        ):
            raise SubscriptionError(502, "invalid_response", "订阅预览内容无效")
        stored = {
            "version": 1,
            "preview_id": preview_id,
            "expires_at": expires_at,
            "canonical_url": canonical_url,
            "url_redacted": url_redacted,
            "source_id": source_id,
            "detected_adapter": detected_adapter,
            "registry_revision": revision,
        }
        _atomic_json(self._opaque_path(self.previews, preview_id), stored)
        return {**result, "warnings": safe_warnings, "registry_revision": revision}

    @staticmethod
    def _fingerprint(action: str, payload: Mapping[str, object]) -> str:
        encoded = json.dumps(
            {"action": action, **dict(payload)},
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
        return hashlib.sha256(encoded).hexdigest()

    def _receipt(
        self,
        idempotency_key: str,
        fingerprint: str,
    ) -> dict[str, object] | None:
        path = self._opaque_path(self.receipts, idempotency_key)
        if not path.is_file():
            return None
        try:
            value = _json_object(path)
        except (OSError, ValueError) as error:
            raise SubscriptionError(
                502, "invalid_state", "本地订阅操作记录损坏"
            ) from error
        if value.get("fingerprint") != fingerprint:
            raise SubscriptionError(
                409, "idempotency_conflict", "操作标识已被另一项请求使用"
            )
        response = value.get("response")
        if not isinstance(response, dict):
            raise SubscriptionError(502, "invalid_state", "本地订阅操作记录损坏")
        return cast(dict[str, object], response)

    def _write_receipt(
        self,
        idempotency_key: str,
        fingerprint: str,
        response: Mapping[str, object],
    ) -> None:
        _atomic_json(
            self._opaque_path(self.receipts, idempotency_key),
            {
                "version": 1,
                "fingerprint": fingerprint,
                "created_at": _now(),
                "response": dict(response),
            },
        )

    def confirm(self, payload: Mapping[str, object]) -> dict[str, object]:
        preview_id = _required_string(payload.get("preview_id"), field="preview_id", limit=300)
        expected_revision = _revision(payload.get("expected_registry_revision"))
        idempotency_key = _required_string(
            payload.get("idempotency_key"), field="idempotency_key", limit=128
        )
        fingerprint = self._fingerprint("add", payload)
        with self.mirror.locked() as locked:
            receipt = self._receipt(idempotency_key, fingerprint)
            if receipt is not None:
                return receipt
            preview_path = self._opaque_path(self.previews, preview_id)
            if not preview_path.is_file():
                raise SubscriptionError(404, "preview_not_found", "没有找到订阅预览")
            try:
                preview = _json_object(preview_path)
                expires = datetime.fromisoformat(
                    _parse_time(preview.get("expires_at"), field="expires_at").replace(
                        "Z", "+00:00"
                    )
                )
            except (OSError, ValueError) as error:
                raise SubscriptionError(404, "preview_not_found", "没有找到订阅预览") from error
            if expires <= datetime.now(UTC):
                preview_path.unlink(missing_ok=True)
                raise SubscriptionError(410, "preview_expired", "订阅预览已过期，请重新预览")
            if preview.get("preview_id") != preview_id:
                raise SubscriptionError(404, "preview_not_found", "没有找到订阅预览")
            if preview.get("registry_revision") != expected_revision:
                raise SubscriptionError(409, "revision_conflict", "订阅列表已更新，请重新预览")
            result, revision = self._admin("add", payload)
            source_value = result.get("source")
            if not isinstance(source_value, dict):
                raise SubscriptionError(502, "invalid_response", "订阅服务返回内容无效")
            try:
                source = ManagementSource.parse(cast(Mapping[str, object], source_value))
            except ValueError as error:
                raise SubscriptionError(502, "invalid_response", "订阅服务返回内容无效") from error
            if (
                source.source_id != preview.get("source_id")
                or source.canonical_url != preview.get("canonical_url")
                or source.url_redacted != preview.get("url_redacted")
                or source.adapter != preview.get("detected_adapter")
            ):
                raise SubscriptionError(502, "preview_mismatch", "订阅确认结果与预览不一致")
            marked = result.get("existing_items_marked_seen")
            include_current = result.get("next_run_will_include_current")
            if (
                isinstance(marked, bool)
                or not isinstance(marked, int)
                or marked < 0
                or not isinstance(include_current, bool)
            ):
                raise SubscriptionError(502, "invalid_response", "订阅服务返回内容无效")
            locked.upsert(revision, source)
            response: dict[str, object] = {
                "registry_revision": revision,
                "source": asdict(source),
                "existing_items_marked_seen": marked,
                "next_run_will_include_current": include_current,
            }
            self._write_receipt(idempotency_key, fingerprint, response)
            preview_path.unlink(missing_ok=True)
            return response

    def set_enabled(
        self,
        source_id: str,
        enabled: bool,
        payload: Mapping[str, object],
    ) -> dict[str, object]:
        if _SOURCE_ID.fullmatch(source_id) is None:
            raise SubscriptionError(404, "source_not_found", "没有找到对应的订阅")
        expected_revision = _revision(payload.get("expected_registry_revision"))
        idempotency_key = _required_string(
            payload.get("idempotency_key"), field="idempotency_key", limit=128
        )
        action = "enable" if enabled else "disable"
        remote_payload = {
            "source_id": source_id,
            "expected_registry_revision": expected_revision,
            "idempotency_key": idempotency_key,
        }
        fingerprint = self._fingerprint(action, remote_payload)
        with self.mirror.locked() as locked:
            receipt = self._receipt(idempotency_key, fingerprint)
            if receipt is not None:
                return receipt
            result, revision = self._admin(action, remote_payload)
            source_value = result.get("source")
            if not isinstance(source_value, dict):
                raise SubscriptionError(502, "invalid_response", "订阅服务返回内容无效")
            try:
                source = ManagementSource.parse(cast(Mapping[str, object], source_value))
            except ValueError as error:
                raise SubscriptionError(502, "invalid_response", "订阅服务返回内容无效") from error
            if source.source_id != source_id or source.enabled is not enabled:
                raise SubscriptionError(502, "source_mismatch", "订阅操作结果与请求不一致")
            locked.upsert(revision, source)
            response: dict[str, object] = {
                "registry_revision": revision,
                "source": asdict(source),
            }
            self._write_receipt(idempotency_key, fingerprint, response)
            return response

    def remove(self, source_id: str, payload: Mapping[str, object]) -> dict[str, object]:
        if _SOURCE_ID.fullmatch(source_id) is None:
            raise SubscriptionError(404, "source_not_found", "没有找到对应的订阅")
        if payload.get("confirm") is not True:
            raise SubscriptionError(400, "confirmation_required", "移除订阅需要明确确认")
        expected_revision = _revision(payload.get("expected_registry_revision"))
        idempotency_key = _required_string(
            payload.get("idempotency_key"), field="idempotency_key", limit=128
        )
        remote_payload = {
            "source_id": source_id,
            "expected_registry_revision": expected_revision,
            "idempotency_key": idempotency_key,
            "confirm": True,
        }
        fingerprint = self._fingerprint("remove", remote_payload)
        with self.mirror.locked() as locked:
            receipt = self._receipt(idempotency_key, fingerprint)
            if receipt is not None:
                return receipt
            result, revision = self._admin("remove", remote_payload)
            if (
                result.get("source_id") != source_id
                or result.get("removed") is not True
                or result.get("historical_state_retained") is not True
            ):
                raise SubscriptionError(502, "source_mismatch", "订阅操作结果与请求不一致")
            try:
                locked.remove(revision, source_id)
            except KeyError as error:
                raise SubscriptionError(409, "mirror_stale", "请先刷新订阅列表后重试") from error
            response: dict[str, object] = {
                "registry_revision": revision,
                "source_id": source_id,
                "removed": True,
                "historical_state_retained": True,
            }
            self._write_receipt(idempotency_key, fingerprint, response)
            return response
