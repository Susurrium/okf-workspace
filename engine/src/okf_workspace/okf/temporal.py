from __future__ import annotations

from collections.abc import Mapping
from datetime import UTC, date, datetime
from typing import cast


def temporal_text(value: object) -> str | None:
    if isinstance(value, date):
        return value.isoformat()
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    try:
        datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    return text


def _event_moment(value: object) -> datetime | None:
    text = temporal_text(value)
    if text is None:
        return None
    parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    # 历史无时区值保留可读性，不使用本机时区推断跨设备事件的先后。
    return parsed.astimezone(UTC) if parsed.tzinfo is not None else None


def generation_verification(fields: Mapping[str, object]) -> tuple[bool, tuple[str, ...]]:
    generated = fields.get("generated")
    if generated is None:
        return False, ()
    if not isinstance(generated, Mapping):
        return True, ("generated 必须是包含 by、at 的核验事件",)
    event = cast(Mapping[str, object], generated)
    actor = event.get("by")
    generated_at = _event_moment(event.get("at"))
    if not isinstance(actor, str) or not actor.strip() or generated_at is None:
        return True, ("generated.by 或 generated.at 无效，时间必须包含时区",)
    verified = fields.get("verified")
    if verified is None:
        return True, ()
    events = cast(list[object], verified) if isinstance(verified, list) else [verified]
    warnings: list[str] = []
    confirmed = False
    for index, value in enumerate(events):
        if not isinstance(value, Mapping):
            warnings.append(f"verified[{index}] 必须包含 by、at")
            continue
        verification = cast(Mapping[str, object], value)
        verifier = verification.get("by")
        verified_at = _event_moment(verification.get("at"))
        if not isinstance(verifier, str) or not verifier.strip() or verified_at is None:
            warnings.append(f"verified[{index}].by 或 at 无效，时间必须包含时区")
            continue
        if verified_at >= generated_at:
            confirmed = True
    return not confirmed, tuple(warnings)
