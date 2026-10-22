# pyright: reportUnknownMemberType=false, reportUnknownVariableType=false
# pyright: reportPrivateUsage=false

from __future__ import annotations

import json
import threading
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import cast

import pytest
from fastapi.testclient import TestClient

import okf_workspace.semantic.runner as semantic_runner
import okf_workspace.semantic.worker as semantic_worker
from okf_workspace.ai.provider import CodexSettings
from okf_workspace.api import LocalTokenStore, create_app
from okf_workspace.config import BrainPaths
from okf_workspace.feeds.cache import FeedCache
from okf_workspace.feeds.models import FeedEdition, FeedItem, FeedKind
from okf_workspace.notes import NoteService
from okf_workspace.okf.file_io import FileWriteConflict
from okf_workspace.okf.frontmatter import OkfDocument, read_document, write_document
from okf_workspace.okf.templates import initialize_vault
from okf_workspace.semantic import (
    SemanticKind,
    SemanticOperationService,
    SemanticOutput,
    SemanticRequest,
    SemanticStage,
)
from okf_workspace.semantic.runner import CodexSemanticRunner, SemanticCancelled
from okf_workspace.semantic.store import SemanticOperationStore
from okf_workspace.semantic.worker import SemanticWorker


class FixedRunner:
    def __init__(self, content: str = "## 核心解释\n\n这是根据真实来源生成的内容。") -> None:
        self.content = content
        self.requests: list[SemanticRequest] = []

    def generate(self, request: SemanticRequest) -> SemanticOutput:
        self.requests.append(request)
        return SemanticOutput(self.content, (*request.sources, request.target))


class FailingRunner:
    def generate(self, request: SemanticRequest) -> SemanticOutput:
        del request
        raise RuntimeError("Codex temporarily unavailable")


class BlockingRunner:
    def __init__(self) -> None:
        self.started = threading.Event()
        self.release = threading.Event()

    def generate(self, request: SemanticRequest) -> SemanticOutput:
        self.started.set()
        if not self.release.wait(5):
            raise RuntimeError("test runner was not released")
        return SemanticOutput("## 完成\n\n生成结束。", (request.target,))


class CancelAwareRunner:
    def __init__(self) -> None:
        self.started = threading.Event()
        self.cancel_seen = threading.Event()

    def generate(self, request: SemanticRequest) -> SemanticOutput:
        del request
        raise AssertionError("the worker should use the controllable runner path")

    def generate_controlled(
        self,
        request: SemanticRequest,
        *,
        should_cancel: Callable[[], bool],
        on_stage: Callable[[SemanticStage, str], None],
    ) -> SemanticOutput:
        del request
        on_stage(SemanticStage.GENERATING, "test generation")
        self.started.set()
        while not should_cancel():
            time.sleep(0.01)
        self.cancel_seen.set()
        raise SemanticCancelled("cancelled by test")


def _learning_note(vault: Path) -> Path:
    path = vault / "learning" / "guides" / "vpn.md"
    write_document(
        path,
        OkfDocument(
            {
                "type": "Study Guide",
                "title": "VPN",
                "status": "draft",
                "created_at": "2026-08-20T00:00:00+08:00",
            },
            (
                "# VPN\n\n## 辅助学习材料\n\n"
                '<!-- ai:auto:start name="study-material" -->\n等待生成。\n'
                '<!-- ai:auto:end name="study-material" -->\n\n'
                "## 我的笔记\n\n<!-- human:notes:start -->\n"
                "这里是用户自己的内容。\n<!-- human:notes:end -->\n"
            ),
        ),
    )
    return path


def _wiki_source(vault: Path) -> Path:
    path = vault / "sources" / "text" / "documents" / "wiki-source.md"
    write_document(
        path,
        OkfDocument(
            {
                "type": "Source Text",
                "title": "Wiki Source",
                "created_at": "2026-08-20T00:00:00+08:00",
                "parser": "fixture",
                "sources": [{"resource": "/index.md"}],
            },
            "# Wiki Source\n\n可复用的来源正文。\n",
        ),
    )
    return path


def test_publish_remerges_when_editor_changes_note_before_commit(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    vault = initialize_vault(tmp_path / "vault")
    target = _learning_note(vault)
    real_write = write_document
    attempts = 0

    def racing_write(
        path: Path,
        document: OkfDocument,
        *,
        create_only: bool = False,
        expected_sha256: str | None = None,
    ) -> None:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            current = read_document(path)
            current.body += "\n刚刚输入的用户笔记。\n"
            current.frontmatter["custom_extension"] = "keep me"
            real_write(path, current)
        real_write(path, document, create_only=create_only, expected_sha256=expected_sha256)

    monkeypatch.setattr(semantic_worker, "write_document", racing_write)
    SemanticWorker(vault, tmp_path / "state", FixedRunner())._publish(
        SemanticRequest("race-test", SemanticKind.GENERATE_STUDY_GUIDE, "learning/guides/vpn.md"),
        "## 新学习材料\n\nAI 正文。",
    )
    result = read_document(target)
    assert attempts == 2
    assert "刚刚输入的用户笔记" in result.body
    assert "AI 正文" in result.body
    assert result.frontmatter["custom_extension"] == "keep me"


def test_repeated_publish_conflict_preserves_note_and_generated_output(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    vault = initialize_vault(tmp_path / "vault")
    target = _learning_note(vault)
    before = target.read_bytes()

    def conflict(*args: object, **kwargs: object) -> None:
        raise FileWriteConflict("editor is still writing")

    monkeypatch.setattr(semantic_worker, "write_document", conflict)
    with pytest.raises(FileWriteConflict):
        SemanticWorker(vault, tmp_path / "state", FixedRunner())._publish(
            SemanticRequest(
                "conflict-test", SemanticKind.GENERATE_STUDY_GUIDE, "learning/guides/vpn.md"
            ),
            "## 可恢复材料\n\n生成的正文。",
        )
    assert target.read_bytes() == before
    assert "生成的正文" in (tmp_path / "state/semantic-output/conflict-test.md").read_text(
        encoding="utf-8"
    )


def test_invalid_semantic_candidate_never_replaces_existing_note(tmp_path: Path) -> None:
    vault = initialize_vault(tmp_path / "vault")
    target = _learning_note(vault)
    before = target.read_bytes()
    with pytest.raises(RuntimeError, match="validation"):
        SemanticWorker(vault, tmp_path / "state", FixedRunner())._publish(
            SemanticRequest(
                "invalid-test",
                SemanticKind.GENERATE_STUDY_GUIDE,
                "learning/guides/vpn.md",
                project="/projects/missing/project.md",
            ),
            "## 生成正文\n\n正文。",
        )
    assert target.read_bytes() == before


def test_prepare_study_operation_is_persistent_and_preserves_human_text(tmp_path: Path) -> None:
    vault = initialize_vault(tmp_path / "vault")
    target = _learning_note(vault)
    runner = FixedRunner()
    service = SemanticOperationService(vault, tmp_path / "state")
    queued = service.enqueue(
        SemanticKind.GENERATE_STUDY_GUIDE,
        "learning/guides/vpn.md",
        sources=("learning/guides/vpn.md",),
    )
    assert queued["status"] == "queued"
    assert SemanticWorker(vault, tmp_path / "state", runner).run_once()
    record = service.store.load(str(queued["operation_id"]))

    assert record["status"] == "completed"
    assert record["stage"] == "completed"
    document = read_document(target)
    assert "study_material_status" not in document.frontmatter
    assert "learning_status" not in document.frontmatter
    assert "根据真实来源生成" in document.body
    assert "这里是用户自己的内容" in document.body
    assert runner.requests[0].kind is SemanticKind.GENERATE_STUDY_GUIDE


def test_explicit_workflow_context_is_persisted_on_the_derived_guide(tmp_path: Path) -> None:
    vault = initialize_vault(tmp_path / "vault")
    notes = NoteService(vault)
    notes.create_course("systems", "系统课")
    notes.create_project("deploy", "部署项目")
    source = _wiki_source(vault)
    service = SemanticOperationService(vault, tmp_path / "state")
    queued = service.enqueue(
        SemanticKind.GENERATE_STUDY_GUIDE,
        "learning/courses/systems/guides/shared-deploy.md",
        sources=(source.relative_to(vault).as_posix(),),
        course="systems",
        project="deploy",
    )

    assert queued["course"] == "/learning/courses/systems/course.md"
    assert queued["project"] == "/projects/deploy/project.md"
    assert SemanticWorker(vault, tmp_path / "state", FixedRunner()).run_once()

    guide = read_document(vault / "learning/courses/systems/guides/shared-deploy.md")
    assert guide.frontmatter["course"] == "/learning/courses/systems/course.md"
    assert guide.frontmatter["project"] == "/projects/deploy/project.md"


def test_failed_operation_leaves_markdown_unchanged_and_can_be_retried(tmp_path: Path) -> None:
    vault = initialize_vault(tmp_path / "vault")
    target = _learning_note(vault)
    service = SemanticOperationService(vault, tmp_path / "state")
    before = target.read_text(encoding="utf-8")
    queued = service.enqueue(SemanticKind.GENERATE_STUDY_GUIDE, "learning/guides/vpn.md")
    assert SemanticWorker(vault, tmp_path / "state", FailingRunner()).run_once()
    record = service.store.load(str(queued["operation_id"]))

    assert record["status"] == "failed"
    assert "temporarily unavailable" in str(record["error"])
    assert target.read_text(encoding="utf-8") == before


def test_failed_wiki_generation_does_not_create_a_markdown_placeholder(tmp_path: Path) -> None:
    vault = initialize_vault(tmp_path / "vault")
    source = _wiki_source(vault)
    target = vault / "knowledge" / "wiki" / "pending-wiki.md"
    state = tmp_path / "state"
    service = SemanticOperationService(vault, state)
    queued = service.enqueue(
        SemanticKind.GENERATE_WIKI,
        "knowledge/wiki/pending-wiki.md",
        sources=(source.relative_to(vault).as_posix(),),
    )

    assert SemanticWorker(vault, state, FailingRunner()).run_once()

    record = service.store.load(str(queued["operation_id"]))
    assert record["status"] == "failed"
    assert not target.exists()


def test_successful_wiki_generation_marks_content_ready_only_after_publish(
    tmp_path: Path,
) -> None:
    vault = initialize_vault(tmp_path / "vault")
    source = _wiki_source(vault)
    target = vault / "knowledge" / "wiki" / "pending-wiki.md"
    state = tmp_path / "state"
    service = SemanticOperationService(vault, state)
    service.enqueue(
        SemanticKind.GENERATE_WIKI,
        "knowledge/wiki/pending-wiki.md",
        sources=(source.relative_to(vault).as_posix(),),
    )

    assert SemanticWorker(vault, state, FixedRunner("## Durable result\n\nVerified.")).run_once()

    document = read_document(target)
    assert "generation_status" not in document.frontmatter
    assert document.frontmatter["generated"]["by"] == "process:codex-background"
    assert document.frontmatter["sources"] == [
        {"resource": "/sources/text/documents/wiki-source.md"}
    ]
    assert "Durable result" in document.body


def test_duplicate_request_is_idempotent_and_does_not_create_two_operations(
    tmp_path: Path,
) -> None:
    vault = initialize_vault(tmp_path / "vault")
    _learning_note(vault)
    service = SemanticOperationService(vault, tmp_path / "state")

    first = service.enqueue(SemanticKind.GENERATE_STUDY_GUIDE, "learning/guides/vpn.md")
    second = service.enqueue(SemanticKind.GENERATE_STUDY_GUIDE, "learning/guides/vpn.md")

    assert second["operation_id"] == first["operation_id"]
    assert len(service.store.list()) == 1


def test_concurrent_requests_share_one_durable_operation(
    vault: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    _learning_note(vault)
    state = tmp_path / "state"
    original_find = SemanticOperationStore.find_active

    def slow_find(self: SemanticOperationStore, fingerprint: str) -> dict[str, object] | None:
        found = original_find(self, fingerprint)
        time.sleep(0.03)
        return found

    monkeypatch.setattr(SemanticOperationStore, "find_active", slow_find)
    barrier = threading.Barrier(8)

    def enqueue(_index: int) -> str:
        service = SemanticOperationService(vault, state)
        barrier.wait(timeout=5)
        return str(service.enqueue(
            SemanticKind.GENERATE_STUDY_GUIDE, "learning/guides/vpn.md",
        )["operation_id"])

    with ThreadPoolExecutor(max_workers=8) as pool:
        identifiers = list(pool.map(enqueue, range(8)))
    assert len(set(identifiers)) == 1
    assert len(SemanticOperationStore(state).list()) == 1


@pytest.mark.parametrize("legacy", [{"learned": True}, {"learning_status": "completed"}])
def test_generation_never_infers_study_completion(
    vault: Path, tmp_path: Path, legacy: dict[str, object],
) -> None:
    target = _learning_note(vault)
    document = read_document(target)
    document.frontmatter.update(legacy)
    write_document(target, document)
    service = SemanticOperationService(vault, tmp_path / "state")
    service.enqueue(SemanticKind.GENERATE_STUDY_GUIDE, "learning/guides/vpn.md")
    assert SemanticWorker(vault, tmp_path / "state", FixedRunner()).run_once()
    assert "studied_at" not in read_document(target).frontmatter


def test_durable_handoff_receipt_survives_completed_target_changes(
    vault: Path, tmp_path: Path,
) -> None:
    _learning_note(vault)
    service = SemanticOperationService(vault, tmp_path / "state")
    first = service.enqueue(
        SemanticKind.GENERATE_STUDY_GUIDE, "learning/guides/vpn.md",
        idempotency_key="document:fixture:initial",
    )
    assert SemanticWorker(vault, tmp_path / "state", FixedRunner()).run_once()
    second = service.enqueue(
        SemanticKind.GENERATE_STUDY_GUIDE, "learning/guides/vpn.md",
        idempotency_key="document:fixture:initial",
    )
    assert second["operation_id"] == first["operation_id"]
    assert second["status"] == "completed"


def test_retry_cannot_duplicate_a_newer_active_target(vault: Path, tmp_path: Path) -> None:
    _learning_note(vault)
    service = SemanticOperationService(vault, tmp_path / "state")
    first = service.enqueue(SemanticKind.GENERATE_STUDY_GUIDE, "learning/guides/vpn.md")
    assert SemanticWorker(vault, tmp_path / "state", FailingRunner()).run_once()
    newer = service.enqueue(
        SemanticKind.GENERATE_STUDY_GUIDE, "learning/guides/vpn.md", instruction="New request",
    )
    with pytest.raises(ValueError, match="already active"):
        service.retry(str(first["operation_id"]))
    assert service.store.load(str(first["operation_id"]))["status"] == "failed"
    assert service.store.load(str(newer["operation_id"]))["status"] == "queued"


@pytest.mark.parametrize("action", ["learn-now", "wiki-now"])
def test_feed_generation_keeps_explicit_contexts_separate(
    vault: Path, tmp_path: Path, action: str,
) -> None:
    notes = NoteService(vault)
    notes.create_course("alpha", "Alpha")
    notes.create_course("beta", "Beta")
    notes.create_project("project", "Project")
    state = tmp_path / "state"
    item = FeedItem(
        item_id="shared", feed=FeedKind.AI_DAILY, edition_id="edition", title="Shared",
        body="A shared source used by two different courses.", url="https://example.test/shared",
    )
    FeedCache(state).put(FeedEdition(
        edition_id="edition", feed=FeedKind.AI_DAILY, edition_at="2026-09-26",
        title="Edition", items=(item,),
    ))
    paths = BrainPaths(vault, tmp_path / "originals", state)
    # No lifespan: explicitly drive the real worker after each API request.
    client = TestClient(create_app(paths, semantic_enabled=True, semantic_runner=FixedRunner()))
    headers = {"Authorization": f"Bearer {LocalTokenStore(state).ensure()}"}
    targets: list[Path] = []
    for course in ("alpha", "beta"):
        response = client.post(
            "/feeds/ai-daily/items/shared/decision", headers=headers,
            json={"action": action, "course": course, "project": "project"},
        )
        assert response.status_code == 200
        payload = cast(dict[str, object], response.json())
        operation = cast(dict[str, object], payload["semantic_operation"])
        assert operation["course"] == f"/learning/courses/{course}/course.md"
        assert operation["project"] == "/projects/project/project.md"
        assert SemanticWorker(vault, state, FixedRunner()).run_once()
        target = vault / str(operation["target"])
        assert read_document(target).frontmatter["course"] == operation["course"]
        targets.append(target)
    assert targets[0] != targets[1]
    assert read_document(targets[0]).frontmatter["course"] == "/learning/courses/alpha/course.md"


def test_completed_prepare_request_can_be_explicitly_regenerated_after_content_changes(
    tmp_path: Path,
) -> None:
    vault = initialize_vault(tmp_path / "vault")
    _learning_note(vault)
    state = tmp_path / "state"
    service = SemanticOperationService(vault, state)
    first = service.enqueue(SemanticKind.GENERATE_STUDY_GUIDE, "learning/guides/vpn.md")
    assert SemanticWorker(vault, state, FixedRunner()).run_once()

    repeated = service.enqueue(SemanticKind.GENERATE_STUDY_GUIDE, "learning/guides/vpn.md")

    assert repeated["operation_id"] != first["operation_id"]
    assert repeated["status"] == "queued"
    assert len(service.store.list()) == 2


def test_recovery_keeps_source_complete_legacy_request_and_supersedes_duplicates(
    tmp_path: Path,
) -> None:
    state = tmp_path / "state"
    operations = state / "operations"
    operations.mkdir(parents=True)
    for suffix, moment, sources in (
        ("a", "2026-08-17T00:00:01+00:00", ["sources/records/a.md", "sources/text/a.md"]),
        ("b", "2026-08-17T00:00:02+00:00", []),
        ("c", "2026-08-17T00:00:03+00:00", []),
    ):
        (operations / f"op-{suffix}.json").write_text(
            json.dumps(
                {
                    "schema": 1,
                    "operation_id": f"op-{suffix}",
                    "kind": "generate-study-guide",
                    "target": "learning/guides/a.md",
                    "sources": sources,
                    "mode": None,
                    "instruction": "",
                    "status": "generating",
                    "created_at": moment,
                    "updated_at": moment,
                    "error": None,
                    "actual_reads": [],
                }
            ),
            encoding="utf-8",
        )

    store = SemanticOperationService(tmp_path / "vault", state).store
    changed = store.reconcile_pending()
    records = store.list()

    assert changed >= 3
    queued = [record for record in records if record["status"] == "queued"]
    assert len(queued) == 1
    assert queued[0]["sources"] == ["sources/records/a.md", "sources/text/a.md"]
    assert sum(record["status"] == "superseded" for record in records) == 2


def test_restart_immediately_recovers_a_recent_running_operation(tmp_path: Path) -> None:
    vault = initialize_vault(tmp_path / "vault")
    _learning_note(vault)
    service = SemanticOperationService(vault, tmp_path / "state")
    queued = service.enqueue(SemanticKind.GENERATE_STUDY_GUIDE, "learning/guides/vpn.md")
    assert service.store.claim_next("old-worker") is not None

    assert service.reconcile_pending() >= 1

    recovered = service.store.load(str(queued["operation_id"]))
    assert recovered["status"] == "queued"
    assert recovered["stage"] == "queued"
    assert recovered["worker_id"] is None


def test_running_operation_cancellation_reaches_the_runner_and_stops_work(
    tmp_path: Path,
) -> None:
    vault = initialize_vault(tmp_path / "vault")
    _learning_note(vault)
    state = tmp_path / "state"
    service = SemanticOperationService(vault, state)
    queued = service.enqueue(SemanticKind.GENERATE_STUDY_GUIDE, "learning/guides/vpn.md")
    runner = CancelAwareRunner()
    worker = SemanticWorker(vault, state, runner)
    thread = threading.Thread(target=worker.run_once)
    thread.start()
    assert runner.started.wait(2)

    service.cancel(str(queued["operation_id"]))
    thread.join(timeout=2)

    assert not thread.is_alive()
    assert runner.cancel_seen.is_set()
    record = service.store.load(str(queued["operation_id"]))
    assert record["status"] == "cancelled"
    assert record["stage"] == "cancelled"


def test_cancel_wins_between_generation_check_and_publishing(
    vault: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    target = _learning_note(vault)
    original = target.read_bytes()
    state = tmp_path / "state"
    service = SemanticOperationService(vault, state)
    queued = service.enqueue(SemanticKind.GENERATE_STUDY_GUIDE, "learning/guides/vpn.md")
    worker = SemanticWorker(vault, state, FixedRunner())
    real_cancelled = worker.store.cancelled
    accepted: list[dict[str, object]] = []

    def cancel_after_check(operation_id: str) -> bool:
        result = real_cancelled(operation_id)
        if not accepted:
            accepted.append(service.cancel(operation_id))
        return result

    monkeypatch.setattr(worker.store, "cancelled", cancel_after_check)
    assert worker.run_once()
    assert accepted[0]["cancel_requested"] is True
    assert target.read_bytes() == original
    assert service.store.load(str(queued["operation_id"]))["status"] == "cancelled"


def test_publishing_wins_before_a_late_cancellation(
    vault: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    target = _learning_note(vault)
    state = tmp_path / "state"
    service = SemanticOperationService(vault, state)
    queued = service.enqueue(SemanticKind.GENERATE_STUDY_GUIDE, "learning/guides/vpn.md")
    worker = SemanticWorker(vault, state, FixedRunner())
    real_publish = worker._publish

    def cancel_before_file_write(request: SemanticRequest, content: str) -> None:
        with pytest.raises(ValueError, match="already being published"):
            service.cancel(request.operation_id)
        assert service.store.load(request.operation_id)["cancel_requested"] is False
        real_publish(request, content)

    monkeypatch.setattr(worker, "_publish", cancel_before_file_write)
    assert worker.run_once()
    assert service.store.load(str(queued["operation_id"]))["status"] == "completed"
    assert "这是根据真实来源生成的内容。" in read_document(target).body


def test_health_stays_responsive_while_semantic_worker_is_blocked(tmp_path: Path) -> None:
    vault = initialize_vault(tmp_path / "vault")
    _learning_note(vault)
    paths = BrainPaths(vault, tmp_path / "originals", tmp_path / "state")
    runner = BlockingRunner()
    token = LocalTokenStore(paths.state).ensure()
    headers = {"Authorization": f"Bearer {token}"}

    with TestClient(create_app(paths, semantic_runner=runner, semantic_enabled=True)) as client:
        queued = client.post(
            "/semantic/operations",
            headers=headers,
            json={
                "kind": "generate-study-guide",
                "target": "learning/guides/vpn.md",
            },
        )
        assert queued.status_code == 200
        assert runner.started.wait(2)
        health = client.get("/health")
        runner.release.set()

    assert health.status_code == 200
    assert health.json()["status"] == "ok"


def test_codex_runner_uses_supported_output_schema(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    vault = initialize_vault(tmp_path / "vault")
    target = NoteService(vault).create_study_guide("Routing", "Source text")
    target_relative = target.relative_to(vault).as_posix()
    state = tmp_path / "state"

    def fake_run(
        _runner: CodexSemanticRunner,
        command: list[str],
        _prompt_path: Path,
        _operation_root: Path,
        **_kwargs: object,
    ) -> None:
        output = Path(command[command.index("--output-last-message") + 1])
        output.write_text(
            json.dumps(
                {
                    "content": "## Core explanation\n\nGenerated content.",
                    "actual_reads": [target_relative],
                }
            ),
            encoding="utf-8",
        )

    monkeypatch.setattr(CodexSemanticRunner, "_run_codex", fake_run)
    runner = CodexSemanticRunner(
        vault,
        state,
        CodexSettings(command="codex", working_directory=state / "runtime"),
    )

    result = runner.generate(
        SemanticRequest(
            operation_id="op-schema",
            kind=SemanticKind.GENERATE_STUDY_GUIDE,
            target=target_relative,
        )
    )

    schema = json.loads(
        (state / "operations/op-schema/output-schema.json").read_text(encoding="utf-8")
    )
    assert "uniqueItems" not in schema["properties"]["actual_reads"]
    assert result.actual_reads == (target_relative,)


def test_codex_runner_rejects_unsubstantiated_read_evidence(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    vault = initialize_vault(tmp_path / "vault")
    target = NoteService(vault).create_study_guide("Evidence", "Source text")
    target_relative = target.relative_to(vault).as_posix()
    state = tmp_path / "state"

    def fake_run(
        _runner: CodexSemanticRunner,
        command: list[str],
        _prompt_path: Path,
        _operation_root: Path,
        **_kwargs: object,
    ) -> None:
        output = Path(command[command.index("--output-last-message") + 1])
        output.write_text(
            json.dumps({"content": "Plausible but unsupported.", "actual_reads": []}),
            encoding="utf-8",
        )

    monkeypatch.setattr(CodexSemanticRunner, "_run_codex", fake_run)
    runner = CodexSemanticRunner(
        vault,
        state,
        CodexSettings(command="codex", working_directory=state / "runtime"),
    )

    with pytest.raises(RuntimeError, match="required read evidence"):
        runner.generate(
            SemanticRequest(
                operation_id="op-missing-evidence",
                kind=SemanticKind.GENERATE_STUDY_GUIDE,
                target=target_relative,
            )
        )


def test_semantic_context_reuses_vector_reader_without_rebuilding_index(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    vault = initialize_vault(tmp_path / "vault")
    state = tmp_path / "state"
    state.mkdir()
    (state / "vectors.sqlite").touch()
    constructed = {"vectors": 0, "embedders": 0}

    class FakeVectorIndex:
        def __init__(self, path: Path) -> None:
            assert path == state / "vectors.sqlite"
            constructed["vectors"] += 1

        def sync(self, *_args: object) -> None:
            raise AssertionError("semantic operations must not rebuild the vector index")

    class FakeEmbedder:
        def __init__(self) -> None:
            constructed["embedders"] += 1

    class FakeHybridSearcher:
        def __init__(self, *_args: object, **_kwargs: object) -> None:
            pass

        def search(self, *_args: object, **_kwargs: object) -> list[object]:
            return []

    class FakeContextReader:
        def __init__(self, *_args: object) -> None:
            pass

        def read(self, *_args: object, **_kwargs: object) -> list[object]:
            return []

    monkeypatch.setattr(semantic_runner, "VectorIndex", FakeVectorIndex)
    monkeypatch.setattr(semantic_runner, "FastEmbedder", FakeEmbedder)
    monkeypatch.setattr(semantic_runner, "HybridSearcher", FakeHybridSearcher)
    monkeypatch.setattr(semantic_runner, "ContextReader", FakeContextReader)

    class ExposedRunner(CodexSemanticRunner):
        def candidate_paths(self, request: SemanticRequest) -> tuple[str, ...]:
            return self._candidate_paths(request)

    runner = ExposedRunner(
        vault,
        state,
        CodexSettings(command="codex", working_directory=state / "runtime"),
    )
    request = SemanticRequest(
        operation_id="op-vector-read",
        kind=SemanticKind.GENERATE_STUDY_GUIDE,
        target="learning/guides/missing.md",
    )

    assert runner.candidate_paths(request) == ()
    assert runner.candidate_paths(request) == ()
    assert constructed == {"vectors": 1, "embedders": 1}
