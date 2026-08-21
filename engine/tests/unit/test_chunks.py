from __future__ import annotations

from okf_workspace.retrieval.chunks import chunk_markdown


def test_structural_chunks_exclude_frontmatter_and_preserve_fence() -> None:
    fence = chr(96) * 3
    markdown = (
        "---\ntype: Reference\nsecret_index_field: do-not-embed\n---\n"
        "# 网络指南\n\n"
        "## 路由\n\n普通说明。\n\n"
        f"{fence}powershell\n"
        "Get-NetRoute\n\n"
        "Resolve-DnsName example.org\n"
        f"{fence}\n\n"
        "## 同步\n\n同步不等于备份。\n"
    )

    chunks = chunk_markdown(
        "knowledge/wiki/network.md",
        markdown,
        fallback_title="网络指南",
        max_chars=45,
    )

    assert all("secret_index_field" not in chunk.text for chunk in chunks)
    code_chunks = [chunk for chunk in chunks if "Get-NetRoute" in chunk.text]
    assert len(code_chunks) == 1
    assert code_chunks[0].text.count(fence) == 2
    assert any(chunk.heading == "网络指南 > 同步" for chunk in chunks)
    assert all(chunk.start_line <= chunk.end_line for chunk in chunks)


def test_managed_region_without_real_content_is_not_indexed() -> None:
    markdown = (
        "---\ntype: Study Guide\ntitle: Empty notes\ncreated_at: 2026-08-20T12:00:00+08:00\n---\n"
        "# Empty notes\n\n"
        "## 我的笔记\n\n"
        "<!-- human:notes:start -->\n<!-- human:notes:end -->\n\n"
        "## 辅助学习材料\n\n"
        "<!-- ai:auto:start name=\"study-material\" -->\n"
        "真正有用的解释。\n"
        "<!-- ai:auto:end name=\"study-material\" -->\n"
    )

    chunks = chunk_markdown(
        "learning/guides/example.md",
        markdown,
        fallback_title="Empty notes",
    )

    assert len(chunks) == 1
    assert chunks[0].heading == "Empty notes > 辅助学习材料"
    assert "真正有用的解释" in chunks[0].text
