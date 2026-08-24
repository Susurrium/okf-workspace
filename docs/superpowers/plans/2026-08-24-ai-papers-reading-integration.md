# AI Papers Reading Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Export the existing remote `ai_papers` collection through `feed-export.v1`, synchronize it through an independent local cursor, and show the latest complete issue as a fixed scrollable Reading card without changing Today or subscription management.

**Architecture:** AI Daily adds the opt-in `papers` stream while preserving the existing three-stream response and learning-only Registry projection. OKF Engine parses the preserved papers Markdown into the existing `FeedEdition` model and runs a second export lane under the same lock, but with its own cursor and feature flag. The Dashboard exposes the latest papers edition separately from `ai_daily` and renders it before the managed subscription-source grid.

**Tech Stack:** Python 3.12, Pydantic, pytest, Ruff, Pyright, TypeScript, Obsidian API, Vitest, esbuild, PowerShell, OpenSSH forced-command deployment.

**Spec:** `docs/superpowers/specs/2026-08-24-ai-papers-reading-integration-design.md`

## Global Constraints

- Preserve `feed-export.v1`; old requests for `hotspot`, `news`, and `learning` must remain byte-shape compatible.
- Keep the Registry projection restricted to `ai_learning`; `ai_papers` is a system feed, not a user-managed subscription.
- Use `source_id = system:ai-papers-of-the-week` and `source_name = AI Papers of the Week` for every papers item.
- Use edition ID `<issued-date>-papers-<sha256(artifact_id) first 12>` and item ID `ai-daily:papers:<sha256(canonical-paper-url) first 24>`.
- Store the papers cursor at `State/feed-sync/ai-daily-papers-export-cursor.json`; never read or move `ai-daily-export-cursor.json` for papers.
- Advance the papers cursor over empty pages so a later historical row cannot trap synchronization.
- Gate the local papers lane with `papers_enabled: true` in the `ai-daily` producer configuration; missing or false retains current behavior.
- Today continues to show only China Hotspots, AI News, and Treehole; papers must never enter `latest_ai_daily` or `latest_ai_daily_streams`.
- Reading shows papers as a fixed system card before subscription cards; it has no source enable, disable, remove, or repair controls.
- Preserve remote archive and outbox bytes; local Digest materialization may be semantically equivalent rather than byte-identical.
- Producer deployment precedes consumer enablement. Rollback disables `papers_enabled` and preserves cache plus both cursor files.
- Do not add or confirm the Machine Intelligence subscription during this rollout; only verify that preview now succeeds after Engine restart.

---

### Task 1: Export `ai_papers` as the opt-in `papers` stream

**Files:**
- Modify: `E:/code/aidaily/src/aidaily_bridge/feed_export.py:36-45`
- Modify: `E:/code/aidaily/tests/bridge/test_feed_export.py`

**Interfaces:**
- Consumes: `Collection.AI_PAPERS.value == "ai_papers"` and the existing `FeedExportHandler.handle(request: dict[str, object]) -> dict[str, Any]`.
- Produces: a valid `streams: ["papers"]` request whose documents use `stream: "papers"`; all other requested-stream and Registry behavior is unchanged.

- [ ] **Step 1: Write the failing exporter tests**

Add a papers artifact to the existing StateStore fixture and assert:

```python
response = handler.handle(
    {
        "protocol": "feed-export.v1",
        "request_id": "papers-only",
        "action": "sync",
        "after": None,
        "streams": ["papers"],
        "limit": 30,
        "include_registry": True,
    }
)
result = response["result"]
assert [document["stream"] for document in result["documents"]] == ["papers"]
assert set(result["stream_status"]) == {"papers"}
assert {source["source_id"] for source in result["registry"]["sources"]} == {
    "ruanyf-weekly"
}
```

Also request `streams: ["hotspot", "news", "learning"]` and assert papers is absent from both `documents` and `stream_status` while the cursor still advances over unselected papers rows.

- [ ] **Step 2: Run the exporter tests and verify RED**

Run: `python -m pytest tests/bridge/test_feed_export.py -q`

Expected: FAIL because `papers` is rejected as an unsupported stream.

- [ ] **Step 3: Add the one mapping required by the protocol**

Change the mapping to:

```python
_STREAM_BY_COLLECTION = {
    Collection.CHINA_HOTSPOTS.value: "hotspot",
    Collection.AI_NEWS.value: "news",
    Collection.AI_LEARNING.value: "learning",
    Collection.AI_PAPERS.value: "papers",
}
```

Do not change the existing `Collection.AI_LEARNING` Registry filter.

- [ ] **Step 4: Verify exporter compatibility**

Run: `python -m pytest tests/bridge/test_feed_export.py -q`

Run: `python -m pytest tests/bridge -q`

Run: `python -m ruff check src/aidaily_bridge tests/bridge`

Expected: all commands PASS and legacy requests contain no papers fields.

- [ ] **Step 5: Commit the producer change**

```powershell
git add src/aidaily_bridge/feed_export.py tests/bridge/test_feed_export.py
git commit -m "feat: export AI papers feed stream"
```

### Task 2: Parse preserved AI Papers Markdown into stable feed editions

**Files:**
- Modify: `engine/src/okf_workspace/feeds/adapters.py`
- Modify: `engine/tests/integration/test_feed_adapters_cli.py`

**Interfaces:**
- Consumes: `ai_papers_markdown_from_v1(markdown: str, *, artifact_id: str) -> FeedEdition` input containing YAML `date`, one `## Top AI Papers of the Week...` heading, and ordered table rows `| N) **Title** - Description | [Paper](https://...) |`.
- Produces: `FeedEdition(feed=FeedKind.AI_DAILY, stream="papers")` with fixed system source identity, stable IDs, rank metrics, description bodies, and upstream URLs.

- [ ] **Step 1: Write parser tests for identity, order, and completeness**

Use this complete fixture:

```python
markdown = """---
title: "AI Papers of the Week"
date: "2026-08-17"
---

> 以下标题与正文完整保留 AI Papers of the Week 最新一期。

## Top AI Papers of the Week (August 11 - August 17) - 2026
| **Paper** | **Links** |
| --- | --- |
| 1) **First Paper** - First description. | [Paper](https://arxiv.org/abs/2608.00001) |
| 2) **Second Paper** - Second description. | [Paper](https://example.org/paper?id=2) |
"""
edition = ai_papers_markdown_from_v1(markdown, artifact_id="ai-papers:2026-08-17")
expected_hash = hashlib.sha256(b"ai-papers:2026-08-17").hexdigest()[:12]
assert edition.edition_id == f"2026-08-17-papers-{expected_hash}"
assert edition.stream == "papers"
assert [item.title for item in edition.items] == ["First Paper", "Second Paper"]
assert [item.metrics["rank"] for item in edition.items] == [1, 2]
assert {item.source_id for item in edition.items} == {"system:ai-papers-of-the-week"}
```

Assert duplicate rank, gapped rank, duplicate canonical URL, missing description, and a second issue heading each raise `ValueError` instead of producing a partial edition.

- [ ] **Step 2: Run parser tests and verify RED**

Run: `python -m pytest engine/tests/integration/test_feed_adapters_cli.py -q -k papers`

Expected: FAIL because `ai_papers_markdown_from_v1` does not exist.

- [ ] **Step 3: Implement the strict papers parser**

Add constants and the public function with this contract:

```python
_AI_PAPERS_SOURCE_ID = "system:ai-papers-of-the-week"
_AI_PAPERS_SOURCE_NAME = "AI Papers of the Week"

def ai_papers_markdown_from_v1(
    markdown: str,
    *,
    artifact_id: str,
) -> FeedEdition:
    issue_date = _frontmatter_value(markdown, "date")
    if not issue_date:
        raise ValueError("AI Papers Markdown has no date")
    # Find exactly one issue heading and parse every numbered paper row.
    # Require ranks 1..N and unique canonical HTTP(S) URLs.
    edition_hash = hashlib.sha256(artifact_id.encode("utf-8")).hexdigest()[:12]
    edition_id = f"{issue_date}-papers-{edition_hash}"
    # Build FeedItem values in rank order; metrics={"rank": rank}.
```

Canonicalize only scheme/host casing and remove a URL fragment; preserve path and query because paper identity may depend on them. Reject credentials, non-HTTP(S) schemes, missing hosts, and blank artifact IDs.

- [ ] **Step 4: Verify parser behavior and regression safety**

Run: `python -m pytest engine/tests/integration/test_feed_adapters_cli.py -q`

Run: `python -m ruff check engine/src/okf_workspace/feeds/adapters.py engine/tests/integration/test_feed_adapters_cli.py`

Expected: PASS.

- [ ] **Step 5: Commit the parser**

```powershell
git add engine/src/okf_workspace/feeds/adapters.py engine/tests/integration/test_feed_adapters_cli.py
git commit -m "feat: parse AI papers feed editions"
```

### Task 3: Synchronize papers through an isolated export lane

**Files:**
- Modify: `engine/src/okf_workspace/feeds/sync.py:19-22,525-875,881-900`
- Modify: `engine/tests/integration/test_feed_export_sync.py`

**Interfaces:**
- Consumes: `RemoteFeedPuller.feed_export(alias, *, after, streams, limit, include_registry)` and `ai_papers_markdown_from_v1(markdown, *, artifact_id)`.
- Produces: `_sync_incremental_ai_daily(alias: str, puller: RemoteFeedPuller, *, papers_enabled: bool = False) -> tuple[FeedEdition, ...]`, a core lane on `ai-daily-export-cursor.json`, and a papers lane on `ai-daily-papers-export-cursor.json`.

- [ ] **Step 1: Write failing integration tests for lane isolation**

Create a puller that records requests and returns one empty core page followed by one papers document. Assert:

```python
stored = syncer._sync_incremental_ai_daily("ai-daily-feed-export", puller, papers_enabled=True)
assert [call["streams"] for call in puller.calls] == [
    ["hotspot", "news", "learning"],
    ["papers"],
]
assert (state / "feed-sync/ai-daily-export-cursor.json").read_text() == original_core_cursor
assert json.loads(
    (state / "feed-sync/ai-daily-papers-export-cursor.json").read_text()
)["cursor"] == papers_next_cursor
assert cache.latest_edition(FeedKind.AI_DAILY, stream="papers") is not None
```

Add tests that `papers_enabled=False` makes no papers request, an empty papers page still commits its advanced cursor, a papers failure is recorded as `stream="papers"` without discarding successfully stored core editions, and a papers response cannot replace the learning Registry mirror.

- [ ] **Step 2: Run the lane tests and verify RED**

Run: `python -m pytest engine/tests/integration/test_feed_export_sync.py -q -k papers`

Expected: FAIL because the method has no `papers_enabled` argument and only one cursor lane.

- [ ] **Step 3: Parameterize validation and cursor storage**

Introduce:

```python
_AI_DAILY_CORE_STREAMS = ("hotspot", "news", "learning")
_AI_PAPERS_STREAMS = ("papers",)

def _export_cursor_path(self, lane: str = "core") -> Path:
    name = (
        "ai-daily-papers-export-cursor.json"
        if lane == "papers"
        else "ai-daily-export-cursor.json"
    )
    return self.state / "feed-sync" / name
```

Make `_load_export_cursor`, `_commit_export_cursor`, `_validate_stream_health`, and `_validate_export_documents` receive the exact allowed stream tuple and lane. For papers documents, pass `document["cursor"]["artifact_id"]` to the papers parser. Keep learning source-name mapping only in the core lane.

- [ ] **Step 4: Run both lanes under the existing shared lock**

Refactor the page loop into a private lane helper called only while `.ai-daily-export.lock` is held. The core lane uses `include_registry=True`, commits `ai-daily-stream-status.json`, and retains current error behavior. The papers lane uses `include_registry=False`, never changes the Registry mirror or core health file, records remote degraded/error status as `stream="papers"`, and commits only its own cursor.

Read `papers_enabled` strictly:

```python
papers_enabled = config.get("papers_enabled") is True
return self._sync_incremental_ai_daily(
    export_alias,
    RemoteFeedPuller(self.state),
    papers_enabled=papers_enabled,
)
```

- [ ] **Step 5: Verify both incremental and legacy behavior**

Run: `python -m pytest engine/tests/integration/test_feed_export_sync.py -q`

Run: `python -m pytest engine/tests/integration/test_feed_workflow.py -q`

Expected: PASS; existing tests still see only the core request when the new flag is absent.

- [ ] **Step 6: Commit the isolated sync lane**

```powershell
git add engine/src/okf_workspace/feeds/sync.py engine/tests/integration/test_feed_export_sync.py
git commit -m "feat: sync AI papers with an independent cursor"
```

### Task 4: Expose papers to Reading while proving Today exclusion

**Files:**
- Modify: `engine/src/okf_workspace/dashboard/feeds.py:526-562`
- Modify: `engine/src/okf_workspace/dashboard/views.py:113-165`
- Modify: `engine/tests/integration/test_dashboard_views.py`
- Modify: `engine/tests/integration/test_feed_workflow.py`

**Interfaces:**
- Consumes: the latest cached `FeedEdition` where `feed=ai-daily` and `stream=papers`.
- Produces: optional `ai_papers: FeedDigestEdition | null` in `feed_dashboard`; no Today contract changes.

- [ ] **Step 1: Write failing dashboard and Today tests**

Store a newer papers edition plus older hotspot/news editions and assert:

```python
digest = feed_dashboard(state)
assert digest["ai_papers"]["section"] == "papers"
assert {item["source_id"] for item in digest["ai_papers"]["items"]} == {
    "system:ai-papers-of-the-week"
}
assert [value["section"] for value in digest["ai_daily"]] == ["hotspot", "news", "learning"]

today = today_view(vault, state, date(2026, 8, 24))
assert today["latest_ai_daily"]["section"] != "papers"
assert {value["section"] for value in today["latest_ai_daily_streams"]} <= {
    "hotspot", "news"
}
```

- [ ] **Step 2: Run tests and verify RED**

Run: `python -m pytest engine/tests/integration/test_dashboard_views.py engine/tests/integration/test_feed_workflow.py -q -k papers`

Expected: FAIL because `feed_dashboard` has no `ai_papers` property; the Today assertion also catches `_latest_feed` accidentally selecting papers.

- [ ] **Step 3: Add the separate dashboard projection and harden Today**

In `feed_dashboard`, load papers independently:

```python
papers = cache.latest_edition(FeedKind.AI_DAILY, stream="papers")
return {
    "ai_daily": [_digest(edition, decisions) for edition in streams],
    "ai_papers": _digest(papers, decisions) if papers else None,
    "ai_daily_sync": ai_daily_sync,
    "treehole": _digest(treehole, decisions) if treehole else None,
}
```

Replace the generic `latest_ai_daily` lookup in `today_view` with a newest-edition choice restricted to `hotspot` and `news`; keep `_latest_ai_daily_streams` explicitly restricted to those same streams.

- [ ] **Step 4: Verify API projections**

Run: `python -m pytest engine/tests/integration/test_dashboard_views.py engine/tests/integration/test_feed_workflow.py engine/tests/integration/test_local_api.py -q`

Expected: PASS and older cache states return `ai_papers: null`.

- [ ] **Step 5: Commit projection changes**

```powershell
git add engine/src/okf_workspace/dashboard/feeds.py engine/src/okf_workspace/dashboard/views.py engine/tests/integration/test_dashboard_views.py engine/tests/integration/test_feed_workflow.py
git commit -m "feat: expose AI papers only in Reading"
```

### Task 5: Render a fixed scrollable AI Papers card before subscriptions

**Files:**
- Modify: `dashboard/src/feeds/types.ts:65-100,324`
- Modify: `dashboard/src/plugin/dashboard-view.ts:1215-1325`
- Modify: `dashboard/styles.css`
- Modify: `dashboard/tests/dashboard-view.test.ts`

**Interfaces:**
- Consumes: `FeedDashboardDigest.ai_papers: FeedDigestEdition | null` with `section: "papers"`.
- Produces: one `article.okf-feed-project--papers` in Reading, before `section.okf-reading-source-grid`, with the same header/meta/scroll/body/footer composition used by Today cards.

- [ ] **Step 1: Write failing DOM tests**

Seed the dashboard digest with one two-item papers edition and one subscription source. Assert:

```typescript
const papers = container.querySelector(".okf-feed-project--papers");
const sourceGrid = container.querySelector(".okf-reading-source-grid");
expect(papers).not.toBeNull();
expect(
  papers!.compareDocumentPosition(sourceGrid!) & Node.DOCUMENT_POSITION_FOLLOWING,
).toBeTruthy();
expect(papers!.querySelectorAll(".okf-feed-item")).toHaveLength(2);
expect(papers!.textContent).toContain("AI Papers of the Week");
expect(papers!.textContent).not.toContain("停用");
expect(papers!.textContent).not.toContain("移除");
```

Add an empty-state test for `ai_papers: null` and a test that Today still has exactly three daily cards.

- [ ] **Step 2: Run the Dashboard tests and verify RED**

Run: `npm test -- --run dashboard/tests/dashboard-view.test.ts`

Expected: FAIL because the papers card is not rendered.

- [ ] **Step 3: Extend the TypeScript response contract**

Use a separate papers stream type so existing daily issue code stays narrow:

```typescript
export type AiDailyStream = "hotspot" | "news" | "learning";
export type AiPapersStream = "papers";

export interface FeedDashboardDigest {
  ai_daily: FeedDigestEdition[];
  ai_papers: FeedDigestEdition | null;
  treehole: FeedDigestEdition | null;
}
```

Allow `FeedDigestEdition.section` and `FeedDigestItem.section` to contain `AiDailyStream | AiPapersStream | null`.

- [ ] **Step 4: Render the card with the shared card surface**

At the start of Reading overview rendering, after the action buttons and before search/grid, create a section with `createFeedCardSurface`:

```typescript
const surface = this.createFeedCardSurface(container, {
  title: "AI Papers of the Week",
  meta: "正在读取最新一期…",
  cardClass: "okf-feed-card--scrollable okf-feed-project okf-feed-project--papers",
  headerClass: "okf-feed-project__header",
  bodyClass: "okf-feed-project__scroll okf-feed-project__preview",
  footerClass: "okf-feed-project__footer",
});
```

Populate it with `renderFeedDigestEdition(surface.body, "ai-daily", digest.ai_papers, { heading: false, mode: "compact" })`, a footer button opening the native AI Daily digest, and `attachFeedScroll("ai-daily-papers", surface.body)`. The empty state remains visible as one fixed card and does not block subscription rendering.

- [ ] **Step 5: Add only the papers accent token**

Use the same spacing, height, typography, and scrolling rules as Today. Add only a distinct papers accent variable/class; do not reuse Reading subscription-source green and do not introduce a new nested card hierarchy.

- [ ] **Step 6: Verify UI tests, typecheck, and build**

Run: `npm test -- --run dashboard/tests/dashboard-view.test.ts`

Run: `npm run check`

Run: `npm run build`

Expected: PASS and `dashboard/dist/main.js` is generated without warnings.

- [ ] **Step 7: Commit Dashboard changes**

```powershell
git add dashboard/src/feeds/types.ts dashboard/src/plugin/dashboard-view.ts dashboard/styles.css dashboard/tests/dashboard-view.test.ts dashboard/dist/main.js
git commit -m "feat: add AI papers Reading card"
```

### Task 6: Document, configure, and fully verify both repositories

**Files:**
- Modify: `docs/FEED-WORKFLOW.md`
- Modify: `deploy/windows/install.ps1` only if its generated default producer config is covered by a failing installer test
- Test: existing Engine and Dashboard suites

**Interfaces:**
- Consumes: `papers_enabled: boolean` under the existing `ai-daily` object.
- Produces: documented activation, cursor location, rollback, and operational verification commands.

- [ ] **Step 1: Add documentation assertions if deployment tests cover generated config**

If `install.ps1` generates `feed-producers.json`, extend its existing test to assert the generated `ai-daily` object contains `papers_enabled: false`. If deployment config is operator-owned and not generated, leave installer code unchanged.

- [ ] **Step 2: Document exact behavior**

Add these facts to `docs/FEED-WORKFLOW.md`: remote collection `ai_papers` maps to export stream `papers`; the local flag defaults disabled; papers use `ai-daily-papers-export-cursor.json`; Reading treats it as a fixed system source; Today and the managed subscription Registry exclude it; rollback is flag-off without deleting data.

- [ ] **Step 3: Run complete repository verification**

From `E:/code/aidaily`:

```powershell
python -m pytest tests/bridge -q
python -m ruff check src/aidaily_bridge tests/bridge
python -m pyright src/aidaily_bridge
```

From `E:/code/okf-workspace`:

```powershell
python -m pytest engine/tests -q
python -m ruff check engine/src engine/tests
python -m pyright engine/src
npm --prefix dashboard test -- --run
npm --prefix dashboard run check
npm --prefix dashboard run build
```

Expected: every command PASS with no new warnings.

- [ ] **Step 4: Commit documentation or generated-config changes**

```powershell
git add docs/FEED-WORKFLOW.md deploy/windows/install.ps1
git commit -m "docs: describe AI papers feed rollout"
```

Omit `deploy/windows/install.ps1` from `git add` when Task 6 Step 1 proves it is not a generated default.

### Task 7: Deploy producer first and prove protocol compatibility

**Files:**
- Deploy from: `E:/code/aidaily/src/aidaily_bridge/feed_export.py`
- Deploy from: `E:/code/aidaily/tests/bridge/test_feed_export.py`
- Runtime target: `/opt/ai-daily-bridge` with the existing 3.1.0 generation/deployment process

**Interfaces:**
- Consumes: forced command `/opt/ai-daily-bridge/deploy/bridge-v3/feed-export.sh` and SSH alias `ai-daily-feed-export`.
- Produces: a remote exporter accepting both old three-stream and new papers-only requests.

- [ ] **Step 1: Capture the current remote unit and generation state**

Use the established deployment script/document for 3.1.0 and record the active venv symlink, service status, and checksum before changing it. Do not edit live files in place.

- [ ] **Step 2: Install a new immutable generation and run remote tests**

Deploy the committed producer code using the repository's existing bridge-v3 release procedure, then run the remote `test_feed_export.py` suite in the new generation before switching the symlink.

- [ ] **Step 3: Switch the forced-command runtime and smoke-test both request shapes**

Send JSON on stdin through `ssh ai-daily-feed-export`:

```json
{"protocol":"feed-export.v1","request_id":"legacy-smoke","action":"sync","after":null,"streams":["hotspot","news","learning"],"limit":1,"include_registry":true}
```

Assert `ok=true`, no `papers` health key, and a learning-only Registry. Then send:

```json
{"protocol":"feed-export.v1","request_id":"papers-smoke","action":"sync","after":null,"streams":["papers"],"limit":30,"include_registry":false}
```

Assert `ok=true`, `stream_status` has only `papers`, and at least one retained papers artifact is exported.

- [ ] **Step 4: Verify scheduled services remain healthy**

Check `ai-daily-bridge-v3.timer`, `ai-daily-bridge-v3.service`, and `ai-daily-v3-stack.service`; rollback the forced-command symlink if either smoke request fails.

### Task 8: Deploy Engine and Dashboard, enable backfill, and verify the live result

**Files:**
- Deploy from: `E:/code/okf-workspace/engine`
- Deploy from: `E:/code/okf-workspace/dashboard/dist/main.js`
- Deploy from: `E:/code/okf-workspace/dashboard/manifest.json`
- Deploy from: `E:/code/okf-workspace/dashboard/styles.css`
- Configure: `E:/ObsidianData/OKF-Brain-State/feed-producers.json`
- Install target: `E:/ObsidianData/OKF-Brain/.obsidian/plugins/okf-workspace-dashboard`

**Interfaces:**
- Consumes: working remote `papers` export stream and local `papers_enabled: true`.
- Produces: live papers cache, independent cursor, Reading card, and a restarted Engine containing the Machine Intelligence URL fix.

- [ ] **Step 1: Snapshot local cursor checksums and deployment versions**

Record SHA-256 and JSON content for `ai-daily-export-cursor.json`, note whether `ai-daily-papers-export-cursor.json` exists, and record installed plugin version/checksum. These are read-only rollback evidence.

- [ ] **Step 2: Install Engine and Dashboard through existing scripts**

Run the repository's Windows Engine/Dashboard install procedure. Fully exit Obsidian before replacing the plugin bundle, then reopen it so the embedded Engine on `127.0.0.1:8765` loads the new Python code.

- [ ] **Step 3: Enable the papers lane without changing other producer keys**

Edit only the existing `ai-daily` object in `E:/ObsidianData/OKF-Brain-State/feed-producers.json` to add:

```json
"papers_enabled": true
```

Preserve `remote_kind`, `ssh_alias`, `feed_export_ssh_alias`, and all Treehole settings exactly.

- [ ] **Step 4: Trigger one feed sync and verify backfill isolation**

Call the existing local feed-sync API/CLI once. Assert the pre-sync and post-sync core cursor JSON are identical, `ai-daily-papers-export-cursor.json` now exists, and `FeedCache.latest_edition(FeedKind.AI_DAILY, stream="papers")` contains every row from the latest remote issue in rank order.

- [ ] **Step 5: Verify the live Dashboard**

Reload the Dashboard and assert Today still has exactly three cards. Open Reading and assert the AI Papers card appears before subscription-source cards, scrolls through the full latest issue, opens its native Digest, and has no subscription management controls.

- [ ] **Step 6: Verify the earlier Machine Intelligence bug in the restarted Engine**

Open Add Subscription, submit `https://wechat2rss.bestblogs.dev/feed/8d97af31b0de9e48da74558af128a4673d78c9a3.xml`, and run preview only. Assert preview succeeds and shows article URLs containing query parameters. Cancel without confirming the subscription.

- [ ] **Step 7: Run final health checks**

Confirm the local API is healthy, Feed Sync reports no new `papers` failure, the core cursor remains unchanged by the papers backfill, and neither Today nor the learning source catalog contains `system:ai-papers-of-the-week`.
