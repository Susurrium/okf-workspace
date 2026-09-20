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
- Intake：所有默认入口直接使用 MarkItDown；历史隐式 high 不触发 MinerU；保留显式解析器选择的单元覆盖。暂不验收 MinerU 服务。
- Retry：切换 parser 不残留永远 queued 的旧 conversion。
- Identity：原始文件名、resource、首个 `ingested_via` 不在 worker 中丢失。
- Relations：Course、Project、双关联与 Independent 都传播到目标，不改写共享 Source 身份。
- Learning/Knowledge：生成、更新、完成学习和 Wiki 沉淀语义分离。
- Retrieval：标题/全文/向量均只定位候选，回答实际读取 Markdown；关联扩展遵守相同范围，不匹配同名前缀目录；显式附件单独尊重用户选择。
- Operations：幂等、取消、重试、orphaned；生成结果发布前校验，冲突重读合并，不用旧快照回滚用户新内容。
- File safety：Windows drive/UNC/ADS/device 路径拒绝；跨进程创建只有一个成功者；Source 身份及用途合并不丢失。

## 3. Dashboard 关键矩阵

- 测试真实 `OkfDashboardView`，不能只测未运行的旧 page model。
- Today 宽屏横向展示继续进行、待处理与待办，窄 pane 依次降为两栏和单栏；中国热点、AI 资讯、树洞热榜各自选择最近一期，卡片内滚动查看该期所有条目。
- Reading 展示 `learning` 订阅来源及 `papers` 论文卡片，使用与 Today 相同的滚动列表和 Feed 条目交互；按来源搜索和浏览历史，连续加载不重复、不跳期，返回后恢复滚动位置；论文不出现在 Today。
- Inbox 三阶段、渠道过滤、Web 四个离散动作及明确反馈。
- Learning 的 `全部 = Course + Project-related + Independent`，具体关系筛选和双关联正确。
- Project 快速记录、关联学习入口、状态与下一步展示准确。
- Vault-native 动作在 Engine 离线时仍可完成；后台动作显示排队、运行、完成、失败和重试。
- 页面刷新不重置 tab、筛选、details、输入焦点和已保存 scrollTop。
- 缓存刷新失败不能伪装成最新成功；单个坏笔记不能使整个视图消失；订阅确认前后退/关闭不触发重复提交或迟到结果覆盖。
- Reading 与实时预览使用相同的 Feed 判断；多 pane 操作取所属编辑器文件，不取全局活动文件。

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
3. 上传测试 PDF/DOCX/PPTX，确认默认 MarkItDown 路径及图片完整性；
4. 发布 Web Clip 和 Feed 中相同 URL，确认只产生一个 Source pair；
5. 生成 Independent、Course、Project-related Study Guide；
6. 更新 Study Guide，用户明确标记完成，再生成/更新 Wiki 和 Wiki Map；
7. 创建 Project 日志与 Decision，整理 Daily；
8. 用新 Codex 对话检索 Wiki/Project/Learning，并记录真实读取路径；
9. 验证 Dashboard 所有入口、状态反馈和原生文件跳转；
10. 运行 validator/doctor 并确认没有悬空新任务、坏链接或重复 Source。

## 6. 实机专项

自动化全部通过后，只做一次短实机验收：

- MarkItDown 真实转换带图 DOCX，并验证结果 bundle/图片完整性；MinerU 本轮明确跳过；
- 本机 Codex 完成一次可见会话和一次后台生成；
- Today 的中国热点、AI 资讯、树洞热榜各打开一条；Reading 验证至少两个来源卡片，进入其中一个来源、加载两期内容并处理一条；
- Obsidian 重启后 Dashboard、Claudian、本地服务生命周期正常；
- Windows 开机无旧 worker 或多余终端。

LiveSync 属于以后启用多设备时的独立验收，不阻塞当前单机发布。备份也不是当前开发
门槛；需要时再启用可选的外部备份。

## 7. 采集恢复

- RSS 超过单批限制的条目保留在 pending 队列，同日补采、跨日排空，不因排序或多来源饥饿丢失。
- 订阅预览只抓取一次；合法空 feed 与异常返回区分；坏条目不阻塞同源其他条目，并报告降级。
- news、learning、papers、hotspot 的健康状态分别记录，不互相覆盖；保留上次成功时间。
- MarkItDown 慢上传受空闲与总时限限制；回收过期隐藏临时文件而不删除活动任务文件。
- Windows 维护任务错过计划时间后补跑；恢复演练使用 monorepo 的 engine 可执行文件。
