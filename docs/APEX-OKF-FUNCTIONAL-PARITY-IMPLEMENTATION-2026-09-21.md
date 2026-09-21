# Apex × OKF 功能完整性恢复实施记录

日期：2026-09-21
对应审计：`APEX-OKF-FUNCTIONAL-PARITY-GAP-AUDIT-2026-09-21.md`

## 实施结果

原完整 OKF Dashboard 已改造成可嵌入 Apex 自定义 Section 的共享 Surface。正式注册的 Today、
Inbox、Reading、Learning、Projects、Knowledge、Life 和 System 八种 Section 现在都挂载这份完整
实现，不再使用原先的薄投影作为运行时入口。

现有工作台文件无需格式迁移。原有 `workspace-learning` 等稳定类型会在插件重新加载后直接解析为
完整 Surface；未知字段、Section ID、Apex 原生卡片和自由正文继续由现有无损序列化路径保留。

## 恢复的用户能力

- Learning：学习范围、Course/Project 上下文、完整目录、可学习/待生成/已完成、操作状态、
  生成/重试/取消、Claudian、明确完成/撤销和 Wiki 沉淀。
- Inbox：渠道筛选、多选/批量不保留、Web Clip 两级判断、普通 Capture 路由、转换进度和恢复动作。
- Knowledge：目录、搜索、七类筛选、AI 核验、过期/弃用信息和 Wiki 操作状态。
- Projects：状态视图、状态感知主动作、项目想法/资料/日志/Claudian、正式 Decision；同时合入
  正式任务勾选和提醒/计划/截止日期编辑。
- Today：继续工作、关注队列、正式任务、Daily Feed、系统提醒、导入；同时合入安全任务勾选和
  三类日期编辑。
- Life：Daily、随手记录、Reflection、Review、日历和记录整理。
- System：诊断、设置、后台任务、失败转换/语义操作恢复、索引与 Feed 维护。
- Reading：同步、来源搜索、完整条目分页、请求竞态保护、缓存、按来源阅读位置和订阅设置。
- 全局入口：搜索、快速创建、问我的笔记、导入资料和后台任务中心。

嵌入式 Surface 使用紧凑 OKF 切换器。即使旧工作台尚未加入 Life/System Section，用户也能从
任意现有 OKF Section 进入这两个页面，再返回该 Section 的默认页面。

## 架构变化

### 共享 Surface

`OkfDashboardView` 接受嵌入容器、初始页面和嵌入模式，同一控制器同时用于原页面行为和 Apex
Section。`okf-surface-sections.ts` 负责八种稳定类型到共享 Surface 的映射，并保存发布门槛能力清单。

### Section 生命周期

Apex 自定义 Section 的 `render` 现在可以返回清理函数。`DashboardView` 按稳定 Section ID 管理
清理函数，并在该 Section 原位刷新、整页重渲染和 pane 关闭时执行。共享 Surface 因此会正确取消
请求、释放计时器、保存滚动位置并销毁操作面板，不依赖 DOM 观察器，也不会在布局刷新后积累隐藏实例。

### 预设和入口

- 新增 Life、System 工作台预设；
- Daily 预设加入 Life/System；
- Learning 预设加入学习任务状态；
- Project/Reading 预设移除没有实际上下文绑定的“项目行动”“相关学习”“已整理知识”等误导标题；
- 默认快速操作加入快速创建、问我的笔记和导入资料。

### 正式任务兼容

共享 Project/Today Surface 合入了锚点安全的任务勾选和三个独立日期字段。验证中同时修复：

1. Windows CRLF 文件最后一行任务无法匹配；
2. 外部写入改变文件大小时，任务缓存只看 `mtime` 可能保留旧扫描结果；
3. 已知文件变化后改用直接读取，避免 Obsidian 的 `cachedRead` 短暂落后于文件 stat。

## 自动化验证

- Dashboard：40 个测试文件，213 项全部通过；
- 新增正式 Section 功能台账测试，验证八个稳定类型全部挂载共享 Surface；
- 原完整 Dashboard 行为测试：49 项全部通过；
- Apex：lint 和独立生产构建通过；
- Dashboard TypeScript 和生产构建通过；
- 根 `scripts/check.ps1` 通过，包括 Engine 403 项、根 E2E 9 项、MarkItDown 35 项、Dashboard
  213 项、Claudian 500 项及架构/版本检查。

## 真实 Obsidian 验证

验证使用隔离 Vault、隔离 profile 和生产 `dashboard/dist/`，未打开生产 Vault。

- 既有 `dashboard.md` 原地加载，9 个已有 OKF Section 全部成为完整嵌入式 Surface；
- Learning 非空数据显示 3 份材料、Course 上下文、1 份可学习、1 份待生成、1 份已完成；
- Course 视图显示待整理、Study Guide、Source、Lesson 统计及上下文操作；
- Inbox 显示 Web Clip，并能从“我想学习”进入“现在生成 Study Guide / 稍后学习 / 返回”；
- Knowledge 显示 Wiki 和“待核验 AI 内容”，提供“查看并核验”；
- Project 显示完整旧操作面板、新建正式决定，以及正式任务的提醒/计划/截止日期；
- Today 显示来自 Project 和 Lesson 的同一正式任务及日期编辑；
- 嵌入切换器成功进入 Life 和 System，并提供对应完整入口；
- 强制 Apex 整页刷新前后，运行时实例和 DOM Surface 数量均为 9，没有重复挂载；
- Engine 未提供有效 Feed token 时，Reading/Today 保留页面和重试入口并明确显示 401，不影响 Vault
  本地工作流。

## 剩余发布门槛

功能实现已经恢复。发布切换仍保留两个验证项：

1. 在具有有效 Engine token 的隔离环境重跑 Reading 的真实同步、完整条目分页和位置恢复；
2. 使用包含生成中、发布中、失败、取消和转换回退的合成 operation 数据执行一次完整 P08 走查。

这两个门槛不需要再改变页面架构；它们用于证明在线服务状态和失败恢复在最终发布包中的真实表现。
