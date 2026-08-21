"""Parser endpoints and credentials kept outside the Vault."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit


@dataclass(frozen=True, slots=True)
class ImportSettings:
    mineru_url: str = "http://127.0.0.1:18000"
    mineru_ssh_managed: bool = True
    mineru_ssh_host: str = "bjmu-inner"
    mineru_ssh_remote_port: int = 8000
    markitdown_url: str = "http://127.0.0.1:18010"
    markitdown_token_file: Path | None = None

    @classmethod
    def from_env(cls) -> ImportSettings:
        token = os.environ.get("OKF_MARKITDOWN_TOKEN_FILE", "").strip()
        return cls(
            mineru_url=os.environ.get(
                "OKF_MINERU_URL",
                "http://127.0.0.1:18000",
            ).strip(),
            mineru_ssh_managed=os.environ.get("OKF_MINERU_SSH_MANAGED", "true").strip().casefold()
            not in {"0", "false", "no", "off"},
            mineru_ssh_host=os.environ.get("OKF_MINERU_SSH_HOST", "bjmu-inner").strip(),
            mineru_ssh_remote_port=int(os.environ.get("OKF_MINERU_SSH_REMOTE_PORT", "8000")),
            markitdown_url=os.environ.get(
                "OKF_MARKITDOWN_URL",
                "http://127.0.0.1:18010",
            ).strip(),
            markitdown_token_file=Path(token).resolve() if token else None,
        )

    def __post_init__(self) -> None:
        if not self.mineru_ssh_host or any(
            character.isspace() for character in self.mineru_ssh_host
        ):
            raise ValueError("MinerU SSH host must be a non-empty OpenSSH alias")
        if not 1 <= self.mineru_ssh_remote_port <= 65535:
            raise ValueError("MinerU SSH remote port must be between 1 and 65535")
        for name, value in (
            ("MinerU", self.mineru_url),
            ("MarkItDown", self.markitdown_url),
        ):
            parsed = urlsplit(value)
            if parsed.scheme not in {"http", "https"} or not parsed.netloc:
                raise ValueError(f"{name} URL must be absolute HTTP(S): {value!r}")
            if parsed.username or parsed.password or parsed.query or parsed.fragment:
                raise ValueError(f"{name} URL contains unsupported credentials or suffix")
            if (
                name == "MarkItDown"
                and parsed.scheme == "http"
                and parsed.hostname not in {"127.0.0.1", "localhost", "::1"}
            ):
                raise ValueError("remote MarkItDown must use HTTPS")

    def markitdown_token(self) -> str:
        if self.markitdown_token_file is None:
            return ""
        token = self.markitdown_token_file.read_text(encoding="utf-8").strip()
        if not token:
            raise RuntimeError("MarkItDown token file is empty")
        return token
