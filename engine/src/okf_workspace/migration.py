"""Idempotent migration to the Markdown-authoritative Wiki-only layout."""

from __future__ import annotations

import json
import os
import re
import shutil
import tempfile
from collections.abc import Mapping, MutableMapping
from contextlib import suppress
from datetime import date, datetime
from pathlib import Path
from typing import cast
from urllib.parse import urlsplit

from okf_workspace.git import GitCheckpointError, create_checkpoint
from okf_workspace.ingestion import (
    DIRECT_ENTRY,
    FEED,
    FILE_IMPORT,
    WEB_CLIP,
    normalize_ingested_via,
)
from okf_workspace.okf.frontmatter import OkfDocument, read_document, write_document
from okf_workspace.okf.paths import resolve_bundle_path, slugify
from okf_workspace.okf.relations import (
    inherited_context_fields,
    normalize_context_reference,
    source_paths,
)
from okf_workspace.okf.templates import (
    VAULT_DYNAMIC_DIRECTORIES,
    ensure_vault_dynamic_directories,
)
from okf_workspace.projections.navigation import rebuild_root_index
from okf_workspace.sources import SourcePublisher

_EMPTY_QUEUE_MARKER = "当前没有待学习项目。"
_MISSING = object()
_DEFAULT_WEB_CLIPPER_FIELDS = frozenset(
    {"title", "source", "author", "published", "created", "description", "tags"}
)
_CANONICAL_CAPTURE_FIELDS = frozenset({"type", "created_at", "ingested_via", "resource"})


def _read_json_object(path: Path) -> dict[str, object]:
    if not path.is_file():
        return {}
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        message = f"Cannot migrate invalid JSON without risking user settings: {path}"
        raise ValueError(message) from exc
    if not isinstance(loaded, dict):
        raise ValueError(f"Expected a JSON object in Obsidian settings: {path}")
    loaded_settings = cast(dict[object, object], loaded)
    return {str(key): value for key, value in loaded_settings.items()}


def _write_text_atomic(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.",
        suffix=".tmp",
        dir=path.parent,
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _is_learning_queue_placeholder(document: OkfDocument) -> bool:
    return (
        document.type == "Knowledge Concept"
        and "## 为什么进入学习队列" in document.body
        and "## 待学习与验证" in document.body
        and "- [ ] 阅读 Source Extract" in document.body
    )


def _unique_target(root: Path, relative: Path) -> Path:
    target = root / relative
    if not target.exists():
        return target
    number = 2
    while True:
        candidate = target.with_stem(f"{target.stem}-legacy-{number}")
        if not candidate.exists():
            return candidate
        number += 1


def _default_clipper_created_date(value: object) -> date | None:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if not isinstance(value, str):
        return None
    try:
        return date.fromisoformat(value.strip())
    except ValueError:
        return None


def _is_http_url(value: object) -> bool:
    if not isinstance(value, str):
        return False
    parsed = urlsplit(value.strip())
    return parsed.scheme.lower() in {"http", "https"} and bool(parsed.netloc)


def _has_default_clipper_tag(value: object) -> bool:
    if isinstance(value, str):
        return value.strip().casefold() == "clippings"
    if isinstance(value, (list, tuple)):
        items = cast(list[object] | tuple[object, ...], value)
        return any(
            isinstance(item, str) and item.strip().casefold() == "clippings" for item in items
        )
    return False


def _first_visible_line(body: str) -> str:
    return next((line.strip() for line in body.splitlines() if line.strip()), "")


def _prepend_h1(title: str, body: str) -> str:
    separator = "\n" if body.startswith("\n") else "\n\n"
    return f"# {title.strip()}{separator}{body}"


def _is_default_web_clipper_document(document: OkfDocument) -> bool:
    """Match only the official Web Clipper default template's stable signature."""

    fields = document.frontmatter
    title = fields.get("title")
    return (
        _DEFAULT_WEB_CLIPPER_FIELDS.issubset(fields)
        and _CANONICAL_CAPTURE_FIELDS.isdisjoint(fields)
        and isinstance(title, str)
        and bool(title.strip())
        and _is_http_url(fields.get("source"))
        and _default_clipper_created_date(fields.get("created")) is not None
        and _has_default_clipper_tag(fields.get("tags"))
    )


def _migrate_default_web_clippings(root: Path) -> list[str]:
    """Move exact default Web Clipper notes into the canonical Capture Inbox."""

    directory = root / "Clippings"
    if not directory.is_dir():
        return []

    changes: list[str] = []
    for source in sorted(directory.glob("*.md")):
        try:
            document = read_document(source)
        except (OSError, ValueError):
            continue
        if not _is_default_web_clipper_document(document):
            continue

        title = cast(str, document.frontmatter["title"]).strip()
        resource = cast(str, document.frontmatter["source"]).strip()
        created_date = _default_clipper_created_date(document.frontmatter["created"])
        if created_date is None:  # Kept explicit for type narrowing and defensive safety.
            continue
        try:
            modified = datetime.fromtimestamp(source.stat().st_mtime).astimezone()
        except OSError:
            continue
        created_at = modified.replace(
            year=created_date.year,
            month=created_date.month,
            day=created_date.day,
        )
        slug = slugify(title)[:80].rstrip("-_") or "web-clip"
        filename = f"{created_at:%Y-%m-%d-%H%M%S}-{slug}.md"
        relative = Path("inbox") / "captures" / f"{created_at:%Y}" / f"{created_at:%m}" / filename
        target = _unique_target(root, relative)

        preserved = {
            str(key): value
            for key, value in document.frontmatter.items()
            if key not in {"title", "source", "created"}
        }
        body = document.body
        if not re.match(r"^#(?:\s|$)", _first_visible_line(body)):
            body = _prepend_h1(title, body)
        migrated = OkfDocument(
            {
                "type": "Capture",
                "title": title,
                "created_at": created_at.isoformat(timespec="seconds"),
                "ingested_via": WEB_CLIP,
                "resource": resource,
                **preserved,
            },
            body,
        )
        write_document(target, migrated, create_only=True)
        try:
            source.unlink()
        except OSError:
            target.unlink(missing_ok=True)
            raise
        changes.append(
            f"{source.relative_to(root).as_posix()} -> {target.relative_to(root).as_posix()}"
        )

    with suppress(OSError):
        directory.rmdir()
    return changes


def _description(document: OkfDocument) -> str:
    visible = next(
        (
            line.strip()
            for line in document.body.splitlines()
            if line.strip() and not line.lstrip().startswith(("#", "<!--", "- ["))
        ),
        "",
    )
    title = str(document.frontmatter.get("title", "Wiki"))
    return (visible or title)[:200]


def _migrate_legacy_knowledge(root: Path) -> tuple[list[str], dict[str, str]]:
    changes: list[str] = []
    links: dict[str, str] = {}
    for directory in (root / "knowledge" / "concepts", root / "knowledge" / "references"):
        if not directory.is_dir():
            continue
        for source in sorted(directory.glob("*.md")):
            if source.name == "index.md":
                continue
            document = read_document(source)
            old_relative = source.relative_to(root).as_posix()
            if _is_learning_queue_placeholder(document):
                source.unlink()
                changes.append(f"{old_relative} (removed obsolete queue placeholder)")
                continue
            else:
                target = _unique_target(root, Path("knowledge") / "wiki" / source.name)
                legacy_status = document.frontmatter.pop("epistemic_status", None)
                document.frontmatter["type"] = "Wiki"
                if legacy_status == "learned":
                    document.frontmatter["learned"] = True
                document.frontmatter.setdefault("description", _description(document))
                document.frontmatter.setdefault("status", "draft")
                now = datetime.now().astimezone().isoformat(timespec="seconds")
                document.frontmatter.setdefault("created_at", now)
            write_document(target, document, create_only=True)
            source.unlink()
            new_relative = target.relative_to(root).as_posix()
            links[old_relative] = new_relative
            changes.append(f"{old_relative} -> {new_relative}")
        index = directory / "index.md"
        if index.is_file():
            index.unlink()
            changes.append(f"{index.relative_to(root).as_posix()} (removed legacy index)")
        with suppress(OSError):
            directory.rmdir()
    return changes, links


def _rewrite_links(root: Path, mapping: dict[str, str]) -> list[str]:
    changes: list[str] = []
    if not mapping:
        return changes
    for path in root.rglob("*.md"):
        original = path.read_text(encoding="utf-8")
        updated = original
        for old, new in mapping.items():
            updated = updated.replace(f"/{old}", f"/{new}").replace(old, new)
        if updated != original:
            path.write_text(updated, encoding="utf-8", newline="\n")
            changes.append(f"{path.relative_to(root).as_posix()} (updated links)")
    return changes


def _remove_nested_indexes(root: Path) -> list[str]:
    changes: list[str] = []
    preserved_directories = frozenset(VAULT_DYNAMIC_DIRECTORIES)
    for path in sorted(root.rglob("index.md")):
        if path == root / "index.md":
            continue
        relative = path.relative_to(root)
        if any(part in {".git", ".obsidian", ".trash"} for part in relative.parts):
            continue
        path.unlink()
        changes.append(f"{relative.as_posix()} (removed nested index)")
    placeholder = root / "sources" / "assets" / ".gitkeep"
    if placeholder.is_file():
        placeholder.unlink()
        changes.append("sources/assets/.gitkeep (removed empty-directory placeholder)")
    for directory in sorted(
        (path for path in root.rglob("*") if path.is_dir()),
        key=lambda path: len(path.parts),
        reverse=True,
    ):
        relative = directory.relative_to(root)
        if any(part in {".git", ".obsidian", ".trash"} for part in relative.parts):
            continue
        if relative in preserved_directories:
            continue
        with suppress(OSError):
            directory.rmdir()
            changes.append(f"{relative.as_posix()}/ (removed empty directory)")
    return changes


def _sync_system_resources(root: Path, templates: Path) -> list[str]:
    """Install managed contracts/templates and preserve editable interactive files."""

    changes: list[str] = []
    for relative, overwrite in (
        (Path("system/contracts"), True),
        (Path("system/templates/canonical"), True),
        (Path("system/templates/core"), True),
        (Path("system/templates/interactive"), False),
        (Path("system/views"), True),
        (Path("system/policies"), True),
        (Path("system/integrations/web-clipper"), True),
    ):
        source_root = templates / relative
        if not source_root.is_dir():
            continue
        managed_files = {
            source.relative_to(source_root) for source in source_root.rglob("*") if source.is_file()
        }
        for source in source_root.rglob("*"):
            if not source.is_file():
                continue
            target = root / relative / source.relative_to(source_root)
            if target.is_file() and not overwrite:
                continue
            current_bytes = target.read_bytes() if target.is_file() else None
            payload = source.read_bytes()
            if current_bytes == payload:
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
            changes.append(target.relative_to(root).as_posix())
        if overwrite:
            target_root = root / relative
            if target_root.is_dir():
                for stale in sorted(target_root.rglob("*")):
                    if stale.is_file() and stale.relative_to(target_root) not in managed_files:
                        stale.unlink()
                        changes.append(
                            f"{stale.relative_to(root).as_posix()} (removed stale managed resource)"
                        )

    obsidian = root / ".obsidian"
    obsidian.mkdir(parents=True, exist_ok=True)
    app_target = obsidian / "app.json"
    app_settings = _read_json_object(app_target)
    app_settings.update(
        {
            "showInlineTitle": False,
            "propertiesInDocument": "hidden",
        }
    )
    rendered_app = json.dumps(app_settings, ensure_ascii=False, indent=2) + "\n"
    if not app_target.is_file() or app_target.read_text(encoding="utf-8") != rendered_app:
        _write_text_atomic(app_target, rendered_app)
        changes.append(".obsidian/app.json")

    for filename in ("daily-notes.json", "templates.json"):
        source = templates / ".obsidian" / filename
        target = obsidian / filename
        wanted = json.loads(source.read_text(encoding="utf-8"))
        settings = _read_json_object(target)
        rendered = json.dumps({**settings, **wanted}, ensure_ascii=False, indent=2) + "\n"
        if not target.is_file() or target.read_text(encoding="utf-8") != rendered:
            _write_text_atomic(target, rendered)
            changes.append(f".obsidian/{filename}")
    return changes


def _normalize_interactive_templates(root: Path) -> list[str]:
    """Upgrade legacy YAML lines without overwriting user-edited template bodies."""

    changes: list[str] = []
    template_root = root / "system" / "templates" / "interactive"
    if not template_root.is_dir():
        return changes
    for path in sorted(template_root.glob("*.md")):
        original = path.read_text(encoding="utf-8")
        updated = re.sub(r"(?m)^(?:owner|updated_at):[^\n]*(?:\n|$)", "", original)
        updated = re.sub(r"(?m)^status:\s*stable\s*(?:\n|$)", "", updated)
        if "\ncreated_at:" not in updated:
            updated = re.sub(
                r"(?m)^(status:[^\n]*)$",
                "\\1\ncreated_at: \"<% tp.date.now('YYYY-MM-DDTHH:mm:ssZ') %>\"",
                updated,
                count=1,
            )
        if updated == original:
            continue
        path.write_text(updated, encoding="utf-8", newline="\n")
        changes.append(f"{path.relative_to(root).as_posix()} (updated template YAML)")
    return changes


def _append_ai_region(body: str, name: str) -> str:
    start = f'<!-- ai:auto:start name="{name}" -->'
    if start in body:
        return body
    return body.rstrip() + "\n\n" + start + "\n" + f'<!-- ai:auto:end name="{name}" -->' + "\n"


def _wrap_human_notes(body: str) -> str:
    if "<!-- human:notes:start -->" in body:
        return body
    for heading in ("## 我的学习记录", "## 我的笔记", "## 我的课堂原始记录"):
        position = body.find(heading)
        if position < 0:
            continue
        content_start = position + len(heading)
        next_heading = body.find("\n## ", content_start)
        content_end = next_heading if next_heading >= 0 else len(body)
        content = body[content_start:content_end].strip()
        wrapped = (
            f"{heading}\n\n<!-- human:notes:start -->\n"
            + (content + "\n" if content else "")
            + "<!-- human:notes:end -->"
        )
        return body[:position] + wrapped + body[content_end:]
    return body


def _feed_decisions(state: Path | None) -> dict[str, str]:
    decisions: dict[str, str] = {}
    if state is None:
        return decisions
    root = state.resolve() / "feed-decisions"
    if not root.is_dir():
        return decisions
    for path in root.rglob("*.json"):
        with suppress(OSError, json.JSONDecodeError):
            loaded: object = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(loaded, dict):
                continue
            payload = cast(dict[str, object], loaded)
            item_id = payload.get("item_id")
            action = payload.get("action")
            if isinstance(item_id, str) and isinstance(action, str):
                decisions[item_id] = action
    return decisions


def _wiki_operations(state: Path | None) -> dict[str, dict[str, object]]:
    """Return only the latest legacy background Wiki operation per target."""

    selected: dict[str, dict[str, object]] = {}
    if state is None:
        return selected
    root = state.resolve() / "operations"
    if not root.is_dir():
        return selected
    for path in root.glob("op-*.json"):
        with suppress(OSError, json.JSONDecodeError):
            loaded: object = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(loaded, dict):
                continue
            payload = cast(dict[str, object], loaded)
            if payload.get("kind") not in {"distill-wiki", "generate-wiki-draft"}:
                continue
            target = payload.get("target")
            if not isinstance(target, str):
                continue
            previous = selected.get(target)
            if previous is None or str(payload.get("updated_at", "")) > str(
                previous.get("updated_at", "")
            ):
                payload["_migration_record_path"] = path
                selected[target] = payload
    return selected


def _retire_legacy_operation(operation: dict[str, object], now: str) -> str | None:
    record_path = operation.get("_migration_record_path")
    if not isinstance(record_path, Path) or not record_path.is_file():
        return None
    payload = {key: value for key, value in operation.items() if not key.startswith("_migration_")}
    payload.pop("learning_status", None)
    payload.pop("mode", None)
    payload["status"] = "superseded"
    payload["updated_at"] = now
    payload["superseded_reason"] = "legacy Markdown placeholder removed by Contract v2 migration"
    record_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    return record_path.name


def _retire_absent_legacy_operations(
    root: Path,
    state: Path | None,
    now: str,
) -> list[str]:
    changes: list[str] = []
    for target, operation in _wiki_operations(state).items():
        schema = operation.get("schema")
        legacy_schema = isinstance(schema, int) and schema < 5
        if (
            operation.get("status") != "failed"
            or (root / target).is_file()
            or not (legacy_schema or "learning_status" in operation)
        ):
            continue
        retired = _retire_legacy_operation(operation, now)
        if retired is not None:
            changes.append(f"State/{retired} (retired absent legacy operation)")
    return changes


def _repair_legacy_structure(root: Path) -> list[str]:
    """Repair legacy paths and body regions without introducing workflow state."""

    changes: list[str] = []
    for path in sorted(root.rglob("*.md")):
        relative = path.relative_to(root).as_posix()
        if any(part in {".agents", ".git", ".obsidian", ".trash"} for part in path.parts):
            continue
        if path.name in {"index.md", "log.md", "AGENTS.md"}:
            continue
        if relative.startswith("system/contracts/") or relative.startswith("system/templates/"):
            continue
        with suppress(OSError, ValueError):
            document = read_document(path)
            changed = False
            if document.type == "Feed Edition" and "feed_kind" not in document.frontmatter:
                legacy = document.frontmatter.pop("feed", None)
                if isinstance(legacy, str):
                    document.frontmatter["feed_kind"] = legacy
                    changed = True
            elif document.type == "Source":
                if not document.frontmatter.get("source_kind") and not document.frontmatter.get(
                    "kind"
                ):
                    with suppress(ValueError, IndexError):
                        source_relative = path.relative_to(root / "sources" / "records")
                        document.frontmatter["source_kind"] = source_relative.parts[0]
                        changed = True
                if not document.frontmatter.get("extract") and not document.frontmatter.get("text"):
                    source_relative = path.relative_to(root / "sources" / "records")
                    extract = root / "sources" / "extracts" / source_relative
                    if extract.is_file():
                        document.frontmatter["extract"] = f"/{extract.relative_to(root).as_posix()}"
                        changed = True
            elif document.type == "Source Extract":
                if not any(line.startswith("# ") for line in document.body.splitlines()):
                    title = str(document.frontmatter.get("title") or path.stem)
                    document.body = f"# {title}\n\n{document.body.lstrip()}"
                    changed = True
            elif document.type == "Daily Note":
                for region in ("linked-activity", "organized-daily"):
                    updated = _append_ai_region(document.body, region)
                    if updated != document.body:
                        document.body = updated
                        changed = True
            elif document.type in {"Learning Note", "Class Note"}:
                updated = _wrap_human_notes(document.body)
                if updated != document.body:
                    document.body = updated
                    changed = True
            if changed:
                write_document(path, document)
                changes.append(f"{relative} (repaired legacy structure)")
    for relative in (
        "system/contracts/daily-note.md",
        "system/contracts/project.md",
        "system/contracts/study-material.md",
        "system/contracts/wiki.md",
        "system/templates/capture.md.tmpl",
        "system/templates/daily.md.tmpl",
    ):
        obsolete = root / relative
        if obsolete.is_file():
            obsolete.unlink()
            changes.append(f"{relative} (removed obsolete duplicate)")
    return changes


def _disposition(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    return {
        "learn": "learn",
        "course": "learn",
        "learn-now": "learn",
        "learn-later": "learn",
        "wiki": "wiki",
        "wiki-now": "wiki",
        "source": "reference",
        "source-only": "reference",
        "reference": "reference",
        "later": "undecided",
        "undecided": "undecided",
        "ignore": "reference",
    }.get(value)


def _placeholder_wiki(document: OkfDocument) -> bool:
    if document.type != "Wiki" or document.frontmatter.get("generation_status") != "failed":
        return False
    lowered = document.body.casefold()
    markers = (
        "正在等待 codex",
        "wiki 草稿尚未生成完成",
        "等待 codex 从来源提炼",
    )
    return any(marker in lowered for marker in markers)


def _normalize_contract_v2(root: Path, state: Path | None) -> list[str]:
    """Remove historical workflow fields and keep only durable OKF semantics."""

    changes: list[str] = []
    decisions = _feed_decisions(state)
    wiki_operations = _wiki_operations(state)
    now = datetime.now().astimezone().isoformat(timespec="seconds")
    for path in sorted(root.rglob("*.md")):
        relative = path.relative_to(root).as_posix()
        if any(
            part in {".agents", ".claudian", ".git", ".obsidian", ".trash"}
            for part in path.relative_to(root).parts
        ):
            continue
        if path.name in {"index.md", "log.md", "AGENTS.md"}:
            continue
        if relative.startswith(("system/contracts/", "system/templates/")):
            continue
        with suppress(OSError, ValueError):
            document = read_document(path)
            if document.type == "Archived Legacy Note":
                if _is_learning_queue_placeholder(document):
                    path.unlink()
                    changes.append(f"{relative} (removed obsolete archived placeholder)")
                    continue
                target = _unique_target(root, Path("knowledge/wiki") / path.name)
                document.frontmatter["type"] = "Wiki"
                document.frontmatter["description"] = _description(document)
                document.frontmatter["status"] = "deprecated"
                document.frontmatter.pop("legacy_type", None)
                document.frontmatter.pop("archived_at", None)
                write_document(target, document, create_only=True)
                path.unlink()
                changes.append(
                    f"{relative} -> {target.relative_to(root).as_posix()} (legacy to Wiki)"
                )
                continue
            original = dict(document.frontmatter)
            fields = document.frontmatter
            legacy_operation = wiki_operations.get(relative)
            generated = fields.get("generated")
            generated_by = (
                cast(Mapping[object, object], generated).get("by")
                if isinstance(generated, Mapping)
                else None
            )
            if (
                document.type == "Wiki"
                and legacy_operation is not None
                and legacy_operation.get("status") == "failed"
                and generated_by in {"feed-decision", "system/import-scaffold"}
            ):
                path.unlink()
                changes.append(f"{relative} (removed failed background Wiki placeholder)")
                retired = _retire_legacy_operation(legacy_operation, now)
                if retired is not None:
                    changes.append(f"State/{retired} (retired failed legacy operation)")
                continue
            if _placeholder_wiki(document):
                path.unlink()
                changes.append(f"{relative} (removed failed Wiki placeholder)")
                if legacy_operation is not None:
                    retired = _retire_legacy_operation(legacy_operation, now)
                    if retired is not None:
                        changes.append(f"State/{retired} (retired failed legacy operation)")
                continue

            fields.setdefault("title", path.stem)
            fields.setdefault(
                "created_at",
                fields.get("updated_at")
                or datetime.fromtimestamp(path.stat().st_mtime)
                .astimezone()
                .isoformat(timespec="seconds")
                or now,
            )
            fields.pop("owner", None)
            fields.pop("updated_at", None)

            old_learning = fields.pop("learning_status", None)
            if old_learning in {"learned", "completed"}:
                fields["learned"] = True
            elif fields.get("learned") is not True:
                fields.pop("learned", None)
            fields.pop("study_material_status", None)
            fields.pop("generation_status", None)

            if document.type == "Source":
                if "uses" not in fields and "purpose" not in fields:
                    item_id = fields.get("feed_item_id")
                    recorded_decision = decisions.get(item_id) if isinstance(item_id, str) else None
                    disposition = (
                        _disposition(recorded_decision)
                        or _disposition(fields.get("disposition"))
                        or _disposition(fields.get("feed_decision"))
                        or _disposition(fields.get("intended_use"))
                        or "undecided"
                    )
                    fields["disposition"] = disposition
                for name in (
                    "feed_decision",
                    "intended_use",
                    "routing_status",
                    "parser_policy",
                    "requested_parser",
                    "parser",
                    "degraded_from",
                ):
                    fields.pop(name, None)
            elif document.type == "Source Extract":
                fallback = fields.pop("degraded_from", None)
                if isinstance(fallback, str) and fallback.strip():
                    fields["fallback_from"] = fallback
                for name in ("parser_policy", "requested_parser", "projection_schema"):
                    fields.pop(name, None)
                if fields.get("assets") == []:
                    fields.pop("assets", None)
            elif document.type == "Feed Edition":
                fields.setdefault("edition_at", fields["created_at"])
                fields.setdefault("feed_items", [])
                fields.pop("quality", None)
                fields.pop("quality_reason", None)
                fields.pop("generated_at", None)
                if fields.get("stream") is None:
                    fields.pop("stream", None)
            elif document.type == "Class Note":
                fields.pop("course", None)
            elif document.type == "Project Decision":
                fields.pop("project", None)
            elif document.type == "Project" and fields.get("project_status") == "archived":
                fields["project_status"] = "completed"
            elif document.type == "Course" and fields.get("course_status") == "archived":
                fields["course_status"] = "completed"

            for name in ("aliases", "tags", "sources"):
                if fields.get(name) == [] and not (
                    document.type == "Source Text" and name == "sources"
                ):
                    fields.pop(name, None)
            generated = fields.get("generated")
            if (
                isinstance(generated, Mapping)
                and cast(Mapping[object, object], generated).get("by")
                == "codex/background-wiki-draft"
            ):
                generated_event = cast(Mapping[object, object], generated)
                fields["generated"] = {
                    "by": "codex/background",
                    "at": generated_event.get("at") or now,
                }
            elif (
                document.type == "Wiki"
                and legacy_operation is not None
                and legacy_operation.get("status") == "completed"
                and generated_by in {None, "feed-decision", "system/import-scaffold"}
            ):
                fields["generated"] = {
                    "by": "codex/background",
                    "at": legacy_operation.get("updated_at") or now,
                }
            if dict(fields) != original:
                write_document(path, document)
                changes.append(f"{relative} (normalized to Contract v2)")
    return changes


def _move_profile_v3_paths(root: Path) -> tuple[list[str], dict[str, str]]:
    """Move legacy public folders into their final OKF Profile 3 locations."""

    changes: list[str] = []
    links: dict[str, str] = {}
    directory_moves: list[tuple[Path, Path]] = [
        (Path("learning/topics"), Path("learning/guides")),
        (Path("sources/extracts"), Path("sources/text")),
    ]
    courses = root / "learning" / "courses"
    if courses.is_dir():
        for course in sorted(path for path in courses.iterdir() if path.is_dir()):
            relative = course.relative_to(root)
            directory_moves.extend(
                (
                    (relative / "notes", relative / "lessons"),
                    (relative / "materials", relative / "guides"),
                )
            )
    for old_root, new_root in directory_moves:
        source_root = root / old_root
        if not source_root.is_dir():
            continue
        for source in sorted(path for path in source_root.rglob("*") if path.is_file()):
            old_relative = source.relative_to(root).as_posix()
            target = root / new_root / source.relative_to(source_root)
            if target.exists():
                target = _unique_target(root, target.relative_to(root))
            target.parent.mkdir(parents=True, exist_ok=True)
            source.replace(target)
            new_relative = target.relative_to(root).as_posix()
            links[old_relative] = new_relative
            changes.append(f"{old_relative} -> {new_relative}")
        for directory in sorted(
            (path for path in source_root.rglob("*") if path.is_dir()),
            key=lambda value: len(value.parts),
            reverse=True,
        ):
            with suppress(OSError):
                directory.rmdir()
        with suppress(OSError):
            source_root.rmdir()
    return changes, links


def _rewrite_profile_v3_legacy_path_prefixes(root: Path) -> list[str]:
    """Rewrite extensionless Wiki links and other references left by legacy folders."""

    prefixes = {
        "learning/topics/": "learning/guides/",
        "sources/extracts/": "sources/text/",
    }
    courses = root / "learning" / "courses"
    if courses.is_dir():
        for course in sorted(path for path in courses.iterdir() if path.is_dir()):
            relative = course.relative_to(root).as_posix()
            prefixes[f"{relative}/notes/"] = f"{relative}/lessons/"
            prefixes[f"{relative}/materials/"] = f"{relative}/guides/"
    changes: list[str] = []
    for path in sorted(root.rglob("*.md")):
        relative = path.relative_to(root)
        if any(part in {".agents", ".git", ".obsidian", ".trash"} for part in relative.parts):
            continue
        original = path.read_text(encoding="utf-8")
        updated = original
        for old, new in prefixes.items():
            updated = updated.replace(old, new)
        if updated == original:
            continue
        path.write_text(updated, encoding="utf-8", newline="\n")
        changes.append(f"{relative.as_posix()} (updated legacy path prefixes)")
    return changes


def _profile_v3_type(value: str) -> str:
    return {
        "Daily Note": "Daily",
        "Project Decision": "Decision",
        "Class Note": "Lesson",
        "Learning Note": "Study Guide",
        "Knowledge Map": "Wiki Map",
        "Feed Edition": "Digest",
        "Source Extract": "Source Text",
        "Personal Context": "Profile",
    }.get(value, value)


def _purpose(value: object) -> str:
    if not isinstance(value, str):
        return "undecided"
    return {
        "learn": "study",
        "course": "study",
        "learn-now": "study",
        "learn-later": "study",
        "study": "study",
        "wiki": "wiki",
        "wiki-now": "wiki",
        "source": "reference",
        "source-only": "reference",
        "reference": "reference",
        "later": "undecided",
        "undecided": "undecided",
        "ignore": "reference",
    }.get(value, "undecided")


def _normalize_source_uses(root: Path, fields: MutableMapping[str, object]) -> None:
    """Migrate legacy Source routing fields into durable, context-aware uses."""

    normalized: list[dict[str, str]] = []

    def context(field: str, value: object) -> str | None:
        if not isinstance(value, str) or not value.strip():
            return None
        with suppress(OSError, ValueError):
            return normalize_context_reference(root, field, value)
        return None

    def append_use(purpose_value: object, course: object, project: object) -> None:
        use = {"purpose": _purpose(purpose_value)}
        for field, value in (("course", course), ("project", project)):
            if resolved := context(field, value):
                use[field] = resolved
        if use not in normalized:
            normalized.append(use)

    raw_uses = fields.get("uses")
    if isinstance(raw_uses, list):
        for item in cast(list[object], raw_uses):
            if not isinstance(item, Mapping):
                continue
            use = cast(Mapping[object, object], item)
            append_use(use.get("purpose"), use.get("course"), use.get("project"))

    legacy_purpose = fields.pop("purpose", _MISSING)
    legacy_disposition = fields.pop("disposition", _MISSING)
    legacy_course = fields.pop("course", _MISSING)
    legacy_project = fields.pop("project", _MISSING)
    has_legacy_use = any(
        value is not _MISSING
        for value in (legacy_purpose, legacy_disposition, legacy_course, legacy_project)
    )
    if has_legacy_use:
        selected = legacy_purpose if legacy_purpose is not _MISSING else legacy_disposition
        append_use(selected, legacy_course, legacy_project)
    if not normalized:
        normalized.append({"purpose": "undecided"})
    fields["uses"] = normalized


def _file_time(path: Path) -> str:
    return datetime.fromtimestamp(path.stat().st_mtime).astimezone().isoformat(timespec="seconds")


def _inferred_ingested_via(
    note_type: str,
    fields: Mapping[str, object],
    relative: str,
) -> str | None:
    """Infer channels only from durable local evidence during a profile migration."""

    if note_type == "Capture":
        # Before Web Clipper support, every Capture producer was a direct user entry.
        return DIRECT_ENTRY
    if note_type != "Source":
        return None

    lowered = relative.casefold()
    kind = str(fields.get("kind") or fields.get("source_kind") or "").casefold()
    resource = str(fields.get("resource") or "").casefold()
    if (
        fields.get("feed_item") is not None
        or fields.get("feed_item_id") is not None
        or fields.get("digest") is not None
        or fields.get("feed_edition") is not None
        or "/ai-daily/" in f"/{lowered}"
        or "/treehole/" in f"/{lowered}"
        or kind in {"ai-daily", "treehole"}
    ):
        return FEED
    if (
        "/documents/" in f"/{lowered}"
        or resource.startswith("okf-original://")
        or kind
        in {
            "doc",
            "docx",
            "document",
            "epub",
            "html",
            "md",
            "odt",
            "pdf",
            "ppt",
            "pptx",
            "rtf",
            "txt",
            "xls",
            "xlsx",
        }
    ):
        return FILE_IMPORT
    if "/web/" in f"/{lowered}":
        return WEB_CLIP
    return None


def _normalize_ingestion_fields(
    note_type: str,
    fields: MutableMapping[str, object],
    relative: str,
) -> None:
    """Migrate the former ``origin`` experiment into the final artifact-local field."""

    old_origin = fields.pop("origin", _MISSING)
    if note_type not in {"Capture", "Source"}:
        fields.pop("ingested_via", None)
        return
    has_current = "ingested_via" in fields
    current = normalize_ingested_via(fields.get("ingested_via"))
    if current is not None:
        fields["ingested_via"] = current
        return
    fields.pop("ingested_via", None)
    if has_current:
        return
    if old_origin is not _MISSING:
        legacy = normalize_ingested_via(old_origin)
        if legacy is not None:
            fields["ingested_via"] = legacy
        return
    resolved = _inferred_ingested_via(note_type, fields, relative)
    if resolved is None:
        fields.pop("ingested_via", None)
    else:
        fields["ingested_via"] = resolved


def _normalize_profile_v3(root: Path) -> list[str]:
    """Finalize public type names and durable fields without inventing state."""

    changes: list[str] = []
    for path in sorted(root.rglob("*.md")):
        relative = path.relative_to(root).as_posix()
        if any(
            part in {".agents", ".claudian", ".git", ".obsidian", ".trash"}
            for part in path.relative_to(root).parts
        ):
            continue
        if path.name in {"index.md", "log.md", "AGENTS.md"}:
            continue
        if relative.startswith(("system/contracts/", "system/templates/")):
            continue
        with suppress(OSError, ValueError):
            document = read_document(path)
            fields = document.frontmatter
            original = dict(fields)
            original_body = document.body
            old_type = document.type
            fields["type"] = _profile_v3_type(old_type)
            note_type = str(fields["type"])
            fields.setdefault("title", path.stem)
            fields.setdefault("created_at", _file_time(path))
            _normalize_ingestion_fields(note_type, fields, relative)

            status = fields.get("status")
            if status not in {"draft", "deprecated"}:
                fields.pop("status", None)

            old_learning = fields.pop("learning_status", None)
            old_learned = fields.pop("learned", None)
            if old_learning in {"learned", "completed"} or old_learned is True:
                fields.setdefault("studied_at", _file_time(path))

            if note_type == "Daily":
                fields.setdefault("date", path.stem)
                document.body = _append_ai_region(document.body, "linked-activity")
                document.body = _append_ai_region(document.body, "organized-daily")
            elif note_type == "Lesson":
                fields["lesson_at"] = fields.pop(
                    "class_at", fields.get("lesson_at", path.stem[:10])
                )
                parts = path.relative_to(root).parts
                if len(parts) >= 4 and parts[:2] == ("learning", "courses"):
                    fields.setdefault("course", f"/learning/courses/{parts[2]}/course.md")
                document.body = document.body.replace("organized-class-note", "organized-lesson")
                document.body = _wrap_human_notes(document.body)
                document.body = _append_ai_region(document.body, "organized-lesson")
            elif note_type == "Study Guide":
                parts = path.relative_to(root).parts
                if len(parts) >= 4 and parts[:2] == ("learning", "courses"):
                    fields.setdefault("course", f"/learning/courses/{parts[2]}/course.md")
                document.body = _wrap_human_notes(document.body)
                document.body = _append_ai_region(document.body, "study-material")
            elif note_type == "Decision":
                fields.setdefault("decided_at", fields.get("created_at"))
                parts = path.relative_to(root).parts
                if len(parts) >= 3 and parts[0] == "projects":
                    fields.setdefault("project", f"/projects/{parts[1]}/project.md")
            elif note_type == "Wiki":
                fields.setdefault("description", _description(document))
                generated = fields.get("generated")
                if isinstance(generated, Mapping):
                    event = cast(Mapping[object, object], generated)
                    fields["generated"] = {
                        "by": "process:codex-background",
                        "at": event.get("at") or fields["created_at"],
                    }
            elif note_type == "Wiki Map":
                fields.setdefault("description", _description(document))
            elif note_type == "Digest":
                fields["feed"] = fields.pop("feed_kind", fields.get("feed", ""))
                fields["digest_id"] = fields.pop("edition_id", fields.get("digest_id", path.stem))
                fields["issued_at"] = fields.pop(
                    "edition_at", fields.get("issued_at", fields["created_at"])
                )
                fields["items"] = fields.pop("feed_items", fields.get("items", []))
                section = fields.pop("stream", fields.get("section"))
                if section:
                    fields["section"] = section
                else:
                    fields.pop("section", None)
            elif note_type == "Source":
                fields["kind"] = fields.pop("source_kind", fields.get("kind", "document"))
                text = fields.pop("extract", fields.get("text"))
                if text:
                    fields["text"] = text
                else:
                    fields.pop("text", None)
                sha256 = fields.pop("source_sha256", fields.get("sha256"))
                if sha256:
                    fields["sha256"] = sha256
                _normalize_source_uses(root, fields)
                feed_item = fields.pop("feed_item_id", fields.get("feed_item"))
                if feed_item:
                    fields["feed_item"] = feed_item
                digest = fields.pop("feed_edition", fields.get("digest"))
                if digest:
                    fields["digest"] = digest
            elif note_type == "Source Text":
                fields.setdefault("parser", "legacy")
                fields.setdefault("sources", [])

            if note_type != "Wiki":
                fields.pop("generated", None)
            for legacy in (
                "study_material_status",
                "generation_status",
                "routing_status",
                "feed_decision",
                "intended_use",
            ):
                fields.pop(legacy, None)
            for name in ("aliases", "tags", "sources"):
                if fields.get(name) == [] and not (
                    note_type == "Source Text" and name == "sources"
                ):
                    fields.pop(name, None)
            if dict(fields) != original or document.body != original_body:
                write_document(path, document)
                changes.append(f"{relative} (normalized to OKF Profile 3)")
    return changes


def _ensure_source_pairs(root: Path) -> list[str]:
    """Give legacy Source-only records a canonical Source Text authority file."""

    changes: list[str] = []
    records = root / "sources" / "records"
    publisher = SourcePublisher(root)
    if not records.is_dir():
        return changes
    for source in sorted(records.rglob("*.md")):
        with suppress(OSError, ValueError):
            source_document = read_document(source)
            if source_document.type != "Source":
                continue
            current = source_document.frontmatter.get("text")
            if isinstance(current, str) and current.strip():
                continue
            relative = source.relative_to(records)
            source_text = root / "sources" / "text" / relative
            if source_text.exists():
                source_text = _unique_target(root, source_text.relative_to(root))
            title = str(source_document.frontmatter.get("title", source.stem))
            source_relative = source.relative_to(root).as_posix()
            text_relative = source_text.relative_to(root).as_posix()
            source_document.frontmatter["text"] = f"/{text_relative}"
            text_document = OkfDocument(
                {
                    "type": "Source Text",
                    "title": f"{title} - 完整正文",
                    "created_at": source_document.frontmatter.get("created_at")
                    or _file_time(source),
                    "parser": "legacy-source-record",
                    "sources": [{"resource": f"/{source_relative}"}],
                },
                source_document.body,
            )
            publisher.publish_pair(source, source_text, source_document, text_document)
            changes.append(f"{source_relative} + {text_relative} (formalized Source pair)")
    return changes


def _ensure_source_text_h1(root: Path) -> list[str]:
    """Add the missing visible title to legacy Source Text without rewriting its body."""

    changes: list[str] = []
    directory = root / "sources" / "text"
    if not directory.is_dir():
        return changes
    for path in sorted(directory.rglob("*.md")):
        try:
            document = read_document(path)
        except (OSError, ValueError):
            continue
        if document.type != "Source Text":
            continue
        first_visible = _first_visible_line(document.body)
        if not first_visible or re.match(r"^#(?:\s|$)", first_visible):
            continue
        title = document.frontmatter.get("title")
        if not isinstance(title, str) or not title.strip():
            continue
        document.body = _prepend_h1(title, document.body)
        write_document(path, document)
        changes.append(f"{path.relative_to(root).as_posix()} (added missing Source Text H1)")
    return changes


def _clean_legacy_logs(root: Path) -> list[str]:
    changes: list[str] = []
    legacy_headings = {"# Directory Update Log", "# 目录更新日志"}
    for log in sorted(root.rglob("log.md")):
        relative = log.relative_to(root)
        if any(part in {".git", ".obsidian", ".trash"} for part in relative.parts):
            continue
        text = log.read_text(encoding="utf-8")
        first, _, remainder = text.partition("\n")
        if first.strip() not in legacy_headings:
            continue
        if relative == Path("log.md") or relative.parts[:2] == ("learning", "courses"):
            if not remainder.strip():
                log.unlink()
                changes.append(f"{relative.as_posix()} (removed empty legacy log)")
            continue
        if len(relative.parts) == 3 and relative.parts[0] == "projects":
            project_home = log.with_name("project.md")
            title = relative.parts[1]
            if project_home.is_file():
                with suppress(OSError, ValueError):
                    loaded = read_document(project_home)
                    title = str(loaded.frontmatter.get("title") or title)
            intro = "该文件按时间记录实际进展、讨论、决定与阻塞；`project.md` 只保留当前状态。"
            existing = remainder.strip()
            updated = f"# {title} · 项目日志\n\n{intro}\n"
            if existing:
                updated += f"\n{existing}\n"
            log.write_text(updated, encoding="utf-8", newline="\n")
            changes.append(f"{relative.as_posix()} (renamed legacy project log)")
    return changes


def _capture_targets_exist(root: Path, value: object) -> bool:
    if not isinstance(value, list):
        return False
    for item in cast(list[object], value):
        if not isinstance(item, str):
            continue
        relative = item.strip().replace("\\", "/").removeprefix("/")
        if not relative:
            continue
        try:
            target = resolve_bundle_path(root.resolve(), relative)
        except ValueError:
            continue
        parts = target.relative_to(root.resolve()).parts
        durable_destination = (
            parts[:2] == ("life", "reflections")
            or parts[:2] == ("knowledge", "wiki")
            or parts[:2] == ("learning", "guides")
            or (
                len(parts) >= 4
                and parts[:2] == ("learning", "courses")
                and parts[3] in {"guides", "lessons"}
            )
            or (len(parts) == 3 and parts[0] == "projects" and parts[2] == "log.md")
        )
        if durable_destination and target.is_file():
            return True
    return False


def _remove_legacy_capture_links(root: Path) -> list[str]:
    """Remove references to the retired archive copy after its body was consumed."""

    changes: list[str] = []
    archived_prefix = "/archive/captures/"
    source_line = re.compile(r"(?m)^\s*来源：\[Capture\]\(/archive/captures/[^)]+\)\s*\n?")
    for path in sorted(root.rglob("*.md")):
        relative = path.relative_to(root).as_posix()
        if relative.startswith(("system/contracts/", "system/templates/")):
            continue
        if any(
            part in {".agents", ".claudian", ".git", ".obsidian", ".trash"}
            for part in path.relative_to(root).parts
        ):
            continue
        with suppress(OSError, ValueError):
            document = read_document(path)
            changed = False
            raw_sources = document.frontmatter.get("sources")
            if isinstance(raw_sources, list):
                retained: list[object] = []
                for item in cast(list[object], raw_sources):
                    resource = (
                        cast(Mapping[object, object], item).get("resource")
                        if isinstance(item, Mapping)
                        else item
                    )
                    if isinstance(resource, str) and resource.startswith(archived_prefix):
                        changed = True
                        continue
                    retained.append(cast(object, item))
                if retained:
                    document.frontmatter["sources"] = retained
                elif changed:
                    document.frontmatter.pop("sources", None)
            cleaned_body = source_line.sub("", document.body)
            if cleaned_body != document.body:
                document.body = cleaned_body
                changed = True
            if changed:
                write_document(path, document)
                changes.append(f"{relative} (removed retired Capture link)")
    return changes


def _normalize_capture_lifecycle(root: Path) -> list[str]:
    """Migrate legacy Capture state into the Inbox-by-presence lifecycle."""

    changes: list[str] = []
    captures: list[tuple[Path, OkfDocument]] = []
    for path in sorted(root.rglob("*.md")):
        relative = path.relative_to(root)
        if any(
            part in {".agents", ".claudian", ".git", ".obsidian", ".trash"}
            for part in relative.parts
        ):
            continue
        if relative.as_posix().startswith(("system/contracts/", "system/templates/")):
            continue
        with suppress(OSError, ValueError):
            document = read_document(path)
            if document.type == "Capture":
                captures.append((path, document))

    for path, document in captures:
        relative = path.relative_to(root)
        rendered = relative.as_posix()
        status = document.frontmatter.get("capture_status")
        had_workflow_fields = (
            "capture_status" in document.frontmatter or "processed_into" in document.frontmatter
        )
        target_exists = _capture_targets_exist(
            root,
            document.frontmatter.get("processed_into"),
        )
        archived = relative.parts[:2] == ("archive", "captures")
        terminal = status == "discarded" or (status == "processed" and target_exists)
        if terminal:
            path.unlink()
            changes.append(f"{rendered} (removed retired Capture copy)")
            continue

        document.frontmatter.pop("capture_status", None)
        document.frontmatter.pop("processed_into", None)
        if archived:
            tail = Path(*relative.parts[2:])
            target = _unique_target(root, Path("inbox/captures") / tail)
            write_document(target, document, create_only=True)
            path.unlink()
            changes.append(f"{rendered} -> {target.relative_to(root).as_posix()}")
        elif had_workflow_fields:
            write_document(path, document)
            changes.append(f"{rendered} (removed legacy Capture state)")

    changes.extend(_remove_legacy_capture_links(root))
    return changes


def _backfill_study_guide_context(root: Path) -> list[str]:
    """Copy only source-proven Course/Project links onto legacy Study Guides."""

    changes: list[str] = []
    learning = root / "learning"
    if not learning.is_dir():
        return changes
    for path in sorted(learning.rglob("*.md")):
        relative = path.relative_to(root).as_posix()
        if path.name == "index.md":
            continue
        with suppress(OSError, ValueError):
            document = read_document(path)
            if document.type != "Study Guide":
                continue
            context = inherited_context_fields(
                root,
                source_paths(document),
                current=document.frontmatter,
            )
            changed = False
            for field, value in context.items():
                if document.frontmatter.get(field) is None:
                    document.frontmatter[field] = value
                    changed = True
            if changed:
                write_document(path, document)
                changes.append(f"{relative} (inherited Course/Project context)")
    return changes


def migrate_current_layout(
    vault: Path,
    template_root: Path,
    state: Path | None = None,
) -> tuple[str, ...]:
    root = vault.resolve()
    templates = template_root.resolve()
    if not (root / "index.md").is_file():
        raise FileNotFoundError(root / "index.md")
    changes: list[str] = []
    gitignore = root / ".gitignore"
    if not gitignore.is_file():
        gitignore.write_text(
            (templates / ".gitignore").read_text(encoding="utf-8"),
            encoding="utf-8",
            newline="\n",
        )
        changes.append(".gitignore")

    with suppress(GitCheckpointError):
        create_checkpoint(root, "checkpoint before OKF Profile 3 migration")

    agent = root / "AGENTS.md"
    new_agent = (templates / "AGENTS.md").read_text(encoding="utf-8")
    old_agent = agent.read_text(encoding="utf-8") if agent.is_file() else ""
    if new_agent != old_agent and (
        not old_agent
        or "# OKF Brain Vault AI 规则" in old_agent
        or "# OKF Brain Vault 工作规则" in old_agent
        or ("Markdown 是权威内容" in old_agent and "Original、密钥、运行状态" in old_agent)
    ):
        agent.write_text(new_agent, encoding="utf-8", newline="\n")
        changes.append("AGENTS.md")

    changes.extend(_migrate_default_web_clippings(root))

    knowledge_changes, link_mapping = _migrate_legacy_knowledge(root)
    changes.extend(knowledge_changes)
    changes.extend(_rewrite_links(root, link_mapping))

    queue = root / "learning" / "queue.md"
    if queue.is_file():
        document = read_document(queue)
        if _EMPTY_QUEUE_MARKER in document.body and "[[" not in document.body:
            queue.unlink()
            changes.append("learning/queue.md (removed empty legacy queue)")
        else:
            document.frontmatter["status"] = "deprecated"
            note = (
                "> [!warning] Legacy\n"
                "> 此文件只保留旧记录，不再是权威队列；Dashboard 从 Study Guide 动态生成。\n\n"
            )
            if "此文件只保留旧记录" not in document.body:
                document.body = document.body.replace(
                    "# Learning Queue\n", "# Learning Queue\n\n" + note, 1
                )
                write_document(queue, document)
                changes.append("learning/queue.md (marked legacy)")

    changes.extend(_remove_nested_indexes(root))

    changes.extend(_clean_legacy_logs(root))

    changes.extend(_sync_system_resources(root, templates))
    changes.extend(_normalize_interactive_templates(root))
    changes.extend(_repair_legacy_structure(root))
    changes.extend(_normalize_contract_v2(root, state))
    profile_path_changes, profile_links = _move_profile_v3_paths(root)
    changes.extend(profile_path_changes)
    changes.extend(_rewrite_links(root, profile_links))
    changes.extend(_rewrite_profile_v3_legacy_path_prefixes(root))
    changes.extend(_normalize_profile_v3(root))
    changes.extend(_normalize_capture_lifecycle(root))
    changes.extend(_ensure_source_pairs(root))
    changes.extend(_ensure_source_text_h1(root))
    changes.extend(_backfill_study_guide_context(root))
    changes.extend(
        _retire_absent_legacy_operations(
            root,
            state,
            datetime.now().astimezone().isoformat(timespec="seconds"),
        )
    )
    changes.extend(_remove_nested_indexes(root))
    changes.extend(
        f"{relative.as_posix()}/ (created standard directory)"
        for relative in ensure_vault_dynamic_directories(root)
    )

    root_index = root / "index.md"
    canonical_index = (templates / "index.md").read_text(encoding="utf-8")
    current_index = root_index.read_text(encoding="utf-8")
    current_navigation = "# Workspace 总目录" in current_index
    if not current_navigation or 'name="current-activity"' in current_index:
        root_index.write_text(canonical_index, encoding="utf-8", newline="\n")
        changes.append("index.md (replaced with structured root directory)")
    rebuild_root_index(root)

    with suppress(GitCheckpointError):
        create_checkpoint(root, "migrate: OKF Profile 3 Workspace layout")
    return tuple(changes)
