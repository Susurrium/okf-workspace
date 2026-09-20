# OKF Workspace 部署

## 1. 本地开发准备

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

## 2. Windows 单机安装

```powershell
cd E:\code\okf-workspace
.\deploy\windows\install.ps1 `
  -MarkItDownUrl 'https://your-markitdown.example' `
  -MarkItDownTokenFile 'E:\ObsidianData\OKF-Brain-State\secrets\markitdown-client.token'
```

默认数据路径仍与当前 Vault 兼容：

| 数据 | 默认路径 |
|---|---|
| Vault | `E:\ObsidianData\OKF-Brain` |
| Originals | `E:\ObsidianData\OKF-Brain-Originals` |
| Runtime State | `E:\ObsidianData\OKF-Brain-State` |
| 部署配置 | `E:\ObsidianData\OKF-Brain-State\config\deployment.json` |

安装器会：

1. 安装 Engine、Dashboard 与 Claudian 依赖并构建；
2. 初始化或同步 Engine 内的 Workspace Kit；
3. 安装 Dashboard、Claudian、Contracts 和 Skills；
4. 在 Vault 外创建本地 API token；
5. 写入 Engine、MinerU、MarkItDown 与 Codex 配置；
6. 构建全文及可选向量索引；
7. 注册两个相互独立的计划任务：02:30 的每日维护负责索引、可选备份与恢复检查；06:50 的 Feed Sync 在远端发布窗口后执行增量同步，支持错过启动后补跑和 10 分钟间隔的三次临时故障重试。

每日维护同样支持错过时间后补跑、10 分钟间隔三次重试，并禁止同任务重叠运行。

安装器不会创建登录常驻 API 任务。Dashboard 插件在 Obsidian 加载后启动自己持有的本地
Engine 子进程，Obsidian 退出后服务随之停止。

### PowerShell 中读取 CLI JSON

CLI 的机器可读 JSON 在标准输出中保持为单一 JSON 文档；进度和错误写到标准错误。为兼容
PowerShell 7 与 Windows PowerShell 5.1 的不同原生进程编码规则，非 ASCII 字符在线路上会
写成标准 JSON `\uXXXX` 转义。`ConvertFrom-Json` 解析后得到的仍是原始中文，不是数据丢失。

```powershell
$report = okf doctor --verbose | Out-String | ConvertFrom-Json
$report.actionable
```

这个命令不依赖当前活动代码页；无需运行 `chcp 65001`，也不要先用文本替换修补输出。
需要保存原始 JSON 时可直接重定向，随后按 JSON 读取。

安装开始前会先验证 Vault、Originals 与 Runtime State：三者必须是绝对解析后彼此独立、
不相同也不互相嵌套的目录，且不能指向磁盘根目录或源码仓库根目录。每个受管目录都会写入
同一安装身份的 `.okf-workspace-owner.json`；这既允许三个目录位于不同磁盘或父目录，也让
卸载器只删除本次安装明确拥有的数据。

## 3. 备份与 LiveSync

当前开发阶段不把备份作为安装前置条件，也不自动为 Vault 建立每日 Git checkpoint。
需要 Restic 时显式传入：

```powershell
.\deploy\windows\install.ps1 `
  -EnableBackupSetup `
  -BackupRepository 'F:\Backups\OKF-Workspace'
```

LiveSync 在单机流程稳定后单独启用。它同步 Vault 内容，不同步 Runtime State、Originals、
本地服务或源码；移动端仅阅读和编辑 Markdown 时不要求主机 Obsidian 在线。
传入 `-LiveSyncPluginSource` 时，安装器会先完整检查 `main.js`、`manifest.json`、
`styles.css` 以及 manifest id，再通过临时目录原子替换插件文件；预检失败不会改动现有插件。

安装器只启用本次安装必需的 Dashboard、Claudian，以及用户明确提供源码的 LiveSync。
Templater、QuickAdd、Dataview 等推荐社区插件如果已被用户禁用，重新安装不会擅自启用。

## 4. MinerU 与 MarkItDown

- 所有默认文档导入直接使用 MarkItDown，不自动启动或探测 MinerU。
- 质量检查级别与解析器选择分开；历史隐式 `high` 请求也默认使用 MarkItDown。
- 仅显式指定 `parser=mineru` 的高级调用保留 MinerU 能力；当前暂停其专项维护。
- 转换器只返回 Markdown bundle；Source/Source Text 发布由 Engine 统一完成。

MarkItDown 源码位于 `services/markitdown/`，服务器部署资产位于
`deploy/markitdown/`。生成可传输部署包：

```powershell
.\scripts\package-markitdown-deployment.ps1
```

MinerU 是共享外部服务；本仓库只保存 `integrations/mineru/` 中的客户端约定和部署运维
资产，不复制服务运行数据。

## 5. 开发期插件快速部署

只更新插件而不重新写完整部署配置时：

```powershell
.\scripts\install-dashboard.ps1
.\scripts\install-okf-claudian.ps1
```

完成后在 Obsidian 中重新加载应用。生产切换应使用完整安装器，以保证 Python 路径、token
文件和 plugin settings 一致。

发布后运行 `scripts/record-deployment.ps1 -Config <deployment.json>`：逐项核对两插件
实际安装文件与构建 SHA-256，记录 Engine Python 源码哈希和 Git 版本到 State 的
`reports/deployment-receipt.json`。当前本地 Engine 仍采用 editable-source 运行，回执是
部署时证据，不把其伪装成不可变镜像；之后的源码修改需要重新验收并记录回执。

插件安装器只管理 `okf-workspace-dashboard`、`okf-claudian` 以及历史误复制目录
`.obsidian/plugins/claudian`。官方社区插件 `realclaudian` 的启用状态和文件不会被修改；如两者
会造成界面冲突，由用户在 Obsidian 中自行决定是否停用它。

Engine Skills 部署到 `.agents/skills/`，并由 `.okf-managed-skills.json` 记录安装器所有权。
升级只替换或清理清单内的 Skill，其他用户/第三方 Skill 原样保留。首次部署若遇到同名但
尚未归 OKF 管理的目录，只有当其完整目录结构、逐文件内容和 SHA-256 与当前源码完全一致时，
才会作为旧安装器留下的副本被安全认领；任意缺失、额外文件、内容差异或链接都会在写入前
失败，要求用户先检查、改名或移走该目录，不会覆盖。

## 6. 发布验收

自动检查通过后，使用一次合成 Vault 与一次真实服务 smoke test：

1. 创建 Daily、Capture、Course、Project；
2. 导入 PDF/DOCX，确认进度、Source pair 与结果跳转；
3. 处理一条 AI Daily 和一条树洞；
4. 生成 Independent、Course 和 Project-related Study Guide；
5. 更新 Study Guide 并生成 Wiki；
6. 新 Codex 会话检索已生成 Wiki；
7. 重启 Obsidian，确认只有一个本地服务且退出后终止；
8. 运行 validator/doctor，确认新数据无坏链、重复 Source 或悬空任务。

不需要两周观察期，也不要求把所有历史 UAT 内容迁移成正式内容；但会让 validator
失败、产生坏链或悬空任务的测试残留，必须在本轮验收前删除、修复或重新转换。

## 7. 卸载

```powershell
.\deploy\windows\uninstall.ps1 `
  -Config 'E:\ObsidianData\OKF-Brain-State\config\deployment.json'
```

默认只移除 Workspace 计划任务、OKF Dashboard、OKF Claudian 和历史误复制的 `claudian`
目录，保留官方 `realclaudian`、用户 Skills 与全部数据。只有明确传入 `-RemoveData` 才会
删除 Vault、Originals 与 Runtime State。数据删除前会先一次性验证三个精确路径、安装身份
与 ownership marker；任意一项不匹配都会在移除任务、插件或数据之前停止。旧安装若没有
marker，先重新运行一次当前安装器完成身份迁移，再执行 `-RemoveData`。
