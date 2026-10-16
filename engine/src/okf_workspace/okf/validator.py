"""Contract-aware validation for an OKF Workspace Vault."""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from datetime import date, datetime
from pathlib import Path, PurePosixPath
from typing import cast

from .contracts import (
    ArtifactContract,
    ContractCatalog,
    ContractError,
    load_contract_catalog,
    matches_contract_path,
)
from .document_role import DocumentRole, document_role, is_workbench_backup, workbench_issue
from .frontmatter import FrontmatterError, OkfDocument, parse_document, read_document
from .project_category import normalize_project_category

_DATE_HEADING = re.compile(r"^## (\d{4}-\d{2}-\d{2})\s*$")
_SKIPPED_DIRECTORIES = {".agents", ".claudian", ".git", ".obsidian", ".trash"}
_CONTROL_FILES = {"AGENTS.md"}
_SKIPPED_SYSTEM_SECTIONS = {"contracts", "templates"}


@dataclass(frozen=True, slots=True)
class ValidationIssue:
    path: str
    code: str
    message: str
    severity: str = "error"


@dataclass(slots=True)
class ValidationReport:
    issues: list[ValidationIssue] = field(default_factory=lambda: [])
    files_checked: int = 0

    @property
    def errors(self) -> list[ValidationIssue]:
        return [issue for issue in self.issues if issue.severity == "error"]

    @property
    def warnings(self) -> list[ValidationIssue]:
        return [issue for issue in self.issues if issue.severity == "warning"]

    @property
    def valid(self) -> bool:
        return not self.errors


def _relative(path: Path, vault: Path) -> str:
    return path.resolve().relative_to(vault.resolve()).as_posix()


def _is_skipped(path: Path, vault: Path) -> bool:
    relative = path.relative_to(vault).as_posix()
    parts = path.relative_to(vault).parts
    return (
        path.name in _CONTROL_FILES
        or parts[:2] == ("sources", "originals")
        or any(part in _SKIPPED_DIRECTORIES for part in parts)
        or (len(parts) >= 2 and parts[0] == "system" and parts[1] in _SKIPPED_SYSTEM_SECTIONS)
        or is_workbench_backup(relative)
    )


def _issue(report: ValidationReport, path: str, code: str, message: str) -> None:
    report.issues.append(ValidationIssue(path, code, message))


def _validate_index(
    path: Path,
    vault: Path,
    report: ValidationReport,
    *,
    profile: bool,
) -> None:
    relative = _relative(path, vault)
    text = path.read_text(encoding="utf-8")
    is_root = path.resolve() == (vault / "index.md").resolve()
    if not is_root:
        if profile:
            _issue(report, relative, "nested-index", "only the bundle-root index.md is allowed")
        if text.startswith(("---\n", "---\r\n")):
            _issue(report, relative, "index-frontmatter", "nested index.md cannot use frontmatter")
        if not any(line.startswith("# ") for line in text.splitlines()):
            _issue(report, relative, "index-heading", "index.md must contain an H1 heading")
        return
    if not text.startswith(("---\n", "---\r\n")):
        if profile:
            _issue(report, relative, "root-index-frontmatter", "root index requires okf_version")
        return
    try:
        root = parse_document(text, source=str(path))
    except FrontmatterError as exc:
        _issue(report, relative, "root-index-frontmatter", str(exc))
        return
    if document_role(root) is not DocumentRole.ARTIFACT:
        _validate_workbench(root, relative, report)
        _issue(
            report,
            relative,
            "reserved-workbench",
            "bundle-root index.md is reserved for navigation",
        )
    if profile and str(root.frontmatter.get("okf_version")) != "0.2":
        _issue(report, relative, "okf-version", 'root index must declare okf_version: "0.2"')
    if not any(line.startswith("# ") for line in root.body.splitlines()):
        _issue(report, relative, "index-heading", "index.md must contain an H1 heading")


def _validate_log(path: Path, vault: Path, report: ValidationReport) -> None:
    relative = _relative(path, vault)
    text = path.read_text(encoding="utf-8")
    if text.startswith(("---\n", "---\r\n")):
        _issue(report, relative, "log-frontmatter", "log.md is reserved without frontmatter")
    dates = [match.group(1) for line in text.splitlines() if (match := _DATE_HEADING.match(line))]
    if dates != sorted(dates):
        report.issues.append(
            ValidationIssue(
                relative,
                "log-order",
                "Historical dates are not chronological; preserve history and append new entries",
                severity="warning",
            )
        )
    if not any(line.startswith("# ") for line in text.splitlines()):
        _issue(report, relative, "log-heading", "log.md must contain an H1 heading")


def _valid_temporal(value: object, *, allow_date: bool) -> bool:
    if isinstance(value, datetime):
        return True
    if allow_date and isinstance(value, date):
        return True
    if not isinstance(value, str) or not value.strip():
        return False
    normalized = value.strip().replace("Z", "+00:00")
    try:
        datetime.fromisoformat(normalized)
        return True
    except ValueError:
        if not allow_date:
            return False
    try:
        date.fromisoformat(normalized)
        return True
    except ValueError:
        return False


def _valid_field_type(kind: str, value: object) -> bool:
    if kind == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if kind == "boolean":
        return isinstance(value, bool)
    if kind == "string":
        return isinstance(value, str) and bool(value.strip())
    if kind == "vault_path":
        return isinstance(value, str) and _local_reference(value) is not None
    if kind == "date":
        return (
            _valid_temporal(value, allow_date=True) and isinstance(value, str) and "T" not in value
        )
    if kind == "datetime":
        return _valid_temporal(value, allow_date=False)
    if kind == "temporal":
        return _valid_temporal(value, allow_date=True)
    if kind == "list":
        return isinstance(value, list)
    if kind == "string_list":
        if not isinstance(value, list):
            return False
        return all(isinstance(item, str) for item in cast(list[object], value))
    if kind == "vault_path_list":
        if not isinstance(value, list):
            return False
        return all(
            isinstance(item, str) and _local_reference(item) is not None
            for item in cast(list[object], value)
        )
    if kind == "mapping":
        return isinstance(value, Mapping)
    if kind == "actor_event":
        return _valid_actor_event(value)
    if kind == "actor_event_list":
        if isinstance(value, Mapping):
            return _valid_actor_event(cast(object, value))
        if not isinstance(value, list) or not value:
            return False
        events = cast(list[object], value)  # pyright: ignore[reportUnknownArgumentType]
        return all(_valid_actor_event(item) for item in events)
    if kind == "source_list":
        if not isinstance(value, list):
            return False
        for item in cast(list[object], value):
            if not isinstance(item, Mapping):
                return False
            source = cast(Mapping[object, object], item)
            resource = source.get("resource")
            if not isinstance(resource, str) or not resource.strip():
                return False
            if resource.startswith("/") and _local_reference(resource) is None:
                return False
        return True
    if kind == "source_use_list":
        if not isinstance(value, list) or not value:
            return False
        for item in cast(list[object], value):
            if not isinstance(item, Mapping):
                return False
            use = cast(Mapping[object, object], item)
            if set(use) - {"purpose", "course", "project"}:
                return False
            if use.get("purpose") not in {"study", "wiki", "reference", "undecided"}:
                return False
            for field in ("course", "project"):
                reference = use.get(field)
                if reference is not None and (
                    not isinstance(reference, str) or _local_reference(reference) is None
                ):
                    return False
        return True
    raise ContractError(f"unknown contract field type: {kind}")


def _valid_actor_event(value: object) -> bool:
    if not isinstance(value, Mapping):
        return False
    event = cast(Mapping[object, object], value)
    actor = event.get("by")
    if not isinstance(actor, str) or not actor.strip():
        return False
    return _valid_temporal(event.get("at"), allow_date=False)


def _local_reference(value: str) -> str | None:
    normalized = value.strip()
    if not normalized.startswith("/") or normalized.startswith("//"):
        return None
    if "\\" in normalized:
        return None
    relative = normalized[1:]
    parts = PurePosixPath(relative).parts
    if not relative or any(part in {"", ".", ".."} for part in parts):
        return None
    return relative


def _validate_references(
    document: OkfDocument,
    contract: ArtifactContract,
    catalog: ContractCatalog,
    vault: Path,
    relative: str,
    report: ValidationReport,
) -> None:
    field_types = {**catalog.common_field_types, **contract.field_types}
    for name, kind in field_types.items():
        value = document.frontmatter.get(name)
        if value is None:
            continue
        references: list[str] = []
        if kind == "vault_path" and isinstance(value, str):
            local = _local_reference(value)
            if local is not None:
                references.append(local)
        elif kind == "vault_path_list" and isinstance(value, list):
            for item in cast(list[object], value):
                if isinstance(item, str) and (local := _local_reference(item)):
                    references.append(local)
        elif kind == "source_list" and isinstance(value, list):
            for item in cast(list[object], value):
                if isinstance(item, Mapping):
                    resource = cast(Mapping[object, object], item).get("resource")
                    if isinstance(resource, str) and (local := _local_reference(resource)):
                        references.append(local)
        elif kind == "source_use_list" and isinstance(value, list):
            for item in cast(list[object], value):
                if not isinstance(item, Mapping):
                    continue
                use = cast(Mapping[object, object], item)
                for field in ("course", "project"):
                    reference = use.get(field)
                    if isinstance(reference, str) and (local := _local_reference(reference)):
                        references.append(local)
        for reference in references:
            if not (vault / Path(reference)).is_file():
                _issue(
                    report,
                    relative,
                    "missing-reference",
                    f"{name} references a missing Vault file: {reference}",
                )


def _validate_regions(
    document: OkfDocument,
    contract: ArtifactContract,
    relative: str,
    report: ValidationReport,
) -> None:
    for name in contract.required_ai_regions:
        start = f'<!-- ai:auto:start name="{name}" -->'
        end = f'<!-- ai:auto:end name="{name}" -->'
        if document.body.count(start) != 1 or document.body.count(end) != 1:
            _issue(
                report,
                relative,
                "managed-region",
                f"requires exactly one complete ai:auto region named {name}",
            )
    for name in contract.optional_ai_regions:
        start = f'<!-- ai:auto:start name="{name}" -->'
        end = f'<!-- ai:auto:end name="{name}" -->'
        start_count = document.body.count(start)
        end_count = document.body.count(end)
        if start_count != end_count or start_count > 1:
            _issue(
                report,
                relative,
                "managed-region",
                f"optional ai:auto region {name} must be absent or one complete pair",
            )
    for name in contract.required_human_regions:
        start = f"<!-- human:{name}:start -->"
        end = f"<!-- human:{name}:end -->"
        if document.body.count(start) != 1 or document.body.count(end) != 1:
            _issue(
                report,
                relative,
                "human-region",
                f"requires exactly one complete human region named {name}",
            )


def _validate_artifact(
    path: Path,
    vault: Path,
    report: ValidationReport,
    catalog: ContractCatalog,
) -> None:
    relative = _relative(path, vault)
    try:
        document = read_document(path)
    except (FrontmatterError, OSError) as exc:
        _issue(report, relative, "frontmatter", str(exc))
        return
    _validate_document_artifact(document, relative, vault, report, catalog)


def _validate_document_artifact(
    document: OkfDocument,
    relative: str,
    vault: Path,
    report: ValidationReport,
    catalog: ContractCatalog,
) -> None:
    if _validate_workbench(document, relative, report):
        return
    if not document.type:
        _issue(report, relative, "missing-type", "frontmatter requires a non-empty type")
        return
    contract = catalog.for_type(document.type)
    if contract is None:
        _issue(
            report,
            relative,
            "unknown-type",
            f"no Contract is installed for type: {document.type}",
        )
        return
    if not matches_contract_path(relative, contract):
        _issue(
            report,
            relative,
            "contract-path",
            f"{document.type} must match one of: {', '.join(contract.paths)}",
        )
    required = (*catalog.common_required_fields, *contract.required_fields)
    for name in dict.fromkeys(required):
        value = document.frontmatter.get(name)
        if value is None or (isinstance(value, str) and not value.strip()):
            legacy_purpose = document.frontmatter.get("purpose")
            if (
                document.type == "Source"
                and name in {"text", "uses"}
                and isinstance(legacy_purpose, str)
                and legacy_purpose.strip()
            ):
                report.issues.append(
                    ValidationIssue(
                        relative,
                        "legacy-source-use",
                        f"legacy Source without {name} is readable but should be migrated",
                        severity="warning",
                    )
                )
                continue
            _issue(report, relative, "missing-field", f"{document.type} requires field: {name}")
    for name in contract.workspace_write_fields:
        value = document.frontmatter.get(name)
        if value is None or (isinstance(value, str) and not value.strip()):
            report.issues.append(
                ValidationIssue(
                    relative,
                    "workspace-write-field",
                    (
                        f"Workspace-created {document.type} should include field: {name}; "
                        "legacy or external artifacts may remain unlabeled"
                    ),
                    severity="warning",
                )
            )
    field_types = {**catalog.common_field_types, **contract.field_types}
    for name, kind in field_types.items():
        value = document.frontmatter.get(name)
        if value is None:
            continue
        try:
            valid = _valid_field_type(kind, value)
        except ContractError as exc:
            _issue(report, relative, "contract-error", str(exc))
            continue
        if not valid:
            _issue(report, relative, "field-type", f"{name} must use Contract type {kind}")
    if document.type == "Project":
        try:
            normalize_project_category(document.frontmatter.get("project_category"))
        except ValueError as exc:
            _issue(report, relative, "project-category", str(exc))
    states = {**catalog.common_states, **contract.states}
    for name, allowed in states.items():
        value = document.frontmatter.get(name)
        if value is not None and value not in allowed:
            _issue(
                report,
                relative,
                "invalid-state",
                f"{name} must be one of: {', '.join(sorted(allowed))}",
            )
    for trigger, fields in contract.conditional_required_fields.items():
        if document.frontmatter.get(trigger) is None:
            continue
        for name in fields:
            value = document.frontmatter.get(name)
            if value is None or value == [] or (isinstance(value, str) and not value.strip()):
                _issue(
                    report,
                    relative,
                    "conditional-missing-field",
                    f"{document.type} with {trigger} requires field: {name}",
                )
    if not any(line.startswith("# ") for line in document.body.splitlines()):
        _issue(report, relative, "missing-heading", "artifact body requires an H1 heading")
    _validate_regions(document, contract, relative, report)
    _validate_references(document, contract, catalog, vault, relative, report)


def _validate_standard_artifact(
    path: Path,
    vault: Path,
    report: ValidationReport,
) -> None:
    relative = _relative(path, vault)
    try:
        document = read_document(path)
    except (FrontmatterError, OSError) as exc:
        _issue(report, relative, "frontmatter", str(exc))
        return
    if _validate_workbench(document, relative, report):
        return
    if not document.type:
        _issue(report, relative, "missing-type", "frontmatter requires a non-empty type")


def _validate_workbench(document: OkfDocument, relative: str, report: ValidationReport) -> bool:
    role = document_role(document)
    issue = workbench_issue(document)
    if issue is not None:
        _issue(report, relative, *issue)
    # Conflicting identities still undergo the normal Artifact checks.
    return role is DocumentRole.WORKBENCH or (
        role is DocumentRole.INVALID_WORKBENCH and not document.type
    )


def _validate_reserved_workbench(path: Path, root: Path, report: ValidationReport) -> bool:
    # The bundle-root index retains its reserved navigation contract.
    if path == root / "index.md":
        return False
    try:
        document = read_document(path)
    except (FrontmatterError, OSError):
        return False
    if document_role(document) is DocumentRole.ARTIFACT:
        return False
    _validate_workbench(document, _relative(path, root), report)
    return True


def _catalog(vault: Path, report: ValidationReport) -> ContractCatalog | None:
    try:
        return load_contract_catalog(vault)
    except ContractError as exc:
        _issue(report, "system/contracts", "contract-error", str(exc))
        return None


def validate_paths(
    vault: Path,
    paths: Iterable[Path | str],
    *,
    profile: bool = True,
) -> ValidationReport:
    """Validate only explicitly changed artifacts and their direct references."""

    root = vault.resolve()
    report = ValidationReport()
    catalog = _catalog(root, report) if profile else None
    if profile and catalog is None:
        return report
    for value in dict.fromkeys(str(path) for path in paths):
        candidate = Path(value)
        path = candidate if candidate.is_absolute() else root / candidate
        try:
            path = path.resolve()
            path.relative_to(root)
        except ValueError:
            _issue(report, value, "outside-vault", "validation target is outside the Vault")
            continue
        if not path.is_file():
            _issue(report, value, "missing-file", "validation target does not exist")
            continue
        report.files_checked += 1
        if _is_skipped(path, root):
            continue
        if path.name in {"index.md", "log.md"} and _validate_reserved_workbench(path, root, report):
            continue
        if path.name == "index.md":
            _validate_index(path, root, report, profile=profile)
        elif path.name == "log.md":
            _validate_log(path, root, report)
        elif catalog is not None:
            _validate_artifact(path, root, report, catalog)
        else:
            _validate_standard_artifact(path, root, report)
    return report


def validate_document(vault: Path, path: Path, document: OkfDocument) -> ValidationReport:
    """Validate a candidate Artifact before publication, without creating its file."""

    root = vault.resolve()
    report = ValidationReport()
    candidate = path if path.is_absolute() else root / path
    try:
        relative = candidate.resolve().relative_to(root).as_posix()
    except ValueError:
        _issue(report, str(path), "outside-vault", "validation target is outside the Vault")
        return report
    catalog = _catalog(root, report)
    if catalog is not None:
        report.files_checked = 1
        _validate_document_artifact(document, relative, root, report, catalog)
        if document_role(document) is DocumentRole.WORKBENCH:
            _issue(
                report,
                relative,
                "non-artifact-publication",
                "Engine Artifact publishers cannot publish Dashboard-owned workbench documents",
            )
    return report


def validate_bundle(vault: Path, *, profile: bool = True) -> ValidationReport:
    root = vault.resolve()
    report = ValidationReport()
    if not root.is_dir():
        _issue(report, ".", "missing-bundle", f"bundle directory does not exist: {root}")
        return report
    if profile and not (root / "index.md").is_file():
        _issue(report, "index.md", "missing-root-index", "bundle root requires index.md")
    catalog = _catalog(root, report) if profile else None
    if profile and catalog is None:
        return report
    for path in sorted(root.rglob("*.md")):
        if _is_skipped(path, root):
            continue
        report.files_checked += 1
        if path.name in {"index.md", "log.md"} and _validate_reserved_workbench(path, root, report):
            continue
        if path.name == "index.md":
            _validate_index(path, root, report, profile=profile)
        elif path.name == "log.md":
            _validate_log(path, root, report)
        elif catalog is not None:
            _validate_artifact(path, root, report, catalog)
        else:
            _validate_standard_artifact(path, root, report)
    return report
