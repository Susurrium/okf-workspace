"""Rebuildable SQLite FTS5 index over an OKF Markdown Bundle."""

from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
from collections.abc import Generator, Iterable, Mapping, Sequence
from contextlib import contextmanager
from pathlib import Path, PureWindowsPath
from typing import Any, cast

from okf_workspace.okf.document_role import DocumentRole, document_role
from okf_workspace.okf.file_io import FileWriteConflict, document_lock
from okf_workspace.okf.frontmatter import FrontmatterError, parse_document
from okf_workspace.okf.paths import resolve_bundle_path

from .chunks import chunk_markdown
from .links import extract_links
from .models import IndexUpdate, MarkdownChunk, SearchHit
from .scanner import is_candidate_path, iter_candidate_entries
from .schema import INDEX_SCHEMA, INDEX_SCHEMA_VERSION

_CJK_RUN = re.compile(r"[\u3400-\u9fff]+")
_WORD = re.compile(r"[A-Za-z0-9_][A-Za-z0-9_.+-]*")


def _jsonable(value: object) -> object:
    if isinstance(value, Mapping):
        mapping = cast(Mapping[object, object], value)
        return {str(key): _jsonable(item) for key, item in mapping.items()}
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes)):
        sequence = cast(Sequence[object], value)
        return [_jsonable(item) for item in sequence]
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    return str(value)


def lexical_text(text: str) -> str:
    additions: list[str] = []
    for run in _CJK_RUN.findall(text):
        additions.extend(run[index : index + 2] for index in range(len(run) - 1))
        if len(run) == 1:
            additions.append(run)
    additions.extend(word.lower() for word in _WORD.findall(text))
    return f"{text}\n{' '.join(additions)}"


def fts_query(text: str) -> str:
    tokens: list[str] = []
    for run in _CJK_RUN.findall(text):
        if len(run) == 1:
            tokens.append(run)
        else:
            tokens.extend(run[index : index + 2] for index in range(len(run) - 1))
    tokens.extend(word.lower() for word in _WORD.findall(text))
    unique = list(dict.fromkeys(token for token in tokens if token.strip()))
    return " OR ".join(f'"{token.replace(chr(34), chr(34) * 2)}"' for token in unique)


def _retrieval_metadata(frontmatter: Mapping[str, Any]) -> str:
    values: list[str] = []
    names = ["title", "type", "description", "course", "project"]
    if frontmatter.get("type") == "Project":
        names.append("project_category")
    for name in names:
        value = frontmatter.get(name)
        if isinstance(value, str) and value.strip():
            values.append(value.strip())
    for name in ("aliases", "tags"):
        value = frontmatter.get(name)
        if isinstance(value, Sequence) and not isinstance(value, (str, bytes)):
            values.extend(
                item.strip()
                for item in cast(Sequence[object], value)
                if isinstance(item, str) and item.strip()
            )
    return "\n".join(dict.fromkeys(values))


class SearchIndex:
    def __init__(self, vault: Path, database: Path) -> None:
        self.vault = vault.resolve()
        self.database = database.resolve()
        self.database.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

    @contextmanager
    def connect(self) -> Generator[sqlite3.Connection, None, None]:
        connection = sqlite3.connect(self.database)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA journal_mode = WAL")
        try:
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def _initialize(self) -> None:
        with document_lock(self.database), self.connect() as connection:
            connection.execute(
                "CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
            )
            row = connection.execute(
                "SELECT value FROM metadata WHERE key = 'schema_version'"
            ).fetchone()
            version = int(row["value"]) if row is not None else 0
            if version > INDEX_SCHEMA_VERSION:
                raise ValueError(f"unsupported search index schema: {version}")
            if version != INDEX_SCHEMA_VERSION:
                connection.executescript(
                    "DROP TRIGGER IF EXISTS chunks_insert;"
                    "DROP TRIGGER IF EXISTS chunks_delete;"
                    "DROP TRIGGER IF EXISTS chunks_update;"
                    "DROP TABLE IF EXISTS fts_chunks;"
                    "DROP VIEW IF EXISTS fts_content;"
                    "DROP TABLE IF EXISTS links;"
                    "DROP TABLE IF EXISTS chunks;"
                    "DROP TABLE IF EXISTS documents;"
                    "DROP TABLE IF EXISTS file_states;"
                )
            connection.executescript(INDEX_SCHEMA)
            connection.execute(
                "INSERT OR REPLACE INTO metadata(key, value) VALUES('schema_version', ?)",
                (str(INDEX_SCHEMA_VERSION),),
            )

    def _delete_document(self, connection: sqlite3.Connection, relative: str) -> None:
        connection.execute("DELETE FROM links WHERE source_path = ?", (relative,))
        connection.execute("DELETE FROM documents WHERE path = ?", (relative,))

    def index_path(self, path: Path, *, force: bool = False) -> tuple[bool, int]:
        absolute = path.resolve()
        relative = absolute.relative_to(self.vault).as_posix()
        with document_lock(self.database), self.connect() as connection:
            return self._index_path(connection, absolute, relative, force=force)

    @staticmethod
    def _file_version(stat: os.stat_result) -> tuple[int, int, int, str]:
        return stat.st_mtime_ns, stat.st_size, stat.st_ctime_ns, str(stat.st_ino)

    def _index_path(
        self,
        connection: sqlite3.Connection,
        absolute: Path,
        relative: str,
        *,
        force: bool,
    ) -> tuple[bool, int]:
        if (
            absolute.suffix.casefold() != ".md"
            or not is_candidate_path(Path(relative))
            or not absolute.is_file()
        ):
            self._delete_document(connection, relative)
            connection.execute("DELETE FROM file_states WHERE path = ?", (relative,))
            return False, 0
        stat = absolute.stat()
        payload = absolute.read_bytes()
        if self._file_version(stat) != self._file_version(absolute.stat()):
            raise FileWriteConflict(f"文件在建立索引期间发生变化：{relative}")
        digest = hashlib.sha256(payload).hexdigest()
        existing = connection.execute(
            "SELECT file_hash FROM documents WHERE path = ?",
            (relative,),
        ).fetchone()
        connection.execute(
            "INSERT OR REPLACE INTO file_states VALUES (?, ?, ?, ?, ?)",
            (relative, *self._file_version(stat)),
        )
        if not force and existing is not None and existing["file_hash"] == digest:
            connection.execute(
                "UPDATE documents SET modified_ns = ?, size = ? WHERE path = ?",
                (stat.st_mtime_ns, stat.st_size, relative),
            )
            return False, 0
        try:
            markdown = payload.decode("utf-8")
        except UnicodeError:
            self._delete_document(connection, relative)
            return False, 0
        fallback = absolute.stem
        frontmatter: Mapping[str, Any]
        try:
            document = parse_document(markdown, source=relative)
        except FrontmatterError:
            if markdown.splitlines() and markdown.splitlines()[0].strip() == "---":
                self._delete_document(connection, relative)
                return False, 0
            title, note_type, body = fallback, "", markdown
            frontmatter = cast(Mapping[str, Any], {})
        else:
            if document_role(document) is not DocumentRole.ARTIFACT:
                self._delete_document(connection, relative)
                return False, 0
            frontmatter, body = document.frontmatter, document.body
            title_value = frontmatter.get("title")
            title = title_value.strip() if isinstance(title_value, str) else fallback
            type_value = frontmatter.get("type")
            note_type = type_value.strip() if isinstance(type_value, str) else ""
        chunks = chunk_markdown(relative, markdown, fallback_title=title)
        metadata_text = _retrieval_metadata(frontmatter)
        self._delete_document(connection, relative)
        connection.execute(
            """
                INSERT INTO documents(
                    path, file_hash, modified_ns, size, title, note_type, frontmatter_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
            (
                relative,
                digest,
                stat.st_mtime_ns,
                stat.st_size,
                title,
                note_type,
                json.dumps(_jsonable(frontmatter), ensure_ascii=False, sort_keys=True),
            ),
        )
        for chunk in chunks:
            self._insert_chunk(connection, chunk, metadata_text=metadata_text)
        for target, relation in extract_links(body, source_path=relative, frontmatter=frontmatter):
            connection.execute(
                """
                    INSERT OR IGNORE INTO links(source_path, target_path, relation)
                    VALUES (?, ?, ?)
                    """,
                (relative, target, relation),
            )
        return True, len(chunks)

    def _insert_chunk(
        self,
        connection: sqlite3.Connection,
        chunk: MarkdownChunk,
        *,
        metadata_text: str,
    ) -> None:
        connection.execute(
            """
            INSERT INTO chunks(
                    chunk_id, path, heading, start_line, end_line, text, text_hash, search_text
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                chunk.chunk_id,
                chunk.path,
                chunk.heading,
                chunk.start_line,
                chunk.end_line,
                chunk.text,
                chunk.text_hash,
                lexical_text(f"{metadata_text}\n{chunk.heading}\n{chunk.text}"),
            ),
        )

    def sync(self, *, force: bool = False, paths: Sequence[str] | None = None) -> IndexUpdate:
        requested = None if paths is None else [self._requested_path(path) for path in paths]
        with document_lock(self.database), self.connect() as connection:
            return self._sync(connection, force=force, requested=requested)

    def _requested_path(self, value: str) -> Path:
        windows = PureWindowsPath(value)
        if (
            not windows.parts
            or windows.drive
            or windows.root
            or any(":" in part or PureWindowsPath(part).is_reserved() for part in windows.parts)
        ):
            raise ValueError(f"增量索引路径必须为 Vault 内的普通相对路径：{value!r}")
        return resolve_bundle_path(self.vault, value)

    def _sync(
        self,
        connection: sqlite3.Connection,
        *,
        force: bool,
        requested: list[Path] | None,
    ) -> IndexUpdate:
        states = {
            str(row["path"]): (
                int(row["modified_ns"]),
                int(row["size"]),
                int(row["changed_ns"]),
                str(row["file_id"]),
            )
            for row in connection.execute("SELECT * FROM file_states")
        }
        before_documents = {
            str(row["path"]) for row in connection.execute("SELECT path FROM documents")
        }
        candidates: list[tuple[str, Path]]
        if requested is None:
            candidates = list(iter_candidate_entries(self.vault))
            affected = set(states)
        else:
            candidates = []
            prefixes = [path.relative_to(self.vault).as_posix() for path in requested]
            affected = {
                path
                for path in states
                if any(path == prefix or path.startswith(prefix + "/") for prefix in prefixes)
            }
            for path in requested:
                prefix = path.relative_to(self.vault).as_posix()
                if path.is_dir():
                    candidates.extend(
                        (f"{prefix}/{relative}", entry)
                        for relative, entry in iter_candidate_entries(path)
                    )
                elif path.is_file():
                    candidates.append((prefix, path))
        known: set[str] = set()
        indexed = 0
        unchanged = 0
        chunk_count = 0
        for relative, path in dict.fromkeys(candidates):
            known.add(relative)
            if (
                requested is None
                and not force
                and states.get(relative) == self._file_version(path.stat())
            ):
                if relative in before_documents:
                    unchanged += 1
                continue
            changed, chunks = self._index_path(connection, path, relative, force=force)
            if changed:
                indexed += 1
                chunk_count += chunks
            elif connection.execute(
                "SELECT 1 FROM documents WHERE path = ?", (relative,)
            ).fetchone():
                unchanged += 1
        existing = {str(row["path"]) for row in connection.execute("SELECT path FROM documents")}
        removed_paths = (affected | existing if requested is None else affected) - known
        for relative in removed_paths:
            self._delete_document(connection, relative)
            connection.execute("DELETE FROM file_states WHERE path = ?", (relative,))
        after_documents = {
            str(row["path"]) for row in connection.execute("SELECT path FROM documents")
        }
        return IndexUpdate(indexed, unchanged, len(before_documents - after_documents), chunk_count)

    def get_file_hash(self, relative: str) -> str | None:
        with self.connect() as connection:
            row = connection.execute(
                "SELECT file_hash FROM documents WHERE path = ?",
                (relative,),
            ).fetchone()
        return str(row["file_hash"]) if row is not None else None

    @staticmethod
    def _scope_sql(
        include_prefixes: Sequence[str],
        exclude_prefixes: Sequence[str],
        *,
        column: str,
    ) -> tuple[str, list[str]]:
        clauses: list[str] = []
        parameters: list[str] = []

        def bind(prefix: str) -> None:
            base = prefix.rstrip("/")
            escaped = base.replace("!", "!!").replace("%", "!%").replace("_", "!_")
            parameters.extend((base, f"{escaped}/%"))

        boundary = f"({column} = ? OR {column} LIKE ? ESCAPE '!')"
        if include_prefixes:
            clauses.append("(" + " OR ".join(boundary for _ in include_prefixes) + ")")
            for prefix in include_prefixes:
                bind(prefix)
        for prefix in exclude_prefixes:
            clauses.append(f"NOT {boundary}")
            bind(prefix)
        return (" AND " + " AND ".join(clauses) if clauses else ""), parameters

    def exact_search(
        self,
        query: str,
        *,
        include_prefixes: Sequence[str] = (),
        exclude_prefixes: Sequence[str] = (),
        limit: int = 10,
    ) -> list[SearchHit]:
        scope, parameters = self._scope_sql(
            include_prefixes,
            exclude_prefixes,
            column="c.path",
        )
        needle = f"%{query.casefold()}%"
        sql = (
            """
            SELECT c.*, d.title
            FROM chunks c
            JOIN documents d ON d.path = c.path
            WHERE (
                lower(c.path) LIKE ?
                OR lower(c.heading) LIKE ?
                OR lower(d.title) LIKE ?
                OR lower(d.frontmatter_json) LIKE ?
            )
            """
            + scope
            + " ORDER BY c.path, c.start_line LIMIT ?"
        )
        with self.connect() as connection:
            rows = connection.execute(
                sql,
                [needle, needle, needle, needle, *parameters, limit],
            ).fetchall()
        return [
            SearchHit(
                path=str(row["path"]),
                heading=str(row["heading"]),
                start_line=int(row["start_line"]),
                end_line=int(row["end_line"]),
                text_hash=str(row["text_hash"]),
                score=3.0,
                retrieval_reasons=("exact title/path/heading",),
            )
            for row in rows
        ]

    def fts_search(
        self,
        query: str,
        *,
        include_prefixes: Sequence[str] = (),
        exclude_prefixes: Sequence[str] = (),
        limit: int = 20,
    ) -> list[SearchHit]:
        match = fts_query(query)
        if not match:
            return []
        scope, parameters = self._scope_sql(
            include_prefixes,
            exclude_prefixes,
            column="c.path",
        )
        sql = (
            """
            SELECT c.*, bm25(fts_chunks, 5.0, 2.0, 1.0) AS rank
            FROM fts_chunks
            JOIN chunks c ON c.row_id = fts_chunks.rowid
            WHERE fts_chunks MATCH ?
            """
            + scope
            + " ORDER BY rank LIMIT ?"
        )
        with self.connect() as connection:
            rows = connection.execute(
                sql,
                [match, *parameters, limit],
            ).fetchall()
        return [
            SearchHit(
                path=str(row["path"]),
                heading=str(row["heading"]),
                start_line=int(row["start_line"]),
                end_line=int(row["end_line"]),
                text_hash=str(row["text_hash"]),
                score=1.0 / (1.0 + abs(float(row["rank"]))),
                retrieval_reasons=("FTS5/BM25",),
            )
            for row in rows
        ]

    def first_chunk(self, relative: str) -> SearchHit | None:
        with self.connect() as connection:
            row = connection.execute(
                "SELECT * FROM chunks WHERE path = ? ORDER BY start_line LIMIT 1",
                (relative,),
            ).fetchone()
        if row is None:
            return None
        return SearchHit(
            path=str(row["path"]),
            heading=str(row["heading"]),
            start_line=int(row["start_line"]),
            end_line=int(row["end_line"]),
            text_hash=str(row["text_hash"]),
            score=0.25,
            retrieval_reasons=("one-hop link/source expansion",),
        )

    def related_paths(self, paths: Iterable[str]) -> set[str]:
        values = tuple(dict.fromkeys(paths))
        if not values:
            return set()
        placeholders = ",".join("?" for _ in values)
        with self.connect() as connection:
            rows = connection.execute(
                f"""
                SELECT target_path AS path FROM links
                WHERE source_path IN ({placeholders})
                UNION
                SELECT source_path AS path FROM links
                WHERE target_path IN ({placeholders})
                """,
                [*values, *values],
            ).fetchall()
        return {str(row["path"]) for row in rows}

    def chunks_for_paths(self, paths: Sequence[str]) -> list[MarkdownChunk]:
        if not paths:
            return []
        placeholders = ",".join("?" for _ in paths)
        with self.connect() as connection:
            rows = connection.execute(
                f"SELECT * FROM chunks WHERE path IN ({placeholders}) ORDER BY path, start_line",
                list(paths),
            ).fetchall()
        return [
            MarkdownChunk(
                chunk_id=str(row["chunk_id"]),
                path=str(row["path"]),
                heading=str(row["heading"]),
                start_line=int(row["start_line"]),
                end_line=int(row["end_line"]),
                text=str(row["text"]),
                text_hash=str(row["text_hash"]),
            )
            for row in rows
        ]

    def all_chunks(self) -> list[MarkdownChunk]:
        with self.connect() as connection:
            rows = connection.execute("SELECT * FROM chunks ORDER BY path, start_line").fetchall()
        return [
            MarkdownChunk(
                chunk_id=str(row["chunk_id"]),
                path=str(row["path"]),
                heading=str(row["heading"]),
                start_line=int(row["start_line"]),
                end_line=int(row["end_line"]),
                text=str(row["text"]),
                text_hash=str(row["text_hash"]),
            )
            for row in rows
        ]

    def chunk_fingerprints(self) -> dict[str, str]:
        with self.connect() as connection:
            return {
                str(row["chunk_id"]): str(row["text_hash"])
                for row in connection.execute(
                    "SELECT chunk_id, text_hash FROM chunks ORDER BY path, start_line"
                )
            }

    def chunks_for_ids(self, chunk_ids: Sequence[str]) -> list[MarkdownChunk]:
        if not chunk_ids:
            return []
        placeholders = ",".join("?" for _ in chunk_ids)
        with self.connect() as connection:
            rows = connection.execute(
                f"SELECT * FROM chunks WHERE chunk_id IN ({placeholders}) "
                "ORDER BY path, start_line",
                list(chunk_ids),
            ).fetchall()
        return [
            MarkdownChunk(
                chunk_id=str(row["chunk_id"]),
                path=str(row["path"]),
                heading=str(row["heading"]),
                start_line=int(row["start_line"]),
                end_line=int(row["end_line"]),
                text=str(row["text"]),
                text_hash=str(row["text_hash"]),
            )
            for row in rows
        ]
