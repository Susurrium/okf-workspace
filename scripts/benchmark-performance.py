from __future__ import annotations

import argparse
import cProfile
import hashlib
import json
import math
import pstats
import statistics
import subprocess
import tempfile
import time
from collections.abc import Callable
from dataclasses import asdict
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import TypedDict

from okf_workspace.notes import NoteService
from okf_workspace.okf.templates import initialize_vault
from okf_workspace.retrieval.context import ContextReader
from okf_workspace.retrieval.index import SearchIndex
from okf_workspace.retrieval.search import HybridSearcher
from okf_workspace.semantic.models import SemanticKind, SemanticRequest
from okf_workspace.semantic.store import SemanticOperationStore


class Measurement(TypedDict):
    samples_ms: list[float]
    median_ms: float
    p95_ms: float


class BudgetCheck(TypedDict):
    limit_ms: int
    passed: bool


def measure(action: Callable[[], object], samples: int) -> Measurement:
    durations: list[float] = []
    for _ in range(samples):
        started = time.perf_counter()
        action()
        durations.append((time.perf_counter() - started) * 1000)
    ordered = sorted(durations)
    return {
        "samples_ms": [round(value, 3) for value in durations],
        "median_ms": round(statistics.median(durations), 3),
        "p95_ms": round(ordered[math.ceil(samples * 0.95) - 1], 3),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--documents", type=int, default=5_000)
    parser.add_argument("--samples", type=int, default=20)
    parser.add_argument("--output", type=Path, default=Path("work/performance.json"))
    parser.add_argument("--enforce-budgets", action="store_true")
    arguments = parser.parse_args()
    if arguments.documents < 2 or arguments.samples < 2:
        parser.error("documents and samples must be at least two")
    repository = Path(__file__).resolve().parents[1]
    fixture_root = repository / "work" / "performance-benchmarks"
    fixture_root.mkdir(parents=True, exist_ok=True)
    tempfile.tempdir = str(fixture_root)
    fingerprint = hashlib.sha256()
    for path in sorted((repository / "engine" / "src").rglob("*.py")):
        fingerprint.update(path.relative_to(repository).as_posix().encode())
        fingerprint.update(path.read_bytes())
    now = datetime.now(UTC)
    report: dict[str, object] = {
        "source_revision": subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=repository, text=True
        ).strip(),
        "source_fingerprint": fingerprint.hexdigest(),
        "measured_at": now.isoformat(),
        "documents": arguments.documents,
        "samples": arguments.samples,
        "embedding": "lexical only; no model inference",
    }
    metrics: dict[str, Measurement] = {}
    with tempfile.TemporaryDirectory(
        prefix="filesystem-", dir=fixture_root
    ) as temporary:
        base = Path(temporary)
        (base / "fixture.json").write_text(
            json.dumps(
                {
                    "purpose": "独立初始状态下的文件系统与后台队列性能验收",
                    "created_at": now.isoformat(),
                    "expires_at": (now + timedelta(days=1)).isoformat(),
                    "source_revision": report["source_revision"],
                    "obsidian_profile": None,
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
        vault = initialize_vault(base / "vault")
        target = NoteService(vault).create_wiki(
            "Performance wiki",
            "routing vpn workspace evidence.\n" * 128,
        )
        payload = target.read_bytes()
        for number in range(1, arguments.documents):
            (target.parent / f"scale-{number:06}.md").write_bytes(payload)
        index = SearchIndex(vault, base / "state" / "search.sqlite")
        started = time.perf_counter()
        indexed = index.sync()
        report["initial_index_ms"] = round((time.perf_counter() - started) * 1000, 3)
        report["initial_update"] = asdict(indexed)
        relative = target.relative_to(vault).as_posix()
        metrics["unchanged_index"] = measure(index.sync, arguments.samples)
        profiler = cProfile.Profile()
        profiler.runcall(index.sync)
        no_yaml = (
            "parse_document"
            not in pstats.Stats(profiler).get_stats_profile().func_profiles
        )
        if not no_yaml:
            raise AssertionError("unchanged reconciliation parsed Markdown YAML")

        def edit_one() -> object:
            with target.open("a", encoding="utf-8") as handle:
                handle.write("\nAdditional evidence.\n")
            changed = index.sync(paths=[relative])
            if changed.indexed != 1 or changed.removed != 0:
                raise AssertionError(f"invalid incremental update: {changed}")
            return changed

        metrics["single_path_update"] = measure(edit_one, arguments.samples)
        searcher, reader = HybridSearcher(index), ContextReader(index)

        def retrieve() -> object:
            hits = searcher.search("routing vpn", mode="lexical")
            contexts = reader.read(hits, limit=6)
            if not contexts or not all(
                "routing" in context.actual_text for context in contexts
            ):
                raise AssertionError("retrieval did not read the expected real files")
            return contexts

        metrics["retrieval_with_refresh_and_reads"] = measure(
            retrieve, arguments.samples
        )
        report["index_bytes"] = index.database.stat().st_size
        store = SemanticOperationStore(base / "state")
        store.create(
            SemanticRequest("op-template", SemanticKind.GENERATE_WIKI, relative),
            fingerprint="synthetic",
            source_hashes={},
        )
        template = store.complete("op-template", actual_reads=())
        store.path("op-template").unlink()
        for number in range(arguments.documents):
            identifier = f"op-{number:08}"
            store.path(identifier).write_text(
                json.dumps({**template, "operation_id": identifier}), encoding="utf-8"
            )
        store.catalog.reconcile()

        def idle_claim() -> None:
            if store.claim_next("performance-worker") is not None:
                raise AssertionError("completed history was scheduled again")

        metrics["idle_claim"] = measure(idle_claim, arguments.samples)
        profiler = cProfile.Profile()
        profiler.runcall(idle_claim)
        no_history = (
            "read_text" not in pstats.Stats(profiler).get_stats_profile().func_profiles
        )
        if not no_history:
            raise AssertionError("idle queue check reopened completed history")
        report["structural_checks"] = {
            "unchanged_yaml_reads_zero": no_yaml,
            "idle_history_reads_zero": no_history,
        }
    budgets = {
        "unchanged_index": 1_000,
        "single_path_update": 500,
        "retrieval_with_refresh_and_reads": 1_500,
        "idle_claim": 50,
    }
    budget_checks: dict[str, BudgetCheck] = {
        name: {"limit_ms": limit, "passed": metrics[name]["p95_ms"] < limit}
        for name, limit in budgets.items()
    }
    report.update(metrics)
    report["budgets"] = budget_checks
    report["synthetic_vault_and_state_removed"] = True
    arguments.output.parent.mkdir(parents=True, exist_ok=True)
    arguments.output.write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(json.dumps(report, ensure_ascii=True))
    if arguments.enforce_budgets and not all(
        item["passed"] for item in budget_checks.values()
    ):
        raise SystemExit("performance budgets exceeded; inspect the saved report")


if __name__ == "__main__":
    main()
