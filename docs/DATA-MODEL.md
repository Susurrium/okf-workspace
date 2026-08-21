# Workspace 数据模型与 YAML 3.0

## 1. 设计原则

系统采用两层模型：

1. **OKF 0.2 兼容层**：外部 Markdown 只要 YAML 可解析且 `type` 非空就可以被读取。未知类型、未知字段和断链不会导致通用消费失败。
2. **Workspace Profile v3**：系统自产文件必须匹配本地 Contract，包括路径、字段、枚举和正文区域。

这就是“宽容消费、严格生产”。唯一格式权威是 Vault 的 `system/contracts/base.yaml` 与 `system/contracts/<artifact>.yaml`。模板、Skills、Dashboard 和 Python/TypeScript 写入器都必须引用这套语义，不能各自发明 YAML。

## 2. 公共字段

所有受管 Artifact 只强制三个公共字段：

```yaml
type: Study Guide
title: 示例标题
created_at: 2026-08-20T12:00:00+08:00
```

| 字段 | 是否必填 | 作用 |
|---|---:|---|
| `type` | 是 | 决定 Contract、默认路径和展示方式。 |
| `title` | 是 | 人类阅读、Obsidian 跳转和 Dashboard 展示名。 |
| `created_at` | 是 | 创建时间；最近修改时间由文件 mtime 提供。Vault Git 只是可选的恢复能力，不是数据模型前提。 |
| `status` | 否 | 只表达内容生命周期：`draft` 或 `deprecated`；缺失即稳定。兼容读取显式 `stable`，新写入不生成它。 |
| `description` | 否 | 一句话摘要；Wiki 和 Wiki Map 必填。 |
| `resource` | 否 | 规范 URI；Source 必填。 |
| `tags` | 否 | 人工浏览和 Obsidian 搜索，不承担状态机职责。 |
| `aliases` | 否 | 真实存在的别名，空列表不写。 |
| `sources` | 否 | 当前内容使用的来源列表；空列表通常不写。 |
| `generated` | 否 | 仅标记无人审阅的后台 AI 长期内容。 |
| `verified` | 否 | 只记录真实发生的核验事件。 |
| `stale_after` | 否 | 只用于确实会随时间失效的知识。 |

`owner`、`updated_at`、`learning_status`、`study_material_status`、`generation_status`、`routing_status` 不属于 v3。排队、进度、失败和重试在 Vault 外 Runtime State 中保存。

所有更新必须保留不认识的扩展字段，保证 OKF 兼容性。

## 3. `status` 为什么可选

大多数正常笔记处于稳定可用状态，反复写 `status: stable` 没有信息增益。新文件只有两种情况写 `status`：

- `draft`：内容明确尚未完成，不能被当作成熟成果；
- `deprecated`：内容保留供追溯，但不应作为当前答案。

因此“字段缺失”不是“不知道状态”，而是 Profile 明确定义的正常稳定状态。Dashboard 和检索都用这一有效值工作。

## 4. 人工内容与 AI 内容

不使用 `human / mixed / derived` 细分。以下内容都视为用户拥有的正常内容，不加 AI 风险标签：

- AI 只做排版、格式化或按模板整理；
- 用户与 Codex 深入讨论后，主动要求更新 Study Guide；
- 用户明确发起生成并在可见会话中查看结果；
- 日记、Lesson、项目日志中的受控整理区。

只有“后台自主生成 + 长期复用 + 用户尚未检查”的 Wiki 才写：

```yaml
generated:
  by: process:codex-background
  at: 2026-08-20T12:00:00+08:00
```

用户或其它流程真的核验后才写：

```yaml
verified:
  - by: human:owner
    at: 2026-08-21T09:00:00+08:00
```

`generated` 是提醒，不是审批门槛。Dashboard 仅在存在 `generated` 且没有相应人工核验时显示“AI 自动生成 · 未复核”。

## 5. 学习完成语义

Study Guide 与 Wiki 可选：

```yaml
studied_at: 2026-08-20T18:30:00+08:00
```

它只在用户明确说“学完了、掌握了、完成学习”时写入。缺失表示没有明确完成记录，不代表 AI 判断用户没有理解。生成材料、打开笔记、对话或答题都不得自动产生 `studied_at`。

## 6. 最终 Artifact 集合

| `type` | 默认位置 | 专属语义 |
|---|---|---|
| `Capture` | `inbox/captures/YYYY/MM/` | `capture_status: open/processed/discarded`；Workspace 新写入含 `ingested_via`，网页剪藏另含 `resource`。 |
| `Daily` | `life/daily/YYYY/MM/` | 必填 `date`；含 `linked-activity`、`organized-daily` 区域。 |
| `Reflection` | `life/reflections/` | 用户自由反思正文。 |
| `Review` | `life/reviews/` | 阶段复盘；可含 `organized-review`。 |
| `Project` | `projects/<project>/project.md` | `project_status: active/paused/completed`；正文保留 `project-current-state`。 |
| `Decision` | `projects/<project>/decisions/` | 必填 `decided_at`，路径表达所属项目。 |
| `Course` | `learning/courses/<course>/course.md` | `course_status: active/paused/completed`。 |
| `Lesson` | `learning/courses/<course>/lessons/` | 必填 `lesson_at`；人工笔记与 `organized-lesson` 分区。 |
| `Study Guide` | `learning/guides/` 或课程 `guides/` | 可选 `course/project/sources/studied_at`；含人工 `notes` 与 AI `study-material`。 |
| `Wiki` | `knowledge/wiki/` | 必填 `description`；可选关联、学习、生成、核验和失效信息。 |
| `Wiki Map` | `knowledge/maps/` | 必填 `description`；只做主题导航和 Wiki 关系组织。 |
| `Digest` | `feeds/<feed>/YYYY/` | `feed/digest_id/issued_at/items`；原生可读 Feed 合刊。 |
| `Source` | `sources/records/<kind>/` | 必填 `resource/kind/text/uses`；身份与用途分离。Workspace 新写入含 `ingested_via`，可选 `sha256/feed_item/digest`。 |
| `Source Text` | `sources/text/<kind>/` | `parser/sources` 和转换后的完整 Markdown。 |
| `Profile` | `self/` | 用户明确维护的能力、偏好、方向、限制和当前状态。 |
| `Agent Policy` | `system/policies/` | AI 工作边界。 |
| `System View` | `system/views/` | Obsidian 原生查询与导航视图。 |

类型不再带无意义的 `Note` 后缀。`Wiki Map` 不按周期自动生成；当某主题已有多个 Wiki、关系需要导航，或用户明确要求时，由 `maintain-wiki-map` 创建或更新。

## 7. Source 流水线

```text
Original（Vault 外原件）
  → Source Pair
      ├─ Source（来源身份、出处、Source Text 链接和 uses[]）
      │   ├─ purpose: study     → Learning / Study Guide
      │   ├─ purpose: wiki      → Knowledge / Wiki
      │   ├─ purpose: reference → 保留 Source Pair，不生成语义成果
      │   └─ purpose: undecided → Inbox 等待人工决定
      └─ Source Text（MinerU、MarkItDown、网页或 Feed 的完整 Markdown）
```

Source 的身份字段不表达课程、项目或处理结果：

- `resource`：规范化后的真实来源 URI；本地导入也会得到稳定 URI；
- `kind`：来源类别或技术类型，用于路径、展示和解析；
- `text`：唯一对应的 Source Text Vault 路径；
- `ingested_via`：首次进入 Workspace 的渠道，只记录来源沿革。

因此 Source 的身份/定位必填字段是 `resource/kind/text`，与处理选择无关；人工决定另放在
同样必填的 `uses` 列表中。每一项是一个可长期复用的用途，可附带用户明确选择的 Course
或 Project：

```yaml
type: Source
title: 示例资料
created_at: 2026-08-20T12:00:00+08:00
resource: https://example.com/article
kind: web
text: /sources/text/web/example.md
ingested_via: web-clip
uses:
  - purpose: study
    course: /learning/courses/example/course.md
  - purpose: reference
    project: /projects/example/project.md
```

`uses[].purpose` 只有四种：

- `study`：该上下文需要 Study Guide，成果进入 Learning；
- `wiki`：该上下文需要长期 Wiki，成果进入 Knowledge；
- `reference`：只保留 Source 与 Source Text，不触发语义生成；
- `undecided`：该上下文还没有决定，显示在 Inbox。

同一个 Source 可以同时服务多个 Course、Project 或独立场景。系统按
`purpose + course + project` 这一完整组合幂等写入：重复点击同一选择不会产生重复项，
在另一个上下文作出的选择也不会覆盖既有用途。Course 与 Project 都是可选的真实 Vault
路径；没有归属时不写空字段。

`undecided` 表示某个上下文缺少决定，而不是永远保留的第二用途。写入正式的
`study/wiki/reference` 决定时，系统只清理被这次决定覆盖的 `undecided`：无上下文的
待决定项，或其 Course/Project 与新决定相符的待决定项。其它上下文的待决定项和所有
已经确认的用途保持不变。

“现在生成”和“稍后生成”是操作时机，不是长期 YAML 状态。前者额外创建后台 Operation；后者只保留 Source，Dashboard 从真实文件动态汇总待处理项。

`ingested_via` 只描述 Capture/Source 这个 Artifact 最初如何进入 Workspace：

- `web-clip`：Obsidian Web Clipper；
- `file-import`：用户上传本地文件，和 PDF/Word/Markdown 格式无关；
- `feed`：AI Daily、树洞等 Feed；
- `direct-entry`：Dashboard、QuickAdd 或人工直接记录。

`ingested_via` 不代替 `kind`（技术格式）、`resource`（真实来源）、`parser`（转换器）
或 `uses`（用户决定的用途与上下文）。本系统的新写入器必须产生 `ingested_via`；确实
无法判断的历史或外部 Artifact 保持缺失，Dashboard 显示“未标注”，不虚构 `unknown`。
同一个可规范化网页 URL 跨 Web Clipper 与 Feed 重复出现时复用原 Source，
`ingested_via` 永远保留首次进入渠道，不随之后的处理动作改变。

## 8. 正文区域

受管区域用于保护人工原文和实现可重复写入：

```markdown
<!-- human:notes:start -->
用户原始内容
<!-- human:notes:end -->

<!-- ai:auto:start name="study-material" -->
辅助学习材料
<!-- ai:auto:end name="study-material" -->
```

后台 Worker 只能原子替换自己的 `ai:auto` 区域。交互式 Codex 在用户明确授权时可以修改目标范围，但必须保留原文、未知 YAML、引用和既有链接。

## 9. 校验与陈旧判断

- **Standard**：检查 OKF YAML 与非空 `type`，宽容未知类型和字段。
- **Profile**：额外检查 Contract、路径、必填字段、类型、枚举、引用和正文区域。
- `stale_after` 在当天日期大于或等于该值时视为陈旧；系统只提示，不自动删除或重写。

普通编辑只做必要的局部校验；部署、迁移和 System 审计执行全 Vault Profile 校验。
