"""Exercise the actual Apex serializer and presets against Engine file policies."""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path
from typing import cast

from okf_workspace.config import default_template_root
from okf_workspace.deployment.restore import verify_restored_data
from okf_workspace.migration import migrate_current_layout
from okf_workspace.okf.templates import initialize_vault
from okf_workspace.okf.validator import validate_bundle
from okf_workspace.projections.tasks import collect_tasks
from okf_workspace.retrieval.context import ContextReader
from okf_workspace.retrieval.index import SearchIndex
from okf_workspace.retrieval.search import HybridSearcher

ROOT = Path(__file__).parents[2]


def test_apex_generated_workbenches_survive_engine_lifecycle(tmp_path: Path) -> None:
    node = shutil.which("node")
    assert node is not None, "Root checks require Node for cross-component serializer verification"
    entry = """
import { generateDefaultMarkdown, parse, serialize } from './apex/src/parser.ts';
import {
  WORKBENCH_PRESETS, generateWorkbenchPresetMarkdown,
} from './src/features/workbench-presets.ts';
const defaultBoard = parse(generateDefaultMarkdown());
defaultBoard.bodyPreamble = 'ApexMemoNonce: a user-owned workbench memo.';
console.log(JSON.stringify([
  serialize(defaultBoard),
  ...WORKBENCH_PRESETS.map(preset => generateWorkbenchPresetMarkdown(preset.id)),
]));
"""
    script = """
const esbuild = require('esbuild');
esbuild.build({
  stdin: { contents: process.argv[1], resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent',
  alias: { obsidian: './apex/scripts/obsidian-stub.ts' },
}).then(result => eval(result.outputFiles[0].text));
"""
    result = subprocess.run(
        [node, "-e", script, entry],
        cwd=ROOT / "dashboard",
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=60,
    )
    assert result.returncode == 0, result.stderr
    boards = cast(list[str], json.loads(result.stdout))
    assert len(boards) == 7
    vault = initialize_vault(tmp_path / "vault")
    snapshots: dict[str, bytes] = {}
    for index, board in enumerate(boards):
        relative = f"workbenches/工作台-{index}.md"
        path = vault / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        text = board + "\n- [ ] #task CrossComponentNonce ^task-cross-component\n"
        path.write_text(text, encoding="utf-8")
        snapshots[relative] = path.read_bytes()
    backup = vault / ".dashboard-backup/old.md"
    backup.parent.mkdir(parents=True)
    backup.write_bytes(snapshots["workbenches/工作台-0.md"])
    assert validate_bundle(vault).valid
    migrate_current_layout(vault, default_template_root())
    assert {relative: (vault / relative).read_bytes() for relative in snapshots} == snapshots
    tasks = collect_tasks(vault)
    assert len([task for task in tasks if task.text == "CrossComponentNonce"]) == 7
    index = SearchIndex(vault, tmp_path / "state/search.sqlite")
    index.sync()
    assert not HybridSearcher(index).search("ApexMemoNonce", scope="all", refresh_index=False)
    path = "workbenches/工作台-0.md"
    hits = HybridSearcher(index).search("ApexMemoNonce", explicit_paths=(path,), scope="all")
    assert any("ApexMemoNonce" in item.actual_text for item in ContextReader(index).read(hits))
    assert verify_restored_data(vault, tmp_path / "originals").valid
