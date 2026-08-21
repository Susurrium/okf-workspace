"""Search candidates, then read authoritative Markdown before answering."""

from .context import ContextReader
from .index import SearchIndex
from .models import ContextItem, SearchHit
from .search import HybridSearcher

__all__ = [
    "ContextItem",
    "ContextReader",
    "HybridSearcher",
    "SearchHit",
    "SearchIndex",
]
