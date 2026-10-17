# Dashboard 验收台账

## 当前结论

更新：2026-10-17。Apex 选择性更新、统一快速记录、OKF 项目组织、分区交互及沉浸式工作台已完成开发与约定验收。
前四项通过 PR #9 合并到 `main`，合并提交为 `122286ce`；沉浸式工作台的来源与验收证据见下节。当前采用范围及排除项只维护在
[上游采用策略](UPSTREAM.md#上游采用策略)，使用方法见[使用指南](../docs/USER-GUIDE.md)。

本轮更新没有部署正式环境。以下结果分别对应具名源码与候选产物，截图及历史部署记录保留各自的验证范围。
后续发布遵循[部署指南](../docs/DEPLOYMENT.md#production-cutover)。
沉浸式专项的独立分支与验收状态见下节。

## 沉浸式工作台

2026-10-17 在独立工作树 `work/immersive-workbench/` 完成上游 3.8.5 沉浸式布局移植和专项验收，基线 `6eb0fb7c`，
分支 `codex/immersive-workbench`，验收回执对应该分支提交前的源码快照。未部署正式环境。
以下证据位于主工作区 `work/immersive-workbench/work/upstream-port/`，构建安装文件与源码哈希见 `receipt.json`。

| 范围 | 实际结果与证据 |
| --- | --- |
| 自动化 | Dashboard 类型检查、构建、64 个文件 / 460 项测试通过；`tests-final.log`、`typecheck-final.log`、`build-final.log`。Apex 全部 49 项 `test:*` 脚本通过，后续网格修正重跑两个沉浸式脚本；对应 `final-test-*.log`、`lint-final.log`、`apex-build-final.log` |
| 布局与业务 | 原生鼠标拖动、右边／底边／角部缩放、落点预览和失焦取消通过；单纯调整布局保留业务分区与 Capture 输入节点。完整业务区域内部滚动、重复测量稳定、固定坐标防重叠、成员移除重加通过。实际新建和完成任务仍刷新业务显示；`drag.json`、`resize-*.json`、`flow-taskRefresh.json`、`flow-widget.json` |
| 状态与数据 | 双窗格共享草稿、计时服务和显示；工作台布局隔离、冷启动恢复。真实表单保留七种本地预设，创建沉浸式工作台和三类小组件实例。旧格式打开不写入，明确保存写入原生字段，正文和未知扩展保留；`flow-multiPane.json`、`flow-cold.json`、`flow-create.json`、`flow-instances.json`、`flow-legacy.json` |
| 故障与并发 | 真实只读文件触发 EPERM，保留输入并显示重试入口，解除只读后实际重试成功；同一卡片并发修改拒绝覆盖，不同卡片修改合并，重新读取恢复磁盘状态。`flow-fault.json`、`flow-retry.json`、`flow-conflict.json` |
| Capture 与弹出窗口 | Enter 实际创建单篇 Capture；独立 Obsidian 弹出窗口使用独立 Document，缩放持久化、共享计时服务和遮罩释放通过。`flow-capture.json`、`popout.json` |
| 视觉与上游比较 | 真实 Obsidian 明暗主题、完整业务分区、430×950 窗口、添加菜单、布局菜单、无背景与保存失败逐张检查。未修改的上游沉浸式核心与本地核心使用相同夹具、原生 Obsidian API 和共享宿主适配渲染，卡片几何完全一致；该比较没有安装完整上游插件。截图及范围见 `receipt.json`、`visual-review.md` |
| 安装与退出 | 三个候选文件核对安装哈希，保存在 `candidate/`。使用本次新快照恢复受管运行文件，178 个原有文件恢复时逐字节核对；退出策略额外关闭 Engine 自动启动，其余设置与用户此前的人工测试修改保留。清理 14 个合成文件、索引 4 个条目，合成索引剩余 0。窗口、Engine、自动启动、LiveSync 关闭，8766/9366 无监听；`cleanup.json`、`index-cleanup.json`、`exit-status.json` |

真实手机、远端同步和外部在线服务未纳入本次实机验证。上游完整导入基线仍为 3.6.5，
本次移植范围与本地差异只维护在[上游采用策略](UPSTREAM.md#上游采用策略)。

## 整合候选验收

快速记录 `9b5fe03e` 与项目类别 `61192b93` 经 `364d4570` 整合；后续测试夹具修正与文档记录随 PR #9 合入。
本节证据统一位于主工作区 `work/branch-integration/`，三个候选安装文件保存在其中的 `candidate/`。

| 验证范围 | 实际结果与证据 |
| --- | --- |
| 根检查 | `scripts/check.ps1` 通过：Engine 600，跨组件 12 passed / 1 skipped，Dashboard 61 个文件 / 435 项测试，Claudian 420 suites / 6316 passed / 3 skipped，72 项脚本测试；类型、lint 和构建通过。原始输出 `root-check-final.log` |
| Apex | 全部 47 项专项检查、lint 与独立构建通过，日志 `work/integration-apex-checks/` |
| 实机交叉流程 | 固定 OKF-Test、独立 State/profile、API 8766、CDP 9366，LiveSync 关闭。真实创建表单建立两个已分类项目，操作类别看板与置顶；项目内使用原生键鼠保存 Capture，关联指向项目主页，置顶不改写项目 Markdown |
| 类别与文件保护 | 真实类别表单和两次 Engine HTTP 写入核对类别修改与旧值检查；Capture 字节、项目未知字段、正文和任务保留。表单使用 DOM 事件驱动，业务写入接口未替换 |
| 故障与重启 | 将测试设置文件和 Capture 目标分别占用为目录，触发真实磁盘错误；草稿保存失败阻止创建，恢复后重试复用目标且正文保留。冷启动后类别恢复 |
| 安装与清理 | 安装文件与候选 SHA-256 一致，见 `runtime-receipt.json`。删除 7 个合成文件，167 个原有文件恢复并逐字节比较，索引清除 6 个合成条目；窗口、Engine、自动启动与 LiveSync 关闭，8766/9366 无监听，见 `cleanup.json`、`exit-status.json` |

整合候选 SHA-256：

| 文件 | SHA-256 |
| --- | --- |
| `main.js` | `a6ca74c2f0523aa935924977668e17e2bc80558fb3675821861218efa274f498` |
| `styles.css` | `3740349608f0c50bd719be29b71852ec7d3f864905b1fda158c709e4976a3bd6` |

完整三个文件哈希以候选回执为准。整合验收没有新增截图视觉检查、真实移动设备或远端同步验收；
下面的专项截图对应各自的安装产物。

首轮整合根检查的 Windows 并发硬链接替换 EPERM 保存在 `work/integration-root-check.log`。
夹具按项目约定使用忽略的工作目录，保留真实硬链接、并发写入及不支持硬链接的断言，25 项专项测试通过；
最终完整根检查以上表日志为准。原生交互脚本失败记录与定位资料保留在本节证据目录。

## 专项验收与证据索引

### Apex 选择性更新

| 范围 | 已验证内容与证据 |
| --- | --- |
| 外观与图标 | 实际保存、应用、删除主题并冷启动；原生图标列表展示 400 项，搜索保存非精选 `calendar-clock`。验证默认侧栏固定及显式取消偏好的保留 |
| 计时与记账 | 真实正计时保存、重复结束不新增记录、跨日期历史、多 pane 订阅及冷启动；空数据分类增删、分组、排序和流水保留。实机结果 `work/apex-runtime-results.json`，候选 `work/apex-selected-accepted/` |
| 导航与拖动 | 同名分区按稳定 ID 定位；原生鼠标调整高度并保存，未知字段与正文保留；窗口失焦取消不写文件，调整状态与遮罩清理 |
| 视觉 | 逐张查看最终 41 张真实 Obsidian 截图：胶囊、抹茶、丁香的明暗主题，左右／上下布局，计时设置、提醒与统计，分类管理、外观工作室、主题命名及图标选择。复查对比度、窄窗口排版和悬浮计时主题切换。截图、候选、哈希与恢复记录在 `work/apex-visual-20261016/` |
| 自动化 | `work/apex-visual-accepted-checks/`、`work/apex-prepush-checks/`；两次均包含全部 47 项 Apex 检查脚本、lint 与独立构建。横幅有图／无图／指定颜色及分区菜单事件回归通过 |
| 外部服务 | 网易云真实搜索返回 30 条，未播放音频；测试环境无微信读书凭据，未验证其在线调用 |

41 张截图的 `main.js` 为 `da7f25655f58a69bc113109abd0fe91c111a6ec7edf03e6540bcf690d59ab6d6`，
`styles.css` 为 `2523a5e089b097fab41a688ece415259a09f7bf2bc54d2a5c0dcc97bddbd882c`。
完整清单为 `work/apex-visual-20261016/receipt.json`；截图中的提醒调用实际服务方法打开，
提醒间隔由隔离测试验证。430px 为桌面视口模拟，未验证真实移动设备或系统睡眠恢复。

该阶段较早根检查的 Windows EPERM、专项复查及最终通过记录分别为
`work/apex-root-check.log`、`work/apex-claudian-recheck.log`、`work/apex-root-check-final.log`。
分区配置入口断言失败日志保存在 `work/apex-visual-checks/` 和 `work/apex-visual-final-checks/`。

### 统一快速记录

| 范围 | 已验证内容与证据 |
| --- | --- |
| 草稿与关联 | 默认、课程和项目上下文隔离，双窗格同步编辑，关闭后保留与冷启动恢复；在原生收集箱中找到保存的 Capture |
| 原生交互 | 实际 Enter、Shift+Enter、Ctrl+Enter、Escape、命令面板、系统下拉及重复提交；记录 `work/capture-native-20261016/receipt.json` |
| 真实失败 | 设置路径占用阻止 Capture 创建；目标目录冲突、写入后草稿清理失败均保留正文并可重试；恢复后目标数量、正文哈希和修改时间保持一致。实际 Obsidian 设置接口经回读确认持久化，见同目录 `platform.json` 与故障记录 |
| 视觉 | 最终 26 张真实截图逐张查看，覆盖三种主题的明暗、两种布局、双窗格、长短文本、展开编辑及 430×900；保存失败和已保存但清理失败时正文仍可选取，原生 Ctrl+A 选中完整正文 |
| 产物与清理 | 截图、候选、安装哈希和清理回执在 `work/capture-visual-20261016/`；合成 Capture 和关系夹具已清理，各轮配置恢复原始存在状态与字节，测试服务与同步关闭 |

该专项最终 `main.js` 为 `f92f3d0ce21d142cd6e16755116a848c13086ddb3468b0c1c507f9a464725eab`，
`styles.css` 为 `b1cefdcb49d2f23acdac58e72031d1c42155b173bddb54d013908b67c72ffc27`。
自动化日志在 `work/capture-unification-apex-final/`；初始跨度断言失败保留在
`work/capture-unification-apex-checks/`。该专项未验证真实移动设备或远端同步。

### 项目类别与组织

项目类别创建、清除、合并与并发旧值检查，真实全文索引命中和清理，类别／状态跨组移动、
同组手动顺序、置顶和冷启动恢复均已验证。未改变项目路径、正文、任务、未知字段与原关联。
430px 桌面视口下测量分类窗口和卡片无横向溢出；该专项没有截图视觉验收。

当前可复查的整合实机证据集中在 `work/branch-integration/`：`projects.json` 记录实际创建，
`category.json` 和 `api.json` 记录表单与 HTTP 类别修改，`cold-start.log`、`reopen.json` 记录重启及类别恢复，
候选、完整检查、文件恢复和索引清理见本页的整合验收记录。
原项目类别独立工作目录已不存在；专项的原始结果摘要、历史候选哈希与当时故障日志位置
可从 `git show 122286ce:dashboard/ACCEPTANCE.md` 读取，当前不将旧目录作为可用证据入口。

### 分区目录、页面与任务

分区目录搜索、公共菜单、独立页面、放大窗口、返回位置、过滤状态隔离、创建失败保留输入及重试不重复，
均通过实际 Obsidian 验证。该专项逐张查看最终 34 张截图，覆盖明暗主题、1440×1000 与 430×950。
26 项实机结果、截图和产物清单分别为 `work/section-experience-evidence/final-run.json`、`receipt.json`，
候选在同目录 `candidate/`。隔离夹具使用 API 8772、CDP 9372，退出时均无监听。
原隔离夹具路径已不存在，当前复查使用上述证据和固定候选。

分区体验工作树的 2,199 个源码文件已归档并逐文件校验，随后移除旧工作树和分支。
归档与清单位于 `work/branch-integration/section-experience-source.zip`、`section-archive.json`；
验收资料继续保留在主工作区。当前操作和 Tasks／清单边界分别见
[使用指南](../docs/USER-GUIDE.md#分区与工作台)、[任务与工作台清单操作](../docs/USER-GUIDE.md#tasks)。

## 历史验收与部署依据

| 日期与主题 | 保留的结论与证据位置 |
| --- | --- |
| 2026-10-15 分区与视觉 | 35 项实机检查及最终 39 张截图；`work/surface-final-results.json`、`work/surface-visual-final/receipt.json`，包含配置并发保护、正文保留和任务写入后重试 |
| 2026-10-15 Tasks 边界 | 实际 Tasks 配置、Apex 父子清单、拒绝越界写入和重启核对；`work/tasks-boundary-accepted/` 固定候选，`work/tasks-boundary-*-final.log` 保留实机结果 |
| 2026-10-15 固定测试环境 | 固定 OKF-Test 的 29 项界面、10 项真实 API、离线 Capture 和冷启动核对；`work/fixed-test-acceptance-result.json`、`work/fixed-test-live-api-result.json`、`work/fixed-test-offline-result.json`、`work/fixed-test-final-lifecycle.json` |
| 2026-10-13～14 界面与 Tasks 整合 | 旧隔离环境及诊断归档于 `E:\ObsidianData\Archives\20261015-test-consolidation`；完整清单与历史候选说明可从 Git 历史读取。2026-10-13 根检查的 Claudian 并发文件失败保存在 `work/root-acceptance-rerun.log`，该次未通过完整根检查 |
| 2026-09-28 Apex 3.6.5 | 完成独立 Obsidian、P01–P08、M0–M9 桌面场景及升级／旧版恢复比较；身份、唯一启用状态、语义设置、原生数据字节和接管回执比较通过。真实 Producer 同步及 39 期期次分页已验证；完整原始记录见下述历史文档 |
| 2026-09-29 正式切换 | `v0.8.0` / `7a9ea715a9169809d47d1b19204ea7d2756a4325` 的安装、实际插件加载、Engine health、计划任务和部署回执核验完成。切换前备份位于 `E:\ObsidianData\Backups\okf-pre-cutover-20260928T234914`；该记录只证明当次部署 |

完整旧台账可用 `git show 122286ce:dashboard/ACCEPTANCE.md` 读取。阶段计划、旧候选的逐步修正与过时操作示例
由 Git 历史保留；原始日志、截图、哈希、故障诊断和恢复资料不随本文整理删除。
当前验收要求统一维护在[开发指南](../docs/DEVELOPMENT.md)，实际安装与恢复程序维护在
[部署指南](../docs/DEPLOYMENT.md#plugin-deployment)。
