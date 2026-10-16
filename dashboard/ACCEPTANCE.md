# Apex × OKF acceptance ledger

## OKF 项目类别与展示（2026-10-16）

实现位于独立工作目录 `work/project-categories/`，分支 `codex/project-categories`，
基于 `cf525e65` 开发，保留主工作区并行修改。项目类别为 Project 的可选属性；
旧项目无需补写，类别编辑保持原路径、状态、正文、任务及未知字段。

| 范围 | 验证结果 |
| --- | --- |
| Engine 与 Contract | 600 项测试通过，Ruff 与 Pyright 通过；可选类别、创建前输入校验、CLI/API 设置与清除、旧值检查、原文及扩展字段保留、真实全文索引命中与清除、旧派生索引重建均覆盖 |
| 跨组件 | 根脚本的 12 项通过 / 1 项按条件跳过 |
| Dashboard | 类型检查、59 个文件 / 422 项测试和构建通过；类别分组、状态独立、显示偏好保存、置顶不写项目、同组排序与跨组修改分别验证 |
| Claudian | 类型、lint、420 suites / 6316 passed / 3 skipped、72 项脚本测试及构建通过；该组件源码未修改 |
| Obsidian 实机 | 固定 OKF-Test、API 8766、CDP 9366。通过真实创建窗口建立四个合成项目，验证类别拖动、类别合并预览与保存、清除分类、状态跨列移动、置顶与手动顺序；检查真实 Markdown 正文、任务及未知字段，实际 HTTP 类别写入成功 |
| 恢复与尺寸 | 重启后以保存的原生 ViewState 恢复同一页面，分组、看板、手动顺序和置顶均保留。430px 桌面视口中四张卡片宽 322px，分类窗口宽 344px，内容未横向溢出；此项为 DOM 尺寸检查 |
| 产物与退出 | 最终安装的 main.js、styles.css、manifest.json 与构建哈希一致，保存在 `work/accepted-candidate/`。原有测试插件、配置及受管资源按快照恢复并比较字节，四个合成项目及其搜索索引条目已清除；测试窗口、Engine、自动启动、LiveSync 关闭，8766/9366 无监听 |

本节证据路径均相对该独立工作目录。运行记录位于 `work/` 下的 `category-runtime-results.json`、
`category-runtime-followup.json`、`category-cold-start.json`、
`category-narrow-layout.json`、`category-artifacts.json` 和 `category-index-cleanup.json`。
最终 main.js SHA-256 为
`357f0dc4036ec5122c9b993ad6cc1196522f3007e6b51a800255b2592e7a8e38`。

根脚本执行时先后在 Windows 文件替换和新增导航状态断言处中止。
共享原子写入针对 Windows 暂时占用做有界重试，每次重试核对原版本；
永久失败、外部改动保护和实际多进程写入均通过测试。
最终项目路径保护与原子写入另行补验 14 项测试，Ruff、Pyright 通过。
原始记录保留为 `work/project-root-check-first.log`、
`project-root-check-second.log` 和 `project-root-check.log`。
最后一份记录包含 Engine 和跨组件成功结果；修正状态断言后，
Dashboard 与 Claudian 按根脚本的相同命令完成补验，日志为
`work/dashboard-*-final.log` 与 `work/claudian-*-final.log`。

本次未截图或进行视觉验收，未验证真实移动设备与远端同步，未部署正式环境。

## 分区目录、公共操作和任务命名（2026-10-16）

按用户要求，在 `work/fixtures/section-experience-ui` 新建隔离环境，使用合成 Vault、独立 State、
Obsidian profile、API 8772 和 CDP 9372。测试未接入同步或外部账户。源码在独立工作副本中构建，
合回时保留并行开发的修改；最终 501 个运行源码文件的原始字节与共享工作区一致。

| 验证范围 | 结果与证据 |
| --- | --- |
| 自动化 | 合并源码的 Dashboard 416 项测试、两组类型检查和生产构建通过；Apex lint、构建及分区、日历、刷新范围、滚动、删除、笔记创建、并排布局和网页的相关专项检查通过 |
| 添加目录 | 24 个类型按五个用途分组，选项只显示图标和名称；便利贴保留原名。实机检查旧名称搜索、自定义名称保留和实际添加；添加入口注入失败时保留草稿，真实写入后注入刷新失败并重试，仅创建一个分区 |
| 页面与放大 | 实机检查六种内置独立页面、六种放大窗口以及功能页面；搜索和范围传递正确，页面排序与日历筛选不改写工作台正文。返回时工作台成为活动视图并保留原滚动位置；放大窗口关闭后解除订阅 |
| 文件操作 | 在实际 Markdown 中保存任务和便利贴内的清单卡片；连续添加六个分区均保留。26 项实机检查记录于 `work/section-experience-evidence/final-run.json`，另有任务独立页面截图与窗口退出检查 |
| 视觉 | 获取并逐张查看最终 34 张真实 Obsidian 截图，覆盖添加目录、菜单、独立页面、放大窗口、任务表单及明暗主题。窗口为 1440×1000 和 430×950；窄窗口收起原生文件侧栏。截图及哈希见 `work/section-experience-evidence/receipt.json` |
| 安装与退出 | 构建、安装和固定候选的 main.js、styles.css、manifest.json SHA-256 一致；Vault 校验通过，检查 35 个 Markdown 文件。窗口、Engine、自动启动和 LiveSync 均关闭，8772/9372 无监听 |

验收产物固定在 `work/section-experience-evidence/candidate/`，完整回执同时保存在该目录的上一级和
隔离 State 的 `reports/section-experience-acceptance.json`。合成工作台与构建副本保留供用户查看，
期限记录于 fixture.json；启动和退出入口为 `work/start-section-experience.ps1`、`work/stop-section-experience.ps1`。

本轮未验证真实移动设备、微信读书与滴答清单在线调用、远端订阅同步、AI 生成和文档转换。
当前交互说明见[使用指南](../docs/USER-GUIDE.md#分区与工作台)。

## Apex 更新真实视觉验收（2026-10-16）

在固定 `OKF-Test` 中运行实际 Obsidian，获取并逐张查看最终 41 张截图；发现问题后修改、
重新构建安装并复查。截图、尺寸、主题、图片与安装文件 SHA-256 汇总在
`work/apex-visual-20261016/receipt.json`，对应产物保存在该目录的 `candidate/`。

| 范围 | 结果 |
| --- | --- |
| 工作台 | 胶囊、抹茶、丁香的明暗主题，左右布局和上下布局均已查看；无图横幅文字跟随主题，丁香深色文字与卡片保持可读对比度 |
| 计时 | 正计时不显示倒计时轮次圆点；悬浮面板随主题切换更新颜色。查看明暗设置、提醒、统计与倒计时界面；真实计时产生一条 2 分钟记录，统计显示一致 |
| 记账 | 金额和备注占位文字清晰；管理窗口保持足够宽度，明暗输入框可见。查看支出、收入及窄窗口，内部正常滚动；实际点击新增关闭按钮后窗口关闭 |
| 外观与图标 | 查看外观工作室顶部、底部、主题命名和图标选择。430px 窄窗口中的滑块标签完整换行，设置按钮与输入框未超出弹窗 |
| 自动化 | Dashboard 类型检查与 58 个文件 / 415 项测试通过；Apex 全部 47 项检查脚本、lint、独立构建通过，日志 `work/apex-visual-accepted-checks/`。横幅回归覆盖有图、无图及指定颜色；两项笔记分区测试按当前菜单入口验证配置行为 |
| 产物与退出 | 最终截图的三个安装文件哈希均与构建及保存的候选一致；部署回执副本位于截图目录。原有五个配置及组件数据文件的存在状态和字节均恢复，合成工作台删除；测试窗口、Engine、自动启动和 LiveSync 关闭，8766/9366 无监听，恢复记录见 `cleanup.json` |

最终 `main.js` SHA-256 为 `da7f25655f58a69bc113109abd0fe91c111a6ec7edf03e6540bcf690d59ab6d6`，
`styles.css` 为 `2523a5e089b097fab41a688ece415259a09f7bf2bc54d2a5c0dcc97bddbd882c`。
本轮只补验 Dashboard 与 Apex，未重新执行根检查；下方保留此前根检查对应的结果与产物。
先前检查中的卡片设置入口断言失败记录保存在 `work/apex-visual-checks/` 和
`work/apex-visual-final-checks/`，修正后的检查覆盖菜单展示及原配置事件分发。

430px 使用桌面视口模拟，没有验证真实移动设备。提醒截图调用实际服务方法打开窗口，
提醒间隔由隔离测试验证；本轮未进行系统睡眠恢复或远端同步验收，没有部署正式环境。

提交前补验包含分区创建失败重试保护的当前源码：Dashboard 58 个文件 / 416 项测试、类型检查和构建通过；
Apex 全部 47 项检查脚本、lint 与独立构建通过，日志 `work/apex-prepush-checks/`。
上述 41 张截图对应所列安装哈希，提交前补验构建只生成本地产物。

## Apex 选择性功能更新（2026-10-16）

完整上游基线仍为 3.6.5，本轮按[采用策略](UPSTREAM.md#上游采用策略)移植已选功能。
自动化与实机均使用当前本地候选；没有部署正式环境。已有 Claudian 未提交修改保持原状。

| 验证范围 | 结果与证据 |
| --- | --- |
| 根检查 | `scripts/check.ps1` 最终通过：Engine 588，跨组件 12 passed / 1 skipped，Dashboard 412，Claudian 420 suites / 6316 passed / 3 skipped，以及 72 项脚本测试；类型、lint 和构建通过。`work/apex-root-check-final.log` |
| Apex | 全部 47 项 `test:*`、lint 和独立构建通过。`work/apex-final-checks/`；最终通用弹窗样式另行补验 mobile-stability、theme-studio-colors、scroll-root 及 Dashboard 11 项相关回归 |
| 外观与图标 | 在实际 Obsidian 中保存、应用和删除主题，验证完整外观及冷启动恢复；原生图标列表展示 400 项，搜索并保存非精选 `calendar-clock`。备忘录改色按钮不再显示，侧栏尊重取消固定偏好，并在无偏好时默认固定 |
| 计时 | 最终候选实际正计时 66 秒后保存一条 1 分钟记录，重复结束不新增记录；跨日期保留历史，冷启动恢复设置和历史。多 pane 同步更新，关闭一个 pane 不影响其他订阅；自动化覆盖暂停期间模式变化、提醒被动关闭与卸载清理 |
| 记账 | 从空数据新增分类、分组、排序和流水，删除预置分类后流水保留，冷启动后恢复；实际管理窗口完成排序和预置分类删除。新格式 version 2 不迁移旧数据，异常文件拒绝覆盖 |
| 导航与拖动 | 同名分区使用稳定 ID 定位；展示操作不改写工作台正文。CDP 原生鼠标拖动将合成分区高度保存为 335，保留未知字段和正文；失焦取消不写文件，遮罩与调整状态均清理 |
| 尺寸 | 胶囊、丁香、抹茶的明暗主题下，430px 弹窗窗口内实际内容宽度 386px，scrollWidth 同为 386px；窗口高度 680px、视口 800px，内部可滚动 568px。记录为 DOM/CSS 尺寸测量 |
| 外部服务 | 网易云真实搜索返回 30 条结果；未播放音频。测试环境没有微信读书凭据，未执行其在线调用 |
| 安装与退出 | 构建与安装的 main.js、styles.css、manifest.json SHA-256 一致。已记录测试 State 部署回执；合成工作台已删除，原有功能配置及组件数据存在状态已恢复，测试窗口、Engine、自动启动和 LiveSync 关闭，8766/9366 无监听 |

实机记录为 `work/apex-runtime-results.json`。已验收产物及对应记录固定保存在
`work/apex-selected-accepted/`，部署回执位于测试 State 的 `reports/deployment-receipt.json`。

首轮根检查在已有 Claudian 测试中遇到 Windows 临时文件重命名 EPERM；未修改该组件，
单独复查 25 项通过，随后完整根检查通过。首轮日志 `work/apex-root-check.log`、复查日志
`work/apex-claudian-recheck.log` 和诊断 `work/apex-update-diagnostics.json` 保留。

上述尺寸记录来自 DOM/CSS 测量；后续截图验收及当前候选结果见本页顶部记录。

## 分区真实视觉验收（2026-10-15）

本轮按用户授权，在独立的 `surface-capabilities` 测试环境中获取真实 Obsidian 截图，逐张查看，
修改问题后重新构建、安装和复查。最终 39 张截图均来自相同的安装产物，每张截图的尺寸、主题、
安装哈希与文件哈希记录于 `work/surface-visual-final/receipt.json`；候选文件保存在该目录的 `candidate/`。

| 范围 | 结果与证据 |
| --- | --- |
| 十个独立页面 | 明暗主题各一轮，检查文字、工具、卡片与页面边界；最终截图为 `verified-light-*-page.png` 和 `verified-dark-*-page.png` |
| 工作台与布局 | 查看实际分栏、折叠、资料和任务分区；检查窄窗口中的操作换行。最终截图包括 `verified-board-split.png`、`verified-board-collapsed.png` |
| 学习与课程 | 实际展开选择器、选择课程、打开课程详情，查看带内容的学习卡片；宽屏与窄窗口中列表和操作均可见。临时学习夹具未设置 `studied_at` |
| 弹窗与任务写入 | 查看资料、项目、课程、分区配置和任务表单；430px 桌面窗口中检查完整表单滚动。空描述禁止提交，实际保存后保留新生成的任务标识；注入写入后的刷新故障，再次提交成功，任务只出现一次且字节不变。已有工作台正文保持一致。`work/surface-visual-final/run.json` |
| 订阅卡片 | 查看正常空状态；以隔离的内存合成响应检查多条内容、就地加载和卡片滚动，实际生产渲染器保持运行。测试后恢复原读取方法，不代表远端订阅服务验收 |
| 自动化与构建 | 最终 Dashboard 405 项测试、两组类型检查和生产构建通过。日志为 `work/surface-visual-retry-tests.log`、`work/surface-visual-retry-typecheck.log`、`work/surface-visual-retry-install.log` |
| 文件与退出 | 清理本轮工作台、任务和学习记录后，Vault 校验通过，检查 33 个 Markdown 文件；构建与安装的三个产物哈希一致。窗口、Engine、自动启动和 LiveSync 均关闭，CDP 9367 无监听 |

本轮修正空订阅卡片的多余高度、资料详情的分栏、详情操作间距、任务表单的内部标识和窄窗口日期布局，
以及课程选择入口、选项高度和课程操作区的越界。当前交互说明见[使用指南](../docs/USER-GUIDE.md#分区与工作台)。

本次没有部署正式环境。窄尺寸使用桌面 Chromium 窗口，未进行真实移动设备验证；外部 AI、文档转换、
远端订阅及同步未验收。中间截图与诊断保留于 `work/surface-visual/diagnostics.json` 及同目录截图。

## 分区完整功能与页面状态验收（2026-10-15）

工作台与独立页面共用业务工具、操作和查询。目录排序、任务视图、筛选和分页在当前实例中完成；
独立打开传递已应用的浏览状态，各页面保存自己的返回历史。分区配置通过 Obsidian 的 frontmatter
API 局部保存，保留完整正文及未知字段。行为说明统一见[使用指南](../docs/USER-GUIDE.md#分区与工作台)。

用户明确授权另建隔离测试环境，以避免与另一个聊天使用的 `OKF-Test` 冲突。本次实机环境为
`work/fixtures/surface-capabilities/vault`，State 和 Obsidian profile 位于同一夹具的独立 State 下；
API 8767、CDP 9367，独立安装身份与本地凭据，不连接 LiveSync。

| 验证范围 | 结果与证据 |
| --- | --- |
| 根检查 | Engine 588、跨组件 12 passed / 1 skipped、Dashboard 当次 403、Claudian 6316 passed / 3 skipped，以及 72 项脚本测试通过；类型、lint、构建和边界检查通过。`work/surface-final-root-check.log` |
| 最终 Dashboard 候选 | 完整 405 项测试、两组类型检查和生产构建通过，覆盖目录排序和配置窗口的并发保护。`work/surface-final-dashboard-tests.log` |
| Apex | lint、独立构建、`test:refresh-scope`、`test:scroll-root`、`test:kanban-upgrade` 通过；配置并发冲突与未知字段合并进入 Dashboard 回归测试 |
| 实机操作 | 35 项不同检查通过：十个业务页面、旧配置的完整工具、就地分页和切换、真实任务完成及表单写入、排序与搜索传递、实例隔离、原生冷启动状态恢复、配置保存和正文保留，以及窗口打开后的新增字段保留与同字段冲突保护。`work/surface-final-results.json` |
| 主题与尺寸 | 原生明暗主题下，六个独立页面的 48 次尺寸测量及两个工作台标题栏的 16 次测量通过。实际 client/scroll 宽度逐项记录；工作台较宽请求受到父容器约束，未据此宣称实际达到所有请求宽度。`work/surface-runtime-geometry.json` |
| 内容与契约 | 打开工作台前后字节一致；局部保存保留全部正文、根与列未知字段、其他分区配置；实际任务写入和浏览状态经过冷启动核对。最终隔离 Vault 验证通过，检查 33 个 Markdown 文件 |
| 安装身份 | Dashboard `main.js`、`styles.css`、`manifest.json` 的构建与安装 SHA-256 一致；当前源码哈希和检查范围记录于隔离 State 的 `reports/surface-deployment-receipt.json`，汇总见 `work/surface-final-results.json` |
| 退出 | 本次工作台与任务记录已清理；窗口、Engine、自动启动与 LiveSync 均关闭，8767/9367 无监听。标准 DOCX 的 store-only 导入结果作为合成排序夹具保留；环境用途与到期时间记录于 `work/fixtures/surface-capabilities/fixture.json` |

原生关闭和冷启动用于核对页面历史；常规测试控制脚本在关闭前会卸载插件并移除页面，不能据此
判定原生页面恢复行为。验收脚本诊断和失败记录保留在 `work/surface-verification-diagnostics.json`
及 `work/surface-runtime-*-failure*.json`。

本次没有部署正式环境。实机检查使用 DOM、真实文件、本地 Engine 和尺寸数据；未执行视觉检查、
远端同步、外部 AI 或文档转换服务验收。

## Tasks and workbench source boundaries (2026-10-15)

The source candidate retains Tasks 8.5.0 configuration, indexing, queries and editor,
and restricts Apex checklists to workbench Markdown. Production was not deployed
and existing production content was not migrated. The worktree contains pre-existing
and task-related uncommitted changes; the test receipt identifies the installed bytes.

| Verification | Result and evidence |
| --- | --- |
| Repository checks | Engine 588 passed; cross-component 12 passed / 1 skipped; Dashboard initially 395 passed; Claudian 420 suites / 6316 tests passed, 3 skipped, and 72 script tests passed. `work/tasks-boundary-root-check.log` records the root run. |
| Final Dashboard and Apex changes | Dashboard typecheck/build and all 403 tests passed, including 14 boundary tests. Apex lint/build and affected calendar/card scripts passed. |
| Actual Tasks settings and editing | 16 checks passed: custom and empty filters, Dataview format, next-status order, editor field/access-key options, real Markdown save, all workbench exclusion, rename and historical inspection. `work/tasks-boundary-live-final.log`. |
| Actual Apex checklist operations | Five checks passed: parent/child completion, literal task metadata, complete in-workbench archive, reload and Tasks exclusion. `work/tasks-boundary-checklist-live-final.log`. |
| Actual write boundaries | Four checks passed: Tasks rejects workbench destinations; checklist writes reject a removed workbench identity; rejected operations preserve current bytes. `work/tasks-boundary-write-guards-live-final.log`. |
| Date shortcut | The actual date dialog saved the selected task format and preserved time, unknown metadata and block identity. `work/tasks-boundary-date-live-final.log`. |
| Restart | 67 task records, byte hashes of 17 workbenches, Tasks settings and saved views matched. Settings use deep value comparison; workbenches use exact SHA-256 comparison. `work/tasks-boundary-restart-result.log` and before/after snapshots. |
| Engine and contracts | Actual test Vault projection excluded workbenches and returned 52 open tasks; Vault validation passed for 71 Markdown files. |
| Installed candidate | Installed artifacts matched their build hashes at candidate capture. The Dashboard candidate, SHA-256 manifest and matching deployment receipt are frozen in `work/tasks-boundary-accepted/`; subsequent workspace builds do not replace this evidence. |

All real-app checks used the fixed `OKF-Test` Vault, Engine 8766 and its isolated
profile/CDP 9366, with LiveSync disabled. Synthetic test notes remain in that test
Vault. Tasks settings were restored after configuration checks. Final shutdown
confirmed `vault_open`, `api_listening`, `engine_autostart` and `livesync_enabled`
were false, with no CDP listener. Verification used DOM, file content and local
runtime APIs; visual inspection, remote synchronization and external AI/conversion
services were not exercised.

## Persistent test environment acceptance (2026-10-15)

This run used `E:\ObsidianData\OKF-Test`, State `OKF-Test-State`, Engine port 8766
and the State-owned `obsidian-profile` on CDP 9366. The profile registered only
the test Vault. Current environment and lifecycle procedures are maintained in
the [development guide](../docs/DEVELOPMENT.md#正式发布后的继续开发).

Fifty fixture files and two saved task views were consolidated into this Vault;
existing test notes and workbench bytes were preserved. Current Engine resources,
Skills and both plugin builds are installed. The test Vault passed contract
validation with 62 files checked. Installed artifact hashes are recorded in
`OKF-Test-State/reports/deployment-receipt.json` and `development-build.json`.

| Verification | Evidence |
| --- | --- |
| Vault identity, ten business pages, unified Tasks takeover, task indexing, contextual form and actual Markdown write, original-only Source semantics | 29 checks in `work/fixed-test-acceptance-result.json` |
| Actual Engine authentication, matching Vault identity, rejected mismatched write, six read endpoints and persisted Capture | 10 checks in `work/fixed-test-live-api-result.json` |
| Engine-offline Capture through Obsidian Vault APIs | `work/fixed-test-offline-result.json` |
| Restart persistence of 64 tasks, exact board bytes, saved query identities/scopes, actual task Markdown and plugin state | Seven checks in `work/fixed-test-final-lifecycle.json` |
| Temporary fixture path restrictions, metadata, Contracts and completed cleanup | `work/fixture-tool-result.json` |
| Complete source update, contract validation and verified installed builds | `work/fixed-test-update-final.log` |
| Repository checks and final installer/control regression | Root check passed: Engine 584, cross-component 12 passed / 1 skipped, Dashboard 350, Claudian checks/tests/build; final focused installer/control suite: 34 passed |

The former Dashboard acceptance directories, task acceptance directory and
optimization profile were archived and removed after archive/file-hash checks.
Eleven old creation, server and CDP launch tools were retired. Archives, manifests,
operation snapshots, failure records and copied evidence are retained under
`E:\ObsidianData\Archives\20261015-test-consolidation`. Runtime paths in the
historical entries below identify those archived runs.

Production plugin files and deployment configuration matched their operation-start
hashes; the production process and scheduled-task targets were retained. At
completion the test window, Engine, autostart and LiveSync were all stopped.
This acceptance used DOM, file content and real local APIs. Visual inspection,
remote synchronization, external conversion and AI-provider execution were not
performed.

## Section layout and navigation acceptance (2026-10-14)

Workbench sections use the native Apex container spacing and collapse rules.
The containing section owns the primary title and frame. Its header contains
scoped full-view access and refresh; meaningful internal group/source headings
remain visible. Workspace switching, widgets and quick buttons use the native
Apex interface. Scoped full-view navigation explicitly activates the originating
workbench on return.

The candidate was installed only in
`E:\ObsidianData\OKF-Dashboard-Acceptance-20261013\vault` (CDP 9337).
The recorded test calendar `section-mv6yaoye` was removed from `优化日常`.
Other metadata and Markdown body content matched the preserved baseline,
including the Project/Memo order and user-created `笔记` section. All 62 tasks
remained indexed. Multi-instance calendar testing used a separate generated
layout-test board, which was removed from the workspace registry after testing;
its Markdown remains as test evidence.

| Scenario | Evidence |
| --- | --- |
| Expanded/collapsed Project + native Memo combinations | 64 layout assertions at 1440×1000 dark/light, 2560×1392 and 1100×950; folded heights both 64px, matching tops, narrow sections use full width |
| Primary title, source/group headings, header controls and original navigation | `work/section-refinement-layout-results.json`, inspected `section-refinement-pair-*.png` |
| Scoped full view, unknown config, return activation, full-update heading, command access, DOM drag/drop, pointer resizing, legacy Today and multiple calendars | Nine final checks in `work/section-refinement-final-interactions.json` |
| Existing layout/data preservation | `work/section-refinement-preservation.json`, exact metadata/body comparison against the recorded baseline |
| Current experience board | `section-refinement-final-folded.png`, `section-refinement-final-updates.png`, `section-refinement-experience-top.png` |

Dashboard: 350 Vitest tests, both TypeScript checks and production build passed.
All 44 Apex scripts passed; standalone build and lint passed again after the
renderer refinement. Final CSS assets were regenerated through `build-assets.mjs`
and loaded for the final geometry/interaction run. Vault contract validation
passed with 66 files checked. `git diff --check` passed.

Installed/build SHA-256 values matched: main
`74fed374c1478722fe5e5accbdc990ca895c4b592a33f8fb21ca411139dce52b`,
styles `628a4c429ca2b146fa92e5e787b9bf2268801ebad4811f53e2a41093186f8421`.
No production deployment was performed.

The CDP evidence distinguishes console history from errors emitted during each
check. Two existing invalid-PDF entries were recorded before this run in
`section-refinement-runtime-baseline.json`; final interaction checks emitted no
new errors. Return-state diagnosis and the initial resize-event mismatch remain
recorded in `section-refinement-return-diagnosis.json` and
`section-refinement-resize-failure.json`. The resize check subsequently exercised
the actual PointerEvent handlers. Feed previews used synthetic cache served by
the authenticated Engine for this isolated Vault; external providers were not
invoked by these layout checks.

## Dashboard interaction optimization (2026-10-14)

The optimized workbench adds an independent Tasks page, shared contextual task
forms and rows, named workbench selection, business navigation, bounded summaries,
and Source/Project/Course details with scoped catalogue routes. Existing boards,
native Apex data and useful contextual entry points are retained. New daily
presets use four configurable shortcuts. Capture supports simultaneous Course
and Project associations; import purpose remains independent of processing.

Runtime acceptance used only
`E:\ObsidianData\OKF-Dashboard-Acceptance-20261013\vault`, CDP 9337, the separate
`work/optimization-obsidian-profile` and the isolated Engine on port 8777.
The Engine Vault fingerprint was verified before use. The new `优化日常` board
was created through the workbench interface; the legacy board was preserved.
No production deployment or production content edits were performed.

| Scenario | Evidence and result |
| --- | --- |
| Contextual task creation, visible defaults, exact Markdown, cancellation, dates/time, query intersection, saved scope, object details, catalogue returns, Capture and history | `work/optimization-flow-results.json`: 22 checks passed in actual Obsidian |
| Recurrence, unique next occurrence, complete subtree move, reference updates, independent subtree copies and dependencies, saved-view rename/delete, independent calendar scopes | `work/optimization-boundary-results.json`: 13 checks passed |
| Calendar content isolation, persisted navigation, quick creation with plan default, full editor date inheritance, invalid query and recovery | `work/optimization-calendar-results.json`: 8 checks passed |
| Business pages, themes and widths | Ten pages captured in both native dark/light themes at 1440×1000; five pages at 960×850, with 580px content panes; page client and scroll widths matched, with no page error blocks |
| Native layout and dialogs | New daily board, task form and actual vertical split captured; screenshots reviewed for card boundaries, hierarchy, wrapping, labels, readable controls and modal actions |
| Restart persistence | `work/optimization-restart-result.json`: saved-view IDs/query/scope, exact board Markdown, task count and scoped overdue page matched before and after restart |

The three final runtime suites reported no console errors or unhandled runtime
exceptions. Large-list checks verify that details remain bounded and the full
catalogue can still find the newly created task. UI repairs were rebuilt,
installed in the isolated Vault and rechecked. Screenshot and geometry evidence
is in `work/optimization-visual-final.json` and `work/optimization-final-*.png`.

Restart acceptance used one active writer for the full test Vault. An older
isolated Obsidian profile was stopped after its registered Vaults were verified
to be test-only. The concurrent-profile attempt and its differing snapshots
remain in `work/optimization-before-restart.json` and
`work/optimization-after-restart.json`; the successful comparison uses the
`optimization-single-writer-*` snapshots. Fixture-note datetime and heading
requirements were corrected; the final Vault contract validation passed with
65 files checked and no issues.

The installed candidate matches the production build: main SHA-256
`91bdd26bcf4e99d14e4160de780dd6dcb961cb43dd6ce65b8855347f7e8c9713`,
styles SHA-256
`3b927a04c68f844ec5359c042eb8b4afe5c750e01688c8553e063f3174589c35`.

Final automated verification: root `scripts/check.ps1` passed under PowerShell 7
with Node 24.16.0: Engine 575, cross-component 12 passed / 1 skipped, Dashboard
349, Claudian 6,316 passed / 3 skipped and 72 architecture/script checks.
Engine Ruff/Pyright, Dashboard and Tasks integration type checks, Claudian
typecheck/lint and production builds passed. All 44 Apex test scripts,
standalone build and lint passed. A further Dashboard production build passed
after the final CSS refinements. `git diff --check` passed.

Claudian's separate performance check passed with a 2.32 MiB bundle; its 188.5 ms
median cold evaluation exceeded the advisory 150 ms threshold. This is a
Claudian measurement, independent of the Dashboard visual acceptance.

Feed content was synthetic cache served by the actual isolated Engine. Live
Producer synchronization, external parsing and AI-provider generation were not
rerun in this UI acceptance; automated workflow tests remain separate evidence.

## Unified Tasks component (2026-10-13)

The Tasks 8.5.0 source is embedded in the Dashboard package. Formal tasks, local
checklists, Today, calendar, contextual catalogues and native Markdown task
interactions share the same task semantics and authoritative source files.

| Scenario | Evidence | Verification boundary |
| --- | --- | --- |
| Recurrence, custom states, dependency queries, tags, hierarchy and independent copies | `tests/unified-tasks.test.ts` | Real embedded Tasks model and query engine; Obsidian host isolated |
| Reminder acknowledgement, rescheduling, child items and identity across moves | `tests/task-reminders.test.ts` | Real reminder service, controlled clock and host notifications |
| Complete subtree move, fields, source conflict and references | `tests/task-operations.test.ts` | Real operation against synthetic Markdown; host file API isolated |
| Frontend / Engine task eligibility and Markdown code examples | `tests/fixtures/tasks/task-cases.json` | Shared cross-language fixture |
| Task catalogue and card recurrence, native query completion, cancel, edit, reminder and move | `work/tasks-*-result.json` | Actual isolated Obsidian, DOM interaction and source-file checks |
| Advanced dependency query, grouping, saved view, checklist promotion and contextual creation | `work/tasks-views-result.json` | Actual task interfaces; zero measured task-row overflow |
| Calendar creation, archive fields and resolved daily references | `work/tasks-final-verification-result.json`, `work/tasks-archive-result.json` | Actual source records and Obsidian link resolution |

Runtime acceptance used only `work/tasks-acceptance/vault` and a separate profile,
CDP port 9352. Initial loading and recurrence were checked on Obsidian 1.12.7;
the subsequent interaction run used Obsidian 1.14.4. The independent Tasks plugin
was absent. No production deployment or production note changes occurred.
This task used DOM, dimensions and file inspection; it did not perform screenshot
or visual-image acceptance. CDP failure and completion records remain in
`work/tasks-acceptance/cdp-log.ndjson`.

Dashboard verification: 338 Vitest tests, Dashboard and upstream integration
type checks, and the production build passed. Engine full pytest: 575 passed;
cross-component fixtures: 12 passed / 1 skipped. Required Ruff and Engine Pyright
checks passed. The complete root `scripts/check.ps1` passed: Engine 575,
cross-component 12 passed / 1 skipped, Dashboard 338, Claudian 6,316 passed /
3 skipped plus 72 architecture/script checks, and all required checks and builds.

## Dashboard sections and interactions (2026-10-12 source change)

This source change adds a Sources catalogue and a configurable latest-Feed surface, scopes components by
workbench/section identity, preserves existing boards, and shares note rows, task completion, material
decisions, recovery presentation and asynchronous feedback. New presets apply only to newly created boards.

| Scenario | Evidence | Verification boundary |
| --- | --- | --- |
| Multiple Source uses, component state, explicit scope and preset round-trip | `tests/workbench-design.test.ts` | Synthetic Vault and actual Dashboard controller; no production data |
| Original/text access and contextual operation isolation | `tests/workbench-design.test.ts` | UI/file identity checks; original viewer and AI provider are isolated |
| Course/Project import, creation, draft restore and stale response | `tests/document-import-relations.test.ts` | Actual modal and local note writer with isolated import submission |
| Capture draft failure/success and keyboard behavior | `tests/quick-capture-modal.test.ts` | Actual modal using the test DOM |
| Project, Feed, lifecycle, task identity and preservation regressions | Dashboard Vitest suite | Automated component verification |
| Obsidian runtime and visual layout | Isolated 2026-10-13 run below | Actual Windows Obsidian, synthetic Vault, screenshots and file checks |

Automated verification completed on 2026-10-13: root `scripts/check.ps1` passed (Engine 575,
cross-component 12 passed / 1 skipped, Dashboard 316, plus the required checks and builds).
All 44 Apex `test:*` scripts, standalone build and lint passed. The source change also verifies actual
layout-writer failure propagation and explicit retry in `tests/apex-sync-pool.test.ts`; purpose-only
routing for original-only Sources is covered by `engine/tests/integration/test_local_api.py`.

### Isolated runtime and visual acceptance (2026-10-13)

The candidate was installed only in
`E:\ObsidianData\OKF-Dashboard-Acceptance-20261013\vault`, with separate `profile/` and `state/`
directories, CDP port 9337 and Engine port 8777. Only `okf-workspace-dashboard` was enabled;
Engine autostart and synchronization were disabled. The Vault was generated from current Contracts
and synthetic content. No production Vault or default Obsidian profile was used.

| Scenario | Observed result |
| --- | --- |
| Nine business pages, defaults and shortcuts | All opened in Obsidian; the default board keeps three daily-update streams in their own section and seven existing Apex quick buttons |
| Wide, narrow and split panes | Screenshots reviewed at 1600×1100, 900×1000 and 560×950; split-pane learning and Sources roots measured 345px with equal client/scroll widths after repair |
| Themes and controls | Dark/light screenshots verified readable rows, visible 16px task checkboxes, wrapping actions, Source details and Knowledge facets |
| Scope and instances | Two Learning instances retained different project bindings and stages; a missing bound Course displayed an error without widening the scope |
| Expansion and full catalogues | Current scope, selected stage and originating board survived each route; the full catalogue reused its existing instance identity |
| Configuration and two-pane saves | Actual Markdown save retained unknown configuration and prose; the second pane received the same-board change |
| Tasks and learning completion | Related Guide tasks appeared in the full Project task list; completion updated Today and the Calendar completed state. Task completion did not set `studied_at`; explicit study completion and reversal worked |
| Source uses and files | Source catalogue deduplicated uses; one purpose decision retained other pending and dual-linked uses. Original-only routing created no placeholder text; PDF/Markdown opened in native views |
| Capture and import drafts | Closing/reopening retained text, unsubmitted files and both relationships; saving created actual notes/originals in the test Vault |
| Subscription history | Two seeded sources rendered; history advanced from four to all six editions without duplication; source and 245px reading position survived navigation and application restart |
| Offline behavior | With the test Engine stopped, task completion and Capture saved locally; generation reported disabled service startup and no queued success |
| Workbench/section creation | Project preset propagated the chosen project; command and footer used the grouped section picker. Removing a Source section preserved Source notes and original files |
| Application restart | The isolated process was closed and relaunched; one plugin identity loaded, board bytes and stage state were retained, and the installed bundle matched the build |

Runtime evidence and screenshots are retained in the ignored repository `work/` directory:
`acceptance-final-results.json`, `acceptance-page-results.json`, `acceptance-before-restart.json`,
`acceptance-final-*.png`, `acceptance-two-panes-fixed.png`, `acceptance-today-small.png`,
`acceptance-sources-small.png` and `acceptance-light-*.png`. The final main-bundle SHA-256 is
`0049a774a20d5cc160a1decb698b9bf11ef75a6ac1cd267e24392fe360c9dd86`.
The post-interaction Vault passed contract validation and contained 80 Markdown files.
The runtime report records 63 passed checks and no unhandled application errors before or after
restart. The isolated Obsidian process and Engine were stopped at completion; ports 9337 and 8777
were no longer listening, and the original default-profile Obsidian process remained running.

Dashboard verification after the runtime repairs: 319 Vitest tests passed, TypeScript check and
production build passed. All 44 Apex scripts passed; the final section-confirmation change also
passed the related dialog/deletion scripts, standalone build and lint. The full root check passed
Engine 575, cross-component 12 / 1 skipped and Dashboard 319, then failed in the existing Claudian
OpenCode concurrent prompt-file test on Windows (`ENOTEMPTY`; a focused run also observed `EPERM`).
A focused 25-test rerun passed, but the subsequent full run still reported 6315 passed / 3 skipped /
1 failed. The root check is therefore **not passed**; its failure output remains in
`work/root-acceptance-rerun.log`.

This run used seeded Feed cache served by the real local Engine. Live Producer synchronization,
cloud parsing and AI-provider generation/cancellation/retry were not executed. Their automated
workflow tests do not constitute live-service evidence. The candidate was not deployed to production.


> **2026-09-21 functional-parity correction:** the original completion statement was too broad. The
> recorded data-safety and lifecycle scenarios remain valid, but the new Apex sections do not yet preserve
> the full reachable behavior of the former OKF Dashboard. The subsequent shared-Surface implementation
> restored M4–M6 and the desktop runtime portion of M8. M7 has authenticated fixture-sync evidence; live
> producer sync and source/history pagination now pass in the isolated Obsidian run. M9 rollback comparison
> also passes against a fresh pre-swap snapshot. P08 passed its reachable-surface inventory in the isolated
> run. The accepted outcomes are recorded in the staged gates and isolated-run evidence below; detailed
> implementation reports remain available in Git history.

> **Production cutover update (2026-09-29):** release v0.8.0 is installed in the production Vault. The
> backup, installer acceptance, live plugin load, Engine health, plugin identity, and scheduled-task checks
> are recorded below. The isolated M0–M9 and P01–P08 evidence remains separate from production runtime evidence.

This ledger records the capability inventory, staged gates and acceptance evidence for the Apex × OKF
integration. Historical proposals remain available in Git history. A row is complete only when its named automated evidence
passes and, where required, its disposable-Vault interaction has been recorded. Production user data is
never a test fixture.

## Product capability inventory

| Capability | Baseline owner | Integration decision | Planned evidence |
| --- | --- | --- | --- |
| Multi-workbench layout, theme, banner, drag/resize/collapse | Apex | Preserve and expose through the unified host | Upstream layout tests plus two-pane Obsidian scenario |
| Web, image, video, gallery, music, weather, countdown, lunar calendar | Apex | Preserve with explicit capability and lifecycle ownership | Upstream scripts plus lifecycle scenario |
| Notes collection, folder, database, DQL | Apex | Preserve; route managed-artifact mutations through edit policy | Contract-aware edit tests and Vault scenario |
| Habits, expenses, reading, focus | Apex native services | Preserve original formats and services; path takeover only | Byte/shape-preserving migration tests |
| Project | OKF Vault contract | Replace Apex project label with `workspace-projects`; keep old `projects` as notes collection | Project action and multi-section tests |
| Task, calendar, Daily, Capture | Shared Vault projection/actions | Unify identity, date fields, routing, and writes | Cross-language fixtures and end-to-end scenario |
| Learning, Knowledge, Inbox, Import | OKF/Engine | Add native sections and detail routes; reuse current services | Existing workflow tests plus section scenarios |
| Feed and Digest reading | OKF/Engine | Add native section while retaining history, pagination, and reading position | Feed workflow and lifecycle tests |
| Claudian | Existing bridge | Keep global and contextual entry points with graceful absence | Bridge tests and disabled-plugin scenario |
| Engine operations | Existing Engine API/monitor | Plugin-level ownership; local Vault reading/editing remains available offline | Service/lifecycle and unavailable-Engine scenarios |

## Existing OKF entry-point inventory

The unified plugin must retain the current Dashboard commands and ribbon entry, quick Capture and Daily
creation, project creation/status/log/Decision actions, explicit study completion and reversal, Feed source
and item workflows, document import, operation monitoring, Digest reading controls, semantic search, and the
Claudian v1 handoff. Each entry may move in the interface, but none may require the retired Dashboard View.

## Staged gates

| Stage | Deliverable | Gate status |
| --- | --- | --- |
| M0 | Scope, ownership, baseline, capability and acceptance ledgers | Complete: architecture ownership, this ledger, and `dashboard/UPSTREAM.md`; local links and `git diff --check` passed |
| M1 | Apex subtree and one outer plugin build/identity | Complete: locked subtree, all 28 baseline scripts, independent/outer builds, one installed identity, and real Obsidian load passed |
| M2 | Existing OKF services, settings, commands, and plugin lifecycle exposed to new host | Complete: one outer plugin owns native services and OKF workflows; 22 commands, reload, two-pane, pane-close timer, Engine-offline, and Claudian-absent runs passed |
| M3 | Stable section IDs, lossless board repository, registry, pane-local state | Complete: stable IDs, lossless schema/body round-trip, shared write coordination, and real two-pane save/reload passed |
| M4 | Full Project experience and managed-artifact edit policy | **Complete after parity repair:** shared Project Surface restores contextual Capture/import, Claudian, catalog, metrics and state-aware actions, while retaining formal tasks, dates and Decision creation; nonempty real Obsidian run passed |
| M5 | Unified task/calendar/Daily/Capture loop | **Complete after parity repair:** shared Today and Life Surfaces restore continuation, attention, Feed, reflection/review and global entry points; anchored task/date regression and nonempty real run passed |
| M6 | Learning/Knowledge/Inbox/Import sections and details | **Complete after parity repair:** registered Apex types mount the complete shared Surfaces; scope/context, operation states, filters, verification, decisions, recovery and Claudian paths are reachable; nonempty real run passed |
| M7 | Feed/Reading and default workbench presets | **Complete:** automated pagination/cache/scroll/request tests pass; isolated Obsidian completed authenticated live Producer and TreeHole sync, traversed all 39 editions for a registry-managed source over 10 pages, and loaded more history in the UI |
| M8 | Native-data takeover, UX, capability, and performance work | **Complete for desktop implementation:** native takeover remains intact; eight shared Surfaces, Life/System access, custom-section cleanup and 9-to-9 rerender stability passed in real Obsidian |
| M9 | Full release, rollback, real Obsidian, and upstream-update exercise | **Passed in isolated acceptance Vault:** loaded the prior 3.6.0 bundle and restored the 3.6.5 candidate under the single unified plugin ID; before/after snapshot comparison passed identity, enabled state, semantic settings, native-data bytes, and normalized takeover receipt. Final candidate reload and second comparison also passed |

## Final acceptance matrix

The A01–A19 statuses below report only the named scenario. They are necessary regression evidence, not a
claim of complete Dashboard replacement. P07 and M9 were completed in the isolated acceptance Vault; the
following rows record the individual scenario evidence:

| ID | Scenario | Required evidence | Status |
| --- | --- | --- | --- |
| P01 | Learning feature parity | Registered Apex section exposes the former scope, context, workflow states, recovery, Claudian, completion, and Wiki actions | **Passed:** 49 shared-Surface behavior tests plus nonempty Course/ready/pending/completed real run |
| P02 | Inbox/import feature parity | Registered Apex section exposes decisions, bulk handling, conversion progress, fallback, retry, cancel, and recovery | **Passed:** registered shared Surface, workflow tests and real Web Clip two-stage decision run |
| P03 | Knowledge feature parity | Registered Apex section exposes catalog, search, filters, verification, lifecycle badges, and operation states | **Passed:** registered shared Surface and real AI-unverified Wiki run |
| P04 | Project feature parity | Registered Apex section exposes contextual capture/import, Claudian, catalog, status-aware action, and precise related navigation | **Passed:** full action panel, formal task/date and nonempty real Project run |
| P05 | Today/Life feature parity | Registered Apex sections expose continuation, attention, Feed, reflection/review, calendar, and capture organization | **Passed:** nonempty Today task/continuation run and real Life navigation |
| P06 | System/global controls | Registered surface exposes diagnostics, task center, failed-operation recovery, settings, search, quick create, and Ask Notes | **Passed:** registered System Surface, embedded navigation and existing recovery tests |
| P07 | Reading controller parity | Registered Apex section passes full-load, pagination, cache, stale-response, scroll, refresh-failure, and sync scenarios | **Passed:** Automated pagination and lifecycle coverage passed. In isolated Obsidian, the live Producer reported healthy streams and synced all four AI Daily streams plus TreeHole; UI showed the success notice, 12 Papers items rendered, and the source summary reported the latest editions. A registry-managed source with 39 learning editions traversed 10 API pages (4 per page, final page 3), with 39 unique editions and `has_more=false`; the UI load-more control advanced history from 4 to 8 editions. Existing source overview contained six cards, including cached legacy entries, so those cards are not all counted as live Producer evidence |
| P08 | Reachable-surface acceptance | Nonempty real Obsidian run verifies every inventory action through the registered Apex surfaces | **Passed:** synthetic task-center walkthrough covers queued, generating, publishing, failed, cancelled, conversion fallback, cancel/retry/continue actions. Isolated Obsidian verified newer-schema preservation, duplicate sections, two-pane synchronization, authenticated synthetic Feed sync, repaired papers-scroll restoration, Calendar task times, multiple new-note templates and variable substitution, table-column hide/restore, card deletion, focal-point persistence, and 50-item progressive group rendering |

| ID | Scenario | Required evidence | Status |
| --- | --- | --- | --- |
| A01 | Create a dated Project action | One task body appears through Project, Today, and Calendar; completion from any view updates all | Passed: real three-view projection and completion plus task/project/Vault tests |
| A02 | Put one Project in two workbenches | Status synchronizes; removing one reference keeps the Project; filters remain independent | Passed: real `dashboard` and `Acceptanceprojectworkspace` panes synchronized status while retaining the Project |
| A03 | Rename/reorder same-named sections | Stable IDs retain config, collapse, scroll, and body association | Passed: lossless stable-ID tests and real rename/save/reload |
| A04 | Complete a board checklist from Calendar, then save layout | Completion remains after layout save/reload | Passed: completed source survived later layout writes and reload; merge tests passed |
| A05 | Checkboxes in fences/YAML/Source Text/Digest | Formal-task query excludes them; explicit ordinary-checklist filter can still expose ordinary lists | Passed: shared TS/Python fixtures and scanner/projection tests |
| A06 | Reminder before due and scheduled distinct from due | All values render and edit independently; reminder never overwrites due | Passed: real three-field editor write plus independent parser/write tests |
| A07 | Duplicate text, file rename, and line movement | Mutation finds the same anchored task or requests reread; never changes its twin | Passed: real rename/line-shift/twin task run and block-ID tests |
| A08 | Database edits or drags a Project/Source | Legal action is used; identity, pair, managed regions, and path contract remain valid | Passed: real typed Project status and denied Source edit/move; policy tests passed |
| A09 | Calendar creates task for a missing Daily | A valid Daily for the clicked date is created; no fallback to today or a board list | Passed: real `2031-04-05` Daily creation and service tests |
| A10 | Feed to study/wiki/reference with one Source in several Projects | One Source, independent idempotent uses, correct context, no inferred interest | Passed: Engine and Dashboard workflow integration tests |
| A11 | Finish a book/timer or generate Study Guide | `studied_at` is unchanged until explicit human confirmation | Passed: real timer run, Vault-wide check, and explicit completion tests |
| A12 | Convert sticky note to Capture with interruption/repeated click | Text is recoverable and idempotent; no long-lived duplicate body | Passed: real conversion/repeat retained one durable marker; failure tests passed |
| A13 | Close section or last workbench pane | Background work continues, notification occurs once, reopened UI shows real result | Passed: real last-pane Pomodoro completion/reopen plus lifecycle tests |
| A14 | Engine unavailable | Vault read/light edits work; import/generation reports the exact unavailable capability | Passed: real disconnected UI and continued Vault actions plus API tests |
| A15 | Claudian unavailable | Other workbench features work; AI action offers clear context/prompt fallback | Passed: real absent-Claudian fallback and bridge tests |
| A16 | Feed return, note update, or theme switch | Unrelated web/music/timer state survives; reading page and position survive | Passed: real theme cycle preserved exact Feed position and Pomodoro bytes; UI-state tests passed |
| A17 | Unknown field/section/free prose/newer board version | Data is retained and compatibility limit is visible; save never silently drops it | Passed: real schema-99 warning and repeated save preservation plus format tests |
| A18 | Re-run interrupted legacy Apex-data takeover | Original format remains, manual changes are not overwritten, no Vault notes are created, one writer remains | Passed: real disabled-legacy copy/rerun/conflict run plus takeover tests |
| A19 | Apply an upstream update | Native Apex and integrated OKF scenarios pass after a real subtree update exercise | **Passed:** isolated 2.5.4 → 3.6.0 → 3.6.5 subtree updates; 44 Apex scripts/lint/build, root check, P01–P08 acceptance, and upgrade/rollback comparison; see the Apex 3.6.5 isolated Obsidian run below and [upstream baseline](UPSTREAM.md) |

## Synthetic Vault scenarios

Automated integration fixtures will create only synthetic data and cover: two same-named sections with
unknown YAML/prose; two same-text tasks with different anchors; fenced and YAML block checkboxes; a missing
historical Daily; one Source with study/wiki/reference uses in two Projects; a managed Project and Source
opened through database/kanban views; a pending Engine operation observed across pane closure; and two
conflicting native-data directories for takeover recovery.

For each completed row, replace `Pending` with the test/fixture path and the recorded disposable-Vault run.
No status may be inferred from a nearby unit test that does not execute the complete scenario.

## Apex 3.6.5 isolated Obsidian run (2026-09-28)

Runtime: disposable `OKF-Apex-Manual-Test` Vault opened with the isolated Obsidian profile and CDP on
`127.0.0.1:9337`; plugin `okf-workspace-dashboard` 1.15.0 was loaded. The separate default Obsidian
profile was not used. The isolated Vault contained only synthetic notes.

- Opened both configured workbenches and confirmed the unified plugin rendered the OKF shared surfaces.
- Added and deleted temporary sections through the rendered UI. The two dashboard panes observed the same
  update and deletion. After each save, the newer `workbench_schema: 99`, unknown YAML, duplicate section IDs,
  and both anchored prose blocks remained intact.
- Disabled and re-enabled the plugin in Obsidian. The plugin reloaded, one dashboard plugin ID remained
  enabled, and the installed plugin `data.json` SHA-256 stayed
  `8C64634DF56415A2392F2F74172729360D4BFF6859BE7CCFA03163AAA12AAD17`.
- Ran Obsidian's `app:reload` command. The isolated Vault reopened with the candidate plugin loaded, the
  single dashboard identity enabled, the `dashboard` workbench active, and the schema-99 warning visible.
- Started a separate Engine at `127.0.0.1:18765` with the disposable Vault and fresh temporary State and
  Originals directories. Its random token stayed in the temporary State directory outside the Vault; the
  plugin stored only the token-file path. An unauthenticated Feed request returned 401.
- Configured the isolated plugin to use that Engine and clicked “同步最新内容”. The authenticated sync
  returned synthetic AI Daily and Treehole editions. A 12-item synthetic Papers edition rendered in Reading;
  the UI displayed all 12 items and reported successful synchronization.
- A 220 px Papers scroll offset initially reset after switching workbenches. The view constructor omitted
  `ai-daily-papers` when restoring persisted feed offsets. The constructor now initializes all feeds through
  `DASHBOARD_FEEDS`; after rebuilding and reloading the isolated plugin, 220 px was restored across the same
  workbench switch. Regression coverage is in `dashboard/tests/dashboard-view.test.ts`.
- Created three synthetic formal tasks for 2026-09-28, opened the Calendar section in Week view, and verified
  `10:00–18:00` for a scheduled same-day task, `08:00–14:30` for a reminder task, and `09:15` for a due-only
  task. Deleted the temporary section through its UI confirmation and trashed the synthetic note afterward.
- Configured two temporary new-note templates through the folder UI, selected the second template, and verified
  its frontmatter, `{{title}}`, and `{{date:YYYY-MM-DD}}` substitutions in the created note. Removed both
  templates and trashed the note/template files afterward.
- Switched the synthetic Notes section to Table, hid and restored its `status` column through the column
  picker, then returned it to the original Kanban view. Created and deleted a temporary card through the UI
  confirmation and verified its note was removed.
- Created 55 temporary notes grouped by `status`; the Kanban column initially rendered 50 and showed a
  “show more (5 remaining)” control. Activating it rendered all 55. Removed the notes and folder and restored
  the original grouping setting afterward.
- In the banner editor, used a temporary local image and moved the focal point to `30%,70%`. Saving persisted
  the matching `imagePos` entry while retaining the banner quote/author and schema-99 metadata. Cleared the
  image through the same UI, verified `imagePos` was removed, and trashed the temporary image.
- Closed and relaunched the isolated Obsidian process with the same isolated profile and CDP port. The
  candidate loaded with only `okf-workspace-dashboard` enabled, restored the schema-99 board warning and
  workbench, and successfully authenticated to the temporary Engine for another two-feed sync. The token
  remained in memory only; the external token-file path and Engine URL persisted, and `data.json` had no
  `token` property.
- Immediately before rollback, captured a redacted snapshot outside the Vault. Loaded the prior 3.6.0 bundle
  under the unified `okf-workspace-dashboard` identity, then compared the post-load snapshot with the baseline.
  All five comparisons passed: identity, exactly-once enabled state, semantic settings excluding the transient
  token, native data bytes, and normalized takeover receipt. The isolated Vault had none of the five optional
  native JSON files, and that absence was unchanged.
- Restored and reloaded the 3.6.5 candidate. CDP confirmed Obsidian, the unified plugin, and workspace were
  ready; the main bundle hash matched the candidate build. A second snapshot against the same baseline passed
  all comparisons. Snapshot reports and the candidate backup remain outside the Vault.
- Connected the isolated Engine to the configured remote Producer aliases and ran the Obsidian sync command.
  The Producer probe reported healthy streams; AI Daily and TreeHole sync completed, the UI displayed
  “订阅内容已同步”, Papers showed 12 items, and the latest issue dates were 2026-09-28. The live source's
  39 learning editions were paged through 10 API requests with no duplicates or remaining cursor. The UI
  history load-more action increased the visible editions from 4 to 8. The six-card overview also includes
  legacy cached sources and is not treated as six live sources.
- P08's reachable-surface inventory passed in the isolated run. Together with the live sync and rollback
  comparison above, P07 and M9 now pass for this isolated acceptance Vault. No production Vault was used.

## Production cutover (2026-09-29)

- Release: `v0.8.0`, repository revision `7a9ea715a9169809d47d1b19204ea7d2756a4325`.
- Before installation, copied the complete production Vault and separate Apex, unified Dashboard, and
  Claudian plugin directories to `E:\ObsidianData\Backups\okf-pre-cutover-20260928T234914`. The Vault
  snapshot contains 247 files / 36,326,700 bytes; source and snapshot SHA-256 values matched for every file.
- `scripts/check.ps1`: passed (Engine 450, cross-component 8, Dashboard 246, Claudian 6,316 passed / 3
  skipped, plus type, lint, architecture, and build checks). `scripts/build.ps1`: passed.
- Dashboard `npm audit --omit=dev`: 0 production dependency vulnerabilities. `npm ci` reported two
  moderate advisories in the development dependency tree; production install/build was unaffected.
- `deploy/windows/install.ps1`: completed. It synchronized managed Vault resources and Skills, installed
  Dashboard 1.16.0 and Claudian 2.3.6-okf.4, rebuilt the index (83 notes, 676 chunks), and passed the
  installer acceptance suite (450 Python tests, synthetic Vault, performance checks, and one-session UAT).
  `okf validate` passed with 82 Markdown files checked.
- Obsidian 1.13.7 opened the production Vault. The unified Dashboard and Claudian loaded; the only active
  Dashboard ID is `okf-workspace-dashboard`, while `apex-dashboard` remains disabled. The Dashboard view
  rendered, and the local Engine `/health` endpoint returned HTTP 200.
- The Apex native-data takeover receipt contains five `source-missing` entries. No existing Apex native JSON
  files were present to copy. The maintenance and Feed Sync scheduled tasks are registered and Ready.
- `scripts/record-deployment.ps1` verified installed Dashboard and Claudian artifact hashes. Its Dashboard
  artifact path reads the built `dashboard/dist/` files; that script correction is included in commit
  `cdb2a246`. The receipt's `tracked_worktree_dirty` value records the repository state when the receipt was
  generated and does not describe the current checkout. The installed plugin hashes match the release build.
- No production business notes were created or edited during runtime verification. Detailed Project/Today/
  Calendar, Reading, two-pane, and rollback scenarios remain covered by the synthetic acceptance Vault above.

### M9 rollback snapshot procedure

Run these commands from the repository root in the isolated test setup. Keep both report files outside the
Vault. Capture the first snapshot immediately before replacing the candidate package with the prior package;
after the prior package is loaded, capture the second snapshot with `-CompareTo`:

```powershell
.\scripts\dashboard-rollback-snapshot.ps1 `
  -Vault 'D:\ObsidianTests\OKF-Apex-Manual-Test' `
  -OutputPath 'C:\Temp\apex-rollback-before.json'

# Load the prior package under the same unified plugin identity, then run:
.\scripts\dashboard-rollback-snapshot.ps1 `
  -Vault 'D:\ObsidianTests\OKF-Apex-Manual-Test' `
  -OutputPath 'C:\Temp\apex-rollback-after.json' `
  -CompareTo 'C:\Temp\apex-rollback-before.json'
```

The comparison exits with an error if plugin identity/enabled state, semantic settings, any of the five native
JSON file hashes, or the normalized takeover receipt differs. The report excludes settings content and the
transient token; preserve it as acceptance evidence. A failed semantic-settings check requires investigation
and explicit review of the differing setting fields before M9 can pass.
