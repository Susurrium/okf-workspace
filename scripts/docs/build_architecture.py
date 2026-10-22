"""Build the offline architecture viewer from reviewed repository-local definitions.

Run from any directory: python scripts/docs/build_architecture.py [--check]
Contracts and docs/architecture/README.md remain the authority; the graph is a view.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import html
import json
import re
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
OUTPUT = ROOT / "docs/architecture/visualizations"
COLORS = {
    "ui": ("#e8f0ff", "#4569bd"),
    "engine": ("#e6f6f1", "#258675"),
    "vault": ("#fff3d9", "#ac7a20"),
    "external": ("#f0eaff", "#825abb"),
    "state": ("#eef1f5", "#637184"),
    "legacy": ("#f5f5f5", "#909090"),
}
FLOW_SOURCES = (
    "engine/src/okf_workspace/notes/captures.py",
    "engine/src/okf_workspace/notes/web_captures.py",
    "engine/src/okf_workspace/importers/pipeline.py",
    "docs/INTERFACES.md#feeds",
    "engine/src/okf_workspace/notes/create.py",
    "docs/INTERFACES.md#bridge",
    "docs/architecture/README.md#data-ownership",
    "docs/DEPLOYMENT.md#sync-backup",
)
KINDS = {
    "root",
    "input",
    "step",
    "choice",
    "parallel",
    "artifact",
    "view",
    "state",
    "exception",
    "uses",
    "generate",
}


def check_source(source: str, root: Path = ROOT) -> Path:
    """Reject stale evidence, out-of-repository paths, and nonexistent anchors."""
    path_text, _, fragment = source.partition("#")
    if not path_text or ":" in path_text or "\\" in path_text:
        raise ValueError(f"Use a repository-relative source: {source}")
    path = (root / path_text).resolve()
    if not path.is_relative_to(root.resolve()) or not path.exists():
        raise ValueError(f"Missing or out-of-repository source: {source}")
    if fragment:
        text = path.read_text(encoding="utf-8")
        headings = re.findall(r"^#{1,6}\s+(.+)$", text, flags=re.MULTILINE)
        anchors = {
            re.sub(r"[^\w\-\s]", "", h.lower()).replace(" ", "-") for h in headings
        }
        anchors.update(re.findall(r'<a\s+id="([^"]+)"', text))
        if fragment not in anchors:
            raise ValueError(f"Missing source anchor: {source}")
    return path


def validate_charts(charts: list[dict[str, Any]]) -> set[str]:
    references: set[str] = set()
    chart_ids: set[str] = set()
    for chart in charts:
        if chart["id"] == "flow" or not re.fullmatch(r"[a-z][a-z0-9_-]*", chart["id"]):
            raise ValueError(f"Invalid chart identifier: {chart['id']}")
        if chart["id"] in chart_ids:
            raise ValueError(f"Duplicate chart: {chart['id']}")
        chart_ids.add(chart["id"])
        ids = [n["id"] for n in chart["nodes"]]
        if len(set(ids)) != len(ids):
            raise ValueError(f"Duplicate node in {chart['id']}")
        for node in chart["nodes"]:
            if not re.fullmatch(r"[a-z][a-z0-9_-]*", node["id"]):
                raise ValueError(f"Invalid node identifier: {node['id']}")
            check_source(node["source"])
            references.add(node["source"])
            if node["kind"] not in COLORS:
                raise ValueError(f"Unknown chart node kind: {node['kind']}")
        for edge in chart["edges"]:
            if edge["a"] not in ids or edge["b"] not in ids:
                raise ValueError(f"Dangling edge in {chart['id']}: {edge}")
    return references


def item(
    kind: str,
    title: str,
    source: str,
    children: list[dict[str, Any]] | None = None,
    path: str = "",
) -> dict[str, Any]:
    return {
        "kind": kind,
        "title": title,
        "source": source,
        "path": path,
        "children": children or [],
    }


def parse_flow(text: str) -> dict[str, Any]:
    stack: list[dict[str, Any]] = []
    tree: dict[str, Any] | None = None
    category = -1
    source = "docs/architecture/README.md"
    for number, raw in enumerate(text.splitlines(), 1):
        if not raw.strip():
            continue
        spaces = len(raw) - len(raw.lstrip(" "))
        depth = spaces // 2
        parts = raw.strip().split("|", 2)
        if spaces % 2 or len(parts) < 2 or depth > len(stack):
            raise ValueError(f"Invalid flow indentation or fields at line {number}")
        if parts[0] not in KINDS:
            raise ValueError(f"Unknown flow kind at line {number}: {parts[0]}")
        if depth == 1:
            category += 1
            if category >= len(FLOW_SOURCES):
                raise ValueError("Flow categories must match FLOW_SOURCES")
            source = FLOW_SOURCES[category]
        node = item(
            parts[0], parts[1], source, path=parts[2] if len(parts) == 3 else ""
        )
        stack = stack[:depth]
        if stack:
            stack[-1]["children"].append(node)
        elif tree is None:
            tree = node
        else:
            raise ValueError("Flow must have exactly one root")
        stack.append(node)
    if tree is None or category + 1 != len(FLOW_SOURCES):
        raise ValueError("Flow must have one root and eight input categories")
    return tree


def generation(title: str) -> list[dict[str, Any]]:
    source = "engine/src/okf_workspace/semantic/worker.py"
    target = "Wiki" if "Wiki" in title else "Study Guide"
    path = (
        "knowledge/wiki/<slug>.md"
        if target == "Wiki"
        else "learning/guides/ 或 learning/courses/<course>/guides/"
    )
    result = f"{target} 已创建 / 更新 → {'知识' if target == 'Wiki' else '学习'}"

    def make(
        kind: str,
        text: str,
        children: list[dict[str, Any]] | None = None,
        location: str = "",
    ) -> dict[str, Any]:
        return item(kind, text, source, children, location)

    return [
        make(
            "choice",
            "用户选择执行方式？",
            [
                make(
                    "step",
                    "交互：Claudian Codex 会话，任务和附件默认预填",
                    [
                        make(
                            "step",
                            "用户发送 → 检索候选 / 读来源 → 按授权与规则执行",
                            [
                                make("artifact", result, location=path),
                                make(
                                    "exception",
                                    "取消 / 报错 / 未完成 → 检查会话并明确继续；保留来源",
                                ),
                            ],
                        ),
                    ],
                ),
                make(
                    "step",
                    "后台：启用语义自动化 → State Operation → 独立 Worker",
                    [
                        make(
                            "step",
                            "检索 → Codex 只读生成 content 与模型报告的 actual_reads",
                            [
                                make(
                                    "choice",
                                    "必读清单 / Contract / 并发检查通过？",
                                    [
                                        make(
                                            "step",
                                            "通过 → Engine 原子创建或更新命名 ai:auto 区域",
                                            [
                                                make("artifact", result, location=path),
                                                make(
                                                    "state",
                                                    "刷新索引和完成通知；索引失败不抹去已保存成果",
                                                ),
                                            ],
                                        ),
                                        make(
                                            "exception",
                                            "失败 / 超时 / 冲突 → State 记原因；保留来源并提供重试",
                                        ),
                                        make(
                                            "exception",
                                            "发布前取消 → 终止检索或生成子进程",
                                        ),
                                    ],
                                ),
                            ],
                        ),
                    ],
                ),
            ],
        ),
        make("view", "后续人工阅读、补充、明确核验；AI 不推断 studied_at"),
    ]


def uses(source: str) -> list[dict[str, Any]]:
    return [
        item("view", "明确暂存 → undecided → 待处理；以后用户判断", source),
        item(
            "choice",
            "学习 → study；何时生成？",
            source,
            [
                item("generate", "现在生成 Study Guide", source),
                item("view", "稍后生成 → 学习待生成；保留资料，不创建空白笔记", source),
            ],
        ),
        item("generate", "长期知识 → wiki → 生成 Wiki", source),
        item("artifact", "参考 → reference；保留资料，不生成学习或知识笔记", source),
    ]


def expand_flow(node: dict[str, Any]) -> None:
    """Copy shared continuations so every branch remains independently readable."""
    if node["title"].startswith("明确归档"):
        options, continuation = node["children"][:5], node["children"][5]
        for option in options:
            option["children"] = [copy.deepcopy(continuation)]
        node["children"] = options
    if node["title"] == "不能，或用户明确要求重新转换":
        choice, execution = node["children"]
        for method in choice["children"]:
            if method["kind"] != "exception":
                method["children"] = [copy.deepcopy(execution)]
        node["children"] = [choice]
    if node["kind"] == "uses":
        node["kind"], node["children"] = "choice", uses(node["source"])
    if node["kind"] == "generate":
        node["kind"], node["children"] = "step", generation(node["title"])
    for child in node["children"]:
        expand_flow(child)


def identify_flow(tree: dict[str, Any]) -> list[dict[str, Any]]:
    flat: list[dict[str, Any]] = []
    objects: set[int] = set()

    def visit(node: dict[str, Any], parent: str | None = None, depth: int = 0) -> None:
        if id(node) in objects:
            raise ValueError("Flow contains a cycle or shared node")
        objects.add(id(node))
        node.update(id=f"n{len(flat) + 1}", parent=parent, depth=depth)
        check_source(node["source"])
        flat.append(node)
        for child in node["children"]:
            visit(child, node["id"], depth + 1)

    visit(tree)
    return flat


def render_svg(chart: dict[str, Any]) -> str:
    esc = html.escape
    output = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {chart["width"]} {chart["height"]}" role="img" aria-label="{esc(chart["title"])}">',
        '<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#68788d"/></marker></defs>',
        '<style>text{font-family:"Microsoft YaHei","Segoe UI",sans-serif}.node{cursor:pointer}.node:hover rect{stroke-width:3}.node-title{font-size:19px;font-weight:650}.node-line{font-size:14px;fill:#46566b}.edge-label{font-size:13px;fill:#4c5f76;paint-order:stroke;stroke:#fff;stroke-width:5px;stroke-linejoin:round}.edge{fill:none;stroke:#68788d;stroke-width:1.8}.dim{opacity:.13}.selected rect{stroke-width:4}</style>',
        '<rect width="100%" height="100%" fill="#ffffff"/>',
    ]
    for g in chart["groups"]:
        fill, stroke = COLORS[g["kind"]]
        output.append(
            f'<rect x="{g["x"]}" y="{g["y"]}" width="{g["w"]}" height="{g["h"]}" rx="18" fill="{fill}" fill-opacity=".3" stroke="{stroke}" stroke-opacity=".24"/>'
        )
        output.append(
            f'<text x="{g["x"] + 20}" y="{g["y"] + 29}" fill="{stroke}" font-size="16" font-weight="650">{esc(g["title"])}</text>'
        )
    nodes = {n["id"]: n for n in chart["nodes"]}
    for e in chart["edges"]:
        a, b = nodes[e["a"]], nodes[e["b"]]
        ax, ay = a["x"] + a["w"] / 2, a["y"] + a["h"] / 2
        bx, by = b["x"] + b["w"] / 2, b["y"] + b["h"] / 2
        side = e.get("side")
        if side in ("top", "bottom") and abs(ax - bx) >= 140:
            y1 = a["y"] if side == "top" else a["y"] + a["h"]
            y2 = b["y"] if side == "top" else b["y"] + b["h"]
            my = min(y1, y2) - 32 if side == "top" else max(y1, y2) + 32
            path = f"M{ax},{y1} C{ax},{my} {bx},{my} {bx},{y2}"
            lx, ly = (ax + bx) / 2, my + (10 if side == "top" else -7)
        elif side in ("left", "right") and abs(ax - bx) < 130:
            x1 = a["x"] if side == "left" else a["x"] + a["w"]
            x2 = b["x"] if side == "left" else b["x"] + b["w"]
            mx = min(x1, x2) - 28 if side == "left" else max(x1, x2) + 28
            path = f"M{x1},{ay} C{mx},{ay} {mx},{by} {x2},{by}"
            lx, ly = mx, (ay + by) / 2
        elif abs(ax - bx) < 140:
            y1 = a["y"] + a["h"] if by > ay else a["y"]
            y2 = b["y"] if by > ay else b["y"] + b["h"]
            my = (y1 + y2) / 2
            path = f"M{ax},{y1} C{ax},{my} {bx},{my} {bx},{y2}"
            lx, ly = (ax + bx) / 2 + 8, my
        else:
            x1 = a["x"] + a["w"] if bx > ax else a["x"]
            x2 = b["x"] if bx > ax else b["x"] + b["w"]
            mx = (x1 + x2) / 2
            path = f"M{x1},{ay} C{mx},{ay} {mx},{by} {x2},{by}"
            lx, ly = mx, (ay + by) / 2 - 7
        dash = ' stroke-dasharray="7 5"' if e["dashed"] else ""
        output.append(
            f'<g class="edge-group" data-a="{e["a"]}" data-b="{e["b"]}"><path class="edge" d="{path}" marker-end="url(#arrow)"{dash}/><text class="edge-label" x="{lx}" y="{ly}" text-anchor="middle">{esc(e["label"])}</text></g>'
        )
    for n in chart["nodes"]:
        fill, stroke = COLORS[n["kind"]]
        title_units = sum(1 if ord(c) > 255 else 0.56 for c in n["title"])
        title_size = min(19, (n["w"] - 34) / max(1, title_units))
        output.append(
            f'<g class="node" data-node="{n["id"]}" tabindex="0" role="button" aria-label="{esc(n["title"])}"><title>{esc(n["detail"])}</title><rect x="{n["x"]}" y="{n["y"]}" width="{n["w"]}" height="{n["h"]}" rx="12" fill="{fill}" stroke="{stroke}" stroke-width="1.6"/><text class="node-title" style="font-size:{title_size:.1f}px" x="{n["x"] + 17}" y="{n["y"] + 31}" fill="{stroke}">{esc(n["title"])}</text>'
        )
        for i, line in enumerate(n["lines"]):
            line_units = sum(1 if ord(c) > 255 else 0.56 for c in line)
            line_size = min(14, (n["w"] - 36) / max(1, line_units))
            output.append(
                f'<text class="node-line" style="font-size:{line_size:.1f}px" x="{n["x"] + 17}" y="{n["y"] + 57 + i * 21}">{esc(line)}</text>'
            )
        output.append("</g>")
    output.append("</svg>")
    return "\n".join(output)


def script_json(value: Any) -> str:
    # Prevent descriptions containing HTML from ending an inline script element.
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).replace(
        "<", "\\u003c"
    )


def source_fingerprint(files: set[Path]) -> str:
    digest = hashlib.sha256()
    for path in sorted(files, key=lambda value: value.relative_to(ROOT).as_posix()):
        digest.update(path.relative_to(ROOT).as_posix().encode("utf-8"))
        if path.is_file():
            # 同一证据在 Windows CRLF 和 LF 检出中使用相同文本字节。
            digest.update(path.read_text(encoding="utf-8").encode("utf-8"))
    return digest.hexdigest()


def build() -> tuple[dict[Path, str], dict[str, Any]]:
    spec_path = HERE / "sources/architecture.json"
    flow_path = HERE / "sources/information-flow.txt"
    template_path = HERE / "viewer.html"
    spec = json.loads(spec_path.read_text(encoding="utf-8"))
    if spec["schema"] != 1:
        raise ValueError("Unsupported visualization schema")
    references = validate_charts(spec["charts"])
    tree = parse_flow(flow_path.read_text(encoding="utf-8"))
    expand_flow(tree)
    flat = identify_flow(tree)
    references.update(n["source"] for n in flat)
    files = {spec_path, flow_path, template_path, Path(__file__).resolve()}
    files.update(check_source(source) for source in references)
    metadata = {key: spec[key] for key in ("reviewed_at", "baseline_commit", "scope")}
    metadata["source_fingerprint"] = source_fingerprint(files)
    payload = {"metadata": metadata, "charts": spec["charts"], "tree": tree}
    images = {c["id"]: render_svg(c) for c in spec["charts"]}
    page = template_path.read_text(encoding="utf-8")
    page = page.replace("__DATA__", script_json(payload)).replace(
        "__SVGS__", script_json(images)
    )
    report = {
        "charts": len(spec["charts"]),
        "chart_nodes": sum(len(c["nodes"]) for c in spec["charts"]),
        "flow_nodes": len(flat),
        "source_references": len(references),
        **metadata,
    }
    return {
        OUTPUT / "index.html": page,
        OUTPUT / "overview.svg": images["overview"] + "\n",
    }, report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="validate sources and generated output without writing",
    )
    args = parser.parse_args()
    try:
        outputs, report = build()
        for path, content in outputs.items():
            if args.check:
                if not path.is_file() or path.read_text(encoding="utf-8") != content:
                    raise ValueError(
                        f"Generated output is stale: {path.relative_to(ROOT)}"
                    )
            else:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(content, encoding="utf-8", newline="\n")
    except (ValueError, KeyError, IndexError, OSError) as exc:
        parser.exit(1, f"Architecture validation failed: {exc}\n")
    print(json.dumps({"check": args.check, **report}, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
