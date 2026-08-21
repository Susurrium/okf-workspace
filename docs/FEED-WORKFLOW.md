# AI Daily 与树洞人工判断流程

## 1. 数据进入方式

AI Daily 和 PkuHoleObserver 继续作为外部生产者。工作区通过只读 SSH 获取最终 Markdown 或 JSON/ZIP 快照，原始 Feed cache 放在 Vault 外的 `Runtime State/feed-cache/`。同步不会确认、移动或删除远端文件。

用户打开一期内容时，系统才创建 Obsidian 原生 `Digest`：

- `feeds/ai-daily/YYYY/<digest>.md`
- `feeds/treehole/YYYY/<digest>.md`

Dashboard 展示该期全部条目，每条只显示关键摘要和必要元数据；两个 Feed 分区独立、单列、有限高度并可内部滚动。完整正文、评论和人工判断仍在原生 Digest 中完成。

## 2. 判断权属于用户

系统不显示 AI 兴趣分、价值分或默认建议。用户做两层判断：是否愿意学习，以及即使不学习是否具有长期价值。

```text
想学习
├─ 现在生成 Study Guide → Source + Source Text → 后台生成
└─ 稍后生成             → Source + Source Text（uses[] 增加 study）

不想学习
├─ 直接形成 Wiki         → Source + Source Text → 后台生成 Wiki
├─ 只保存资料             → Source + Source Text（uses[] 增加 reference）
└─ 不保留                 → 只在 Runtime State 记住界面决定

暂时不能决定             → Source + Source Text（uses[] 增加 undecided）→ Inbox
```

界面操作值保持为 `learn-now / learn-later / wiki-now / source-only / ignore / later`；它们表示“本次要执行什么”，不是长期 YAML 状态。真正持久的人工决定写入 `Source.uses[]`：

```yaml
uses:
  - purpose: study
    course: /learning/courses/example/course.md
  - purpose: reference
    project: /projects/example/project.md
```

一个 Feed 条目与 Web Clipper 或其它 Feed 指向同一真实来源时，会复用同一 Source。每个
`purpose + course + project` 组合只记一次，因此可以在多个 Course/Project 中使用同一来源，
也不会因重复点击产生重复用途。从“稍后决定”改为正式决定时，只移除这一上下文被覆盖的
`undecided`，不会删除其它课程、项目或已确认用途。

## 3. “现在”与“稍后”

- “现在生成”先原子保存 Source 和 Source Text，再创建 Semantic Operation，并立即给 Dashboard 返回任务编号。
- “稍后生成”不创建空白 Study Guide 或 Wiki。Learning 从 `uses[].purpose: study` 且尚无目标成果的真实 Source 汇总“待生成”；Inbox 只汇总 Capture 和 `undecided` 用途。用户以后可在 Dashboard 启动生成，也可在可见 Codex 会话中调用对应 Skill。
- `study` 生成的成果进入 Learning，`wiki` 生成的成果进入 Knowledge，`reference` 不创建 Study Guide 或 Wiki。
- 后台状态 `queued → running → completed|failed` 只存在 Runtime State。
- 完成后卡片直接显示目标链接并发送通知；页面切换或重启不会重新变成“是否学习”。
- 失败保留 Source 和 Source Text，不留下失败占位笔记，可从卡片或 System 重试。
- 同一有效任务不会重复入队；只有用户明确要求重新生成才创建新操作。

后台生成 Study Guide 使用 `prepare-study-guide`；继续完善用 `update-study-guide`；直接形成长期知识用 `distill-wiki`。后台无人审阅 Wiki 会带 `generated` 标记，Study Guide 不因此被当成高风险 AI 内容。

## 4. CLI 调试入口

```powershell
uv run okf feed ingest ai-daily .\ai-daily-issue.json --content-map .\ai-daily-full-markdown.json
uv run okf feed ingest treehole .\treehole-batch.json
uv run okf feed list ai-daily
uv run okf feed open ai-daily 2026-08-17-news
uv run okf feed decide ai-daily "item-id" learn-now
```

日常使用优先 Dashboard 和 Obsidian 原生 Digest；CLI 仅用于批处理、测试与故障定位。
