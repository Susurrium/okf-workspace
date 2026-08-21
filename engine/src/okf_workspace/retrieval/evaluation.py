"""Reproducible FTS/vector/hybrid evaluation using private local fixtures."""

from __future__ import annotations

import hashlib
import json
import tempfile
from collections.abc import Callable
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import cast

from ruamel.yaml import YAML

from okf_workspace.fixtures import generate_fixture_vault
from okf_workspace.okf.frontmatter import OkfDocument, write_document

from .index import SearchIndex
from .search import HybridSearcher, RetrievalMode
from .vector import Embedder, VectorIndex


@dataclass(frozen=True, slots=True)
class FixtureDefinition:
    fixture_id: str
    path: Path
    sha256: str


@dataclass(frozen=True, slots=True)
class RetrievalCase:
    case_id: str
    query: str
    must_include: tuple[str, ...] = ()
    must_exclude_paths: tuple[str, ...] = ()
    must_prioritize: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class CaseResult:
    case_id: str
    passed: bool
    paths: tuple[str, ...]
    failures: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class RetrievalEvaluation:
    mode: str
    passed: int
    total: int
    cases: tuple[CaseResult, ...]


def _yaml_object(path: Path) -> dict[str, object]:
    yaml = YAML(typ="safe")
    loader = cast(
        Callable[[str], object],
        yaml.load,  # pyright: ignore[reportUnknownMemberType]
    )
    loaded = loader(path.read_text(encoding="utf-8"))
    if not isinstance(loaded, dict):
        raise ValueError(f"YAML root must be a mapping: {path}")
    return cast(dict[str, object], loaded)


def _string_tuple(value: object) -> tuple[str, ...]:
    if value is None:
        return ()
    if not isinstance(value, list):
        raise ValueError("expected a list of strings")
    items = cast(list[object], value)
    if not all(isinstance(item, str) for item in items):
        raise ValueError("expected a list of strings")
    return tuple(cast(list[str], items))


def load_fixtures(path: Path) -> tuple[FixtureDefinition, ...]:
    root = _yaml_object(path)
    raw = root.get("fixtures")
    if not isinstance(raw, list):
        raise ValueError(f"manifest has no fixtures list: {path}")
    fixtures: list[FixtureDefinition] = []
    for item_object in cast(list[object], raw):
        if not isinstance(item_object, dict):
            raise ValueError("fixture entry must be a mapping")
        item = cast(dict[str, object], item_object)
        fixture_id = item.get("id")
        source = item.get("path")
        sha256 = item.get("sha256")
        if not all(isinstance(value, str) for value in (fixture_id, source, sha256)):
            raise ValueError("fixture id, path, and sha256 must be strings")
        fixtures.append(
            FixtureDefinition(
                cast(str, fixture_id),
                Path(cast(str, source)),
                cast(str, sha256).lower(),
            )
        )
    return tuple(fixtures)


def load_cases(path: Path) -> tuple[RetrievalCase, ...]:
    root = _yaml_object(path)
    raw = root.get("cases")
    if not isinstance(raw, list):
        raise ValueError(f"cases file has no cases list: {path}")
    cases: list[RetrievalCase] = []
    for item_object in cast(list[object], raw):
        if not isinstance(item_object, dict):
            raise ValueError("case entry must be a mapping")
        item = cast(dict[str, object], item_object)
        case_id = item.get("id")
        query = item.get("query")
        if not isinstance(case_id, str) or not isinstance(query, str):
            raise ValueError("case id and query must be strings")
        cases.append(
            RetrievalCase(
                case_id,
                query,
                _string_tuple(item.get("must_include")),
                _string_tuple(item.get("must_exclude_paths")),
                _string_tuple(item.get("must_prioritize")),
            )
        )
    return tuple(cases)


def _digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _materialize(
    root: Path,
    fixtures: tuple[FixtureDefinition, ...],
) -> tuple[Path, dict[str, str]]:
    vault = generate_fixture_vault(root)
    aliases = {
        "nonce-note": "knowledge/wiki/nonce-note.md",
        "current-lesson": ("learning/courses/medical-statistics/lessons/2026-08-17-回归分析.md"),
    }
    for fixture in fixtures:
        if not fixture.path.is_file():
            raise FileNotFoundError(fixture.path)
        actual = _digest(fixture.path)
        if actual != fixture.sha256:
            raise ValueError(
                f"private fixture hash changed: {fixture.fixture_id}: "
                f"expected {fixture.sha256}, got {actual}"
            )
        relative = f"knowledge/wiki/{fixture.fixture_id}.md"
        aliases[fixture.fixture_id] = relative
        content = fixture.path.read_text(encoding="utf-8-sig")
        fields: dict[str, object] = {"fixture_id": fixture.fixture_id}
        if fixture.fixture_id == "livesync-guide":
            fields["sources"] = [
                {
                    "resource": "/sources/records/documents/livesync-source-record.md",
                }
            ]
        write_document(
            vault / relative,
            OkfDocument(
                {
                    "type": "Wiki",
                    "title": fixture.path.stem,
                    "status": "stable",
                    "created_at": "2026-08-17T09:30:00+08:00",
                    "description": f"Private retrieval fixture: {fixture.fixture_id}.",
                    **fields,
                },
                f"# {fixture.path.stem}\n\n{content}",
            ),
            create_only=True,
        )
    if "livesync-guide" in aliases:
        livesync_fixture = next(
            fixture for fixture in fixtures if fixture.fixture_id == "livesync-guide"
        )
        source_relative = "sources/records/documents/livesync-source-record.md"
        text_relative = "sources/text/documents/livesync-source-text.md"
        aliases["livesync-source-record"] = source_relative
        write_document(
            vault / source_relative,
            OkfDocument(
                {
                    "type": "Source",
                    "title": "LiveSync 私有测试来源记录",
                    "status": "stable",
                    "created_at": "2026-08-17T09:30:00+08:00",
                    "resource": "local-private://livesync-guide",
                    "kind": "document",
                    "text": f"/{text_relative}",
                    "uses": [{"purpose": "reference"}],
                    "ingested_via": "file-import",
                    "sha256": livesync_fixture.sha256,
                },
                ("# LiveSync 私有测试来源记录\n\n[完整笔记](/knowledge/wiki/livesync-guide.md)\n"),
            ),
            create_only=True,
        )
        write_document(
            vault / text_relative,
            OkfDocument(
                {
                    "type": "Source Text",
                    "title": "LiveSync 私有测试来源正文",
                    "created_at": "2026-08-17T09:30:00+08:00",
                    "parser": "private-fixture",
                    "sources": [{"resource": f"/{source_relative}"}],
                },
                "# LiveSync 私有测试来源正文\n\n"
                + livesync_fixture.path.read_text(encoding="utf-8-sig"),
            ),
            create_only=True,
        )
    return vault, aliases


def _evaluate(
    mode: str,
    searcher: HybridSearcher,
    cases: tuple[RetrievalCase, ...],
    aliases: dict[str, str],
    *,
    retrieval_mode: RetrievalMode,
) -> RetrievalEvaluation:
    results: list[CaseResult] = []
    for case in cases:
        explicit = tuple(aliases[value] for value in case.must_prioritize if value in aliases)
        hits = searcher.search(
            case.query,
            scope="auto",
            mode=retrieval_mode,
            explicit_paths=explicit,
            limit=5,
            refresh_index=False,
        )
        paths = tuple(hit.path for hit in hits)
        failures: list[str] = []
        for fixture_id in case.must_include:
            expected = aliases.get(fixture_id)
            if expected is None or expected not in paths:
                failures.append(f"missing {fixture_id}")
        for prefix in case.must_exclude_paths:
            if any(path.startswith(prefix) for path in paths):
                failures.append(f"unexpected scope {prefix}")
        for fixture_id in case.must_prioritize:
            expected = aliases.get(fixture_id)
            if expected is None or expected not in paths[:3]:
                failures.append(f"not prioritized {fixture_id}")
        results.append(
            CaseResult(
                case.case_id,
                not failures,
                paths,
                tuple(failures),
            )
        )
    return RetrievalEvaluation(
        mode,
        sum(result.passed for result in results),
        len(results),
        tuple(results),
    )


def run_private_evaluation(
    manifest: Path,
    cases_path: Path,
    *,
    embedder: Embedder | None = None,
) -> dict[str, object]:
    fixtures = load_fixtures(manifest)
    cases = load_cases(cases_path)
    with tempfile.TemporaryDirectory(prefix="okf-private-retrieval-") as temporary:
        root = Path(temporary)
        vault, aliases = _materialize(root / "vault", fixtures)
        index = SearchIndex(vault, root / "state" / "search.sqlite")
        index.sync()
        fts = _evaluate(
            "fts",
            HybridSearcher(index),
            cases,
            aliases,
            retrieval_mode="lexical",
        )
        evaluations = [fts]
        vector: RetrievalEvaluation | None = None
        hybrid: RetrievalEvaluation | None = None
        if embedder is not None:
            vectors = VectorIndex(root / "state" / "vectors.sqlite")
            vectors.sync(index, embedder)
            vector_searcher = HybridSearcher(
                index,
                vector_index=vectors,
                embedder=embedder,
            )
            vector = _evaluate(
                "vector",
                vector_searcher,
                cases,
                aliases,
                retrieval_mode="vector",
            )
            hybrid = _evaluate(
                "hybrid",
                vector_searcher,
                cases,
                aliases,
                retrieval_mode="hybrid",
            )
            evaluations.extend((vector, hybrid))
        payload: dict[str, object] = {
            "fixtures": [asdict(fixture) for fixture in fixtures],
            "evaluations": [asdict(evaluation) for evaluation in evaluations],
        }
        if embedder is not None and vector is not None and hybrid is not None:
            payload["hybrid_not_worse"] = hybrid.passed >= fts.passed
            fts_semantic = next(
                (case.passed for case in fts.cases if case.case_id == "RET-03"),
                None,
            )
            hybrid_semantic = next(
                (case.passed for case in hybrid.cases if case.case_id == "RET-03"),
                None,
            )
            vector_semantic = next(
                (case.passed for case in vector.cases if case.case_id == "RET-03"),
                None,
            )
            if (
                fts_semantic is not None
                and vector_semantic is not None
                and hybrid_semantic is not None
            ):
                payload["semantic_rewrite_improved"] = (
                    vector_semantic is True
                    and hybrid_semantic is True
                    and (fts_semantic is False or hybrid.passed > fts.passed)
                )
        serialized = json.dumps(payload, default=str)
        decoded = cast(object, json.loads(serialized))
        if not isinstance(decoded, dict):
            raise RuntimeError("evaluation report serialization failed")
        return cast(dict[str, object], decoded)
