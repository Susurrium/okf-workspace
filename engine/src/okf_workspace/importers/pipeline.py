"""Synchronous user flow: Original → convert → export → QC → publish."""

from __future__ import annotations

import hashlib
import json
import logging
import shutil
import time
from collections.abc import Mapping
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path
from typing import Protocol, cast

import httpx

from okf_workspace.git import GitCheckpointError, checkpointing_enabled, create_checkpoint
from okf_workspace.sources import SourcePublisher

from .clients import MarkItDownClient, MinerUClient, ParserClient, RetryableConversionError
from .cloud_mineru import CloudMinerUClient
from .config import ImportSettings
from .export import load_export_contract, write_export_contract
from .managed_mineru import managed_mineru_client
from .models import (
    ConversionMethod,
    ConversionStatus,
    ImportIntent,
    ImportQuality,
    ImportRequest,
    ImportResult,
    OriginalRecord,
    ParserExport,
    ParserName,
    QCReport,
    requires_semantic_generation,
)
from .originals import VaultOriginalStore
from .publish import publish_import, publish_original, route_existing_import
from .qc import inspect_export
from .routing import choose_method
from .ssh_transport import SSHTransportError
from .state import ConversionStore
from .word import OfficeComConverter

_LOGGER = logging.getLogger(__name__)


class LegacyDocConverter(Protocol):
    def convert(self, source: Path, destination: Path) -> Path: ...


def conversion_id(
    source_sha256: str,
    request: ImportRequest,
    parser: ParserName | None = None,
) -> str:
    # A conversion is one durable user request. Parser is an execution strategy
    # and may change during retry without creating a second queued identity.
    del parser
    material = json.dumps(
        {
            "source_sha256": source_sha256,
            "quality": request.quality.value,
            "intent": request.intent.value,
            "course": request.course,
            "project": request.project,
            "generate": request.generate,
            "contract": 2,
        },
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return f"conv-{hashlib.sha256(material).hexdigest()}"


class DocumentImporter:
    def __init__(
        self,
        *,
        vault: Path,
        originals: Path,
        state: Path,
        settings: ImportSettings | None = None,
        clients: Mapping[ParserName, ParserClient] | None = None,
        method_clients: Mapping[ConversionMethod, ParserClient] | None = None,
        doc_converter: LegacyDocConverter | None = None,
    ) -> None:
        self.vault = vault.resolve()
        # Keep the deployment argument readable for existing installations;
        # external originals are migration input, never the active write target.
        self.legacy_originals = originals.resolve()
        self.original_store = VaultOriginalStore(self.vault, state)
        self.state_root = state.resolve()
        self.store = ConversionStore(self.state_root)
        self.settings = settings or ImportSettings.from_env()
        self.clients = dict(clients or {})
        self.method_clients = dict(method_clients or {})
        self.doc_converter = doc_converter or OfficeComConverter()

    def _default_client(self, method: ConversionMethod) -> ParserClient:
        if method is ConversionMethod.MINERU_CLOUD:
            if self.settings.mineru_token_file is None:
                raise RuntimeError("MinerU cloud token file is not configured")
            return CloudMinerUClient(
                self.settings.mineru_token_file,
                model=self.settings.mineru_model,
            )
        if method is ConversionMethod.MINERU_SELF_HOSTED:
            return MinerUClient(self.settings.mineru_url)
        return MarkItDownClient(
            self.settings.markitdown_url,
            self.settings.markitdown_token(),
        )

    def _convert(
        self,
        method: ConversionMethod,
        source: Path,
        working: Path,
    ) -> ParserExport:
        injected = self.method_clients.get(method) or (
            self.clients.get(method.parser) if method is not ConversionMethod.MINERU_SELF_HOSTED
            else None
        )
        if injected is None and method is ConversionMethod.MINERU_SELF_HOSTED:
            if not self.settings.mineru_self_hosted_enabled:
                raise ValueError("请启用并配置自建 MinerU 服务")
            if self.settings.mineru_ssh_managed:
                try:
                    with managed_mineru_client(self.settings) as managed:
                        export = managed.convert(source, working)
                        if export.parser is not method.parser:
                            raise ValueError(
                                "conversion result parser does not match selected method"
                            )
                        return replace(export, method=method)
                except (httpx.TransportError, SSHTransportError) as exc:
                    raise RetryableConversionError(
                        f"{method.value} connection is unavailable"
                    ) from exc
        client = injected or self._default_client(method)
        try:
            export = client.convert(source, working)
            if export.parser is not method.parser:
                raise ValueError("conversion result parser does not match selected method")
            return replace(export, method=method)
        except httpx.TransportError as exc:
            raise RetryableConversionError(f"{method.value} connection is unavailable") from exc
        finally:
            close = getattr(client, "close", None)
            if injected is None and callable(close):
                close()

    def _convert_recorded(
        self,
        conversion_id: str,
        method: ConversionMethod,
        source: Path,
        working: Path,
    ) -> ParserExport:
        started_at = datetime.now(UTC).isoformat(timespec="seconds")
        started = time.perf_counter()
        try:
            export = self._convert(method, source, working)
        except Exception as exc:
            self.store.record_parser_attempt(
                conversion_id,
                parser=method.parser,
                method=method,
                status="failed",
                started_at=started_at,
                duration_ms=round((time.perf_counter() - started) * 1000),
                error=str(exc)[:2000],
            )
            raise
        self.store.record_parser_attempt(
            conversion_id,
            parser=method.parser,
            method=method,
            status="completed",
            started_at=started_at,
            duration_ms=round((time.perf_counter() - started) * 1000),
        )
        return export

    def _publish_ready(
        self,
        identifier: str,
        request: ImportRequest,
        original: OriginalRecord,
        export_directory: Path,
        export: ParserExport,
        qc: QCReport,
        *,
        replace_existing: bool = False,
        expected_text_sha256: str | None = None,
    ) -> ImportResult:
        checkpoint_warnings: list[str] = []
        self.store.update(
            identifier,
            status=ConversionStatus.READY,
            request=request,
            original=original,
            parser=export.parser,
            outputs={"export": str(export_directory)},
            stages={"conversion": "completed", "quality": "passed", "routing": "pending"},
            warnings=qc.warnings,
        )
        checkpoints_enabled = checkpointing_enabled(self.vault)
        if checkpoints_enabled:
            try:
                create_checkpoint(self.vault, "checkpoint before document import")
            except GitCheckpointError as exc:
                checkpoint_warnings.append(f"写入前 Git 检查点失败：{exc}")
        published = publish_import(
            self.vault,
            request,
            original,
            export,
            replace_existing=replace_existing,
            expected_text_sha256=expected_text_sha256,
        )
        source, source_text, routed_target = (
            published.source, published.source_text, published.routed_target,
        )
        if published.reused_existing:
            checkpoint_warnings.append(
                "已沿用已有转换正文；如需采用本次转换结果，请使用指定方式重新转换。"
            )
        checkpoint_status = "disabled"
        if checkpoints_enabled:
            checkpoint_status = "completed"
            try:
                create_checkpoint(self.vault, f"import: {original.filename}")
            except GitCheckpointError as exc:
                checkpoint_status = "failed"
                checkpoint_warnings.append(f"导入后 Git 检查点失败：{exc}")
        outputs = {
            "export": str(export_directory),
            "source": str(source),
            "source_text": str(source_text),
        }
        if routed_target is not None:
            outputs["routed_target"] = str(routed_target)
        if published.text_sha256 is not None:
            outputs["source_text_sha256"] = published.text_sha256
        self.store.update(
            identifier,
            status=ConversionStatus.IMPORTED,
            request=request,
            original=original,
            parser=export.parser,
            outputs=outputs,
            stages={
                "conversion": "completed",
                "quality": "passed",
                "routing": "completed",
                "checkpoint": checkpoint_status,
                "semantic": "pending" if requires_semantic_generation(
                    request.intent, request.generate,
                ) else "not-requested",
            },
            warnings=(*qc.warnings, *checkpoint_warnings),
        )
        self._discard_working_files(identifier)
        return ImportResult(
            conversion_id=identifier,
            status=ConversionStatus.IMPORTED,
            original=original,
            parser=export.parser,
            export_directory=export_directory,
            source=source,
            source_text=source_text,
            routed_target=routed_target,
            qc=qc,
            method=export.method,
        )

    def _discard_working_files(self, identifier: str) -> None:
        """After the durable receipt, retain the export for retries, not scratch copies."""
        working = self.store.directory(identifier) / "working"
        try:
            root = self.state_root / "conversions"
            resolved = working.resolve()
            if (
                resolved != root / identifier / "working"
                or not resolved.is_relative_to(root)
                or resolved.is_relative_to(self.vault)
            ):
                raise ValueError("conversion working directory escapes external State")
            if working.exists():
                shutil.rmtree(working)
        except (OSError, ValueError):
            # Cleanup failure must never turn a successfully published import into failure.
            _LOGGER.warning(
                "Could not clean conversion scratch files: %s", identifier, exc_info=True,
            )

    def import_document(
        self, request: ImportRequest, *, replace_existing: bool = False,
        expected_text_sha256: str | None = None,
    ) -> ImportResult:
        selected_method = self.resolve_method(request)
        original = self.original_store.ingest(
            request.source,
            filename=request.source_filename,
        )
        selected_parser = selected_method.parser
        request = replace(request, method=selected_method)
        identifier = conversion_id(original.sha256, request, selected_parser)
        with self.store.execution(identifier):
            return self._import_original(
                request, original, identifier,
                replace_existing=replace_existing, expected_text_sha256=expected_text_sha256,
            )

    def resolve_method(self, request: ImportRequest) -> ConversionMethod:
        selected = choose_method(
            request.source, request.method, request.parser,
            default=self.settings.default_conversion_method,
        )
        if selected is ConversionMethod.MINERU_SELF_HOSTED and not (
            self.settings.mineru_self_hosted_enabled or selected in self.method_clients
        ):
            raise ValueError("请启用并配置自建 MinerU 服务")
        return selected

    def _import_original(
        self, request: ImportRequest, original: OriginalRecord, identifier: str, *,
        replace_existing: bool, expected_text_sha256: str | None,
    ) -> ImportResult:
        selected_method = cast(ConversionMethod, request.method)
        selected_parser = selected_method.parser
        conversion_root = self.store.directory(identifier)
        working = conversion_root / "working"
        export_directory = conversion_root / "export"
        self.store.update(
            identifier,
            status=ConversionStatus.QUEUED,
            request=request,
            original=original,
            parser=selected_parser,
            stages={"upload": "completed", "conversion": "queued"},
        )
        export: ParserExport | None = None
        qc: QCReport | None = None
        try:
            prepared = original.stored_path
            if original.extension == ".doc":
                prepared = self.doc_converter.convert(
                    original.stored_path,
                    working / "normalized.docx",
                )
            elif original.extension == ".ppt":
                prepared = self.doc_converter.convert(
                    original.stored_path,
                    working / "normalized.pptx",
                )
            self.store.update(
                identifier,
                status=ConversionStatus.CONVERTING,
                request=request,
                original=original,
                parser=selected_parser,
                stages={
                    "conversion": "running", "quality": "not-started", "routing": "not-started",
                },
            )
            export = self._convert_recorded(identifier, selected_method, prepared, working)
            qc = inspect_export(
                export,
                strict_assets=request.quality is ImportQuality.HIGH,
            )
            write_export_contract(
                export_directory,
                conversion_id=identifier,
                original=original,
                export=export,
                qc=qc,
            )
            if not qc.passed:
                raise RuntimeError("conversion QC failed: " + "; ".join(qc.errors))
            return self._publish_ready(
                identifier,
                request,
                original,
                export_directory,
                export,
                qc,
                replace_existing=replace_existing,
                expected_text_sha256=expected_text_sha256,
            )
        except Exception as exc:
            self.store.update(
                identifier,
                status=ConversionStatus.FAILED,
                request=request,
                original=original,
                parser=export.parser if export is not None else selected_parser,
                error=str(exc),
                outputs=({"export": str(export_directory)} if export_directory.is_dir() else None),
                stages={
                    "conversion": "completed" if export is not None else "failed",
                    "quality": "passed" if qc and qc.passed else "failed" if qc else "not-started",
                    "routing": "failed" if qc and qc.passed else "not-started",
                },
                warnings=qc.warnings if qc else (),
            )
            raise

    def save_original(self, request: ImportRequest) -> dict[str, object]:
        """Save/register bytes without selecting a parser or allocating a conversion."""
        if request.generate or request.intent not in {ImportIntent.SOURCE, ImportIntent.LATER}:
            raise ValueError("仅保存原件不能请求转换或生成笔记")
        original = self.original_store.ingest(request.source, filename=request.source_filename)
        source = publish_original(self.vault, request, original)
        outputs = {"source": str(source)}
        publisher = SourcePublisher(self.vault)
        document = publisher.read_record(source)
        if "text" in document.frontmatter:
            text, _ = publisher.resolve_text(document)
            outputs["source_text"] = str(text)
        return {"status": "stored", "outputs": outputs, "file_sha256": original.sha256}

    def enqueue(self, request: ImportRequest) -> dict[str, object]:
        original = self.original_store.ingest(
            request.source,
            filename=request.source_filename,
        )
        existing = SourcePublisher(self.vault).find_by_sha256(original.sha256)
        if existing and "text" in existing[1].frontmatter:
            # Generation from published text needs no available converter.
            selected_method = request.method or (
                ConversionMethod.from_parser(request.parser) if request.parser
                else self.settings.default_conversion_method
            )
        else:
            selected_method = self.resolve_method(request)
        request = replace(request, method=selected_method)
        selected_parser = selected_method.parser
        queued_request = replace(request, source=original.stored_path)
        identifier = conversion_id(original.sha256, queued_request, selected_parser)
        with self.store.execution(identifier):
            return self._enqueue_original(identifier, original, queued_request, selected_parser)

    def _enqueue_original(
        self, identifier: str, original: OriginalRecord,
        queued_request: ImportRequest, selected_parser: ParserName,
    ) -> dict[str, object]:
        if self.store.record_path(identifier).is_file():
            existing = self.store.load(identifier)
            if existing.get("status") in {
                ConversionStatus.QUEUED.value,
                ConversionStatus.CONVERTING.value,
                ConversionStatus.WAITING_FOR_MINERU.value,
                ConversionStatus.WAITING_FOR_PARSER.value,
                ConversionStatus.IMPORTED.value,
            }:
                return {**existing, "reused_existing": True}
        publisher = SourcePublisher(self.vault)
        existing_source = publisher.find_by_sha256(original.sha256)
        if existing_source and "text" in existing_source[1].frontmatter:
            source, text, draft = route_existing_import(
                self.vault, existing_source[0], intent=queued_request.intent,
                course=queued_request.course, project=queued_request.project,
            )
            if text is None:
                raise ValueError("Source Text disappeared during import")
            outputs = {"source": str(source), "source_text": str(text)}
            # Reuse the original publication baseline, never treat human edits
            # as permission for a later unattended replacement.
            for prior in self.store.list():
                prior_outputs = prior.get("outputs")
                if not isinstance(prior_outputs, dict):
                    continue
                values = cast(dict[str, object], prior_outputs)
                baseline = values.get("source_text_sha256")
                if values.get("source_text") == str(text) and isinstance(baseline, str):
                    outputs["source_text_sha256"] = baseline
                    break
            if draft is not None:
                outputs["routed_target"] = str(draft)
            self.store.update(
                identifier, status=ConversionStatus.IMPORTED, request=queued_request,
                original=original, parser=selected_parser, outputs=outputs,
                warnings=("沿用已有正文，未重新转换。",),
                stages={"conversion": "reused", "quality": "reused", "routing": "completed",
                        "semantic": "pending" if requires_semantic_generation(
                            queued_request.intent, queued_request.generate,
                        ) else "not-requested"},
            )
            return {**self.store.load(identifier), "reused_existing": True}
        self.store.update(
            identifier,
            status=ConversionStatus.QUEUED,
            request=queued_request,
            original=original,
            parser=selected_parser,
            stages={"upload": "completed", "conversion": "queued"},
        )
        return self.store.load(identifier)

    def retry(
        self,
        identifier: str,
        *,
        parser: ParserName | None = None,
        method: ConversionMethod | None = None,
    ) -> ImportResult:
        with self.store.execution(identifier):
            if parser is not None or method is not None:
                self.queue_retry(identifier, parser=parser, method=method)
            return self._retry(identifier)

    def queue_retry(
        self, identifier: str, *, parser: ParserName | None = None,
        method: ConversionMethod | None = None,
    ) -> dict[str, object]:
        with self.store.execution(identifier):
            record = self.store.load(identifier)
            if method is not None or parser is not None:
                self.resolve_method(ImportRequest(
                    source=Path(str(record["original_path"])), intent=ImportIntent.SOURCE,
                    method=method, parser=parser,
                ))
            return self.store.queue_retry(identifier, parser=parser, method=method)

    def _retry(self, identifier: str) -> ImportResult:
        record = self.store.load(identifier)
        reparse = record.get("reparse") is True
        output_values = record.get("outputs")
        previous_hash = (
            cast(dict[str, object], output_values).get("source_text_sha256")
            if isinstance(output_values, dict) else None
        )
        expected_hash = previous_hash if isinstance(previous_hash, str) else None

        def required_string(key: str) -> str:
            value = record.get(key)
            if not isinstance(value, str) or not value:
                raise ValueError(f"conversion record is missing {key}")
            return value

        intent = ImportIntent(required_string("intent"))
        quality = ImportQuality(required_string("quality"))
        course_value = record.get("course")
        project_value = record.get("project")
        generate_value = record.get("generate", False)
        requested_parser = record.get("requested_parser", "auto")
        stored_parser = (
            ParserName(str(requested_parser))
            if isinstance(requested_parser, str) and requested_parser != "auto"
            else None
        )
        request = ImportRequest(
            source=self.original_store.resolve(required_string("source_sha256"), verify=True),
            intent=intent,
            source_filename=required_string("source_filename"),
            quality=quality,
            method=(
                ConversionMethod(str(record["method"])) if record.get("method") else
                ConversionMethod.from_parser(stored_parser or ParserName(required_string("parser")))
            ),
            course=course_value if isinstance(course_value, str) else None,
            project=project_value if isinstance(project_value, str) else None,
            generate=bool(generate_value),
        )
        export_directory = self.store.directory(identifier) / "export"
        stages = record.get("stages")
        resume_reparse = (
            isinstance(stages, dict)
            and cast(dict[str, object], stages).get("conversion") == "completed"
            and cast(dict[str, object], stages).get("quality") == "passed"
        )
        if (not reparse or resume_reparse) and (export_directory / "manifest.json").is_file():
            export, qc = load_export_contract(export_directory)
            if qc.passed and (export.method or ConversionMethod.from_parser(export.parser)) is (
                self.resolve_method(request)
            ):
                original_path = request.source
                source_filename = required_string("source_filename")
                original = self.original_store.ingest(original_path, filename=source_filename)
                return self._publish_ready(
                    identifier,
                    request,
                    original,
                    export_directory,
                    export,
                    qc,
                    replace_existing=reparse,
                    expected_text_sha256=expected_hash,
                )
        return self.import_document(
            request, replace_existing=reparse, expected_text_sha256=expected_hash,
        )
