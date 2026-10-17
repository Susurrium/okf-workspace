# 部署与运维

[文档入口](../README.md#文档入口) · [开发验收](DEVELOPMENT.md) · [接口](INTERFACES.md)

<a id="production-cutover"></a>

## 正式启用与升级

正式操作须有覆盖目标和影响范围的用户授权。固定已验收提交、发布清单、Engine 包和两套插件，
核对实际运行文件与回执；历史验收和安装器默认路径不代表当前正式目标。

首次启用顺序：明确独立程序/Vault/State → 安装版本包并初始化当前资源 → 配置本机凭据和所需外部服务 →
逐台接入独立同步 → 上线验收 → 记录回执 → 按退役流程处理旧环境。
仅迁入用户选择的笔记、原件及插件数据，保留测试环境；测试 State、会话和旧同步设置不整体复制。

上线验证 Obsidian 重启、Engine 生命周期、原件保存/打开、明确转换、AI 与检索。
多设备范围覆盖离线保存、乱序同步、重复申请/回执和目标设备真实原件查看；未变化且用户已确认的同步/平板证据可引用。
新建备份须实际恢复验证，CouchDB 归档哈希或可读性不能代替数据库恢复。

### 已有环境升级与回退

先停止目标写入者，备份受影响数据并核对 schema；用已验收版本包显式指定原 Vault、State、兼容 Originals，
切换程序/插件，保留设置与 token，不重新初始化 Vault。产物哈希变化时补做对应验收。
回退重新执行保留的旧包安装器；跨 schema 时先恢复匹配数据。安装器发现 Engine 运行文件与 wheel 不一致会停止，保留人工修改。

Windows 计划任务使用全局同名任务，仅允许指定环境持有；旧 Vault 卸载也可能注销新环境任务。
处理旧数据前核对全部活动路径，避免直接套用旧配置的 `-RemoveData`。

<a id="install"></a>

## Windows 安装

### 正式版本包

完成开发验收后在仓库运行 `scripts/package-workspace-deployment.ps1`。
`dist/workspace/<版本>-<清单哈希>/` 及同名 ZIP/SHA-256 包含 wheel、带哈希的依赖锁、插件成品和运维脚本，
不包含源码、Node 依赖、Vault、State 或凭据。核验后解压，在包目录执行：

```powershell
.\deploy\windows\install.ps1 `
  -ProgramRoot 'D:\OKF-Workspace' `
  -Vault 'E:\ObsidianData\OKF' `
  -State 'E:\ObsidianData\OKF-State' `
  -Originals 'E:\ObsidianData\OKF-Legacy-Originals'
```

程序安装到 `<ProgramRoot>/releases/<版本>-<清单哈希>/`。安装需 uv、Python 3.12 和下载依赖的能力，
运行无需 uv；Claudian 使用独立安装并登录的 Codex CLI。
安装器验证 Vault、State、旧 Originals 为独立、不嵌套的绝对目录，拒绝磁盘/源码根，并写同一安装身份的归属标记。
`OKF-Brain` 系列兼容缺省值不作为实际环境依据。活动原件保存在 Vault 的 `sources/originals/`。

安装器同步资源、插件、Skills、配置和索引，在 State 外部凭据位置建立本地 token，生成部署回执。
正式安装注册每日维护 02:30、Feed Sync 06:50 两项任务；错过时补跑，暂时失败间隔 10 分钟重试三次，禁止重叠。
启用备份后先备份与恢复检查，再更新索引。API 由 Dashboard 持有并随宿主退出，无登录常驻任务。

迁移程序目录使用旧版本包、新 `-ProgramRoot`、原数据路径和新 `-ResticExecutable` 重新安装：
先暂停正式任务并退出 Obsidian，核对新位置运行和备份后处理旧目录。`.venv` 含绝对路径，不直接移动。

<a id="test-environment"></a>

### 固定测试环境的建立与恢复

路径和日常更新见[开发指南](DEVELOPMENT.md#固定测试环境)。当前入口要求已有部署配置和测试标识；
首次建立是单独的初始化/登记任务，需要独立目录、同一安装身份的归属标记、部署配置及 `config/test-environment.json`。

恢复时先停止写入并保留现状，从核验备份恢复配置。标识的 `environment: test`、安装 ID、Vault、State、API 端口
须与原登记、部署配置和目录归属一致。身份不明时停止，不复制正式配置或临时生成身份绕过校验。

### 开发源码安装

```powershell
.\deploy\windows\install.ps1 `
  -Vault 'E:\ObsidianData\OKF-Test' `
  -State 'E:\ObsidianData\OKF-Test-State' `
  -Originals 'E:\ObsidianData\OKF-Test-Legacy-Originals' `
  -ApiPort 8766 -SkipScheduledTasks
```

源码入口只接受匹配测试身份，拒绝隐式数据路径和全局任务注册。完整安装包含迁移，先核对其范围和恢复依据；
日常更新使用开发指南的统一更新器。单独插件安装见下节。

<a id="plugin-deployment"></a>

## 插件部署与升级回执

仅更新测试插件时先停止测试窗口，再执行：

```powershell
.\scripts\install-dashboard.ps1 -Vault E:\ObsidianData\OKF-Test -State E:\ObsidianData\OKF-Test-State
.\scripts\install-okf-claudian.ps1 -Vault E:\ObsidianData\OKF-Test -State E:\ObsidianData\OKF-Test-State
```

正式切换使用完整版本包。正式包安装生成 `reports/deployment-receipt.json`，核验 Engine/wheel、插件哈希、版本及发布清单。
源码或单独插件安装后使用 `scripts/record-deployment.ps1 -Config <deployment.json>`，记录部署时源码哈希及 Git 状态。

安装器管理 `okf-workspace-dashboard`、`okf-claudian` 和历史误复制的 `claudian`，保留官方 `realclaudian`、
用户禁用的社区插件及设备设置。提供 LiveSync 源码时先检查三个程序文件和 manifest ID，再原子替换，预检失败保留现状。

Skills 安装在 `.agents/skills/`，所有权由 `.okf-managed-skills.json` 定义；升级仅处理受管项。
首次认领同名旧副本要求完整目录结构、逐文件内容和哈希全部一致，额外/缺失文件、链接或差异均在写入前报错，保留用户/第三方内容。

<a id="conversion"></a>

## 转换服务配置

默认 MinerU 云端，MarkItDown 和显式启用的自建 MinerU 可选。转换器只返回结果，Engine 校验/QC 后发布。
`high` 表示严格图片检查；读取转换目录/System 仅查配置，实际执行才连接或启动外部服务。

| 方式 | 输入与能力 |
| --- | --- |
| MinerU 云端 | PDF、DOC/DOCX、PPT/PPTX、PNG/JPG/JPEG/WebP/BMP/GIF；选择性 OCR |
| MarkItDown | PDF、DOC/DOCX、PPT/PPTX；无 OCR，PDF 不提取图片，DOCX/PPTX 提取常规内嵌位图 |
| MinerU 自建 | PDF、PPT/PPTX；使用本身解析能力，旧 Office 路径不做云端补充 OCR |

旧 DOC/PPT 由 Windows Office COM 生成派生 DOCX/PPTX，保留原件；单文件上限 64 MiB，仍受实际服务限制。
MarkItDown PDF 严格检查显示图片完整性未验证。格式和重试协议见[接口](INTERFACES.md#conversion)。

配置写入 Vault 外的完整 `deployment.json`，相关字段示例：

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

自建直连设置 `mineru_self_hosted_enabled=true`、`mineru_ssh_managed=false`；受管 SSH 还需明确回环 URL、alias 和远端端口。
MarkItDown 远程地址使用 HTTPS。Token 是仓库/Vault 外的受限 UTF-8 文件，设置只存路径，变更后重启 Engine。

安装器和 `scripts/deploy.ps1` 转发 `-DefaultConversionMethod`、`-MarkItDownUrl`、`-MarkItDownTokenFile`、
`-MinerUSelfHostedEnabled`、`-MinerUUrl`、`-MinerUSshManaged`、`-MinerUSshHost`、`-MinerUSshRemotePort`；
未指定时沿用配置，显式 `$false` 和空 Token 路径也会传递。`-MinerUTokenFile` 保留已有模型设置。
对应环境变量为 `OKF_DEFAULT_CONVERSION_METHOD`、`OKF_MARKITDOWN_URL`、`OKF_MARKITDOWN_TOKEN_FILE`、
`OKF_MINERU_TOKEN_FILE`、`OKF_MINERU_MODEL`、`OKF_MINERU_SELF_HOSTED_ENABLED`、`OKF_MINERU_URL`、
`OKF_MINERU_SSH_MANAGED`、`OKF_MINERU_SSH_HOST`、`OKF_MINERU_SSH_REMOTE_PORT`。旧 `documentParserPolicy` 不限制可选方式。

服务端操作分别见 [MarkItDown 手册](../deploy/markitdown/README.md)、[MinerU 手册](../integrations/mineru/README.md)。
MarkItDown 部署包由 `scripts/package-markitdown-deployment.ps1` 生成。

<a id="sync-backup"></a>

## LiveSync 与备份

正式与测试数据库、账户、State、凭据分别隔离。每台设备保留完整 Vault 原件，同步上限至少 64 MiB，
保留 `sources/originals/`。同步对象包括笔记、原件、申请/回执和必要 Obsidian 配置；以下排除：

- `.git/`、`.trash/`、大型 `sources/assets/treehole-media/`；
- `.obsidian/plugins/okf-workspace-dashboard/data.json`：本机路径、服务配置、界面偏好和快速记录草稿；
- Vault 外 State、Feed cache、转换目录、索引、旧 Originals 回退副本与源码；
- API/模型 token、Setup URI、CouchDB/Restic 密码。

安装器生成 `.obsidian/okf-livesync-exclusions.json` 建议，由用户复制到 LiveSync 排除设置。
程序升级只同步插件文件，设备自己的设置和凭据保留。现有 Tailscale 路由先核对；
`deploy/server/compose.yml` 的 CouchDB+Caddy 配置不能直接当作现有 Serve 现场配置。

### 备份与恢复

LiveSync 同时传播误删和损坏。备份分别使用可选本地 Git checkpoint、Windows Restic、服务器 CouchDB 逻辑快照与 Restic。
开发默认不启用 checkpoint 或备份；启用 Restic 时在正式完整安装命令中增加：

```powershell
-EnableBackupSetup -BackupRepository 'F:\Backups\OKF-Workspace'
```

Restic 不在计划任务 PATH 时指定 `-ResticExecutable`。备份覆盖 Vault、保留旧 Originals、正式程序、State 配置和服务凭据，
排除可重建虚拟环境/缓存及 `restic-password`；密码另外保存。策略每日 7、每周 8、每月 12 份，按安装身份隔离，独立历史归档不受影响。
全文和向量索引可在恢复 Markdown 后重建；部署配置与凭据按备份范围恢复。

恢复演练必须得到可读 UTF-8 Markdown，全部原件引用可定位且 SHA-256 一致，历史原件链接可校验旧存储。
CouchDB 恢复无 `_bulk_docs` 错误，抽查笔记和附件可读。结束后安全清理临时恢复目录，报告仅留数量、时间与 snapshot ID。

<a id="original-migration"></a>

## 旧原件与移动设备迁移

1. 备份 Vault、State、旧 Originals，停止目标 Engine 写入。
2. 执行 `python -m okf_workspace.importers.vault_original_migration --vault <Vault> --originals <旧 Originals> --state <State>`。
3. 先复制全部原件并核验哈希，再更新旧链接/转换路径，保留正文、未知字段、转换身份和旧原件。
4. 更新 Engine、插件和 Vault 资源，再启动同步。移动端只有核验已保存字节和申请后才释放旧 IndexedDB 上传，失败保留数据并重试。
5. 核验旧链接可打开 Vault 原件，旧 file-store 申请使用迁入的原件；全部 blob 已迁入且具备备份后，再停旧服务/备份和 `/original-files` 路由，保留 CouchDB 根路由、同步及备份。

旧 Originals 字段仅作迁移/安装兼容。State 的 `conversions/<id>/export/` 保留完整结果/QC，暂不自动过期；
成功发布和回执持久化后清理 working，失败保留。未完成核验前保留旧目录与旧服务备份。

<a id="server-migration"></a>

## CouchDB 服务器迁移

依次暂停全部设备同步 → 导出最终逻辑快照并记录数据库/update_seq → 本机 Vault 备份及恢复测试 →
新服务器 `deploy/server/install.sh`/compose → `couchdb_snapshot.py restore` → 核对文档和附件 → 建专用非管理员账户 →
测试设备 dry run 或空 Vault 拉取 → 主机/其他设备逐台切换 → 恢复同步。
旧端保持只读至少一个备份周期，再撤销凭据和 DNS；新端快照/Restic timer 纳入监控。
无远端快照时先完整同步主机，再从主机重建新远端；新旧远端不同时接收写入。

## 发布验收

按[开发指南](DEVELOPMENT.md)完成适用自动化、合成资料、实机与外部服务验证，记录实际部署回执。
[Dashboard 台账](../dashboard/ACCEPTANCE.md)提供历史证据入口；验收要求不表示当前部署已执行。
修复或清除造成坏链、悬空任务和校验失败的合成残留。

<a id="environment-retirement"></a>

## 环境退役与归档

固定测试环境继续保留。长期环境重建/删除需授权；短期夹具按[退出要求](DEVELOPMENT.md#验收证据与退出)处理。

1. 停止窗口、Engine、同步与其他写入者，核验进程/端口退出。
2. 清点精确 Vault/State/profile/兼容 Originals 与数据库快照，记录身份、日期、版本、路径及重解析点，保留人工修改和恢复资料。
3. 归档到活动目录/中间文件之外，核验清单、逐文件哈希与可读性；数据库/应用另做恢复验证。
4. 清除活动 profile/启动引用，确认归档与授权后删除精确目录；历史证据中的原路径保留原义。
5. 记录归档、核验和清理结果，隐私与凭据保持访问保护，未解决故障资料继续保留。

目录处理不通过会注销全局任务的卸载器执行。

<a id="uninstall"></a>

## 卸载

明确授权后，对实际目标配置执行 `deploy/windows/uninstall.ps1 -Config '<State>\config\deployment.json'`。
默认移除全局 Workspace 任务及受管插件，保留官方 `realclaudian`、用户 Skills 和数据。
`-RemoveData` 才删除 Vault/Originals/State；在任何移除前验证三个精确路径、安装身份和 ownership marker，任一不符即停止。
旧安装缺 marker 时先通过当前安装器完成身份迁移，再执行数据删除。
