# Claudian upstream

- Upstream: <https://github.com/YishenTu/claudian>
- Previous imported version: `2.1.4`
- Previous imported commit: `40880cabec40d61766c84f2da9f403ed36016f08`
- Synced upstream version: `2.3.6`
- Synced upstream commit: `14a6abcc2f1628ad99122dbe6ad5f56033331ac3`
- Sync contains 243 upstream commits after the previous imported commit.
- Synced into the OKF Workspace monorepo: 2026-09-28

The monorepo has one private `origin`. A fetch-only remote named `claudian-upstream` may be configured for deliberate upgrades. Do not use a Git submodule.

Recommended update procedure:

1. Fetch the selected upstream release and pin its full commit SHA here.
2. Compare the selected commit with the previous imported commit.
3. Update the vendored Claudian source and tests as one dedicated change.
4. Reapply or adapt the items in `OKF-PATCHES.md` through the narrowest available extension point.
5. Run Claudian checks, Dashboard checks, fixture-Vault integration checks and the root check script. Follow the [development acceptance rules](../docs/DEVELOPMENT.md#合成-vault-完整流程) for Obsidian verification and any temporary fixtures.
6. Update this file, `OKF-PATCHES.md`, plugin identity/version metadata, and the root release manifest.

Upstream updates are manual and value-driven; they are not pulled automatically.

The synced source includes provider runtime and lifecycle changes, Codex/Claude/OpenCode/Pi
features, chat UI improvements, security and cross-platform fixes, and upstream test
reorganization. Consult `OKF-PATCHES.md` for the preserved OKF adapter. The fork uses
`package-lock.json` and npm as its only dependency authority. Upstream `bun.lock` and nested
GitHub workflows are intentionally not vendored; the monorepo root owns installation, tests,
and releases. Collab's upstream extraction remains a separate upstream product boundary and
does not restore the retired in-tree Collab implementation.
