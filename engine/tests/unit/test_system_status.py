from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import cast

import pytest

from okf_workspace.dashboard.system import system_status


def test_system_status_reports_backup_time_and_actionable_feed_sync(
    vault: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    state = tmp_path / "state"
    backup = state / "backups" / "last-success.json"
    backup.parent.mkdir(parents=True)
    backup.write_text(
        json.dumps({"completed_at": datetime.now(UTC).isoformat()}),
        encoding="utf-8",
    )
    (state / "feed-producers.json").write_text("{}", encoding="utf-8")
    metadata = state / "feed-cache/metadata/ai-daily/2026-08-22-learning.json"
    metadata.parent.mkdir(parents=True)
    metadata.write_text("{}", encoding="utf-8")

    status = system_status(vault, state)
    items = {item["item_id"]: item for item in cast(list[dict[str, object]], status["items"])}

    assert items["backup"]["status"] == "ok"
    assert "最近成功" in str(items["backup"]["detail"])
    assert items["feeds"]["action"] == "立即同步"


def test_system_status_treats_codex_as_primary_and_livesync_as_deferred(
    vault: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    plugin = vault / ".obsidian" / "plugins" / "obsidian-livesync"
    plugin.mkdir(parents=True)
    codex = tmp_path / "codex.cmd"
    codex.write_text("", encoding="utf-8")
    monkeypatch.setenv("OKF_AI_MODE", "codex")
    monkeypatch.setenv("OKF_CODEX_COMMAND", str(codex))
    monkeypatch.delenv("OKF_LIVESYNC_REQUIRED", raising=False)

    status = system_status(vault, tmp_path / "state")
    items = {item["item_id"]: item for item in cast(list[dict[str, object]], status["items"])}

    assert items["livesync"]["status"] == "deferred"
    assert items["livesync"]["action"] is None
    assert items["backup"]["status"] == "deferred"
    assert items["backup"]["action"] is None
    assert items["ai"]["status"] == "configured"
    assert "ChatGPT 订阅" in str(items["ai"]["detail"])


def test_system_status_does_not_treat_nonempty_unconfigured_livesync_as_ready(
    vault: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    plugin = vault / ".obsidian" / "plugins" / "obsidian-livesync"
    plugin.mkdir(parents=True)
    (plugin / "data.json").write_text(
        '{"isConfigured":false,"liveSync":false,"syncOnStart":false}',
        encoding="utf-8",
    )
    codex = tmp_path / "codex.cmd"
    codex.write_text("", encoding="utf-8")
    monkeypatch.setenv("OKF_AI_MODE", "codex")
    monkeypatch.setenv("OKF_CODEX_COMMAND", str(codex))
    monkeypatch.delenv("OKF_LIVESYNC_REQUIRED", raising=False)

    status = system_status(vault, tmp_path / "state")
    items = {item["item_id"]: item for item in cast(list[dict[str, object]], status["items"])}

    assert items["livesync"]["status"] == "deferred"
    assert items["livesync"]["action"] is None


def test_system_status_can_require_livesync_later(
    vault: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    plugin = vault / ".obsidian" / "plugins" / "obsidian-livesync"
    plugin.mkdir(parents=True)
    codex = tmp_path / "codex.cmd"
    codex.write_text("", encoding="utf-8")
    monkeypatch.setenv("OKF_AI_MODE", "codex")
    monkeypatch.setenv("OKF_CODEX_COMMAND", str(codex))
    monkeypatch.setenv("OKF_LIVESYNC_REQUIRED", "true")

    status = system_status(vault, tmp_path / "state")
    items = {item["item_id"]: item for item in cast(list[dict[str, object]], status["items"])}

    assert items["livesync"]["status"] == "not-configured"
    assert "Setup URI" in str(items["livesync"]["action"])


def test_system_status_reports_cloud_token_without_probing_it(
    vault: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    codex = tmp_path / "codex.cmd"
    codex.write_text("", encoding="utf-8")
    monkeypatch.setenv("OKF_AI_MODE", "codex")
    monkeypatch.setenv("OKF_CODEX_COMMAND", str(codex))
    token = tmp_path / "mineru.token"
    token.write_text("fixture-secret", encoding="utf-8")
    monkeypatch.setenv("OKF_MINERU_TOKEN_FILE", str(token))

    status = system_status(vault, tmp_path / "state")
    items = {item["item_id"]: item for item in cast(list[dict[str, object]], status["items"])}

    assert items["mineru"]["status"] == "configured"
    assert "fixture-secret" not in str(items["mineru"])
    assert items["mineru"]["action"] is None


def test_system_status_prompts_only_when_optional_backup_is_enabled(
    vault: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    state = tmp_path / "state"
    config = state / "config" / "deployment.json"
    config.parent.mkdir(parents=True)
    config.write_text(json.dumps({"backup_repository": "X:/backup"}), encoding="utf-8")

    status = system_status(vault, state)
    items = {item["item_id"]: item for item in cast(list[dict[str, object]], status["items"])}

    assert items["backup"]["status"] == "not-configured"
    assert items["backup"]["action"] == "执行首次备份"


def test_system_status_requires_cloud_token_file(
    vault: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("OKF_MINERU_TOKEN_FILE", raising=False)

    status = system_status(vault, tmp_path / "state")
    items = {item["item_id"]: item for item in cast(list[dict[str, object]], status["items"])}

    assert items["mineru"]["status"] == "not-configured"
    assert items["mineru"]["action"] == "请配置 MinerU token 文件"


def test_system_status_refresh_does_not_submit_cloud_tasks(
    vault: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("OKF_MINERU_TOKEN_FILE", raising=False)
    state = tmp_path / "state"

    first = system_status(vault, state)
    refreshed = system_status(vault, state, refresh_services=True)
    assert first["items"] == refreshed["items"]
