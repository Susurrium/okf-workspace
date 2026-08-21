#!/usr/bin/env python3
"""Guard MinerU's Linux process session and ephemeral server artifacts."""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import signal
import stat
import sys
import time
import urllib.request
from contextlib import suppress
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path

STATE_SCHEMA = 2
SESSION_NAME = re.compile(r"^session-[A-Za-z0-9._-]+$")
LEGACY_TASK_NAME = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
)
RPC_NAME = re.compile(r"^vllm-rpc-[1-9][0-9]*$")


class GuardError(RuntimeError):
    pass


@dataclass(frozen=True)
class ProcessInfo:
    pid: int
    uid: int
    pgrp: int
    session: int
    starttime: int
    cmdline: str


@dataclass(frozen=True)
class ServiceState:
    schema: int
    pid: int
    uid: int
    pgrp: int
    session: int
    starttime: int
    output_root: str
    rpc_root: str
    log_file: str
    created_at: str


def process_info(pid: int) -> ProcessInfo | None:
    proc = Path("/proc") / str(pid)
    try:
        raw = (proc / "stat").read_text(encoding="ascii")
        remainder = raw[raw.rfind(")") + 2 :].split()
        status = (proc / "status").read_text(encoding="ascii")
        uid_line = next(line for line in status.splitlines() if line.startswith("Uid:"))
        uid = int(uid_line.split()[1])
        cmdline = (proc / "cmdline").read_bytes().replace(b"\0", b" ").decode(
            "utf-8", errors="replace"
        )
    except (FileNotFoundError, PermissionError, StopIteration, ValueError):
        return None
    return ProcessInfo(
        pid=pid,
        uid=uid,
        pgrp=int(remainder[2]),
        session=int(remainder[3]),
        starttime=int(remainder[19]),
        cmdline=cmdline.strip(),
    )


def session_members(session_id: int) -> list[ProcessInfo]:
    members: list[ProcessInfo] = []
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        info = process_info(int(entry.name))
        if info is not None and info.session == session_id:
            members.append(info)
    return sorted(members, key=lambda item: item.pid)


def _validate_state_file(path: Path) -> None:
    try:
        metadata = path.lstat()
    except FileNotFoundError as exc:
        raise GuardError(f"service state does not exist: {path}") from exc
    if not stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
        raise GuardError(f"service state is not a regular file: {path}")
    if metadata.st_uid != os.getuid():
        raise GuardError(f"service state is not owned by uid {os.getuid()}: {path}")
    if metadata.st_mode & 0o077:
        raise GuardError(f"service state permissions are too broad: {path}")
    if metadata.st_size > 16_384:
        raise GuardError(f"service state is unexpectedly large: {path}")


def load_state(path: Path) -> ServiceState:
    _validate_state_file(path)
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        state = ServiceState(**payload)
    except (OSError, json.JSONDecodeError, TypeError) as exc:
        raise GuardError(f"invalid service state: {path}") from exc
    if state.schema != STATE_SCHEMA:
        raise GuardError(f"unsupported service-state schema: {state.schema}")
    if min(state.pid, state.uid, state.pgrp, state.session, state.starttime) < 1:
        raise GuardError("service state contains invalid process identity")
    return state


def write_state(
    path: Path,
    pid: int,
    output_root: Path,
    rpc_root: Path,
    log_file: Path,
) -> None:
    info = process_info(pid)
    if info is None:
        raise GuardError(f"process disappeared before state could be written: {pid}")
    if info.uid != os.getuid():
        raise GuardError(f"process {pid} is not owned by this user")
    if info.pid != info.pgrp or info.pid != info.session:
        raise GuardError("run-api.sh must be launched as a new session and process-group leader")
    if "run-api.sh" not in info.cmdline:
        raise GuardError(f"process {pid} is not run-api.sh")
    state = ServiceState(
        schema=STATE_SCHEMA,
        pid=pid,
        uid=info.uid,
        pgrp=info.pgrp,
        session=info.session,
        starttime=info.starttime,
        output_root=str(output_root.resolve(strict=True)),
        rpc_root=str(rpc_root.resolve(strict=True)),
        log_file=str(log_file.resolve(strict=True)),
        created_at=datetime.now(UTC).isoformat(),
    )
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{pid}.tmp")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    fd = os.open(temporary, flags, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(asdict(state), handle, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        with suppress(FileNotFoundError):
            temporary.unlink()


def validate_live_state(
    state: ServiceState, *, allow_missing_leader: bool = True
) -> list[ProcessInfo]:
    members = session_members(state.session)
    wrong_owner = [member.pid for member in members if member.uid != state.uid]
    if wrong_owner:
        raise GuardError(f"session contains processes owned by another uid: {wrong_owner}")
    leader = process_info(state.pid)
    if leader is not None:
        if (
            leader.uid != state.uid
            or leader.starttime != state.starttime
            or leader.session != state.session
            or leader.pgrp != state.pgrp
            or "run-api.sh" not in leader.cmdline
        ):
            raise GuardError("recorded PID has been reused or no longer identifies run-api.sh")
    elif not allow_missing_leader:
        raise GuardError("run-api.sh leader is no longer alive")
    return members


def remove_matching_state(path: Path, expected: ServiceState) -> None:
    try:
        current = load_state(path)
    except GuardError:
        return
    if current.pid == expected.pid and current.starttime == expected.starttime:
        path.unlink(missing_ok=True)


def clear_state_for_process(path: Path, pid: int) -> None:
    state = load_state(path)
    info = process_info(pid)
    if info is None:
        raise GuardError(f"cannot validate state owner process {pid}")
    if (
        state.pid != pid
        or state.starttime != info.starttime
        or state.uid != info.uid
        or state.session != info.session
    ):
        raise GuardError("service state does not belong to the requesting process")
    remaining = [
        member.pid
        for member in session_members(state.session)
        if member.pid not in {pid, os.getpid()}
    ]
    if remaining:
        raise GuardError(f"refusing to clear state while session members remain: {remaining}")
    purge_rpc_root(Path(state.rpc_root), path.parent, state.pid)
    path.unlink(missing_ok=True)


def _signal_session(state: ServiceState, sig: signal.Signals) -> None:
    members = validate_live_state(state)
    groups = sorted({member.pgrp for member in members}, reverse=True)
    for group in groups:
        with suppress(ProcessLookupError):
            os.killpg(group, sig)


def _wait_for_session_exit(state: ServiceState, timeout: float) -> list[ProcessInfo]:
    deadline = time.monotonic() + timeout
    while True:
        members = session_members(state.session)
        if not members or time.monotonic() >= deadline:
            return members
        time.sleep(0.25)


def _safe_output_target(target: Path, output_parent: Path) -> Path:
    parent = output_parent.resolve(strict=True)
    try:
        metadata = target.lstat()
    except FileNotFoundError:
        return target
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
        raise GuardError(f"refusing to remove non-directory or symlink output: {target}")
    resolved = target.resolve(strict=True)
    if resolved.parent != parent or not SESSION_NAME.fullmatch(resolved.name):
        raise GuardError(f"output is not an exact session directory below {parent}: {resolved}")
    return resolved


def purge_output(target: Path, output_parent: Path) -> bool:
    resolved = _safe_output_target(target, output_parent)
    if not resolved.exists():
        return False
    shutil.rmtree(resolved)
    return True


def purge_rpc_root(target: Path, run_parent: Path, pid: int) -> bool:
    parent = run_parent.resolve(strict=True)
    try:
        metadata = target.lstat()
    except FileNotFoundError:
        return False
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
        raise GuardError(f"refusing to remove non-directory or symlink RPC root: {target}")
    resolved = target.resolve(strict=True)
    if resolved.parent != parent or resolved.name != f"vllm-rpc-{pid}":
        raise GuardError(f"RPC root is not the exact recorded run directory: {resolved}")
    shutil.rmtree(resolved)
    return True


def terminate(state_path: Path, *, force: bool, purge: bool, output_parent: Path) -> None:
    state = load_state(state_path)
    members = validate_live_state(state)
    if members:
        _signal_session(state, signal.SIGTERM)
        remaining = _wait_for_session_exit(state, 30.0)
        if remaining and not force:
            pids = [member.pid for member in remaining]
            raise GuardError(f"MinerU did not exit after SIGTERM; remaining PIDs: {pids}")
        if remaining:
            _signal_session(state, signal.SIGKILL)
            remaining = _wait_for_session_exit(state, 10.0)
            if remaining:
                raise GuardError(
                    f"validated MinerU session survived SIGKILL: {[item.pid for item in remaining]}"
                )
    purge_rpc_root(Path(state.rpc_root), state_path.parent, state.pid)
    remove_matching_state(state_path, state)
    removed = purge and purge_output(Path(state.output_root), output_parent)
    print("process=stopped")
    print(f"output={'removed' if removed else 'retained'} path={state.output_root}")


def cleanup_orphans(
    output_parent: Path,
    state_path: Path,
    *,
    retention_minutes: int,
) -> None:
    parent = output_parent.resolve(strict=True)
    active: Path | None = None
    try:
        state = load_state(state_path)
        if validate_live_state(state):
            active = Path(state.output_root).resolve(strict=False)
    except GuardError:
        pass
    cutoff = time.time() - retention_minutes * 60
    removed = 0
    for child in parent.iterdir():
        try:
            metadata = child.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
            continue
        if child.resolve(strict=True) == active or metadata.st_mtime >= cutoff:
            continue
        if not (SESSION_NAME.fullmatch(child.name) or LEGACY_TASK_NAME.fullmatch(child.name)):
            continue
        resolved = child.resolve(strict=True)
        if resolved.parent != parent:
            continue
        shutil.rmtree(resolved)
        removed += 1
    print(f"orphan_outputs_removed={removed}")


def cleanup_logs(log_dir: Path, *, retention_days: int, retain_count: int) -> None:
    root = log_dir.resolve(strict=True)
    candidates: list[tuple[float, Path]] = []
    for child in root.iterdir():
        try:
            metadata = child.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
            continue
        if not (child.name.startswith("api-") and child.name.endswith(".log")):
            continue
        resolved = child.resolve(strict=True)
        if resolved.parent == root:
            candidates.append((metadata.st_mtime, resolved))
    candidates.sort(reverse=True)
    cutoff = time.time() - retention_days * 86_400
    removed = 0
    for index, (modified, path) in enumerate(candidates):
        if index < retain_count or modified >= cutoff:
            continue
        path.unlink()
        removed += 1
    print(f"old_logs_removed={removed}")


def cleanup_rpc_orphans(
    run_parent: Path,
    state_path: Path,
    *,
    retention_minutes: int,
) -> None:
    parent = run_parent.resolve(strict=True)
    active: Path | None = None
    try:
        state = load_state(state_path)
        if validate_live_state(state):
            active = Path(state.rpc_root).resolve(strict=False)
    except GuardError:
        pass
    cutoff = time.time() - retention_minutes * 60
    removed = 0
    for child in parent.iterdir():
        try:
            metadata = child.lstat()
        except FileNotFoundError:
            continue
        if (
            stat.S_ISLNK(metadata.st_mode)
            or not stat.S_ISDIR(metadata.st_mode)
            or not RPC_NAME.fullmatch(child.name)
            or metadata.st_mtime >= cutoff
            or child.resolve(strict=True) == active
        ):
            continue
        resolved = child.resolve(strict=True)
        if resolved.parent != parent:
            continue
        shutil.rmtree(resolved)
        removed += 1
    print(f"orphan_rpc_roots_removed={removed}")


def check_listeners(state_path: Path, host: str, port: int) -> None:
    try:
        import psutil
    except ImportError as exc:
        raise GuardError("psutil is required to audit TCP listeners") from exc
    state = load_state(state_path)
    members = validate_live_state(state, allow_missing_leader=False)
    pids = {member.pid for member in members}
    listeners: list[tuple[str, int, int]] = []
    for connection in psutil.net_connections(kind="tcp"):
        if connection.pid not in pids or connection.status != psutil.CONN_LISTEN:
            continue
        address = connection.laddr
        listeners.append((str(address.ip), int(address.port), int(connection.pid)))
    listeners.sort()
    unsafe = [item for item in listeners if item[0] not in {"127.0.0.1", "::1"}]
    if unsafe:
        raise GuardError(f"MinerU session has non-loopback TCP listeners: {unsafe}")
    if not any(ip == host and listener_port == port for ip, listener_port, _ in listeners):
        raise GuardError(f"expected API listener {host}:{port} was not found: {listeners}")
    for ip, listener_port, pid in listeners:
        print(f"listener={ip}:{listener_port} pid={pid}")
    print("listeners=loopback-only")


def check_health(url: str, version: str, concurrency: int) -> None:
    with urllib.request.urlopen(url, timeout=5) as response:
        payload = json.load(response)
    expected = {
        "status": "healthy",
        "version": version,
        "max_concurrent_requests": concurrency,
    }
    for key, value in expected.items():
        if payload.get(key) != value:
            raise GuardError(f"health field {key!r} is {payload.get(key)!r}, expected {value!r}")
    if not isinstance(payload.get("protocol_version"), int):
        raise GuardError("health response has no integer protocol_version")
    print(json.dumps(payload, sort_keys=True))
    print("health=validated")


def show_status(state_path: Path) -> int:
    try:
        state = load_state(state_path)
        members = validate_live_state(state)
    except GuardError as exc:
        print(f"process=invalid-state reason={exc}")
        return 2
    if not members:
        print("process=stale-state")
        return 1
    print(
        f"process=running pid={state.pid} session={state.session} "
        f"members={len(members)} output={state.output_root} log={state.log_file}"
    )
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)

    write = commands.add_parser("write-state")
    write.add_argument("--state", type=Path, required=True)
    write.add_argument("--pid", type=int, required=True)
    write.add_argument("--output", type=Path, required=True)
    write.add_argument("--rpc", type=Path, required=True)
    write.add_argument("--log", type=Path, required=True)

    clear = commands.add_parser("clear-state")
    clear.add_argument("--state", type=Path, required=True)
    clear.add_argument("--pid", type=int, required=True)

    stop = commands.add_parser("stop")
    stop.add_argument("--state", type=Path, required=True)
    stop.add_argument("--output-parent", type=Path, required=True)
    stop.add_argument("--force", action="store_true")
    stop.add_argument("--purge-output", action="store_true")

    cleanup = commands.add_parser("cleanup-orphans")
    cleanup.add_argument("--state", type=Path, required=True)
    cleanup.add_argument("--output-parent", type=Path, required=True)
    cleanup.add_argument("--retention-minutes", type=int, required=True)

    logs = commands.add_parser("cleanup-logs")
    logs.add_argument("--log-dir", type=Path, required=True)
    logs.add_argument("--retention-days", type=int, required=True)
    logs.add_argument("--retain-count", type=int, required=True)

    rpc = commands.add_parser("cleanup-rpc-orphans")
    rpc.add_argument("--state", type=Path, required=True)
    rpc.add_argument("--run-parent", type=Path, required=True)
    rpc.add_argument("--retention-minutes", type=int, required=True)

    listeners = commands.add_parser("check-listeners")
    listeners.add_argument("--state", type=Path, required=True)
    listeners.add_argument("--host", required=True)
    listeners.add_argument("--port", type=int, required=True)

    health = commands.add_parser("check-health")
    health.add_argument("--url", required=True)
    health.add_argument("--version", required=True)
    health.add_argument("--concurrency", type=int, required=True)

    status = commands.add_parser("status")
    status.add_argument("--state", type=Path, required=True)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    if args.command == "write-state":
        write_state(args.state, args.pid, args.output, args.rpc, args.log)
    elif args.command == "clear-state":
        clear_state_for_process(args.state, args.pid)
    elif args.command == "stop":
        terminate(
            args.state,
            force=args.force,
            purge=args.purge_output,
            output_parent=args.output_parent,
        )
    elif args.command == "cleanup-orphans":
        if args.retention_minutes < 1:
            raise GuardError("retention must be at least one minute")
        cleanup_orphans(
            args.output_parent,
            args.state,
            retention_minutes=args.retention_minutes,
        )
    elif args.command == "cleanup-logs":
        if args.retention_days < 1 or args.retain_count < 1:
            raise GuardError("log retention values must be positive")
        cleanup_logs(
            args.log_dir,
            retention_days=args.retention_days,
            retain_count=args.retain_count,
        )
    elif args.command == "cleanup-rpc-orphans":
        if args.retention_minutes < 1:
            raise GuardError("retention must be at least one minute")
        cleanup_rpc_orphans(
            args.run_parent,
            args.state,
            retention_minutes=args.retention_minutes,
        )
    elif args.command == "check-listeners":
        check_listeners(args.state, args.host, args.port)
    elif args.command == "check-health":
        check_health(args.url, args.version, args.concurrency)
    elif args.command == "status":
        return show_status(args.state)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (GuardError, OSError, ValueError) as error:
        print(f"runtime-guard: {error}", file=sys.stderr)
        raise SystemExit(2) from error
