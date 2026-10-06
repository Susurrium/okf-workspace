"""Receive complete, user-authored document requests replicated through the Vault.

Requests and originals both arrive through Vault replication. Legacy remote
requests can only resolve an already migrated Vault original.
Only the designated desktop Engine runs this receiver.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import shutil
import tempfile
import threading
import time
import uuid
from collections.abc import Mapping
from datetime import UTC, datetime
from pathlib import Path
from typing import cast

from okf_workspace.okf.file_io import atomic_write_bytes, document_lock
from okf_workspace.okf.frontmatter import (
    OkfDocument,
    parse_document,
    read_document,
    render_document,
)
from okf_workspace.okf.paths import resolve_bundle_path
from okf_workspace.okf.relations import normalize_context_reference
from okf_workspace.okf.validator import validate_document
from okf_workspace.semantic.service import SemanticOperationService
from okf_workspace.semantic.store import SemanticOperationStore

from .models import ConversionMethod, ImportIntent, ImportQuality, ImportRequest
from .originals import sha256_file
from .pipeline import DocumentImporter
from .routing import SUPPORTED_EXTENSIONS
from .state import ConversionBusyError

MAX_SYNCED_DOCUMENT_BYTES = 64 * 1024 * 1024
LOGGER = logging.getLogger(__name__)
MESSAGES = {
    "stored": "原件已保存",
    "waiting-for-file": "等待文件或关联笔记同步完整",
    "waiting-for-upload": "等待原件文件服务，电脑将自动重试",
    "queued": "电脑已接收，等待转换",
    "converting": "正在转换",
    "ready": "正在保存转换结果",
    "waiting-for-mineru": "等待 MinerU 恢复，电脑将自动重试",
    "waiting-for-parser": "等待转换服务恢复，电脑将自动重试",
    "imported": "转换完成",
    "failed": "处理失败",
}


class SyncedDocumentIntake:
    def __init__(
        self, importer: DocumentImporter, *, poll_seconds: float = 2.0,
        semantic_service: SemanticOperationService | None = None,
    ) -> None:
        self.importer = importer
        self.vault = importer.vault
        self.root = self.vault / "inbox" / "uploads"
        self.bindings = importer.state_root / "synced-imports"
        self.poll_seconds = poll_seconds
        self._last_poll = float("-inf")
        self._retry_at: dict[str, float] = {}
        self.semantic_service = semantic_service

    def poll(self) -> None:
        now = time.monotonic()
        if now - self._last_poll < self.poll_seconds:
            return
        self._last_poll = now
        self.scan()

    def run_forever(self, stop: threading.Event) -> None:
        while not stop.is_set():
            try:
                self.poll()
            except OSError:
                LOGGER.exception("Could not scan synced document inputs")
            stop.wait(0.5)

    def scan(self) -> int:
        received = 0
        roots = [self.root, self.vault / "system" / "imports"]
        candidates = [
            path for root in roots if root.resolve().is_relative_to(self.vault)
            for path in root.glob("*/request.md")
            if path.resolve().is_relative_to(root.resolve())
        ]
        for path in sorted(candidates):
            # A symlink/junction must not turn a replicated request into an
            # arbitrary local read or receipt write.
            if self._retry_at.get(path.parent.name, 0) > time.monotonic():
                continue
            try:
                if str(uuid.UUID(path.parent.name)) != path.parent.name:
                    continue
            except ValueError:
                continue
            try:
                with document_lock(self.bindings / path.parent.name, timeout=0.01):
                    received += int(self._receive(path))
            except (TimeoutError, ConversionBusyError):
                continue
            except Exception:
                LOGGER.exception("Could not receive synced document %s", path.parent.name)
        return received

    def _receive(self, path: Path) -> bool:
        identifier = path.parent.name
        document: OkfDocument | None = None
        try:
            document = read_document(path)
            fields = self.request_fields(document, identifier)
            binding_path = self.bindings / f"{identifier}.json"
            binding = self.read_binding(binding_path)
            if binding is not None:
                if binding.get("request") != fields:
                    raise ValueError("已接收的导入申请发生变化，请重新提交资料")
                if fields.get("action") == "store" and isinstance(binding.get("result"), dict):
                    result = cast(dict[str, object], binding["result"])
                    outputs = cast(dict[str, str], result.get("outputs", {}))
                    if outputs.get("source") and Path(outputs["source"]).is_file():
                        self._receipt(path, document, result)
                        return False
                conversion_id = str(binding.get("conversion_id") or "")
                if conversion_id and self.importer.store.record_path(conversion_id).is_file():
                    self._receipt(path, document, self.importer.store.load(conversion_id))
                    return False
            filename = str(fields["filename"])
            if Path(filename).name != filename or re.search(r'[<>:"/\\|?*\x00-\x1f]', filename):
                raise ValueError("原文件名无效")
            if Path(filename).suffix.lower() not in SUPPORTED_EXTENSIONS:
                raise ValueError("不支持这种文档格式")
            source: Path
            if fields.get("transport") != "file-store":
                source = resolve_bundle_path(self.vault, str(fields["file"]).removeprefix("/"))
                canonical = self.importer.original_store.root / str(fields["file_sha256"])
                if source.parent not in {path.parent.resolve(), canonical.resolve()}:
                    raise ValueError("导入文件必须位于原件目录或旧申请目录")
                if not source.is_file():
                    # After explicit upload cleanup, restore/rebuild can use the
                    # durable original even if the runtime binding was lost.
                    source = self.importer.original_store.resolve(
                        str(fields["file_sha256"]), verify=True,
                    )
                if not source.is_file() or source.stat().st_size != fields["size_bytes"]:
                    self._receipt(path, document, {"status": "waiting-for-file"})
                    return False
            else:
                source = self.importer.original_store.resolve(
                    str(fields["file_sha256"]), verify=True,
                )
            for name in ("course", "project"):
                if fields.get(name) is not None:
                    normalize_context_reference(self.vault, name, str(fields[name]))
            report = validate_document(self.vault, path, document)
            if not report.valid:
                raise ValueError("导入申请不符合契约：" + str(report.issues))
            spool_root = self.importer.state_root / "uploads"
            spool_root.mkdir(parents=True, exist_ok=True)
            # Verify a private snapshot, rather than checking then importing a
            # Vault file that the replication writer might replace in between.
            with tempfile.TemporaryDirectory(prefix="synced-", dir=spool_root) as temporary:
                snapshot = Path(temporary) / filename
                shutil.copyfile(source, snapshot)
                if (
                    snapshot.stat().st_size != fields["size_bytes"]
                    or sha256_file(snapshot) != fields["file_sha256"]
                ):
                    self._receipt(path, document, {"status": "waiting-for-file"})
                    return False
                import_request = ImportRequest(
                    source=snapshot,
                    source_filename=filename,
                    intent=ImportIntent(str(fields["intent"])),
                    quality=ImportQuality(str(fields.get("quality", "quick"))),
                    method=(
                        None if fields.get("method", "auto") == "auto"
                        else ConversionMethod(str(fields["method"]))
                    ),
                    course=self._context_slug(fields, "course"),
                    project=self._context_slug(fields, "project"),
                    generate=cast(bool, fields.get("generate", False)),
                )
                record = (
                    self.importer.save_original(import_request) if fields.get("action") == "store"
                    else self.importer.enqueue(import_request)
                )
                # Only a new explicit user request may retry failed generation.
                # Bound requests above merely refresh their receipt on each scan.
                outputs = cast(dict[str, object], record.get("outputs", {}))
                operation_id = outputs.get("semantic_operation_id")
                if fields.get("generate") and isinstance(operation_id, str):
                    service = self.semantic_service
                    if service and service.store.load(operation_id).get("status") in {
                        "failed", "cancelled", "orphaned",
                    }:
                        service.retry(operation_id)
            atomic_write_bytes(binding_path, json.dumps({
                "request": fields, "conversion_id": record.get("conversion_id"),
                **({"result": record} if fields.get("action") == "store" else {}),
            }, ensure_ascii=False).encode("utf-8"))
            self._receipt(path, document, record)
            return True
        except FileNotFoundError:
            if document is not None:
                self._receipt(path, document, {"status": "waiting-for-file"})
            return False
        except (ValueError, OSError) as exc:
            if document is not None:
                self._receipt(path, document, {"status": "failed", "error": str(exc)})
            else:
                LOGGER.warning("Invalid synced request %s: %s", identifier, exc)
            return False

    @staticmethod
    def request_fields(document: OkfDocument, identifier: str) -> dict[str, object]:
        if document.type != "Document Import Request":
            raise ValueError("不是资料导入申请")
        raw = document.frontmatter
        result: dict[str, object] = {}
        version = raw.get("request_version")
        action = raw.get("action")
        if version is not None and (type(version) is not int or version != 4):
            raise ValueError("不支持的导入申请版本，请更新电脑工作台")
        if action is not None or version is not None:
            if action not in {"store", "convert"}:
                raise ValueError("必须明确选择保存或转换")
            result["action"] = action
            if version is not None:
                result["request_version"] = version
        conversion_fields = ("quality", "method") if action != "store" else ()
        for name in (
            "request_id", "filename", "file_sha256", "intent", *conversion_fields,
        ):
            value = raw.get(name)
            if not isinstance(value, str) or not value:
                raise ValueError(f"导入申请缺少 {name}")
            result[name] = value
        transport = raw.get("transport")
        if transport == "file-store":
            store_id = raw.get("original_store")
            if not isinstance(store_id, str) or not re.fullmatch(r"[a-zA-Z0-9_-]{8,80}", store_id):
                raise ValueError("缺少原件文件服务身份")
            result.update(transport=transport, original_store=store_id)
        elif transport is None:
            if not isinstance(raw.get("file"), str) or not raw["file"]:
                raise ValueError("导入申请缺少 file")
            result["file"] = raw["file"]
        else:
            raise ValueError("不支持的导入传输方式")
        if result["request_id"] != identifier:
            raise ValueError("申请编号与目录不一致")
        if not re.fullmatch(r"[0-9a-f]{64}", str(result["file_sha256"])):
            raise ValueError("文件校验值无效")
        size = raw.get("size_bytes")
        if (
            not isinstance(size, int) or isinstance(size, bool)
            or not 0 < size <= MAX_SYNCED_DOCUMENT_BYTES
        ):
            raise ValueError("单个文件必须大于 0 且不超过 64 MiB")
        result["size_bytes"] = size
        if action == "store":
            if any(name in raw for name in ("quality", "method", "parser", "generate")):
                raise ValueError("仅保存原件不能附带转换或生成选项")
            if result["intent"] not in {"source", "later"}:
                raise ValueError("仅保存原件不能请求生成笔记")
        else:
            generate = raw.get("generate")
            if not isinstance(generate, bool):
                raise ValueError("generate 必须是布尔值")
            result["generate"] = generate
            ImportQuality(str(result["quality"]))
            if result["method"] != "auto":
                ConversionMethod(str(result["method"]))
        ImportIntent(str(result["intent"]))
        for name in ("course", "project"):
            value = raw.get(name)
            if value is not None:
                pattern = (
                    r"/learning/courses/[^/]+/course\.md" if name == "course"
                    else r"/projects/[^/]+/project\.md"
                )
                if not isinstance(value, str) or not re.fullmatch(pattern, value):
                    raise ValueError(f"无效的 {name} 关联")
                result[name] = value
        return result

    @staticmethod
    def _context_slug(fields: Mapping[str, object], name: str) -> str | None:
        value = fields.get(name)
        return str(value).split("/")[-2] if value is not None else None

    @staticmethod
    def read_binding(path: Path) -> dict[str, object] | None:
        if not path.is_file():
            return None
        value = cast(object, json.loads(path.read_text(encoding="utf-8")))
        if not isinstance(value, dict):
            raise ValueError("导入接收记录无效")
        return cast(dict[str, object], value)

    def _receipt(self, request: Path, document: OkfDocument, record: Mapping[str, object]) -> None:
        status = str(record.get("status", "failed"))
        fields: dict[str, object] = {
            "type": "Document Import Receipt",
            "title": str(document.frontmatter.get("title", request.parent.name)),
            "created_at": document.frontmatter.get("created_at", datetime.now(UTC).isoformat()),
            "request_id": request.parent.name,
            "request": "/" + request.relative_to(self.vault).as_posix(),
            "processing_status": status,
            "original_archived": False,
            "message": str(record.get("error") or MESSAGES.get(status, status))[:2000],
        }
        if record.get("conversion_id"):
            fields["conversion_id"] = record["conversion_id"]
        if record.get("conversion_id") or status == "stored":
            digest = str(document.frontmatter["file_sha256"])
            try:
                self.importer.original_store.resolve(digest)
                fields["original_archived"] = True
                fields["file_sha256"] = digest
            except FileNotFoundError:
                fields["original_archived"] = False
        outputs: dict[str, str] = {}
        raw_outputs = record.get("outputs")
        if isinstance(raw_outputs, Mapping):
            for name, value in cast(Mapping[str, object], raw_outputs).items():
                public_name = {
                    "source_record": "source", "source_extract": "source_text",
                    "routed_draft": "routed_target",
                    "source": "source", "source_text": "source_text",
                    "routed_target": "routed_target",
                }.get(name)
                if public_name and isinstance(value, str):
                    try:
                        relative = Path(value).resolve().relative_to(self.vault).as_posix()
                        outputs[public_name] = relative
                    except ValueError:
                        continue
        fields["outputs"] = outputs
        operation_id = (
            cast(Mapping[str, object], raw_outputs).get("semantic_operation_id")
            if isinstance(raw_outputs, Mapping) else None
        )
        if isinstance(operation_id, str):
            store = SemanticOperationStore(self.importer.state_root)
            if store.path(operation_id).is_file():
                operation = store.load(operation_id)
                fields["semantic_status"] = operation["status"]
                if operation.get("error"):
                    fields["semantic_error"] = str(operation["error"])[:2000]
                labels = {
                    "queued": "等待生成辅助材料", "running": "正在生成辅助材料",
                    "completed": "辅助材料已生成", "failed": "辅助材料生成失败",
                    "cancelled": "辅助材料生成已取消", "orphaned": "辅助材料生成已中断",
                }
                fields["message"] = str(fields["message"]) + "；" + labels.get(
                    str(operation["status"]), str(operation["status"]),
                )
        content = f"{fields['message']}\n"
        for name, value in outputs.items():
            labels = {
                "source": "资料记录", "source_text": "转换正文", "routed_target": "处理结果",
            }
            label = labels[name]
            content += f"\n- {label}：[[{value}]]\n"
        target = request.parent / "receipt.md"
        start = '<!-- ai:auto:start name="document-import-result" -->'
        end = '<!-- ai:auto:end name="document-import-result" -->'
        region = f"{start}\n{content.strip()}\n{end}"
        body = f"# {fields['title']}\n\n{region}\n"
        expected_sha256: str | None = None
        if target.is_file():
            previous_bytes = target.read_bytes()
            previous = parse_document(previous_bytes.decode("utf-8"))
            if (
                previous.type != "Document Import Receipt"
                or previous.frontmatter.get("request_id") != request.parent.name
                or previous.body.count(start) != 1 or previous.body.count(end) != 1
            ):
                raise ValueError("处理回执的身份或受管理区域已改变，保留现有内容")
            before, remaining = previous.body.split(start, 1)
            _, after = remaining.split(end, 1)
            body = before + region + after
            # Preserve user notes and unknown extension fields.
            for name in ("semantic_error", "semantic_status", "conversion_id", "file_sha256"):
                if name not in fields:
                    previous.frontmatter.pop(name, None)
            fields = {**previous.frontmatter, **fields}
            expected_sha256 = hashlib.sha256(previous_bytes).hexdigest()
        rendered = render_document(fields, body)
        # A receipt is a read-only projection. Rebuild it after a lost update,
        # but do not churn unchanged files on every poll.
        if target.is_file() and target.read_text(encoding="utf-8") == rendered:
            return
        candidate = OkfDocument(fields, body)
        report = validate_document(self.vault, target, candidate)
        if not report.valid:
            raise ValueError("导入回执不符合契约：" + str(report.issues))
        atomic_write_bytes(target, rendered.encode("utf-8"), expected_sha256=expected_sha256)
