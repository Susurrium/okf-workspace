from __future__ import annotations

import pytest

from okf_workspace.notes.organize import (
    HeadingSectionError,
    ManagedRegionError,
    read_heading_section,
    replace_heading_section,
    replace_managed_region,
)


def test_replaces_only_named_managed_region() -> None:
    original = (
        "Before\n"
        '<!-- ai:auto:start name="tasks" -->\nold\n'
        '<!-- ai:auto:end name="tasks" -->\n'
        "After\n"
    )

    updated = replace_managed_region(original, "tasks", "new")

    assert "Before" in updated
    assert "\nnew\n" in updated
    assert "old" not in updated
    assert updated.endswith("After\n")


def test_missing_or_duplicate_region_fails() -> None:
    with pytest.raises(ManagedRegionError):
        replace_managed_region("no region", "tasks", "new")


def test_exact_heading_edit_preserves_other_sections_and_code_fences() -> None:
    original = """# 标题

## 第一节

保持不变。

```markdown
## 第二节
代码中的标题不是目标。
```

## 第二节

原始正文。

### 子标题

仍属于第二节。

## 第三节

也保持不变。
"""

    assert "原始正文" in read_heading_section(original, "第二节")
    updated = replace_heading_section(original, "第二节", "更简洁的正文。")

    assert "保持不变" in updated
    assert "代码中的标题不是目标" in updated
    assert "原始正文" not in updated
    assert "仍属于第二节" not in updated
    assert "更简洁的正文" in updated
    assert "## 第三节" in updated


def test_heading_edit_rejects_missing_or_ambiguous_heading() -> None:
    with pytest.raises(HeadingSectionError):
        replace_heading_section("# A\n", "B", "new")
    with pytest.raises(HeadingSectionError):
        replace_heading_section("# A\n\n## B\n\n## B\n", "B", "new")
