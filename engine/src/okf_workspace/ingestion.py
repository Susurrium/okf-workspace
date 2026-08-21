"""Canonical input-channel metadata for local Capture and Source artifacts."""

from __future__ import annotations

from typing import Final, Literal, cast

type IngestedVia = Literal["web-clip", "file-import", "feed", "direct-entry"]

WEB_CLIP: Final[IngestedVia] = "web-clip"
FILE_IMPORT: Final[IngestedVia] = "file-import"
FEED: Final[IngestedVia] = "feed"
DIRECT_ENTRY: Final[IngestedVia] = "direct-entry"

INGESTED_VIA_VALUES: Final[frozenset[str]] = frozenset(
    {WEB_CLIP, FILE_IMPORT, FEED, DIRECT_ENTRY}
)

_LEGACY_VALUES: Final[dict[str, IngestedVia]] = {
    "web-clipper": WEB_CLIP,
    "manual-upload": FILE_IMPORT,
    "quick-capture": DIRECT_ENTRY,
}


def normalize_ingested_via(value: object) -> IngestedVia | None:
    """Return a canonical channel, mapping known legacy values and rejecting placeholders."""

    if not isinstance(value, str):
        return None
    normalized = value.strip().casefold()
    if normalized in INGESTED_VIA_VALUES:
        return cast(IngestedVia, normalized)
    return _LEGACY_VALUES.get(normalized)
