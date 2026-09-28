"""Action-oriented system status; verbose internals stay in logs/doctor."""

from __future__ import annotations

import json
import os
import shutil
from collections.abc import Mapping
from dataclasses import asdict, dataclass
from datetime import UTC, datetime, timedelta
from importlib.metadata import version
from pathlib import Path
from typing import cast

from okf_workspace.feeds import FeedKind
from okf_workspace.governance import scan_governance
from okf_workspace.importers.config import ImportSettings


@dataclass(frozen=True, slots=True)
class SystemItem:
    item_id: str
    label: str
    status: str
    detail: str
    action: str | None = None


def _conversion_failures(state: Path) -> int:
    count = 0
    for path in (state / "conversions").glob("*/status.json"):
        try:
            loaded = cast(object, json.loads(path.read_text(encoding="utf-8")))
        except (OSError, json.JSONDecodeError):
            continue
        if (
            isinstance(loaded, dict)
            and cast(Mapping[object, object], loaded).get("status") == "failed"
        ):
            count += 1
    return count


def _livesync_is_configured(settings_path: Path) -> bool:
    try:
        loaded = cast(object, json.loads(settings_path.read_text(encoding="utf-8")))
    except (OSError, json.JSONDecodeError):
        return False
    if not isinstance(loaded, dict):
        return False
    settings = cast(Mapping[object, object], loaded)
    explicit = settings.get("isConfigured")
    if isinstance(explicit, bool):
        return explicit
    remote_type = settings.get("remoteType")
    database = settings.get("database")
    return isinstance(remote_type, str) and bool(remote_type.strip()) and bool(database)


def _semantic_counts(state: Path) -> tuple[int, int]:
    pending = 0
    failed = 0
    for path in (state / "operations").glob("op-*.json"):
        try:
            loaded = cast(object, json.loads(path.read_text(encoding="utf-8")))
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(loaded, dict):
            continue
        status = cast(Mapping[object, object], loaded).get("status")
        pending += int(status in {"queued", "running", "orphaned"})
        failed += int(status == "failed")
    return pending, failed


def _semantic_worker_available(state: Path) -> bool:
    status_file = state / "semantic-worker.json"
    if not status_file.is_file():
        return False
    try:
        loaded = cast(object, json.loads(status_file.read_text(encoding="utf-8")))
    except (OSError, json.JSONDecodeError):
        return False
    if not isinstance(loaded, dict):
        return False
    heartbeat = cast(Mapping[object, object], loaded).get("heartbeat_at")
    if not isinstance(heartbeat, str):
        return False
    try:
        moment = datetime.fromisoformat(heartbeat).astimezone(UTC)
    except ValueError:
        return False
    return datetime.now(UTC) - moment < timedelta(seconds=45)


def _latest_markdown_mtime(vault: Path) -> float:
    return max((path.stat().st_mtime for path in vault.rglob("*.md")), default=0.0)


def _read_completed_at(path: Path) -> datetime | None:
    if not path.is_file():
        return None
    try:
        loaded = cast(object, json.loads(path.read_text(encoding="utf-8")))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(loaded, dict):
        return None
    value = cast(Mapping[object, object], loaded).get("completed_at")
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value).astimezone(UTC)
    except ValueError:
        return None


def _backup_configured(runtime: Path) -> bool:
    config_path = runtime / "config" / "deployment.json"
    if not config_path.is_file():
        return False
    try:
        loaded = cast(object, json.loads(config_path.read_text(encoding="utf-8")))
    except (OSError, json.JSONDecodeError):
        return False
    if not isinstance(loaded, dict):
        return False
    repository = cast(Mapping[object, object], loaded).get("backup_repository")
    return isinstance(repository, str) and bool(repository.strip())


def system_status(
    vault: Path,
    state: Path,
    *,
    refresh_services: bool = False,
) -> dict[str, object]:
    root = vault.resolve()
    runtime = state.resolve()
    settings = ImportSettings.from_env()
    token_file = settings.mineru_token_file
    token_present = bool(token_file and token_file.is_file() and token_file.stat().st_size)
    mineru = SystemItem(
        "mineru",
        "MinerU 云解析",
        "configured" if token_present else "not-configured",
        (
            f"已配置本机 token 文件；模型：{settings.mineru_model}。连接状态由解析任务验证。"
            if token_present else "尚未配置 MinerU token 文件，文档导入无法开始。"
        ),
        None if token_present else "配置本机 MinerU token 文件",
    )
    items = [mineru]
    ai_mode = os.environ.get("OKF_AI_MODE", "codex").strip().casefold()
    if ai_mode == "codex":
        configured_command = os.environ.get("OKF_CODEX_COMMAND", "").strip()
        command = configured_command or shutil.which("codex.cmd" if os.name == "nt" else "codex")
        codex_ready = bool(command and (not configured_command or Path(command).is_file()))
        codex_model = os.environ.get("OKF_CODEX_MODEL", "").strip()
        items.append(
            SystemItem(
                "ai",
                "本机 Codex",
                "configured" if codex_ready else "unavailable",
                (
                    "使用 ChatGPT 订阅登录态"
                    + (f"；模型：{codex_model}" if codex_model else "；使用 Codex 默认模型")
                    if codex_ready
                    else "未找到 Codex 命令"
                ),
                None if codex_ready else "安装 Codex 并使用 ChatGPT 登录",
            )
        )
    else:
        ai_base_url = os.environ.get("OKF_AI_BASE_URL", "").strip()
        ai_model = os.environ.get("OKF_AI_MODEL", "").strip()
        ai_key_file = os.environ.get("OKF_AI_API_KEY_FILE", "").strip()
        ai_key_ready = not ai_key_file or Path(ai_key_file).is_file()
        ai_ready = bool(ai_base_url and ai_model and ai_key_ready)
        items.append(
            SystemItem(
                "ai",
                "其他 AI 服务 (可选)",
                "configured" if ai_ready else "not-configured",
                f"已配置模型：{ai_model}" if ai_ready else "尚未配置可调用的模型",
                None if ai_ready else "配置 AI 服务地址、模型和凭据文件",
            )
        )
    index = runtime / "brain.sqlite"
    needs_index = not index.is_file() or index.stat().st_mtime < _latest_markdown_mtime(root)
    items.append(
        SystemItem(
            "index",
            "全文索引",
            "stale" if needs_index else "current",
            "需要重建" if needs_index else "已是最新",
            "重建索引" if needs_index else None,
        )
    )
    pending_semantics, failed_semantics = _semantic_counts(runtime)
    semantic_worker_ready = _semantic_worker_available(runtime)
    semantic_status = (
        "failed"
        if failed_semantics
        else "unavailable"
        if pending_semantics and not semantic_worker_ready
        else "running"
        if pending_semantics
        else "ok"
    )
    items.append(
        SystemItem(
            "semantic-operations",
            "后台生成",
            semantic_status,
            (
                f"{failed_semantics} 个失败，{pending_semantics} 个运行或排队"
                if failed_semantics
                else (
                    "后台处理服务未运行，已排队任务仍然保留"
                    if pending_semantics and not semantic_worker_ready
                    else (
                        f"{pending_semantics} 个运行或排队" if pending_semantics else "没有失败任务"
                    )
                )
            ),
            "查看并重试"
            if failed_semantics
            else "重新打开 Obsidian 以启动后台处理"
            if pending_semantics and not semantic_worker_ready
            else None,
        )
    )
    governance = scan_governance(root)
    items.append(
        SystemItem(
            "governance",
            "笔记与链接检查",
            "warning" if governance else "ok",
            (
                f"{len(governance)} 个需要检查的问题"
                if governance
                else "标签、知识笔记状态和内部链接正常"
            ),
            "查看检查结果" if governance else None,
        )
    )
    failures = _conversion_failures(runtime)
    items.append(
        SystemItem(
            "conversions",
            "文档转换",
            "failed" if failures else "ok",
            f"{failures} 个失败转换" if failures else "没有失败转换",
            "查看并重试" if failures else None,
        )
    )
    livesync = root / ".obsidian" / "plugins" / "obsidian-livesync"
    livesync_settings = livesync / "data.json"
    livesync_required = os.environ.get("OKF_LIVESYNC_REQUIRED", "false").casefold() in {
        "1",
        "true",
        "yes",
        "on",
    }
    livesync_configured = _livesync_is_configured(livesync_settings)
    if not livesync_required and not livesync_configured:
        livesync_status = "deferred"
        livesync_detail = "未启用，当前设备仍可正常使用"
        livesync_action = None
    elif not livesync.is_dir():
        livesync_status = "not-installed"
        livesync_detail = "插件尚未安装"
        livesync_action = "安装并配置 LiveSync"
    elif not livesync_configured:
        livesync_status = "not-configured"
        livesync_detail = "插件已安装，尚未导入本 Vault 的 Setup URI"
        livesync_action = "使用自己的 Setup URI 配对"
    else:
        livesync_status = "configured"
        livesync_detail = "远端配置已保存；实时连接状态请以 LiveSync 图标为准"
        livesync_action = None
    items.append(
        SystemItem(
            "livesync",
            "多设备同步 (LiveSync)",
            livesync_status,
            livesync_detail,
            livesync_action,
        )
    )
    backup_marker = runtime / "backups" / "last-success.json"
    backup_at = _read_completed_at(backup_marker)
    backup_configured = _backup_configured(runtime)
    backup_stale = backup_at is not None and (datetime.now(UTC) - backup_at).days >= 2
    backup_status = (
        "stale"
        if backup_stale
        else ("ok" if backup_at else ("not-configured" if backup_configured else "deferred"))
    )
    items.append(
        SystemItem(
            "backup",
            "可选外部备份",
            backup_status,
            (
                f"最近成功：{backup_at.astimezone().isoformat(timespec='minutes')}"
                if backup_at
                else (
                    "已配置，尚无成功备份记录"
                    if backup_configured
                    else "当前未启用；需要时再配置"
                )
            ),
            (
                "检查并执行备份"
                if backup_stale
                else ("执行首次备份" if backup_configured and not backup_at else None)
            ),
        )
    )
    producer_config = runtime / "feed-producers.json"
    feed_cache = runtime / "feed-cache"
    feed_files = [
        path
        for feed in FeedKind
        for path in (feed_cache / feed.value).glob("*.json")
    ]
    latest_feed = max((path.stat().st_mtime for path in feed_files), default=0.0)
    latest_feed_at = datetime.fromtimestamp(latest_feed, UTC) if latest_feed else None
    feed_stale = latest_feed_at is None or (datetime.now(UTC) - latest_feed_at).days >= 2
    items.append(
        SystemItem(
            "feeds",
            "每日资讯与树洞订阅",
            "not-configured"
            if not producer_config.is_file()
            else ("stale" if feed_stale else "ok"),
            (
                "尚未连接订阅服务"
                if not producer_config.is_file()
                else (
                    f"最近更新：{latest_feed_at.astimezone().isoformat(timespec='minutes')}"
                    if latest_feed_at
                    else "尚未完成首次同步"
                )
            ),
            "配置订阅服务"
            if not producer_config.is_file()
            else ("立即同步" if feed_stale else None),
        )
    )
    return {
        "checked_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "version": version("okf-workspace-engine"),
        "items": [asdict(item) for item in items],
        "actionable": [asdict(item) for item in items if item.action],
    }
