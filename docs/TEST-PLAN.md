# OKF Workspace 测试与验收

测试使用隐私安全的合成 Vault；历史生产笔记和旧 Runtime State 不作为兼容门槛。

## 1. 根级命令

```powershell
cd E:\code\okf-workspace
.\scripts\bootstrap.ps1
.\scripts\check.ps1
.\scripts\build.ps1
```

`check.ps1` 必须覆盖：

- Engine：pytest、Ruff、Pyright；
- MarkItDown：pytest、Ruff；
- Engine ↔ MarkItDown 跨组件 bundle contract；
- Dashboard：TypeScript、Vitest；
- Claudian：TypeScript、ESLint、架构边界测试。

`build.ps1` 必须产生 Engine wheel、MarkItDown wheel、Dashboard 插件和 Claudian 插件。

## 2. Engine 关键矩阵

- Contract：所有 Workspace 写入器产生合法 YAML，并保留未知扩展字段。
- Sources：Source/Source Text 成对原子发布；Web/Feed 双向 URL 去重；文件哈希去重。
- Intake：MinerU 默认、MarkItDown 降级、直接 MarkItDown、必须 MinerU。
- Retry：切换 parser 不残留永远 queued 的旧 conversion。
- Identity：原始文件名、resource、首个 `ingested_via` 不在 worker 中丢失。
- Relations：Course、Project、双关联与 Independent 都传播到目标，不改写共享 Source 身份。
- Learning/Knowledge：生成、更新、完成学习和 Wiki 沉淀语义分离。
- Retrieval：标题/全文/向量均只定位候选，回答实际读取 Markdown；vault-relative 链接正确解析。
- Operations：幂等、取消、重试、orphaned、完成发布和失败回滚。

## 3. Dashboard 关键矩阵

- 测试真实 `OkfDashboardView`，不能只测未运行的旧 page model。
- Today 双栏与窄 pane 模式；Feed 独立滚动和刷新后位置保持。
- Inbox 三阶段、渠道过滤、Web 四个离散动作及明确反馈。
- Learning 的 `全部 = Course + Project-related + Independent`，具体关系筛选和双关联正确。
- Project 快速记录、关联学习入口、状态与下一步展示准确。
- Vault-native 动作在 Engine 离线时仍可完成；后台动作显示排队、运行、完成、失败和重试。
- 页面刷新不重置 tab、筛选、details、输入焦点和已保存 scrollTop。

## 4. Claudian 关键矩阵

- Codex provider 使用本机 Codex CLI 登录态，Claude provider 未启用时不要求 Claude 认证。
- `okfBridge v1` 能接收 Dashboard 的任务、文件和 Skill 建议。
- OKF adapter 不反向侵入上游 domain/core；Dashboard 不依赖 Claudian 内部类。
- Vault `AGENTS.md`、Skills 与附件按任务读取，基础提示不复制整套 Workspace 说明。
- 上游 architecture tests 与 production build 持续通过。

## 5. 合成 Vault 完整流程

每次发布使用临时目录重新生成，不复用旧状态：

1. 初始化 Vault 和 Contracts；
2. 快速记录一个无归属 Capture、一个 Course 想法和一个 Project 想法；
3. 上传测试 PDF/DOCX/PPTX，分别走默认、快速与降级路径；
4. 发布 Web Clip 和 Feed 中相同 URL，确认只产生一个 Source pair；
5. 生成 Independent、Course、Project-related Study Guide；
6. 更新 Study Guide，用户明确标记完成，再生成/更新 Wiki 和 Wiki Map；
7. 创建 Project 日志与 Decision，整理 Daily；
8. 用新 Codex 对话检索 Wiki/Project/Learning，并记录真实读取路径；
9. 验证 Dashboard 所有入口、状态反馈和原生文件跳转；
10. 运行 validator/doctor 并确认没有悬空新任务、坏链接或重复 Source。

## 6. 实机专项

自动化全部通过后，只做一次短实机验收：

- MinerU 服务器真实转换一个复杂 PDF；
- MarkItDown 真实转换一个 DOCX；
- 本机 Codex 完成一次可见会话和一次后台生成；
- AI Daily 与树洞各处理一条；
- Obsidian 重启后 Dashboard、Claudian、本地服务生命周期正常；
- Windows 开机无旧 worker 或多余终端。

LiveSync 属于以后启用多设备时的独立验收，不阻塞当前单机发布。备份也不是当前开发
门槛；需要时再启用可选的外部备份。
