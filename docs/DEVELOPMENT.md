# 开发与验收

[文档索引](README.md) · [架构边界](architecture/README.md) · [部署运维](DEPLOYMENT.md)

本文件维护开发命令、修改要求和验收方法。测试矩阵是要求，不代表本次或生产环境已经通过；已执行的验收证据保存在组件验收台账和发布记录。

按需阅读：[环境](#开发环境) · [检查与构建](#检查与构建) · [合成 Vault 验收](#合成-vault-完整流程) · [实机验收](#实机与外部服务验收) · [文案](#界面命名与文案) · [文档维护](#文档维护)。

## 开发环境

要求 Windows 11、PowerShell 7、Python 3.12、uv、Node.js 24、npm、Git、Obsidian 和
已登录的 Codex CLI。

```powershell
cd E:\code\okf-workspace
.\scripts\bootstrap.ps1
.\scripts\check.ps1
.\scripts\build.ps1
```

Dashboard 与 Claudian 有各自的 lockfile；Engine 与 MarkItDown 也有各自的 uv 环境。根脚本
只是统一调度，不在组件之间共享隐式依赖。

## 正式发布后的继续开发

源码、正式程序和测试数据分别维护。正式程序通过版本包部署，例如 `D:\OKF-Workspace`；
开发仍在本仓库进行。修改源码不会改变已安装的正式 Engine，构建插件时只部署到测试 Vault。

保留一个按当前 Contracts 初始化的 `E:\ObsidianData\OKF-Test`，配套独立
`OKF-Test-State`、本地端口 `8766`、本地 token 和远端 `okf-test` 数据库及专用账户。
旧 `OKF-Brain`、`OKF-Workspace` 和 `okf-workspace` 数据库继续作为历史档案，
不整体复制到新的测试或正式环境。测试内容使用合成资料；自动化测试仍自行建立临时 fixture Vault。

源码安装测试环境时显式指定这些路径、`-ApiPort 8766 -SkipScheduledTasks`；
测试不持有正式环境的全局计划任务。安装后在测试 State 的 `config/test-environment.json`
记录 `environment: test`、对应安装身份、Vault、State 和端口，供控制脚本校验。
默认关闭 Engine 自动启动和 LiveSync。已有测试环境可使用：

```powershell
.\scripts\test-workspace.ps1 -Action Start
.\scripts\test-workspace.ps1 -Action Stop
.\scripts\test-workspace.ps1 -Action Status
# 只有开发同步功能时才接入测试数据库：
.\scripts\test-workspace.ps1 -Action Start -EnableSync
```

Start 打开测试 Vault 并启动其 Engine；Stop 关闭测试窗口、关闭 Engine 自动启动和 LiveSync，
不影响正式 Vault。脚本要求有效的测试环境标识，拒绝正式端口和不匹配的 Dashboard 配置。
CouchDB 可以同时保留正式和测试库；平时停用测试客户端即可，不能停止正式库共用的容器。
测试 CouchDB 版本或服务器配置时使用独立容器。

更新插件时显式指定测试环境：

```powershell
.\scripts\install-dashboard.ps1 -Vault E:\ObsidianData\OKF-Test -State E:\ObsidianData\OKF-Test-State
.\scripts\install-okf-claudian.ps1 -Vault E:\ObsidianData\OKF-Test
```

Claudian 的本地 `.env.local` 若启用自动复制，只能指向测试 Vault。
测试结束执行 Stop，避免自动同步和后台 AI 写入继续运行。

后续流程为：提交当前发布基线 → 新分支开发 → 相关自动化检查 → 测试 Vault 验证 →
更新版本并打包 → 安装正式环境。保留上一个版本包以便回退；涉及数据 schema 的回退先恢复匹配数据。
已经完成且与本次改动无关的 LiveSync／平板验收可以沿用。

## 检查与构建

根目录执行 `scripts/check.ps1`，覆盖 Engine pytest/Ruff/Pyright、`tests/e2e` fixture-Vault 测试与 Ruff、Dashboard TypeScript/Vitest/build、Claudian typecheck/lint/完整测试/build，以及 Windows 插件身份迁移检查。`scripts/build.ps1` 生成 Engine wheel 和两套插件产物。

针对性检查可以先在相应组件目录运行：

| 修改范围 | 检查 |
| --- | --- |
| Engine Python | `uv run pytest <相关测试>`、`uv run ruff check src tests`、`uv run pyright` |
| Dashboard | `npm run check`、`npm test -- <相关测试>`、`npm run build` |
| Claudian | 先读最近的 `AGENTS.md`；代码修改运行 typecheck、lint、相关测试、build 及该指南要求的其他检查 |
| 跨组件 | 根目录 `uv run --project engine pytest tests/e2e`，再运行根检查脚本 |
| 文档 | `git diff --check`、本地链接与命令核对；组件文档有专用测试时运行该测试 |

历史 Originals 服务使用 `scripts/check-legacy-originals.ps1` 和独立 CI。当前 Vault 原件迁移、旧设备上传恢复仍进入默认 Engine／跨组件检查。

Dashboard 正式构建入口是 `src/plugin/main.ts`。八个 OKF Section 经 `features/workbench/okf-surface-sections.ts` 挂载共享 Surface；界面回归应覆盖实际 `OkfDashboardView`，不建立仅供旧测试使用的第二套实现。

Dashboard 产物是 `dist/main.js`、`dist/styles.css` 和根目录 `manifest.json`。Claudian 按其组件构建配置生成插件文件；其构建可能读取 `.env.local` 并向配置的 Vault 复制产物，执行前检查目标。快速安装与部署回执见[部署运维](DEPLOYMENT.md#plugin-deployment)。

## 测试原则

测试使用隐私安全的合成 Vault，按当前 Contracts 生成。历史生产笔记、旧 Runtime State 和废弃开发样例不作为新写入器的兼容门槛。生产内容、索引、秘密和运行状态留在仓库外。模拟测试验证协议与工作流；真实外部服务是否可用需单独 smoke test。

## Engine 验收矩阵

- Contract：所有 Workspace 写入器产生合法 YAML，并保留未知扩展字段。
- 工作台边界：使用 Apex 实际序列化器与六种预设生成合成工作台；任意名称、中文路径、
  旧版与未来版本不要求 Artifact 字段，身份冲突、非布尔标记及异常 YAML 明确报错。
  笔记迁移逐字节保留工作台；检索清理旧布局索引，显式附件读取最新正文；真实任务保留，
  工作台备份不重复参与检索、任务或笔记治理，备份恢复仍保留工作台。
- Sources：Source/Source Text 成对原子发布；Web/Feed 双向 URL 去重；文件哈希去重。
- Intake：默认仅保存原件不调用解析器；明确转换且未指定方式时使用 MinerU 云 API；本地 token 文件不进入仓库或 Vault；失败不隐式降级到旧服务。
- Retry：切换 parser 不残留永远 queued 的旧 conversion。
- Identity：原始文件名、resource、首个 `ingested_via` 不在 worker 中丢失。
- Relations：Course、Project、双关联与 Independent 都传播到目标，不改写共享 Source 身份。
- Learning/Knowledge：生成、更新、完成学习和 Wiki 沉淀语义分离。
- Retrieval：标题/全文/向量均只定位候选，回答实际读取 Markdown；关联扩展遵守相同范围，不匹配同名前缀目录；显式附件单独尊重用户选择。
- Operations：幂等、取消、重试、orphaned；生成结果发布前校验，冲突重读合并，不用旧快照回滚用户新内容。
- File safety：Windows drive/UNC/ADS/device 路径拒绝；跨进程创建只有一个成功者；Source 身份及用途合并不丢失。

- 导入恢复回归：同一文件换用途只合并 uses，保留 Source Text 人工修改和既有图片；显式换解析器必须实际调用新解析器，只有正文仍匹配上次发布摘要时才更新，冲突保留原文和新 export。
- 持久交接回归：READY 重启后从 export 继续；转换完成与生成入队之间中断可补偿；入队失败可见并独立重试；生成已完成但转换回执未落盘时不重复生成。
- 语义任务回归：多线程相同请求只创建一个任务；Feed 多课程／项目选择传到各自目标；后台生成不从旧 learned 字段写入 studied_at。

## Dashboard 验收矩阵

- 测试真实 `OkfDashboardView`，不能只测未运行的旧 page model。
- 导入窗口选择 Wiki 必须请求生成；已转换但尚未完成生成入队的项目继续显示在待处理区，并提供独立重试入口。
- Today 宽屏横向展示继续进行、待处理与待办，窄 pane 依次降为两栏和单栏；中国热点、AI 资讯、树洞热榜各自选择最近一期，卡片内滚动查看该期所有条目。
- Reading 展示 `learning` 订阅来源及 `papers` 论文卡片，使用与 Today 相同的滚动列表和 Feed 条目交互；按来源搜索和浏览历史，连续加载不重复、不跳期，返回后恢复滚动位置；论文不出现在 Today。
- Inbox 三阶段、渠道过滤、Web 四个离散动作及明确反馈。
- Learning 的 `全部 = Course + Project-related + Independent`，具体关系筛选和双关联正确。
- Project 快速记录、关联学习入口、状态与下一步展示准确。
- Vault-native 动作在 Engine 离线时仍可完成；后台动作显示排队、运行、完成、失败和重试。
- 页面刷新不重置 tab、筛选、details、输入焦点和已保存 scrollTop。
- 缓存刷新失败不能伪装成最新成功；单个坏笔记不能使整个视图消失；订阅确认前后退/关闭不触发重复提交或迟到结果覆盖。
- Reading 与实时预览使用相同的 Feed 判断；多 pane 操作取所属编辑器文件，不取全局活动文件。

## Claudian 验收矩阵

- Codex provider 使用本机 Codex CLI 登录态，Claude provider 未启用时不要求 Claude 认证。
- `okfBridge v1` 能接收 Dashboard 的任务、文件和 Skill 建议。
- OKF adapter 不反向侵入上游 domain/core；Dashboard 不依赖 Claudian 内部类。
- Vault `AGENTS.md`、Skills 与附件按任务读取，基础提示不复制整套 Workspace 说明。
- 上游 architecture tests 与 production build 持续通过。

1. Dashboard 交接打开 Claudian 的 Codex 会话，不打开外部终端。
2. 任务与上下文在发送前可见、可移除，不会在重登后补发旧输入。
3. read/write/plan 权限与指定 Skill 正确传递。
4. 普通问答不加载无关 Skill。
5. 切换提示模式只影响新会话。
6. Claude 会话不会接收 OKF Bridge 任务。
7. Claudian 关闭时，Dashboard、导入、Feed、检索和后台任务仍能独立工作。

## 合成 Vault 完整流程

每次发布使用临时目录重新生成，不复用旧状态：

1. 初始化 Vault 和 Contracts；
2. 快速记录一个无归属 Capture、一个 Course 想法和一个 Project 想法；
3. 先仅保存测试原件，确认不产生转换任务；再明确转换 PDF/DOCX/PPTX，确认默认云解析路径及图片完整性；
4. 发布 Web Clip 和 Feed 中相同 URL，确认只产生一个 Source pair；
5. 生成 Independent、Course、Project-related Study Guide；
6. 更新 Study Guide，用户明确标记完成，再生成/更新 Wiki 和 Wiki Map；
7. 创建 Project 日志与 Decision，整理 Daily；
8. 用新 Codex 对话检索 Wiki/Project/Learning，并记录真实读取路径；
9. 验证 Dashboard 所有入口、状态反馈和原生文件跳转；
10. 运行 validator/doctor 并确认没有悬空新任务、坏链接或重复 Source。

## 实机与外部服务验收

自动化全部通过后，只做一次短实机验收：

- MinerU 云 API 真实转换带图 DOCX，并验证结果 ZIP/图片完整性；
- 本机 Codex 完成一次可见会话和一次后台生成；
- Today 的中国热点、AI 资讯、树洞热榜各打开一条；Reading 验证至少两个来源卡片，进入其中一个来源、加载两期内容并处理一条；
- Obsidian 重启后 Dashboard、Claudian、本地服务生命周期正常；
- Windows 开机无旧 worker 或多余终端。

LiveSync 属于以后启用多设备时的独立验收，不阻塞当前单机发布。备份也不是当前开发
门槛；需要时再启用可选的外部备份。

使用仓库内公开测试 PDF 做一次真实解析，不会读取生产 Vault：

```powershell
uv run --project engine python scripts/smoke-mineru-cloud.py `
  --token-file E:\ObsidianData\OKF-Brain-State\secrets\mineru-client.token
```

此命令会实际提交云端任务并消耗服务额度。它只打印解析器、正文长度、图片数量与 QC 结果。
然后在 Dashboard 分别导入 PDF、DOCX、PPTX，检查正文、图片与重试状态。
添加 `--pipeline --file engine/tests/fixtures/documents/slides.pptx` 可在临时 fixture Vault
中执行完整的 Engine 导入与发布流程，不触及生产 Vault。

三种转换方式的验收还需覆盖默认冻结、格式拒绝、旧参数兼容、缓存隔离、等待中切换、执行锁、人工修改保护。云端、MarkItDown 和自建端点按实际启用配置分别验收，不将 mock 结果作为在线证明。

## 采集与同步恢复

- RSS 超过单批限制的条目保留在 pending 队列，同日补采、跨日排空，不因排序或多来源饥饿丢失。
- 订阅预览只抓取一次；合法空 feed 与异常返回区分；坏条目不阻塞同源其他条目，并报告降级。
- news、learning、papers、hotspot 的健康状态分别记录，不互相覆盖；保留上次成功时间。
- MinerU 云任务超时后从原 batch_id 恢复；上传与结果下载受大小和总时限限制。
- Windows 维护任务错过计划时间后补跑；恢复演练使用 monorepo 的 engine 可执行文件。

- `dashboard/tests/synced-intake.test.ts`：字节先于申请、重复导入、改动保护及旧设备上传恢复。
- `dashboard/tests/vault-original-open.test.ts`：Source 来源链与原生 Obsidian 打开，无外部读取依赖。
- `engine/tests/integration/test_vault_original_migration.py`：迁移可重复执行，保留旧数据、正文和身份。
- `tests/e2e/test_synced_mobile_import.py`：实际 TypeScript 保存 → Python 接收转换 → 回传。
- `tests/e2e/test_remote_original_import.py`：实际旧版离线上传 → 新版本机恢复 → 全量同步导入，全程不启动文件服务。

## 界面命名与文案

面向用户的名称与内部标识分离。适用于工作台、Claudian、系统视图、模板及操作说明。

### 产品与导航

- 工作台插件展示名为“工作台”，助手插件展示名为“Claudian”。上游项目与技术来源放在关于页。
- 页面使用“今天、待处理、订阅阅读、学习、项目、知识库、生活、系统状态”。
- 内部插件 ID、命令 ID、路径、YAML 类型、API 值和区域标记保持英文协议值。
- 侧栏注册标题属于 Obsidian 持久化键；更改可见提示时保留原注册标识。

### 术语

| 内部值 | 展示名称 |
|---|---|
| Capture | 随手记录 |
| Course / Lesson | 课程 / 课堂笔记 |
| Study Guide | 学习笔记 |
| study-material | 辅助学习材料 |
| Source / Source Text | 资料（来源信息）/ 资料正文 |
| Original | 原文件 |
| Wiki / Wiki Map | 知识笔记 / 知识导航 |
| Daily / Reflection / Review | 日记 / 反思 / 复盘 |
| Decision | 项目决策 |
| Feed / Digest | 订阅 / 本期汇总 |

### 动作与状态

- 按钮说明动作及去向，通知说明已经发生的结果。会移动文件的操作不能只叫“标记”。
- 订阅选择与生成进度分别表达：已选择学习不代表已学习，已请求生成不代表已生成。
- 生成状态区分排队、生成中、完成、失败、中断、取消及未确认。
- 只有用户明确确认后才记录学习完成；打开笔记不代表核验来源。
- 资料正文可能来自转换或订阅摘要，不能一概承诺为完整原文。
- 工作台便签、快速记录、记到今日日记分别说明实际保存位置。
- 保存指写入笔记库；发布仅用于真正的对外发布。

### 技术信息与翻译

- 日常界面解释结果和下一步；连接设置与高级诊断保留必要的工具名、路径和错误细节。
- 普通按钮不展示组件 ID、内部类型或开发阶段。权限文案必须说明实际访问范围。
- Claudian 可见字符串使用 i18n，包含工具提示、无障碍标签、弹窗和异步通知；其他语言缺失时回退英文。
- 系统模板标题与程序定位存在依赖时一起核对；不批量改写用户已有笔记。

## 文档维护

主文档只有根 README 与本索引列出的七份指南。`docs/README.md` 只维护导航，不复制规范正文。一个事实只设一个维护位置，其他文档链接到对应章节。

- 模块、依赖与写入归属更新 `architecture/README.md`；字段与正文模型更新 `DATA-MODEL.md`，实际 Contract 始终优先。
- 日常操作更新 `USER-GUIDE.md`；安装、凭据、同步、迁移和恢复更新 `DEPLOYMENT.md`；协议更新 `INTERFACES.md`。
- 组件源码、专用配置、上游版本和补丁说明留在组件旁边。不要修改 vendored 上游 README 来承担仓库级导航。
- 当前计划只记录仍需推进或待确认的事项；完成记录写入验收台账、发布记录或 Git 历史。已结束的提案、访谈、旧路线图和升级过程放进 `docs/archive/`，注明日期与现行入口。
- Vault Contracts、模板、Policies 和 Skills 是可部署资源，继续独立维护，不并入 README。
- 移动或合并文件时同时更新相对链接、章节锚点和命令；不积累重复正文和兼容跳转文件。

缓存、依赖、构建输出和本地任务资料由 Git 忽略。清理 `.context/` 或工作目录前检查 Git worktree、未提交内容和仍使用的恢复资料。

### 架构可视化

交互入口是 `docs/architecture/visualizations/index.html`，默认展示信息流分支树；
`overview.svg` 用于首页静态预览。两个文件由标准库生成器构建，可离线打开，不引入业务运行依赖。

图形定义只有一个维护位置：`scripts/docs/sources/architecture.json` 保存六个架构视图、
核对日期与参考提交，`information-flow.txt` 保存八类信息分支；共有的用途和生成步骤由
`scripts/docs/build_architecture.py` 在每条路径下展开。`scripts/docs/viewer.html` 是页面模板。
生成的 HTML/SVG 不手工编辑，也不替代架构规范或 Contracts。

在仓库根目录执行：

```powershell
python scripts/docs/build_architecture.py
python scripts/docs/build_architecture.py --check
uv run --project engine pytest scripts/docs/test_build_architecture.py
```

生成器检查节点标识、边的端点、树形结构、仓库内证据路径和文档锚点；`--check` 还检查
产物是否与当前定义一致，且不写文件。页面指纹覆盖图形源、生成器、模板及被引用的文件，
用于识别变更，不代表所有实现都经过自动语义审计。参考提交是核对基线，不是部署版本。

涉及信息流或模块边界的变更，先更新规范与相关实现，再核对图形定义、调整核对日期/基线并
重新生成。验证搜索、场景筛选、展开收起、节点证据、七个视图、SVG 导出和窄屏显示。
