"""Lightweight mechanical checks for long-lived Vault integrity."""

from __future__ import annotations

from collections import Counter
from collections.abc import Mapping
from dataclasses import asdict, dataclass
from datetime import date, datetime
from pathlib import Path
from typing import cast

from okf_workspace.okf.frontmatter import FrontmatterError, OkfDocument, read_document
from okf_workspace.retrieval.links import extract_links


@dataclass(frozen=True, slots=True)
class GovernanceIssue:
    code: str
    path: str
    detail: str
    severity: str = "warning"


def scan_governance(vault: Path) -> list[GovernanceIssue]:
    root = vault.resolve()
    documents: list[tuple[str, OkfDocument]] = []
    issues: list[GovernanceIssue] = []
    for path in sorted(root.rglob("*.md")):
        relative = path.relative_to(root).as_posix()
        if any(part in {".git", ".obsidian", ".trash"} for part in path.relative_to(root).parts):
            continue
        if path.name in {"index.md", "log.md"}:
            continue
        try:
            document = read_document(path)
        except (FrontmatterError, OSError):
            continue
        documents.append((relative, document))
        legacy_types = {
            "Knowledge Concept",
            "Reference",
            "Knowledge Map",
            "Learning Note",
            "Class Note",
            "Source Extract",
            "Daily Note",
            "Project Decision",
            "Feed Edition",
            "Personal Context",
        }
        if document.type in legacy_types:
            issues.append(
                GovernanceIssue(
                    "legacy-knowledge-type",
                    relative,
                    f"{document.type} 已废弃，应迁移为 OKF Profile 3 的对应类型",
                    "error",
                )
            )
        if document.frontmatter.get("status") == "stable":
            issues.append(
                GovernanceIssue(
                    "redundant-stable-status",
                    relative,
                    "status 缺省即 stable；请移除冗余的 status: stable",
                )
            )
        generated = document.frontmatter.get("generated")
        if generated is not None and document.type != "Wiki":
            issues.append(
                GovernanceIssue(
                    "generated-on-non-wiki",
                    relative,
                    "Profile v3 只在无人审阅的后台长期 Wiki 上使用 generated",
                    "error",
                )
            )
        if document.type == "Wiki":
            required_text = ("title", "description", "created_at")
            for field in required_text:
                value = document.frontmatter.get(field)
                if not isinstance(value, (str, date, datetime)) or not str(value).strip():
                    issues.append(
                        GovernanceIssue(
                            "wiki-missing-field",
                            relative,
                            f"Wiki 需要非空字段：{field}",
                        )
                    )
            studied_at = document.frontmatter.get("studied_at")
            if studied_at is not None and not isinstance(studied_at, (str, date, datetime)):
                issues.append(
                    GovernanceIssue(
                        "wiki-studied-at",
                        relative,
                        "studied_at 只记录用户明确完成本轮学习的时间",
                    )
                )
            if not relative.startswith("knowledge/wiki/"):
                issues.append(
                    GovernanceIssue(
                        "wiki-path",
                        relative,
                        "Wiki 应位于 knowledge/wiki/",
                    )
                )
            aliases = document.frontmatter.get("aliases")
            if aliases is not None and (
                not isinstance(aliases, list)
                or not all(isinstance(item, str) for item in cast(list[object], aliases))
            ):
                issues.append(
                    GovernanceIssue("wiki-aliases", relative, "Wiki aliases 必须是字符串列表")
                )
            sources = document.frontmatter.get("sources")
            if sources is not None and not isinstance(sources, list):
                issues.append(
                    GovernanceIssue("wiki-sources", relative, "Wiki sources 必须是来源列表")
                )
            if generated is not None and not isinstance(generated, dict):
                issues.append(
                    GovernanceIssue(
                        "wiki-generated",
                        relative,
                        "generated 只记录真实生成者与时间，必须是映射",
                    )
                )
            if (
                isinstance(generated, Mapping)
                and cast(Mapping[object, object], generated).get("by")
                != "process:codex-background"
            ):
                issues.append(
                    GovernanceIssue(
                        "wiki-generated-actor",
                        relative,
                        "后台 Wiki 的 generated.by 必须是 process:codex-background",
                        "error",
                    )
                )
            if generated is not None and not sources:
                issues.append(
                    GovernanceIssue(
                        "generated-without-sources",
                        relative,
                        "无人审阅的自动生成 Wiki 必须保留真实 sources",
                    )
                )
        for field in ("tags", "topics"):
            value = document.frontmatter.get(field)
            valid = value is None
            if isinstance(value, list):
                valid = all(isinstance(item, str) for item in cast(list[object], value))
            if not valid:
                issues.append(
                    GovernanceIssue("invalid-tags", relative, f"{field} 必须是字符串列表")
                )
            if field == "tags" and isinstance(value, list):
                tags = cast(list[object], value)
                redundant = {
                    str(item)
                    for item in tags
                    if isinstance(item, str)
                    and item.casefold()
                    in {"wiki", "reference", "learned", "unlearned", "studied", "unstudied"}
                }
                if redundant:
                    issues.append(
                        GovernanceIssue(
                            "state-as-tag",
                            relative,
                            "状态不应写入 tags：" + "、".join(sorted(redundant)),
                        )
                    )
        for target, relation in extract_links(
            document.body,
            source_path=relative,
            frontmatter=document.frontmatter,
        ):
            if relation == "wiki":
                continue
            if not (root / target).is_file():
                issues.append(
                    GovernanceIssue("broken-link", relative, f"{relation} 目标不存在：{target}")
                )
    wiki_titles = [
        str(document.frontmatter.get("title", "")).strip().casefold()
        for _relative, document in documents
        if document.type == "Wiki"
    ]
    duplicate_titles = {
        title for title, count in Counter(wiki_titles).items() if title and count > 1
    }
    for relative, document in documents:
        title = str(document.frontmatter.get("title", "")).strip().casefold()
        if document.type == "Wiki" and title in duplicate_titles:
            issues.append(
                GovernanceIssue("duplicate-wiki-title", relative, "存在同名 Wiki，建议合并或改名")
            )
    return issues


def governance_report(vault: Path) -> dict[str, object]:
    issues = scan_governance(vault)
    return {
        "issue_count": len(issues),
        "issues": [asdict(issue) for issue in issues],
    }
