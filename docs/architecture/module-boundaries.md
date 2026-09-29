# Module boundaries

## Dependency direction

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

## Hard rules

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
