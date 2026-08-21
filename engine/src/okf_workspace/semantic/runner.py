"""Run a read-only Codex agent and capture one structured semantic result."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from collections.abc import Callable, Mapping
from contextlib import suppress
from pathlib import Path
from typing import Protocol, cast, runtime_checkable

from okf_workspace.ai.provider import CodexSettings
from okf_workspace.okf.paths import resolve_bundle_path
from okf_workspace.retrieval.context import ContextReader
from okf_workspace.retrieval.index import SearchIndex
from okf_workspace.retrieval.search import HybridSearcher
from okf_workspace.retrieval.vector import FastEmbedder, VectorIndex

from .models import SemanticKind, SemanticOutput, SemanticRequest, SemanticStage

CancelCheck = Callable[[], bool]
StageCallback = Callable[[SemanticStage, str], None]


class SemanticCancelled(RuntimeError):
    """Raised after a requested cancellation has stopped child work."""


class SemanticTimedOut(RuntimeError):
    """Raised after a child process is stopped at a bounded deadline."""


class SemanticRunner(Protocol):
    def generate(self, request: SemanticRequest) -> SemanticOutput: ...


@runtime_checkable
class ControllableSemanticRunner(Protocol):
    def generate_controlled(
        self,
        request: SemanticRequest,
        *,
        should_cancel: CancelCheck,
        on_stage: StageCallback,
    ) -> SemanticOutput: ...


def _seconds_from_env(name: str, fallback: float) -> float:
    value = os.environ.get(name, "").strip()
    if not value:
        return fallback
    try:
        parsed = float(value)
    except ValueError:
        return fallback
    return parsed if parsed > 0 else fallback


class CodexSemanticRunner:
    def __init__(self, vault: Path, state: Path, settings: CodexSettings) -> None:
        self.vault = vault.resolve()
        self.state = state.resolve()
        self.settings = settings
        self.total_timeout_seconds = _seconds_from_env(
            "OKF_SEMANTIC_TIMEOUT_SECONDS",
            max(settings.timeout_seconds, 600.0),
        )
        self.retrieval_timeout_seconds = _seconds_from_env(
            "OKF_SEMANTIC_RETRIEVAL_TIMEOUT_SECONDS",
            12.0,
        )
        # The direct diagnostic path keeps these warm. Production generation
        # uses a short-lived retrieval child so it can be stopped safely.
        self._vector_index: VectorIndex | None = None
        self._embedder: FastEmbedder | None = None

    def _candidate_paths(self, request: SemanticRequest) -> tuple[str, ...]:
        """Direct retrieval path retained for diagnostics and focused tests."""

        index = SearchIndex(self.vault, self.state / "brain.sqlite")
        index.sync()
        searcher = HybridSearcher(index)
        vector_database = self.state / "vectors.sqlite"
        if vector_database.is_file():
            try:
                if self._vector_index is None:
                    self._vector_index = VectorIndex(vector_database)
                if self._embedder is None:
                    self._embedder = FastEmbedder()
                searcher = HybridSearcher(
                    index,
                    vector_index=self._vector_index,
                    embedder=self._embedder,
                )
            except RuntimeError:
                pass
        hits = searcher.search(
            self._query(request),
            scope="learning",
            explicit_paths=request.sources,
            limit=8,
            refresh_index=False,
        )
        contexts = ContextReader(index).read(hits, limit=6)
        return tuple(dict.fromkeys(item.path for item in contexts))

    def generate(self, request: SemanticRequest) -> SemanticOutput:
        return self.generate_controlled(
            request,
            should_cancel=lambda: False,
            on_stage=lambda _stage, _detail: None,
        )

    def generate_controlled(
        self,
        request: SemanticRequest,
        *,
        should_cancel: CancelCheck,
        on_stage: StageCallback,
    ) -> SemanticOutput:
        target = resolve_bundle_path(self.vault, request.target)
        target_exists = target.is_file()
        sources = tuple(
            path for path in request.sources if resolve_bundle_path(self.vault, path).is_file()
        )
        operation_root = self.state / "operations" / request.operation_id
        operation_root.mkdir(parents=True, exist_ok=True)
        deadline = time.monotonic() + self.total_timeout_seconds

        on_stage(SemanticStage.RETRIEVING, "正在检索相关笔记")
        candidates = self._bounded_candidate_paths(
            request,
            operation_root,
            deadline=deadline,
            should_cancel=should_cancel,
            on_stage=on_stage,
        )
        if should_cancel():
            raise SemanticCancelled("semantic operation cancelled")

        schema = operation_root / "output-schema.json"
        output = operation_root / "codex-result.json"
        schema.write_text(
            json.dumps(
                {
                    "type": "object",
                    "properties": {
                        "content": {"type": "string", "minLength": 1},
                        "actual_reads": {
                            "type": "array",
                            "items": {"type": "string"},
                        },
                    },
                    "required": ["content", "actual_reads"],
                    "additionalProperties": False,
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
        prompt_path = operation_root / "prompt.md"
        prompt_path.write_text(
            self._prompt(request, sources, candidates, target_exists=target_exists),
            encoding="utf-8",
        )
        command = [
            self.settings.command,
            "exec",
            "--ephemeral",
            "--sandbox",
            "read-only",
            "--skip-git-repo-check",
            "--color",
            "never",
            "--cd",
            str(self.vault),
            "--output-schema",
            str(schema),
            "--output-last-message",
            str(output),
        ]
        if self.settings.model:
            command.extend(("--model", self.settings.model))
        command.append("-")
        on_stage(SemanticStage.GENERATING, "Codex 正在读取来源并生成内容")
        self._run_codex(
            command,
            prompt_path,
            operation_root,
            deadline=deadline,
            should_cancel=should_cancel,
        )
        if not output.is_file():
            raise RuntimeError("Codex semantic operation produced no structured output")
        loaded = cast(object, json.loads(output.read_text(encoding="utf-8")))
        if not isinstance(loaded, dict):
            raise RuntimeError("Codex semantic output is malformed")
        mapping = cast(Mapping[str, object], loaded)
        content_value = mapping.get("content")
        if not isinstance(content_value, str):
            raise RuntimeError("Codex semantic output is malformed")
        raw_reads = mapping.get("actual_reads", [])
        reads: list[str] = []
        if isinstance(raw_reads, list):
            for value in cast(list[object], raw_reads):
                if not isinstance(value, str):
                    continue
                try:
                    path = resolve_bundle_path(self.vault, value)
                except ValueError:
                    continue
                if path.is_file():
                    reads.append(path.relative_to(self.vault).as_posix())
        required_reads = tuple(
            dict.fromkeys((request.target, *sources) if target_exists else sources)
        )
        missing_reads = [path for path in required_reads if path not in reads]
        if missing_reads:
            raise RuntimeError(
                "Codex did not report required read evidence: " + ", ".join(missing_reads)
            )
        content = content_value.strip()
        if not content:
            raise RuntimeError("Codex semantic output is empty")
        return SemanticOutput(content=content, actual_reads=tuple(dict.fromkeys(reads)))

    def _bounded_candidate_paths(
        self,
        request: SemanticRequest,
        operation_root: Path,
        *,
        deadline: float,
        should_cancel: CancelCheck,
        on_stage: StageCallback,
    ) -> tuple[str, ...]:
        retrieval_request = operation_root / "retrieval-request.json"
        retrieval_request.write_text(
            json.dumps(
                {"query": self._query(request), "sources": list(request.sources)},
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
        try:
            paths, actual_mode = self._retrieval_attempt(
                "hybrid",
                retrieval_request,
                operation_root,
                deadline=min(deadline, time.monotonic() + self.retrieval_timeout_seconds),
                should_cancel=should_cancel,
            )
            if actual_mode == "lexical":
                on_stage(SemanticStage.RETRIEVING, "向量检索不可用，已自动改用文本检索")
            return paths
        except SemanticCancelled:
            raise
        except (OSError, RuntimeError, SemanticTimedOut) as error:
            on_stage(
                SemanticStage.RETRIEVING,
                f"向量检索未完成，正在降级为文本检索：{self._short_error(error)}",
            )
        try:
            paths, _actual_mode = self._retrieval_attempt(
                "lexical",
                retrieval_request,
                operation_root,
                deadline=min(deadline, time.monotonic() + self.retrieval_timeout_seconds),
                should_cancel=should_cancel,
            )
            on_stage(SemanticStage.RETRIEVING, "已使用文本检索找到相关笔记")
            return paths
        except SemanticCancelled:
            raise
        except (OSError, RuntimeError, SemanticTimedOut) as error:
            on_stage(
                SemanticStage.RETRIEVING,
                f"上下文检索暂不可用；将只使用目标和明确来源：{self._short_error(error)}",
            )
            return ()

    def _retrieval_attempt(
        self,
        mode: str,
        request_path: Path,
        operation_root: Path,
        *,
        deadline: float,
        should_cancel: CancelCheck,
    ) -> tuple[tuple[str, ...], str]:
        output = operation_root / f"retrieval-{mode}.json"
        stdout_path = operation_root / f"retrieval-{mode}.stdout.log"
        stderr_path = operation_root / f"retrieval-{mode}.stderr.log"
        output.unlink(missing_ok=True)
        command = [
            sys.executable,
            "-m",
            "okf_workspace.semantic.retrieval_worker",
            "--vault",
            str(self.vault),
            "--state",
            str(self.state),
            "--request",
            str(request_path),
            "--output",
            str(output),
            "--mode",
            mode,
        ]
        with stdout_path.open("wb") as stdout, stderr_path.open("wb") as stderr:
            process = subprocess.Popen(
                command,
                stdin=subprocess.DEVNULL,
                stdout=stdout,
                stderr=stderr,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            self._wait_process(
                process,
                deadline=deadline,
                should_cancel=should_cancel,
                label=f"{mode} retrieval",
            )
        if process.returncode != 0:
            raise RuntimeError(
                f"{mode} retrieval failed: {self._tail(stderr_path) or self._tail(stdout_path)}"
            )
        if not output.is_file():
            raise RuntimeError(f"{mode} retrieval produced no result")
        loaded = cast(object, json.loads(output.read_text(encoding="utf-8")))
        if not isinstance(loaded, dict):
            raise RuntimeError(f"{mode} retrieval result is malformed")
        result = cast(Mapping[str, object], loaded)
        raw_paths = result.get("paths")
        actual_mode = result.get("mode")
        if not isinstance(raw_paths, list) or not all(
            isinstance(item, str) for item in cast(list[object], raw_paths)
        ):
            raise RuntimeError(f"{mode} retrieval paths are malformed")
        if actual_mode not in {"hybrid", "lexical"}:
            raise RuntimeError(f"{mode} retrieval mode is malformed")
        return tuple(cast(list[str], raw_paths)), cast(str, actual_mode)

    def _run_codex(
        self,
        command: list[str],
        prompt_path: Path,
        operation_root: Path,
        *,
        deadline: float,
        should_cancel: CancelCheck,
    ) -> None:
        stdout_path = operation_root / "codex.stdout.log"
        stderr_path = operation_root / "codex.stderr.log"
        with (
            prompt_path.open("rb") as prompt,
            stdout_path.open("wb") as stdout,
            stderr_path.open("wb") as stderr,
        ):
            try:
                process = subprocess.Popen(
                    command,
                    stdin=prompt,
                    stdout=stdout,
                    stderr=stderr,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                )
            except OSError as error:
                raise RuntimeError(f"Codex semantic operation failed: {error}") from error
            self._wait_process(
                process,
                deadline=deadline,
                should_cancel=should_cancel,
                label="Codex generation",
            )
        if process.returncode != 0:
            detail = self._tail(stderr_path) or self._tail(stdout_path) or "unknown Codex error"
            raise RuntimeError(f"Codex semantic operation failed: {detail}")

    @classmethod
    def _wait_process(
        cls,
        process: subprocess.Popen[bytes],
        *,
        deadline: float,
        should_cancel: CancelCheck,
        label: str,
    ) -> None:
        while process.poll() is None:
            if should_cancel():
                cls._stop_process_tree(process)
                raise SemanticCancelled("semantic operation cancelled")
            if time.monotonic() >= deadline:
                cls._stop_process_tree(process)
                raise SemanticTimedOut(f"{label} exceeded its time limit")
            time.sleep(0.2)

    @staticmethod
    def _stop_process_tree(process: subprocess.Popen[bytes]) -> None:
        if process.poll() is not None:
            return
        if os.name == "nt":
            with suppress(OSError):
                subprocess.run(
                    ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    check=False,
                    timeout=5,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                )
        if process.poll() is None:
            with suppress(OSError):
                process.terminate()
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            with suppress(OSError):
                process.kill()
            with suppress(subprocess.TimeoutExpired):
                process.wait(timeout=2)

    @staticmethod
    def _query(request: SemanticRequest) -> str:
        return (
            " ".join(value for value in (request.instruction, Path(request.target).stem) if value)
            or request.kind.value
        )

    @staticmethod
    def _prompt(
        request: SemanticRequest,
        sources: tuple[str, ...],
        candidates: tuple[str, ...],
        *,
        target_exists: bool,
    ) -> str:
        purpose = {
            SemanticKind.GENERATE_STUDY_GUIDE: (
                "为现有 Study Guide 生成第一版辅助学习材料，只返回 study-material 区域内容。"
            ),
            SemanticKind.REFRESH_STUDY_GUIDE: (
                "根据来源和现有内容重写辅助学习材料草稿，只返回 study-material 区域内容。"
            ),
            SemanticKind.GENERATE_WIKI: (
                "为已经确定的目标生成一版长期 Wiki 草稿，只返回 wiki-content 区域内容。"
            ),
        }[request.kind]
        target_state = "是，请先读取再更新" if target_exists else "否，只生成待发布内容"
        return (
            "这是受限的后台草稿生成任务，不是交互式 Skill 工作流。"
            "不要调用 prepare-study-guide、update-study-guide 或 distill-wiki；"
            "完整的查重、合并、拆分和跨文件写入只在 Claudian 中由对应 Skill 完成。\n"
            f"任务：{purpose}\n"
            f"目标笔记：{request.target}\n"
            f"目标当前是否存在：{target_state}\n"
            f"明确来源：{list(sources)}\n"
            f"建议检查的既有上下文：{list(candidates)}\n"
            f"用户补充要求：{request.instruction or '无'}\n\n"
            "必须亲自读取全部明确来源和实际采用的相关 Markdown；目标存在时也必须读取目标。"
            "不要修改任何文件。content 只输出要写入目标命名 ai:auto 区域的 Markdown，"
            "不要输出 frontmatter、一级标题、代码围栏或执行说明。"
            "actual_reads 使用 Vault 相对路径并只列出真实读取过的文件。"
        )

    @staticmethod
    def _tail(path: Path, limit: int = 1200) -> str:
        try:
            return path.read_text(encoding="utf-8", errors="replace").strip()[-limit:]
        except OSError:
            return ""

    @staticmethod
    def _short_error(error: BaseException) -> str:
        message = str(error).strip().replace("\n", " ")
        return message[-240:] or error.__class__.__name__
