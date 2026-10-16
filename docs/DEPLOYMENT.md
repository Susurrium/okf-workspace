# 部署与运维

[文档入口](../README.md#文档入口) · [开发准备](DEVELOPMENT.md) · [日常使用](USER-GUIDE.md)

按需阅读：[正式启用与升级](#production-cutover) · [安装](#install) · [测试环境恢复](#test-environment) · [转换服务](#conversion) · [同步与备份](#sync-backup) · [插件更新](#plugin-deployment) · [环境退役](#environment-retirement) · [卸载](#uninstall)。

<a id="production-cutover"></a>

## 正式启用与升级

正式操作需要用户对目标环境及操作范围的授权，开发验收通过不自动授权部署。
先完成[开发验收](DEVELOPMENT.md)，固定发布提交与产物，核对实际运行文件。
安装器默认路径、历史验收措辞和旧同步数据库不能代替用户对正式目标的指定。

### 首次启用

1. **固定发布版本。** 完成根检查、构建与一次当前版本的短实机验收，核对 `release-manifest.yaml` 和组件版本。保留同一提交的 Engine 包、两套插件成品及发布记录；后续修复重新生成版本与验收证据。
2. **准备独立运行程序。** 使用下文的正式版本包安装；Engine、插件、Skills、计划任务与部署回执来自同一版本包。源码安装仅用于开发，运行副本不混入未提交改动。
3. **初始化正式数据。** 使用新 Vault 和新 State，部署当前 Contracts、模板、Policies、Skills 与插件。配置新的本地 API token，并按需配置外部转换/AI 凭据和 Feed 来源。只迁入用户明确选择的笔记、原件和插件数据，不整体复制测试 State、会话或旧同步设置。
4. **启用独立同步。** 多设备使用时为正式 Vault 创建独立 CouchDB 数据库与专用账户，从一台设备开始接入，再逐台接入其他设备。现有服务器可复用，测试数据库保持隔离。服务器已有 Tailscale Serve 时先核对现有路由；`deploy/server/compose.yml` 是 CouchDB + Caddy 部署方案，不能直接套用为现有 Tailscale 部署的现场配置。
5. **完成上线验收。** 验证 Obsidian 重启、Engine 生命周期、原件保存与打开、明确转换、AI 生成和检索。多设备验收覆盖离线保存、乱序同步、重复申请、回执及目标移动设备的实际原件查看。用户已确认完成的 LiveSync/CouchDB 与平板验收可以沿用，无需逐项重复；新建立的本地加密备份仍需验证恢复。需要 CouchDB 恢复证据时，归档哈希或压缩包可读性检查不能替代数据库恢复。之后记录新部署回执。
6. **处理历史环境。** 核对计划任务指向正式 State，按[环境退役](#environment-retirement)处理不再使用的环境，保留固定测试环境供后续开发。

### 已有环境升级与回退

使用已验收版本包的完整安装器，显式指定原 Vault、State 和兼容 Originals 路径；
保留用户设置及 token，切换程序与插件并生成新回执。升级前停止目标环境的写入者，
核对数据 schema、受影响文件和所需恢复依据；升级不重新初始化已有 Vault。
构建或打包改变产物哈希时，先核验差异并补做受影响的验收，不能沿用不同产物的通过记录。

回退时重新执行保留的旧版本包安装器并复用数据路径。跨 Workspace schema 的回退先根据
相应版本说明恢复匹配数据；程序回退不能代替数据恢复。安装器会逐文件核验已安装 Engine
与 wheel，发现运行文件被修改时停止，不覆盖修改。

当前 Windows 安装器与卸载器使用同一组全局 Workspace 计划任务名称，不提供多安装实例的独立任务命名。切换时只能让指定环境持有这组后台任务；对旧 Vault 执行卸载也可能注销新环境使用的同名任务。历史数据清理应先核对所有活动路径，不能直接套用旧配置的 `-RemoveData`。

<a id="install"></a>

## Windows 安装

### 正式版本包

在开发仓库完成根检查后构建并打包：

```powershell
.\scripts\package-workspace-deployment.ps1
```

输出为 `dist/workspace/<版本>-<清单哈希>/`、同名 ZIP 与 ZIP 的 SHA-256 文件。版本包只包含 Engine wheel、两组带哈希的依赖锁文件、两套插件成品与安装运维脚本；不包含开发源码、Node 依赖、Vault、运行状态或凭据。

解压到临时目录，进入包目录执行：

```powershell
.\deploy\windows\install.ps1 `
  -ProgramRoot 'D:\OKF-Workspace' `
  -Vault 'E:\ObsidianData\OKF' `
  -State 'E:\ObsidianData\OKF-State' `
  -Originals 'E:\ObsidianData\OKF-Legacy-Originals'
```

安装器先校验包文件，再将程序部署到 `<ProgramRoot>/releases/<版本>-<清单哈希>/`。安装时需要 uv、Python 3.12 和依赖下载能力；不需要 Node/npm 或源码检出。日常 Engine 运行不需要 uv；Claudian 仍使用独立安装并已登录的 Codex CLI。初始化、迁移与 Skills 安装使用 wheel 内的 Workspace 资源。

程序目录迁移使用保留的版本包、新的 `-ProgramRoot` 和原 Vault／State／兼容 Originals 路径重新安装，
并显式传入新位置的 `-ResticExecutable`。先暂停正式计划任务并退出 Obsidian，再执行切换；
安装器重建新目录的 Python 环境并更新插件、任务和回执。不要直接移动 `.venv`：
Windows CLI 启动器包含 Python 的绝对路径。确认新位置运行及备份正常后，再处理旧程序副本。

已有部署的切换与恢复要求见[升级与回退](#已有环境升级与回退)。

<a id="test-environment"></a>

### 固定测试环境的建立与恢复

固定环境路径及日常更新命令统一维护在[开发指南](DEVELOPMENT.md#正式发布后的继续开发)。
源码安装、更新和启停入口都要求部署配置与测试标识已经存在；当前没有自动创建全新固定测试
环境的一键入口。首次建立须作为明确的初始化与登记任务，准备独立数据目录、部署配置、
同一安装身份的归属标记和 `config/test-environment.json`，验证后再使用源码入口。

恢复已有环境时先停止写入并保留现状，从经核验的备份恢复缺失配置。测试标识的
`installation_id`、`vault`、`state`、`api_port` 必须与原登记记录、部署配置及目录归属一致，
`environment` 为 `test`，端口与正式环境隔离。仅标识文件丢失时也依据这些原始证据恢复；
身份无法确认就停止恢复，不临时生成新身份或复制正式配置使检查通过。

### 开发源码安装

```powershell
cd E:\code\okf-workspace
.\deploy\windows\install.ps1 `
  -Vault 'E:\ObsidianData\OKF-Test' `
  -State 'E:\ObsidianData\OKF-Test-State' `
  -Originals 'E:\ObsidianData\OKF-Test-Legacy-Originals' `
  -ApiPort 8766 -SkipScheduledTasks
```

源码安装仅用于已具有匹配 `config/test-environment.json` 的测试环境，入口拒绝正式身份、
隐式数据路径和全局计划任务注册。完整安装包含布局与数据迁移，执行前核对迁移范围和恢复依据；
日常更新使用开发指南中的 `update-test-workspace.ps1`。
安装器保留 `OKF-Brain` 系列路径作为兼容缺省；当前正式与测试操作均应显式指定目标路径，
不能从这些缺省值推断当前使用的环境。活动原件始终保存到目标 Vault 的 `sources/originals/`。

安装器会：

1. 正式包安装锁定的 Engine 依赖和 wheel，源码安装则安装三组件开发依赖并构建；
2. 初始化或同步 Engine 内的 Workspace Kit；
3. 安装 Dashboard、Claudian、Contracts 和 Skills；
4. 在 Vault 外创建本地 API token；
5. 写入 Engine、MinerU、MarkItDown 与 Codex 配置；
6. 构建全文及可选向量索引；
7. 正式安装注册两个相互独立的计划任务：02:30 的每日维护负责索引、可选备份与恢复检查；06:50 的 Feed Sync 在远端发布窗口后执行增量同步，支持错过启动后补跑和 10 分钟间隔的三次临时故障重试。测试安装传入 `-SkipScheduledTasks`，跳过注册。

每日维护同样支持错过时间后补跑、10 分钟间隔三次重试，并禁止同任务重叠运行。启用备份后先备份和检查恢复，再更新可重建的索引，避免索引故障阻止当天备份。

安装器不会创建登录常驻 API 任务。Dashboard 插件在 Obsidian 加载后启动自己持有的本地
Engine 子进程，Obsidian 退出后服务随之停止。

旧版安装参数仍保留独立 Originals 目录作为迁移来源，新文件实际写入 Vault 内。
安装开始前会先验证 Vault、旧 Originals 与 Runtime State：三者必须是绝对解析后彼此独立、
不相同也不互相嵌套的目录，且不能指向磁盘根目录或源码仓库根目录。每个受管目录都会写入
同一安装身份的 `.okf-workspace-owner.json`；这既允许三个目录位于不同磁盘或父目录，也让
卸载器只删除本次安装明确拥有的数据。

<a id="conversion"></a>

## 转换服务配置

- 默认文档导入使用 MinerU 云端；导入窗口、API 和 CLI 可选择 MarkItDown 或显式启用的自建 MinerU。
- 质量检查级别与转换方式分开；`high` 仅开启严格检查图片，不切换服务。
- 读取转换方式目录与 System 状态只检查配置，不探测或启动转换服务；自建 SSH 生命周期仅在执行时启动。
- 转换器只返回 Markdown bundle；Source/Source Text 发布由 Engine 统一完成。

默认方式、凭据和自建启用参数见下文；重试协议见[接口说明](INTERFACES.md#conversion)。

MarkItDown 源码位于 `services/markitdown/`，服务器部署资产位于
`deploy/markitdown/`。生成可传输部署包：

```powershell
.\scripts\package-markitdown-deployment.ps1
```

自建 MinerU 是可选的外部服务；本仓库只保存 `integrations/mineru/` 中的客户端约定和部署运维
资产，不复制服务运行数据。

### 格式与能力

| 方式 | 输入 | 边界 |
| --- | --- | --- |
| MinerU 云端 | PDF、DOC/DOCX、PPT/PPTX、PNG/JPG/JPEG/WebP/BMP/GIF | 默认；保留选择性 OCR；机器结果需复核 |
| MarkItDown 服务 | PDF、DOC/DOCX、PPT/PPTX | 不提供 OCR；PDF 文本优先，不提取图片；DOCX/PPTX 提取常规内嵌图片 |
| MinerU 自建 | PDF、PPT/PPTX | 配置后启用；旧 Office 路径不执行云端补充 OCR；其他格式暂不开放 |

旧 DOC/PPT 使用本机 Microsoft Office COM 生成 DOCX/PPTX 后提交，原件不变。
自建 PDF 可使用服务本身的解析能力；不能把“支持自建 MinerU”解释为所有格式、所有云能力相同。
MarkItDown PDF 的严格检查不会证明图片完整，应显示“PDF 图片完整性未验证”。
所有输入当前上限 64 MiB。实际服务可能拒绝超出其页数、存储或处理能力的输入。

### 部署字段与环境变量

配置位于 Vault 和仓库之外的 `deployment.json`。示例仅展示相关字段，需合并到完整配置：

```json
{
  "default_conversion_method": "mineru-cloud",
  "mineru_token_file": "E:/ObsidianData/OKF-Test-State/secrets/mineru-client.token",
  "mineru_model": "vlm",
  "markitdown_url": "http://127.0.0.1:18010",
  "markitdown_token_file": "E:/ObsidianData/OKF-Test-State/secrets/markitdown-client.token",
  "mineru_self_hosted_enabled": false,
  "mineru_url": "http://127.0.0.1:18000",
  "mineru_ssh_managed": true,
  "mineru_ssh_host": "bjmu-inner",
  "mineru_ssh_remote_port": 8000
}
```

自建直连使用 `mineru_self_hosted_enabled=true`、`mineru_ssh_managed=false`；
受管 SSH 使用 `mineru_ssh_managed=true` 和明确的本地回环 URL、SSH alias、远端端口。
只有实际执行这种转换才会进入原 SSH 服务生命周期。部署资产见 `integrations/mineru`，
启用前按其手册验证目标服务；旧部署记录不是当前运行状态证明。
MarkItDown 远端地址必须使用 HTTPS；其网络隔离 worker 与 Vault 发布保持独立。

Windows 安装器提供 `-DefaultConversionMethod`、`-MarkItDownUrl`、`-MarkItDownTokenFile`、
`-MinerUSelfHostedEnabled`、`-MinerUUrl`、`-MinerUSshManaged`、`-MinerUSshHost`、
`-MinerUSshRemotePort`；未显式传入的选项沿用既有部署配置。
日常入口 `scripts/deploy.ps1` 也转发这些参数，包括显式的 `$false` 和空 Token 路径。
相应环境变量为 `OKF_DEFAULT_CONVERSION_METHOD`、`OKF_MARKITDOWN_URL`、
`OKF_MARKITDOWN_TOKEN_FILE`、`OKF_MINERU_SELF_HOSTED_ENABLED`、`OKF_MINERU_URL`、
`OKF_MINERU_SSH_MANAGED`、`OKF_MINERU_SSH_HOST`、`OKF_MINERU_SSH_REMOTE_PORT`。
Token 内容始终仅存储于外部凭据文件。旧 Dashboard `documentParserPolicy` 不再限制可选方式。

### MinerU 云凭据

将 token 保存为仓库、Vault 之外的受限 UTF-8 文本文件。Windows 部署配置只保存文件路径：

```json
{
  "mineru_token_file": "E:\\ObsidianData\\OKF-Test-State\\secrets\\mineru-client.token",
  "mineru_model": "vlm"
}
```

也可通过 `OKF_MINERU_TOKEN_FILE` 和 `OKF_MINERU_MODEL` 配置 Engine。
运行 `deploy/windows/install.ps1 -MinerUTokenFile <路径>` 时，安装器会保留已有模型设置。
token 不进入仓库、Vault、Dashboard 插件设置或日志。更换 token 后更新文件并重启 Engine。

<a id="sync-backup"></a>

## LiveSync 与备份

手机文件导入使用现有 LiveSync 全量同步完整原件，无需独立原件服务。
原件保存到 Vault 的 `sources/originals/`；旧版迁移见[原件迁移](#original-migration)。

当前开发阶段不把备份作为安装前置条件，也不自动为 Vault 建立每日 Git checkpoint。
为已有正式环境启用 Restic 时，先核对本节的备份范围与恢复条件，在已验收版本包目录执行
完整安装命令并增加备份参数；以下使用前文的正式目标：

```powershell
.\deploy\windows\install.ps1 `
  -ProgramRoot 'D:\OKF-Workspace' `
  -Vault 'E:\ObsidianData\OKF' `
  -State 'E:\ObsidianData\OKF-State' `
  -Originals 'E:\ObsidianData\OKF-Legacy-Originals' `
  -EnableBackupSetup `
  -BackupRepository 'F:\Backups\OKF-Workspace'
```

Restic 未在计划任务的 PATH 中时，增加 `-ResticExecutable '绝对路径\restic.exe'`。
每日备份包含 Vault、保留的旧 Originals、正式程序文件、State 的配置和服务凭据；
排除可重建的虚拟环境、缓存和 `restic-password`。备份密码需另外保管在密码管理器或离线介质，
恢复备份时也需要它。保留策略为每日 7 份、每周 8 份、每月 12 份；按安装标识隔离，
历史 Vault 的单独归档不受正式环境的保留策略影响。

LiveSync 在单机流程稳定后单独启用。它同步包含完整原件的 Vault，不同步 Runtime State、旧 Originals 回退副本、
本地服务或源码；移动端仅阅读和编辑 Markdown 时不要求主机 Obsidian 在线。
传入 `-LiveSyncPluginSource` 时，安装器会先完整检查 `main.js`、`manifest.json`、
`styles.css` 以及 manifest id，再通过临时目录原子替换插件文件；预检失败不会改动现有插件。

安装器只启用本次安装必需的 Dashboard、Claudian，以及用户明确提供源码的 LiveSync。
Templater、QuickAdd、Dataview 等推荐社区插件如果已被用户禁用，重新安装不会擅自启用。

### 同步边界

原件位于 Vault 的 `sources/originals/`，与笔记、申请和回执一起全量同步。
每台设备保留完整原件；CouchDB 也保存原件分块。无需独立原件服务或设备缓存。
各设备单文件同步上限至少为 64 MiB，不得排除 `sources/originals/`。
旧原件服务只保留回退备份，迁移流程见 [原件全量同步](DEPLOYMENT.md#original-migration)。

LiveSync 同步生产 Vault 中的 Markdown、必要 Obsidian 配置和完整原件附件。以下内容不进入同步：

- `.git/`、`.trash/`；
- `.obsidian/plugins/okf-workspace-dashboard/data.json`（含本机路径、服务配置、界面偏好及快速记录草稿，按设备保留）；
- 大型 `sources/assets/treehole-media/`；
- 位于 Vault 外的旧 Original Store 回退副本、Runtime State、Feed cache、转换工作目录和索引；
- API token、Setup URI、CouchDB 密码、Restic 密码和模型服务 token。

安装器把建议写入 `.obsidian/okf-livesync-exclusions.json`，由用户复制到 Self-hosted LiveSync 的同步排除设置。该文件不是秘密。

### 为什么 LiveSync 不是备份

LiveSync 会同步正确编辑，也会同步误删和损坏。恢复层分三部分：

- 可选 Vault Git checkpoint：用户显式选入后，为自动化写入提供本地版本恢复；不是默认安装或备份前提；
- Windows Restic：加密增量备份包含完整原件的 Vault、正式程序、部署配置、服务凭据与保留中的旧 Original Store 回退副本；
- 服务器 Restic：备份 CouchDB 逻辑快照和服务器部署配置。

Runtime State、全文索引和向量索引不作为必须恢复对象；恢复 Markdown 后可重建。

### 恢复演练的通过条件

- 恢复目录包含至少一份 Markdown；
- 全部恢复 Markdown 可按 UTF-8 读取；
- 每个 `/sources/originals/...` Source 引用能在恢复的 Vault 找到完整文件并通过 SHA-256 校验；历史 `okf-original://sha256/...` 引用继续支持旧 Original Store 校验；
- CouchDB 测试恢复没有 `_bulk_docs` 错误，随机笔记和附件可读取；
- 验证完成后临时恢复目录被安全删除，长期报告只保留数量、时间和 snapshot ID，不保留私密正文。

<a id="original-migration"></a>

## 旧原件与移动设备迁移

1. 备份当前 Vault、State 和旧 Originals，停止 Engine 的写入任务。
2. 执行 `python -m okf_workspace.importers.vault_original_migration --vault <Vault> --originals <旧 Originals> --state <State>`。
3. 先完成所有原件的复制与哈希校验，再更新旧 `okf-original://` 引用和转换状态中的原件路径。保留未知 YAML、用户正文、转换身份和旧原件。
4. 更新 Engine、工作台程序和部署的 Vault 规则，再启动并完成 LiveSync。
5. 平板加载新版后，一次性恢复旧 IndexedDB 中未完成的上传到 Vault；只在校验本机副本与保存申请成功后释放旧上传字节。已有申请不覆盖、不重复提交；异常保留数据并提供重试。
6. 已迁移的旧协议链接仍可打开 Vault 原件。旧 `file-store` 申请只能使用迁入 Vault 的原件，不再访问旧服务。
7. 校验各旧服务 blob 都已迁入 Vault 并做好备份后，停止原件服务及其独立定时备份，移除 `/original-files` 路由。保留 CouchDB 的根路由、同步服务和现有备份。

同步不是备份。CouchDB 和包含原件的 Vault 都应保留独立备份。旧服务源码和部署资产只用于历史恢复；新安装无需部署它。

旧 `deployment.json.originals` 只保留迁移来源与安装兼容意义；活动原件全部位于 Vault。外部 State 的 `conversions/<id>/export/` 保存完整转换结果、附件清单和 QC，暂不自动过期；成功发布和回执持久化后清理 `working/`，失败任务保留临时文件。旧原件目录与旧服务备份在核验前保留，不能因为代码归档就推断数据可以删除。

<a id="server-migration"></a>

## CouchDB 服务器迁移

迁移不改变 Vault 结构，也不需要重建知识笔记：

1. 暂停所有设备的 LiveSync 自动同步；
2. 在 CLab 端生成最后一份 CouchDB 逻辑快照，并记录数据库名与 `update_seq`；
3. 对主电脑 Vault 运行 Restic backup 和 restore-test；已明确选入 Git checkpoint 时可额外创建 checkpoint；
4. 在个人服务器使用 `deploy/server/install.sh` 与 `deploy/server/compose.yml` 启动 CouchDB + Caddy；
5. 用 `couchdb_snapshot.py restore` 把快照恢复到个人服务器；
6. 查询目标数据库文档数量，抽查带附件文档；
7. 为新服务器创建专用非管理员同步账户；
8. 只在一台测试设备更新 LiveSync Remote URI/Setup URI，先执行 dry run 或拉到空测试 Vault；
9. 确认 Markdown 数量、随机笔记内容和附件后，再切换主电脑；
10. 最后切换其余设备并恢复自动同步；
11. 保留 CLab 只读至少一个备份周期，随后撤销旧凭据和 DNS；
12. 将个人服务器 CouchDB 定时快照与 Restic timer 纳入监控。

如果 CLab 无法导出逻辑快照，可以让主电脑完整同步后，以主电脑 Vault 为权威建立新远端；不要同时让新旧远端接收写入。

<a id="plugin-deployment"></a>

## 插件部署与升级回执

完整测试环境更新与启停流程见[开发指南](DEVELOPMENT.md#更新与启停)。仅更新测试插件时，
先停止测试窗口，显式指定配套目标：

```powershell
.\scripts\install-dashboard.ps1 -Vault E:\ObsidianData\OKF-Test -State E:\ObsidianData\OKF-Test-State
.\scripts\install-okf-claudian.ps1 -Vault E:\ObsidianData\OKF-Test -State E:\ObsidianData\OKF-Test-State
```

安装完成后按开发指南从测试专用 profile 启动并验收。
生产切换使用正式版本包的完整安装器，以保证 Python 路径、token
文件和 plugin settings 一致。

正式包安装完成后自动生成 State 的 `reports/deployment-receipt.json`，校验已安装 Engine
与 wheel 的内容、两插件文件与包内构建 SHA-256，并记录版本、运行目录和发布清单哈希。
源码安装或单独更新插件后运行 `scripts/record-deployment.ps1 -Config <deployment.json>`；
源码运行回执记录部署时的 Python 源码哈希和 Git 版本，之后的源码修改需要重新验收与记录。

插件安装器只管理 `okf-workspace-dashboard`、`okf-claudian` 以及历史误复制目录
`.obsidian/plugins/claudian`。官方社区插件 `realclaudian` 的启用状态和文件不会被修改；如两者
会造成界面冲突，由用户在 Obsidian 中自行决定是否停用它。

Engine Skills 部署到 `.agents/skills/`，并由 `.okf-managed-skills.json` 记录安装器所有权。
升级只替换或清理清单内的 Skill，其他用户/第三方 Skill 原样保留。首次部署若遇到同名但
尚未归 OKF 管理的目录，只有当其完整目录结构、逐文件内容和 SHA-256 与当前源码完全一致时，
才会作为旧安装器留下的副本被安全认领；任意缺失、额外文件、内容差异或链接都会在写入前
失败，要求用户先检查、改名或移走该目录，不会覆盖。

## 发布验收

执行[开发与验收](DEVELOPMENT.md)中的自动检查、合成 Vault 流程与实际启用服务的 smoke test，然后记录部署回执。Dashboard 的实机验收和生产切换证据见[组件验收台账](../dashboard/ACCEPTANCE.md)。这些要求不表示已执行当前生产部署。会导致校验失败、坏链或悬空任务的验收残留需删除、修复或重新转换。

<a id="environment-retirement"></a>

## 环境退役与归档

普通临时夹具结束测试时按[开发指南](DEVELOPMENT.md#验收证据与退出)退出，核对本次创建的
完整路径和活动引用后清理；固定测试环境继续保留。长期环境的重建或删除须有相应用户授权。
归档和删除均不使用会注销全局计划任务的卸载器代替目录处理。

需要归档时依次执行：

1. 停止目标窗口、Engine、同步和其他写入者，核对实际进程及端口已退出。
2. 清点 Vault、配套 State、profile、兼容 Originals 及必要数据库快照，记录用途、日期、
   安装身份和版本。核对路径及重解析点，保留用户修改和恢复资料。
3. 将归档保存到与活动目录、中间文件分开的明确位置；核验文件清单、逐文件哈希和归档
   可读取性。涉及数据库或应用恢复时，另做相应恢复验证。
4. 清理不再使用的 profile 登记和启动配置，检查现行工具已无活动引用；历史验收中的路径
   保留其原始含义。确认归档和授权范围后，再删除精确的退役目录。
5. 在本次验收记录中保存归档位置、清单、核验和清理结果。含用户内容或凭据的归档遵循
   原有访问保护，不进入源码仓库或公开日志；未解决故障的证据继续保留。

<a id="uninstall"></a>

## 卸载

以下示例仅在明确授权卸载指定环境后执行；填写该环境的实际部署配置路径。

```powershell
.\deploy\windows\uninstall.ps1 `
  -Config '<要卸载环境的 State>\config\deployment.json'
```

默认只移除 Workspace 计划任务、OKF Dashboard、OKF Claudian 和历史误复制的 `claudian`
目录，保留官方 `realclaudian`、用户 Skills 与全部数据。只有明确传入 `-RemoveData` 才会
删除 Vault、Originals 与 Runtime State。数据删除前会先一次性验证三个精确路径、安装身份
与 ownership marker；任意一项不匹配都会在移除任务、插件或数据之前停止。旧安装若没有
marker，先重新运行一次当前安装器完成身份迁移，再执行 `-RemoveData`。
