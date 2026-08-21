#!/usr/bin/env python3
"""Fail-closed verification of the MarkItDown Docker runtime topology."""

from __future__ import annotations

import argparse
import ipaddress
import json
import re
import subprocess
import sys
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import cast

PROJECT_NAME = "obsidian-markitdown-fallback"
API_SERVICE = "api"
WORKER_SERVICE = "worker"
API_NETWORK = f"{PROJECT_NAME}_api-internal"
CONTAINER_ID_PATTERN = re.compile(r"^[0-9a-f]{64}$")
COMMAND_TIMEOUT_SECONDS = 30
MAX_COMMAND_OUTPUT_CHARS = 8 * 1024 * 1024

Command = tuple[str, ...]
CommandRunner = Callable[[Command, Path], str]
JsonObject = dict[str, object]


class TopologyError(RuntimeError):
    """Raised when Docker state does not match the required project topology."""


def _run_command(command: Command, cwd: Path) -> str:
    try:
        completed = subprocess.run(
            command,
            cwd=cwd,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            check=False,
            text=True,
            encoding="utf-8",
            errors="strict",
            timeout=COMMAND_TIMEOUT_SECONDS,
        )
    except FileNotFoundError as exc:
        raise TopologyError(f"required command is unavailable: {command[0]}") from exc
    except subprocess.TimeoutExpired as exc:
        raise TopologyError(f"Docker command timed out: {' '.join(command[:4])}") from exc
    except UnicodeError as exc:
        raise TopologyError("Docker returned non-UTF-8 output") from exc

    if completed.returncode != 0:
        detail = " ".join(completed.stderr.splitlines()).strip()
        if len(detail) > 800:
            detail = detail[:800] + "..."
        suffix = f": {detail}" if detail else ""
        raise TopologyError(f"Docker command failed ({' '.join(command[:4])}){suffix}")
    if len(completed.stdout) > MAX_COMMAND_OUTPUT_CHARS:
        raise TopologyError("Docker command output exceeds the verification limit")
    if "\x00" in completed.stdout:
        raise TopologyError("Docker command output contains a NUL byte")
    return completed.stdout


def _json_object(value: object, location: str) -> JsonObject:
    if not isinstance(value, dict) or any(not isinstance(key, str) for key in value):
        raise TopologyError(f"{location} must be a JSON object")
    return cast(JsonObject, value)


def _inspect_object(
    command: Command,
    *,
    cwd: Path,
    runner: CommandRunner,
    location: str,
) -> JsonObject:
    output = runner(command, cwd)
    try:
        decoded = json.loads(output)
    except json.JSONDecodeError as exc:
        raise TopologyError(f"{location} inspect output is not valid JSON") from exc
    if not isinstance(decoded, list) or len(decoded) != 1:
        raise TopologyError(f"{location} inspect must return exactly one object")
    return _json_object(decoded[0], f"{location} inspect entry")


def _compose_container_id(service: str, *, cwd: Path, runner: CommandRunner) -> str:
    output = runner(
        ("docker", "compose", "ps", "--all", "--quiet", service),
        cwd,
    )
    identifiers = [line.strip() for line in output.splitlines() if line.strip()]
    if len(identifiers) != 1:
        raise TopologyError(
            f"Compose service {service!r} must have exactly one container "
            f"(found {len(identifiers)})"
        )
    container_id = identifiers[0]
    if CONTAINER_ID_PATTERN.fullmatch(container_id) is None:
        raise TopologyError(f"Compose service {service!r} returned an unsafe container ID")
    return container_id


def _require_empty_mapping(value: object, location: str) -> None:
    if value is None:
        return
    mapping = _json_object(value, location)
    if mapping:
        raise TopologyError(f"{location} must be empty")


def _validate_container_identity(
    container: JsonObject,
    *,
    container_id: str,
    service: str,
) -> str:
    if container.get("Id") != container_id:
        raise TopologyError(f"{service} inspect returned a different container ID")

    config = _json_object(container.get("Config"), f"{service} Config")
    labels = _json_object(config.get("Labels"), f"{service} Compose labels")
    if labels.get("com.docker.compose.project") != PROJECT_NAME:
        raise TopologyError(f"{service} does not belong to project {PROJECT_NAME}")
    if labels.get("com.docker.compose.service") != service:
        raise TopologyError(f"{service} container has the wrong Compose service label")

    state = _json_object(container.get("State"), f"{service} State")
    if state.get("Status") != "running" or state.get("Running") is not True:
        raise TopologyError(f"{service} container is not running")

    name = container.get("Name")
    if not isinstance(name, str) or not name.startswith("/") or len(name) < 2:
        raise TopologyError(f"{service} container has an invalid name")
    return name[1:]


def _validate_api_container(
    container: JsonObject,
    *,
    container_id: str,
) -> tuple[str, ipaddress.IPv4Address, int, str, str]:
    container_name = _validate_container_identity(
        container,
        container_id=container_id,
        service=API_SERVICE,
    )
    host_config = _json_object(container.get("HostConfig"), "api HostConfig")
    _require_empty_mapping(host_config.get("PortBindings"), "api PortBindings")
    if host_config.get("NetworkMode") != API_NETWORK:
        raise TopologyError(f"api NetworkMode must be {API_NETWORK}")

    network_settings = _json_object(container.get("NetworkSettings"), "api NetworkSettings")
    networks = _json_object(network_settings.get("Networks"), "api Networks")
    if set(networks) != {API_NETWORK}:
        raise TopologyError(f"api must be attached only to {API_NETWORK}")
    endpoint = _json_object(networks[API_NETWORK], "api internal-network endpoint")
    if endpoint.get("Gateway") != "":
        raise TopologyError("api internal-network endpoint Gateway must be empty")

    raw_ip = endpoint.get("IPAddress")
    if not isinstance(raw_ip, str):
        raise TopologyError("api internal-network endpoint has no IPv4 address")
    try:
        api_ip = ipaddress.IPv4Address(raw_ip)
    except ipaddress.AddressValueError as exc:
        raise TopologyError("api internal-network endpoint has an invalid IPv4 address") from exc
    if (
        not api_ip.is_private
        or api_ip.is_global
        or api_ip.is_reserved
        or api_ip.is_unspecified
        or api_ip.is_loopback
        or api_ip.is_link_local
        or api_ip.is_multicast
    ):
        raise TopologyError(
            "api internal-network endpoint IPv4 address must be private and non-reserved"
        )

    prefix_length = endpoint.get("IPPrefixLen")
    if (
        isinstance(prefix_length, bool)
        or not isinstance(prefix_length, int)
        or not 1 <= prefix_length <= 32
    ):
        raise TopologyError("api internal-network endpoint has an invalid IPv4 prefix length")
    network_id = endpoint.get("NetworkID")
    endpoint_id = endpoint.get("EndpointID")
    if not isinstance(network_id, str) or not network_id:
        raise TopologyError("api internal-network endpoint has no network ID")
    if not isinstance(endpoint_id, str) or not endpoint_id:
        raise TopologyError("api internal-network endpoint has no endpoint ID")
    return container_name, api_ip, prefix_length, network_id, endpoint_id


def _validate_worker_networks(value: object) -> None:
    """Reject real Worker networks while accepting Docker's inert ``none`` endpoint."""

    networks = _json_object(value, "worker Networks")
    if not networks:
        return
    if set(networks) != {"none"}:
        raise TopologyError("worker Networks must be empty or contain only the none endpoint")
    endpoint = _json_object(networks["none"], "worker none endpoint")
    for field in ("Gateway", "IPAddress", "IPv6Gateway", "GlobalIPv6Address"):
        if endpoint.get(field) != "":
            raise TopologyError(f"worker none endpoint {field} must be empty")
    for field in ("IPPrefixLen", "GlobalIPv6PrefixLen"):
        if endpoint.get(field) != 0:
            raise TopologyError(f"worker none endpoint {field} must be zero")


def _validate_worker_container(container: JsonObject, *, container_id: str) -> None:
    _validate_container_identity(
        container,
        container_id=container_id,
        service=WORKER_SERVICE,
    )
    host_config = _json_object(container.get("HostConfig"), "worker HostConfig")
    if host_config.get("NetworkMode") != "none":
        raise TopologyError("worker NetworkMode must be none")
    _require_empty_mapping(host_config.get("PortBindings"), "worker PortBindings")

    network_settings = _json_object(container.get("NetworkSettings"), "worker NetworkSettings")
    _require_empty_mapping(network_settings.get("Ports"), "worker runtime Ports")
    _validate_worker_networks(network_settings.get("Networks"))


def _validate_api_network(
    network: JsonObject,
    *,
    api_container_id: str,
    api_container_name: str,
    api_ip: ipaddress.IPv4Address,
    api_prefix_length: int,
    api_network_id: str,
    api_endpoint_id: str,
) -> None:
    if network.get("Name") != API_NETWORK:
        raise TopologyError(f"network name must be {API_NETWORK}")
    if network.get("Id") != api_network_id:
        raise TopologyError("api endpoint refers to a different network ID")
    if network.get("Driver") != "bridge":
        raise TopologyError("api internal network driver must be bridge")
    if network.get("Internal") is not True:
        raise TopologyError("api internal network must have Internal=true")

    containers = _json_object(network.get("Containers"), "api internal-network members")
    if set(containers) != {api_container_id}:
        raise TopologyError("api internal network must contain only the api container")
    member = _json_object(containers[api_container_id], "api network-member record")
    if member.get("Name") != api_container_name:
        raise TopologyError("api network-member name does not match the inspected container")
    if member.get("EndpointID") != api_endpoint_id:
        raise TopologyError("api network-member endpoint ID does not match the container")

    raw_member_ip = member.get("IPv4Address")
    if not isinstance(raw_member_ip, str):
        raise TopologyError("api network-member record has no IPv4 interface")
    try:
        member_interface = ipaddress.IPv4Interface(raw_member_ip)
    except ipaddress.AddressValueError as exc:
        raise TopologyError("api network-member record has an invalid IPv4 interface") from exc
    if member_interface.ip != api_ip or member_interface.network.prefixlen != api_prefix_length:
        raise TopologyError("api network-member IPv4 interface does not match its endpoint")


def verify_runtime_topology(
    *,
    cwd: Path,
    runner: CommandRunner = _run_command,
) -> ipaddress.IPv4Address:
    """Verify the exact project topology and return the API's internal IPv4 address."""

    api_container_id = _compose_container_id(API_SERVICE, cwd=cwd, runner=runner)
    worker_container_id = _compose_container_id(WORKER_SERVICE, cwd=cwd, runner=runner)
    if api_container_id == worker_container_id:
        raise TopologyError("api and worker resolved to the same container")

    api_container = _inspect_object(
        ("docker", "inspect", "--type", "container", api_container_id),
        cwd=cwd,
        runner=runner,
        location="api container",
    )
    worker_container = _inspect_object(
        ("docker", "inspect", "--type", "container", worker_container_id),
        cwd=cwd,
        runner=runner,
        location="worker container",
    )
    api_name, api_ip, prefix_length, network_id, endpoint_id = _validate_api_container(
        api_container,
        container_id=api_container_id,
    )
    _validate_worker_container(worker_container, container_id=worker_container_id)

    api_network = _inspect_object(
        ("docker", "network", "inspect", API_NETWORK),
        cwd=cwd,
        runner=runner,
        location="api internal network",
    )
    _validate_api_network(
        api_network,
        api_container_id=api_container_id,
        api_container_name=api_name,
        api_ip=api_ip,
        api_prefix_length=prefix_length,
        api_network_id=network_id,
        api_endpoint_id=endpoint_id,
    )
    return api_ip


def _validated_working_directory() -> Path:
    try:
        working_directory = Path.cwd().resolve(strict=True)
        script_directory = Path(__file__).resolve(strict=True).parent
    except OSError as exc:
        raise TopologyError("cannot resolve the deployment working directory") from exc
    if working_directory != script_directory:
        raise TopologyError(f"run this verifier from its deployment directory: {script_directory}")
    compose_file = working_directory / "compose.yaml"
    if compose_file.is_symlink() or not compose_file.is_file():
        raise TopologyError("current directory has no safe compose.yaml")
    return working_directory


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Verify the isolated obsidian-markitdown-fallback Docker topology."
    )
    parser.add_argument(
        "--print-api-ip",
        action="store_true",
        help="print only the verified API internal IPv4 address",
    )
    args = parser.parse_args(argv)

    try:
        working_directory = _validated_working_directory()
        api_ip = verify_runtime_topology(cwd=working_directory)
    except (OSError, TopologyError) as exc:
        print(f"TOPOLOGY VERIFY FAILED: {exc}", file=sys.stderr)
        return 1

    if args.print_api_ip:
        print(api_ip)
    else:
        print(
            "Runtime topology verified: "
            f"project={PROJECT_NAME} api_ip={api_ip} "
            f"api_network={API_NETWORK} worker_network=none"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
