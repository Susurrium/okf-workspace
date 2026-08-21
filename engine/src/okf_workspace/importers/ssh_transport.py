# pyright: reportPrivateUsage=false, reportUnnecessaryIsInstance=false
"""Safe SSH process management for the Windows-side MinerU adapter.

Only two operations live here:

* invoke one of four fixed lifecycle scripts on ``bjmu-inner``; and
* own an OpenSSH child process that forwards the loopback-only MinerU API.

The module never invokes a command through a local shell.  The remote command
is also selected from a fixed allow-list, rather than accepting arbitrary text
from callers.
"""

from __future__ import annotations

import math
import queue
import socket
import subprocess
import threading
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Literal

type RemoteAction = Literal["start", "status", "stop", "stop_complete"]
type HealthProbe = Callable[[], bool]

_REMOTE_APP_DIR = "/home/yangg/workdir/mineru/app"
_REMOTE_LEASE_SCRIPT = f"{_REMOTE_APP_DIR}/client-lease.sh"
_REMOTE_SCRIPTS: dict[RemoteAction, str] = {
    "start": f"{_REMOTE_APP_DIR}/start.sh",
    "status": f"{_REMOTE_APP_DIR}/status.sh",
    "stop": f"{_REMOTE_APP_DIR}/stop.sh",
    "stop_complete": f"{_REMOTE_APP_DIR}/stop-complete.sh",
}
_LOOPBACK = "127.0.0.1"
_OUTPUT_LIMIT = 4_000


class SSHConfigurationError(ValueError):
    """An SSH setting would be ambiguous or unsafe."""


class SSHTransportError(RuntimeError):
    """Base error for failures while controlling SSH."""


class SSHExecutableNotFoundError(SSHTransportError):
    """The configured OpenSSH client could not be started."""


class SSHProcessStartError(SSHTransportError):
    """The operating system refused to start the OpenSSH client."""


class SSHCommandTimeoutError(SSHTransportError):
    """A remote lifecycle command exceeded its configured deadline."""

    def __init__(
        self,
        action: RemoteAction,
        timeout: float,
        *,
        stdout: str = "",
        stderr: str = "",
    ) -> None:
        detail = _failure_detail(stdout, stderr)
        suffix = f" Output: {detail}" if detail else ""
        super().__init__(
            f"Remote MinerU {action!r} command timed out after {timeout:g} seconds.{suffix}"
        )
        self.action = action
        self.timeout = timeout
        self.stdout = stdout
        self.stderr = stderr


class SSHCommandError(SSHTransportError):
    """A remote lifecycle script returned a non-zero exit status."""

    def __init__(
        self,
        action: RemoteAction,
        returncode: int,
        *,
        stdout: str = "",
        stderr: str = "",
    ) -> None:
        detail = _failure_detail(stdout, stderr)
        suffix = f" Output: {detail}" if detail else ""
        super().__init__(
            f"Remote MinerU {action!r} command exited with status {returncode}.{suffix}"
        )
        self.action = action
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


class SSHTunnelError(SSHTransportError):
    """Base error for local port-forward failures."""


class SSHLeaseError(SSHTransportError):
    """The exclusive remote ingestion lease could not be acquired or held."""


class SSHTunnelExitedError(SSHTunnelError):
    """OpenSSH exited before the forwarded service became healthy."""

    def __init__(self, returncode: int, *, stdout: str = "", stderr: str = "") -> None:
        detail = _failure_detail(stdout, stderr)
        suffix = f" Output: {detail}" if detail else ""
        super().__init__(
            f"SSH port-forward exited with status {returncode} before becoming ready.{suffix}"
        )
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


class SSHTunnelTimeoutError(SSHTunnelError):
    """The forwarded endpoint did not pass its health probe in time."""

    def __init__(
        self,
        timeout: float,
        *,
        stdout: str = "",
        stderr: str = "",
        probe_error: BaseException | None = None,
    ) -> None:
        details: list[str] = []
        output = _failure_detail(stdout, stderr)
        if output:
            details.append(f"SSH output: {output}")
        if probe_error is not None:
            details.append(f"last health probe error: {type(probe_error).__name__}: {probe_error}")
        suffix = f" ({'; '.join(details)})" if details else ""
        super().__init__(
            f"SSH port-forward did not become healthy within {timeout:g} seconds{suffix}."
        )
        self.timeout = timeout
        self.stdout = stdout
        self.stderr = stderr
        self.probe_error = probe_error


@dataclass(frozen=True, slots=True)
class SSHConfig:
    """Validated OpenSSH settings for one loopback-only MinerU endpoint."""

    executable: str = "ssh"
    host: str = "bjmu-inner"
    local_port: int = 18_000
    remote_port: int = 8_000
    connect_timeout: float = 15.0
    command_timeout: float = 360.0
    tunnel_start_timeout: float = 30.0
    probe_interval: float = 0.2
    terminate_timeout: float = 5.0

    def __post_init__(self) -> None:
        executable = self.executable.strip()
        host = self.host.strip()
        if not executable or _contains_control(executable):
            raise SSHConfigurationError("SSH executable must be a non-empty path or command name")
        if not host or host.startswith("-") or any(char.isspace() for char in host):
            raise SSHConfigurationError(
                "SSH host must be a non-empty OpenSSH destination without whitespace or options"
            )
        if _contains_control(host):
            raise SSHConfigurationError("SSH host must not contain control characters")

        for name, port in (("local_port", self.local_port), ("remote_port", self.remote_port)):
            if isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65_535:
                raise SSHConfigurationError(f"{name} must be an integer from 1 to 65535")

        for name, value in (
            ("connect_timeout", self.connect_timeout),
            ("command_timeout", self.command_timeout),
            ("tunnel_start_timeout", self.tunnel_start_timeout),
            ("probe_interval", self.probe_interval),
            ("terminate_timeout", self.terminate_timeout),
        ):
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise SSHConfigurationError(f"{name} must be a positive finite number")
            if not math.isfinite(value) or value <= 0:
                raise SSHConfigurationError(f"{name} must be a positive finite number")

        object.__setattr__(self, "executable", executable)
        object.__setattr__(self, "host", host)

    @property
    def local_endpoint(self) -> tuple[str, int]:
        """The only address on which this transport permits a listener."""

        return (_LOOPBACK, self.local_port)

    @property
    def local_forward_spec(self) -> str:
        """Return OpenSSH's loopback-to-loopback ``-L`` value."""

        return f"{_LOOPBACK}:{self.local_port}:{_LOOPBACK}:{self.remote_port}"


@dataclass(frozen=True, slots=True)
class RemoteCommandResult:
    """Captured output from a successful remote lifecycle command."""

    action: RemoteAction
    argv: tuple[str, ...]
    returncode: int
    stdout: str
    stderr: str


class SSHTunnel:
    """One owned OpenSSH forwarding process.

    ``close`` signals only the exact :class:`subprocess.Popen` child created by
    this object.  It never searches for processes by name, PID file, or port.
    """

    def __init__(
        self,
        process: subprocess.Popen[str],
        argv: Sequence[str],
        *,
        terminate_timeout: float,
    ) -> None:
        self._process = process
        self._argv = tuple(argv)
        self._terminate_timeout = terminate_timeout
        self._closed = False
        self._stdout = ""
        self._stderr = ""

    @property
    def argv(self) -> tuple[str, ...]:
        return self._argv

    @property
    def pid(self) -> int:
        return self._process.pid

    @property
    def is_running(self) -> bool:
        return not self._closed and self._process.poll() is None

    @property
    def stdout(self) -> str:
        return self._stdout

    @property
    def stderr(self) -> str:
        return self._stderr

    def close(self) -> None:
        """Terminate this object's child process, escalating to ``kill`` on timeout."""

        if self._closed:
            return
        self._closed = True

        if self._process.poll() is None:
            self._process.terminate()
        try:
            stdout, stderr = self._process.communicate(timeout=self._terminate_timeout)
        except subprocess.TimeoutExpired:
            # Killing is safe here: ``_process`` is the child this instance
            # created, never a process discovered from global machine state.
            self._process.kill()
            stdout, stderr = self._process.communicate(timeout=self._terminate_timeout)
        self._stdout = _as_text(stdout)
        self._stderr = _as_text(stderr)

    def __enter__(self) -> SSHTunnel:
        return self

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
        self.close()


class SSHLease:
    """One exact OpenSSH child holding the server-side client flock."""

    def __init__(
        self,
        process: subprocess.Popen[str],
        argv: Sequence[str],
        *,
        terminate_timeout: float,
        stdout: str = "",
    ) -> None:
        self._process = process
        self._argv = tuple(argv)
        self._terminate_timeout = terminate_timeout
        self._closed = False
        self._stdout = stdout
        self._stderr = ""

    @property
    def is_running(self) -> bool:
        return not self._closed and self._process.poll() is None

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        if self._process.poll() is None:
            self._process.terminate()
        try:
            stdout, stderr = self._process.communicate(timeout=self._terminate_timeout)
        except subprocess.TimeoutExpired:
            self._process.kill()
            stdout, stderr = self._process.communicate(timeout=self._terminate_timeout)
        self._stdout += _as_text(stdout)
        self._stderr = _as_text(stderr)

    def __enter__(self) -> SSHLease:
        return self

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
        self.close()


class SSHTransport:
    """Run fixed MinerU lifecycle commands and create an owned SSH tunnel."""

    def __init__(self, config: SSHConfig | None = None) -> None:
        self.config = config or SSHConfig()

    def start_server(self, *, timeout: float | None = None) -> RemoteCommandResult:
        return self.run_remote("start", timeout=timeout)

    def status_server(self, *, timeout: float | None = None) -> RemoteCommandResult:
        return self.run_remote("status", timeout=timeout)

    def stop_server(
        self,
        *,
        timeout: float | None = None,
        completed: bool = False,
    ) -> RemoteCommandResult:
        """Stop an owned service, purging its session output only after success."""

        action: RemoteAction = "stop_complete" if completed else "stop"
        return self.run_remote(action, timeout=timeout)

    def run_remote(
        self,
        action: RemoteAction,
        *,
        timeout: float | None = None,
    ) -> RemoteCommandResult:
        """Invoke one allow-listed remote script and return its captured output."""

        if action not in _REMOTE_SCRIPTS:
            raise ValueError(f"Unsupported remote action: {action!r}")
        deadline = _positive_timeout(timeout, self.config.command_timeout, "command timeout")
        argv = self._remote_argv(action)
        try:
            completed = subprocess.run(
                argv,
                stdin=subprocess.DEVNULL,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=deadline,
                check=False,
                shell=False,
            )
        except FileNotFoundError as error:
            raise SSHExecutableNotFoundError(
                f"SSH executable was not found: {self.config.executable!r}"
            ) from error
        except subprocess.TimeoutExpired as error:
            raise SSHCommandTimeoutError(
                action,
                deadline,
                stdout=_as_text(error.stdout),
                stderr=_as_text(error.stderr),
            ) from error
        except OSError as error:
            raise SSHProcessStartError(
                f"Could not start SSH executable {self.config.executable!r}: {error}"
            ) from error

        stdout = _as_text(completed.stdout)
        stderr = _as_text(completed.stderr)
        if completed.returncode != 0:
            raise SSHCommandError(
                action,
                completed.returncode,
                stdout=stdout,
                stderr=stderr,
            )
        return RemoteCommandResult(action, tuple(argv), completed.returncode, stdout, stderr)

    def acquire_lease(self, *, timeout: float | None = None) -> SSHLease:
        """Hold the remote single-client lease until the returned object closes."""

        deadline_seconds = _positive_timeout(
            timeout,
            self.config.tunnel_start_timeout,
            "lease acquisition timeout",
        )
        argv = self._lease_argv()
        try:
            process = subprocess.Popen(
                argv,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
                shell=False,
            )
        except FileNotFoundError as error:
            raise SSHExecutableNotFoundError(
                f"SSH executable was not found: {self.config.executable!r}"
            ) from error
        except OSError as error:
            raise SSHProcessStartError(
                f"Could not start SSH executable {self.config.executable!r}: {error}"
            ) from error

        lease = SSHLease(
            process,
            argv,
            terminate_timeout=self.config.terminate_timeout,
        )
        messages: queue.Queue[str | BaseException] = queue.Queue(maxsize=1)

        def read_ready_line() -> None:
            try:
                line = process.stdout.readline() if process.stdout is not None else ""
                messages.put(line)
            except BaseException as error:  # pragma: no cover - OS pipe failure
                messages.put(error)

        threading.Thread(target=read_ready_line, daemon=True).start()
        deadline = time.monotonic() + deadline_seconds
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                lease.close()
                detail = _failure_detail(lease._stdout, lease._stderr)
                raise SSHLeaseError(
                    f"Remote MinerU client lease was not acquired within "
                    f"{deadline_seconds:g} seconds. Output: {detail}"
                )
            try:
                message = messages.get(timeout=min(0.1, remaining))
            except queue.Empty:
                if process.poll() is None:
                    continue
                lease.close()
                detail = _failure_detail(lease._stdout, lease._stderr)
                raise SSHLeaseError(
                    f"Remote MinerU client lease exited before readiness. Output: {detail}"
                ) from None
            if isinstance(message, BaseException):
                lease.close()
                raise SSHLeaseError(
                    f"Could not read remote lease readiness: {message}"
                ) from message
            lease._stdout = message
            if message.strip() == "lease=acquired" and process.poll() is None:
                return lease
            lease.close()
            detail = _failure_detail(lease._stdout, lease._stderr)
            if "lease=busy" in detail:
                raise SSHLeaseError(
                    "Another MinerU ingestion client currently owns the server lease; retry later."
                )
            raise SSHLeaseError(f"Remote MinerU lease returned an invalid response: {detail}")

    def open_tunnel(
        self,
        *,
        health_probe: HealthProbe | None = None,
        timeout: float | None = None,
    ) -> SSHTunnel:
        """Start a loopback-only port forward and wait for a readiness probe.

        By default readiness means that a TCP connection to the local forwarded
        port succeeds.  Callers can supply a no-argument callback that checks the
        MinerU ``/health`` endpoint instead.  A false result or an exception means
        "not ready yet" until the deadline expires.
        """

        deadline_seconds = _positive_timeout(
            timeout,
            self.config.tunnel_start_timeout,
            "tunnel startup timeout",
        )
        self._assert_local_port_available()
        argv = self._tunnel_argv()
        try:
            process = subprocess.Popen(
                argv,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
                shell=False,
            )
        except FileNotFoundError as error:
            raise SSHExecutableNotFoundError(
                f"SSH executable was not found: {self.config.executable!r}"
            ) from error
        except OSError as error:
            raise SSHProcessStartError(
                f"Could not start SSH executable {self.config.executable!r}: {error}"
            ) from error

        tunnel = SSHTunnel(
            process,
            argv,
            terminate_timeout=self.config.terminate_timeout,
        )
        probe = health_probe or self._tcp_health_probe
        deadline = time.monotonic() + deadline_seconds
        last_probe_error: BaseException | None = None

        while True:
            returncode = process.poll()
            if returncode is not None:
                stdout, stderr = process.communicate(timeout=self.config.terminate_timeout)
                tunnel._closed = True
                tunnel._stdout = _as_text(stdout)
                tunnel._stderr = _as_text(stderr)
                raise SSHTunnelExitedError(
                    returncode,
                    stdout=tunnel.stdout,
                    stderr=tunnel.stderr,
                )

            try:
                if probe():
                    return tunnel
                last_probe_error = None
            except Exception as error:  # readiness failures are expected while booting
                last_probe_error = error

            remaining = deadline - time.monotonic()
            if remaining <= 0:
                tunnel.close()
                raise SSHTunnelTimeoutError(
                    deadline_seconds,
                    stdout=tunnel.stdout,
                    stderr=tunnel.stderr,
                    probe_error=last_probe_error,
                )
            time.sleep(min(self.config.probe_interval, remaining))

    def _remote_argv(self, action: RemoteAction) -> list[str]:
        return [
            self.config.executable,
            "-T",
            "-o",
            "BatchMode=yes",
            "-o",
            f"ConnectTimeout={math.ceil(self.config.connect_timeout)}",
            self.config.host,
            _REMOTE_SCRIPTS[action],
        ]

    def _lease_argv(self) -> list[str]:
        # A user's SSH config may contain unrelated forwards.  The lease
        # channel must execute only the fixed script and must not create any
        # configured forwarding listeners as a side effect.
        return [
            self.config.executable,
            "-T",
            "-o",
            "BatchMode=yes",
            "-o",
            f"ConnectTimeout={math.ceil(self.config.connect_timeout)}",
            "-o",
            "ClearAllForwardings=yes",
            "-o",
            "ServerAliveInterval=15",
            "-o",
            "ServerAliveCountMax=3",
            self.config.host,
            _REMOTE_LEASE_SCRIPT,
        ]

    def _tunnel_argv(self) -> list[str]:
        # Both sides are intentionally hard-coded loopback addresses.  In
        # particular, no API permits constructing a 0.0.0.0 listener.
        return [
            self.config.executable,
            "-N",
            "-T",
            "-o",
            "BatchMode=yes",
            "-o",
            f"ConnectTimeout={math.ceil(self.config.connect_timeout)}",
            "-o",
            "ExitOnForwardFailure=yes",
            "-o",
            "GatewayPorts=no",
            "-o",
            "PermitLocalCommand=no",
            "-o",
            "ServerAliveInterval=15",
            "-o",
            "ServerAliveCountMax=3",
            "-L",
            self.config.local_forward_spec,
            self.config.host,
        ]

    def _assert_local_port_available(self) -> None:
        """Reject an occupied endpoint instead of trusting an unowned listener."""

        probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            exclusive_address_use = getattr(socket, "SO_EXCLUSIVEADDRUSE", None)
            if exclusive_address_use is not None:
                probe.setsockopt(socket.SOL_SOCKET, exclusive_address_use, 1)
            probe.bind(self.config.local_endpoint)
        except OSError as error:
            host, port = self.config.local_endpoint
            raise SSHTunnelError(
                f"Local tunnel endpoint {host}:{port} is already in use; refusing to reuse "
                "an unowned listener."
            ) from error
        finally:
            probe.close()

    def _tcp_health_probe(self) -> bool:
        try:
            with socket.create_connection(self.config.local_endpoint, timeout=1.0):
                return True
        except OSError:
            return False


def _contains_control(value: str) -> bool:
    return any(ord(char) < 32 or ord(char) == 127 for char in value)


def _positive_timeout(value: float | None, default: float, label: str) -> float:
    actual = default if value is None else value
    if isinstance(actual, bool) or not isinstance(actual, (int, float)):
        raise ValueError(f"{label} must be a positive finite number")
    if not math.isfinite(actual) or actual <= 0:
        raise ValueError(f"{label} must be a positive finite number")
    return float(actual)


def _as_text(value: str | bytes | None) -> str:
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return value


def _failure_detail(stdout: str, stderr: str) -> str:
    combined = stderr.strip() or stdout.strip()
    if len(combined) > _OUTPUT_LIMIT:
        return combined[:_OUTPUT_LIMIT] + "..."
    return combined
