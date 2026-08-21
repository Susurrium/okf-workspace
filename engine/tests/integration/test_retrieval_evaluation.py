from __future__ import annotations

import hashlib
from collections.abc import Sequence
from pathlib import Path
from typing import cast

from okf_workspace.retrieval.evaluation import run_private_evaluation
from okf_workspace.retrieval.vector import Embedder


class FixtureMeaningEmbedder(Embedder):
    @property
    def model_id(self) -> str:
        return "fixture-meaning-v1"

    def embed(self, texts: Sequence[str]) -> list[list[float]]:
        values: list[list[float]] = []
        for text in texts:
            if any(value in text for value in ("备份", "容灾", "LiveSync")):
                values.append([1.0, 0.0])
            elif any(value in text for value in ("VPN", "TUN", "虚拟网卡", "路由")):
                values.append([0.0, 1.0])
            else:
                values.append([0.0, 0.0])
        return values


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def test_private_evaluation_materializes_outside_git_and_scores_cases(
    tmp_path: Path,
) -> None:
    vpn = tmp_path / "vpn.md"
    vpn.write_text(
        "# VPN\n\n校园 VPN 与代理 TUN 会竞争路由，排查虚拟网卡和路由表。\n",
        encoding="utf-8",
    )
    livesync = tmp_path / "livesync.md"
    livesync.write_text(
        "# LiveSync\n\n同步会传播删除，不能代替独立备份和容灾。\n",
        encoding="utf-8",
    )
    manifest = tmp_path / "manifest.yaml"
    manifest.write_text(
        "fixtures:\n"
        "  - id: vpn-guide\n"
        f"    path: {vpn.as_posix()}\n"
        f"    sha256: {digest(vpn)}\n"
        "  - id: livesync-guide\n"
        f"    path: {livesync.as_posix()}\n"
        f"    sha256: {digest(livesync)}\n",
        encoding="utf-8",
    )
    cases = tmp_path / "cases.yaml"
    cases.write_text(
        "cases:\n"
        "  - id: VPN\n"
        "    query: 校园 VPN 为什么和代理 TUN 冲突\n"
        "    must_include: [vpn-guide]\n"
        "  - id: BACKUP\n"
        "    query: 同步能不能代替备份\n"
        "    must_include: [livesync-guide]\n",
        encoding="utf-8",
    )

    report = run_private_evaluation(
        manifest,
        cases,
        embedder=FixtureMeaningEmbedder(),
    )

    evaluations = cast(list[dict[str, object]], report["evaluations"])
    assert [evaluation["mode"] for evaluation in evaluations] == [
        "fts",
        "vector",
        "hybrid",
    ]
    assert all(evaluation["passed"] == 2 for evaluation in evaluations)
    assert all(evaluation["total"] == 2 for evaluation in evaluations)
    assert report["hybrid_not_worse"] is True
