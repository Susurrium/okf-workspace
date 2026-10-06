# OKF Workspace Engine

The Engine owns the Vault artifact model, deterministic workflows, Intake, Feeds, retrieval, background operations, API, worker, CLI, and deployable Workspace resources.

Production Vault content and runtime state live outside this package.

Use the root scripts for dependency setup and checks; see [development and verification](../docs/DEVELOPMENT.md).
Public API and CLI behavior, including PowerShell JSON transport, live in [interfaces](../docs/INTERFACES.md#cli).
Installation and converter credentials live in [deployment](../docs/DEPLOYMENT.md).
Artifact formats are defined by the [Vault Contracts](workspace/vault/system/contracts/), with module ownership in [architecture](../docs/architecture/README.md).
