# OKF Workspace

OKF Workspace is one private monorepo for a Vault-native personal workspace. Codex is the interactive reasoning layer, Obsidian is the human reading and writing environment, and Markdown/YAML remains the semantic authority.

## Repository layout

- `engine/`: Workspace domain, Intake, Feeds, retrieval, background operations, API, worker, CLI, and deployable Vault resources.
- `dashboard/`: Obsidian workbench plugin.
- `claudian/`: customized Claudian/Codex Obsidian plugin.
- `services/`: retained service deployment assets; no service is required for document conversion.
- `integrations/`: external-system assets, including the retired self-hosted MinerU deployment.
- `tests/`: cross-component fixtures and end-to-end verification.

Production Vault, Runtime State, Originals, indexes, secrets, and sessions live outside this repository.

## Architecture

- [Current development plan](docs/DEVELOPMENT-PLAN.md)
- [System overview](docs/architecture/system-overview.md)
- [Module boundaries](docs/architecture/module-boundaries.md)
- [Data ownership](docs/architecture/data-ownership.md)
- [Data model](docs/DATA-MODEL.md)
- [Test plan](docs/TEST-PLAN.md)
- [MinerU cloud setup](docs/MINERU-CLOUD.md)

## Development

```powershell
./scripts/bootstrap.ps1
./scripts/check.ps1
./scripts/build.ps1
```

The Dashboard and Claudian retain independent Node dependency trees because they have different upstream and toolchain constraints. Root scripts provide one development workflow without forcing one lockfile.
