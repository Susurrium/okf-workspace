"""AI providers for a ChatGPT-authenticated local Codex or an optional API."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import urllib.error
import urllib.request
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol, cast


class ChatProvider(Protocol):
    def complete(self, *, system: str, user: str) -> str: ...


@dataclass(frozen=True, slots=True)
class CodexSettings:
    command: str
    working_directory: Path
    model: str = ""
    timeout_seconds: float = 300.0

    @classmethod
    def from_env(cls) -> CodexSettings:
        configured = os.environ.get("OKF_CODEX_COMMAND", "").strip()
        command = configured or shutil.which("codex.cmd" if os.name == "nt" else "codex")
        if not command:
            raise RuntimeError(
                "Codex is not available; install Codex and sign in with ChatGPT, "
                "or configure an API provider"
            )
        state = Path(os.environ.get("OKF_BRAIN_STATE", ".")).resolve()
        workdir = Path(os.environ.get("OKF_CODEX_WORKDIR", str(state / "codex-runtime"))).resolve()
        timeout = float(os.environ.get("OKF_CODEX_TIMEOUT_SECONDS", "300"))
        return cls(
            command=command,
            working_directory=workdir,
            model=os.environ.get("OKF_CODEX_MODEL", "").strip(),
            timeout_seconds=timeout,
        )


class CodexExecProvider:
    """Use the local Codex client's ChatGPT subscription in non-interactive mode."""

    def __init__(self, settings: CodexSettings) -> None:
        self.settings = settings

    def complete(self, *, system: str, user: str) -> str:
        self.settings.working_directory.mkdir(parents=True, exist_ok=True)
        prompt = (
            "你正在执行一次隔离的文本生成任务。不要调用工具、不要读取磁盘、不要修改文件；"
            "只根据下方明确提供的内容作答。只输出最终结果，不要描述执行过程。\n\n"
            f"系统要求：\n{system.strip()}\n\n用户输入：\n{user.strip()}"
        )
        command = [
            self.settings.command,
            "exec",
            "--ephemeral",
            "--ignore-user-config",
            "--sandbox",
            "read-only",
            "--skip-git-repo-check",
            "--color",
            "never",
            "--cd",
            str(self.settings.working_directory),
        ]
        if self.settings.model:
            command.extend(("--model", self.settings.model))
        command.append("-")
        try:
            completed = subprocess.run(
                command,
                input=prompt,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=self.settings.timeout_seconds,
                check=False,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise RuntimeError(f"Codex request failed: {exc}") from exc
        content = completed.stdout.strip()
        if completed.returncode != 0:
            detail = completed.stderr.strip()[-800:] or "unknown Codex error"
            raise RuntimeError(f"Codex request failed: {detail}")
        if not content:
            raise RuntimeError("Codex response content is empty")
        return content


@dataclass(frozen=True, slots=True)
class AISettings:
    base_url: str
    model: str
    api_key: str
    timeout_seconds: float = 120.0

    @classmethod
    def from_env(cls) -> AISettings:
        base_url = os.environ.get("OKF_AI_BASE_URL", "").strip()
        model = os.environ.get("OKF_AI_MODEL", "").strip()
        api_key = os.environ.get("OKF_AI_API_KEY", "").strip()
        api_key_file = os.environ.get("OKF_AI_API_KEY_FILE", "").strip()
        if not api_key and api_key_file:
            try:
                api_key = Path(api_key_file).read_text(encoding="utf-8").strip()
            except OSError as exc:
                raise RuntimeError("AI API key file is unavailable") from exc
        if not base_url or not model:
            raise RuntimeError(
                "AI is not configured; set OKF_AI_BASE_URL and OKF_AI_MODEL "
                "(plus OKF_AI_API_KEY_FILE when required)"
            )
        return cls(base_url=base_url, model=model, api_key=api_key)

    @property
    def chat_completions_url(self) -> str:
        base = self.base_url.rstrip("/")
        return base if base.endswith("/chat/completions") else f"{base}/chat/completions"


class OpenAICompatibleProvider:
    def __init__(self, settings: AISettings) -> None:
        self.settings = settings

    def complete(self, *, system: str, user: str) -> str:
        payload = json.dumps(
            {
                "model": self.settings.model,
                "temperature": 0.2,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
            },
            ensure_ascii=False,
        ).encode("utf-8")
        headers = {"Content-Type": "application/json"}
        if self.settings.api_key:
            headers["Authorization"] = f"Bearer {self.settings.api_key}"
        request = urllib.request.Request(
            self.settings.chat_completions_url,
            data=payload,
            headers=headers,
            method="POST",
        )
        try:
            with urllib.request.urlopen(
                request,
                timeout=self.settings.timeout_seconds,
            ) as response:
                raw = response.read().decode("utf-8")
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as exc:
            raise RuntimeError(f"AI request failed: {exc}") from exc
        decoded_object = cast(object, json.loads(raw))
        if not isinstance(decoded_object, dict):
            raise RuntimeError("AI response is not a JSON object")
        decoded = cast(Mapping[str, object], decoded_object)
        choices = decoded.get("choices")
        if not isinstance(choices, list) or not choices:
            raise RuntimeError("AI response contains no choices")
        first = cast(list[object], choices)[0]
        if not isinstance(first, dict):
            raise RuntimeError("AI response choice is malformed")
        first_mapping = cast(Mapping[str, object], first)
        message = first_mapping.get("message")
        if not isinstance(message, dict):
            raise RuntimeError("AI response message is malformed")
        message_mapping = cast(Mapping[str, object], message)
        content = message_mapping.get("content")
        if not isinstance(content, str) or not content.strip():
            raise RuntimeError("AI response content is empty")
        return content.strip()


def provider_from_env() -> ChatProvider:
    """Select the explicit deployment mode; local Codex is the default."""

    mode = os.environ.get("OKF_AI_MODE", "codex").strip().casefold()
    if mode == "codex":
        return CodexExecProvider(CodexSettings.from_env())
    if mode == "provider":
        return OpenAICompatibleProvider(AISettings.from_env())
    raise RuntimeError("OKF_AI_MODE must be either 'codex' or 'provider'")
