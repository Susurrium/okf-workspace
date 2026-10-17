# 架构与数据

[文档入口](../../README.md#文档入口) · [接口](../INTERFACES.md) · [Vault Contracts](../../engine/workspace/vault/system/contracts/README.md)

本文件维护模块职责、数据归属与关键约束。Artifact 字段、枚举、路径和可写区域由 Contracts 定义。

[![系统总览](visualizations/overview.svg)](visualizations/index.html#overview)

[架构查看器](visualizations/index.html)提供信息流与模块关系；生成方法见[开发指南](../DEVELOPMENT.md#架构可视化)。

<a id="system-overview"></a>

## 系统概览

| 应用 | 职责 |
| --- | --- |
| Engine | 领域模型、确定性工作流、Intake、Feeds、检索、API、CLI、后台任务及可部署 Vault 资源 |
| Dashboard | 工作台、Vault 读取、简单人工等价编辑，通过 Engine 请求领域操作 |
| Claudian | 会话、助手界面和 Provider runtime，通过公开 Bridge 接收交接 |

Vault Markdown/YAML 和原件保存长期内容。凭据、会话、队列、缓存与索引位于仓库外的本机 State。
LiveSync 复制 Vault 完整字节；各设备直接打开本地原件。部署、同步和旧服务恢复见[部署指南](../DEPLOYMENT.md)。

<a id="module-boundaries"></a>

## 模块边界

- Foundation 提供 Contracts、frontmatter、路径、关系、原子文件操作和基础类型。
- Sources 独占 Source/Source Text 身份、查找与成对发布；Intake 和 Feeds 不互相调用实现，跨模块操作由应用工作流组合。
- Dashboard 通过 Vault API 读取和执行简单人工等价编辑。转换、发布、后台语义操作及 State 访问由 Engine 执行；写入请求携带 Vault fingerprint，身份不匹配即拒绝。
- Engine 提供 Digest 路径和正文；Dashboard 仅创建缺失文件，已有笔记由 Engine 刷新。
- Apex 作为源码嵌入 Dashboard 的唯一插件构建；统一宿主管理组件服务与生命周期，保留原生数据格式和唯一写入者。
- `services/markitdown/` 是独立转换服务，`integrations/mineru/` 保存外部服务接入和运维资产。旧 Originals 服务仅用于历史恢复。

### 文件导入与发布

Dashboard 先保存 Vault 原件，再写入 `system/imports/<uuid>/request.md`。桌面 Engine 对私有快照核验长度和 SHA-256，
同步到达顺序不限。`store` 登记资料，`convert` 执行所选转换；凭据、执行状态与完整 export/QC 留在 State。
转换器返回结果包，Engine 统一发布 Source 与 Source Text。成功发布并持久化回执后清理工作副本，失败保留恢复依据。
仅发布最终正文引用的附件，依赖由正文链接表达；Source Text 的来源关系指向 Source。

### Claudian 接入

Claudian 拥有会话、CLI、认证和 Provider runtime；OKF 业务指令来自部署的 Vault 资源。
每轮上下文包含产品系统指令、所选提示模式、作用域 AGENTS、匹配的 Skill，以及用户消息/历史/明确附加或读取的文件。
Workspace Kit 安装到 Vault 的根 AGENTS、`.agents/skills/` 和 `system/`，按任务读取。
源码接入边界见 [Claudian UPSTREAM](../../claudian/UPSTREAM.md)，公开协议与提示模式见[接口](../INTERFACES.md#bridge)。

可见交接与 Engine 后台生成共享 Contracts 和 Skills。后台语义内容由 Codex 生成；
入队、幂等、取消、原子发布和状态持久化由 Engine 管理，按来源、用途和课程/项目上下文去重。

<a id="data-ownership"></a>

## 数据归属

| 数据 | 所有者与存储 |
| --- | --- |
| Capture、文件申请/回执 | Intake；Vault 保存内容和显示投影，执行状态在 State |
| 原件与附件 | 用户长期内容；Intake 核验，LiveSync 复制完整字节 |
| Source 身份、用途、正文 | Sources |
| Feed cache、Digest、决定回执 | Feeds |
| Course、Lesson、Study Guide | Workspace Learning |
| Wiki、Wiki Map | Workspace Knowledge |
| Project、日志、Decision | Workspace Projects |
| Daily、Reflection、Review | Workspace Life |
| 转换、语义操作与索引 | Vault 外本机 State；长期结果发布到 Vault |
| Contracts、模板、Views、Policies、Skills | Engine 可部署资源 |
| Apex 习惯、记账、阅读、专注及实例配置 | 原生服务、JSON/plugin data |
| 顶部常用操作、显示开关与 Capture 草稿 | Dashboard 本机插件配置；快捷项为全局偏好，草稿按默认/课程/项目上下文隔离 |
| 工作台布局、便签、清单、安全副本 | Dashboard/Apex 工作台 Markdown |

### Artifact 与公共字段

外部兼容读取要求 YAML 可解析且 `type` 非空，容许未知类型、扩展字段与断链；Workspace 自产文件严格遵循 Profile v3。
普通编辑局部校验，部署、迁移和专项审计执行完整 Profile 校验。精确字段与路径统一查阅[Contracts](../../engine/workspace/vault/system/contracts/README.md)。
根 `index.md` 是人工导航，`log.md` 是无 YAML 的连续项目日志，二者分别承担导航和过程记录。

### 人工内容与 AI 写入

人工监督下的讨论、整理与可见生成按正常内容保存。无人值守生成、长期复用且未检查的 Wiki 标注生成来源与时间；
核验记录对应实际核验人/流程。学习完成由用户明确确认，生成、阅读、讨论或答题不自动写入 `studied_at`。
后台只替换目标允许的 AI 区域，保留人工区域和未知字段；交互修改遵循用户授权。

### Source 与用途

资料身份与课程/项目无关，首次渠道保持不变；用途按 `purpose + course + project` 幂等合并。
正式用途仅清理无上下文或与本次课程/项目匹配的待决定项，其他已确认用途和待决定项保留。
“现在生成”另外建立后台任务，“稍后生成”保存用途；Feed 尚未选择时留在候选档案，不建立空白目标。
Capture 成功整理到长期目标后删除，明确丢弃进入本地回收站；网页 Capture 先发布资料与正文。
字段约束见 Contracts，调用语义见[接口](../INTERFACES.md#web-clipper)。

### 项目类别

`project_category` 的字符串类型由 Project Contract 定义，仅保存在项目主页；保存时首尾去空白后须为 1–80 个 Unicode 字符，
不含控制字符、区分大小写且无固定枚举。缺失为未分类，清除删除字段，多主题使用 tags，AI 不推断类别。
类别修改保护路径、正文、状态、任务和扩展字段，批量修改逐项检查原值。
看板分组、置顶与手动顺序属于视图状态；跨类别/状态列分别修改类别/状态字段。

### 任务与工作台

Tasks 配置单向导出到 `system/views/Tasks.md`，供 Engine 投影读取；Engine 遇到无法解释的全局查询明确报告，完整查询由 Dashboard/Tasks 执行。
工作台清单归所属工作台，普通任务和清单均排除不适用的来源及备份；人工操作见[任务](../USER-GUIDE.md#任务)。

工作台由顶层 YAML 布尔值 `dashboard: true` 识别，路径和注册表不决定身份。缺失 schema 兼容旧工作台，正整数为兼容版本；
非空 Artifact type 与工作台标记并存、非布尔标记、非法 schema 或 YAML 都报错并保留原文件。
Engine 发布器拒绝工作台目标，迁移逐字节保留工作台及异常身份文件。

工作台文件名保留 Unicode，改展示名保留路径，取消注册保留文件。注册表缺失时从有效 frontmatter 恢复，排除隐藏目录、
安全副本和根 index；按路径排序，优先 dashboard，否则首项。显式登记但尚未同步的路径保留；存储读取失败停止恢复。
默认检索与索引排除工作台和根 `.dashboard-backup/`，显式附加时读取当前正文；工作台继续参与备份恢复。

#### 工作台布局

布局由 Dashboard 保存到所属工作台 frontmatter，保留未知字段和正文。

| 字段 | 语义 |
| --- | --- |
| `layout` | `side`、`stacked`、`immersive`；缺失时跟随插件默认布局 |
| `immersive` | 卡片列表；显式空列表与缺失分别保留 |
| 卡片 `id` | `section:<稳定 ID>`、`card:<卡片 ID>`、`widget:<组件键>`；旧名称仅在唯一匹配时转换 |
| `w`、`cap` | 1–12 列、3–240 个 10px 网格行，行跨度包含底部间距；运行时 `h` 保存为 `cap` |
| `x`、`y` | 可选非负整数坐标，同时存在且 `x + w <= 12` |
| `fixed`、`hidden` | 可选布尔值：保留指定高度、隐藏卡片 |

沉浸式成员属于当前工作台，左右/上下布局使用全局开关；移出组件保留实例配置和共享服务。
顶部常用操作与当前工作台的快捷按钮分别保存；顶部、侧栏、网格入口的显示状态各自控制，同一 Capture 上下文共享会话和固定重试目标。
原生字段优先于旧 `workbench_layout`，旧字段仅在内存转换，明确保存后写原生字段并保留旧字段及扩展。
旧上游粗网格高度读取时换算。不支持的布局、重复 ID、非法尺寸/坐标报错。
布局经 frontmatter API 局部写入，检查身份及卡片旧值；不同卡片可并发合并，同卡片和顺序冲突拒绝覆盖。
