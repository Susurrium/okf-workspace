"""Protocol constants shared by the API, worker, and result builder."""

from typing import Final

BACKEND_NAME: Final = "markitdown"
DEFAULT_PROFILE: Final = "fallback-assets-v2"
LEGACY_PROFILE: Final = "fallback-text-v1"
SUPPORTED_PROFILES: Final = frozenset({DEFAULT_PROFILE, LEGACY_PROFILE})
RESULT_SCHEMA: Final = "markitdown-result/v3"
LEGACY_RESULT_SCHEMA: Final = "markitdown-result/v2"

RESULT_CAPABILITIES: Final = {
    "page_map": False,
    "ocr": False,
    "formulas": False,
    "tables": "best_effort",
    "headings": "best_effort",
}

HEALTH_CAPABILITIES: Final = {
    "formats": {
        "pdf": {"markdown": True, "assets": False, "ocr": False},
        "pptx": {"markdown": True, "assets": "embedded", "ocr": False},
        "docx": {"markdown": True, "assets": "embedded", "ocr": False},
    },
    "network_access": False,
}

TERMINAL_STATUSES: Final = frozenset({"completed", "failed", "cancelled", "expired"})
