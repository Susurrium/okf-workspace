from __future__ import annotations

import hashlib
import logging
import threading
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from okf_workspace.okf.frontmatter import FrontmatterError, parse_document

Normalizer = Callable[[str], str]
LOGGER = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class SourceIdentity:
    version: tuple[int, int, int]
    digest: str
    resource: str | None
    sha256: str | None


class SourceLookup:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.lock = threading.RLock()
        self.entries: dict[Path, SourceIdentity] = {}
        self.resources: dict[str, list[Path]] = {}
        self.hashes: dict[str, list[Path]] = {}
        self.normalized: list[tuple[Normalizer, dict[str, list[Path]]]] = []
        self.dirty = False

    def invalidate(self, path: Path) -> None:
        with self.lock:
            self.entries.pop(path, None)
            self.normalized.clear()
            self.dirty = True

    def _refresh(self, *, verify_content: bool) -> None:
        current: set[Path] = set()
        changed = self.dirty
        for path in sorted(self.root.rglob("*.md")):
            if not path.is_file():
                continue
            if not path.resolve().is_relative_to(self.root):
                raise ValueError(f"资料索引路径越过所属目录：{path}")
            current.add(path)
            stat = path.stat()
            version = stat.st_mtime_ns, stat.st_size, stat.st_ino
            previous = self.entries.get(path)
            if previous is not None and previous.version == version and not verify_content:
                continue
            payload = path.read_bytes()
            digest = hashlib.sha256(payload).hexdigest()
            resource, sha256 = None, None
            if previous is not None and previous.digest == digest:
                resource, sha256 = previous.resource, previous.sha256
            else:
                try:
                    document = parse_document(payload.decode("utf-8"), source=str(path))
                except (FrontmatterError, UnicodeError):
                    if payload.startswith(b"---"):
                        LOGGER.warning("资料身份字段无法解析：%s", path)
                else:
                    if document.type == "Source":
                        raw_resource = document.frontmatter.get("resource")
                        raw_sha256 = document.frontmatter.get("sha256")
                        resource = raw_resource if isinstance(raw_resource, str) else None
                        sha256 = raw_sha256.casefold() if isinstance(raw_sha256, str) else None
            self.entries[path] = SourceIdentity(version, digest, resource, sha256)
            changed = True
        for path in set(self.entries) - current:
            del self.entries[path]
            changed = True
        if not changed:
            return
        self.resources.clear()
        self.hashes.clear()
        self.normalized.clear()
        self.dirty = False
        for path, entry in self.entries.items():
            if entry.resource is not None:
                self.resources.setdefault(entry.resource, []).append(path)
            if entry.sha256 is not None:
                self.hashes.setdefault(entry.sha256, []).append(path)

    def candidates(
        self,
        value: str,
        *,
        by_hash: bool,
        normalize: Normalizer | None = None,
        verify_content: bool = False,
    ) -> list[Path]:
        with self.lock:
            for verify in ((True,) if verify_content else (False, True)):
                self._refresh(verify_content=verify)
                if by_hash:
                    result = self.hashes.get(value, [])
                elif normalize is None:
                    result = self.resources.get(value, [])
                else:
                    mapping = next(
                        (items for function, items in self.normalized if function is normalize),
                        None,
                    )
                    if mapping is None:
                        new_mapping: dict[str, list[Path]] = {}
                        for resource, paths in self.resources.items():
                            try:
                                identity = normalize(resource)
                            except ValueError:
                                # 规范化器可拒绝其他类型的资源，例如本地文件路径。
                                continue
                            new_mapping.setdefault(identity, []).extend(paths)
                        mapping = new_mapping
                        self.normalized.append((normalize, new_mapping))
                        self.normalized = self.normalized[-4:]
                    result = mapping.get(value, [])
                if result:
                    return sorted(result)
            return []


_LOOKUPS: OrderedDict[Path, SourceLookup] = OrderedDict()
_LOOKUPS_LOCK = threading.Lock()


def source_lookup(root: Path) -> SourceLookup:
    with _LOOKUPS_LOCK:
        lookup = _LOOKUPS.pop(root, None) or SourceLookup(root)
        _LOOKUPS[root] = lookup
        while len(_LOOKUPS) > 8:
            _LOOKUPS.popitem(last=False)
        return lookup
