# Obsidian 真实使用指南

## 1. 先理解分工

- **Codex**：真正负责理解、检索、讨论和语义生成。
- **Vault**：人与 AI 都能读取的长期 Markdown 记忆。
- **Obsidian**：主要阅读和人工编辑界面。
- **Dashboard**：概览、跳转、导入、捕获和触发任务的快捷入口，不代替原生笔记。
- **本地服务**：转换、Feed、索引和后台任务；关闭 Obsidian 后停止，已有 Markdown 仍完整可读。

## 2. 自己写内容放哪里

| 场景 | 位置与做法 |
|---|---|
| 灵感、课程或项目想法、暂不确定归属 | Today 点“快速记录”，写入 `inbox/captures/YYYY/MM/`。可以选择已有 Course 或 Project，也可以不选；之后统一在 Inbox 整理。 |
| 日记正文 | Today 点“创建/继续写今日日记”或 Chinese Calendar，打开 `life/daily/YYYY/MM/` 中当天的 Daily。 |
| 一句话追加到今天 | 调用“记到今日日记”，直接追加到 Daily 的“随手记录”区域，不经过 Inbox。 |
| 独立感想 | 建立 `Reflection`，直接放 `life/reflections/`，不必经过 Inbox。 |
| 课堂记录 | 先选择已有 Course，再创建 `Lesson` 到课程的 `lessons/`。人工原文写在 notes 区。 |
| 项目当前状态 | `projects/<project>/project.md`。 |
| 项目过程 | 追加到 `projects/<project>/log.md`；它是纯 Markdown 时间日志，不使用 YAML。 |
| 重要项目决定 | 建立 `Decision` 到项目的 `decisions/`。 |
| 长期知识 | `knowledge/wiki/` 的 Wiki；多个 Wiki 需要主题导航时再维护 `knowledge/maps/` 的 Wiki Map。 |

日记、Lesson、Study Guide 等受管笔记把个人原文与 AI 可替换区分开。后台只改自己的 `ai:auto` 区域；希望永久保留的个人补充写在普通或 `human:notes` 区。

“快速记录”和“今日日记”不是同一个入口：前者是通用 Capture，适合尚未整理的灵感，
即使选择了 Course/Project 也仍留在 Inbox；后者属于当天的生活记录，不进入待处理队列。

## 3. 日记与生活

你可以直接自由写日记。需要整理时，在 Dashboard 点“整理今天”或对 Codex 说：

> 使用 `$organize-daily` 整理今天的记录，保留原文，只更新 organized-daily 区域。

系统不会自动改写原文，也不会从日记擅自推断长期偏好。明确的待办仍使用 Obsidian Tasks 语法 `- [ ]`；Tasks/Dataview 负责查询展示，YAML Contract 不复制它们的状态。

阶段复盘从 Dashboard → Life 点“新建 Review”，再选择 Weekly、Monthly 或 Yearly。系统直接
创建或打开当期 `life/reviews/<周期>/` Markdown，模板引导你回看进展、阻力、变化和下一周期；
不启动后台服务，也不要求 AI。也可以用 Templater 的“从模板新建笔记”选择 `Review`；Templater
只负责首次创建，同周期文件已存在时会拒绝重复创建，已有 Review 请从 Dashboard 打开。
终端或 Codex 也可使用 `okf note new review --period weekly|monthly|yearly` 创建或打开当期文件。

## 4. 导入 PDF、Word 或 PowerPoint

在 Dashboard 点“导入资料”，依次选择文件、解析策略、用途和归属：

1. **解析策略**
   - 默认：优先 MinerU，不可用时自动降级 MarkItDown；
   - 快速：直接使用 MarkItDown；
   - 设置可改为必须 MinerU，或全局始终 MarkItDown。
2. **用途**
   - 学习并现在生成 Study Guide；
   - 学习但稍后生成；
   - 直接生成 Wiki；
   - 只保存为参考；
   - 暂未决定。
3. **归属**
   - 从已有 Course 或 Project 中选择；
   - 无明确归属时保持独立用途；若生成 Study Guide，它进入通用 `learning/guides/`。

成功后形成：

```text
Original Store 原件
→ sources/records/<kind>/...（Source）
→ sources/text/<kind>/...（Source Text）
→ 可选 Study Guide 或 Wiki
```

Source 的 `resource/kind/text` 只描述来源身份与正文位置。你的用途和归属写在
`uses[]` 中，每项包含 `purpose` 以及可选的 `course/project`；同一原件以后可以再用于
另一个课程或项目，而不会复制或改写 Source 身份。

转换进度和错误只在 Runtime State；目标笔记只在真正生成成功后发布。完成通知和 Dashboard 卡片都提供打开链接。

## 5. 网页剪藏

浏览器安装官方 Obsidian Web Clipper 后，导入 Vault 中的
`system/integrations/web-clipper/workspace-web-capture.json`。Interpreter 保持关闭；
模板只把网页全文、选区或高亮写成 `ingested_via: web-clip` 的 Capture，不在浏览器
保存本地 API token，也不调用 AI。

之后在 Dashboard → Inbox 的“网页剪藏”中选择：

- 立即学习：发布 Source + Source Text，并排队生成 Study Guide；
- 稍后学习：在 `uses[]` 增加 `purpose: study`，不创建空白 Guide；
- 生成 Wiki：发布后排队生成 Wiki；
- 仅作参考：在 `uses[]` 增加 `purpose: reference`，不调用 AI；
- 丢弃：保留到 Capture archive。

不做选择就保持 open Capture，这本身就是“稍后决定”，不需要额外按钮或状态。
同一 URL 会忽略 fragment 和常见跟踪参数进行去重；重复选区/高亮合并到 Source
Text。图片先用远程链接快速发布，再在后台安全下载到 `sources/assets/`；失败不阻塞。
完整配置见 [Web Clipper 接入](WEB-CLIPPER.md)。

## 6. 学习完整流程

### 学习前

Study Guide 位于 `learning/guides/` 或对应课程的 `guides/`。两种生成方式使用同一套 Contract：

- **后台生成**：Dashboard 创建可恢复任务；可切换页面，完成后通知。
- **在 Codex 中生成**：打开可见会话，附带来源和 `$prepare-study-guide`，你可补充要求后发送。

选择“稍后生成”只保存一项 `uses[].purpose: study`，不创建空白目标。以后可从 Learning 的“待生成”卡片点击，也可直接对 Codex 说：

> 使用 `$prepare-study-guide`，根据这份 Source 和 Source Text 生成 Study Guide。

### 学习中

阅读 Study Guide，必要时打开 Source Text 或原件，在 Codex 中追问和实践。值得长期保留的一轮讨论结束后说：

> 使用 `$update-study-guide` 整理以上对话，增量完善当前 Study Guide。

Codex 读取现有内容、来源和本轮结论，补充解释、例子、纠错、已解决与未解决问题，不从头覆盖个人笔记。

### 学习后

完成学习后说：

> 使用 `$distill-wiki` 从这次学习生成或更新 Wiki；我已经完成学习。

Codex 会先检索已有 Wiki，选择新建、更新、合并或拆分，并在你明确声明完成时写 `studied_at`。如果材料有价值但你不想学习，也使用同一个 `$distill-wiki` 直接形成 Wiki；此时不写 `studied_at`。主题 Wiki 足够多且关系需要导航时，再调用 `$maintain-wiki-map`。

## 7. AI Daily 与树洞

Today 把 AI Daily 与树洞分成两个独立、单列、有限高度并可内部滚动的区域。Dashboard 展示全部条目的关键摘要；完整正文、评论和判断在 Obsidian 原生 Digest 中阅读。

系统不替你计算兴趣或价值。每条由你选择：现在学习、稍后学习、直接形成 Wiki、只保存参考或不保留。对应的长期决定写入 `Source.uses[]`，`purpose` 为 `study / wiki / reference`，并可携带明确选择的 Course/Project。同一 Source 可以有多个上下文用途。暂时不能决定时直接离开即可：条目仍在 Feed 和原生 Digest 中，不产生决定回执、Source 或 `undecided`。选择“现在”会额外启动后台任务；选择“稍后学习”不会制造空白 Study Guide/Wiki。

详见 [Feed 人工判断流程](FEED-WORKFLOW.md)。

## 8. 在新 Codex 对话中使用既有知识

Vault 根目录 `AGENTS.md` 负责轻量路由。需要结合既有笔记、继续课程/项目、查找历史决定或回答个人化问题时，Codex 使用 `$retrieve-vault-context`，底层等价于：

```powershell
okf context "你的问题" --scope auto --json
```

检索只定位候选，随后读取真实 Markdown。`actual_reads` 记录本轮真正读取的文件。向量索引损坏或不存在时仍可使用标题、标签和全文检索，不影响 Vault 权威数据。

## 9. 项目流程

1. 创建 Project，填写目标、约束和初始计划。
2. 执行期间随时讨论问题；需要记录时说“使用 `$capture-project-progress` 整理以上进度”。
3. Skill 增量追加 `log.md`，必要时更新 `project.md` 的当前状态；真正重要且可复用的选择拆成 Decision。
4. 项目中出现学习需求可调用 Study Guide Skills，出现长期知识可调用 Wiki Skills。

项目不建立重型状态机。`project.md` 是当前快照，`log.md` 是持久的过程记录，日常使用不依赖 Git。如果你需要额外的本地版本恢复，可以主动启用 Vault Git checkpoint。

## 10. Dashboard、模板和插件

- Dashboard 是首选目录与操作入口；Vault 根目录唯一 `index.md` 是手机端或 Dashboard 不可用时的结构化备用目录。
- Templater 适合人工主动创建并填充 Reflection、Review 等模板；Codex 不“调用 Templater”，而是直接遵守同一个 Contract/模板语义写文件。
- QuickAdd 可绑定高频 Dashboard/插件命令；不复制路径和 YAML 逻辑。
- Dataview、Tasks、Recent Files 直接读取 Vault，适合查询和阅读增强，无需与 Dashboard 建立双向状态同步。
- Chinese Calendar 与 Core Daily Notes 指向同一 Daily 模板和路径，不产生两套日记。
- Claudian 只提供 Obsidian 内可见 Codex 会话、上下文附件和交接界面；任务方法来自 Workspace Skills。

## 11. System 与多设备

System 展示本地服务、解析器、Codex、索引、后台任务、可选 Git checkpoint、备份、Contract、断链、陈旧 Wiki 和未复核 AI Wiki。Vault 默认不创建 Git 仓库；只有主动执行 `okf checkpoint` 选入后，后续自动化写入才生成本地 checkpoint。正常使用不需要反复校验；部署、迁移和专项审计才跑全库检查。

LiveSync 启用后，其他设备可阅读、搜索、写 Daily/Capture、编辑项目与学习内容，并查看已生成结果。本机不必一直开启 Obsidian 才能读取 Markdown；只有本机 Codex、MinerU/MarkItDown 转换、主机索引、后台任务和备份需要主机 Obsidian 运行。
