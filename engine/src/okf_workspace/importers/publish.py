"""Publish one Source, one full Source Text, and an optional routed target."""

from __future__ import annotations

import re
from datetime import datetime
from pathlib import Path

from okf_workspace.ingestion import FILE_IMPORT
from okf_workspace.okf.frontmatter import OkfDocument
from okf_workspace.okf.paths import slugify
from okf_workspace.sources import SourcePublisher

from .models import ImportIntent, ImportRequest, OriginalRecord, ParserExport

_HEADING = re.compile(r"^#\s+(.+?)\s*$", re.MULTILINE)
_LINK = re.compile(r"(!?\[[^\]]*\]\()([^)#]+)(#[^)]*)?(\))")


def _title(export: ParserExport, original: OriginalRecord) -> str:
    match = _HEADING.search(export.markdown)
    return match.group(1).strip() if match else Path(original.filename).stem


def _ensure_h1(markdown: str, title: str) -> str:
    body = markdown.strip()
    if _HEADING.search(body):
        return body + "\n"
    return f"# {title}\n\n{body}\n"


def _copy_assets(
    vault: Path,
    slug: str,
    export: ParserExport,
) -> tuple[str, list[str]]:
    mapping: dict[str, str] = {}
    published: list[str] = []
    for relative, data in sorted(export.assets.items()):
        normalized = relative.replace("\\", "/").lstrip("./")
        target_relative = f"sources/assets/{slug}/{normalized}"
        target = vault.joinpath(*Path(target_relative).parts)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        mapping[normalized] = f"/{target_relative}"
        published.append(target_relative)

    def replace(match: re.Match[str]) -> str:
        raw = match.group(2).replace("\\", "/").lstrip("./")
        target = mapping.get(raw)
        if target is None:
            return match.group(0)
        return f"{match.group(1)}{target}{match.group(3) or ''}{match.group(4)}"

    return _LINK.sub(replace, export.markdown), published


def _source_entry(relative: str) -> list[dict[str, str]]:
    return [{"resource": f"/{relative}"}]


def _purpose(intent: ImportIntent) -> str:
    return {
        ImportIntent.LEARN: "study",
        ImportIntent.COURSE: "study",
        ImportIntent.WIKI: "wiki",
        ImportIntent.SOURCE: "reference",
        ImportIntent.LATER: "undecided",
    }[intent]


def _route_draft(
    vault: Path,
    request: ImportRequest,
    *,
    slug: str,
) -> Path | None:
    if request.intent is ImportIntent.SOURCE:
        return None
    if request.intent is ImportIntent.LATER:
        return None
    contextual_slug = f"{slug}-{slugify(request.project)}" if request.project is not None else slug
    if request.intent is ImportIntent.WIKI:
        path = vault / "knowledge" / "wiki" / f"{contextual_slug}.md"
    elif request.intent is ImportIntent.COURSE or request.course:
        if not request.course:
            raise ValueError("--course is required for course intent")
        path = vault / "learning" / "courses" / request.course / "guides" / f"{contextual_slug}.md"
    else:
        path = vault / "learning" / "guides" / f"{contextual_slug}.md"
    return path


def publish_import(
    vault: Path,
    request: ImportRequest,
    original: OriginalRecord,
    export: ParserExport,
) -> tuple[Path, Path, Path | None]:
    with SourcePublisher(vault).transaction():
        return _publish_import_locked(vault, request, original, export)


def _publish_import_locked(
    vault: Path,
    request: ImportRequest,
    original: OriginalRecord,
    export: ParserExport,
) -> tuple[Path, Path, Path | None]:
    vault = vault.resolve()
    publisher = SourcePublisher(vault)
    title = _title(export, original)
    slug = f"{slugify(Path(original.filename).stem)}-{original.sha256[:10]}"
    existing = publisher.find_by_sha256(original.sha256)
    if existing is None:
        source_relative = f"sources/records/documents/{slug}.md"
        text_relative = f"sources/text/documents/{slug}.md"
        source = vault / source_relative
        source_text = vault / text_relative
        source_document = OkfDocument({}, "")
        text_document = OkfDocument({}, "")
    else:
        source, source_document = existing
        source_text, text_document = publisher.resolve_text(source_document)
        source_relative = source.relative_to(vault).as_posix()
        text_relative = source_text.relative_to(vault).as_posix()
        slug = source.stem
    markdown, assets = _copy_assets(vault, slug, export)
    now = datetime.now().astimezone().isoformat(timespec="seconds")
    source_document.frontmatter.update(
        {
            "type": "Source",
            "text": f"/{text_relative}",
            "sha256": original.sha256,
        }
    )
    source_document.frontmatter.setdefault("title", title)
    source_document.frontmatter.setdefault("resource", original.resource)
    source_document.frontmatter.setdefault("kind", original.extension.lstrip("."))
    source_document.frontmatter.setdefault("ingested_via", FILE_IMPORT)
    source_document.frontmatter.setdefault("created_at", now)
    publisher.resolve_use(
        source_document,
        purpose=_purpose(request.intent),
        course=request.course,
        project=request.project,
    )
    if not source_document.body.strip():
        source_document.body = (
            f"# {title}\n\n"
            f"- 转换正文：[{text_relative}](/{text_relative})\n"
            f"- 原件：{original.resource}\n"
        )
    text_fields = text_document.frontmatter
    text_fields.update(
        {
            "type": "Source Text",
            "parser": export.parser.value,
            "parser_version": export.parser_version,
            "sources": _source_entry(source_relative),
        }
    )
    text_fields.setdefault("title", f"{title} - 完整正文")
    text_fields.setdefault("created_at", now)
    if export.degraded_from is not None:
        text_fields["fallback_from"] = export.degraded_from.value
    else:
        text_fields.pop("fallback_from", None)
    if assets:
        text_fields["assets"] = [f"/{asset}" for asset in assets]
    else:
        text_fields.pop("assets", None)
    text_title = text_fields.get("title")
    text_document.body = _ensure_h1(
        markdown,
        text_title if isinstance(text_title, str) and text_title.strip() else title,
    )
    publisher.publish_pair(
        source,
        source_text,
        source_document,
        text_document,
    )
    draft = _route_draft(
        vault,
        request,
        slug=slug,
    )
    return source, source_text, draft


def route_existing_import(
    vault: Path,
    source: Path,
    *,
    intent: ImportIntent,
    course: str | None = None,
    project: str | None = None,
) -> tuple[Path, Path, Path | None]:
    vault = vault.resolve()
    source = source.resolve()
    request = ImportRequest(
        source=source,
        intent=intent,
        course=course,
        project=project,
    )
    draft = _route_draft(
        vault,
        request,
        slug=source.stem,
    )
    publisher = SourcePublisher(vault)
    pair = publisher.update_use(
        source,
        purpose=_purpose(intent),
        course=course,
        project=project,
    )
    return pair.source, pair.source_text, draft
