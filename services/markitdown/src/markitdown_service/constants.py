"""Protocol constants shared by the API, worker, and result builder."""

from typing import Final

BACKEND_NAME: Final = "markitdown"
DEFAULT_PROFILE: Final = "fallback-text-v1"
RESULT_SCHEMA: Final = "markitdown-result/v2"

RESULT_CAPABILITIES: Final = {
    "page_map": False,
    "assets": False,
    "ocr": False,
    "formulas": False,
    "tables": "best_effort",
    "headings": "best_effort",
}

HEALTH_CAPABILITIES: Final = {
    "pdf": True,
    "pptx": True,
    "docx": True,
    "assets": False,
    "ocr": False,
    "network_access": False,
}

TERMINAL_STATUSES: Final = frozenset({"completed", "failed", "cancelled", "expired"})
