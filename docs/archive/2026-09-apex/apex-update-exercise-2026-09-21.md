# Apex 3.6.0 upstream update exercise

> 历史记录：保留编写时的决策、状态和证据。2026-10-06 归档，不作为当前部署或开发规范。[文档索引](../../README.md) · [当前计划](../../DEVELOPMENT-PLAN.md)

This is the reproducible M9 update rehearsal for the unified workbench. It deliberately does not advance
the production baseline in [Dashboard upstream baseline](../../../dashboard/UPSTREAM.md).

| Field | Value |
| --- | --- |
| Starting Apex commit | `dc7a7098689485f51a8b6195a691f8acc453b79a` (2.5.4) |
| Candidate Apex commit | `f5d6f73e80435d4a5df81966d1ae2683f9220a92` (3.6.0) |
| Exercise branch | `codex/apex-upstream-exercise` |
| Subtree merge commit | `72445c1` |
| Resolved integration commit | `2fc8f45` |
| Validation-fix commit | `acf0765` |

## Procedure and conflict decisions

The candidate was fetched from `https://github.com/PandoraReads/apex-dashboard.git`, then applied in a
temporary worktree with:

```powershell
git subtree pull --prefix dashboard/apex apex-upstream main --squash
```

The real merge conflicted in the generated bundle plus `render-update.ts`, `renderer.ts`, `settings.ts`,
and `view.ts`. Resolution retained the 3.6.0 stacked-layout, guarded-drag, album, anniversary, and widget
appearance changes while preserving these OKF integration invariants:

- section mutations and partial refreshes use stable `sectionRef` identity rather than a display name;
- adjacent paired sections are refreshed together after a width change;
- Dashboard settings accept the injected `ApexHost` and one outer Plugin owner;
- Dashboard panes share the acquired SyncEngine lease and retain pane-local scroll state;
- resize writes route through stable section references;
- the generated standalone Apex bundle is rebuilt only for upstream validation and is not the unified
  release entry point.

One upstream lint error was found at the managed-artifact mutation call. Removing an unnecessary type
assertion made the code pass without changing behavior.

## Results

- Apex 3.6.0 ESLint: passed.
- Apex 3.6.0 TypeScript and production build: passed.
- All 29 Apex 3.6.0 `test:*` scripts: passed.
- Unified Dashboard TypeScript check and production build against the merged candidate: passed.
- Unified Dashboard Vitest suite against the merged candidate: 39 files, 208 tests passed.

The update is therefore mechanically and architecturally mergeable. It is not promoted in this release:
3.6.0 adds product-facing layout and widget behavior that should receive its own disposable-Vault and
real-Obsidian interaction pass before the locked baseline changes. The exercise branch remains as the
auditable candidate and can be recreated from the SHAs above.
