# Apex upstream baseline

The unified workbench imports PandoraReads/apex-dashboard as a source subtree at `dashboard/apex/`.
The current accepted source baseline is Apex 3.6.5. Its upstream validation and the 2026-09-29 production
cutover are recorded in the [acceptance ledger](ACCEPTANCE.md).

| Field | Locked value |
| --- | --- |
| Upstream | `https://github.com/PandoraReads/apex-dashboard.git` |
| Imported commit | `e8d99517c3e76a52a9bfe3ed75251a0d652d4a34` |
| Upstream release | `3.6.5` |
| Import prefix | `dashboard/apex/` |
| Unified plugin ID | `okf-workspace-dashboard` |
| Upstream plugin ID | `apex-dashboard` (source validation only) |
| License | Upstream `LICENSE` retained with the subtree |

The subtree is source provenance, not a second installed Obsidian plugin. The root `dashboard/` build is the
only release entry point. Generic integration patches inside the subtree must remain usable with default
upstream implementations and must not import OKF domain modules directly.

The imported `main.js` bundle and nested GitHub release/build workflows are not
retained in this monorepo. Build outputs are generated locally; CI and releases
are owned by the root workflow. Upstream source, styles, license, package metadata,
and validation scripts remain available for deliberate upgrades.

## Accepted 3.6.5 validation

The 3.6.5 subtree candidate passed Apex lint, TypeScript/esbuild production build, and all 44 Apex
`test:*` scripts. The unified Dashboard checks and root `scripts/check.ps1` passed. P01–P08, including
isolated Obsidian acceptance and upgrade/rollback comparison, are recorded in the acceptance ledger.
This promotes the source baseline for integration/release review. Production cutover completed on
2026-09-29; see the acceptance ledger for that installed-runtime evidence.

The original 2.5.4 import and 3.6.0 rehearsal remain historical provenance. Their exercise reports are
retained in Git history; the acceptance ledger records the accepted 3.6.5 outcome.

## Update procedure

1. Read the adoption policy below, then record the candidate commit and release.
2. Port the selected changes into `dashboard/apex/`, retaining the imported baseline and recording each source commit. A complete subtree upgrade requires a scope that permits all of its behavior changes.
3. Review changes to the parser/serializer, section types and menus, task/date parsing, Daily routing,
   database edits, plugin data paths, settings, and service lifetimes.
4. Run the upstream build/scripts, the unified Dashboard checks, shared fixture tests, and the acceptance
   scenarios in `dashboard/ACCEPTANCE.md`.
5. Exercise critical flows in the persistent test Vault using the [development acceptance rules](../docs/DEVELOPMENT.md#合成-vault-完整流程). Use a temporary fixture only when the upgrade scenario requires independent initial state; complete its cleanup and record the accepted commit here.
6. After acceptance or production cutover, update this baseline and the acceptance ledger with the resulting
   status. Retain completed audit and exercise reports in Git history, and keep the current outcome in
   this baseline and the acceptance ledger.

Passing a Git merge or TypeScript compilation alone is not an accepted upstream update.

## 上游采用策略

用户于 2026-10-15 确定以下范围。完整导入基线仍为 3.6.5 / `e8d99517c3e76a52a9bfe3ed75251a0d652d4a34`；
本轮选择性移植参考固定为 3.8.5 / `b90d1c54b9c694d192c09173fb5a7d105cbccef4`。这不表示完整接受 3.8.5。

### 采用范围

微信读书请求版本 1.0.5；当前组件的通用界面与拖动稳定性修复；完整图标选择；自定义主题保存与外观工作室命令；
番茄钟正计时、提醒和统一设置；记账分类管理；分区导航轨；音乐减少逐曲失败提示；胶囊主题；
移除备忘录改色按钮；没有保存偏好时默认固定侧栏。

用户于 2026-10-16 追加采用 OKF 项目类别、分组、看板、置顶和手动排列。
项目类别进入 Project Contract；界面复用现有 OKF 项目、任务与关联读写，
不导入上游独立 PM 模型及其创建、归档、删除和任务编辑流程。

记账分类按没有正式历史数据设计，不开发旧格式迁移、推断或双写；不主动删除磁盘文件。
胶囊作为新增主题，保留丁香及现有选择。滚动条维持现有显示策略。

### 暂不处理

- 沉浸式工作台及自由布局。
- 新闪念、文件搜索小组件和操作条输入用途切换。

以上仅在用户后续明确范围后开发，本轮不预埋入口、配置或实现。

### 明确排除

- RSS 阅读器、全文提取、OPML、文章保存及专用缓存。
- 内容工作流看板。
- Apex 技能库、技能按钮、快捷调用、自动发现、GitHub 导入和按钮换行。
- Codex Desktop、Copilot、ZCode、WorkBuddy 等新增调度入口。
- 分组渲染上限从 2000 降到 500，以及新增隐藏滚动条规则。
- 上游独立项目模型及其创建、归档、删除流程；上游自行实现的任务勾选、重命名及排序。
- Claudian 内部接口调用、作者个人 PARA 字段、新功能固定使用 `apex-dashboard` 数据目录。
- 将旧 `memo`、`todo` 自动转换成 `sticky`，以及用上游固定分区列表、创建接口或默认模板替换本地实现。

后续上游审查默认跳过明确排除项，不将其作为待补功能，不新增入口、配置、依赖或专用适配与测试。
只有用户明确修改选择后才能重新纳入开发。共享文件仍需检查对现有组件有效的独立修复。
该策略约束新增 Apex 能力，现有 OKF 订阅、项目、Tasks、公开 Claudian Bridge 和 Vault 规则按当前职责维护。

### 选择性移植来源

| 内容 | 上游提交 | 本地适配 |
| --- | --- | --- |
| 微信读书请求版本 | `037336fb` | 仅更新请求中的版本号 |
| 自定义主题与表单保护、音乐通知 | `c6e1c902`、`77020759` | 统一宿主命令、事务保存及明确的失败通知 |
| 通用弹窗高度与滚动 | `6dd71dee` | 匹配实际外层容器，限制窗口高度并保持内部滚动 |
| 胶囊与抹茶暗色配色 | `e578489c`、`906a8547` | 新增胶囊并保留丁香；仅提取现有组件样式 |
| 番茄钟正计时与设置 | `910281cd` | 统一插件路径、多 pane 订阅、提醒取消、保存后确认及失败处理 |
| 记账分类管理 | `ce966dc6` | version 2 单一分类清单，不读取旧格式；未知格式拒绝覆盖 |
| 分区导航、改色按钮与侧栏偏好 | `2946d8ce` | 稳定 ID 导航、pane 资源清理及已有偏好保留 |
| 完整图标选择 | `77020759` | 使用 Obsidian 原生 `getIconIds()`，规范 Lucide 前缀并保留常用排序 |

拖动保护延续本地 pointer capture，实现取消和窗口失焦清理；上游独立构建仍支持默认宿主。
当前验证结果及测试环境安装证据见[验收台账](ACCEPTANCE.md)。

## Workspace registry integration behavior

The local registry helper preserves Unicode letters in new filenames (`工作台 2` becomes
`工作台-2.md`) and uses the first registered path when the active-path setting is absent.
The OKF startup adapter additionally recovers a missing registry from existing workbench Markdown
before opening a view. Existing filenames are not automatically renamed or deleted. Preserve these
behaviors during subtree updates; regression coverage is in
`dashboard/tests/workspace-recovery.test.ts`.
