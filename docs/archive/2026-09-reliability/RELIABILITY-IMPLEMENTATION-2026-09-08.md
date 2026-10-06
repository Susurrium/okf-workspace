# Reliability implementation — 2026-09-08

> 历史记录（2026-10-06 归档）。下文保留当时的方案、状态和验证证据，不作为当前实现要求；当前边界见[系统架构](../../architecture/README.md#system-overview)，有效文档见[文档索引](../../README.md)。

User decision: use MarkItDown by default; defer MinerU-specific lifecycle/SSH work.
Keep existing primary navigation and workflows. Do not migrate or discard user content.

## Checklist

- [x] Atomic create, optimistic version checks, path-keyed cross-process write locks.
- [x] Semantic publication validates before writing and merges against current human content.
- [x] Conversion archive/export path containment; default MarkItDown at all entry points.
- [x] Source identity transactions and Feed/Web supplementary-content preservation.
- [x] Retrieval scope applies to linked expansion and exact folder prefixes.
- [x] Durable RSS pending delivery, fair batches, single-fetch preview, visible source failures (code/tests; remote deployment pending).
- [x] MarkItDown temporary-artifact cleanup and bounded uploads (code/tests; remote deployment pending).
- [x] Papers edition identities, independent per-stream health and recovery.
- [x] Chronological project records and latest-progress display.
- [x] Subscription async lifecycle, recoverable Vault reads and conversation history.
- [x] Shared Learning/Project row actions and shared Feed decision handling.
- [x] Maintenance/restore paths, pinned upstream build recipe, deployment receipts and current acceptance documentation.
- [x] Full automated checks, fixture integration, local plugin deployment and artifact verification.
- [x] MarkItDown 1.4.0 remote deployment and real PDF/DOCX/PPTX conversion smoke tests.
- [x] AI Daily 3.2.0 activation and real independent Feed stream smoke tests (closed 2026-09-20).
- [x] Real Obsidian visual interaction/restart and single-service acceptance (closed 2026-09-20).

## Work ownership

- Root: file I/O, semantic worker, importer security/defaults, retrieval, deployment and integration.
- Engine review agent: Source/Feed preservation, identity transactions, papers health and note ordering.
- Frontend review agent: Dashboard and Claudian changes, tests and builds.
- Producer review agent: AI Daily and standalone MarkItDown changes, tests.

## Verification and boundaries

Record measured results below; do not substitute unit tests for live end-to-end verification.
Do not stage the unrelated PERSONALIZATION documents or modify the old obsidian repository.
No backup policy changes or automatic MinerU repair are part of this implementation.

## Results

Resumed 2026-09-12 after interruptions; implementation and deployment are tracked separately.

- Root `scripts/check.ps1` completed successfully on 2026-09-12: Engine **401**, cross-component **9**, MarkItDown service **35**, Dashboard **175**, Claudian Workspace **500** and architecture/config/release **23** tests passed. Python Ruff/Pyright, both TypeScript checks and Claudian ESLint passed. Two test-client deprecation warnings remain; no test failures.
- Claudian changed history/repository owners were additionally covered by **150** tests in four suites; this is scoped verification, not a claim that all upstream Claudian tests ran.
- AI Daily **135** tests passed, Ruff/Pyright passed, and 3.2.0 wheel/source distribution built. Mocked HTTP tests now isolate desktop proxy environment variables; a discovered SOCKS-environment failure was fixed in the test fixture without changing runtime RSS proxy behavior or system proxy settings.
- Dashboard and Claudian production builds succeeded. Installed versions are Dashboard **1.15.0** and Claudian **2.1.4-okf.3**; all six installed artifacts match source build SHA-256. The receipt path is `E:/ObsidianData/OKF-Brain-State/reports/deployment-receipt.json`. Receipt regression covers the Dashboard `dist/main.js` layout and rejects a stale installed build without replacing an existing receipt.
- Persisted production Dashboard setting was explicitly changed from `prefer-mineru` to `markitdown-only`; the default alone would not have migrated an existing preference. Only the canonical project-log template explanation was deployed; historical user logs were not reordered.
- Cross-component packaging/contracts: 9 passed (including MarkItDown 1.4.0 metadata).
- Restored the broken Engine venv with managed CPython 3.12.10 using `uv venv --allow-existing`; old system Python312 had been removed. Preserved dependencies, did not change the system default Python 3.14 or register a new default. Frozen sync installed Engine 1.11.0.
- Parser clients and service health probes connect directly to explicitly configured endpoints, without inheriting unrelated desktop proxy variables. MinerU is shown as deferred and is no longer automatically health-probed.
- Daily Maintenance installed settings: StartWhenAvailable=true, three retries ten minutes apart; existing battery restrictions and non-overlap policy preserved.
- Local pre-deploy backup: `E:/ObsidianData/OKF-Brain-State/deployment-backups/reliability-20260908-092438` (both plugin artifacts/settings, deployment config, Claudian settings, project-log template and previous source archive).
- Remote blocker at 2026-09-12: Tailscale is online locally, but `clab-obsidian-ingest` (`100.107.106.39`) is offline, last seen 2026-09-09 16:26:34 +08:00. No successful remote deployment is claimed. User has been asked to restore it while local work continues.
- Source write locks coordinate Workspace processes; optimistic hashes detect intervening editor changes. They do not claim a strong filesystem transaction with external editors that ignore the locks.
- `scripts/smoke-markitdown-import.py` is ready for real DOCX/PPTX → remote MarkItDown → Engine → disposable Vault acceptance after the server is reachable.
- Real production doctor confirms Engine 1.11.0, MinerU deferred, semantic/conversion/governance checks OK; MarkItDown unreachable and Feed stale while the server is offline. Search index was refreshed via `SearchIndex.sync()` after the template update, without regenerating the user's root navigation or changing note contents.
- No remote configuration/registry/state migration has been performed. Restic remains unconfigured/disabled; backup path corrections are tested with fixtures, not a real external backup restore drill. No Git commit/push was made, and unrelated PERSONALIZATION documents were left untouched.

## Prepared remote artifacts and resumption

- MarkItDown 1.4.0 release bundle:
  `E:/code/okf-workspace/dist/markitdown/markitdown-release-20260912T061158Z-65bedabaea7a.tar.gz`
  (companion `.sha256` file exists).
  Archive SHA-256: `db00587798c43ab1269029355d4de3a7ddca52aa09c8a90f799fe6f7cdb95f7a`.
  Manifest SHA-256: `65bedabaea7a5c2afee2b28469ebb9d76543e43c09868ab9d27b826ea3081f1d`.
- AI Daily 3.2.0 source distribution:
  `E:/code/aidaily/dist/aidaily-3.2.0.tar.gz`.
  SHA-256: `489a317bcb2618bf7b8aab8f8e04ee5dce4d8ad8556f343625fee436a34a72b7`.
  Includes source, default registry and all deployment scripts including `build-trendradar.sh`; it does not replace the live registry in `/srv/ai-daily/bridge`.

Resume after `clab-obsidian-ingest` is online:

1. Read-only verify host identity, service state, actual data mount, current release and backup locations before writes. Preserve current tokens, source registry and SQLite state.
2. Back up the exact live AI Daily code/config/state under its existing deployment lock. Stage 3.2.0, build the pinned TrendRadar recipe on Linux, then use the existing staged-install/activation procedure. Do not overwrite the live source registry with package defaults.
3. Install the verified MarkItDown bundle using `install-release-bundle.sh`; deployment activation is a separate step using its existing guarded deploy/rollback scripts. Check service 1.4.0 plus the expected manifest digest, not only HTTP liveness.
4. From `E:/code/okf-workspace`, run:
   `engine/.venv/Scripts/python.exe scripts/smoke-markitdown-import.py --config E:/ObsidianData/OKF-Brain-State/config/deployment.json`.
   Also exercise the service's real PDF smoke verification. Fixtures remain disposable; user originals are not test inputs.
5. Verify subscription preview/confirm, independent news/hotspot/learning/papers exports and local Feed sync. Check backlog recovery and visible failures; record observed remote versions and results here.
6. Open/reload Obsidian and verify Today/Reading, Learning/Project actions, subscription close/retry, conversation history recovery, parser preference and single-process local API lifecycle.

Pinned source/runtime versions improve clean-host build repeatability, but do not claim a
bit-for-bit reproducible image or a successful clean-host build before it is actually run.

## 2026-09-14 server resumption and findings

The server is online. Verified `clab-obsidian-ingest`, noninteractive sudo,
`/srv/ai-daily` on `/dev/sdb`, `/srv/markitdown-data` on `/dev/sdc`, both ext4,
and the existing MarkItDown 1.3.0 container/release identities before writing.

- MarkItDown **1.4.0 is deployed** from the revised release bundle
  `E:/code/okf-workspace/dist/markitdown/markitdown-release-20260914T034047Z-a980343b651a.tar.gz`
  (archive SHA-256 `51e1092e09d3e78145721f6f9724f29e37ff52bfad91959187c58e67ad115cf3`,
  bundle manifest `a980343b651ae9af9865c371ea288231b15b75330bd87ff0cad1a9862c195636`).
  API/Worker containers are healthy. Runtime topology remains internal-only API,
  networkless Worker, loopback-only host proxy. The new systemd ExecStart points
  at the exact `a980...` release. The previous 1.3.0 bundle remains linked as
  `previous`; no old release or source data was deleted.
- The deploy script's authenticated real PDF canary passed upload, poll,
  result download, manifest/hash and expected text. Client-side
  `scripts/smoke-markitdown-import.py` then passed DOCX and PPTX through the
  configured Tailnet endpoint into a disposable Vault. Both produced valid
  Source + Source Text, and PPTX kept one embedded image asset. The disposable
  Vault passed structural validation.
- First 1.4.0 attempt used Docker's forced base-image pull and failed because
  `docker.m.daocloud.io` timed out. Its image was not activated. The older
  bundle's rollback script then failed because its own `.env.rollback.*`
  temporary file was rejected by `verify-release.sh`. Under the release lock,
  exact old `.env`/recorded environment hashes, running image ID, health and
  systemd old path were checked; only the managed `current`/`previous` pointers
  were reconciled. A new 1.4.0 bundle uses the already installed pinned base
  image when available and host egress for **build-time** locked dependencies;
  no runtime network privileges changed. Its self-rollback temporary file is
  outside the manifest tree. The intermediate failed release remains installed
  but inactive; it was not deleted.
- AI Daily remains **3.1.0**. Its 3.2.0 source archive was uploaded only to
  `/tmp/okf-aidaily-320.SdBYOtUg/aidaily-3.2.0.tar.gz` and remotely matched
  SHA-256 `489a317bcb2618bf7b8aab8f8e04ee5dce4d8ad8556f343625fee436a34a72b7`.
  No live AI Daily code, registry, keys, SQLite or timer was modified during
  this resumption.
- The 3.1.0 upgrade still has the root-only pending marker
  `/root/ai-daily-release-stamp` from `20260823T102908Z`. The documented
  finalize path requires a successful production run and UI acceptance.
  Recent production runs failed all four collections, so this marker must not
  simply be renamed to a completed release. The 3.0 rollback code, image and
  State/config snapshots matching that stamp still exist. The current SQLite
  database passed `PRAGMA integrity_check` and contains 119 artifacts;
  fixed `source-admin.v1` and `feed-export.v1` read calls both succeeded.
- `ai-daily-v3-stack.service` fails because TrendRadar's existing container
  is unhealthy. Its web healthcheck cannot connect to port 8080, and its
  scraper reports unreachable upstream. The container has DNS and a default
  route; its outbound SYN leaves `enp3s0` after masquerading to the host IP,
  but no reply reaches that interface. Direct host HTTPS works, and a trusted
  cached Python image can fetch PyPI with `--network host`. This is a **container
  egress** problem, not proof that the RSS sources themselves are invalid.
  A disposable invocation of the existing `SafeHTTPFetcher` on the cached
  3.1.0 image with host networking fetched a public `robots.txt` (HTTP 200),
  confirming the application's HTTP client itself can reach public sites
  through host egress. Host networking alone is not a complete solution:
  the exact TrendRadar upstream
  `https://newsnow.busiyi.world/api/s?id=baidu&latest` returned HTTP 403
  from Cloudflare when requested directly from the server. The hotspot
  source therefore needs an independently verified reachable upstream or
  authorized network path as well.
  Both the persistent TrendRadar and one-shot AI Daily collector depend on
  external HTTP; deploying 3.2.0 without resolving egress would leave the
  daily updates broken. Do not disable the pending marker or replace 3.1.0
  merely to report a version upgrade.
- The workstation deployment config still pointed `codex_command` at the
  removed `%AppData%/npm/codex.cmd`. The installed CLI is now
  `D:/code/.tools/npm-global/codex.cmd` (version 0.154.0); updated only this
  config field. The real production doctor now reports only stale Feeds as
  actionable.

To complete AI Daily, determine whether this host's Docker bridge egress can
be repaired while preserving the existing runtime isolation. If not, review a
specific restricted egress route for the two collector processes. The dynamic
RSS reader uses `SafeHTTPFetcher`, which pins public resolved addresses and
does not currently use HTTP proxy environment variables; adding a generic
proxy variable to Compose would not repair that path. TrendRadar's
current web server binds `0.0.0.0:8080`, so switching its container directly
to host networking would expose its output and is not an acceptable one-line
change. After the network behavior is verified, use a fresh exact snapshot of
3.1.0 code/keys/config/SQLite/image under the existing upgrade lock, preserve
the older pending marker as an explicitly superseded failed rollout rather
than claiming it completed, activate 3.2.0 in staged mode, and verify all
four streams and client Reading/Today before enabling the timer.

## 2026-09-14 later network diagnosis and local recovery preparation

The earlier phrase "container egress problem" described the first test window,
not a proven Docker-only root cause. A later explicit address-family comparison
found that the host itself times out on direct public IPv4 while direct IPv6
to `example.com` returns HTTP 200. The CLab IPv4 gateway responds locally,
and the AI Daily Docker bridge is IPv4-only (`EnableIPv6=false`). The container
also times out on public IPv4. This makes a CLab outbound IPv4 session or
policy problem the first hypothesis to test; `clabcli connect` may restore it,
but no authentication attempt or network mutation has yet been made. If host
IPv4 recovers while container IPv4 remains broken, then investigate Docker
forwarding/NAT separately. The previous host-network fetch likely used IPv6
and therefore cannot by itself establish working IPv4 egress.

The TrendRadar container later became `healthy`, but its configured healthcheck
only probes localhost port 8080. The 2026-09-14 TrendRadar database has zero
`news_items` despite five crawl records. The stack oneshot retains its failed
boot result, and the bridge's hard `Requires` dependency prevented that run.
The latest AI Daily outbox file was written on 2026-09-08. Independently,
the NewsNow API returned Cloudflare HTTP 403 over reachable IPv6; it must be
retested after IPv4 recovery, not conflated with the missing IPv4 route.

Locally, the AI Daily stack unit now has `Restart=on-failure` and the bridge
unit has a soft `Wants` dependency on the stack, allowing a failed collector
startup to be captured as a bridge run error. Two regression tests were added;
the targeted deployment tests passed. These edits are local only and are not
part of the previously staged 3.2.0 archive. Production still runs 3.1.0.

## 2026-09-14 connected recovery and AI Daily 3.2.0 activation

After the user restored the CLab external session, host and Docker-bridge
public IPv4 both fetched `https://example.com` with HTTP 200. Docker NAT was
not changed. The public NewsNow API still returned HTTP 403 from Cloudflare,
including from the workstation. A private-network NewsNow canary using pinned
image digest `sha256:521dcc44b528692eab3e33f2d0f4c694bea054b4f12c7e2d3ae2e464aebde513`
returned nonempty HTTP 200 responses for all 11 TrendRadar platforms and
passed the configured domain checks. The canary was stopped after the new
production NewsNow container became healthy; it exposed no host port.

- Reconciled the old failed stack unit without replacing its container. With
  the existing 3.1.0 code, a 2026-09-14 dry-run succeeded for AI News (20),
  Learning (25) and Papers (10). These three streams were then emitted for
  real and consumed locally by `okf feed sync ai-daily`; the Feed cache lists
  the 2026-09-14 editions with counts 20/25/10. China Hotspots failed for
  that period because it requires the missing 2026-09-13 TrendRadar database.
- Before the cutover, made verified AI Daily backup
  `/srv/markitdown-data/backups/ai-daily-v3/ai-daily-v3-20260914T103724Z.tar.gz`
  and copied the exact old live code, runtime keys and units to root-only
  `/root/ai-daily-3.2-pre.OEU2U0P1`. The prior live code remains at
  `/opt/ai-daily-bridge-prev-20260914`; no user registry or SQLite state was
  replaced. The original pending release marker remains unchanged.
- The deployed source archive is
  `E:/code/aidaily/dist/recovery-20260914b/aidaily-3.2.0.tar.gz`, SHA-256
  `186d7478c6619bda59ddbc3449bd16ce16bb012c425c97587b93116d6bbb9035`.
  It was matched on the remote host. The app image was rebuilt as
  `sha256:a8769efc953b83961ef22dc52e1fb127ef84ad1a47f594d5bea929a80fd91d4e`.
  The existing reviewed TrendRadar image
  `sha256:147149ca091ba63051039dcc5f59f665ec56a90935b4781bfe8e172694e82370`
  was deliberately carried forward: a reproducible rebuild could not finish
  because the Docker Hub and GitHub source endpoints timed out/intermittently
  failed. This is not a claim of a successful clean-host TrendRadar build.
- Production AI Daily 3.2.0 stack now has healthy internal `newsnow` and
  TrendRadar containers. TrendRadar successfully crawled all 11 sources and
  its 2026-09-14 database contains 302 news items. A 2026-09-15 China
  Hotspots dry-run produced 33 items titled for 2026-09-14, consistent with
  the configured one-day lag; it was not prematurely published. The source
  registry hash and SSH public-key fingerprints were unchanged, SQLite
  integrity is OK with 122 artifacts, and source-admin and feed-export read
  calls succeeded. The local sync saw no duplicate editions. The bridge timer
  is active/enabled, next scheduled 2026-09-15 06:40 Asia/Shanghai; the stack
  unit is active. All 139 bridge tests passed locally after the deployment
  changes, including the final rerun.
- MarkItDown's persistent backup timer collided with the main service's
  `activating` state during the Sep 14 reboot catch-up. The backup script
  checks only `is-active`, so it did not stop the still-starting writer and
  `tar` failed on `state/jobs.sqlite-wal`. A new cold backup at
  `/srv/ai-daily/backups/markitdown/obsidian-markitdown-20260914T104805Z.tar.gz`
  passed SHA-256 verification after explicitly stopping the service, and the
  service restarted healthy. The monitor rerun reported `Result=success`.
  Installed an ordering drop-in, source-tracked at
  `deploy/markitdown/systemd/obsidian-markitdown-backup.service.d/boot-order.conf`,
  to wait for main service startup before the persistent backup job. The
  drop-in passed privileged `systemd-analyze verify`; the next boot-specific
  catch-up scenario remains to be observed.

Remaining acceptance: the 2026-09-15 scheduled run must publish the first
recovered China Hotspots edition; the missing Sep 13 source data cannot be
reconstructed from the Sep 14 crawler. The local API/Obsidian UI was not
running during server checks, so visual Today/Reading acceptance is not yet
claimed. Keep the old pending release marker and rollback snapshots until
those checks pass.

## 2026-09-20 final development-stage acceptance

The remaining development-stage acceptance was completed and supersedes the
open status recorded above:

- AI Daily 3.2.0 and the local Feed synchronization path are operational. The
  2026-09-20 scheduled run produced current News and Learning editions. The
  Learning edition contains 22 items. One `ruanyf-weekly` request timed out,
  while the other streams and sources completed; no daily content was lost.
  This isolated producer timeout is non-blocking and will be retried by the
  normal schedule.
- The Obsidian Dashboard was visually accepted. During the restart check there
  was exactly one local API listener on `127.0.0.1:8765`, and its health check
  succeeded. After Obsidian exited, no Obsidian, local API, or semantic worker
  process remained. This closes visual, restart, single-service, and
  exit-lifecycle acceptance.
- The default-parser user guide correction was committed and pushed as
  `f898c1d` (`docs: align import guide with MarkItDown default`). `main` and
  `origin/main` were synchronized and the worktree was clean at acceptance.

The following are explicit development-stage decisions, not open acceptance
failures:

- Keep reliability work in the existing consolidated commit `0211584`; do not
  rewrite published history solely to split it into component commits.
- Defer release packaging, the release tag, and a new clean deployment receipt
  until feature development is complete. The current repository state is not
  claimed as a formal release.
- Defer the independent Restic repository during development because the
  current production data volume is small and disposable. Before formal use,
  configure the independent repository, complete the first backup, and perform
  a real restore test.
