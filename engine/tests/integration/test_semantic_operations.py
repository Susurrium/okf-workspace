# pyright: reportUnknownMemberType=false, reportUnknownVariableType=false

from __future__ import annotations

import json
import threading
import time
from collections.abc import Callable
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import okf_workspace.semantic.runner as semantic_runner
from okf_workspace.ai.provider import CodexSettings
from okf_workspace.api import LocalTokenStore, create_app
from okf_workspace.config import BrainPaths
from okf_workspace.notes import NoteService
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
