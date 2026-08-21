# Claudian upstream

- Upstream: <https://github.com/YishenTu/claudian>
- Imported version: `2.1.4`
- Imported commit: `40880cabec40d61766c84f2da9f403ed36016f08`
- Imported into the OKF Workspace monorepo: 2026-08-21

The monorepo has one private `origin`. A fetch-only remote named `claudian-upstream` may be configured for deliberate upgrades. Do not use a Git submodule.

Recommended update procedure:

1. Fetch the selected upstream release.
2. Compare it with the commit recorded above.
3. Update the vendored `claudian/` tree in one dedicated change.
4. Reapply or adapt the items in `OKF-PATCHES.md` through the narrowest available extension point.
5. Run typecheck, lint, architecture tests, targeted Codex/OKF tests, and the production build.
6. Update this file and the root release manifest.

Upstream updates are manual and value-driven; they are not pulled automatically.

This fork uses `package-lock.json` and npm as its only dependency authority. Upstream
`bun.lock` and nested GitHub workflows are intentionally not vendored; the monorepo root CI
owns installation, tests, and releases.
