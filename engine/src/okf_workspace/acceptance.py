"""One-session acceptance and scale benchmarks for the 1.0 release."""

from __future__ import annotations

import ctypes
import json
import math
import os
import sqlite3
import subprocess
import sys
import tempfile
import time
from array import array
from collections.abc import Callable, Sequence
from dataclasses import asdict, dataclass
from pathlib import Path

from okf_workspace import __version__
from okf_workspace.ai import ExplicitAIWorkflows
from okf_workspace.dashboard.views import dashboard_view, today_view
from okf_workspace.deployment import verify_restored_data
from okf_workspace.feeds import FeedCache, FeedEdition, FeedItem, FeedKind
from okf_workspace.feeds.decisions import FeedDecisionService
from okf_workspace.feeds.models import DecisionAction, DecisionResult
from okf_workspace.fixtures import generate_fixture_vault
from okf_workspace.git import create_checkpoint, initialize_repository, undo_last_checkpoint
from okf_workspace.importers import (
    DocumentImporter,
    ImportIntent,
    ImportQuality,
    ImportRequest,
    ParserName,
)
from okf_workspace.importers.models import ParserExport
from okf_workspace.notes import NoteService
from okf_workspace.notes.captures import process_capture
from okf_workspace.okf.frontmatter import read_document
from okf_workspace.okf.validator import validate_bundle
from okf_workspace.projections.today import build_today_snapshot
from okf_workspace.retrieval.chunks import chunk_markdown
from okf_workspace.retrieval.evaluation import load_fixtures
from okf_workspace.retrieval.index import SearchIndex
from okf_workspace.retrieval.search import HybridSearcher
from okf_workspace.retrieval.vector import Embedder, VectorIndex


@dataclass(frozen=True, slots=True)
class CommandCheck:
    name: str
    passed: bool
    duration_seconds: float
    command: tuple[str, ...]
    summary: str


@dataclass(frozen=True, slots=True)
class PerformanceReport:
    wiki_count: int
    chunk_count: int
    vector_dimensions: int
    note_create_p95_ms: float
    today_p95_ms: float
    feed_cache_p95_ms: float
    fts_p95_ms: float
    hybrid_p95_ms: float
    incremental_index_ms: float
    long_document_last_line: int
    long_document_covered_line: int
    long_document_fences_balanced: bool
    process_memory_mb: float | None
    thresholds: dict[str, bool]

    @property
    def passed(self) -> bool:
        return all(self.thresholds.values())


@dataclass(frozen=True, slots=True)
class OneSessionUATReport:
    passed: bool
    steps: dict[str, bool]


class _StaticProvider:
    def complete(self, *, system: str, user: str) -> str:
        return "## AI 整理\n\n- 保留原始记录。\n- 不确定内容：待确认。\n"


class _AcceptanceParser:
    def __init__(self, parser: ParserName) -> None:
        self.parser = parser

    def convert(
        self,
        source: Path,
        working_directory: Path,
        *,
        timeout_seconds: float = 900.0,
    ) -> ParserExport:
        return ParserExport(
            markdown=(
                "# Acceptance import\n\n"
                "Complete converted Markdown with headings, formula, table, and notes. "
                "This body is deliberately long enough for conversion quality checks.\n"
            ),
            assets={},
            parser=self.parser,
            parser_version="acceptance-1.0",
        )


class _PerformanceEmbedder(Embedder):
    def __init__(self, dimensions: int) -> None:
        self.dimensions = dimensions

    @property
    def model_id(self) -> str:
        return f"okf-performance-{self.dimensions}"

    def embed(self, texts: Sequence[str]) -> list[list[float]]:
        result: list[list[float]] = []
        for text in texts:
            vector = [0.0] * self.dimensions
            category = 0 if "routing" in text.casefold() or "vpn" in text.casefold() else 1
            vector[category] = 1.0
            result.append(vector)
        return result


def _p95(milliseconds: list[float]) -> float:
    if not milliseconds:
        return 0.0
    ordered = sorted(milliseconds)
    return ordered[max(0, math.ceil(len(ordered) * 0.95) - 1)]


def _measure(action: Callable[[], object], *, iterations: int = 20) -> float:
    values: list[float] = []
    for _ in range(iterations):
        started = time.perf_counter()
        action()
        values.append((time.perf_counter() - started) * 1000)
    return _p95(values)


def _vector_blob(dimensions: int, category: int) -> bytes:
    values = array("f", [0.0] * dimensions)
    values[category % min(dimensions, 16)] = 1.0
    return values.tobytes()


def _seed_scale_index(
    index: SearchIndex,
    vectors: VectorIndex,
    embedder: _PerformanceEmbedder,
    *,
    wiki_count: int,
    chunk_count: int,
) -> None:
    database = sqlite3.connect(index.database)
    try:
        database.execute("PRAGMA journal_mode = WAL")
        documents = [
            (
                f"knowledge/wiki/scale-{number:05d}.md",
                f"{number:064x}",
                number,
                256,
                f"Scale Wiki {number}",
                "Wiki",
                '{"status":"stable","type":"Wiki"}',
            )
            for number in range(wiki_count)
        ]
        database.executemany(
            """
            INSERT INTO documents(
                path, file_hash, modified_ns, size, title, note_type, frontmatter_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            documents,
        )
        for offset in range(0, chunk_count, 1000):
            chunk_rows: list[tuple[object, ...]] = []
            fts_rows: list[tuple[str, str, str, str, str]] = []
            for number in range(offset, min(offset + 1000, chunk_count)):
                wiki = number % wiki_count
                path = f"knowledge/wiki/scale-{wiki:05d}.md"
                chunk_id = f"scale-{number:06d}"
                heading = f"Routing evidence {number % 5 + 1}"
                body = (
                    "routing vpn conflict deployment backup synchronization "
                    f"wiki-{wiki} chunk-{number} reusable knowledge"
                )
                digest = f"{number:064x}"[-64:]
                chunk_rows.append((chunk_id, path, heading, number + 1, number + 2, body, digest))
                fts_rows.append((chunk_id, path, heading, body, body))
            database.executemany(
                """
                INSERT INTO chunks(
                    chunk_id, path, heading, start_line, end_line, text, text_hash
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                chunk_rows,
            )
            database.executemany(
                """
                INSERT INTO fts_chunks(chunk_id, path, heading, body, search_text)
                VALUES (?, ?, ?, ?, ?)
                """,
                fts_rows,
            )
        database.commit()
    finally:
        database.close()

    vector_database = sqlite3.connect(vectors.database)
    try:
        blobs = [
            _vector_blob(embedder.dimensions, category)
            for category in range(min(embedder.dimensions, 16))
        ]
        for offset in range(0, chunk_count, 1000):
            rows: list[tuple[object, ...]] = []
            for number in range(offset, min(offset + 1000, chunk_count)):
                wiki = number % wiki_count
                rows.append(
                    (
                        f"scale-{number:06d}",
                        f"knowledge/wiki/scale-{wiki:05d}.md",
                        f"Routing evidence {number % 5 + 1}",
                        number + 1,
                        number + 2,
                        f"{number:064x}"[-64:],
                        embedder.model_id,
                        embedder.dimensions,
                        blobs[number % len(blobs)],
                    )
                )
            vector_database.executemany(
                """
                INSERT INTO vectors(
                    chunk_id, path, heading, start_line, end_line,
                    text_hash, model_id, dimensions, vector
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                rows,
            )
        vector_database.commit()
    finally:
        vector_database.close()


def _process_memory_mb() -> float | None:
    if os.name != "nt":
        return None

    class ProcessMemoryCounters(ctypes.Structure):
        _fields_ = [
            ("cb", ctypes.c_ulong),
            ("PageFaultCount", ctypes.c_ulong),
            ("PeakWorkingSetSize", ctypes.c_size_t),
            ("WorkingSetSize", ctypes.c_size_t),
            ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
            ("QuotaPagedPoolUsage", ctypes.c_size_t),
            ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
            ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
            ("PagefileUsage", ctypes.c_size_t),
            ("PeakPagefileUsage", ctypes.c_size_t),
        ]

    counters = ProcessMemoryCounters()
    counters.cb = ctypes.sizeof(counters)
    kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
    psapi = ctypes.windll.psapi  # type: ignore[attr-defined]
    kernel32.GetCurrentProcess.restype = ctypes.c_void_p
    psapi.GetProcessMemoryInfo.argtypes = (
        ctypes.c_void_p,
        ctypes.POINTER(ProcessMemoryCounters),
        ctypes.c_ulong,
    )
    psapi.GetProcessMemoryInfo.restype = ctypes.c_int
    handle = kernel32.GetCurrentProcess()
    if not psapi.GetProcessMemoryInfo(
        handle,
        ctypes.byref(counters),
        counters.cb,
    ):
        return None
    return round(counters.WorkingSetSize / (1024 * 1024), 2)


def _long_document_result(manifest: Path | None, fallback: Path) -> tuple[int, int, bool]:
    source = fallback
    if manifest is not None and manifest.is_file():
        fixtures = load_fixtures(manifest)
        vpn = next((item for item in fixtures if item.fixture_id == "vpn-guide"), None)
        if vpn is not None and vpn.path.is_file():
            source = vpn.path
    markdown = source.read_text(encoding="utf-8-sig")
    chunks = chunk_markdown("long-document.md", markdown, fallback_title=source.stem)
    lines = markdown.replace("\r\n", "\n").replace("\r", "\n").splitlines()
    last_nonempty = max(
        (number for number, value in enumerate(lines, start=1) if value.strip()),
        default=0,
    )
    covered = max((chunk.end_line for chunk in chunks), default=0)
    balanced = True
    for chunk in chunks:
        fence: str | None = None
        for line in chunk.text.splitlines():
            stripped = line.lstrip()
            marker = (
                "`" if stripped.startswith("```") else "~" if stripped.startswith("~~~") else None
            )
            if marker is None:
                continue
            fence = marker if fence is None else None if fence == marker else fence
        if fence is not None:
            balanced = False
            break
    return last_nonempty, covered, balanced


def run_performance_benchmark(
    *,
    full: bool,
    manifest: Path | None = None,
) -> PerformanceReport:
    wiki_count = 20_000 if full else 200
    chunk_count = 100_000 if full else 1_000
    dimensions = 384 if full else 32
    with tempfile.TemporaryDirectory(prefix="okf-performance-") as temporary:
        root = Path(temporary)
        vault = generate_fixture_vault(root / "vault")
        service = NoteService(vault)
        note_number = 0

        def create_note() -> None:
            nonlocal note_number
            note_number += 1
            service.create_capture(f"性能记录 {note_number}", "普通笔记创建性能测试。")

        note_p95 = _measure(create_note)
        today_p95 = _measure(lambda: build_today_snapshot(vault))

        state = root / "state"
        cache = FeedCache(state)
        edition = FeedEdition(
            edition_id="performance-edition",
            feed=FeedKind.AI_DAILY,
            edition_at="2026-08-17",
            title="Performance Edition",
            stream="news",
            items=(
                FeedItem(
                    item_id="performance-item",
                    feed=FeedKind.AI_DAILY,
                    edition_id="performance-edition",
                    title="Performance fixture",
                    body="Complete cached feed body.",
                ),
            ),
        )
        cache.put(edition)
        feed_p95 = _measure(lambda: cache.get(FeedKind.AI_DAILY, edition.edition_id))

        incremental = SearchIndex(vault, state / "small-search.sqlite")
        incremental.sync()
        nonce = vault / "knowledge" / "wiki" / "nonce-note.md"
        nonce.write_text(nonce.read_text(encoding="utf-8") + "\nUPDATED\n", encoding="utf-8")
        started = time.perf_counter()
        update = incremental.sync()
        incremental_ms = (time.perf_counter() - started) * 1000
        if update.indexed != 1:
            raise RuntimeError("incremental index changed more than the edited note")

        scale_vault = root / "scale-vault"
        scale_vault.mkdir()
        scale_index = SearchIndex(scale_vault, state / "scale-search.sqlite")
        vector_index = VectorIndex(state / "scale-vectors.sqlite")
        embedder = _PerformanceEmbedder(dimensions)
        _seed_scale_index(
            scale_index,
            vector_index,
            embedder,
            wiki_count=wiki_count,
            chunk_count=chunk_count,
        )
        searcher = HybridSearcher(
            scale_index,
            vector_index=vector_index,
            embedder=embedder,
        )
        scale_index.fts_search("routing vpn conflict", limit=20)
        searcher.search(
            "routing vpn conflict",
            scope="technical",
            limit=8,
            refresh_index=False,
        )
        fts_p95 = _measure(lambda: scale_index.fts_search("routing vpn conflict", limit=20))
        hybrid_p95 = _measure(
            lambda: searcher.search(
                "routing vpn conflict",
                scope="technical",
                limit=8,
                refresh_index=False,
            )
        )
        last_line, covered_line, fences_balanced = _long_document_result(
            manifest,
            vault / "knowledge" / "wiki" / "long-technical-note.md",
        )
        memory = _process_memory_mb()
        thresholds = {
            "note_create_p95_under_500ms": note_p95 < 500,
            "today_p95_under_2s": today_p95 < 2_000,
            "feed_cache_p95_under_2s": feed_p95 < 2_000,
            "fts_p95_under_500ms": fts_p95 < 500,
            "hybrid_p95_under_2s": hybrid_p95 < 2_000,
            "incremental_index_under_3s": incremental_ms < 3_000,
            "long_document_complete": covered_line >= last_line,
            "long_document_fences_balanced": fences_balanced,
            "idle_memory_under_300mb": memory is None or memory < 300,
        }
        return PerformanceReport(
            wiki_count=wiki_count,
            chunk_count=chunk_count,
            vector_dimensions=dimensions,
            note_create_p95_ms=round(note_p95, 2),
            today_p95_ms=round(today_p95, 2),
            feed_cache_p95_ms=round(feed_p95, 2),
            fts_p95_ms=round(fts_p95, 2),
            hybrid_p95_ms=round(hybrid_p95, 2),
            incremental_index_ms=round(incremental_ms, 2),
            long_document_last_line=last_line,
            long_document_covered_line=covered_line,
            long_document_fences_balanced=fences_balanced,
            process_memory_mb=memory,
            thresholds=thresholds,
        )


def run_one_session_uat(root: Path) -> OneSessionUATReport:
    fixtures = root / "tests" / "fixtures" / "documents"
    with tempfile.TemporaryDirectory(prefix="okf-one-session-uat-") as temporary:
        base = Path(temporary)
        vault = generate_fixture_vault(base / "vault")
        originals = base / "originals"
        state = base / "state"
        initialize_repository(vault)
        create_checkpoint(vault, "uat: initial fixture")
        steps: dict[str, bool] = {}
        service = NoteService(vault)

        daily = service.create_daily()
        daily.write_text(
            daily.read_text(encoding="utf-8") + "\nUAT manual daily edit.\n",
            encoding="utf-8",
        )
        steps["daily_manual_edit"] = "UAT manual daily edit" in daily.read_text(encoding="utf-8")

        capture = service.create_capture("UAT mobile capture", "今天意识到长期系统需要低摩擦。")
        capture_relative = capture.relative_to(vault).as_posix()
        reflection, archived = process_capture(
            vault,
            capture_relative,
            destination="reflection",
        )
        steps["capture_to_reflection"] = reflection.is_file() and archived.is_file()
        undo_last_checkpoint(vault)
        steps["undo_multi_file_write"] = capture.is_file() and not reflection.exists()

        course = service.create_course("uat-course", "UAT Course")
        lesson = service.create_lesson(
            "uat-course",
            "UAT Lesson",
            human_notes="原始缩写 abc，某个结论待确认。",
        )
        before = read_document(lesson).body
        ExplicitAIWorkflows(vault, _StaticProvider()).organize_lesson(
            lesson.relative_to(vault).as_posix()
        )
        after = read_document(lesson).body
        steps["lesson_preserves_original"] = (
            course.is_file()
            and "原始缩写 abc，某个结论待确认。" in before
            and "原始缩写 abc，某个结论待确认。" in after
            and "保留原始记录" in after
        )

        project_log = service.append_project_log(
            "workspace",
            "UAT recorded project progress and next action.",
        )
        steps["project_progress"] = "UAT recorded project progress" in project_log.read_text(
            encoding="utf-8"
        )

        importer = DocumentImporter(
            vault=vault,
            originals=originals,
            state=state,
            clients={
                ParserName.MINERU: _AcceptanceParser(ParserName.MINERU),
                ParserName.MARKITDOWN: _AcceptanceParser(ParserName.MARKITDOWN),
            },
        )
        word = importer.import_document(
            ImportRequest(
                source=fixtures / "simple.docx",
                intent=ImportIntent.WIKI,
                quality=ImportQuality.QUICK,
            )
        )
        pdf = importer.import_document(
            ImportRequest(
                source=fixtures / "formula.pdf",
                intent=ImportIntent.LEARN,
                quality=ImportQuality.HIGH,
            )
        )
        steps["docx_and_complex_pdf_import"] = (
            word.source_text is not None
            and word.source_text.is_file()
            and pdf.source_text is not None
            and pdf.source_text.is_file()
            and pdf.routed_target is not None
        )

        decisions = FeedDecisionService(vault, state)
        action_items: tuple[tuple[str, DecisionAction], ...] = (
            ("uat-learn", DecisionAction.LEARN_NOW),
            ("uat-learn-later", DecisionAction.LEARN_LATER),
            ("uat-wiki", DecisionAction.WIKI_NOW),
            ("uat-source", DecisionAction.SOURCE_ONLY),
            ("uat-ignore", DecisionAction.IGNORE),
        )
        results: list[DecisionResult] = []
        for item_id, action in action_items:
            item = FeedItem(
                item_id=item_id,
                feed=FeedKind.AI_DAILY,
                edition_id="uat-edition",
                title=f"UAT {action.value}",
                body="Complete feed body with reproducible evidence and source context.",
                url="https://example.test/uat",
            )
            results.append(decisions.decide(item, action))
        steps["feed_human_actions"] = [result.action for result in results] == [
            action for _item_id, action in action_items
        ]

        areas = ("inbox", "learning", "projects", "knowledge", "life")
        projections = [dashboard_view(vault, area) for area in areas]
        today_projection = today_view(vault, state)
        steps["dashboard_projections"] = (
            len(projections) == len(areas) and "date" in today_projection
        )

        restored = verify_restored_data(vault, originals)
        steps["restorable_authoritative_data"] = restored.valid
        steps["markdown_remains_valid"] = validate_bundle(vault).valid
        return OneSessionUATReport(all(steps.values()), steps)


def _run_command(name: str, command: list[str], root: Path) -> CommandCheck:
    started = time.perf_counter()
    completed = subprocess.run(
        command,
        cwd=root,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=True,
        check=False,
    )
    duration = time.perf_counter() - started
    output = (completed.stdout + "\n" + completed.stderr).strip().splitlines()
    summary = output[-1] if output else f"exit code {completed.returncode}"
    return CommandCheck(
        name=name,
        passed=completed.returncode == 0,
        duration_seconds=round(duration, 2),
        command=tuple(command),
        summary=summary[-500:],
    )


def run_acceptance_suite(root: Path, *, full_performance: bool) -> dict[str, object]:
    root = root.resolve()
    npm = "npm.cmd" if os.name == "nt" else "npm"
    checks = [
        _run_command("python-tests", [sys.executable, "-m", "pytest", "-q"], root),
        _run_command("python-ruff", [sys.executable, "-m", "ruff", "check", "."], root),
        _run_command(
            "python-pyright",
            [sys.executable, "-m", "pyright", "--pythonpath", sys.executable],
            root,
        ),
        _run_command("dashboard-tests", [npm, "test", "--prefix", "dashboard"], root),
        _run_command("dashboard-build", [npm, "run", "build", "--prefix", "dashboard"], root),
    ]
    with tempfile.TemporaryDirectory(prefix="okf-acceptance-vault-") as temporary:
        fixture_vault = generate_fixture_vault(Path(temporary) / "vault")
        validation = validate_bundle(fixture_vault)
    performance = run_performance_benchmark(full=full_performance)
    uat = run_one_session_uat(root)
    passed = (
        all(check.passed for check in checks)
        and validation.valid
        and performance.passed
        and uat.passed
    )
    return {
        "version": __version__,
        "passed": passed,
        "checks": [asdict(check) for check in checks],
        "synthetic_vault": {
            "passed": validation.valid,
            "files_checked": validation.files_checked,
            "errors": [asdict(issue) for issue in validation.errors],
        },
        "performance": {**asdict(performance), "passed": performance.passed},
        "one_session_uat": asdict(uat),
    }


def write_report(path: Path, payload: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2, default=str) + "\n",
        encoding="utf-8",
        newline="\n",
    )
