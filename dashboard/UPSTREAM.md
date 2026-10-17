# Apex upstream baseline

The unified workbench imports PandoraReads/apex-dashboard as a source subtree at `dashboard/apex/`.
The complete imported baseline is Apex 3.6.5. Selected changes through 3.8.5 and the local OKF
adaptations are accepted under the policy below. Current verification and historical production
evidence are recorded separately in the [acceptance ledger](ACCEPTANCE.md).

| Field | Locked value |
| --- | --- |
| Upstream | `https://github.com/PandoraReads/apex-dashboard.git` |
| Imported commit | `e8d99517c3e76a52a9bfe3ed75251a0d652d4a34` |
| Upstream release | `3.6.5` |
| Selected-update reference | `3.8.5` / `b90d1c54b9c694d192c09173fb5a7d105cbccef4` |
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

本节集中维护当前采用范围及后续审查边界。来源版本与提交见上表；3.8.5 用于选择性移植，
完整导入基线保持 3.6.5。本轮范围处理和已采用功能开发已完成，没有待开发的暂缓项。

### 采用范围

微信读书请求版本 1.0.5；当前组件的通用界面与拖动稳定性修复；完整图标选择；自定义主题保存与外观工作室命令；
番茄钟正计时、提醒和统一设置；记账分类管理；分区导航轨；音乐减少逐曲失败提示；胶囊主题；
移除备忘录改色按钮；没有保存偏好时默认固定侧栏。

闪念小组件的紧凑输入交互在 OKF 内统一命名“快速记录”，通过宿主接入现有 Capture、
草稿和收集箱流程；展开编辑与命令共用同一提交控制。OKF 内不提供独立的闪念目标笔记、文件夹或模板配置。
历史 Apex 笔记和旧配置保留，不自动转换或搬移；独立 Apex 宿主维持其原生捕获行为。

采用 OKF 项目类别、分组、看板、置顶和手动排列。
项目类别进入 Project Contract；界面复用现有 OKF 项目、任务与关联读写，
不导入上游独立 PM 模型及其创建、归档、删除和任务编辑流程。

记账分类按没有正式历史数据设计，不开发旧格式迁移、推断或双写；不主动删除磁盘文件。
胶囊作为新增主题，保留丁香及现有选择。滚动条维持现有显示策略。

沉浸式工作台移植 3.8.5 的 `immersive.ts`、`immersive-grid.ts` 和配套样式、共享组件构建与验收脚本，
保留背景、时钟与紧凑操作条、12 列混合网格、标题拖动、落点预览、吸附、交换、空位放置、边缘滚动，
以及右侧、底部和右下角缩放。顶部与网格共用一个滚动区域。分区初始宽度占半行，内容自然适配高度，
用户调整后保留指定高度。小组件按上游尺寸表设置默认大小。

每个工作台可选择布局，其 `layout`、`immersive` 为有效配置，尺寸使用上游 YAML `cap` 字段；
分区改用本地稳定 ID，保留未知配置和正文。旧 `workbench_layout` 打开时只读转换，用户明确保存后写入原生字段，
原试用字段完整保留作存档。小组件成员由当前工作台独立维护；左右与上下布局继续使用全局开关。
快速记录复用同一 Capture 会话；小组件复用现有服务，OKF 业务分区保留完整功能与内部滚动。
已有便利贴在网格中逐卡展示，普通 memo、todo 分区维持原数据语义。新增入口复用本地预设和上下文选择。

本地适配包括首次按实际宽度测量、完整业务分区高度、缩放边界与固定坐标防重叠、失焦取消与资源清理、
保存失败重试和并发保护、背景按钮对比度，以及窄于 640px 的窗格单列阅读展示。
窄窗格保留宽窗格坐标，恢复宽窗格后继续拖动与缩放；手机沿用小组件在左的布局。滚动条保留。

文件搜索小组件及操作条输入用途切换未纳入当前能力。采用清单之外的新增功能须另行明确需求。

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
| 沉浸式工作台 | `b90d1c54`（3.8.5） | 直接移植布局、交互及样式，按上述边界适配本地身份、持久化、Capture、业务分区与组件生命周期 |

拖动保护延续本地 pointer capture，实现取消和窗口失焦清理；上游独立构建仍支持默认宿主。
当前验证结果及测试环境安装证据见[验收台账](ACCEPTANCE.md)。

Workspace registry and recovery behavior follows the
[workbench data rules](../docs/architecture/README.md#任务与工作台), with regression coverage in
`dashboard/tests/workspace-recovery.test.ts`.
