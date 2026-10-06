from __future__ import annotations

import pytest

from okf_workspace.importers.asset_links import referenced_assets, rewrite_asset_links
from okf_workspace.importers.models import ParserExport, ParserName
from okf_workspace.importers.qc import inspect_export


@pytest.mark.parametrize(
    ("markdown", "path", "rewritten"),
    [
        ('![图](images/a.png "title")', "images/a.png", '![图](/sources/assets/a.png "title")'),
        ("![图 [a [b]]](images/a.png)", "images/a.png", "![图 [a [b]]](/sources/assets/a.png)"),
        ("[下载](./images/a.png#detail)", "images/a.png", "[下载](/sources/assets/a.png#detail)"),
        ("![图](images/a%20b.png)", "images/a b.png", "![图](/sources/assets/a.png)"),
        ("![图](<images/a b.png>)", "images/a b.png", "![图](</sources/assets/a.png>)"),
        ("![图](images/a(b(c)).png)", "images/a(b(c)).png", "![图](/sources/assets/a.png)"),
        (r"![图](images/a\(b\).png)", "images/a(b).png", "![图](/sources/assets/a.png)"),
        ("![[images/a.png|300]]", "images/a.png", "![[/sources/assets/a.png|300]]"),
        ("![[a.png|300]]", "images/a.png", "![[/sources/assets/a.png|300]]"),
        ("![图](.hidden.png)", ".hidden.png", "![图](/sources/assets/a.png)"),
        ("[[images/a.png#detail|图]]", "images/a.png", "[[/sources/assets/a.png#detail|图]]"),
        ('<img src="images/a.png" width="300">', "images/a.png",
         '<img src="/sources/assets/a.png" width="300">'),
        ("<img src='images/a.png'>", "images/a.png", "<img src='/sources/assets/a.png'>"),
        ("<img src=images/a.png>", "images/a.png", "<img src=/sources/assets/a.png>"),
        ('<img src="images/a&amp;b.png">', "images/a&b.png", '<img src="/sources/assets/a.png">'),
        ('![图][Figure]\n\n[figure]: images/a.png "标题"', "images/a.png",
         '![图][Figure]\n\n[figure]: /sources/assets/a.png "标题"'),
        ("![图][]\n\n[图]: images/a.png", "images/a.png", "![图][]\n\n[图]: /sources/assets/a.png"),
        ("![图]\n\n[图]: images/a.png", "images/a.png", "![图]\n\n[图]: /sources/assets/a.png"),
    ],
)
def test_supported_links_share_selection_rewriting_and_quality_checks(
    markdown: str, path: str, rewritten: str,
) -> None:
    assets = {path: b"figure", "images/unused.png": b"scratch"}
    assert referenced_assets(markdown, assets) == {path: b"figure"}
    assert rewrite_asset_links(markdown, {path: "/sources/assets/a.png"}) == rewritten
    export = ParserExport(
        markdown="# Document\n\nA useful body with enough readable text.\n\n" + markdown,
        assets=assets, parser=ParserName.MINERU, parser_version="test",
    )
    assert inspect_export(export, strict_assets=True).passed
    missing = ParserExport(
        markdown=export.markdown, assets={}, parser=export.parser, parser_version="test",
    )
    assert not inspect_export(missing, strict_assets=True).passed


def test_unused_definitions_remote_links_and_code_do_not_publish_assets() -> None:
    markdown = (
        "# Example\n\n`![code](images/code.png)`\n\n"
        "```markdown\n![code](images/code.png)\n```\n\n"
        "<!-- ![comment](images/code.png) -->\n\n"
        "[unused]: images/code.png\n\n"
        "![remote](https://example.com/images/code.png)\n"
        "![remote](//example.com/images/code.png)\n"
        "![used][figure]\n\n[figure]: images/used.png\n"
    )
    assets = {"images/code.png": b"unused", "images/used.png": b"used"}
    assert referenced_assets(markdown, assets) == {"images/used.png": b"used"}
    rewritten = rewrite_asset_links(markdown, {"images/used.png": "/sources/assets/图 (1).png"})
    assert "[figure]: /sources/assets/%E5%9B%BE%20%281%29.png" in rewritten
    assert "`![code](images/code.png)`" in rewritten


def test_filtering_does_not_hide_unsafe_unused_paths() -> None:
    with pytest.raises(ValueError, match="unsafe parser output path"):
        referenced_assets("# Document", {"../escape.png": b"unsafe"})
