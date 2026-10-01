# System overview

OKF Workspace is a modular monolith with three independently built applications:

1. Engine: Python domain, API, worker, CLI, retrieval, and deployable Vault resources.
2. Dashboard: Obsidian workbench and direct Vault read model.
3. Claudian: embedded Codex interaction and versioned Dashboard handoff.

The production Vault is the semantic authority. Runtime State, Originals, indexes, caches, sessions, and secrets are operational data outside the source repository.

Feed and Intake are first-class Engine modules, not independent local services. Document conversion defaults to MinerU's token-authenticated cloud API and also supports an explicitly selected MarkItDown service or an enabled self-hosted MinerU endpoint. Engine owns method selection, format validation, conversion state, QC, and publication; Dashboard presents Engine's capability catalogue. Quality checks do not choose a converter, and failure never silently switches providers. See [conversion methods](../DOCUMENT-CONVERSION.md).
