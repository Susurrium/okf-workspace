"""Publish an Obsidian Web Clipper Capture into canonical Source artifacts."""

from __future__ import annotations

import hashlib
from contextlib import suppress
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Literal
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from okf_workspace.git import GitCheckpointError, create_checkpoint
from okf_workspace.ingestion import WEB_CLIP, normalize_ingested_via
from okf_workspace.okf.frontmatter import OkfDocument, read_document
from okf_workspace.okf.paths import resolve_bundle_path, slugify
from okf_workspace.sources import SourcePublisher, restore_file_bytes, source_write_lock

WebCaptureIntent = Literal["learn", "wiki", "source"]

_TRACKING_PARAMETERS = frozenset(
    {
        "dclid",
        "fbclid",
        "gclid",
        "igshid",
        "mc_cid",
        "mc_eid",
        "msclkid",
        "ref_src",
        "s_cid",
        "twclid",
    }
)
_EXCERPT_HEADINGS = (
    "## Selection",
    "## Highlights",
    "## 选中内容",
    "## 高亮",
)
# Compatibility name for Feed while both entry channels migrate to SourcePublisher.
web_source_write_lock = source_write_lock


@dataclass(frozen=True, slots=True)
class PublishedWebCapture:
    source: Path
    source_text: Path
    routed_target: Path | None
    reused: bool


def canonical_web_url(value: str) -> str:
    """Return a stable URL for deduplication while retaining meaningful query data."""

    raw = value.strip()
    parsed = urlsplit(raw)
    scheme = parsed.scheme.casefold()
    if scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("Web Capture resource must be an absolute http(s) URL")
    host = parsed.hostname.casefold()
    if ":" in host:
        host = f"[{host}]"
    port = parsed.port
    if port is not None and not (
        (scheme == "http" and port == 80) or (scheme == "https" and port == 443)
    ):
        host = f"{host}:{port}"
    parameters = [
        (name, content)
        for name, content in parse_qsl(parsed.query, keep_blank_values=True)
        if not name.casefold().startswith("utm_") and name.casefold() not in _TRACKING_PARAMETERS
    ]
    path = parsed.path or "/"
    return urlunsplit((scheme, host, path, urlencode(parameters, doseq=True), ""))


def _checkpoint(vault: Path, message: str) -> None:
    # Publishing should remain available if Git is temporarily busy. Both attempts are
    # still made, and the atomic Markdown writes remain the authority.
    with suppress(GitCheckpointError):
        create_checkpoint(vault, message)


def _capture_content(body: str, title: str) -> str:
    content = body.strip()
    if content.startswith("# "):
        return content
    return f"# {title}\n\n{content}".rstrip()


def _is_excerpt(body: str) -> bool:
    return any(heading in body for heading in _EXCERPT_HEADINGS)


def _without_title_heading(body: str) -> str:
    lines = body.strip().splitlines()
    if lines and lines[0].startswith("# "):
        lines = lines[1:]
    return "\n".join(lines).strip()


def _merge_body(current: str, incoming: str, captured_at: object) -> str:
    old = current.strip()
    new = incoming.strip()
    if not old:
        return new
    if not new or old == new:
        return old
    if _is_excerpt(new):
        excerpt = _without_title_heading(new)
        if excerpt in old:
            return old
        stamp = str(captured_at).strip() if captured_at else "再次剪藏"
        return f"{old}\n\n## 后续摘录 · {stamp}\n\n{excerpt}\n"
    if _is_excerpt(old):
        excerpt = _without_title_heading(old)
        return f"{new}\n\n## 先前摘录\n\n{excerpt}\n"
    # A new full-page clip replaces the old snapshot; Git keeps the earlier version.
    return new


def find_source_by_canonical_web_url(
    vault: Path,
    canonical: str,
) -> tuple[Path, OkfDocument] | None:
    """Find the first Source whose HTTP(S) resource has the same canonical URL."""

    return SourcePublisher(vault).find_by_resource(
        canonical,
        normalize=canonical_web_url,
    )


def read_linked_source_text(vault: Path, source: OkfDocument) -> tuple[Path, OkfDocument]:
    """Resolve and validate the existing Source Text linked by a Source."""

    return SourcePublisher(vault).resolve_text(source)


def _append_cross_channel_web_capture(current: str, incoming: str, title: str) -> str:
    """Append one distinct Web clip without replacing another channel's source text."""

    identifier = hashlib.sha256(f"{title}\0{incoming.strip()}".encode()).hexdigest()[:16]
    start = f'<!-- okf:web-clip:start id="{identifier}" -->'
    end = f'<!-- okf:web-clip:end id="{identifier}" -->'
    starts = current.count(start)
    ends = current.count(end)
    if starts or ends:
        if starts == 1 and ends == 1 and current.find(start) < current.find(end):
            return current
        raise ValueError("existing Source Text has malformed Web clip markers")
    payload = _without_title_heading(incoming)
    block = f"{start}\n## Web 剪藏补充 · {title}\n\n{payload}\n{end}"
    existing = current.rstrip()
    return f"{existing}\n\n{block}\n" if existing else f"{block}\n"


def _new_source_pair(vault: Path, title: str, canonical: str) -> tuple[str, Path, Path]:
    digest = hashlib.sha256(canonical.encode()).hexdigest()
    title_slug = slugify(title)
    for length in (10, 16, 24, len(digest)):
        slug = f"{title_slug}-{digest[:length]}"
        source = vault / "sources" / "records" / "web" / f"{slug}.md"
        source_text = vault / "sources" / "text" / "web" / f"{slug}.md"
        if not source.exists() and not source_text.exists():
            return slug, source, source_text
    raise FileExistsError("no collision-free Web Source path is available")


def _purpose(intent: WebCaptureIntent) -> str:
    return {
        "learn": "study",
        "wiki": "wiki",
        "source": "reference",
    }[intent]


def _routed_target(
    vault: Path,
    *,
    intent: WebCaptureIntent,
    slug: str,
    course: str | None,
    project: str | None,
) -> Path | None:
    contextual_slug = f"{slug}-{slugify(project)}" if project is not None else slug
    if intent == "wiki":
        return vault / "knowledge" / "wiki" / f"{contextual_slug}.md"
    if intent == "source":
        return None
    if course:
        return vault / "learning" / "courses" / slugify(course) / "guides" / f"{contextual_slug}.md"
    return vault / "learning" / "guides" / f"{contextual_slug}.md"


def _publish_web_capture(
    vault: Path,
    relative: str,
    *,
    intent: WebCaptureIntent,
    course: str | None = None,
    project: str | None = None,
) -> PublishedWebCapture:
    """Promote one open Web Capture without invoking AI or a document parser."""

    vault = vault.resolve()
    capture = resolve_bundle_path(vault, relative)
    if not capture.is_relative_to(vault / "inbox" / "captures"):
        raise ValueError("only an Inbox Capture can be published")
    document = read_document(capture)
    legacy_status = document.frontmatter.get("capture_status")
    if document.type != "Capture" or legacy_status not in {None, "open"}:
        raise ValueError("only an open Capture can be published")
    if document.frontmatter.get("ingested_via") != WEB_CLIP:
        raise ValueError("only a Capture with ingested_via: web-clip uses this workflow")
    resource = document.frontmatter.get("resource")
    if not isinstance(resource, str):
        raise ValueError("Web Capture has no resource URL")
    canonical = canonical_web_url(resource)
    publisher = SourcePublisher(vault)
    title_value = document.frontmatter.get("title")
    title = (
        title_value.strip()
        if isinstance(title_value, str) and title_value.strip()
        else capture.stem
    )
    existing = find_source_by_canonical_web_url(vault, canonical)
    reused = existing is not None
    if existing is None:
        slug, source, source_text = _new_source_pair(vault, title, canonical)
        source_document = OkfDocument({}, "")
        text_document = OkfDocument({}, "")
    else:
        source, source_document = existing
        slug = source.stem
        source_text, text_document = read_linked_source_text(vault, source_document)

    now = datetime.now().astimezone().isoformat(timespec="seconds")
    created_at = document.frontmatter.get("created_at") or now
    source_relative = source.relative_to(vault).as_posix()
    text_relative = source_text.relative_to(vault).as_posix()
    source_fields = source_document.frontmatter
    source_fields.update(
        {
            "type": "Source",
            "created_at": source_fields.get("created_at") or created_at,
            "text": f"/{text_relative}",
        }
    )
    source_fields.setdefault("resource", resource)
    source_fields.setdefault("kind", "web")
    normalized_channel = normalize_ingested_via(source_fields.get("ingested_via"))
    if not reused:
        source_fields["ingested_via"] = WEB_CLIP
    elif normalized_channel is not None:
        source_fields["ingested_via"] = normalized_channel
    else:
        source_fields.pop("ingested_via", None)
    publisher.resolve_use(
        source_document,
        purpose=_purpose(intent),
        course=course,
        project=project,
    )
    if not reused or normalized_channel == WEB_CLIP:
        source_fields["title"] = title
        source_document.body = (
            f"# {title}\n\n"
            f"- 完整正文：[{text_relative}](/{text_relative})\n"
            f"- 网页来源：{resource}\n"
        )

    text_fields = text_document.frontmatter
    incoming = _capture_content(document.body, title)
    if reused and normalized_channel != WEB_CLIP:
        text_document.body = _append_cross_channel_web_capture(
            text_document.body,
            incoming,
            title,
        )
    else:
        text_fields.update(
            {
                "type": "Source Text",
                "title": f"{title} - 完整正文",
                "created_at": text_fields.get("created_at") or created_at,
                "parser": "obsidian-web-clipper",
                "sources": [{"resource": f"/{source_relative}"}],
            }
        )
        text_document.body = _merge_body(
            text_document.body,
            incoming,
            document.frontmatter.get("created_at"),
        )
    target = _routed_target(
        vault,
        intent=intent,
        slug=slug,
        course=course,
        project=project,
    )

    previous_source = source.read_bytes() if source.is_file() else None
    previous_text = source_text.read_bytes() if source_text.is_file() else None
    _checkpoint(vault, "checkpoint before publishing Web Capture")
    try:
        publisher.publish_pair(
            source,
            source_text,
            source_document,
            text_document,
        )
        capture.unlink()
    except Exception:
        restore_file_bytes(source, previous_source)
        restore_file_bytes(source_text, previous_text)
        raise
    _checkpoint(vault, f"capture: publish web source {slug}")
    return PublishedWebCapture(source, source_text, target, reused)


def publish_web_capture(
    vault: Path,
    relative: str,
    *,
    intent: WebCaptureIntent,
    course: str | None = None,
    project: str | None = None,
) -> PublishedWebCapture:
    """Serialize promotion so two Dashboard clicks cannot create duplicate Sources."""

    with web_source_write_lock():
        return _publish_web_capture(
            vault,
            relative,
            intent=intent,
            course=course,
            project=project,
        )
