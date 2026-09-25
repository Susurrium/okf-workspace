"""FastAPI boundary exposing domain results without internal absolute paths."""

# pyright: reportUnusedFunction=false

from __future__ import annotations

import os
import threading
import uuid
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager, suppress
from dataclasses import asdict
from datetime import UTC, datetime
from datetime import date as Date
from pathlib import Path
from typing import Annotated, Literal, cast

from fastapi import (
    BackgroundTasks,
    Depends,
    FastAPI,
    File,
    Form,
    Header,
    HTTPException,
    Query,
    Request,
    UploadFile,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from okf_workspace import __version__
from okf_workspace.ai import (
    AnswerService,
    ExplicitAIWorkflows,
    provider_from_env,
)
from okf_workspace.ai.workflows import AIInputTooLarge, AIOutputError
from okf_workspace.config import BrainPaths
from okf_workspace.dashboard.catalog import scan_notes
from okf_workspace.dashboard.feeds import (
    FeedProjectionTooLarge,
    feed_dashboard,
    subscription_dashboard,
    subscription_source_latest_items_dashboard,
    subscription_sources_dashboard,
)
from okf_workspace.dashboard.system import system_status
from okf_workspace.dashboard.views import dashboard_view, today_view
from okf_workspace.feeds import (
    DecisionAction,
    FeedCache,
    FeedDecisionService,
    FeedKind,
    FeedSyncer,
    materialize_edition,
)
from okf_workspace.feeds.adapters import ai_daily_from_v1, treehole_from_v1
from okf_workspace.feeds.subscriptions import SubscriptionError, SubscriptionService
from okf_workspace.git import (
    GitCheckpointError,
    create_checkpoint,
    latest_checkpoint_summary,
    undo_last_checkpoint,
)
from okf_workspace.governance import governance_report
from okf_workspace.importers import (
    ConversionStatus,
    DocumentImporter,
    DocumentImportWorker,
    ImportIntent,
    ImportQuality,
    ImportRequest,
    ParserName,
)
from okf_workspace.importers.publish import route_existing_import
from okf_workspace.importers.state import ConversionStore
from okf_workspace.notes import NoteService
from okf_workspace.notes.captures import (
    batch_discard_captures,
    discard_capture,
    process_capture,
    recommend_capture_destination,
)
from okf_workspace.notes.web_captures import publish_web_capture
from okf_workspace.notes.web_media import mirror_web_source_images
from okf_workspace.okf.file_io import FileWriteConflict
from okf_workspace.okf.frontmatter import read_document, write_document
from okf_workspace.okf.paths import resolve_bundle_path
from okf_workspace.projections.navigation import rebuild_root_index
from okf_workspace.retrieval.context import ContextReader
from okf_workspace.retrieval.index import SearchIndex
from okf_workspace.retrieval.search import HybridSearcher
from okf_workspace.retrieval.trace import write_trace
from okf_workspace.retrieval.vector import FastEmbedder, VectorIndex
from okf_workspace.semantic import (
    SemanticKind,
    SemanticOperationService,
    SemanticRunner,
    SemanticStatus,
)
from okf_workspace.semantic.worker import SemanticWorker, SemanticWorkerProcess

from .auth import LocalTokenStore

MAX_DOCUMENT_UPLOAD_BYTES = 64 * 1024 * 1024


class CaptureRequest(BaseModel):
    title: str = Field(min_length=1, max_length=160)
    content: str = Field(default="", max_length=200_000)
    course: str | None = Field(default=None, max_length=500)
    project: str | None = Field(default=None, max_length=500)


class CaptureBatchRequest(BaseModel):
    action: Literal["discard"]
    paths: list[str] = Field(min_length=1, max_length=200)


class WebCapturePublishRequest(BaseModel):
    path: str = Field(min_length=1, max_length=500)
    action: Literal["learn-now", "learn-later", "wiki-now", "source-only"]
    course: str | None = Field(default=None, max_length=160)
    project: str | None = Field(default=None, max_length=160)


class DailyRequest(BaseModel):
    date: Date | None = None


class ReflectionRequest(BaseModel):
    title: str = Field(min_length=1, max_length=160)
    content: str = Field(default="", max_length=200_000)


class NamedAreaRequest(BaseModel):
    title: str = Field(min_length=1, max_length=160)
    slug: str | None = Field(default=None, max_length=160)


class LessonRequest(BaseModel):
    course: str = Field(min_length=1, max_length=160)
    title: str = Field(min_length=1, max_length=160)
    content: str = Field(default="", max_length=200_000)
    date: Date | None = None


class AskRequest(BaseModel):
    query: str = Field(min_length=1, max_length=20_000)
    scope: Literal["auto", "all", "technical", "learning", "projects", "life"] = "auto"
    paths: list[str] = Field(default_factory=list)
    limit: int = Field(default=8, ge=1, le=20)


class OrganizeRequest(BaseModel):
    path: str
    destination: Literal[
        "reflection",
        "wiki",
        "study-guide",
        "lesson",
        "project-log",
    ]
    title: str | None = None
    project: str | None = None
    course: str | None = None


class ProjectLogRequest(BaseModel):
    content: str = Field(min_length=1, max_length=100_000)


class NoteAIRequest(BaseModel):
    path: str


class WikiDraftRequest(BaseModel):
    title: str = Field(min_length=1, max_length=160)
    paths: list[str] = Field(min_length=1, max_length=12)
    instruction: str = Field(default="", max_length=20_000)


class SectionRewriteRequest(BaseModel):
    path: str
    heading: str = Field(min_length=1, max_length=300)
    instruction: str = Field(min_length=1, max_length=20_000)


class NoteFieldsRequest(BaseModel):
    status: Literal["draft", "stable", "deprecated"] | None = None
    studied: bool | None = None


class FeedDecisionRequest(BaseModel):
    action: Literal[
        "learn-now",
        "learn-later",
        "wiki-now",
        "source-only",
        "ignore",
    ]
    course: str | None = Field(default=None, max_length=500)
    project: str | None = Field(default=None, max_length=500)


class DocumentRouteRequest(BaseModel):
    intent: Literal["learn", "wiki", "source", "later"]
    course: str | None = None
    project: str | None = None
    generate: bool = False


class FeedIngestRequest(BaseModel):
    payload: dict[str, object]
    content_by_artifact: dict[str, str] = Field(default_factory=dict)


class SubscriptionPreviewRequest(BaseModel):
    url: str = Field(min_length=1, max_length=4096)
    name: str | None = Field(default=None, min_length=1, max_length=300)
    adapter: Literal["auto", "rss", "github_repository", "github_releases"] = "auto"


class SubscriptionConfirmRequest(BaseModel):
    preview_id: str = Field(min_length=1, max_length=300)
    expected_registry_revision: str = Field(pattern=r"^[0-9a-f]{64}$")
    idempotency_key: str = Field(min_length=1, max_length=128)
    include_existing: bool | None = None
    content_mode: Literal["summary", "full"] | None = None
    content_max_chars: int | None = Field(default=None, ge=100, le=20_000)


class SubscriptionMutationRequest(BaseModel):
    expected_registry_revision: str = Field(pattern=r"^[0-9a-f]{64}$")
    idempotency_key: str = Field(min_length=1, max_length=128)


class SubscriptionRemoveRequest(SubscriptionMutationRequest):
    confirm: bool


class RetryRequest(BaseModel):
    parser: Literal["mineru", "markitdown"] | None = None


class SemanticCreateRequest(BaseModel):
    kind: Literal["generate-study-guide", "refresh-study-guide", "generate-wiki"]
    target: str = Field(min_length=1, max_length=500)
    sources: list[str] = Field(default_factory=list, max_length=20)
    instruction: str = Field(default="", max_length=20_000)
    course: str | None = Field(default=None, max_length=160)
    project: str | None = Field(default=None, max_length=160)


def _feed(value: str) -> FeedKind:
    try:
        return FeedKind(value)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail="unknown feed") from exc


def _relative(path: Path, root: Path) -> str:
    try:
        return path.resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        return path.name


def _optional_relative(path: Path | None, root: Path) -> str | None:
    return _relative(path, root) if path is not None else None


def _safe_checkpoint(repository: Path, message: str) -> None:
    """Best-effort checkpoint used after latency-sensitive writes."""

    with suppress(GitCheckpointError):
        create_checkpoint(repository, message)


def _conversion_public(record: dict[str, object], vault: Path) -> dict[str, object]:
    result = {
        key: value for key, value in record.items() if key not in {"original_path", "source_sha256"}
    }
    outputs_value = result.get("outputs")
    if not isinstance(result.get("stages"), dict) and isinstance(outputs_value, dict):
        export_value = cast(dict[object, object], outputs_value).get("export")
        if isinstance(export_value, str) and (Path(export_value) / "manifest.json").is_file():
            result["stages"] = {
                "conversion": "completed",
                "routing": "failed" if result.get("status") == "failed" else "pending",
            }
    outputs: dict[str, str] = {}
    if isinstance(outputs_value, dict):
        for key, value in cast(dict[object, object], outputs_value).items():
            if not isinstance(value, str):
                continue
            name = str(key)
            public_name = {
                "source_record": "source",
                "source_extract": "source_text",
                "routed_draft": "routed_target",
            }.get(name, name)
            if public_name in {"source", "source_text", "routed_target"}:
                outputs[public_name] = _relative(Path(value), vault)
            elif name != "export":
                outputs[name] = value
    result["outputs"] = outputs
    return result


def create_app(
    paths: BrainPaths | None = None,
    *,
    document_importer: DocumentImporter | None = None,
    semantic_runner: SemanticRunner | None = None,
    semantic_enabled: bool | None = None,
) -> FastAPI:
    configured = paths or BrainPaths.from_env()
    token_store = LocalTokenStore(configured.state)
    token_store.ensure()
    vector_runtime: tuple[VectorIndex, FastEmbedder] | None = None
    vector_unavailable = False
    semantics_enabled = (
        semantic_enabled
        if semantic_enabled is not None
        else os.environ.get("OKF_SEMANTIC_AUTOMATION", "false").casefold()
        in {"1", "true", "yes", "on"}
    )
    semantic_service: SemanticOperationService | None = None
    semantic_process: SemanticWorkerProcess | None = None
    injected_worker: SemanticWorker | None = None
    injected_worker_stop: threading.Event | None = None
    injected_worker_thread: threading.Thread | None = None
    if semantics_enabled:
        semantic_service = SemanticOperationService(configured.vault, configured.state)
        if semantic_runner is None:
            semantic_process = SemanticWorkerProcess(configured.vault, configured.state)
        else:
            injected_worker = SemanticWorker(
                configured.vault,
                configured.state,
                semantic_runner,
            )
            injected_worker_stop = threading.Event()
    configured_importer = document_importer or DocumentImporter(
        vault=configured.vault,
        originals=configured.originals,
        state=configured.state,
    )
    document_worker = (
        None
        if document_importer is not None
        else DocumentImportWorker(
            configured_importer,
            semantic_service=semantic_service,
        )
    )
    document_worker_stop = threading.Event()
    document_worker_thread: threading.Thread | None = None

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncGenerator[None]:
        nonlocal document_worker_thread, injected_worker_thread
        if semantic_service is not None:
            semantic_service.reconcile_pending()
        if semantic_process is not None:
            semantic_process.start()
        if injected_worker is not None and injected_worker_stop is not None:
            injected_worker_thread = threading.Thread(
                target=injected_worker.run_forever,
                args=(injected_worker_stop,),
                name="okf-injected-semantic-worker",
                daemon=True,
            )
            injected_worker_thread.start()
        if document_worker is not None:
            document_worker_thread = threading.Thread(
                target=document_worker.run_forever,
                args=(document_worker_stop,),
                name="okf-document-import-worker",
                daemon=True,
            )
            document_worker_thread.start()
        yield
        document_worker_stop.set()
        if document_worker_thread is not None:
            document_worker_thread.join(timeout=2)
        if injected_worker_stop is not None:
            injected_worker_stop.set()
        if injected_worker_thread is not None:
            injected_worker_thread.join(timeout=2)
        if semantic_process is not None:
            semantic_process.stop()

    app = FastAPI(title="Workspace Local API", version=__version__, lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[
            "app://obsidian.md",
            "obsidian://open",
            "http://localhost",
            "https://localhost",
            "null",
        ],
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type"],
        allow_credentials=False,
        max_age=600,
    )
    app.state.paths = configured

    def require_semantics() -> SemanticOperationService:
        if semantic_service is None:
            raise HTTPException(status_code=503, detail="Codex semantic automation is disabled")
        return semantic_service

    def build_searcher(index: SearchIndex) -> HybridSearcher:
        nonlocal vector_runtime, vector_unavailable
        enabled = os.environ.get("OKF_VECTOR_SEARCH", "auto").casefold() not in {
            "0",
            "false",
            "off",
        }
        if not enabled or vector_unavailable or not configured.vector_database.is_file():
            return HybridSearcher(index)
        if vector_runtime is None:
            try:
                model = os.environ.get(
                    "OKF_EMBEDDING_MODEL",
                    "BAAI/bge-small-zh-v1.5",
                )
                vectors = VectorIndex(configured.vector_database)
                embedder = FastEmbedder(model)
                vector_runtime = (vectors, embedder)
            except RuntimeError:
                vector_unavailable = True
                return HybridSearcher(index)
        vectors, embedder = vector_runtime
        vectors.sync(index, embedder)
        return HybridSearcher(index, vector_index=vectors, embedder=embedder)

    def sync_indexes(
        *,
        force: bool = False,
        include_vectors: bool = False,
    ) -> dict[str, object]:
        rebuild_root_index(configured.vault)
        index = SearchIndex(configured.vault, configured.search_database)
        result = index.sync(force=force)
        response: dict[str, object] = asdict(result)
        # Interactive Vault changes only need the inexpensive lexical index.
        # Vector embedding is deliberately reserved for an explicit rebuild or
        # the isolated semantic worker so it cannot starve the local API.
        if include_vectors and configured.vector_database.is_file():
            searcher = build_searcher(index)
            response["vectors_enabled"] = searcher.vector_index is not None
        else:
            response["vectors_enabled"] = configured.vector_database.is_file()
            response["vectors_refreshed"] = False
        return response

    @app.exception_handler(FileNotFoundError)
    def missing_resource(_request: Request, _error: FileNotFoundError) -> JSONResponse:
        return JSONResponse(status_code=404, content={"detail": "resource not found"})

    @app.exception_handler(FileExistsError)
    def existing_resource(_request: Request, _error: FileExistsError) -> JSONResponse:
        return JSONResponse(status_code=409, content={"detail": "target already exists"})

    @app.exception_handler(FileWriteConflict)
    def stale_ai_write(_request: Request, _error: FileWriteConflict) -> JSONResponse:
        return JSONResponse(
            status_code=409, content={"detail": "target changed during AI generation"}
        )

    @app.exception_handler(AIInputTooLarge)
    def ai_input_too_large(_request: Request, error: AIInputTooLarge) -> JSONResponse:
        return JSONResponse(status_code=413, content={"detail": str(error)})

    @app.exception_handler(AIOutputError)
    def invalid_ai_output(_request: Request, error: AIOutputError) -> JSONResponse:
        return JSONResponse(status_code=502, content={"detail": str(error)})

    @app.exception_handler(ValueError)
    def invalid_request(_request: Request, error: ValueError) -> JSONResponse:
        return JSONResponse(status_code=400, content={"detail": str(error)[:300]})

    @app.exception_handler(SubscriptionError)
    def subscription_error(_request: Request, error: SubscriptionError) -> JSONResponse:
        return JSONResponse(
            status_code=error.status_code,
            content={"detail": error.public()},
        )

    def authorize(authorization: Annotated[str | None, Header()] = None) -> None:
        scheme, _, value = (authorization or "").partition(" ")
        if scheme.casefold() != "bearer" or not token_store.verify(value):
            raise HTTPException(status_code=401, detail="invalid local token")

    protected = [Depends(authorize)]

    @app.get("/health")
    async def health() -> dict[str, object]:
        return {"status": "ok", "service": "okf-workspace", "pairing_required": True}

    @app.get("/today", dependencies=protected)
    def get_today(target_date: Date | None = None) -> dict[str, object]:
        return today_view(configured.vault, configured.state, target_date)

    @app.get("/dashboard/{area}", dependencies=protected)
    def get_dashboard(area: str) -> dict[str, object]:
        return dashboard_view(configured.vault, area)

    @app.get("/dashboard/feeds/summary", dependencies=protected)
    def get_feed_dashboard() -> dict[str, object]:
        return feed_dashboard(configured.state)

    @app.get("/dashboard/feeds/subscriptions", dependencies=protected)
    def get_feed_subscriptions(
        limit: Annotated[int, Query(ge=1, le=50)] = 20,
        cursor: str | None = None,
        source_id: Annotated[str | None, Query(max_length=500)] = None,
    ) -> dict[str, object]:
        try:
            return subscription_dashboard(
                configured.state,
                limit=limit,
                cursor=cursor,
                source_id=source_id,
            )
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error

    @app.get("/dashboard/feeds/subscription-sources", dependencies=protected)
    def get_feed_subscription_sources(
        limit: Annotated[int, Query(ge=1, le=8)] = 8,
        cursor: str | None = None,
        query: Annotated[str | None, Query(max_length=200)] = None,
    ) -> dict[str, object]:
        try:
            return subscription_sources_dashboard(
                configured.state,
                limit=limit,
                cursor=cursor,
                query=query,
            )
        except FeedProjectionTooLarge as error:
            raise HTTPException(status_code=413, detail=str(error)) from error
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error

    @app.get(
        "/dashboard/feeds/subscription-sources/{source_id:path}/latest-items",
        dependencies=protected,
    )
    def get_feed_subscription_source_latest_items(
        source_id: str,
        limit: Annotated[int, Query(ge=1, le=50)] = 40,
        cursor: Annotated[str | None, Query(max_length=4096)] = None,
    ) -> dict[str, object]:
        try:
            return subscription_source_latest_items_dashboard(
                configured.state,
                source_id,
                limit=limit,
                cursor=cursor,
            )
        except KeyError as error:
            raise HTTPException(status_code=404, detail="Reading source not found") from error
        except FeedProjectionTooLarge as error:
            raise HTTPException(status_code=413, detail=str(error)) from error
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error

    @app.get("/notes", dependencies=protected)
    def get_notes(
        note_type: str | None = None,
        status: str | None = None,
        studied: bool | None = None,
        include_self: bool = False,
    ) -> list[dict[str, object]]:
        notes = scan_notes(configured.vault, include_self=include_self)
        return [
            asdict(note)
            for note in notes
            if (note_type is None or note.note_type == note_type)
            and (status is None or note.status == status)
            and (studied is None or (note.studied_at is not None) is studied)
        ]

    @app.post("/daily", dependencies=protected)
    def create_daily(request: DailyRequest) -> dict[str, str]:
        path = NoteService(configured.vault).create_daily(request.date)
        return {"path": _relative(path, configured.vault)}

    @app.post("/captures", dependencies=protected)
    def create_capture(request: CaptureRequest) -> dict[str, str]:
        path = NoteService(configured.vault).create_capture(
            request.title,
            request.content,
            course=request.course,
            project=request.project,
        )
        return {"path": _relative(path, configured.vault)}

    @app.post("/reflections", dependencies=protected)
    def create_reflection(request: ReflectionRequest) -> dict[str, str]:
        path = NoteService(configured.vault).create_reflection(request.title, request.content)
        return {"path": _relative(path, configured.vault)}

    @app.post("/courses", dependencies=protected)
    def create_course(request: NamedAreaRequest) -> dict[str, str]:
        path = NoteService(configured.vault).create_course(
            request.slug or request.title,
            request.title,
        )
        return {"path": _relative(path, configured.vault)}

    @app.post("/lessons", dependencies=protected)
    def create_lesson(request: LessonRequest) -> dict[str, str]:
        path = NoteService(configured.vault).create_lesson(
            request.course,
            request.title,
            lesson_date=request.date,
            human_notes=request.content,
        )
        return {"path": _relative(path, configured.vault)}

    @app.post("/projects", dependencies=protected)
    def create_project(request: NamedAreaRequest) -> dict[str, str]:
        path = NoteService(configured.vault).create_project(
            request.slug or request.title,
            request.title,
        )
        return {"path": _relative(path, configured.vault)}

    @app.post("/projects/{slug}/log", dependencies=protected)
    def append_project_log(slug: str, request: ProjectLogRequest) -> dict[str, str]:
        create_checkpoint(configured.vault, "checkpoint before project progress")
        path = NoteService(configured.vault).append_project_log(slug, request.content)
        create_checkpoint(configured.vault, f"project: record progress for {slug}")
        return {"path": _relative(path, configured.vault)}

    @app.post("/notes/{note_path:path}/fields", dependencies=protected)
    def update_note_fields(note_path: str, request: NoteFieldsRequest) -> dict[str, str]:
        path = resolve_bundle_path(configured.vault, note_path)
        document = read_document(path)
        if request.status is not None:
            if request.status == "stable":
                document.frontmatter.pop("status", None)
            else:
                document.frontmatter["status"] = request.status
        if request.studied is not None:
            if document.type not in {"Study Guide", "Wiki"}:
                raise HTTPException(
                    status_code=400,
                    detail=f"studied is not valid for {document.type}",
                )
            if request.studied:
                document.frontmatter["studied_at"] = datetime.now(UTC).isoformat(timespec="seconds")
            else:
                document.frontmatter.pop("studied_at", None)
        create_checkpoint(configured.vault, "checkpoint before note status update")
        write_document(path, document)
        create_checkpoint(configured.vault, f"note: update status for {note_path}")
        return {"path": note_path}

    @app.post("/ai/ask", dependencies=protected)
    def ask(request: AskRequest) -> dict[str, object]:
        index = SearchIndex(configured.vault, configured.search_database)
        index.sync()
        searcher = build_searcher(index)
        service = AnswerService(
            searcher,
            ContextReader(index),
            provider_from_env(),
        )
        result = service.ask(
            request.query,
            scope=request.scope,
            explicit_paths=tuple(request.paths),
            candidate_limit=request.limit,
        )
        trace = write_trace(
            configured.trace_directory,
            query=request.query,
            hits=list(result.candidates),
            contexts=list(result.contexts),
        )
        return {
            "answer": result.answer,
            "actual_reads": [asdict(item) for item in result.contexts],
            "trace_id": trace.stem,
        }

    @app.post("/ai/organize", dependencies=protected)
    def organize(request: OrganizeRequest) -> dict[str, str]:
        capture = resolve_bundle_path(configured.vault, request.path)
        target = process_capture(
            configured.vault,
            request.path,
            destination=request.destination,
            title=request.title,
            project=request.project,
            course=request.course,
        )
        return {
            "created_or_updated": _relative(target, configured.vault),
            "capture_deleted": _relative(capture, configured.vault),
        }

    def explicit_ai() -> ExplicitAIWorkflows:
        return ExplicitAIWorkflows(
            configured.vault,
            provider_from_env(),
        )

    @app.post("/ai/projects/{slug}/summarize", dependencies=protected)
    def summarize_project(slug: str) -> dict[str, object]:
        path, reads = explicit_ai().summarize_project(slug)
        return {"path": _relative(path, configured.vault), "actual_reads": reads}

    @app.post("/ai/lessons/organize", dependencies=protected)
    def organize_lesson(request: NoteAIRequest) -> dict[str, object]:
        path, reads = explicit_ai().organize_lesson(request.path)
        return {"path": _relative(path, configured.vault), "actual_reads": reads}

    @app.post("/ai/learning/plan", dependencies=protected)
    def create_learning_plan(request: NoteAIRequest) -> dict[str, object]:
        path, reads = explicit_ai().create_learning_plan(request.path)
        return {"path": _relative(path, configured.vault), "actual_reads": reads}

    @app.post("/ai/self-test", dependencies=protected)
    def create_self_test(request: NoteAIRequest) -> dict[str, object]:
        content, reads = explicit_ai().self_test(request.path)
        return {"content": content, "actual_reads": reads}

    @app.post("/ai/knowledge/create", dependencies=protected)
    def create_sourced_wiki(request: WikiDraftRequest) -> dict[str, object]:
        path, reads = explicit_ai().create_wiki_from_sources(
            request.title,
            tuple(request.paths),
            instruction=request.instruction,
        )
        return {"path": _relative(path, configured.vault), "actual_reads": reads}

    @app.post("/ai/section/rewrite", dependencies=protected)
    def rewrite_note_section(request: SectionRewriteRequest) -> dict[str, object]:
        path, reads = explicit_ai().rewrite_section(
            request.path,
            request.heading,
            request.instruction,
        )
        return {"path": _relative(path, configured.vault), "actual_reads": reads}

    @app.post("/captures/{capture_path:path}/discard", dependencies=protected)
    def discard(capture_path: str) -> dict[str, str]:
        deleted = discard_capture(configured.vault, capture_path)
        return {"capture_deleted": _relative(deleted, configured.vault)}

    @app.post("/captures/batch", dependencies=protected)
    def batch_captures(request: CaptureBatchRequest) -> dict[str, object]:
        deleted = batch_discard_captures(configured.vault, request.paths)
        return {
            "action": request.action,
            "count": len(deleted),
            "deleted": [_relative(path, configured.vault) for path in deleted],
        }

    @app.post("/captures/publish-web", dependencies=protected)
    def publish_clipped_web_page(
        request: WebCapturePublishRequest,
        background_tasks: BackgroundTasks,
    ) -> dict[str, object]:
        generate = request.action in {"learn-now", "wiki-now"}
        if generate and semantic_service is None:
            raise HTTPException(
                status_code=503,
                detail="Codex semantic automation is disabled; Capture was not published",
            )
        if request.action in {"learn-now", "learn-later"}:
            intent: Literal["learn", "wiki", "source"] = "learn"
        elif request.action == "wiki-now":
            intent = "wiki"
        else:
            intent = "source"
        result = publish_web_capture(
            configured.vault,
            request.path,
            intent=intent,
            course=request.course,
            project=request.project,
        )
        public: dict[str, object] = {
            "action": request.action,
            "source": _relative(result.source, configured.vault),
            "source_text": _relative(result.source_text, configured.vault),
            "routed_target": _optional_relative(result.routed_target, configured.vault),
            "reused": result.reused,
        }
        if (
            result.routed_target is not None
            and generate
            and semantic_service is not None
            and intent in {"learn", "wiki"}
        ):
            try:
                public["semantic_operation"] = semantic_service.enqueue(
                    SemanticKind.GENERATE_STUDY_GUIDE
                    if intent == "learn"
                    else SemanticKind.GENERATE_WIKI,
                    _relative(result.routed_target, configured.vault),
                    sources=(
                        _relative(result.source, configured.vault),
                        _relative(result.source_text, configured.vault),
                    ),
                    course=request.course,
                    project=request.project,
                )
            except Exception:  # The Source pair is already durable and remains retryable.
                public["semantic_error"] = "Source 已发布，但生成任务未入队；请从待生成区重试"
        if os.environ.get("OKF_WEB_MEDIA_MIRROR", "true").casefold() not in {
            "0",
            "false",
            "off",
        }:
            background_tasks.add_task(
                mirror_web_source_images,
                configured.vault,
                _relative(result.source_text, configured.vault),
            )
        return public

    @app.get("/captures/{capture_path:path}/recommend", dependencies=protected)
    def recommend_capture(capture_path: str) -> dict[str, str]:
        return recommend_capture_destination(configured.vault, capture_path)

    @app.post("/documents/import", dependencies=protected)
    async def import_document(
        file: Annotated[UploadFile, File()],
        intent: Annotated[str, Form()],
        quality: Annotated[str, Form()] = "quick",
        parser: Annotated[str, Form()] = "auto",
        course: Annotated[str | None, Form()] = None,
        project: Annotated[str | None, Form()] = None,
        generate: Annotated[bool, Form()] = False,
    ) -> dict[str, object]:
        filename = Path(file.filename or "upload.bin").name
        upload = configured.state / "uploads" / f"{uuid.uuid4()}-{filename}"
        try:
            if file.size is not None and file.size > MAX_DOCUMENT_UPLOAD_BYTES:
                raise HTTPException(
                    status_code=413,
                    detail=f"document upload exceeds {MAX_DOCUMENT_UPLOAD_BYTES} bytes",
                )
            upload.parent.mkdir(parents=True, exist_ok=True)
            total_bytes = 0
            with upload.open("wb") as target:
                while chunk := await file.read(1024 * 1024):
                    total_bytes += len(chunk)
                    if total_bytes > MAX_DOCUMENT_UPLOAD_BYTES:
                        raise HTTPException(
                            status_code=413,
                            detail=f"document upload exceeds {MAX_DOCUMENT_UPLOAD_BYTES} bytes",
                        )
                    target.write(chunk)
            import_request = ImportRequest(
                source=upload,
                intent=ImportIntent(intent),
                source_filename=filename,
                quality=ImportQuality(quality),
                parser=None if parser == "auto" else ParserName(parser),
                course=course,
                project=project,
                generate=generate,
            )
            if document_worker is not None:
                queued = configured_importer.enqueue(import_request)
                return _conversion_public(queued, configured.vault)
            result = configured_importer.import_document(import_request)
        finally:
            upload.unlink(missing_ok=True)
        semantic_operation: dict[str, object] | None = None
        wants_study = result.routed_target is not None and (
            result.status is ConversionStatus.IMPORTED
            and ImportIntent(intent) in {ImportIntent.LEARN, ImportIntent.COURSE}
            and generate
        )
        wants_wiki = result.routed_target is not None and ImportIntent(intent) is ImportIntent.WIKI
        if (wants_study or wants_wiki) and semantic_service is not None:
            target = _relative(cast(Path, result.routed_target), configured.vault)
            sources = tuple(
                _relative(Path(path), configured.vault)
                for path in (result.source, result.source_text)
                if path is not None
            )
            semantic_operation = semantic_service.enqueue(
                SemanticKind.GENERATE_STUDY_GUIDE if wants_study else SemanticKind.GENERATE_WIKI,
                target,
                sources=sources,
                course=course,
                project=project,
            )
        return {
            "conversion_id": result.conversion_id,
            "status": result.status.value,
            "parser": result.parser.value,
            "source": _optional_relative(result.source, configured.vault),
            "source_text": _optional_relative(result.source_text, configured.vault),
            "routed_target": _optional_relative(result.routed_target, configured.vault),
            "qc": asdict(result.qc),
            "semantic_operation": semantic_operation,
        }

    @app.post("/documents/sources/{source_path:path}/route", dependencies=protected)
    def route_imported_source(
        source_path: str,
        request: DocumentRouteRequest,
    ) -> dict[str, object]:
        source, extract, draft = route_existing_import(
            configured.vault,
            resolve_bundle_path(configured.vault, source_path),
            intent=ImportIntent(request.intent),
            course=request.course,
            project=request.project,
        )
        public: dict[str, object] = {
            "source": _relative(source, configured.vault),
            "source_text": _relative(extract, configured.vault),
            "routed_target": _optional_relative(draft, configured.vault),
        }
        if (
            draft is not None
            and request.generate
            and semantic_service is not None
            and request.intent in {"learn", "wiki"}
        ):
            public["semantic_operation"] = semantic_service.enqueue(
                SemanticKind.GENERATE_STUDY_GUIDE
                if request.intent == "learn"
                else SemanticKind.GENERATE_WIKI,
                _relative(draft, configured.vault),
                sources=(
                    _relative(source, configured.vault),
                    _relative(extract, configured.vault),
                ),
                course=request.course,
                project=request.project,
            )
        return public

    @app.get("/documents/conversions/{conversion_id}", dependencies=protected)
    def get_conversion(conversion_id: str) -> dict[str, object]:
        return _conversion_public(
            ConversionStore(configured.state).load(conversion_id),
            configured.vault,
        )

    @app.get("/documents/conversions", dependencies=protected)
    def list_conversions(status: str | None = None) -> list[dict[str, object]]:
        selected = None
        if status is not None:
            try:
                selected = ConversionStatus(status)
            except ValueError as exc:
                raise HTTPException(status_code=400, detail="unknown conversion status") from exc
        return [
            _conversion_public(record, configured.vault)
            for record in ConversionStore(configured.state).list(status=selected)
        ]

    @app.post("/documents/conversions/{conversion_id}/retry", dependencies=protected)
    def retry_conversion(conversion_id: str, request: RetryRequest) -> dict[str, object]:
        selected = ParserName(request.parser) if request.parser else None
        if document_worker is not None:
            return _conversion_public(
                configured_importer.store.queue_retry(conversion_id, parser=selected),
                configured.vault,
            )
        result = configured_importer.retry(
            conversion_id,
            parser=selected,
        )
        return _conversion_public(
            ConversionStore(configured.state).load(result.conversion_id),
            configured.vault,
        )

    @app.get("/feeds/{feed}/digests", dependencies=protected)
    def list_feed_digests(feed: str) -> list[dict[str, object]]:
        return [
            {
                "digest_id": edition.edition_id,
                "issued_at": edition.edition_at,
                "title": edition.title,
                "section": edition.stream,
                "item_count": len(edition.items),
            }
            for edition in FeedCache(configured.state).list_editions(_feed(feed))
        ]

    @app.get("/feeds/{feed}/digests/{digest_id}", dependencies=protected)
    def get_feed_digest(feed: str, digest_id: str) -> dict[str, object]:
        edition = FeedCache(configured.state).get(_feed(feed), digest_id)
        return {
            "digest_id": edition.edition_id,
            "feed": edition.feed.value,
            "issued_at": edition.edition_at,
            "title": edition.title,
            "items": [
                {
                    **{key: value for key, value in asdict(item).items() if key != "edition_id"},
                    "digest_id": item.edition_id,
                }
                for item in edition.items
            ],
            "section": edition.stream,
            "quality": edition.quality,
            "quality_reason": edition.quality_reason,
        }

    @app.post("/feeds/{feed}/digests/{digest_id}/open", dependencies=protected)
    def open_feed_digest(feed: str, digest_id: str) -> dict[str, str]:
        edition = FeedCache(configured.state).get(_feed(feed), digest_id)
        path = materialize_edition(configured.vault, edition)
        return {
            "vault_path": _relative(path, configured.vault),
            "markdown": path.read_text(encoding="utf-8"),
        }

    @app.post("/feeds/{feed}/items/{item_id}/decision", dependencies=protected)
    def decide_feed_item(
        feed: str,
        item_id: str,
        request: FeedDecisionRequest,
        background_tasks: BackgroundTasks,
    ) -> dict[str, object]:
        kind = _feed(feed)
        item = FeedCache(configured.state).find_item(kind, item_id)
        result = FeedDecisionService(configured.vault, configured.state).decide(
            item,
            DecisionAction(request.action),
            checkpoint=False,
            course=request.course,
            project=request.project,
        )
        public = asdict(result)
        for key in ("source", "source_text", "study_guide", "wiki"):
            value = public.get(key)
            if isinstance(value, str):
                public[key] = _relative(Path(value), configured.vault)
        target_path = result.study_guide or result.wiki
        generate_now = result.action in {
            DecisionAction.LEARN_NOW,
            DecisionAction.WIKI_NOW,
        }
        if target_path is not None and generate_now and semantic_service is not None:
            sources = tuple(
                _relative(Path(path), configured.vault)
                for path in (result.source, result.source_text)
                if path is not None
            )
            operation = semantic_service.enqueue(
                SemanticKind.GENERATE_STUDY_GUIDE
                if result.study_guide is not None
                else SemanticKind.GENERATE_WIKI,
                _relative(Path(target_path), configured.vault),
                sources=sources,
            )
            FeedDecisionService(configured.vault, configured.state).store.attach_semantic_operation(
                item,
                str(operation["operation_id"]),
            )
            public["semantic_operation"] = operation
        if result.source is not None:
            background_tasks.add_task(
                _safe_checkpoint,
                configured.vault,
                f"feed: {result.action.value} {item.item_id}",
            )
        return public

    @app.get("/feeds/{feed}/items/{item_id}/decision", dependencies=protected)
    def get_feed_item_decision(feed: str, item_id: str) -> dict[str, object]:
        kind = _feed(feed)
        item = FeedCache(configured.state).find_item(kind, item_id)
        stored = FeedDecisionService(configured.vault, configured.state).store.load(item)
        if stored is None:
            raise HTTPException(status_code=404, detail="feed decision not found")
        outputs = stored.get("outputs")
        if not isinstance(outputs, dict):
            raise HTTPException(status_code=500, detail="feed decision result is invalid")
        public = dict(cast(dict[str, object], outputs))
        aliases = {
            "source_record": "source",
            "source_extract": "source_text",
            "learning_material": "study_guide",
        }
        for legacy, current in aliases.items():
            if legacy in public and current not in public:
                public[current] = public.pop(legacy)
        for key in ("source", "source_text", "study_guide", "wiki"):
            value = public.get(key)
            if isinstance(value, str):
                public[key] = _relative(Path(value), configured.vault)
        operation_id = stored.get("semantic_operation_id")
        if isinstance(operation_id, str) and semantic_service is not None:
            with suppress(FileNotFoundError, ValueError):
                public["semantic_operation"] = semantic_service.store.load(operation_id)
        return public

    @app.post("/feeds/{feed}/ingest", dependencies=protected)
    def ingest_feed(feed: str, request: FeedIngestRequest) -> list[dict[str, object]]:
        kind = _feed(feed)
        editions = (
            ai_daily_from_v1(
                request.payload,
                content_by_artifact=request.content_by_artifact,
            )
            if kind is FeedKind.AI_DAILY
            else [treehole_from_v1(request.payload)]
        )
        cache = FeedCache(configured.state)
        return [
            {"digest_id": edition.edition_id, "cached": cache.put(edition).is_file()}
            for edition in editions
        ]

    @app.get("/feeds/subscriptions", dependencies=protected)
    def list_feed_subscriptions() -> dict[str, object]:
        return SubscriptionService(configured.state).list_sources()

    @app.post("/feeds/subscriptions/preview", dependencies=protected)
    def preview_feed_subscription(
        request: SubscriptionPreviewRequest,
    ) -> dict[str, object]:
        return SubscriptionService(configured.state).preview(
            request.model_dump(exclude_none=True)
        )

    @app.post("/feeds/subscriptions/confirm", dependencies=protected)
    def confirm_feed_subscription(
        request: SubscriptionConfirmRequest,
    ) -> dict[str, object]:
        return SubscriptionService(configured.state).confirm(
            request.model_dump(exclude_none=True)
        )

    @app.post(
        "/feeds/subscriptions/{source_id:path}/enable",
        dependencies=protected,
    )
    def enable_feed_subscription(
        source_id: str,
        request: SubscriptionMutationRequest,
    ) -> dict[str, object]:
        return SubscriptionService(configured.state).set_enabled(
            source_id,
            True,
            request.model_dump(),
        )

    @app.post(
        "/feeds/subscriptions/{source_id:path}/disable",
        dependencies=protected,
    )
    def disable_feed_subscription(
        source_id: str,
        request: SubscriptionMutationRequest,
    ) -> dict[str, object]:
        return SubscriptionService(configured.state).set_enabled(
            source_id,
            False,
            request.model_dump(),
        )

    @app.post(
        "/feeds/subscriptions/{source_id:path}/remove",
        dependencies=protected,
    )
    def remove_feed_subscription(
        source_id: str,
        request: SubscriptionRemoveRequest,
    ) -> dict[str, object]:
        return SubscriptionService(configured.state).remove(
            source_id,
            request.model_dump(),
        )

    @app.post("/feeds/sync", dependencies=protected)
    def sync_feeds() -> list[dict[str, object]]:
        syncer = FeedSyncer(configured.state)
        synchronized = syncer.sync_all()
        successes: list[dict[str, object]] = [
            {
                "feed": edition.feed.value,
                "status": "ok",
                "digest_id": edition.edition_id,
                "issued_at": edition.edition_at,
                "item_count": len(edition.items),
            }
            for editions in synchronized.values()
            for edition in editions
        ]
        failures: list[dict[str, object]] = [
            {
                "feed": failure.feed.value,
                "status": "error",
                "section": failure.stream,
                "detail": failure.detail,
            }
            for failure in syncer.failures
        ]
        return successes + failures

    @app.post("/index/rebuild", dependencies=protected)
    def rebuild_index() -> dict[str, object]:
        result = sync_indexes(force=True, include_vectors=True)
        result["vectors_refreshed"] = bool(result.get("vectors_enabled"))
        return result

    @app.post("/index/sync", dependencies=protected)
    def sync_index() -> dict[str, object]:
        return sync_indexes()

    @app.post("/semantic/operations", dependencies=protected)
    def create_semantic_operation(request: SemanticCreateRequest) -> dict[str, object]:
        return require_semantics().enqueue(
            SemanticKind(request.kind),
            request.target,
            sources=tuple(request.sources),
            instruction=request.instruction,
            course=request.course,
            project=request.project,
        )

    @app.get("/semantic/operations", dependencies=protected)
    def list_semantic_operations(status: str | None = None) -> list[dict[str, object]]:
        selected: SemanticStatus | None = None
        if status is not None:
            try:
                selected = SemanticStatus(status)
            except ValueError as exc:
                raise HTTPException(status_code=400, detail="unknown semantic status") from exc
        return require_semantics().store.list(status=selected)

    @app.get("/semantic/operations/{operation_id}", dependencies=protected)
    def get_semantic_operation(operation_id: str) -> dict[str, object]:
        return require_semantics().store.load(operation_id)

    @app.post("/semantic/operations/{operation_id}/retry", dependencies=protected)
    def retry_semantic_operation(operation_id: str) -> dict[str, object]:
        return require_semantics().retry(operation_id)

    @app.post("/semantic/operations/{operation_id}/cancel", dependencies=protected)
    def cancel_semantic_operation(operation_id: str) -> dict[str, object]:
        return require_semantics().cancel(operation_id)

    @app.post("/undo", dependencies=protected)
    def undo() -> dict[str, str]:
        return {"checkpoint": undo_last_checkpoint(configured.vault)}

    @app.get("/changes/latest", dependencies=protected)
    def latest_change() -> dict[str, object] | None:
        return latest_checkpoint_summary(configured.vault)

    @app.get("/system/status", dependencies=protected)
    def get_system_status(refresh_services: bool = False) -> dict[str, object]:
        return system_status(
            configured.vault,
            configured.state,
            refresh_services=refresh_services,
        )

    @app.get("/system/governance", dependencies=protected)
    def get_governance_report() -> dict[str, object]:
        return governance_report(configured.vault)

    return app
