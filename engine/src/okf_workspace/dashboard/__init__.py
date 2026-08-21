"""Markdown-backed projections for local API and Obsidian Dashboard."""

from .catalog import NoteSummary, scan_notes
from .views import dashboard_view, today_view

__all__ = ["NoteSummary", "dashboard_view", "scan_notes", "today_view"]
