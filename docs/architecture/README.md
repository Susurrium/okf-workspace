# OKF Workspace architecture

[Documentation index](../README.md) · [Data model](../DATA-MODEL.md)

[Open the interactive information-flow and architecture viewer](visualizations/index.html)
(Chinese, offline). It opens on the complete branching information flow; six other tabs
cover the system, dependencies, data ownership, imports, AI execution, and deployment.
Nodes link to current repository evidence. The [static overview](visualizations/overview.svg)
is suitable for previews and export. Open the downloaded HTML in a browser.

Module and ownership rules live here. Vault artifact formats are defined by the deployed Contracts, sourced from `engine/workspace/vault/system/contracts/`. Development plans and archived evidence do not override these boundaries.

The viewer is an explanatory projection, not another source of rules or proof of an online
production deployment. Its reviewed baseline and reference fingerprint are displayed in
the page. Updating and checking the generated files is documented in
[development](../DEVELOPMENT.md#架构可视化).

[System overview](#system-overview) · [Module boundaries](#module-boundaries) · [Data ownership](#data-ownership)

## System overview

OKF Workspace is a modular monolith with three independently built applications:

1. Engine: Python domain, API, worker, CLI, retrieval, and deployable Vault resources.
2. Dashboard: Obsidian workbench and direct Vault read model.
3. Claudian: embedded Codex interaction and versioned Dashboard handoff.

The production Vault is the semantic authority. Runtime State, Originals, indexes, caches, sessions, and secrets are operational data outside the source repository.

Original files are ordinary durable attachments in `sources/originals/<sha256>/<filename>`
inside the production Vault. LiveSync replicates their complete bytes together with Markdown,
requests and receipts. All devices keep the files locally and use Obsidian's native viewer for
PDFs/images. No independent original transport, download cache or external-reader handoff is
part of the active architecture. See [original file lifecycle](../DEPLOYMENT.md#original-migration).

Feed and Intake are first-class Engine modules, not independent local services. Document conversion defaults to MinerU's token-authenticated cloud API and also supports an explicitly selected MarkItDown service or an enabled self-hosted MinerU endpoint. Engine owns method selection, format validation, conversion state, QC, and publication; Dashboard presents Engine's capability catalogue. Quality checks do not choose a converter, and failure never silently switches providers. See [conversion methods](../DEPLOYMENT.md#conversion).

## Module boundaries

### Dependency direction

```text
Dashboard -> Vault read model / Engine API / Claudian bridge
Claudian -> Obsidian / Codex / deployed Workspace resources
API and CLI -> application workflows
application workflows -> Intake / Feeds / Sources / Workspace / Operations
Intake -> Sources / Foundation
Feeds -> Sources / Foundation
Workspace -> Foundation
Sources -> Foundation
Retrieval -> Foundation
Foundation -> no upper module
```

### Hard rules

- Foundation contains only contracts, frontmatter, paths, relations, atomic file operations, and basic types.
- Sources is the only owner of Source and Source Text publication, lookup, canonical identity, and pair transactions.
- Intake and Feeds do not import one another's implementation.
- Dashboard does not implement conversion, publication, or semantic-operation state machines.
- For an Obsidian-initiated Feed Digest open, Engine supplies the path and rendered Markdown;
  Dashboard creates a missing note through Obsidian's Vault API and never overwrites an existing note.
  Engine retains Digest rendering, existing-note refresh, and non-Obsidian materialization.
- Dashboard-originated Engine writes carry the current Vault fingerprint, which Engine checks before
  accepting a mutation. Engine retains ownership of Source pairs, Capture routing, imports, and
  background semantic publication; Dashboard reports disk/index divergence without recreating them.
- Dashboard may host Apex-native widget services for habits, expenses, reading, focus, media, and other
  workbench utilities. Those services retain their existing data models and do not become Engine or Vault
  artifact authorities.
- Claudian contains provider and UI behavior, not copies of Workspace business prompts.
- Cross-module flows are composed in application workflows, not hidden in adapters or API routes.

### Synced mobile document intake

Dashboard writes original bytes directly into `sources/originals/<sha256>/<filename>` and then
publishes a Document Import Request in `system/imports/<uuid>/request.md`, using only Vault APIs.
LiveSync carries both files; arrival order is not assumed. The designated desktop Engine verifies
length/hash of a private snapshot. Explicit `action: store` registers a Source without text or a
conversion job; `action: convert` invokes the existing conversion queue, reusing published text
for subsequent generation. Desktop workbench imports use the same local-first writer. It reuses the Vault
original instead of making an external primary copy. Receipts and published notes sync normally.
Execution state, credentials and indexes remain outside Vault. Mobile has no business state machine.
Reading an original uses `WorkspaceLeaf.openFile` on its local `TFile`, without Engine or an HTTP service.
Old device uploads have a one-way recovery reader; old `okf-original://` links resolve migrated files.
Legacy external originals and remote service assets are retained only for rollback, not active transport.
See [original file lifecycle](../DEPLOYMENT.md#original-migration).

## Data ownership

| Data | Owner | Readers |
| --- | --- | --- |
| Capture | Intake | Dashboard, workflows |
| Vault original attachment | User; Intake verifies and stores it, LiveSync replicates it | Obsidian native viewer, conversion pipeline |
| Explicit Document Import Request | User, through Dashboard Vault APIs after the attachment is saved | desktop Intake receiver, mobile Dashboard |
| Document Import Receipt display projection | Engine Intake | Dashboard; execution authority stays in external State |
| Source identity, durable `uses[]`, and Source Text | Sources | all Workspace modules, retrieval, Dashboard |
| Feed cache, Digest, and action receipt | Feeds | Dashboard, Sources, Operations |
| Course, Lesson, Study Guide | Workspace Learning | Dashboard, Claudian, retrieval |
| Wiki and Wiki Map | Workspace Knowledge | Dashboard, Claudian, retrieval |
| Project, log, and Decision | Workspace Projects | Dashboard, Claudian, retrieval |
| Daily, Reflection, Review | Workspace Life | Dashboard, Claudian, retrieval |
| Semantic and conversion state | Operations | Dashboard, workers |
| Contracts, templates, views, policies, Skills | Engine Workspace resources | Engine, deployed Vault, Dashboard, Claudian |
| Apex habits, expenses, reading history, completed focus sessions, and widget state | Apex native services and their existing JSON/plugin data | Unified Dashboard widgets and their existing export/sync adapters |
| Workbench Markdown layout, inline memos and checklists, and workbench safety copies | Dashboard/Apex workbench format | Dashboard and explicit AI attachments; Tasks and Engine task projections exclude workbenches |

`Source.resource` and `kind` describe a context-neutral input identity. Optional `text` links a
published Source Text; saving an original does not require or fabricate that text. Provenance such as
`ingested_via` records how the input first entered the Workspace; neither identity nor provenance says
what the user wants to do with it.

Document imports publish only the local assets referenced by the final converted body, after OCR
and page reconstruction. Those assets live in `sources/assets/` and sync with the text and original;
parser scratch images and unused exports are not Vault content. `Source Text.sources` points to the
Source record, never to an inventory of extracted images. Body links carry attachment dependencies;
document import publication does not enumerate them again in YAML `assets`.

The complete parser export, asset manifest and QC report remain in external State for retry and
diagnostics. Scratch `working/` files are removed only after publication and the successful receipt
are durable. Failed or interrupted conversions retain scratch files. Export recovery remains possible
without calling the parser again. This policy does not garbage-collect existing Vault attachments.

Durable human decisions belong to `Source.uses[]`. Each use contains `purpose` plus optional `course`
and `project` Vault references. The tuple is idempotent, so one Source can support several courses,
projects, or independent uses without copying the identity or overwriting another context. A formal
`study`, `wiki`, or `reference` decision removes only the `undecided` use covered by that same context.
Other pending and confirmed uses remain intact.

`study` produces a Study Guide owned by Workspace Learning, `wiki` produces a Wiki owned by Workspace
Knowledge, and `reference` intentionally produces no semantic artifact. `undecided` remains visible to
Inbox for Intake sources that the user explicitly routed there. Taking no action on a Feed item leaves it
only in Feed cache and its Digest; it does not create a Source or `undecided` use. Queue, retry, progress,
and failure are Operations runtime data rather than Source state.

The Markdown model does not depend on a Vault Git repository. Local checkpoints are an optional recovery
feature that becomes active only after the user explicitly opts in.

The unified Apex-based Dashboard does not turn Apex-native life-tool data into Workspace artifacts. The
native services keep their existing formats, semantics, and export/sync behavior. A plugin-identity change
may require a repeatable path takeover, but it must not create corresponding Markdown/YAML notes, merge two
stores by guesswork, or leave two active writers. Physical storage below `.obsidian/plugins/` does not make
these records part of the Workspace semantic model.

Workbench Markdown is user-owned Dashboard data, not an OKF Artifact or disposable cache. A parsed
top-level YAML boolean `dashboard: true` identifies it independently of its filename, directory, or
plugin registry. An absent `workbench_schema` is compatible with legacy boards; any positive integer
is an identity-compatible version, while Dashboard owns layout compatibility and preservation of
unknown configuration/body. Empty legacy `type` fields are tolerated. A nonempty Artifact `type`
together with `dashboard: true` is an identity conflict, never a validation exemption. String/numeric
dashboard markers and invalid schema values are diagnosed without rewriting the file.

Engine bundle/changed-file validation does not impose Artifact fields or headings on workbenches.
Engine Artifact publishers still reject workbench candidates. Artifact migrations preserve board
bytes, including conflicting/invalid board identities and malformed YAML, and never normalize their
fields, move them as legacy notes, or rewrite their body. The bundle-root `index.md` remains reserved
for human navigation and cannot be repurposed as a workbench.

Dashboard preserves Unicode letters in new workbench filenames. Display-name changes do not rename
files, and unregistering a workbench does not delete its Markdown. On startup, a missing registry is
recovered from valid workbench frontmatter on disk before a default board can be created; hidden
directories (including safety copies) and root `index.md` are excluded. Recovery registers all discovered
boards in path order and prefers `dashboard` as active when present, otherwise the first path. Explicit
registry paths are preserved even if files have not synced yet. Storage failures abort recovery rather
than being interpreted as an empty Vault.

Default lexical/vector retrieval excludes workbenches and root `.dashboard-backup/` safety copies;
index sync removes prior entries. Explicitly selected workbench attachments are read from current
Markdown without entering the default index. Workbench checklists remain local to their cards;
Tasks and Engine task projections exclude every workbench and its backup copies. Workbenches
remain included in backup/restore, and moving a memo into Capture remains an explicit user action.

Original transport, migration and backup procedures: [deployment](../DEPLOYMENT.md#original-migration). Converter configuration: [deployment](../DEPLOYMENT.md#conversion). Public handoffs: [interfaces](../INTERFACES.md).
