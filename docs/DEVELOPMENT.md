# 开发与验收

[文档入口](../README.md#文档入口) · [架构](architecture/README.md) · [部署运维](DEPLOYMENT.md)

## 开发环境

要求 Windows 11、PowerShell 7、Python 3.12、uv、Node.js 24、npm、Git、Obsidian 和已登录的 Codex CLI。
组件内遵循其版本文件及适用 AGENTS。用户数据、凭据与运行状态保存在仓库外。

```powershell
cd E:\code\okf-workspace
.\scripts\bootstrap.ps1
.\scripts\check.ps1
.\scripts\build.ps1
```

Engine/MarkItDown 各有 uv 环境，Dashboard/Claudian 各有 lockfile。根脚本统一调度，构建只生成本地产物。

## 检查与构建

先读取适用的 AGENTS，按变更范围选择检查。跨组件变更和发布候选执行根检查，补齐未覆盖的专项与实机验证。

| 范围 | 必须检查 |
| --- | --- |
| Engine | `uv run pytest <相关测试>`、`uv run ruff check src tests`、`uv run pyright` |
| Dashboard | `npm run check`、`npm test -- <相关测试>`、`npm run build` |
| Apex 源码/接入 | Dashboard 检查；Apex 受影响 `test:*`、lint、build；上游升级执行全部 `test:*` |
| Claudian | 组件 AGENTS；typecheck、lint、test、build、`check:performance`；纯文档运行文档专项及差异检查 |
| Windows 安装/控制 | 脚本解析与相关测试；身份拒绝在写入前发生，已有设置保留，进程/端口正确退出 |
| 跨组件 | `uv run --project engine pytest tests/e2e` 及 `scripts/check.ps1` |
| 文档 | `git diff --check`、链接/锚点/命令、受影响文档测试；生成资料按既定入口更新 |

根检查覆盖 Engine pytest/Ruff/Pyright、跨组件 fixture-Vault 测试及 Ruff、Dashboard 类型/测试/构建、
Claudian 类型/lint/完整测试/构建、Windows 插件身份迁移及架构生成器测试与产物一致性检查。
它不执行 Apex 专项、Claudian 性能检查、真实 Obsidian、远端服务和多设备验收。
历史 Originals 使用 `scripts/check-legacy-originals.ps1` 与独立 CI；当前原件迁移和旧设备恢复仍在默认检查中。

| 组件 | 构建与集成位置 |
| --- | --- |
| Dashboard | `src/plugin/main.ts` 为统一构建入口；`features/workbench/okf-surface-sections.ts` 挂载共享 `OkfDashboardView`，Apex 提供外框与原生组件；产物 `dist/main.js`、`dist/styles.css`，manifest 位于组件根目录 |
| Tasks | 源码和许可在 `dashboard/vendor/tasks/`，适配在 `tasks-integration/`；`npm run build:tasks` 生成忽略的 `tasks-generated/`，生成文件不手改；跨语言夹具 `tests/fixtures/tasks/task-cases.json` |
| Claudian | 开发用 `npm ci`、`npm run dev`；规则从组件 AGENTS 及其子目录读取；安装入口见部署指南 |

Claudian 可用 `npm run test:affected -- --base origin/main` 选择改动相关测试，支持 `--list`、`--full` 和转发 Jest 参数；
它覆盖已提交、暂存、未暂存与未跟踪输入，未知输入或基线不可用时保留完整覆盖，不能代替其他必需检查。
性能比较使用相同提交和测试选择，记录夹具创建/退出及原生平台能力，区分墙钟耗时、套件累计耗时与 runner 用量。

## 正式发布后的继续开发

源码、正式程序、测试数据分别维护。正式部署使用[已验收版本包](DEPLOYMENT.md#install)，普通开发使用固定测试环境。
变更流程：相关自动检查 → 停止测试写入者 → 更新受管资源/程序 → 核对身份与哈希 → 受影响实机验收 → 记录并退出。
保留任务无关的用户修改，完整安装和数据迁移分别核对范围。

### 固定测试环境

| 项目 | 固定值/要求 |
| --- | --- |
| Vault / State | `E:\ObsidianData\OKF-Test` / `E:\ObsidianData\OKF-Test-State` |
| Obsidian profile | State 下 `obsidian-profile`，只登记 OKF-Test；同一 Vault 同时只有一个 profile 写入 |
| API / CDP | `8766` / `9366`，与正式环境隔离 |
| 同步 | 独立 `okf-test` 数据库、专用账户和凭据；默认关闭 LiveSync 与 Engine 自动启动 |
| 身份 | `config/test-environment.json` 的 `environment: test`、安装标识、Vault、State、端口与部署配置、目录归属一致 |

保留既有测试笔记与人工检查记录。首次建立或恢复按[部署指南](DEPLOYMENT.md#test-environment)执行，更新入口不初始化空环境。
源码完整安装必须显式指定测试目标并传 `-SkipScheduledTasks`。

### 更新与启停

```powershell
.\scripts\test-workspace.ps1 -Action Stop
.\scripts\update-test-workspace.ps1 -Vault E:\ObsidianData\OKF-Test -State E:\ObsidianData\OKF-Test-State
.\scripts\test-workspace.ps1 -Action Start
.\scripts\test-workspace.ps1 -Action Stop
.\scripts\test-workspace.ps1 -Action Status
```

Start 核对 profile、Vault 和 Engine 指纹；只有同步开发才使用 `Start -EnableSync`。
更新在停机与身份检查后同步 Engine 依赖、受管资源、Skills、插件、索引及 Contracts，生成构建和部署回执。
[资源同步](INTERFACES.md#workspace-resources)保留业务笔记及已有交互模板；数据格式升级需明确备份和迁移范围。
单独插件更新见[安装入口](DEPLOYMENT.md#plugin-deployment)。更新中断后先检查实际文件与日志，再完成剩余验证。
测试共享服务器时只停测试客户端；CouchDB 版本/服务器配置实验使用独立容器。

## 验收要求

使用按当前 Contracts 创建的合成资料。mock 只验证明确的隔离行为；外部服务、原生文件和跨进程语义具备条件时必须真实验证。
下表定义验收条件，详细用例由当前测试和实际流程核对；通过结果记录在具名回执中。

| 变更领域 | 自动化与实机必须覆盖的边界 |
| --- | --- |
| 格式/身份 | 合法 YAML、未知字段与正文保留；真实 Apex 序列化器和本地预设；Unicode 路径、旧/未来 schema、身份冲突、异常 YAML；迁移逐字节保留工作台和异常文件 |
| 来源/导入 | 先存原件再写申请、乱序同步、哈希核验、URL/文件去重、首次渠道与身份保留；默认只存原件，明确转换时冻结方式；多上下文用途和人工修改保留 |
| 转换/恢复 | 三种方式的格式拒绝、旧参数、缓存隔离、执行锁、等待时换方式；云任务按原 batch 恢复，上传/下载大小及总时限；READY/export/发布回执各中断点恢复，成功与失败分别保留可用结果 |
| 语义任务 | 生成、完成学习、知识整理分开；同请求多线程幂等，双关联传播；取消/重试/孤立状态恢复；发布前校验与并发保护，已完成结果不重复生成；不推断 `studied_at` |
| 检索/文件 | 候选定位后真实读取，范围与显式附件正确，向量不可用时按既定方式检索；工作台和备份不进入默认索引/任务投影；Windows drive/UNC/ADS/device 拒绝，跨进程创建唯一，真实硬链接/并发断言保留 |
| 业务视图 | 测试实际 `OkfDashboardView`；完整动作、分页、独立页面、持久/临时范围及取消范围、双关联与数量语义；Today 三源独立最新期次，Reading 来源历史与 papers；失败保持 last-good 并明确标记 |
| 交互/写入 | 搜索、筛选、details、焦点、滚动保留；只调整布局保留业务/Capture 节点；保存失败保留输入、重试复用已写目标；异步关闭/返回不触发迟到写入；原生编辑离线可用，多 pane 操作取所属文件 |
| Tasks/清单 | 全局查询、格式、状态、日期/循环/依赖/提醒与来源定位；同任务各入口共享身份；工作台清单操作限于所属工作台；Project 任务及关联跳转使用真实对象 |
| Claudian | 公开 `okfBridge v1`、附件可见/可移除、read/write/plan/Skill、提示模式与新会话；目标 Codex，无意外 Claude 依赖；关闭助手后其他功能可用，架构边界与构建检查通过 |
| Feed/同步 | pending 跨批排空与来源公平性；预览只抓一次，合法空与失败区分；四 stream 独立健康/游标；真实旧设备上传恢复；维护任务错过后补跑，恢复演练使用本仓库 Engine |
| 安装/退出 | 目标身份在写入前核对，候选与安装哈希一致；测试与正式路径/profile/凭据/端口隔离；恢复原有文件，清理合成内容、索引及临时资源，关闭本次写入者 |

相关导入恢复用例集中在 `dashboard/tests/synced-intake.test.ts`、`vault-original-open.test.ts`、
`engine/tests/integration/test_vault_original_migration.py`、`tests/e2e/test_synced_mobile_import.py` 与 `test_remote_original_import.py`。

## 合成 Vault 完整流程

常规实机使用固定 OKF-Test；只有干净初始化、迁移或恢复确需独立状态时才创建短期夹具：

```powershell
.\scripts\new-test-fixture.ps1 -Name clean-install -Purpose '干净初始化验收' -ExpiresAt ([DateTimeOffset]::Now.AddDays(1))
```

夹具位于忽略的 `work/fixtures/<名称>/`，记录用途、来源提交、期限和初始状态；不自动登记 Obsidian 或接入同步，
到期不自动退出/删除。未提交源码和实际构建哈希写入回执，任务负责退出、清理或记录延期理由。
正式 Vault/State 和 `E:\ObsidianData` 不用于新建临时夹具，归档遵循[环境退役](DEPLOYMENT.md#environment-retirement)。

完整流程依次验证：更新与身份 → 无归属/Course/Project Capture → 保存原件及明确转换 PDF/DOCX/PPTX →
Web Clip/Feed 相同 URL 去重 → 独立/课程/项目学习材料 → 更新、明确完成、Wiki/Map → 项目日志/决策/Daily →
新会话检索并记录读取 → 全部界面动作与原生跳转 → validator/doctor，无新增坏链、重复来源或悬空任务。

## 实机与外部服务验收

完整发布候选覆盖实际启用能力：MinerU 云 API 转换带图 DOCX 并核对 ZIP/图片；Dashboard 分别导入 PDF/DOCX/PPTX；
可见 Codex 与后台生成各一次；Today 三源各一条，Reading 至少两来源并加载两期、处理一条；
Obsidian 冷启动、服务生命周期及 Windows 无遗留 worker/额外终端。真实鼠标键盘、失败和视觉检查按改动选取。

```powershell
uv run --project engine python scripts/smoke-mineru-cloud.py --token-file E:\ObsidianData\OKF-Test-State\secrets\mineru-client.token
```

该命令提交真实云任务并消耗额度，仅输出必要结果。加 `--pipeline --file engine/tests/fixtures/documents/slides.pptx`
可在临时 fixture 中验证发布流程。云端、MarkItDown、自建服务分别验证，mock 不代替在线结果。
LiveSync、多设备和备份按实际启用范围单独验收，单机开发不强制启用它们；未受影响的既有证据可明确引用。

## 验收证据与退出

记录源码提交/未提交状态、组件版本、环境身份、构建/安装哈希、场景、结果与证据位置。
源码或产物变化后重验受影响部分，自动化、实机、视觉、外部服务和多设备分别记录，保留失败日志。
同版本号不能代替源码/产物身份；完整源码运行回执记录部署时 Python 哈希。

结束执行 Stop 后 Status，核对 `vault_open`、`api_listening`、`engine_autostart`、`livesync_enabled` 均为 false，
CDP 9366 无监听，profile 无其他 Vault。手动进程由本次任务退出；失败时报告残留，保留诊断，不终止正式实例或共享服务。
回执还应记录原文件恢复、合成文件/索引清理及临时资源退出结果，长期证据按部署指南归档。

## 界面命名与文案

展示名称为“工作台”和“Claudian”；内部 ID、命令、YAML、路径和侧栏持久化键保持协议原值。
分区名称见使用指南。Capture 展示为“随手记录”，“快速记录”是入口；Study Guide 展示为“学习笔记”，
study-material 为“辅助学习材料”；Source/Source Text 为“资料/资料正文”，Wiki/Map 为“知识笔记/知识导航”，Original 为“原文件”。

按钮说明动作与去向，通知说明实际结果，移动文件必须明确说明；生成、完成、核验、保存与对外发布分别命名。
区分排队、生成中、完成、失败、中断、取消和未确认。日常界面隐藏无关实现细节，高级诊断保留必要路径与错误。
Claudian 文案使用 i18n，缺失翻译回退英文；系统模板标题改变时核对程序定位，保留用户已有内容。

## 文档维护

根 README 只提供五份主指南和必要维护入口。一个事实只维护一个正文：日常操作在使用指南，
开发/验收要求在本文，安装配置在部署指南，模块/数据归属在架构，公开协议在接口，精确 Artifact 格式在 Contracts。
组件仅保留独有配置、上游边界、包必需说明与结果台账。模板、Policies、Skills 和 AGENTS 是独立部署/开发资源。

历史过程通过 `git log --all -- <路径>` 与 `git show <提交>:<路径>` 查阅，台账保留必要版本/证据索引。
删除或合并文档时核对引用、锚点、打包及文档测试依赖；生成文件按工具更新，原始失败、恢复资料与用户修改保留。
清理工作目录前核对 worktree、未提交内容和活动恢复引用。

### 架构可视化

`scripts/docs/sources/architecture.json` 和 `information-flow.txt` 维护图形来源，`viewer.html` 是模板。
生成的 `docs/architecture/visualizations/index.html` 和 `overview.svg` 可离线查看，精确规则仍以架构/Contracts 为准。

```powershell
python scripts/docs/build_architecture.py
python scripts/docs/build_architecture.py --check
uv run --project engine pytest scripts/docs/test_build_architecture.py
```

来源变动后核对日期/参考提交并重新生成。检查节点、关系、仓库证据与锚点；`--check` 比较产物和定义且不写文件。
图形指纹标识引用变化，不能代替语义验收；界面变动时验证搜索、场景筛选、展开/收起、节点证据、七视图、SVG 导出与窄屏。
