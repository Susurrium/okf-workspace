# pyright: reportUnknownMemberType=false, reportUnknownVariableType=false
# pyright: reportUnknownArgumentType=false

from __future__ import annotations

import hashlib
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi.testclient import TestClient
from pytest import MonkeyPatch, raises

from okf_workspace.api import LocalTokenStore, create_app
from okf_workspace.config import BrainPaths
from okf_workspace.notes import NoteService, web_captures
from okf_workspace.notes.captures import process_capture, recommend_capture_destination
from okf_workspace.notes.web_captures import canonical_web_url, publish_web_capture
from okf_workspace.okf.frontmatter import OkfDocument, read_document, write_document
from okf_workspace.okf.validator import validate_bundle
from okf_workspace.semantic import SemanticOperationService

NOW = datetime(2026, 8, 20, 10, 30, tzinfo=timezone(timedelta(hours=8)))


def _web_capture(vault: Path, name: str, *, url: str, content: str) -> Path:
    path = vault / "inbox" / "captures" / "2026" / "08" / f"{name}.md"
    write_document(
        path,
        OkfDocument(
            {
                "type": "Capture",
                "title": "Context Graph",
                "created_at": NOW.isoformat(timespec="seconds"),
                "capture_status": "open",
                "ingested_via": "web-clip",
                "resource": url,
            },
            f"# Context Graph\n\n{content}\n",
        ),
    )
    return path


def test_canonical_web_url_removes_fragment_and_tracking_but_retains_real_query() -> None:
    assert (
        canonical_web_url("HTTPS://Example.COM:443/article?utm_source=x&id=7&lang=zh#comments")
        == "https://example.com/article?id=7&lang=zh"
    )
    assert (
        canonical_web_url("https://[2606:2800:220:1:248:1893:25c8:1946]/article#part")
        == "https://[2606:2800:220:1:248:1893:25c8:1946]/article"
    )


def test_web_capture_becomes_source_pair_and_duplicate_selection_merges(
    vault: Path,
    monkeypatch: MonkeyPatch,
) -> None:
    def no_checkpoint(_vault: Path, _message: str) -> None:
        return None

    monkeypatch.setattr("okf_workspace.notes.web_captures._checkpoint", no_checkpoint)
    first = _web_capture(
        vault,
        "first",
        url="https://example.com/context?id=7&utm_source=feed#top",
        content="## 正文\n\n第一版完整网页正文。",
    )

    published = publish_web_capture(
        vault,
        first.relative_to(vault).as_posix(),
        intent="source",
    )

    assert not first.exists()
    assert published.reused is False
    source = read_document(published.source)
    source_text = read_document(published.source_text)
    assert source.frontmatter["ingested_via"] == "web-clip"
    assert source.frontmatter["kind"] == "web"
    assert "purpose" not in source.frontmatter
    assert source.frontmatter["uses"] == [{"purpose": "reference"}]
    assert source.frontmatter["resource"].endswith("utm_source=feed#top")
    assert source_text.frontmatter["parser"] == "obsidian-web-clipper"
    assert "第一版完整网页正文" in source_text.body

    second = _web_capture(
        vault,
        "second",
        url="https://example.com/context?id=7&utm_medium=social#selection",
        content="## 选中内容\n\n一个稍后补充的关键段落。",
    )
    reused = publish_web_capture(
        vault,
        second.relative_to(vault).as_posix(),
        intent="learn",
    )

    assert reused.reused is True
    assert reused.source == published.source
    assert not second.exists()
    merged = read_document(reused.source_text).body
    assert "第一版完整网页正文" in merged
    assert "一个稍后补充的关键段落" in merged
    assert "purpose" not in read_document(reused.source).frontmatter
    assert read_document(reused.source).frontmatter["uses"] == [
        {"purpose": "reference"},
        {"purpose": "study"},
    ]
    assert reused.routed_target is not None
    assert reused.routed_target.parent == vault / "learning" / "guides"
    assert validate_bundle(vault).valid


def test_web_capture_publish_api_routes_to_existing_course(vault: Path, tmp_path: Path) -> None:
    NoteService(vault, clock=lambda: NOW).create_course("context-engineering", "上下文工程")
    capture = _web_capture(
        vault,
        "course-source",
        url="https://example.com/course",
        content="## 正文\n\n课程参考内容。",
    )
    paths = BrainPaths(vault=vault, originals=tmp_path / "originals", state=tmp_path / "state")
    token = LocalTokenStore(paths.state).ensure()
    client = TestClient(create_app(paths, semantic_enabled=False))

    response = client.post(
        "/captures/publish-web",
        headers={"Authorization": f"Bearer {token}"},
        json={
            "path": capture.relative_to(vault).as_posix(),
            "action": "learn-later",
            "course": "context-engineering",
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["source"].startswith("sources/records/web/")
    assert payload["source_text"].startswith("sources/text/web/")
    assert payload["routed_target"].startswith("learning/courses/context-engineering/guides/")
    source = read_document(vault / payload["source"])
    assert "course" not in source.frontmatter
    assert "project" not in source.frontmatter
    assert "purpose" not in source.frontmatter
    assert source.frontmatter["uses"] == [
        {
            "purpose": "study",
            "course": "/learning/courses/context-engineering/course.md",
        }
    ]
    assert "semantic_operation" not in payload


def test_web_capture_reuses_same_url_source_without_rewriting_first_channel(
    vault: Path,
    monkeypatch: MonkeyPatch,
) -> None:
    source = vault / "sources/records/ai-daily/context-graph.md"
    source_text = vault / "sources/text/ai-daily/context-graph.md"
    write_document(
        source,
        OkfDocument(
            {
                "type": "Source",
                "title": "Feed 中的 Context Graph",
                "created_at": NOW.isoformat(timespec="seconds"),
                "resource": "https://example.com/shared?id=9",
                "kind": "ai-daily",
                "text": "/sources/text/ai-daily/context-graph.md",
                "purpose": "undecided",
                "ingested_via": "feed",
            },
            "# Feed 中的 Context Graph\n",
        ),
    )
    write_document(
        source_text,
        OkfDocument(
            {
                "type": "Source Text",
                "title": "Feed 中的 Context Graph - 完整正文",
                "created_at": NOW.isoformat(timespec="seconds"),
                "parser": "feed-cache",
                "sources": [{"resource": "/sources/records/ai-daily/context-graph.md"}],
            },
            "# Feed 中的 Context Graph\n\nFeed 摘要。\n",
        ),
    )
    capture = _web_capture(
        vault,
        "shared",
        url="https://example.com/shared?id=9&utm_source=browser#part",
        content="## 网页正文\n\n网页完整正文。",
    )

    def no_checkpoint(_vault: Path, _message: str) -> None:
        return None

    monkeypatch.setattr(web_captures, "_checkpoint", no_checkpoint)
    result = publish_web_capture(
        vault,
        capture.relative_to(vault).as_posix(),
        intent="wiki",
    )

    assert result.reused is True and result.source == source
    reused = read_document(source)
    assert reused.frontmatter["ingested_via"] == "feed"
    assert reused.frontmatter["kind"] == "ai-daily"
    # The Web action is persisted by the workflow/operation, never on a shared Source.
    assert reused.frontmatter["purpose"] == "undecided"
    assert reused.frontmatter["uses"] == [{"purpose": "wiki"}]
    assert "网页完整正文" in read_document(source_text).body


def test_reused_source_preserves_unlabeled_provenance_and_normalizes_known_alias(
    vault: Path,
    monkeypatch: MonkeyPatch,
) -> None:
    def no_checkpoint(_vault: Path, _message: str) -> None:
        return None

    monkeypatch.setattr(web_captures, "_checkpoint", no_checkpoint)
    for suffix, channel, expected in (
        ("unlabeled", None, None),
        ("legacy", "web-clipper", "web-clip"),
    ):
        source = vault / f"sources/records/custom/{suffix}.md"
        source_text = vault / f"sources/text/custom/{suffix}.md"
        fields: dict[str, object] = {
            "type": "Source",
            "title": suffix,
            "created_at": NOW.isoformat(timespec="seconds"),
            "resource": f"https://example.com/{suffix}",
            "kind": "custom",
            "text": f"/sources/text/custom/{suffix}.md",
            "purpose": "reference",
        }
        if channel is not None:
            fields["ingested_via"] = channel
        write_document(source, OkfDocument(fields, f"# {suffix}\n"))
        write_document(
            source_text,
            OkfDocument(
                {
                    "type": "Source Text",
                    "title": f"{suffix} - 完整正文",
                    "created_at": NOW.isoformat(timespec="seconds"),
                    "parser": "external",
                    "sources": [{"resource": f"/sources/records/custom/{suffix}.md"}],
                },
                f"# {suffix}\n",
            ),
        )
        capture = _web_capture(
            vault,
            f"capture-{suffix}",
            url=f"https://example.com/{suffix}#selection",
            content="## 选中内容\n\n补充内容。",
        )

        result = publish_web_capture(
            vault,
            capture.relative_to(vault).as_posix(),
            intent="source",
        )

        actual = read_document(result.source).frontmatter.get("ingested_via")
        assert actual == expected


def test_new_web_source_never_overwrites_a_colliding_path(
    vault: Path,
    monkeypatch: MonkeyPatch,
) -> None:
    url = "https://example.com/collision"
    digest = hashlib.sha256(url.encode()).hexdigest()[:10]
    source = vault / f"sources/records/web/Context-Graph-{digest}.md"
    source_text = vault / f"sources/text/web/Context-Graph-{digest}.md"
    source.parent.mkdir(parents=True, exist_ok=True)
    source_text.parent.mkdir(parents=True, exist_ok=True)
    source.write_bytes(b"collision-source")
    source_text.write_bytes(b"collision-text")
    capture = _web_capture(
        vault,
        "collision-capture",
        url=url,
        content="## 网页正文\n\n真实内容。",
    )

    def no_checkpoint(_vault: Path, _message: str) -> None:
        return None

    monkeypatch.setattr(web_captures, "_checkpoint", no_checkpoint)
    result = publish_web_capture(
        vault,
        capture.relative_to(vault).as_posix(),
        intent="source",
    )

    assert source.read_bytes() == b"collision-source"
    assert source_text.read_bytes() == b"collision-text"
    assert result.source != source and result.source_text != source_text
    assert result.source.is_file() and result.source_text.is_file()


def test_immediate_web_generation_requires_semantic_service_before_publication(
    vault: Path,
    tmp_path: Path,
) -> None:
    capture = _web_capture(
        vault,
        "no-semantics",
        url="https://example.com/no-semantics",
        content="## 网页正文\n\n不能静默丢失生成动作。",
    )
    paths = BrainPaths(vault=vault, originals=tmp_path / "originals", state=tmp_path / "state")
    token = LocalTokenStore(paths.state).ensure()
    client = TestClient(create_app(paths, semantic_enabled=False))

    response = client.post(
        "/captures/publish-web",
        headers={"Authorization": f"Bearer {token}"},
        json={
            "path": capture.relative_to(vault).as_posix(),
            "action": "wiki-now",
        },
    )

    assert response.status_code == 503
    assert capture.is_file()
    assert not any((vault / "sources/records/web").glob("*.md"))


def test_immediate_web_generation_returns_trackable_semantic_operation(
    vault: Path,
    tmp_path: Path,
) -> None:
    capture = _web_capture(
        vault,
        "queued-wiki",
        url="https://example.com/queued-wiki",
        content="## 网页正文\n\n需要形成一个 Wiki。",
    )
    paths = BrainPaths(vault=vault, originals=tmp_path / "originals", state=tmp_path / "state")
    token = LocalTokenStore(paths.state).ensure()
    client = TestClient(create_app(paths, semantic_enabled=True))

    response = client.post(
        "/captures/publish-web",
        headers={"Authorization": f"Bearer {token}"},
        json={
            "path": capture.relative_to(vault).as_posix(),
            "action": "wiki-now",
        },
    )

    assert response.status_code == 200
    payload = response.json()
    operation = payload["semantic_operation"]
    assert operation["kind"] == "generate-wiki"
    assert operation["status"] == "queued"
    assert payload["routed_target"].startswith("knowledge/wiki/")
    assert not capture.exists()


def test_semantic_enqueue_failure_reports_durable_pair_for_retry(
    vault: Path,
    tmp_path: Path,
    monkeypatch: MonkeyPatch,
) -> None:
    capture = _web_capture(
        vault,
        "enqueue-failure",
        url="https://example.com/enqueue-failure",
        content="## 网页正文\n\n发布成功后排队失败。",
    )
    paths = BrainPaths(vault=vault, originals=tmp_path / "originals", state=tmp_path / "state")
    token = LocalTokenStore(paths.state).ensure()

    def fail_enqueue(self: SemanticOperationService, *_args: object, **_kwargs: object) -> None:
        del self
        raise OSError("simulated queue failure")

    monkeypatch.setattr(SemanticOperationService, "enqueue", fail_enqueue)
    client = TestClient(create_app(paths, semantic_enabled=True))
    response = client.post(
        "/captures/publish-web",
        headers={"Authorization": f"Bearer {token}"},
        json={
            "path": capture.relative_to(vault).as_posix(),
            "action": "wiki-now",
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert "semantic_operation" not in payload
    assert payload["semantic_error"].startswith("Source 已发布")
    assert (vault / payload["source"]).is_file()
    assert not capture.exists()


def test_web_capture_cannot_bypass_source_publication(vault: Path) -> None:
    capture = _web_capture(
        vault,
        "guarded",
        url="https://example.com/guarded",
        content="## 网页正文\n\n必须先形成 Source pair。",
    )
    relative = capture.relative_to(vault).as_posix()

    with raises(ValueError, match=r"Source \+ Source Text"):
        recommend_capture_destination(vault, relative)
    with raises(ValueError, match=r"Source \+ Source Text"):
        process_capture(vault, relative, destination="wiki")
    assert capture.is_file()


def test_web_capture_pair_write_rolls_back_before_removing_capture(
    vault: Path,
    monkeypatch: MonkeyPatch,
) -> None:
    capture = _web_capture(
        vault,
        "rollback",
        url="https://example.com/rollback",
        content="## 网页正文\n\n写入失败时不能丢失。",
    )
    from okf_workspace.sources import publisher as source_publisher

    original_write = source_publisher.write_document
    calls = 0

    def fail_second_write(path: Path, document: OkfDocument) -> None:
        nonlocal calls
        calls += 1
        if calls == 2:
            raise OSError("simulated Source write failure")
        original_write(path, document)

    def no_checkpoint(_vault: Path, _message: str) -> None:
        return None

    monkeypatch.setattr(web_captures, "_checkpoint", no_checkpoint)
    monkeypatch.setattr(source_publisher, "write_document", fail_second_write)

    with raises(OSError, match="simulated"):
        publish_web_capture(
            vault,
            capture.relative_to(vault).as_posix(),
            intent="source",
        )

    assert capture.is_file()
    assert not any((vault / "sources/records/web").glob("*.md"))
    assert not any((vault / "sources/text/web").glob("*.md"))
