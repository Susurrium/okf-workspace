# OKF Workspace development policy

## Authority

1. The user's current request.
2. `engine/workspace/vault/system/contracts/*.yaml` for Vault artifacts.
3. `docs/architecture/` for active module and ownership boundaries.
4. Current tests and implementation.

Historical repositories and archived documents are reference material only.

## Product boundaries

- `engine/` owns the Workspace domain, deterministic operations, API, worker, CLI, retrieval, and deployable Vault resources.
- `dashboard/` is the Obsidian workbench. It may read the Vault directly and perform simple human-equivalent edits, but it must not duplicate Engine state machines.
- `claudian/` owns the embedded agent UI and provider runtimes. OKF business rules come from the deployed Vault resources.
- `services/` contains genuinely independent processes such as the MarkItDown service.
- `integrations/` contains external-system clients and deployment assets, not Workspace authority.

## Data rules

- Markdown/YAML in the production Vault is the semantic authority.
- Runtime state, indexes, Originals, secrets, and user content never enter this repository.
- New Workspace artifacts must satisfy the current contract; obsolete development fixtures do not define compatibility requirements.
- Interest and long-term value remain explicit user judgments.
- AI must not infer `studied_at`.

## Verification

- Python changes: targeted pytest, Ruff, and Pyright.
- Dashboard changes: Vitest, TypeScript check, and production build.
- Claudian changes: nearest scoped `AGENTS.md`, typecheck, lint, relevant tests, and build.
- Cross-boundary changes: fixture-Vault integration tests and the root check script.
