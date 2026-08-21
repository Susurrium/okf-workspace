# System overview

OKF Workspace is a modular monolith with three independently built applications:

1. Engine: Python domain, API, worker, CLI, retrieval, and deployable Vault resources.
2. Dashboard: Obsidian workbench and direct Vault read model.
3. Claudian: embedded Codex interaction and versioned Dashboard handoff.

The production Vault is the semantic authority. Runtime State, Originals, indexes, caches, sessions, and secrets are operational data outside the source repository.

Feed and Intake are first-class Engine modules, not independent local services. MarkItDown is an independent service; MinerU is an external shared service with a repository-owned client and deployment assets.
