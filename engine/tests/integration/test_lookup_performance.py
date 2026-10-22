from __future__ import annotations

import cProfile
import os
import pstats
from pathlib import Path

from okf_workspace.feeds import FeedCache, FeedEdition, FeedItem, FeedKind
from okf_workspace.notes.web_captures import canonical_web_url
from okf_workspace.sources.publisher import SourcePublisher


def test_source_lookup_reuses_headers_but_verifies_the_selected_record(tmp_path: Path) -> None:
    vault = tmp_path / "vault"
    records = vault / "sources" / "records"
    records.mkdir(parents=True)
    for number in range(20):
        (records / f"{number:02}.md").write_text(
            f"---\ntype: Source\nsha256: '{number:064x}'\nresource: https://example.com/{number}\n---\n\nSource.",
            encoding="utf-8",
        )
    assert SourcePublisher(vault).find_by_sha256(f"{19:064x}")
    profiler = cProfile.Profile()
    found = profiler.runcall(SourcePublisher(vault).find_by_sha256, f"{19:064x}")
    assert found is not None and found[0].name == "19.md"
    profile = pstats.Stats(profiler).get_stats_profile()
    assert profile.func_profiles["parse_document"].ncalls == "1"
    target = records / "19.md"
    old = target.stat()
    target.write_text(
        target.read_text(encoding="utf-8").replace(f"{19:064x}", "f" * 64), encoding="utf-8"
    )
    os.utime(target, ns=(old.st_atime_ns, old.st_mtime_ns))
    assert SourcePublisher(vault).find_by_sha256("f" * 64)
    target.unlink()
    assert SourcePublisher(vault).find_by_sha256("f" * 64) is None


def test_normalized_web_lookup_accepts_vault_with_local_file_sources(tmp_path: Path) -> None:
    records = tmp_path / "sources" / "records"
    records.mkdir(parents=True)
    for name, resource in (
        ("local", "/sources/originals/example.docx"),
        ("web", "https://EXAMPLE.com/article?utm_source=test"),
    ):
        (records / f"{name}.md").write_text(
            f"---\ntype: Source\nresource: {resource}\n---\n\nSource.", encoding="utf-8"
        )
    found = SourcePublisher(tmp_path).find_by_resource(
        "https://example.com/article", normalize=canonical_web_url
    )
    assert found is not None and found[0].name == "web.md"


def test_source_lookup_rechecks_after_stale_candidate_identity_changes(tmp_path: Path) -> None:
    records = tmp_path / "sources" / "records"
    records.mkdir(parents=True)
    paths = [records / "first.md", records / "second.md"]
    for number, path in enumerate(paths):
        path.write_text(
            f"---\ntype: Source\nsha256: '{number:064x}'\n---\n\nSource.", encoding="utf-8"
        )
    publisher = SourcePublisher(tmp_path)
    assert publisher.find_by_sha256(f"{0:064x}")
    for number, path in enumerate(paths):
        previous = path.stat()
        path.write_text(
            path.read_text(encoding="utf-8").replace(f"{number:064x}", f"{1 - number:064x}"),
            encoding="utf-8",
        )
        os.utime(path, ns=(previous.st_atime_ns, previous.st_mtime_ns))
    found = publisher.find_by_sha256(f"{0:064x}")
    assert found is not None and found[0] == paths[1]


def test_feed_item_lookup_only_loads_the_matching_edition_body(tmp_path: Path) -> None:
    cache = FeedCache(tmp_path / "state")
    for number in range(10):
        edition = FeedEdition(
            edition_id=f"edition-{number:02}",
            feed=FeedKind.AI_DAILY,
            edition_at=f"2026-10-{number + 1:02}",
            title="Synthetic",
            stream="news",
            items=(
                FeedItem(
                    item_id=f"item-{number}",
                    feed=FeedKind.AI_DAILY,
                    edition_id=f"edition-{number:02}",
                    title="Synthetic",
                    body="Complete body.",
                ),
            ),
        )
        cache.put(edition)
    profiler = cProfile.Profile()
    item = profiler.runcall(cache.find_item, FeedKind.AI_DAILY, "item-0")
    assert item.item_id == "item-0" and item.body == "Complete body."
    profile = pstats.Stats(profiler).get_stats_profile()
    assert profile.func_profiles["get"].ncalls == "1"
