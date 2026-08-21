#!/usr/bin/env python3
"""Fail-closed validation for the MarkItDown Compose network topology."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

SCRIPT_DIRECTORY = Path(__file__).resolve().parent
MAX_CONFIG_BYTES = 4 * 1024 * 1024
EXPECTED_SERVICES = {"api", "worker"}
INTERNAL_NETWORK = "api-internal"
HOST_NAMESPACE_FIELDS = (
    "network_mode",
    "pid",
    "ipc",
    "uts",
    "cgroup",
    "userns_mode",
)


class ComposeVerificationError(RuntimeError):
    """Raised when Compose output cannot be loaded or safely validated."""


def _decode_json(payload: bytes, *, source: str) -> dict[str, Any]:
    if len(payload) > MAX_CONFIG_BYTES:
        raise ComposeVerificationError(
            f"{source} exceeds the {MAX_CONFIG_BYTES}-byte validation limit"
        )
    try:
        text = payload.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ComposeVerificationError(f"{source} is not valid UTF-8") from exc
    try:
        value = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ComposeVerificationError(
            f"{source} is not valid JSON at line {exc.lineno}, column {exc.colno}: {exc.msg}"
        ) from exc
    if not isinstance(value, dict):
        raise ComposeVerificationError(f"{source} root must be a JSON object")
    return value


def _read_config_file(path: Path) -> dict[str, Any]:
    try:
        if path.is_symlink() or not path.is_file():
            raise ComposeVerificationError(
                f"config JSON path must be a regular, non-symlink file: {path}"
            )
        return _decode_json(path.read_bytes(), source=str(path))
    except ComposeVerificationError:
        raise
    except OSError as exc:
        raise ComposeVerificationError(f"cannot read config JSON file {path}: {exc}") from exc


def _render_compose_config() -> dict[str, Any]:
    command = ["docker", "compose", "config", "--format", "json"]
    try:
        completed = subprocess.run(
            command,
            cwd=SCRIPT_DIRECTORY,
            check=False,
            capture_output=True,
            timeout=30,
        )
    except FileNotFoundError as exc:
        raise ComposeVerificationError("docker executable is unavailable") from exc
    except subprocess.TimeoutExpired as exc:
        raise ComposeVerificationError("docker compose config timed out after 30 seconds") from exc
    except OSError as exc:
        raise ComposeVerificationError(f"cannot run docker compose config: {exc}") from exc

    if completed.returncode != 0:
        detail = completed.stderr.decode("utf-8", errors="replace").strip()
        if len(detail) > 2000:
            detail = detail[-2000:]
        suffix = f": {detail}" if detail else ""
        raise ComposeVerificationError(
            f"docker compose config exited with status {completed.returncode}{suffix}"
        )
    return _decode_json(completed.stdout, source="docker compose config output")


def _mapping(value: object, *, label: str, issues: list[str]) -> Mapping[str, Any] | None:
    if not isinstance(value, Mapping):
        issues.append(f"{label} must be an object")
        return None
    if not all(isinstance(key, str) for key in value):
        issues.append(f"{label} contains a non-string key")
        return None
    return value


def _network_names(
    service: Mapping[str, Any], *, service_name: str, issues: list[str]
) -> set[str] | None:
    value = service.get("networks")
    if isinstance(value, Mapping):
        if not all(isinstance(key, str) for key in value):
            issues.append(f"service {service_name!r} networks contain a non-string name")
            return None
        return set(value)
    if isinstance(value, list) and all(isinstance(item, str) for item in value):
        return set(value)
    if value is None:
        return set()
    issues.append(f"service {service_name!r} networks must be an object or string array")
    return None


def _validate_no_host_privilege(
    service: Mapping[str, Any], *, service_name: str, issues: list[str]
) -> None:
    privileged = service.get("privileged")
    if privileged not in (None, False):
        issues.append(f"service {service_name!r} must not enable privileged mode")

    cap_add = service.get("cap_add")
    if cap_add is not None:
        if not isinstance(cap_add, list):
            issues.append(f"service {service_name!r} cap_add must be an array when present")
        elif cap_add:
            issues.append(f"service {service_name!r} must not add Linux capabilities")

    for field in HOST_NAMESPACE_FIELDS:
        value = service.get(field)
        if isinstance(value, str) and value.strip().lower() == "host":
            issues.append(f"service {service_name!r} must not use host {field}")


def _validate_no_ports(
    service: Mapping[str, Any], *, service_name: str, issues: list[str]
) -> None:
    ports = service.get("ports")
    if ports is None:
        return
    if not isinstance(ports, list):
        issues.append(f"service {service_name!r} ports must be an array when present")
    elif ports:
        issues.append(f"service {service_name!r} must not publish host ports")


def validate_config(config: Mapping[str, Any]) -> list[str]:
    """Return every violation of the fixed API/worker Compose topology."""

    issues: list[str] = []
    services = _mapping(config.get("services"), label="services", issues=issues)
    networks = _mapping(config.get("networks"), label="networks", issues=issues)

    if services is not None:
        actual_services = set(services)
        missing = sorted(EXPECTED_SERVICES - actual_services)
        unexpected = sorted(actual_services - EXPECTED_SERVICES)
        if missing:
            issues.append(f"services are missing required entries: {', '.join(missing)}")
        if unexpected:
            issues.append(f"services contain unexpected entries: {', '.join(unexpected)}")

        for service_name in sorted(EXPECTED_SERVICES & actual_services):
            service = _mapping(
                services[service_name],
                label=f"service {service_name!r}",
                issues=issues,
            )
            if service is None:
                continue
            _validate_no_host_privilege(
                service,
                service_name=service_name,
                issues=issues,
            )
            _validate_no_ports(service, service_name=service_name, issues=issues)

            attached_networks = _network_names(
                service,
                service_name=service_name,
                issues=issues,
            )
            if service_name == "api":
                if service.get("network_mode") not in (None, ""):
                    issues.append("service 'api' must use networks, not network_mode")
                if attached_networks is not None and attached_networks != {INTERNAL_NETWORK}:
                    actual = ", ".join(sorted(attached_networks)) or "none"
                    issues.append(
                        "service 'api' must connect only to "
                        f"{INTERNAL_NETWORK!r} (found: {actual})"
                    )
            elif service_name == "worker":
                if service.get("network_mode") != "none":
                    issues.append("service 'worker' network_mode must be exactly 'none'")
                if attached_networks:
                    actual = ", ".join(sorted(attached_networks))
                    issues.append(f"service 'worker' must not attach networks (found: {actual})")

    if networks is not None:
        internal_network = networks.get(INTERNAL_NETWORK)
        network_config = _mapping(
            internal_network,
            label=f"network {INTERNAL_NETWORK!r}",
            issues=issues,
        )
        if network_config is not None and network_config.get("internal") is not True:
            issues.append(f"network {INTERNAL_NETWORK!r} must set internal to true")

    return issues


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Verify the rendered MarkItDown Compose security topology."
    )
    parser.add_argument(
        "--config-json",
        type=Path,
        help="validate an existing rendered Compose JSON file instead of invoking Docker",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        config = (
            _read_config_file(args.config_json)
            if args.config_json is not None
            else _render_compose_config()
        )
        issues = validate_config(config)
    except ComposeVerificationError as exc:
        print(f"COMPOSE VERIFY FAILED: {exc}", file=sys.stderr)
        return 1

    if issues:
        print("COMPOSE VERIFY FAILED: rendered topology is unsafe:", file=sys.stderr)
        for issue in issues:
            print(f"- {issue}", file=sys.stderr)
        return 1

    print(
        "Compose topology verified: api is internal-only, worker has no network, "
        "and no service publishes ports or enables host privilege."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
