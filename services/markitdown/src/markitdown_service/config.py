"""Environment-backed service configuration."""

from __future__ import annotations

import importlib.metadata
import os
import re
import shutil
from dataclasses import dataclass
from pathlib import Path

from . import __version__


class ConfigurationError(RuntimeError):
    """Raised when the process configuration is unsafe or incomplete."""


@dataclass(frozen=True, slots=True)
class StorageStatus:
    spool_bytes: int
    spool_limit_bytes: int
    filesystem_free_bytes: int
    minimum_free_bytes: int

    def can_fit(self, additional_bytes: int) -> bool:
        return (
            additional_bytes >= 0
            and self.spool_bytes + additional_bytes <= self.spool_limit_bytes
            and self.filesystem_free_bytes - additional_bytes >= self.minimum_free_bytes
        )


def _positive_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise ConfigurationError(f"{name} must be an integer") from exc
    if value <= 0:
        raise ConfigurationError(f"{name} must be greater than zero")
    return value


def _positive_float(name: str, default: float) -> float:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        value = float(raw)
    except ValueError as exc:
        raise ConfigurationError(f"{name} must be a number") from exc
    if value <= 0:
        raise ConfigurationError(f"{name} must be greater than zero")
    return value


def _installed_markitdown_version() -> str:
    try:
        return importlib.metadata.version("markitdown")
    except importlib.metadata.PackageNotFoundError:
        return "not-installed"


def _read_tokens(path: Path) -> tuple[str, ...]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as exc:
        raise ConfigurationError(f"cannot read API token file: {path}") from exc

    tokens = tuple(
        stripped for line in lines if (stripped := line.strip()) and not stripped.startswith("#")
    )
    if not tokens:
        raise ConfigurationError("API token file contains no tokens")
    if any(len(token) < 32 for token in tokens):
        raise ConfigurationError("every API token must contain at least 32 characters")
    if len(tokens) != len(set(tokens)):
        raise ConfigurationError("API token file contains duplicate tokens")
    return tokens


@dataclass(frozen=True, slots=True)
class Settings:
    """Fully resolved process settings.

    API and worker containers share storage settings. Only the API process needs
    ``api_tokens``.
    """

    state_dir: Path
    spool_dir: Path
    api_tokens: tuple[str, ...] = ()
    bind_host: str = "0.0.0.0"
    bind_port: int = 8080
    max_upload_bytes: int = 64 * 1024 * 1024
    max_result_bytes: int = 128 * 1024 * 1024
    max_pages: int = 500
    max_active_tasks: int = 3
    max_concurrent_uploads: int = 1
    max_spool_bytes: int = 2 * 1024 * 1024 * 1024
    min_free_bytes: int = 2 * 1024 * 1024 * 1024
    conversion_timeout_seconds: int = 600
    success_ttl_seconds: int = 2 * 60 * 60
    failure_ttl_seconds: int = 24 * 60 * 60
    tombstone_ttl_seconds: int = 24 * 60 * 60
    orphan_ttl_seconds: int = 24 * 60 * 60
    poll_seconds: float = 1.0
    worker_stale_seconds: int = 15
    max_attempts: int = 2
    engine_version: str = "0.1.6"
    engine_build_id: str = "development"
    release_manifest_sha256: str = "development"
    service_version: str = __version__

    @property
    def database_path(self) -> Path:
        return self.state_dir / "jobs.sqlite"

    @property
    def incoming_dir(self) -> Path:
        return self.spool_dir / "incoming"

    @property
    def results_dir(self) -> Path:
        return self.spool_dir / "results"

    @property
    def failed_dir(self) -> Path:
        return self.spool_dir / "failed"

    def prepare_directories(self) -> None:
        for path in (self.state_dir, self.incoming_dir, self.results_dir, self.failed_dir):
            path.mkdir(mode=0o700, parents=True, exist_ok=True)
            if path.is_symlink() or not path.is_dir():
                raise ConfigurationError(f"service path is not a directory: {path}")
            try:
                path.chmod(0o700)
            except OSError as exc:
                raise ConfigurationError(f"cannot secure service directory: {path}") from exc

    def storage_status(self) -> StorageStatus:
        spool_bytes = 0
        for directory in (self.incoming_dir, self.results_dir, self.failed_dir):
            try:
                with os.scandir(directory) as iterator:
                    entries = tuple(iterator)
            except OSError as exc:
                raise ConfigurationError(f"cannot inspect service spool: {directory}") from exc
            for entry in entries:
                try:
                    if entry.is_file(follow_symlinks=False):
                        spool_bytes += entry.stat(follow_symlinks=False).st_size
                except OSError as exc:
                    raise ConfigurationError(f"cannot inspect spool entry: {entry.path}") from exc
        try:
            free_bytes = shutil.disk_usage(self.spool_dir).free
        except OSError as exc:
            raise ConfigurationError(f"cannot inspect spool filesystem: {self.spool_dir}") from exc
        return StorageStatus(
            spool_bytes=spool_bytes,
            spool_limit_bytes=self.max_spool_bytes,
            filesystem_free_bytes=free_bytes,
            minimum_free_bytes=self.min_free_bytes,
        )

    @classmethod
    def from_environment(cls, *, require_tokens: bool) -> Settings:
        state_dir = Path(os.getenv("MARKITDOWN_STATE_DIR", "/data/state"))
        spool_dir = Path(os.getenv("MARKITDOWN_SPOOL_DIR", "/data/spool"))

        tokens: tuple[str, ...] = ()
        if require_tokens:
            token_path_raw = os.getenv("MARKITDOWN_API_TOKEN_FILE")
            if not token_path_raw:
                raise ConfigurationError("MARKITDOWN_API_TOKEN_FILE is required")
            tokens = _read_tokens(Path(token_path_raw))

        build_id = os.getenv("MARKITDOWN_ENGINE_BUILD_ID", "").strip()
        if re.fullmatch(r"[A-Za-z0-9._:+-]+", build_id) is None:
            raise ConfigurationError(
                "MARKITDOWN_ENGINE_BUILD_ID must use the safe release-identity format"
            )
        image_build_id = os.getenv("MARKITDOWN_IMAGE_BUILD_ID", "").strip()
        if image_build_id != build_id:
            raise ConfigurationError(
                "runtime build ID does not match the identity baked into the image"
            )
        release_manifest_sha256 = os.getenv("MARKITDOWN_RELEASE_MANIFEST_SHA256", "").strip()
        image_release_sha256 = os.getenv("MARKITDOWN_IMAGE_RELEASE_MANIFEST_SHA256", "").strip()
        if re.fullmatch(r"[0-9a-f]{64}", release_manifest_sha256) is None:
            raise ConfigurationError("MARKITDOWN_RELEASE_MANIFEST_SHA256 must be lowercase SHA-256")
        if image_release_sha256 != release_manifest_sha256:
            raise ConfigurationError(
                "runtime release manifest does not match the identity baked into the image"
            )

        expected_version = os.getenv("MARKITDOWN_ENGINE_VERSION", "0.1.6").strip()
        installed_version = _installed_markitdown_version()
        if installed_version != expected_version:
            raise ConfigurationError(
                "installed MarkItDown version does not match MARKITDOWN_ENGINE_VERSION "
                f"({installed_version!r} != {expected_version!r})"
            )

        settings = cls(
            state_dir=state_dir,
            spool_dir=spool_dir,
            api_tokens=tokens,
            bind_host=os.getenv("MARKITDOWN_BIND_HOST", "0.0.0.0"),
            bind_port=_positive_int("MARKITDOWN_BIND_PORT", 8080),
            max_upload_bytes=_positive_int("MARKITDOWN_MAX_UPLOAD_BYTES", 64 * 1024 * 1024),
            max_result_bytes=_positive_int("MARKITDOWN_MAX_RESULT_BYTES", 128 * 1024 * 1024),
            max_pages=_positive_int("MARKITDOWN_MAX_PAGES", 500),
            max_active_tasks=_positive_int("MARKITDOWN_MAX_ACTIVE_TASKS", 3),
            max_concurrent_uploads=_positive_int("MARKITDOWN_MAX_CONCURRENT_UPLOADS", 1),
            max_spool_bytes=_positive_int("MARKITDOWN_MAX_SPOOL_BYTES", 2 * 1024 * 1024 * 1024),
            min_free_bytes=_positive_int("MARKITDOWN_MIN_FREE_BYTES", 2 * 1024 * 1024 * 1024),
            conversion_timeout_seconds=_positive_int("MARKITDOWN_CONVERSION_TIMEOUT_SECONDS", 600),
            success_ttl_seconds=_positive_int("MARKITDOWN_SUCCESS_TTL_SECONDS", 7200),
            failure_ttl_seconds=_positive_int("MARKITDOWN_FAILURE_TTL_SECONDS", 86400),
            tombstone_ttl_seconds=_positive_int("MARKITDOWN_TOMBSTONE_TTL_SECONDS", 86400),
            orphan_ttl_seconds=_positive_int("MARKITDOWN_ORPHAN_TTL_SECONDS", 86400),
            poll_seconds=_positive_float("MARKITDOWN_WORKER_POLL_SECONDS", 1.0),
            worker_stale_seconds=_positive_int("MARKITDOWN_WORKER_STALE_SECONDS", 15),
            max_attempts=_positive_int("MARKITDOWN_MAX_ATTEMPTS", 2),
            engine_version=installed_version,
            engine_build_id=build_id,
            release_manifest_sha256=release_manifest_sha256,
        )
        if settings.max_concurrent_uploads > settings.max_active_tasks:
            raise ConfigurationError(
                "MARKITDOWN_MAX_CONCURRENT_UPLOADS must not exceed MARKITDOWN_MAX_ACTIVE_TASKS"
            )
        if settings.max_spool_bytes < settings.max_upload_bytes + settings.max_result_bytes:
            raise ConfigurationError(
                "MARKITDOWN_MAX_SPOOL_BYTES must reserve one maximum upload and result"
            )
        return settings
