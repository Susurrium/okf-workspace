"""Generate and verify the Dashboard bearer token outside the Vault."""

from __future__ import annotations

import os
import secrets
from pathlib import Path


class LocalTokenStore:
    def __init__(self, state: Path) -> None:
        self.path = state.resolve() / "secrets" / "local-api-token"

    def ensure(self) -> str:
        if self.path.is_file():
            token = self.path.read_text(encoding="utf-8").strip()
            if token:
                return token
        self.path.parent.mkdir(parents=True, exist_ok=True)
        token = secrets.token_urlsafe(32)
        self.path.write_text(token + "\n", encoding="utf-8", newline="\n")
        os.chmod(self.path, 0o600)
        return token

    def verify(self, candidate: str) -> bool:
        return secrets.compare_digest(self.ensure(), candidate.strip())
