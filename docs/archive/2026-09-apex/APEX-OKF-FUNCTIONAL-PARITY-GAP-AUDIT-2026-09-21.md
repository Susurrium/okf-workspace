# Apex × OKF 功能完整性差距审计

> 历史记录（2026-10-06 归档）。下文保留当时的方案、状态和验证证据，不作为当前实现要求；当前边界见[系统架构](../../architecture/README.md#system-overview)，有效文档见[文档索引](../../README.md)。

日期：2026-09-21  
审计时结论状态：阻断当时版本发布，重新打开 M4–M9

> **历史状态说明：** 本审计记录的是 2026-09-21 发现的功能差距与当时的发布阻断结论。后续共享
> Surface 修复已完成；P01–P08 和 M0–M9 的隔离验收结果，以及 2026-09-29 的生产切换证据，见
> `APEX-OKF-FUNCTIONAL-PARITY-IMPLEMENTATION-2026-09-21.md` 和 [Dashboard acceptance ledger](../../../dashboard/ACCEPTANCE.md)。
> 下文保留原始差距与代码证据，不代表当前发布门槛仍未通过。

## 1. 结论

当前实现完成了 Apex 外壳、工作台布局、稳定 Section ID、数据接管、部分 Vault 投影和少量动作，
但没有完成原 OKF Dashboard 的功能迁移。它把原来的完整页面改写成了几个轻量 Section，保留了
底层服务和一部分命令，却没有把原界面的范围选择、上下文操作、状态反馈、失败恢复、筛选、
分页和工作流入口带入新工作台。

“学习”最明显：新 Section 顶部只有“新建课程”“新建 Lesson”“导入资料”，列表里再提供
少量“生成学习材料”“标记已学习”“撤销完成”。这不是原学习工作区的等价迁移，只是摘要投影。
用户看到的功能减少是真实回归，不是布局差异，也不是功能被移到其他可发现位置。

这次回归不是产品需求决定，也没有经过用户确认。根因是实现和验收方法错误：

1. 合并方案原本要求复用完整 OKF 能力，实际实现却新写了简化 Section。
2. 验收把“服务方法仍存在”“命令仍注册”“能读取数据”误当成“界面功能已经迁移”。
3. 旧 `OkfDashboardView` 仍包含丰富页面和测试，但插件入口只注册新的 Apex `DashboardView`；
   因此大量测试通过的是已经不可达的旧界面。
4. 19 项验收主要覆盖数据安全、生命周期和少量跨视图行为，没有建立旧界面到新 Section 的
   功能入口清单，空数据场景也掩盖了缺失按钮和状态。

当前版本可以作为架构原型和数据安全基线，不能作为原 Dashboard 的完整替代版本。

## 2. 代码证据

### 2.1 新学习 Section 确实只有薄层能力

`dashboard/src/features/workspace/workspace-sections.ts` 中的新学习 Section 只提供：

- 顶栏：新建课程、新建 Lesson、导入资料；
- Course 行：新建 Lesson；
- 待生成 Source：生成学习材料；
- 待学习/已学习：标记已学习、撤销完成；
- 四个固定分组：课程、待生成、待学习、已学习。

同一文件中的 Inbox 和 Knowledge 也是固定分组加少量按钮，没有原页面的筛选、工作流状态和恢复入口。

### 2.2 完整旧页面仍在源码中，但不再是正式入口

`dashboard/src/plugin/dashboard-view.ts` 仍包含：

- `renderToday`
- `renderReading`
- `renderInbox`
- `renderLearning`
- `renderProjects`
- `renderKnowledge`
- `renderLife`
- `renderSystem`

`dashboard/src/plugin/main.ts` 当前只注册 `DashboardView`（Apex），没有注册 `OkfDashboardView`。
这说明底层能力和旧实现并未全部消失，但用户无法从正式 Dashboard 进入这些完整页面。

### 2.3 现有测试不能证明功能完整

- `dashboard/tests/workspace-sections.test.ts` 只验证 Section 类型和计数投影。
- `dashboard/tests/project-section.test.ts` 主要验证状态筛选和任务投影。
- `dashboard/tests/reading-section.test.ts` 只验证少量纯投影辅助函数。
- `dashboard/tests/dashboard-view.test.ts` 覆盖了旧阅读分页、请求竞态、学习上下文、项目操作等大量行为，
  但这些测试实例化的是不再注册的旧 View。

因此“测试通过”与“新 Apex 工作台具备同等功能”之间没有建立有效联系。

## 3. 分区功能差距

严重程度说明：P0 表示核心流程不可完成或恢复；P1 表示高频体验明显回退；P2 表示信息架构、
可发现性或连续性回退。

### 3.1 学习：P0

原学习工作区具备：

- 学习范围：全部材料、独立学习、课程相关、项目相关，以及具体 Course/Project；
- Course 上下文：进度、最近 Lesson、待处理 Capture、Guide、Source、Lesson 统计；
- Course 操作：新建 Lesson、记录课程想法、添加资料、打开课程主页；
- Project 上下文和对应项目操作；
- 可学习、待生成、已完成三个视图；
- Study Guide 完整状态：等待、生成中、发布中、失败、可学习、已完成；
- 生成、重新生成、允许阶段内取消、失败重试、打开结果；
- 与 Claudian 一起生成、完善、讨论；
- 明确标记完成/取消完成，以及从学习结果沉淀 Wiki；
- 完整学习目录；
- 从当前 Course/Project 发起 Lesson、Capture 或导入时继承上下文。

当前新 Section 缺少上述大部分能力。尤其严重的是：选择某个 Course 后导入和创建 Lesson 的
上下文工作流消失；运行中、失败和发布阶段不可见；Claudian 入口、沉淀 Wiki 和完整目录不可达。

修复要求：把旧学习页面拆成可复用 `LearningSurface`，由 Apex Section 挂载；不能继续在
`workspace-sections.ts` 里逐个补按钮。Course/Project 选择、tab、滚动位置进入稳定 Section 状态，
请求和操作进度进入 pane 运行时状态。

### 3.2 Inbox 与导入恢复：P0

原 Inbox 具备：

- 快速记录和导入；
- “待判断 / 转换进度”视图；
- 导入渠道筛选、多选、批量标记不保留；
- Capture 的来源、类型、主机、时间、摘要等详情；
- 普通 Capture 路由；
- Web Clip 明确判断树：学习、稍后学习、生成 Wiki、仅保存原文、不保留；
- 保留 `interest` 与 `long_term_value` 为显式用户判断；
- Source 的学习/Wiki/只保留来源选择；
- 转换状态、输出、警告、错误和解析器尝试；
- 改用 MarkItDown、继续归档、按解析器重试；
- 语义操作取消、重试和 Claudian 交接。

当前新 Section 只有 Capture 的“进入项目/转为 Lesson”和待归类资料的“学习/Wiki/仅归档”。
用户无法处理 Web Clip 的显式判断，也无法在转换失败后从 Dashboard 恢复任务。

修复要求：恢复完整 `InboxSurface` 和共享 `OperationCenter`。转换、生成和发布操作使用同一套
状态组件和恢复动作；不在 Dashboard 重写 Engine 状态机。

### 3.3 知识：P0/P1

原知识页具备：

- 从材料生成 Wiki、打开完整知识目录；
- 按 Wiki、Wiki Map、标签和主题搜索；
- 全部、待生成、Wiki、Wiki Map、待核验 AI 内容、需要复核、已弃用等筛选；
- Wiki Map 和修改时间排序；
- 生成中、失败、重试、取消等操作状态；
- AI 未核验、过期、弃用标识和明确核验入口；
- 持久化搜索和筛选状态。

当前新 Section 只有“从资料创建 Wiki”、待整理列表和 Wiki/Map 平铺列表。

修复要求：抽取 `KnowledgeSurface`，恢复目录、搜索、筛选、核验和操作状态；所有受管 Artifact
修改继续经过现有 edit policy。

### 3.4 项目：P1

当前新项目 Section 已有状态筛选、项目字段、正式任务、关联内容、记录进展、新建决定、状态修改、
打开日志。这些是有效新增或迁移，但仍未达到旧项目页完整性。

缺少：

- 完整项目目录；
- 互斥的进行中/已暂停/已完成视图及对应计数；
- 根据状态变化的主要动作：记录进展、恢复推进、重新开启；
- 记录待整理想法并自动绑定项目；
- 添加资料并自动绑定项目；
- 在 Claudian 中整理项目；
- 点击统计数后直接打开对应 Capture、Guide、Source 的精确集合。

修复要求：把新项目卡片中已经实现的任务日期和正式任务能力并入共享 `ProjectSurface`，再恢复旧
项目操作面板，避免退回旧实现时丢掉这次新增能力。

### 3.5 Today：P1

原 Today 具备：

- 创建/继续 Daily、快速 Capture、导入资料；
- 行动/每日更新视图；
- 最近 Study Guide、Project、Course 的继续工作列表；
- 后台失败、Inbox 待判断、待学习、待生成 Wiki、过期知识、运行中任务等关注队列；
- 今日任务和“查看全部待办”；
- Daily Feed 与系统告警。

当前新 Today 只有打开今日日记、随手记录和当天正式任务。

修复要求：构建 `TodaySurface`，把“今天要做什么”和“系统需要我处理什么”恢复为统一入口；
保留当前正式任务日期编辑和锚点安全修改。

### 3.6 Life：P1，整个分区缺失

原 Life 具备继续今日日记、随手记录、新建 Reflection、新建 Review、打开日历、最近 Daily/
Reflection/Review，以及把记录整理到项目、课堂笔记、丢弃或按规则建议去向。

当前 Apex 预设没有 OKF Life Section。Apex 自带日历或便签不能替代这些 Vault 工作流。

修复要求：新增 `workspace-life`，并在 Daily 预设或独立 Life 预设中提供；Apex 原生日历和便签继续保留。

### 3.7 System 与后台任务中心：P0，整个分区缺失

原 System 具备：

- 刷新诊断、打开设置；
- 服务和诊断详情；
- Claudian 状态和入口；
- 转换失败、语义操作失败的重试和恢复；
- 治理报告、索引重建、Feed 立即同步；
- 最近一次安全撤销；
- 运行中的转换和 MarkItDown 回退。

当前监控服务和 Notice 仍可能运行，但没有统一的查看和恢复界面。后台任务存在并不等于用户能管理它。

修复要求：新增 `workspace-system` 和全局后台任务入口。它只呈现诊断和调用已有服务，不复制 Engine
状态机。

### 3.8 阅读：P1

当前 `workspace-reading` 已保留订阅、总览、来源搜索、加载更多、历史和订阅设置，是新 Section 中
完成度较高的一项，但仍弱于旧阅读页：

- 缺少清晰的“同步最新内容”入口；
- Source 卡片只依赖预览数据，没有旧版按需加载完整最新条目的流程；
- 缺少全局请求队列、single-flight、并发限制、取消和迟到响应丢弃；
- 缺少按 Source/Digest 保存滚动位置和有界 LRU 缓存；
- Section 重渲染后，选择、查询和分页等闭包状态会丢失；
- 刷新失败时保留缓存内容并原位重试的能力变弱。

修复要求：抽取旧阅读控制器到 `ReadingSurface`，保留新 Section 外壳和现有投影函数，恢复缓存、
分页、竞态保护和位置持久化。

### 3.9 全局入口与工作台预设：P1/P2

旧顶栏提供 Vault 搜索、快速创建、“问我的笔记”、后台任务中心和 System。新工作台主要保留 Apex
全局搜索，其他功能即使仍有命令也不够可发现。

当前预设还存在语义错配：

- Project 预设中的“项目行动”挂载的是全局 Today，并未按项目过滤；
- “相关学习”挂载的是全局 Learning，并未继承当前项目；
- Reading 预设中的“已整理知识”是全局 Knowledge，并非当前阅读来源的输出关系。

修复要求：预设标题必须与真实上下文一致。需要上下文联动时，引入显式的 Section link/context，
不能只改显示名称。

## 4. 正确的目标架构

### 4.1 一个功能实现，多种容器挂载

不再维护“旧完整 View + 新简化 Section”两套页面。把旧 View 中的页面控制器拆成共享 Surface：

```text
dashboard/src/workbench/
  runtime/section-runtime.ts
  state/section-state.ts
  components/operation-state.ts
  components/action-panel.ts
  components/async-boundary.ts

dashboard/src/features/
  learning/learning-surface.ts
  inbox/inbox-surface.ts
  knowledge/knowledge-surface.ts
  projects/project-surface.ts
  today/today-surface.ts
  life/life-surface.ts
  system/system-surface.ts
  reading/reading-surface.ts
```

每个 Surface 接收：

- 类型化 host：打开文件、弹出输入、调用现有 Plugin/Engine/Claudian 服务；
- `VaultDashboardReader` 或专用只读查询；
- Section 状态适配器；
- 生命周期信号，用于取消请求和忽略过期响应；
- 当前工作台上下文，例如所选 Project/Course/Source。

Apex 的 `CustomSectionDefinition` 只负责挂载、尺寸和 Section 配置，不承载业务流程。

### 4.2 状态分层

- 持久化交互状态：tab、筛选、范围、选中实体、排序、折叠、滚动摘要，写入稳定 Section ID 对应的
  `extensionConfig` 或专用 UI state。
- pane 运行时状态：请求代次、AbortController、运行中 promise、临时错误，放在 Section runtime，
  不写入 Vault。
- 业务状态：继续由 Vault Markdown/YAML、Engine API 和既有 Apex JSON 负责。
- habits、expenses、manual reading、focus 继续沿用 Apex JSON，不改为 Vault Artifact。

### 4.3 上下文联动

工作台建立显式 `WorkbenchContext`：

```ts
interface WorkbenchContext {
  projectPath?: string;
  coursePath?: string;
  sourcePath?: string;
}
```

Section 可以声明消费哪些上下文。Project 选择变化后，“项目行动”“相关学习”“添加资料”等 Section
收到同一 `projectPath`。没有上下文时必须显示“选择项目”或按全局模式运行，不能用标题制造已联动的假象。

### 4.4 过渡期兼容

最快且安全的恢复方式分两步：

1. 先把旧完整 OKF 页面作为一个临时“OKF 控制中心”Surface 挂入 Apex，立即恢复所有可达操作；
2. 再逐页抽取共享 Surface，并在通过对应功能台账后替换控制中心里的旧页面。

过渡层和新 Section 都调用同一组现有服务，不引入第二套业务状态机，也不允许两个插件同时写数据。
全部 Surface 达标后再删除旧 View 代码。

## 5. 修复开发流程

### R0：纠正事实和建立功能台账

- 将 M4–M8 标为 Partial，将 M9 标为 Reopened；
- 保留 A01–A19 的具体测试结果，但明确它们只是必要条件，不证明功能完整；
- 从旧页面生成“入口—状态—动作—结果—失败恢复”能力清单；
- 每项只能标记为“已迁移”“经用户确认改变”“明确排除”；不能以“方法仍存在”结项。

完成标准：新 `workbench-feature-parity` 测试直接实例化注册后的新 Section，而不是旧 View。

### R1：先恢复学习完整性

- 提取 `LearningSurface`；
- 恢复范围树、Course/Project 上下文、三个状态视图；
- 恢复生成/重生成/取消/重试/完成/撤销/Wiki 沉淀；
- 恢复 Claudian 生成、完善和讨论；
- 恢复完整目录和上下文继承；
- 合并当前新 Section 已有的明确完成功能。

完成标准：用户在 Apex 学习工作台内可以走完原学习页的每一条主流程，不需要通过命令面板补足。

### R2：Inbox、导入与后台操作中心

- 恢复 Web Clip 判断树和普通 Capture 路由；
- 恢复批量处理、渠道筛选和转换进度；
- 恢复 MarkItDown 回退、继续归档、重试和取消；
- 加入全局后台任务入口。

完成标准：失败任务可以从界面诊断和恢复；显式兴趣/长期价值判断不被 AI 推断。

### R3：知识与项目

- 恢复知识搜索、筛选、核验和操作状态；
- 恢复项目上下文 Capture、导入、Claudian、目录和状态感知主动作；
- 保留新项目 Section 的任务日期和锚点安全更新。

### R4：Today、Life、System 与全局入口

- 恢复 Today 继续工作、关注队列、Daily Feed 和系统告警；
- 新增 Life 与 System Section；
- 恢复快速创建、问笔记、任务中心和系统入口；
- 修正预设中的伪上下文标题和联动。

### R5：阅读控制器完整迁移

- 恢复同步、完整条目加载、分页、缓存、滚动位置和请求竞态保护；
- 用新注册 Section 的集成测试替换旧 View 测试的验收角色。

### R6：全量验收和清理

- 使用包含所有状态的非空合成 Vault；
- 逐项执行功能台账；
- 执行 Vitest、TypeScript、生产构建和根检查；
- 在真实 Obsidian 中验证每个 Surface 的正常、运行中、失败和恢复状态；
- 所有台账项通过后，才移除临时控制中心/旧 View，重新关闭 M9。

## 6. 新的验收门槛

每个分区至少验证以下四层，任何一层缺失都不能称为迁移完成：

| 层次 | 必须验证的内容 |
| --- | --- |
| 入口 | 用户能从工作台看到并进入功能，不依赖隐藏命令 |
| 操作 | 按钮调用正确的 host/service，并带上当前 Project/Course/Source 上下文 |
| 状态 | 空、加载、运行、成功、失败、取消、重试和刷新后的状态正确 |
| 连续性 | tab、筛选、选择、分页和滚动在重渲染、切主题、重开 pane 后按设计保留 |

测试数据必须覆盖：待生成、生成中、发布中、失败、可学习、已完成；Web Capture；转换失败；
Source 三种用途；AI 未核验、过期、弃用知识；活动、暂停、完成项目；多 Course/Project 上下文。

## 7. 当前建议

暂停部署当前合并版本。下一项开发工作应是 R0 + R1：先提交可执行功能台账和 Section 级验收框架，
随后把完整学习工作区迁入 Apex。学习通过后，再按 R2–R6 推进，而不是继续给薄 Section 零散加按钮。
