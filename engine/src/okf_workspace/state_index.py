from __future__ import annotations

import json
import logging
import sqlite3
import time
import uuid
from collections.abc import Callable, Generator, Mapping, Sequence
from contextlib import contextmanager
from pathlib import Path
from typing import TypedDict, cast

from .okf.file_io import document_lock

LOGGER = logging.getLogger(__name__)


class RecordPage(TypedDict):
    items: list[dict[str, object]]
    version: int
    index_id: str
    total: int
    next_offset: int | None
    requires_reset: bool


class StateRecordIndex:
    def __init__(
        self,
        root: Path,
        pattern: str,
        identifier: str,
        is_active: Callable[[Mapping[str, object]], bool],
        identifier_from_path: Callable[[Path], str] | None = None,
    ) -> None:
        self.root = root
        self.pattern = pattern
        self.identifier = identifier
        self.is_active = is_active
        self.identifier_from_path: Callable[[Path], str] = identifier_from_path or (
            lambda path: path.stem
        )
        self.database = root.parent / "indexes" / root.name / "records.sqlite"

    @contextmanager
    def connect(self) -> Generator[sqlite3.Connection, None, None]:
        self.root.mkdir(parents=True, exist_ok=True)
        self.database.parent.mkdir(parents=True, exist_ok=True)
        connection = self._prepare()
        try:
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    @staticmethod
    def _corrupt(error: sqlite3.DatabaseError) -> bool:
        return getattr(error, "sqlite_errorcode", None) in {
            sqlite3.SQLITE_CORRUPT,
            sqlite3.SQLITE_NOTADB,
        }

    def _archive_corrupt(self, error: sqlite3.DatabaseError) -> None:
        backup = self.database.with_name(f"records-corrupt-{uuid.uuid4().hex}.sqlite")
        for suffix in ("", "-wal", "-shm"):
            source = Path(str(self.database) + suffix)
            if source.is_file():
                source.replace(Path(str(backup) + suffix))
        LOGGER.warning("派生状态索引损坏，已保留诊断文件并从 JSON 重建：%s；%s", backup, error)

    def _prepare(self, *, allow_rebuild: bool = True) -> sqlite3.Connection:
        connection = sqlite3.connect(self.database)
        connection.row_factory = sqlite3.Row
        try:
            connection.execute("PRAGMA journal_mode=WAL")
            connection.executescript("""
                CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS records (
                    id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, status TEXT NOT NULL,
                    created TEXT NOT NULL, updated TEXT NOT NULL, fingerprint TEXT NOT NULL,
                    kind TEXT NOT NULL, target TEXT NOT NULL, active INTEGER NOT NULL,
                    mtime INTEGER NOT NULL, size INTEGER NOT NULL, generation INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS record_keys (
                    key TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(key, id)
                );
                CREATE INDEX IF NOT EXISTS records_status ON records(status, created);
                CREATE INDEX IF NOT EXISTS records_active ON records(active, updated);
                CREATE INDEX IF NOT EXISTS records_fingerprint ON records(fingerprint, status);
                CREATE INDEX IF NOT EXISTS records_generation ON records(generation);
            """)
            if self.value(connection, "index_id", "") == "":
                self.set_value(connection, "index_id", uuid.uuid4().hex)
            return connection
        except sqlite3.DatabaseError as error:
            connection.close()
            if allow_rebuild and self._corrupt(error):
                self._archive_corrupt(error)
                return self._prepare(allow_rebuild=False)
            raise

    @staticmethod
    def value(connection: sqlite3.Connection, key: str, default: str = "0") -> str:
        row = connection.execute("SELECT value FROM metadata WHERE key = ?", (key,)).fetchone()
        return str(row[0]) if row is not None else default

    @staticmethod
    def set_value(connection: sqlite3.Connection, key: str, value: object) -> None:
        connection.execute("INSERT OR REPLACE INTO metadata VALUES (?, ?)", (key, str(value)))

    def _next_version(self, connection: sqlite3.Connection) -> int:
        version = int(self.value(connection, "generation")) + 1
        self.set_value(connection, "generation", version)
        return version

    def _upsert(
        self,
        connection: sqlite3.Connection,
        path: Path,
        payload: Mapping[str, object],
    ) -> None:
        identifier = payload.get(self.identifier)
        if not isinstance(identifier, str) or not identifier:
            raise ValueError(f"状态记录缺少 {self.identifier}：{path}")
        if identifier != self.identifier_from_path(path):
            raise ValueError(f"状态记录身份与路径不一致：{path}")
        stat = path.stat()
        version = self._next_version(connection)
        connection.execute(
            "INSERT OR REPLACE INTO records VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                identifier,
                path.relative_to(self.root).as_posix(),
                str(payload.get("status", "")),
                str(payload.get("created_at", "")),
                str(payload.get("updated_at", "")),
                str(payload.get("fingerprint", "")),
                str(payload.get("kind", "")),
                str(payload.get("target", "")),
                int(self.is_active(payload)),
                stat.st_mtime_ns,
                stat.st_size,
                version,
            ),
        )
        connection.execute("DELETE FROM record_keys WHERE id = ?", (identifier,))
        keys = [payload.get("idempotency_key")]
        handoff = payload.get("handoff_keys")
        if isinstance(handoff, list):
            keys.extend(cast(list[object], handoff))
        connection.executemany(
            "INSERT OR IGNORE INTO record_keys VALUES (?, ?)",
            [(key, identifier) for key in keys if isinstance(key, str) and key],
        )

    @staticmethod
    def _read(path: Path) -> dict[str, object]:
        loaded = cast(object, json.loads(path.read_text(encoding="utf-8")))
        if not isinstance(loaded, dict):
            raise ValueError(f"状态记录必须为 JSON 对象：{path}")
        return dict(cast(Mapping[str, object], loaded))

    def _reconcile(
        self,
        connection: sqlite3.Connection,
        *,
        force: bool,
        check_directory: bool = True,
    ) -> None:
        now = time.time()
        checked = float(self.value(connection, "checked"))
        dirty = self.value(connection, "dirty", "1") == "1"
        stamp = str(self.root.stat().st_mtime_ns)
        if (
            not force
            and not dirty
            and 0 <= now - checked < 30
            and (not check_directory or self.value(connection, "stamp") == stamp)
        ):
            return
        known = {str(row["path"]): row for row in connection.execute("SELECT * FROM records")}
        seen: set[str] = set()
        for path in self.root.glob(self.pattern):
            if path.is_symlink() or not path.resolve().is_relative_to(self.root):
                raise ValueError(f"状态记录路径越过所属目录：{path}")
            relative = path.relative_to(self.root).as_posix()
            seen.add(relative)
            previous = known.get(relative)
            stat = path.stat()
            if (
                force
                or dirty
                or previous is None
                or (int(previous["mtime"]), int(previous["size"]))
                != (stat.st_mtime_ns, stat.st_size)
            ):
                self._upsert(connection, path, self._read(path))
        removed = set(known) - seen
        for relative in removed:
            identifier = str(known[relative]["id"])
            connection.execute("DELETE FROM record_keys WHERE id = ?", (identifier,))
            connection.execute("DELETE FROM records WHERE id = ?", (identifier,))
        if removed:
            self.set_value(connection, "reset_generation", self._next_version(connection))
        self.set_value(connection, "checked", now)
        self.set_value(connection, "stamp", stamp)
        self.set_value(connection, "dirty", 0)

    def reconcile(self) -> None:
        with document_lock(self.database), self.connect() as connection:
            self._reconcile(connection, force=True)

    @contextmanager
    def writing(self, path: Path, payload: Mapping[str, object]) -> Generator[None, None, None]:
        if not path.resolve().is_relative_to(self.root):
            raise ValueError("状态写入路径越过所属目录")
        if payload.get(self.identifier) != self.identifier_from_path(path):
            raise ValueError(f"状态记录身份与路径不一致：{path}")
        with document_lock(self.database), self.connect() as connection:
            self._reconcile(connection, force=False, check_directory=False)
            self.set_value(connection, "dirty", 1)
            connection.commit()
            yield
            self._upsert(connection, path, payload)
            self.set_value(connection, "dirty", 0)
            self.set_value(connection, "stamp", self.root.stat().st_mtime_ns)

    def records(
        self,
        *,
        statuses: Sequence[str] = (),
        active_only: bool = False,
        fingerprint: str | None = None,
        key: str | None = None,
        oldest_first: bool = False,
        limit: int | None = None,
    ) -> list[dict[str, object]]:
        with document_lock(self.database), self.connect() as connection:
            self._reconcile(connection, force=False)
            clauses, parameters = self._filters(statuses=statuses, active_only=active_only)
            if fingerprint is not None:
                clauses.append("fingerprint = ?")
                parameters.append(fingerprint)
            if key is not None:
                clauses.append("id IN (SELECT id FROM record_keys WHERE key = ?)")
                parameters.append(key)
            order = "created ASC, id ASC" if oldest_first else "updated DESC, id DESC"
            sql = "SELECT path FROM records WHERE " + " AND ".join(clauses) + f" ORDER BY {order}"
            if limit is not None:
                sql += " LIMIT ?"
                parameters.append(limit)
            return [
                self._read(self.root / str(row["path"]))
                for row in connection.execute(sql, parameters)
            ]

    @staticmethod
    def _filters(
        *,
        statuses: Sequence[str] = (),
        active_only: bool = False,
    ) -> tuple[list[str], list[str | int]]:
        clauses = ["1 = 1"]
        parameters: list[str | int] = []
        if statuses:
            clauses.append("status IN (" + ",".join("?" for _ in statuses) + ")")
            parameters.extend(statuses)
        if active_only:
            clauses.append("active = 1")
        return clauses, parameters

    def page(
        self,
        *,
        limit: int = 200,
        offset: int = 0,
        snapshot_version: int | None = None,
        after_version: int | None = None,
        after_index_id: str | None = None,
        snapshot_index_id: str | None = None,
        status: str | None = None,
    ) -> RecordPage:
        if (
            not 1 <= limit <= 1_000
            or offset < 0
            or (after_version is not None and after_version < 0)
            or (snapshot_version is not None and snapshot_version < 0)
        ):
            raise ValueError("invalid state record page bounds")
        with document_lock(self.database), self.connect() as connection:
            self._reconcile(connection, force=False)
            version = int(self.value(connection, "generation"))
            index_id = self.value(connection, "index_id")
            if (snapshot_version is not None and snapshot_version != version) or (
                snapshot_index_id is not None and snapshot_index_id != index_id
            ):
                raise ValueError("state record snapshot changed")
            reset = after_version is not None and (
                after_version > version
                or after_index_id != index_id
                or status is not None
                or after_version < int(self.value(connection, "reset_generation"))
            )
            clauses, parameters = self._filters(statuses=(status,) if status else ())
            if after_version is not None and not reset:
                clauses.append("generation > ?")
                parameters.append(after_version)
            where = " AND ".join(clauses)
            total = int(
                connection.execute(
                    "SELECT COUNT(*) FROM records WHERE " + where,
                    parameters,
                ).fetchone()[0]
            )
            rows = connection.execute(
                "SELECT path FROM records WHERE "
                + where
                + " ORDER BY updated DESC, id DESC LIMIT ? OFFSET ?",
                [*parameters, limit, offset],
            ).fetchall()
            return {
                "items": [self._read(self.root / str(row["path"])) for row in rows],
                "version": version,
                "index_id": index_id,
                "total": total,
                "requires_reset": reset,
                "next_offset": offset + len(rows) if offset + len(rows) < total else None,
            }
