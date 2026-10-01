"""Rebuildable SQLite FTS5 index over an OKF Markdown Bundle."""

from __future__ import annotations

import json
import re
import sqlite3
from collections.abc import Generator, Iterable, Mapping, Sequence
from contextlib import contextmanager
from pathlib import Path
from typing import Any, cast

from okf_workspace.okf.frontmatter import FrontmatterError, parse_document

from .chunks import chunk_markdown
from .links import extract_links
from .models import IndexUpdate, MarkdownChunk, SearchHit
from .scanner import file_hash, is_retrievable_markdown, iter_markdown

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
    for name in ("title", "type", "description", "course", "project"):
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
        with self.connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS metadata (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS documents (
                    path TEXT PRIMARY KEY,
                    file_hash TEXT NOT NULL,
                    modified_ns INTEGER NOT NULL,
                    size INTEGER NOT NULL,
                    title TEXT NOT NULL,
                    note_type TEXT NOT NULL,
                    frontmatter_json TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS chunks (
                    chunk_id TEXT PRIMARY KEY,
                    path TEXT NOT NULL REFERENCES documents(path) ON DELETE CASCADE,
                    heading TEXT NOT NULL,
                    start_line INTEGER NOT NULL,
                    end_line INTEGER NOT NULL,
                    text TEXT NOT NULL,
                    text_hash TEXT NOT NULL
                );
                CREATE VIRTUAL TABLE IF NOT EXISTS fts_chunks USING fts5(
                    chunk_id UNINDEXED,
                    path UNINDEXED,
                    heading,
                    body,
                    search_text,
                    tokenize = 'unicode61 remove_diacritics 2'
                );
                CREATE TABLE IF NOT EXISTS links (
                    source_path TEXT NOT NULL,
                    target_path TEXT NOT NULL,
                    relation TEXT NOT NULL,
                    PRIMARY KEY (source_path, target_path, relation)
                );
                CREATE INDEX IF NOT EXISTS chunks_path ON chunks(path);
                CREATE INDEX IF NOT EXISTS links_target ON links(target_path);
                """
            )
            row = connection.execute(
                "SELECT value FROM metadata WHERE key = 'schema_version'"
            ).fetchone()
            if row is None or str(row["value"]) != "2":
                connection.execute("DELETE FROM fts_chunks")
                connection.execute("DELETE FROM links")
                connection.execute("DELETE FROM chunks")
                connection.execute("DELETE FROM documents")
            connection.execute(
                "INSERT OR REPLACE INTO metadata(key, value) VALUES('schema_version', '2')"
            )

    def _metadata(self, markdown: str, fallback: str) -> tuple[str, str, Mapping[str, Any], str]:
        try:
            document = parse_document(markdown)
        except FrontmatterError:
            return fallback, "", {}, markdown
        title_value = document.frontmatter.get("title")
        title = title_value.strip() if isinstance(title_value, str) else fallback
        type_value = document.frontmatter.get("type")
        note_type = type_value.strip() if isinstance(type_value, str) else ""
        return title, note_type, document.frontmatter, document.body

    def _delete_document(self, connection: sqlite3.Connection, relative: str) -> None:
        chunk_ids = [
            row["chunk_id"]
            for row in connection.execute(
                "SELECT chunk_id FROM chunks WHERE path = ?",
                (relative,),
            )
        ]
        for chunk_id in chunk_ids:
            connection.execute("DELETE FROM fts_chunks WHERE chunk_id = ?", (chunk_id,))
        connection.execute("DELETE FROM links WHERE source_path = ?", (relative,))
        connection.execute("DELETE FROM documents WHERE path = ?", (relative,))

    def index_path(self, path: Path, *, force: bool = False) -> tuple[bool, int]:
        absolute = path.resolve()
        relative = absolute.relative_to(self.vault).as_posix()
        if not is_retrievable_markdown(absolute, self.vault):
            with self.connect() as connection:
                self._delete_document(connection, relative)
            return False, 0
        stat = absolute.stat()
        with self.connect() as connection:
            existing = connection.execute(
                "SELECT file_hash, modified_ns, size FROM documents WHERE path = ?",
                (relative,),
            ).fetchone()
        if (
            not force
            and existing is not None
            and int(existing["modified_ns"]) == stat.st_mtime_ns
            and int(existing["size"]) == stat.st_size
        ):
            return False, 0
        digest = file_hash(absolute)
        markdown = absolute.read_text(encoding="utf-8")
        fallback = absolute.stem
        title, note_type, frontmatter, body = self._metadata(markdown, fallback)
        chunks = chunk_markdown(relative, markdown, fallback_title=title)
        metadata_text = _retrieval_metadata(frontmatter)
        with self.connect() as connection:
            if not force and existing is not None and existing["file_hash"] == digest:
                return False, 0
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
            for target, relation in extract_links(
                body,
                source_path=relative,
                frontmatter=frontmatter,
            ):
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
                chunk_id, path, heading, start_line, end_line, text, text_hash
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                chunk.chunk_id,
                chunk.path,
                chunk.heading,
                chunk.start_line,
                chunk.end_line,
                chunk.text,
                chunk.text_hash,
            ),
        )
        connection.execute(
            """
            INSERT INTO fts_chunks(chunk_id, path, heading, body, search_text)
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                chunk.chunk_id,
                chunk.path,
                chunk.heading,
                chunk.text,
                lexical_text(f"{metadata_text}\n{chunk.heading}\n{chunk.text}"),
            ),
        )

    def sync(self, *, force: bool = False) -> IndexUpdate:
        known: set[str] = set()
        indexed = 0
        unchanged = 0
        chunk_count = 0
        for path in iter_markdown(self.vault):
            relative = path.relative_to(self.vault).as_posix()
            known.add(relative)
            changed, chunks = self.index_path(path, force=force)
            if changed:
                indexed += 1
                chunk_count += chunks
            else:
                unchanged += 1
        with self.connect() as connection:
            existing = {
                str(row["path"]) for row in connection.execute("SELECT path FROM documents")
            }
            removed_paths = existing - known
            for relative in removed_paths:
                self._delete_document(connection, relative)
        return IndexUpdate(indexed, unchanged, len(removed_paths), chunk_count)

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
            JOIN chunks c ON c.chunk_id = fts_chunks.chunk_id
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
