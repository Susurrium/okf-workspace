# Data ownership

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
| Workbench Markdown layout, inline memos and tasks, and workbench safety copies | Dashboard/Apex workbench format | Dashboard, explicit AI attachments; live embedded tasks may participate in task projections |

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
Markdown without entering the default index. Live workbench tasks retain the normal embedded-task
rules; backup copies never contribute duplicate tasks or semantic governance findings. Workbenches
remain included in backup/restore, and moving a memo into Capture remains an explicit user action.
