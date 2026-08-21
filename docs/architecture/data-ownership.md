# Data ownership

| Data | Owner | Readers |
| --- | --- | --- |
| Capture | Intake | Dashboard, workflows |
| Original manifest and blob | Intake | conversion pipeline |
| Source identity, durable `uses[]`, and Source Text | Sources | all Workspace modules, retrieval, Dashboard |
| Feed cache, Digest, and action receipt | Feeds | Dashboard, Sources, Operations |
| Course, Lesson, Study Guide | Workspace Learning | Dashboard, Claudian, retrieval |
| Wiki and Wiki Map | Workspace Knowledge | Dashboard, Claudian, retrieval |
| Project, log, and Decision | Workspace Projects | Dashboard, Claudian, retrieval |
| Daily, Reflection, Review | Workspace Life | Dashboard, Claudian, retrieval |
| Semantic and conversion state | Operations | Dashboard, workers |
| Contracts, templates, views, policies, Skills | Engine Workspace resources | Engine, deployed Vault, Dashboard, Claudian |

`Source.resource`, `kind`, and `text` describe a context-neutral input identity. Provenance such as
`ingested_via` records how the input first entered the Workspace; neither identity nor provenance says
what the user wants to do with it.

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
