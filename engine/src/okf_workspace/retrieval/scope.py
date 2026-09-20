"""Shared exact folder boundaries for lexical, vector and linked retrieval."""

from collections.abc import Sequence


def path_in_scope(
    path: str, include_prefixes: Sequence[str] = (), exclude_prefixes: Sequence[str] = ()
) -> bool:
    def matches(prefix: str) -> bool:
        base = prefix.rstrip("/")
        return path == base or path.startswith(base + "/")

    return (not include_prefixes or any(matches(p) for p in include_prefixes)) and not any(
        matches(p) for p in exclude_prefixes
    )
