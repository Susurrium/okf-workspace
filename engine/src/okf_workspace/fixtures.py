"""Generate the deterministic, privacy-safe test Vault from the specification."""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from okf_workspace.notes import NoteService
from okf_workspace.okf.frontmatter import OkfDocument, read_document, write_document
from okf_workspace.okf.templates import initialize_vault
from okf_workspace.okf.validator import validate_bundle
from okf_workspace.projections.navigation import rebuild_root_index

FIXED_MOMENT = datetime(2026, 8, 17, 9, 30, tzinfo=timezone(timedelta(hours=8)))


def _clock() -> datetime:
    return FIXED_MOMENT


def _set_fields(path: Path, **fields: object) -> None:
    document = read_document(path)
    document.frontmatter.update(fields)
    write_document(path, document)


def _write_concept(
    path: Path,
    *,
    note_type: str,
    title: str,
    body: str,
    fields: dict[str, object] | None = None,
) -> None:
    frontmatter: dict[str, object] = {
        "type": note_type,
        "title": title,
        "created_at": FIXED_MOMENT.isoformat(),
    }
    if fields:
        frontmatter.update(fields)
    write_document(path, OkfDocument(frontmatter=frontmatter, body=body), create_only=True)


def generate_fixture_vault(output: Path) -> Path:
    vault = initialize_vault(output)
    notes = NoteService(vault, clock=_clock)

    daily = notes.create_daily(FIXED_MOMENT.date())
    daily_document = read_document(daily)
    daily_document.body = daily_document.body.replace(
        "## 任务\n",
        "## 任务\n\n- [ ] #task 完成确定性测试\n",
    )
    write_document(daily, daily_document)

    notes.create_capture("模糊想法", "或许应该把一个想法放到某个项目里，但现在还不确定。")
    notes.create_reflection("长期系统", "长期系统应当降低日常摩擦，而不是增加状态维护。")
    notes.create_course("medical-statistics", "医学统计学")
    lesson = notes.create_lesson(
        "medical-statistics",
        "回归分析",
        lesson_date=FIXED_MOMENT.date(),
    )
    lesson_document = read_document(lesson)
    lesson_document.body = lesson_document.body.replace(
        "<!-- human:notes:start -->\n",
        "<!-- human:notes:start -->\n回归？混杂；老师说某个条件，待确认。\n",
    )
    write_document(lesson, lesson_document)

    notes.create_project("workspace", "个人知识工作区")
    notes.append_project_log("workspace", "创建了合成测试 Vault。")
    _write_concept(
        vault / "projects" / "workspace" / "decisions" / "2026-08-17-okf-first.md",
        note_type="Decision",
        title="采用 OKF 作为知识主体",
        body="# 采用 OKF 作为知识主体\n\n决定使用可读 Markdown 与稳定链接。\n",
        fields={
            "project": "/projects/workspace/project.md",
            "decided_at": FIXED_MOMENT.isoformat(),
        },
    )

    draft = notes.create_wiki("草稿 Wiki", "这是一篇尚未确认的草稿。")
    _set_fields(draft, status="draft")
    notes.create_wiki("稳定 Wiki", "这是一篇结构稳定但尚未学习的知识。")
    deprecated = notes.create_wiki("废弃 Wiki", "该内容只为旧链接保留。")
    _set_fields(deprecated, status="deprecated")
    notes.create_wiki(
        "已学习 Wiki",
        "用户明确确认自己已经学习。",
        studied_at=FIXED_MOMENT,
    )

    notes.create_wiki(
        "即将过期的 Wiki",
        "该知识用于验证 stale_after 提醒。",
        stale_after=date(2026, 8, 18),
    )

    source_record = vault / "sources" / "records" / "documents" / "sample-source.md"
    _write_concept(
        source_record,
        note_type="Source",
        title="示例来源",
        body=(
            "# 示例来源\n\n## 正文入口\n\n[完整正文](/sources/text/documents/sample-source.md)\n"
        ),
        fields={
            "resource": "https://example.test/sample.pdf",
            "kind": "document",
            "text": "/sources/text/documents/sample-source.md",
            "uses": [{"purpose": "reference"}],
            "ingested_via": "file-import",
        },
    )
    _write_concept(
        vault / "sources" / "text" / "documents" / "sample-source.md",
        note_type="Source Text",
        title="示例来源 - 完整正文",
        body="# 完整正文\n\n这是转换得到的完整 Markdown。\n",
        fields={
            "parser": "fixture",
            "sources": [
                {
                    "resource": "/sources/records/documents/sample-source.md",
                }
            ],
        },
    )

    fence = chr(96) * 3
    _write_concept(
        vault / "knowledge" / "wiki" / "long-technical-note.md",
        note_type="Wiki",
        title="中英混合长技术文档",
        body=(
            "# 中英混合长技术文档\n\n"
            "## Network routing\n\n"
            "路由冲突可能来自多个虚拟网卡。\n\n"
            "| 项目 | 结果 |\n|---|---|\n| TUN | 只能启用一个 |\n\n"
            f"{fence}powershell\nResolve-DnsName example.org\n{fence}\n\n"
            "> [!warning]\n> 同步不等于备份。\n"
        ),
        fields={
            "description": "Long mixed-language technical fixture.",
            "sources": [],
        },
    )
    _write_concept(
        vault / "knowledge" / "wiki" / "conflict-a.md",
        note_type="Wiki",
        title="冲突样本 A",
        body="# 冲突样本 A\n\n测试环境应启用功能 X。\n",
        fields={
            "description": "Conflict detection fixture B.",
            "sources": [],
        },
    )
    _write_concept(
        vault / "knowledge" / "wiki" / "conflict-b.md",
        note_type="Wiki",
        title="冲突样本 B",
        body="# 冲突样本 B\n\n测试环境不应启用功能 X。\n",
        fields={
            "description": "Fixture proving that retrieval reads the real Vault.",
            "sources": [],
        },
    )
    _write_concept(
        vault / "knowledge" / "wiki" / "nonce-note.md",
        note_type="Wiki",
        title="Nonce Note",
        body="# Nonce Note\n\n当前 nonce：FIXTURE-NONCE-20260817。\n",
        fields={
            "description": "Conflict detection fixture A.",
            "sources": [],
        },
    )

    private = vault / "self" / "profile.md"
    private_document = read_document(private)
    private_document.body += "\n## 测试私密信息\n\nPRIVATE-FIXTURE-SHOULD-NOT-LEAK\n"
    write_document(private, private_document)

    rebuild_root_index(vault)
    report = validate_bundle(vault)
    if not report.valid:
        detail = "; ".join(f"{issue.path}: {issue.message}" for issue in report.errors)
        raise RuntimeError(f"generated fixture Vault is invalid: {detail}")
    assert draft.is_file()
    return vault
