# 每日更新、订阅阅读与人工判断流程

## 1. 数据进入方式

AI Daily 和 PkuHoleObserver 继续作为外部生产者。AI Daily 使用专用只读 forced-command SSH alias 和 `feed-export.v1` 游标，从上次成功位置增量补齐所有期次；只有一页中的文档全部校验并写入本机 cache 后才推进本机游标。任一 stream 暂时失败时保留其它 stream 与 last-good 内容，断网后由下次计划任务从原游标补拉。PkuHoleObserver 继续获取 JSON/ZIP 快照。原始 Feed cache 放在 Vault 外的 `Runtime State/feed-cache/`；同步不会确认、移动或删除远端文件。

AI Daily 是内部生产器名称，不是一个单独的用户页面。它的三个 stream 在 Dashboard 中按真实用途分开：

- `hotspot` → Today 的“中国热点”；
- `news` → Today 的“AI 资讯”；
- `learning` → Reading 的“订阅阅读”，包括 RSS、周刊、教程和工具更新。

PkuHoleObserver 的 TreeHole 快照进入 Today 的“树洞热榜”。Today 只负责浏览三个最新的每日更新；Reading 使用同一套 Feed 期次、条目和判断界面浏览持续累积的订阅历史。Reading 不是第二个 Learning：只有用户明确选择“想学习”后，对应 Source 才会进入 Learning。

Reading 的订阅管理通过另一把专用 forced-command SSH alias 调用 `source-admin.v1`，不允许本机拼接或发送远端 shell 命令。新增来源必须先预览再确认；预览短期保存在 Runtime State，并绑定规范 URL 和 registry revision。确认、启用、停用和移除都使用 CAS revision 与 idempotency key。移除表示停止后续抓取：有历史内容的来源卡继续保留并标为“已移除”，尚无历史的空卡从 Reading 消失。

`Runtime State/feed-producers.json` 中的新协议配置使用两项明确 alias；二者必须由 OpenSSH 配置绑定各自的远端 forced command，不能复用可执行任意命令的普通登录 alias：

```json
{
  "ai-daily": {
    "remote_kind": "ai-daily-bridge-v1",
    "feed_export_ssh_alias": "ai-daily-feed-export",
    "source_admin_ssh_alias": "ai-daily-source-admin"
  }
}
```

用户打开一期内容时，系统才创建 Obsidian 原生 `Digest`：

- `feeds/ai-daily/YYYY/<digest>.md`
- `feeds/treehole/YYYY/<digest>.md`

Dashboard 的 Today、Reading 和原生 Digest 复用同一种条目语义与判断结果，不各自维护一套动作。Today 中三个每日更新区域独立加载、独立显示各自最近一期，只预览前几条，完整一期直接打开原生 Digest；某一路当天没有更新或同步失败时，不会隐藏或阻塞其它来源。Reading 按稳定的 `source_id` 把订阅组织成来源卡片；卡片只摘要该来源最近一期，进入来源后才按期分页加载它的历史。旧缓存没有来源身份时统一归入“来源未标注”，不按文章链接域名误拆为多个订阅。完整正文、TreeHole 评论和人工判断仍在原生 Digest 中完成。

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

暂时不能决定             → 不操作；条目继续留在 Feed cache 和 Digest
```

界面只有 `learn-now / learn-later / wiki-now / source-only / ignore` 五个实际动作；它们表示“本次要执行什么”，不是长期 YAML 状态。未点击任何动作时不写决定回执、不创建 Source，也不写 `undecided`。真正需要保留资料时，人工决定写入 `Source.uses[]`：

```yaml
uses:
  - purpose: study
    course: /learning/courses/example/course.md
  - purpose: reference
    project: /projects/example/project.md
```

一个 Feed 条目与 Web Clipper 或其它 Feed 指向同一真实来源时，会复用同一 Source。每个
`purpose + course + project` 组合只记一次，因此可以在多个 Course/Project 中使用同一来源，
也不会因重复点击产生重复用途。复用的旧 Source 如果已经存在 Intake 创建的
`undecided`，正式决定只清理当前上下文被覆盖的待决定用途，不会删除其它课程、项目或已确认用途。

早期版本写入 Runtime State 的 `action: later` 仅作为只读历史回执兼容；界面可显示它并允许重新判断，但 API 和 CLI 不再接受这一动作。

## 3. “现在”与“稍后”

- “现在生成”先原子保存 Source 和 Source Text，再创建 Semantic Operation，并立即给 Dashboard 返回任务编号。
- “稍后生成”不创建空白 Study Guide 或 Wiki。Learning 从 `uses[].purpose: study` 且尚无目标成果的真实 Source 汇总“待生成”；Inbox 只汇总 Capture 和 Intake 中明确选择暂存的 `undecided` 用途。用户以后可在 Dashboard 启动生成，也可在可见 Codex 会话中调用对应 Skill。
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
