"""Command-line entry point for deterministic OKF Workspace workflows."""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import asdict
from datetime import date
from pathlib import Path
from typing import NoReturn, cast

from okf_workspace.acceptance import (
    run_acceptance_suite,
    run_performance_benchmark,
    write_report,
)
from okf_workspace.ai import AISettings, AnswerService, OpenAICompatibleProvider
from okf_workspace.config import (
    BrainPaths,
    apply_deployment_config,
    default_template_root,
    repository_root,
)
from okf_workspace.dashboard.system import system_status
from okf_workspace.deployment import verify_restored_data
from okf_workspace.feeds import (
    DecisionAction,
    FeedCache,
    FeedDecisionService,
    FeedKind,
    FeedSyncer,
    materialize_edition,
)
from okf_workspace.feeds.adapters import ai_daily_from_v1, treehole_from_v1
from okf_workspace.fixtures import generate_fixture_vault
from okf_workspace.git import create_checkpoint, initialize_repository, undo_last_checkpoint
from okf_workspace.importers import (
    ConversionMethod,
    DocumentImporter,
    ImportIntent,
    ImportQuality,
    ImportRequest,
    ParserName,
)
from okf_workspace.migration import migrate_current_layout
from okf_workspace.notes import NoteService
from okf_workspace.notes.captures import CaptureDestination, process_capture
from okf_workspace.okf.templates import initialize_vault
from okf_workspace.okf.validator import validate_bundle
from okf_workspace.projections.navigation import rebuild_root_index
from okf_workspace.projections.today import build_today_snapshot
from okf_workspace.retrieval.context import ContextReader
from okf_workspace.retrieval.evaluation import run_private_evaluation
from okf_workspace.retrieval.index import SearchIndex
from okf_workspace.retrieval.search import HybridSearcher, ScopeName
from okf_workspace.retrieval.trace import write_trace
from okf_workspace.retrieval.vector import FastEmbedder, VectorIndex


def _date(value: str) -> date:
    try:
        return date.fromisoformat(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("date must use YYYY-MM-DD") from exc


def _fail(message: str) -> NoReturn:
    print(message, file=sys.stderr)
    raise SystemExit(1)


def _configure_windows_utf8_output() -> None:
    """Keep Markdown/JSON output lossless on Windows consoles using a legacy code page."""
    if os.name != "nt":
        return
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            reconfigure(encoding="utf-8", errors="backslashreplace")


def _print_json(payload: object, *, stringify_unknown: bool = False) -> None:
    """Write code-page-neutral JSON for native PowerShell pipelines.

    Windows PowerShell 5.1 can decode redirected native-process output with the
    active console code page even when the process itself writes UTF-8. Escaping
    non-ASCII characters keeps the transport ASCII-only; JSON consumers restore
    the original Unicode values when they parse it.
    """
    rendered = json.dumps(
        payload,
        ensure_ascii=True,
        indent=2,
        default=str if stringify_unknown else None,
    )
    print(rendered)


def _import_intent(value: str) -> ImportIntent:
    aliases = {"source-only": "source", "triage": "later"}
    return ImportIntent(aliases.get(value, value))


def build_parser() -> argparse.ArgumentParser:
    defaults = BrainPaths.from_env()
    parser = argparse.ArgumentParser(prog="okf", description="OKF-compatible personal Workspace")
    commands = parser.add_subparsers(dest="command", required=True)

    init = commands.add_parser("init", help="initialize a new OKF 0.2 Vault")
    init.add_argument("--vault", type=Path, default=defaults.vault)
    init.add_argument(
        "--with-git",
        action="store_true",
        help="opt into local Vault Git checkpoints",
    )

    migrate = commands.add_parser("migrate", help="migrate superseded queue and layout metadata")
    migrate.add_argument("--vault", type=Path, default=defaults.vault)
    migrate.add_argument("--state", type=Path, default=defaults.state)

    validate = commands.add_parser("validate", help="validate an OKF Bundle")
    validate.add_argument("--vault", type=Path, default=defaults.vault)
    validate.add_argument("--json", action="store_true", dest="json_output")
    validate.add_argument(
        "--standard",
        action="store_true",
        help="check portable OKF v0.2 conformance without the local Profile",
    )

    note = commands.add_parser("note", help="create canonical notes")
    note_commands = note.add_subparsers(dest="note_command", required=True)
    new = note_commands.add_parser("new")
    kinds = new.add_subparsers(dest="kind", required=True)

    daily = kinds.add_parser("daily")
    daily.add_argument("--vault", type=Path, default=defaults.vault)
    daily.add_argument("--date", type=_date)

    review = kinds.add_parser("review")
    review.add_argument("--vault", type=Path, default=defaults.vault)
    review.add_argument("--period", choices=("weekly", "monthly", "yearly"), required=True)
    review.add_argument("--date", type=_date)

    for kind in ("capture", "reflection", "wiki"):
        item = kinds.add_parser(kind)
        item.add_argument("--vault", type=Path, default=defaults.vault)
        item.add_argument("--title", required=True)
        item.add_argument("--content", default="")

    course = kinds.add_parser("course")
    course.add_argument("--vault", type=Path, default=defaults.vault)
    course.add_argument("--slug", required=True)
    course.add_argument("--title", required=True)

    lesson = kinds.add_parser("lesson")
    lesson.add_argument("--vault", type=Path, default=defaults.vault)
    lesson.add_argument("--course", required=True)
    lesson.add_argument("--title", required=True)
    lesson.add_argument("--date", type=_date)

    project_note = kinds.add_parser("project")
    project_note.add_argument("--vault", type=Path, default=defaults.vault)
    project_note.add_argument("--slug", required=True)
    project_note.add_argument("--title", required=True)

    project = commands.add_parser("project", help="project workflows")
    project_commands = project.add_subparsers(dest="project_command", required=True)
    log = project_commands.add_parser("log")
    log.add_argument("slug")
    log.add_argument("content")
    log.add_argument("--vault", type=Path, default=defaults.vault)

    tasks = commands.add_parser("tasks", help="refresh tasks in the root navigation")
    tasks.add_argument("action", choices=("rebuild",))
    tasks.add_argument("--vault", type=Path, default=defaults.vault)

    today = commands.add_parser("today", help="print the current Today projection")
    today.add_argument("--vault", type=Path, default=defaults.vault)
    today.add_argument("--date", type=_date)

    fixtures = commands.add_parser("fixtures", help="generate deterministic test data")
    fixtures.add_argument("action", choices=("generate",))
    fixtures.add_argument("--output", type=Path, required=True)

    checkpoint = commands.add_parser("checkpoint", help="commit a local recovery checkpoint")
    checkpoint.add_argument("--vault", type=Path, default=defaults.vault)
    checkpoint.add_argument("--message", default="checkpoint: save Vault state")

    undo = commands.add_parser("undo", help="revert the latest checkpoint commit")
    undo.add_argument("--vault", type=Path, default=defaults.vault)

    doctor = commands.add_parser("doctor", help="show only actionable system issues")
    doctor.add_argument("--vault", type=Path)
    doctor.add_argument("--state", type=Path)
    doctor.add_argument(
        "--config",
        type=Path,
        default=defaults.state / "config" / "deployment.json",
    )
    doctor.add_argument("--verbose", action="store_true")

    backup = commands.add_parser("backup", help="verify restored long-term data")
    backup_commands = backup.add_subparsers(dest="backup_command", required=True)
    verify_restore = backup_commands.add_parser("verify-restore")
    verify_restore.add_argument("--vault", type=Path, required=True)
    verify_restore.add_argument("--originals", type=Path, required=True)
    verify_restore.add_argument("--json", action="store_true", dest="json_output")

    index = commands.add_parser("index", help="manage rebuildable search indexes")
    index.add_argument("action", choices=("rebuild",))
    index.add_argument("--vault", type=Path, default=defaults.vault)
    index.add_argument("--state", type=Path, default=defaults.state)
    index.add_argument("--force", action="store_true")
    index.add_argument("--vectors", action="store_true")
    index.add_argument(
        "--vector-model",
        default=os.environ.get("OKF_EMBEDDING_MODEL", "BAAI/bge-small-zh-v1.5"),
    )

    for name, help_text in (
        ("search", "show retrieval candidates and ranking reasons"),
        ("context", "retrieve and re-open the real Markdown Codex should use"),
        ("ask", "answer from freshly read local Markdown"),
    ):
        query = commands.add_parser(name, help=help_text)
        query.add_argument("query")
        query.add_argument("--vault", type=Path, default=defaults.vault)
        query.add_argument("--state", type=Path, default=defaults.state)
        query.add_argument(
            "--scope",
            choices=("auto", "all", "technical", "learning", "projects", "life"),
            default="auto",
        )
        query.add_argument("--path", action="append", default=[])
        query.add_argument("--limit", type=int, default=8)
        query.add_argument(
            "--vector",
            action=argparse.BooleanOptionalAction,
            default=name == "context",
        )
        query.add_argument("--json", action="store_true", dest="json_output")
        query.add_argument(
            "--vector-model",
            default=os.environ.get("OKF_EMBEDDING_MODEL", "BAAI/bge-small-zh-v1.5"),
        )

    organize = commands.add_parser(
        "organize",
        help="explicitly turn a Capture into its chosen destination",
    )
    organize.add_argument("path")
    organize.add_argument(
        "--as",
        required=True,
        dest="destination",
        choices=(
            "reflection",
            "wiki",
            "study-guide",
            "lesson",
            "project-log",
        ),
    )
    organize.add_argument("--title")
    organize.add_argument("--project")
    organize.add_argument("--course")
    organize.add_argument("--vault", type=Path, default=defaults.vault)

    test = commands.add_parser("test", help="run reproducible acceptance checks")
    test_commands = test.add_subparsers(dest="test_command", required=True)
    retrieval = test_commands.add_parser("retrieval")
    retrieval.add_argument(
        "--manifest",
        type=Path,
        default=repository_root() / "tests" / "fixtures" / "local-private" / "manifest.yaml",
    )
    retrieval.add_argument(
        "--cases",
        type=Path,
        default=repository_root() / "tests" / "golden" / "retrieval-cases.yaml",
    )
    retrieval.add_argument("--vector", action="store_true")
    retrieval.add_argument("--include-local-private", action="store_true")
    retrieval.add_argument("--report", type=Path)
    retrieval.add_argument(
        "--vector-model",
        default=os.environ.get("OKF_EMBEDDING_MODEL", "BAAI/bge-small-zh-v1.5"),
    )
    all_tests = test_commands.add_parser("all")
    all_tests.add_argument("--quick-performance", action="store_true")
    all_tests.add_argument("--report", type=Path)
    performance = test_commands.add_parser("performance")
    performance.add_argument("--full", action="store_true")
    performance.add_argument(
        "--manifest",
        type=Path,
        default=repository_root() / "tests" / "fixtures" / "local-private" / "manifest.yaml",
    )
    performance.add_argument("--report", type=Path)

    document_import = commands.add_parser(
        "import",
        help="convert a document, publish Source/Extract, and route a draft",
    )
    document_import.add_argument("source", type=Path)
    document_import.add_argument(
        "--intent",
        choices=(
            "learn",
            "wiki",
            "source-only",
            "triage",
            "course",
            "source",
            "later",
        ),
        required=True,
    )
    document_import.add_argument(
        "--quality",
        choices=("high", "quick"),
        default="quick",
    )
    document_import.add_argument(
        "--parser",
        choices=("auto", "mineru", "markitdown"),
        default="auto",
    )
    document_import.add_argument("--course")
    document_import.add_argument(
        "--method", choices=("auto", "mineru-cloud", "markitdown-service", "mineru-self-hosted"),
        default="auto", help="conversion method; independent of quality checks",
    )
    document_import.add_argument("--project")
    document_import.add_argument("--vault", type=Path, default=defaults.vault)
    document_import.add_argument("--originals", type=Path, default=defaults.originals)
    document_import.add_argument("--state", type=Path, default=defaults.state)

    conversion = commands.add_parser("conversion", help="retry a failed conversion")
    conversion_commands = conversion.add_subparsers(
        dest="conversion_command",
        required=True,
    )
    retry = conversion_commands.add_parser("retry")
    retry.add_argument("conversion_id")
    retry.add_argument("--parser", choices=("mineru", "markitdown"))
    retry.add_argument(
        "--method", choices=("mineru-cloud", "markitdown-service", "mineru-self-hosted"),
    )
    retry.add_argument("--vault", type=Path, default=defaults.vault)
    retry.add_argument("--originals", type=Path, default=defaults.originals)
    retry.add_argument("--state", type=Path, default=defaults.state)

    feed = commands.add_parser("feed", help="cache, open, and apply human feed decisions")
    feed_commands = feed.add_subparsers(dest="feed_command", required=True)
    ingest_feed = feed_commands.add_parser("ingest")
    ingest_feed.add_argument("kind", choices=("ai-daily", "treehole"))
    ingest_feed.add_argument("payload", type=Path)
    ingest_feed.add_argument(
        "--content-map",
        type=Path,
        help="optional JSON object mapping AI Daily artifact IDs to full Markdown",
    )
    ingest_feed.add_argument("--state", type=Path, default=defaults.state)

    list_feed = feed_commands.add_parser("list")
    list_feed.add_argument("kind", choices=("ai-daily", "treehole"))
    list_feed.add_argument("--state", type=Path, default=defaults.state)

    open_feed = feed_commands.add_parser("open")
    open_feed.add_argument("kind", choices=("ai-daily", "treehole"))
    open_feed.add_argument("edition_id")
    open_feed.add_argument("--vault", type=Path, default=defaults.vault)
    open_feed.add_argument("--state", type=Path, default=defaults.state)

    decide_feed = feed_commands.add_parser("decide")
    decide_feed.add_argument("kind", choices=("ai-daily", "treehole"))
    decide_feed.add_argument("item_id")
    decide_feed.add_argument(
        "action",
        choices=(
            "learn-now",
            "learn-later",
            "wiki-now",
            "source-only",
            "ignore",
        ),
    )
    decide_feed.add_argument("--vault", type=Path, default=defaults.vault)
    decide_feed.add_argument("--state", type=Path, default=defaults.state)

    sync_feed = feed_commands.add_parser("sync")
    sync_feed.add_argument(
        "kind",
        choices=("ai-daily", "treehole", "all"),
        default="all",
        nargs="?",
    )
    sync_feed.add_argument("--state", type=Path, default=defaults.state)
    return parser


def _json_object(path: Path) -> dict[str, object]:
    loaded = cast(object, json.loads(path.read_text(encoding="utf-8")))
    if not isinstance(loaded, dict):
        raise ValueError(f"JSON root must be an object: {path}")
    return cast(dict[str, object], loaded)


def _note_command(args: argparse.Namespace) -> Path:
    service = NoteService(args.vault)
    if args.kind == "daily":
        return service.create_daily(args.date)
    if args.kind == "review":
        return service.create_review(args.period, args.date)
    if args.kind == "capture":
        return service.create_capture(args.title, args.content)
    if args.kind == "reflection":
        return service.create_reflection(args.title, args.content)
    if args.kind == "wiki":
        return service.create_wiki(args.title, args.content)
    if args.kind == "course":
        return service.create_course(args.slug, args.title)
    if args.kind == "lesson":
        return service.create_lesson(args.course, args.title, lesson_date=args.date)
    if args.kind == "project":
        return service.create_project(args.slug, args.title)
    _fail(f"unsupported note kind: {args.kind}")


def _search_stack(
    vault: Path,
    state: Path,
    *,
    vector: bool,
    vector_model: str,
) -> tuple[SearchIndex, HybridSearcher]:
    index = SearchIndex(vault, state / "brain.sqlite")
    index.sync()
    if not vector:
        return index, HybridSearcher(index)
    embedder = FastEmbedder(vector_model)
    vector_index = VectorIndex(state / "vectors.sqlite")
    vector_index.sync(index, embedder)
    return index, HybridSearcher(
        index,
        vector_index=vector_index,
        embedder=embedder,
    )


def main(argv: list[str] | None = None) -> int:
    _configure_windows_utf8_output()
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        if args.command == "init":
            vault = initialize_vault(args.vault)
            if args.with_git:
                initialize_repository(vault)
                create_checkpoint(vault, "chore: initialize OKF Workspace Vault")
            print(vault)
            return 0
        if args.command == "migrate":
            changes = migrate_current_layout(args.vault, default_template_root(), args.state)
            _print_json({"changes": changes})
            return 0
        if args.command == "validate":
            report = validate_bundle(args.vault, profile=not args.standard)
            if args.json_output:
                _print_json(
                    {
                        "valid": report.valid,
                        "files_checked": report.files_checked,
                        "issues": [
                            {
                                "path": issue.path,
                                "code": issue.code,
                                "message": issue.message,
                                "severity": issue.severity,
                            }
                            for issue in report.issues
                        ],
                    }
                )
            else:
                print(
                    f"{'VALID' if report.valid else 'INVALID'}: "
                    f"{report.files_checked} Markdown files checked"
                )
                for issue in report.issues:
                    print(f"{issue.severity}: {issue.path}: {issue.code}: {issue.message}")
            return 0 if report.valid else 1
        if args.command == "note":
            print(_note_command(args))
            return 0
        if args.command == "project":
            print(NoteService(args.vault).append_project_log(args.slug, args.content))
            return 0
        if args.command == "tasks":
            print(rebuild_root_index(args.vault))
            return 0
        if args.command == "today":
            snapshot = build_today_snapshot(args.vault, args.date)
            _print_json(asdict(snapshot), stringify_unknown=True)
            return 0
        if args.command == "fixtures":
            print(generate_fixture_vault(args.output))
            return 0
        if args.command == "checkpoint":
            initialize_repository(args.vault)
            print(create_checkpoint(args.vault, args.message) or "no changes")
            return 0
        if args.command == "undo":
            print(undo_last_checkpoint(args.vault))
            return 0
        if args.command == "doctor":
            paths = BrainPaths.from_env()
            if args.config.is_file():
                paths = apply_deployment_config(args.config.resolve())
            status = system_status(args.vault or paths.vault, args.state or paths.state)
            payload = (
                status
                if args.verbose
                else {
                    "version": status["version"],
                    "actionable": status["actionable"],
                }
            )
            _print_json(payload)
            return 0
        if args.command == "backup" and args.backup_command == "verify-restore":
            verification = verify_restored_data(args.vault, args.originals)
            if args.json_output:
                _print_json(asdict(verification))
            else:
                print(
                    f"{'VALID' if verification.valid else 'INVALID'}: "
                    f"{verification.readable_files}/{verification.markdown_files} Markdown; "
                    f"{verification.resolved_originals}/"
                    f"{verification.original_references} Originals"
                )
                for error in verification.errors:
                    print(f"error: {error}")
            return 0 if verification.valid else 1
        if args.command == "index":
            rebuild_root_index(args.vault)
            index = SearchIndex(args.vault, args.state / "brain.sqlite")
            update = index.sync(force=args.force)
            index_result: dict[str, object] = {"search": asdict(update)}
            if args.vectors:
                embedder = FastEmbedder(args.vector_model)
                vectors = VectorIndex(args.state / "vectors.sqlite")
                last_percent = -1

                def show_progress(done: int, total: int) -> None:
                    nonlocal last_percent
                    if total <= 0:
                        return
                    percent = int(done * 100 / total)
                    if done == total or percent >= last_percent + 10:
                        print(f"vector index: {done}/{total} ({percent}%)", file=sys.stderr)
                        last_percent = percent

                index_result["vectors_written"] = vectors.sync(
                    index,
                    embedder,
                    progress=show_progress,
                )
                index_result["vector_model"] = embedder.model_id
            _print_json(index_result)
            return 0
        if args.command in {"search", "context"}:
            _, searcher = _search_stack(
                args.vault,
                args.state,
                vector=args.vector,
                vector_model=args.vector_model,
            )
            hits = searcher.search(
                args.query,
                scope=cast(ScopeName, args.scope),
                explicit_paths=tuple(args.path),
                limit=args.limit,
                refresh_index=False,
            )
            if args.command == "context":
                index = searcher.index
                contexts = ContextReader(index).read(hits, limit=args.limit)
                trace = write_trace(
                    args.state / "traces",
                    query=args.query,
                    hits=hits,
                    contexts=contexts,
                )
                if args.json_output:
                    _print_json(
                        {
                            "query": args.query,
                            "scope": args.scope,
                            "retrieval": "hybrid" if args.vector else "lexical",
                            "actual_reads": [asdict(item) for item in contexts],
                            "trace": str(trace),
                        },
                        stringify_unknown=True,
                    )
                else:
                    for item in contexts:
                        reasons = ", ".join(item.retrieval_reasons)
                        print(
                            f"## {item.path} :: {item.heading} "
                            f"(L{item.start_line}-L{item.end_line}) [{reasons}]\n\n"
                            f"{item.actual_text}\n"
                        )
                    print(f"trace: {trace}")
                return 0
            if args.json_output:
                _print_json([asdict(hit) for hit in hits])
            else:
                for hit in hits:
                    reasons = ", ".join(hit.retrieval_reasons)
                    print(
                        f"{hit.path} :: {hit.heading} "
                        f"(L{hit.start_line}-L{hit.end_line}) [{reasons}]"
                    )
            return 0
        if args.command == "ask":
            index, searcher = _search_stack(
                args.vault,
                args.state,
                vector=args.vector,
                vector_model=args.vector_model,
            )
            service = AnswerService(
                searcher,
                ContextReader(index),
                OpenAICompatibleProvider(AISettings.from_env()),
            )
            answer_result = service.ask(
                args.query,
                scope=cast(ScopeName, args.scope),
                explicit_paths=tuple(args.path),
                candidate_limit=args.limit,
            )
            trace = write_trace(
                args.state / "traces",
                query=args.query,
                hits=list(answer_result.candidates),
                contexts=list(answer_result.contexts),
            )
            if args.json_output:
                _print_json(
                    {
                        "answer": answer_result.answer,
                        "actual_reads": [asdict(item) for item in answer_result.contexts],
                        "trace": str(trace),
                    },
                    stringify_unknown=True,
                )
            else:
                print(answer_result.answer)
            return 0
        if args.command == "organize":
            target = process_capture(
                args.vault,
                args.path,
                destination=cast(CaptureDestination, args.destination),
                title=args.title,
                project=args.project,
                course=args.course,
            )
            _print_json(
                {
                    "created_or_updated": str(target),
                    "capture_deleted": str(args.path),
                }
            )
            return 0
        if args.command == "test" and args.test_command == "retrieval":
            vector_enabled = args.vector or args.include_local_private
            evaluation = run_private_evaluation(
                args.manifest,
                args.cases,
                embedder=FastEmbedder(args.vector_model) if vector_enabled else None,
            )
            rendered = json.dumps(
                evaluation,
                ensure_ascii=False,
                indent=2,
                default=str,
            )
            if args.report:
                args.report.parent.mkdir(parents=True, exist_ok=True)
                args.report.write_text(
                    rendered + "\n",
                    encoding="utf-8",
                    newline="\n",
                )
            _print_json(evaluation, stringify_unknown=True)
            evaluations = cast(list[dict[str, object]], evaluation["evaluations"])
            selected = evaluations[-1]
            selected_passed = selected["passed"] == selected["total"]
            hybrid_not_worse = evaluation.get("hybrid_not_worse", True)
            semantic_improved = evaluation.get("semantic_rewrite_improved", True)
            return (
                0
                if selected_passed and hybrid_not_worse is True and semantic_improved is True
                else 1
            )
        if args.command == "test" and args.test_command == "performance":
            report = run_performance_benchmark(
                full=args.full,
                manifest=args.manifest if args.manifest.is_file() else None,
            )
            payload: dict[str, object] = {
                **cast(dict[str, object], asdict(report)),
                "passed": report.passed,
            }
            if args.report:
                write_report(args.report, payload)
            _print_json(payload)
            return 0 if report.passed else 1
        if args.command == "test" and args.test_command == "all":
            report = run_acceptance_suite(
                repository_root(),
                full_performance=not args.quick_performance,
            )
            if args.report:
                write_report(args.report, report)
            _print_json(report, stringify_unknown=True)
            return 0 if report["passed"] is True else 1
        if args.command == "import":
            importer = DocumentImporter(
                vault=args.vault,
                originals=args.originals,
                state=args.state,
            )
            import_result = importer.import_document(
                ImportRequest(
                    source=args.source,
                    intent=_import_intent(args.intent),
                    quality=ImportQuality(args.quality),
                    parser=(None if args.parser == "auto" else ParserName(args.parser)),
                    method=None if args.method == "auto" else ConversionMethod(args.method),
                    course=args.course,
                    project=args.project,
                )
            )
            _print_json(asdict(import_result), stringify_unknown=True)
            return 0
        if args.command == "conversion" and args.conversion_command == "retry":
            importer = DocumentImporter(
                vault=args.vault,
                originals=args.originals,
                state=args.state,
            )
            retry_result = importer.retry(
                args.conversion_id,
                parser=ParserName(args.parser) if args.parser else None,
                method=ConversionMethod(args.method) if args.method else None,
            )
            _print_json(asdict(retry_result), stringify_unknown=True)
            return 0
        if args.command == "feed":
            kind_value = getattr(args, "kind", None)
            feed_kind = (
                FeedKind(kind_value)
                if isinstance(kind_value, str) and kind_value != "all"
                else None
            )
            cache = FeedCache(args.state)
            if args.feed_command == "ingest" and feed_kind is not None:
                payload = _json_object(args.payload)
                if feed_kind is FeedKind.AI_DAILY:
                    content_map = (
                        {
                            str(key): str(value)
                            for key, value in _json_object(args.content_map).items()
                        }
                        if args.content_map
                        else {}
                    )
                    editions = ai_daily_from_v1(payload, content_by_artifact=content_map)
                else:
                    editions = [treehole_from_v1(payload)]
                paths = [cache.put(edition) for edition in editions]
                _print_json([str(path) for path in paths])
                return 0
            if args.feed_command == "list" and feed_kind is not None:
                summaries = [
                    {
                        "edition_id": edition.edition_id,
                        "edition_at": edition.edition_at,
                        "title": edition.title,
                        "stream": edition.stream,
                        "item_count": len(edition.items),
                    }
                    for edition in cache.list_editions(feed_kind)
                ]
                _print_json(summaries)
                return 0
            if args.feed_command == "open" and feed_kind is not None:
                edition = cache.get(feed_kind, args.edition_id)
                print(materialize_edition(args.vault, edition))
                return 0
            if args.feed_command == "decide" and feed_kind is not None:
                item = cache.find_item(feed_kind, args.item_id)
                decision = FeedDecisionService(args.vault, args.state).decide(
                    item,
                    DecisionAction(args.action),
                )
                _print_json(asdict(decision))
                return 0
            if args.feed_command == "sync":
                syncer = FeedSyncer(args.state)
                synchronized = (
                    syncer.sync_all()
                    if args.kind == "all"
                    else {FeedKind(args.kind): syncer.sync(FeedKind(args.kind))}
                )
                _print_json(
                    {
                        **{
                            feed.value: [edition.edition_id for edition in editions]
                            for feed, editions in synchronized.items()
                        },
                        **(
                            {
                                "failures": [
                                    {
                                        "feed": failure.feed.value,
                                        "stream": failure.stream,
                                        "detail": failure.detail,
                                    }
                                    for failure in syncer.failures
                                ]
                            }
                            if syncer.failures
                            else {}
                        ),
                    }
                )
                return 1 if syncer.failures else 0
    except (FileExistsError, FileNotFoundError, RuntimeError, ValueError) as exc:
        _fail(str(exc))
    parser.error(f"unsupported command: {args.command}")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
