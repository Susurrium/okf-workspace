"""Apply explicit human feed decisions without AI interest/value judgments."""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict
from datetime import datetime
from pathlib import Path
from typing import cast

from okf_workspace.git import GitCheckpointError, create_checkpoint
from okf_workspace.ingestion import FEED, normalize_ingested_via
from okf_workspace.notes.web_captures import (
    canonical_web_url,
    web_source_write_lock,
)
from okf_workspace.okf.frontmatter import OkfDocument
from okf_workspace.okf.paths import slugify
from okf_workspace.sources import SourcePublisher

from .editions import materialize_media_references, render_treehole_comments
from .markdown import markdown_link
from .models import (
    DecisionAction,
    DecisionResult,
    FeedItem,
    FeedKind,
)


def _now() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _identity(item: FeedItem) -> str:
    return hashlib.sha256(item.item_id.encode("utf-8")).hexdigest()[:10]


def _slug(item: FeedItem) -> str:
    return f"{slugify(item.title)}-{_identity(item)}"


def _source_entries(relative: str) -> list[dict[str, str]]:
    return [{"resource": f"/{relative}"}]


def _purpose(action: DecisionAction) -> str:
    return {
        DecisionAction.LEARN_NOW: "study",
        DecisionAction.LEARN_LATER: "study",
        DecisionAction.WIKI_NOW: "wiki",
        DecisionAction.SOURCE_ONLY: "reference",
    }[action]


def _render_feed_source_text(vault: Path, item: FeedItem) -> str:
    details: list[str] = [f"# {item.title}\n", item.body.strip()]
    if item.metrics:
        details.append(
            "\n## 指标\n\n"
            + "\n".join(f"- {key}: {value}" for key, value in sorted(item.metrics.items()))
        )
    media = materialize_media_references(vault, item)
    if media:
        details.append("\n## 媒体\n\n" + "\n".join(f"![]({value})" for value in media))
    if item.comments:
        details.append("\n## 评论\n\n" + render_treehole_comments(vault, item))
    return "\n\n".join(details) + "\n"


def _feed_supplement(vault: Path, item: FeedItem) -> tuple[str, str, str]:
    identifier = hashlib.sha256(f"{item.feed.value}\0{item.item_id}".encode()).hexdigest()[:16]
    start = f'<!-- okf:feed-item:start id="{identifier}" -->'
    end = f'<!-- okf:feed-item:end id="{identifier}" -->'
    metadata = [
        f"- Feed：{item.feed.value} / {item.edition_id}",
        f"- Feed item：{item.item_id}",
    ]
    if item.url:
        metadata.append(f"- 原始链接：{markdown_link('打开原文', item.url)}")
    sections = [
        start,
        f"## Feed 补充 · {item.title}\n\n" + "\n".join(metadata),
        item.body.strip(),
    ]
    if item.metrics:
        sections.append(
            "### 指标\n\n"
            + "\n".join(f"- {key}: {value}" for key, value in sorted(item.metrics.items()))
        )
    media = materialize_media_references(vault, item)
    if media:
        sections.append("### 媒体\n\n" + "\n".join(f"![]({value})" for value in media))
    if item.comments:
        sections.append("### 评论\n\n" + render_treehole_comments(vault, item))
    sections.append(end)
    block = "\n\n".join(sections)
    if block.count(start) != 1 or block.count(end) != 1:
        raise ValueError("Feed content contains reserved supplement markers")
    return start, end, block


def _merge_feed_supplement(current: str, start: str, end: str, block: str) -> str:
    starts = current.count(start)
    ends = current.count(end)
    if not starts and not ends:
        existing = current.rstrip()
        return f"{existing}\n\n{block}\n" if existing else f"{block}\n"
    if starts != 1 or ends != 1:
        raise ValueError("existing Source Text has malformed Feed supplement markers")
    start_at = current.find(start)
    end_at = current.find(end)
    if start_at > end_at:
        raise ValueError("existing Source Text has malformed Feed supplement markers")
    return current[:start_at] + block + current[end_at + len(end) :]


class FeedDecisionStore:
    def __init__(self, state: Path) -> None:
        self.root = state.resolve() / "feed-decisions"

    def path_for(self, item: FeedItem) -> Path:
        return self.root / item.feed.value / f"{_identity(item)}.json"

    def save(
        self,
        item: FeedItem,
        action: DecisionAction,
        *,
        result: DecisionResult,
    ) -> Path:
        target = self.path_for(item)
        target.parent.mkdir(parents=True, exist_ok=True)
        payload: dict[str, object] = {
            "item_id": item.item_id,
            "feed": item.feed.value,
            "edition_id": item.edition_id,
            "title": item.title,
            "action": action.value,
            "decided_at": _now(),
            "outputs": asdict(result),
        }
        target.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
            newline="\n",
        )
        return target

    def load(self, item: FeedItem) -> dict[str, object] | None:
        path = self.path_for(item)
        if not path.is_file():
            return None
        loaded = cast(object, json.loads(path.read_text(encoding="utf-8")))
        return cast(dict[str, object], loaded) if isinstance(loaded, dict) else None

    def attach_semantic_operation(self, item: FeedItem, operation_id: str) -> None:
        payload = self.load(item)
        if payload is None:
            raise FileNotFoundError(self.path_for(item))
        payload["semantic_operation_id"] = operation_id
        self.path_for(item).write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
            newline="\n",
        )


class FeedDecisionService:
    def __init__(self, vault: Path, state: Path) -> None:
        self.vault = vault.resolve()
        self.state = state.resolve()
        self.store = FeedDecisionStore(self.state)

    def _source_paths(self, item: FeedItem) -> tuple[str, str]:
        category = "ai-daily" if item.feed is FeedKind.AI_DAILY else "treehole"
        slug = _slug(item)
        return (
            f"sources/records/{category}/{slug}.md",
            f"sources/text/{category}/{slug}.md",
        )

    def _create_source(
        self,
        item: FeedItem,
        action: DecisionAction,
    ) -> tuple[Path, Path]:
        with web_source_write_lock(self.vault):
            return self._create_source_locked(item, action)

    def _create_source_locked(
        self,
        item: FeedItem,
        action: DecisionAction,
    ) -> tuple[Path, Path]:
        publisher = SourcePublisher(self.vault)
        source_relative, text_relative = self._source_paths(item)
        source = self.vault / source_relative
        source_text = self.vault / text_relative
        now = _now()
        resource = item.url or f"feed://{item.feed.value}/{item.item_id}"
        if not source.is_file() and item.url:
            try:
                canonical = canonical_web_url(item.url)
            except ValueError:
                canonical = None
            existing = (
                publisher.find_by_resource(item.url, normalize=canonical_web_url)
                if canonical is not None
                else None
            )
            if existing is not None:
                reused_source, source_document = existing
                reused_text, text_document = publisher.resolve_text(source_document)
                start, end, supplement = _feed_supplement(self.vault, item)
                text_document.body = _merge_feed_supplement(
                    text_document.body,
                    start,
                    end,
                    supplement,
                )
                first_channel = normalize_ingested_via(
                    source_document.frontmatter.get("ingested_via")
                )
                if first_channel is None:
                    source_document.frontmatter.pop("ingested_via", None)
                else:
                    source_document.frontmatter["ingested_via"] = first_channel
                publisher.resolve_use(
                    source_document,
                    purpose=_purpose(action),
                )
                publisher.publish_pair(
                    reused_source,
                    reused_text,
                    source_document,
                    text_document,
                )
                return reused_source, reused_text
        source_existed = source.is_file()
        if source_existed:
            source_document = publisher.read_record(source)
            source_text, text_document = publisher.resolve_text(source_document)
            source_relative = source.relative_to(self.vault).as_posix()
            text_relative = source_text.relative_to(self.vault).as_posix()
            source_document.frontmatter.update(
                {
                    "resource": resource,
                    "kind": item.feed.value,
                    "text": f"/{text_relative}",
                    "feed_item": item.item_id,
                    "digest": item.edition_id,
                }
            )
        else:
            source_document = OkfDocument(
                {
                    "type": "Source",
                    "title": item.title,
                    "resource": resource,
                    "kind": item.feed.value,
                    "text": f"/{text_relative}",
                    "feed_item": item.item_id,
                    "digest": item.edition_id,
                    "ingested_via": FEED,
                    "created_at": now,
                },
                (
                    f"# {item.title}\n\n"
                    f"- 转换正文：[{text_relative}](/{text_relative})\n"
                    f"- Feed：{item.feed.value} / {item.edition_id}\n"
                    + (f"- 原始链接：{markdown_link('打开原文', item.url)}\n" if item.url else "")
                ),
            )
            text_document = OkfDocument({}, "")
        publisher.resolve_use(
            source_document,
            purpose=_purpose(action),
        )
        text_document.frontmatter.update(
            {
                "type": "Source Text",
                "title": f"{item.title} - 完整正文",
                "parser": "feed-cache",
                "parser_version": "2",
                "sources": _source_entries(source_relative),
                "created_at": text_document.frontmatter.get("created_at") or now,
            }
        )
        if source_existed:
            # A Source Text can acquire Web clips, human corrections and other
            # channel supplements after its first Feed publication. Only replace
            # this item's explicit Feed region; never regenerate the whole note.
            start, end, supplement = _feed_supplement(self.vault, item)
            legacy_body = _render_feed_source_text(self.vault, item).lstrip("\n")
            current_body = text_document.body.lstrip("\n")
            if start not in current_body and current_body.startswith(legacy_body):
                # Upgrade only an exact known generated prefix, retaining all
                # following channel supplements and human annotations.
                text_document.body = (
                    f"# {item.title}\n\n{supplement}\n" + current_body[len(legacy_body) :]
                )
            else:
                text_document.body = _merge_feed_supplement(
                    text_document.body, start, end, supplement
                )
        else:
            start, end, supplement = _feed_supplement(self.vault, item)
            text_document.body = f"# {item.title}\n\n{supplement}\n"
        publisher.publish_pair(
            source,
            source_text,
            source_document,
            text_document,
        )
        return source, source_text

    def _learning_target(
        self,
        item: FeedItem,
    ) -> Path:
        target = self.vault / "learning" / "guides" / f"{_slug(item)}.md"
        return target

    def _wiki_target(self, item: FeedItem) -> Path:
        target = self.vault / "knowledge" / "wiki" / f"{_slug(item)}.md"
        return target

    def decide(
        self,
        item: FeedItem,
        action: DecisionAction,
        *,
        checkpoint: bool = True,
    ) -> DecisionResult:
        """Apply one user-selected outcome; AI never chooses this action."""
        source: Path | None = None
        source_text: Path | None = None
        study_guide: Path | None = None
        wiki: Path | None = None
        warnings: list[str] = []
        existing_source_relative, _existing_text_relative = self._source_paths(item)
        existing_source = self.vault / existing_source_relative
        creates_artifacts = action in {
            DecisionAction.LEARN_NOW,
            DecisionAction.LEARN_LATER,
            DecisionAction.WIKI_NOW,
            DecisionAction.SOURCE_ONLY,
        }
        changes_vault = creates_artifacts or (
            existing_source.is_file() and action is not DecisionAction.IGNORE
        )
        if changes_vault and checkpoint:
            try:
                create_checkpoint(self.vault, f"checkpoint before feed {action.value}")
            except GitCheckpointError as exc:
                warnings.append(f"写入前 Git 检查点失败：{exc}")
        if creates_artifacts:
            source, source_text = self._create_source(item, action)
            if action is DecisionAction.LEARN_NOW:
                study_guide = self._learning_target(item)
            elif action is DecisionAction.WIKI_NOW:
                wiki = self._wiki_target(item)
            if checkpoint:
                try:
                    create_checkpoint(self.vault, f"feed: {action.value} {item.item_id}")
                except GitCheckpointError as exc:
                    warnings.append(f"写入后 Git 检查点失败：{exc}")
        elif existing_source.is_file():
            if checkpoint:
                try:
                    create_checkpoint(self.vault, f"feed: update decision {item.item_id}")
                except GitCheckpointError as exc:
                    warnings.append(f"写入后 Git 检查点失败：{exc}")
        result = DecisionResult(
            item_id=item.item_id,
            action=action,
            source=str(source) if source else None,
            source_text=str(source_text) if source_text else None,
            study_guide=str(study_guide) if study_guide else None,
            wiki=str(wiki) if wiki else None,
            warnings=tuple(warnings),
        )
        self.store.save(
            item,
            action,
            result=result,
        )
        return result
