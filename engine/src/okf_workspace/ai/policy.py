"""Small permission matrix for explicit and automatic AI writes."""

from __future__ import annotations

from typing import Literal

from okf_workspace.okf.paths import normalize_bundle_path

Actor = Literal["human", "explicit-ai", "automatic-ai"]
Operation = Literal["create", "replace-managed-region", "edit-section"]


class WritePolicyError(PermissionError):
    """Raised when an AI write crosses the documented content boundary."""


def authorize_write(
    path: str,
    *,
    actor: Actor,
    operation: Operation,
    managed_region: str | None = None,
) -> None:
    # Vault 会同步到 Windows，保留名称空间的保护不依赖调用方的大小写。
    normalized = normalize_bundle_path(path).as_posix().casefold()
    if actor == "human":
        return
    if normalized.startswith("self/"):
        raise WritePolicyError("AI cannot modify Self without a dedicated user-confirmed flow")
    if normalized.startswith("sources/text/"):
        raise WritePolicyError("Source Text is replaced only by document reconversion")
    if actor == "automatic-ai":
        if operation != "replace-managed-region" or not managed_region:
            raise WritePolicyError(
                "automatic AI may only replace an explicitly named ai:auto region"
            )
        if normalized.startswith("life/reflections/"):
            raise WritePolicyError("automatic AI cannot rewrite reflection text")
