"""Fast, idempotent queue operations for semantic work.

The API process only validates and persists requests. Codex execution, vector
retrieval, and Markdown publishing happen in the independent semantic worker.
"""

from __future__ import annotations

import hashlib
import uuid
from pathlib import Path

from okf_workspace.okf.frontmatter import read_document
from okf_workspace.okf.paths import resolve_bundle_path
from okf_workspace.okf.relations import explicit_context_fields

from .models import SemanticKind, SemanticRequest, SemanticStatus
from .store import SemanticOperationStore


class SemanticOperationService:
    def __init__(self, vault: Path, state: Path) -> None:
        self.vault = vault.resolve()
        self.state = state.resolve()
        self.store = SemanticOperationStore(self.state)

    def enqueue(
        self,
        kind: SemanticKind,
        target: str,
        *,
        sources: tuple[str, ...] = (),
        instruction: str = "",
        course: str | None = None,
        project: str | None = None,
        idempotency_key: str | None = None,
    ) -> dict[str, object]:
        with self.store.transaction():
            if idempotency_key:
                receipt = self.store.find_by_idempotency_key(idempotency_key)
                if receipt is not None:
                    return receipt
            return self._enqueue(
                kind, target, sources=sources, instruction=instruction,
                course=course, project=project, idempotency_key=idempotency_key,
            )

    def _enqueue(
        self,
        kind: SemanticKind,
        target: str,
        *,
        sources: tuple[str, ...] = (),
        instruction: str = "",
        course: str | None = None,
        project: str | None = None,
        idempotency_key: str | None = None,
    ) -> dict[str, object]:
        target_path = resolve_bundle_path(self.vault, target)
        target = target_path.relative_to(self.vault).as_posix()
        normalized_sources = tuple(dict.fromkeys(sources))
        if not normalized_sources and not target_path.is_file():
            raise ValueError("semantic generation requires at least one explicit source")
        target_hash = (
            hashlib.sha256(target_path.read_bytes()).hexdigest() if target_path.is_file() else ""
        )
        source_hashes: dict[str, str] = {}
        for source in normalized_sources:
            source_path = resolve_bundle_path(self.vault, source)
            if not source_path.is_file():
                raise FileNotFoundError(source_path)
            source_hashes[source] = hashlib.sha256(source_path.read_bytes()).hexdigest()
        self._validate_target(kind, target_path)
        context = explicit_context_fields(
            self.vault,
            course=course,
            project=project,
        )
        fingerprint = self._fingerprint(
            kind,
            target,
            normalized_sources,
            source_hashes,
            target_hash,
            instruction,
            context.get("course"),
            context.get("project"),
        )
        existing = self.store.find_active(fingerprint)
        if existing is not None:
            return self.store.bind_handoff(existing, idempotency_key)
        completed = self.store.find_completed(fingerprint)
        if completed is not None and target_path.is_file():
            return self.store.bind_handoff(completed, idempotency_key)
        request = SemanticRequest(
            operation_id=f"op-{uuid.uuid4().hex}",
            kind=kind,
            target=target,
            sources=normalized_sources,
            instruction=instruction,
            course=context.get("course"),
            project=context.get("project"),
        )
        self.store.supersede_target(kind, target)
        record = self.store.create(
            request,
            fingerprint=fingerprint,
            source_hashes=source_hashes,
            idempotency_key=idempotency_key,
        )
        return record

    def retry(self, operation_id: str) -> dict[str, object]:
        with self.store.transaction():
            return self._retry(operation_id)

    def _retry(self, operation_id: str) -> dict[str, object]:
        record = self.store.load(operation_id)
        if record.get("status") not in {
            SemanticStatus.FAILED.value,
            SemanticStatus.CANCELLED.value,
            SemanticStatus.ORPHANED.value,
        }:
            raise ValueError("only failed, cancelled, or orphaned operations can be retried")
        request = self.store.request(operation_id)
        if any(
            item.get("operation_id") != operation_id
            and item.get("target") == request.target
            and item.get("status") in {SemanticStatus.QUEUED.value, SemanticStatus.RUNNING.value}
            for item in self.store.list()
        ):
            raise ValueError("another operation for this target is already active")
        self._validate_target(
            request.kind,
            resolve_bundle_path(self.vault, request.target),
        )
        return self.store.retry(operation_id)

    def cancel(self, operation_id: str) -> dict[str, object]:
        return self.store.cancel(operation_id)

    def reconcile_pending(self) -> int:
        """Recover legacy/stale work once without blindly duplicating it."""

        return self.store.reconcile_pending()

    @staticmethod
    def _fingerprint(
        kind: SemanticKind,
        target: str,
        sources: tuple[str, ...],
        source_hashes: dict[str, str],
        target_hash: str,
        instruction: str,
        course: str | None,
        project: str | None,
    ) -> str:
        fields = [kind.value, target, instruction.strip(), course or "", project or ""]
        if target_hash:
            fields.append(f"target:{target_hash}")
        fields.extend(f"{source}:{source_hashes[source]}" for source in sources)
        return hashlib.sha256("\n".join(fields).encode()).hexdigest()

    @staticmethod
    def _validate_target(
        kind: SemanticKind,
        target_path: Path,
    ) -> None:
        relative = target_path.as_posix().casefold()
        expected_prefixes = (
            ("/learning/guides/", "/learning/courses/")
            if kind
            in {
                SemanticKind.GENERATE_STUDY_GUIDE,
                SemanticKind.REFRESH_STUDY_GUIDE,
            }
            else ("/knowledge/wiki/",)
        )
        if target_path.suffix.casefold() != ".md" or not any(
            prefix in relative for prefix in expected_prefixes
        ):
            raise ValueError("semantic target path does not match the requested artifact")
        if not target_path.is_file():
            return
        document = read_document(target_path)
        if kind in {
            SemanticKind.GENERATE_STUDY_GUIDE,
            SemanticKind.REFRESH_STUDY_GUIDE,
        }:
            if document.type != "Study Guide":
                raise ValueError("study material target must be a Study Guide")
            return
        if document.type != "Wiki":
            raise ValueError("Wiki target must use type: Wiki")
