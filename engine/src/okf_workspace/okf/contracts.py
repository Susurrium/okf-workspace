"""Load the single machine-readable contract for every OKF artifact."""

from __future__ import annotations

import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import cast

from ruamel.yaml import YAML

from okf_workspace.config import default_template_root


class ContractError(ValueError):
    """Raised when the installed contract catalog is incomplete or malformed."""


_FIELD_TYPES = {
    "actor_event",
    "actor_event_list",
    "boolean",
    "date",
    "datetime",
    "list",
    "mapping",
    "source_list",
    "source_use_list",
    "string",
    "string_list",
    "temporal",
    "vault_path",
    "vault_path_list",
}


@dataclass(frozen=True, slots=True)
class ArtifactContract:
    artifact: str
    paths: tuple[str, ...]
    required_fields: tuple[str, ...]
    workspace_write_fields: tuple[str, ...]
    field_types: Mapping[str, str]
    states: Mapping[str, frozenset[str]]
    conditional_required_fields: Mapping[str, tuple[str, ...]]
    required_ai_regions: tuple[str, ...]
    optional_ai_regions: tuple[str, ...]
    required_human_regions: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class ContractCatalog:
    version: int
    profile: str
    okf_version: str
    common_required_fields: tuple[str, ...]
    common_field_types: Mapping[str, str]
    common_states: Mapping[str, frozenset[str]]
    artifacts: Mapping[str, ArtifactContract]

    def for_type(self, artifact: str) -> ArtifactContract | None:
        return self.artifacts.get(artifact)


def contract_root(vault: Path) -> Path:
    local = vault.resolve() / "system" / "contracts"
    if (local / "base.yaml").is_file():
        return local
    bundled = default_template_root() / "system" / "contracts"
    if (bundled / "base.yaml").is_file():
        return bundled
    raise ContractError("system/contracts/base.yaml is missing")


def _mapping(value: object, *, source: Path, field: str) -> Mapping[str, object]:
    if not isinstance(value, Mapping):
        raise ContractError(f"{source}: {field} must be a YAML mapping")
    untyped = cast(Mapping[object, object], value)
    if not all(isinstance(key, str) for key in untyped):
        raise ContractError(f"{source}: {field} keys must be strings")
    return cast(Mapping[str, object], untyped)


def _strings(value: object, *, source: Path, field: str) -> tuple[str, ...]:
    if value is None:
        return ()
    if not isinstance(value, list):
        raise ContractError(f"{source}: {field} must be a list of strings")
    items = cast(list[object], value)
    if not all(isinstance(item, str) for item in items):
        raise ContractError(f"{source}: {field} must be a list of strings")
    return tuple(cast(list[str], items))


def _field_types(value: object, *, source: Path) -> dict[str, str]:
    mapping = _mapping(value or {}, source=source, field="field_types")
    result: dict[str, str] = {}
    for key, kind in mapping.items():
        if not isinstance(kind, str):
            raise ContractError(f"{source}: field_types entries must be strings")
        if kind not in _FIELD_TYPES:
            raise ContractError(f"{source}: unknown field type {kind!r} for {key}")
        result[key] = kind
    return result


def _states(value: object, *, source: Path) -> dict[str, frozenset[str]]:
    mapping = _mapping(value or {}, source=source, field="states")
    result: dict[str, frozenset[str]] = {}
    for key, values in mapping.items():
        allowed = frozenset(_strings(values, source=source, field=f"states.{key}"))
        if not allowed:
            raise ContractError(f"{source}: states.{key} must not be empty")
        result[key] = allowed
    return result


def _conditional_required_fields(value: object, *, source: Path) -> dict[str, tuple[str, ...]]:
    mapping = _mapping(value or {}, source=source, field="conditional_required_fields")
    return {
        key: _strings(
            fields,
            source=source,
            field=f"conditional_required_fields.{key}",
        )
        for key, fields in mapping.items()
    }


def _validate_paths(paths: tuple[str, ...], *, source: Path) -> None:
    for pattern in paths:
        candidate = Path(pattern)
        if (
            pattern.startswith(("/", "\\"))
            or ".." in candidate.parts
            or not pattern.endswith(".md")
        ):
            raise ContractError(
                f"{source}: paths must be safe Vault-relative Markdown patterns: {pattern}"
            )
        try:
            path_pattern_regex(pattern)
        except re.error as exc:
            raise ContractError(f"{source}: invalid path pattern {pattern}: {exc}") from exc


def _validate_shape(
    *,
    source: Path,
    required_fields: tuple[str, ...],
    field_types: Mapping[str, str],
    states: Mapping[str, frozenset[str]],
    inherited_types: Mapping[str, str] | None = None,
) -> None:
    available = {**(inherited_types or {}), **field_types}
    for field in required_fields:
        if field not in available:
            raise ContractError(f"{source}: required field {field!r} must declare a field type")
    for field in states:
        if available.get(field) != "string":
            raise ContractError(f"{source}: state field {field!r} must declare field type string")


def _load(path: Path) -> Mapping[str, object]:
    yaml = YAML(typ="safe")
    load = cast(Callable[[str], object], yaml.load)  # pyright: ignore[reportUnknownMemberType]
    try:
        loaded = load(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise ContractError(f"{path}: invalid contract YAML: {exc}") from exc
    return _mapping(loaded, source=path, field="document")


def load_contract_catalog(vault: Path) -> ContractCatalog:
    root = contract_root(vault)
    base_path = root / "base.yaml"
    base = _load(base_path)
    version = base.get("contract_version")
    if not isinstance(version, int) or isinstance(version, bool) or version < 1:
        raise ContractError(f"{base_path}: contract_version must be a positive integer")
    if base.get("authority") != "markdown":
        raise ContractError(f"{base_path}: authority must be markdown")
    profile = base.get("profile")
    okf_version = base.get("okf_version")
    if not isinstance(profile, str) or not profile.strip():
        raise ContractError(f"{base_path}: profile must be a non-empty string")
    if not isinstance(okf_version, str) or okf_version != "0.2":
        raise ContractError(f'{base_path}: okf_version must equal "0.2"')
    common_required = _strings(
        base.get("common_required_fields"),
        source=base_path,
        field="common_required_fields",
    )
    common_types = _field_types(base.get("common_field_types"), source=base_path)
    common_states = _states(base.get("common_states"), source=base_path)
    _validate_shape(
        source=base_path,
        required_fields=common_required,
        field_types=common_types,
        states=common_states,
    )
    artifacts: dict[str, ArtifactContract] = {}
    for path in sorted(root.glob("*.yaml")):
        if path.name == "base.yaml":
            continue
        payload = _load(path)
        if payload.get("contract_version") != version:
            raise ContractError(f"{path}: contract_version must equal {version}")
        if payload.get("authority") != "markdown":
            raise ContractError(f"{path}: authority must be markdown")
        artifact = payload.get("artifact")
        if not isinstance(artifact, str) or not artifact.strip():
            raise ContractError(f"{path}: artifact must be a non-empty string")
        if artifact in artifacts:
            raise ContractError(f"{path}: duplicate artifact contract for {artifact}")
        regions = _mapping(payload.get("regions") or {}, source=path, field="regions")
        paths = _strings(payload.get("paths"), source=path, field="paths")
        if not paths:
            raise ContractError(f"{path}: paths must not be empty")
        _validate_paths(paths, source=path)
        required_fields = _strings(
            payload.get("required_fields"), source=path, field="required_fields"
        )
        workspace_write_fields = _strings(
            payload.get("workspace_write_fields"),
            source=path,
            field="workspace_write_fields",
        )
        field_types = _field_types(payload.get("field_types"), source=path)
        states = _states(payload.get("states"), source=path)
        conditional_required = _conditional_required_fields(
            payload.get("conditional_required_fields"), source=path
        )
        _validate_shape(
            source=path,
            required_fields=(*required_fields, *workspace_write_fields),
            field_types=field_types,
            states=states,
            inherited_types=common_types,
        )
        available_types = {**common_types, **field_types}
        for trigger, fields in conditional_required.items():
            if trigger not in available_types:
                raise ContractError(
                    f"{path}: conditional trigger {trigger!r} must declare a field type"
                )
            for field in fields:
                if field not in available_types:
                    raise ContractError(
                        f"{path}: conditional field {field!r} must declare a field type"
                    )
        required_ai = _strings(regions.get("required_ai"), source=path, field="regions.required_ai")
        optional_ai = _strings(regions.get("optional_ai"), source=path, field="regions.optional_ai")
        required_human = _strings(
            regions.get("required_human"),
            source=path,
            field="regions.required_human",
        )
        all_regions = (*required_ai, *optional_ai, *required_human)
        if len(all_regions) != len(set(all_regions)):
            raise ContractError(f"{path}: managed region names must be unique")
        artifacts[artifact] = ArtifactContract(
            artifact=artifact,
            paths=paths,
            required_fields=required_fields,
            workspace_write_fields=workspace_write_fields,
            field_types=field_types,
            states=states,
            conditional_required_fields=conditional_required,
            required_ai_regions=required_ai,
            optional_ai_regions=optional_ai,
            required_human_regions=required_human,
        )
    if not artifacts:
        raise ContractError(f"{root}: no artifact contracts found")
    return ContractCatalog(
        version=version,
        profile=profile,
        okf_version=okf_version,
        common_required_fields=common_required,
        common_field_types=common_types,
        common_states=common_states,
        artifacts=artifacts,
    )


_PATH_TOKENS: tuple[tuple[str, str], ...] = (
    ("YYYY-MM-DD", r"\d{4}-\d{2}-\d{2}"),
    ("HHMMSS", r"\d{6}"),
    ("YYYY", r"\d{4}"),
    ("MM", r"\d{2}"),
    ("Www", r"W\d{2}"),
)


def path_pattern_regex(pattern: str) -> re.Pattern[str]:
    """Translate the intentionally small path notation used by contracts."""

    cursor = 0
    pieces: list[str] = []
    token = re.compile(r"<([a-zA-Z][a-zA-Z0-9_-]*)>|YYYY-MM-DD|HHMMSS|YYYY|MM|Www")
    replacements = dict(_PATH_TOKENS)
    for match in token.finditer(pattern):
        pieces.append(re.escape(pattern[cursor : match.start()]))
        value = match.group(0)
        if value.startswith("<"):
            pieces.append(r".+" if match.group(1) == "path" else r"[^/]+")
        else:
            pieces.append(replacements[value])
        cursor = match.end()
    pieces.append(re.escape(pattern[cursor:]))
    return re.compile("^" + "".join(pieces) + "$")


def matches_contract_path(relative: str, contract: ArtifactContract) -> bool:
    return any(path_pattern_regex(pattern).fullmatch(relative) for pattern in contract.paths)
