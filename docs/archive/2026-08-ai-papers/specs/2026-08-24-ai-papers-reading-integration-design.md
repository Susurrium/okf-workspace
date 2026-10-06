# AI Papers → Reading 集成设计

> 历史记录（2026-10-06 归档）。下文保留当时的方案、状态和验证证据，不作为当前实现要求；当前边界见[系统架构](../../../architecture/README.md#system-overview)，有效文档见[文档索引](../../../README.md)。

状态：等待用户复核  
日期：2026-08-24  
涉及仓库：`E:\code\aidaily`、`E:\code\okf-workspace`

## 1. 背景

AI Daily 生产端已经抓取并保存 `ai_papers`：每次检测最新一期，只有发现新 issue 才产生
不可变 artifact；远端 Markdown 完整保留原期刊内容。目前 `feed-export.v1` 只允许
`hotspot`、`news`、`learning`，所以本机 OKF 没有收到 papers，Reading 也没有对应卡片。

现有 AI Daily 导出游标是跨 collection 的全局游标。旧客户端在只请求三条流时，也会跨过
未选择的 papers artifact 并推进游标。因此，单纯把 `papers` 加进主同步请求不能回补历史；
倒退主游标又会重放全部历史三流，并把 papers 解析失败与每日 Today/Reading 同步绑定在一起。

## 2. 目标

1. `ai_papers` 通过 `feed-export.v1` 以独立 `papers` stream 导出。
2. Reading 顶部显示一个固定的“AI Papers of the Week”系统卡片。
3. 卡片显示最新一期的全部论文，并在有限高度内滚动；视觉骨架、条目动作和错误状态与现有
   Feed 卡片一致。
4. 每篇论文继续使用现有五种人工判断；只有用户点击后才创建 Source、Study Guide 或 Wiki。
5. 历史 papers 自动、安全回补，同时不倒退或替换现有三流主游标。
6. papers 的生产、同步、解析或展示失败不阻塞 hotspot/news/learning。
7. Today 永远不显示 papers。

## 3. 非目标

- 不把 papers 伪装成 `learning` 订阅来源。
- 不让 papers 出现在添加订阅、搜索订阅、启停或移除界面。
- 不给 papers 建立 Registry mirror 或 Learning source catalog 条目。
- 不翻译、重写、LLM 筛选或重新排序论文。
- 不在本次实现通用“任意内容通道”框架。
- 不修改或接管服务器上现存的 `obsidian-workflow-ai-daily-itemizer` 旁路。

## 4. 核心架构决定

### 4.1 独立 stream，固定系统卡片

生产端新增映射：

```text
ai_papers → papers
```

`papers` 是 `feed-export.v1` 的新增合法 stream。协议名称和信封保持 v1；旧客户端继续只请求
三条旧流，服务端只返回它请求的 documents 与 stream health，因此旧客户端无需理解 papers。

papers 不进入 Learning Registry。OKF 为论文条目使用固定系统来源身份：

```text
source_id   = system:ai-papers-of-the-week
source_name = AI Papers of the Week
```

### 4.2 独立、持续的 papers 游标

现有主同步及其游标保持原样，只负责：

```text
hotspot + news + learning
```

新增一个持续使用的 papers 导出游标，而不是一次性重置主游标：

```text
Runtime State/feed-sync/ai-daily-papers-export-cursor.json
```

该同步每次只请求 `streams: ["papers"]`。首次启用时从 `after: null` 扫描全局 artifact 序列，
自动得到全部历史 papers；以后从自己的 cursor 继续增量扫描。即使某一页没有 papers 文档，
只要远端返回的 `next_cursor` 前进，本机也必须持久化它，否则会反复扫描同一批非 papers
artifact。

游标记录包含：

- schema version；
- producer alias fingerprint；
- 当前远端 cursor；
- `updated_at`；
- 首次追平远端时的 `bootstrap_completed_at`；
- 已写入的 papers artifact 总数。

papers 同步与主同步共用本机 `.ai-daily-export.lock` 和同一 FeedCache。每页只有在所有 papers
文档完成 hash、大小、格式校验并写入 cache 后才推进 papers cursor。papers 失败只记录
`stream="papers"` 的故障，主三流仍可成功提交自己的 cursor。

本机 `feed-producers.json` 增加显式开关：

```json
{
  "ai-daily": {
    "papers_enabled": true
  }
}
```

字段缺失或为 `false` 时保持当前三流行为。字段非 boolean 时配置校验失败，不做猜测。

### 4.3 稳定身份而非“日期即身份”

导出 document 的 `cursor.artifact_id` 是不可变生产身份。本机 parser 必须接收该身份，并生成：

```text
edition_id = <issued-date>-papers-<sha256(artifact_id) 前 12 位>
item_id    = ai-daily:papers:<sha256(canonical-paper-url) 前 24 位>
```

这样同一天的两个不同 artifact 不会覆盖同一个 cache 文件或 Vault Digest；同一 artifact
重放仍然幂等；同一论文在以后一期再次出现时继续复用原判断结果。

原生 Digest 文件名使用完整 `edition_id`，例如：

```text
feeds/ai-daily/2026/2026-08-17-papers-a1b2c3d4e5f6.md
```

## 5. 生产端改动（AI Daily）

1. 在 collection → stream 映射中加入 `Collection.AI_PAPERS: "papers"`。
2. `feed-export.v1` 的 stream allowlist 接受 `papers`。
3. `streams:["papers"]` 返回 papers documents 和单独的 papers health。
4. 旧三流请求的结果字段和字节语义保持兼容，不额外注入 papers document 或 health。
5. feed-export 的 Registry 投影继续只包含 `ai_learning` 来源；`ai-papers-of-the-week` 不进入
   Registry mirror。
6. 不改变现有 papers producer、outbox、archive、seen 和 `no_new_issue` 行为。

## 6. 本机 Engine 改动

### 6.1 远端客户端与同步

- `RemoteFeedPuller.feed_export()` 接收受限的显式 streams 参数。
- 主同步继续传 `hotspot/news/learning`。
- papers 同步传唯一的 `papers`，使用独立 cursor 文件。
- stream health 校验按本次请求的 expected streams 工作；健康状态写入时按 stream 合并，不能
  让 papers 更新覆盖三条旧流，反之亦然。
- papers 同步失败保留最后一次成功的卡片内容和 health；主三流同步结果不回滚。

### 6.2 专用确定性 parser

新增 `ai_papers_markdown_from_v1(markdown, artifact_id)`，不复用只识别编号二级标题的通用
AI Daily parser。它必须：

1. 校验 YAML frontmatter 中唯一、规范的内容日期。
2. 识别当前 issue 标题和排行榜 Markdown 表格。
3. 每个有效排行必须恰好对应一个 `[Paper](HTTP(S) URL)`。
4. 排名从 1 开始、唯一且连续；缺失、重复或跳号均失败。
5. 保留全部论文标题、完整描述、排名和论文 URL，并保持上游顺序。
6. 为每个 item 写入固定系统 `source_id/source_name`，把排名放入 `metrics.rank`。
7. 若出现疑似论文行却无法解析、表格为空、日期缺失或 URL 非法，整份 document 失败。

远端 archive/outbox 仍是字节级完整保存的权威副本；OKF native Digest 是语义完整投影，而不是
原 Markdown 的逐字复制。验收要求是每个排行条目的标题、描述、排名和 URL 全部存在且顺序一致；
已知包装提示、表头和分隔线可以由 OKF 原生 Digest renderer 重建。

### 6.3 Cache、API 与 Today 边界

- papers edition 写入普通 AI Daily FeedCache，但不更新 learning source catalog。
- `/dashboard/feeds/summary` 新增可选字段 `ai_papers`，返回最新 papers edition 的全部 items；
  原有 `ai_daily` 数组语义保持不变，便于旧 Dashboard 忽略新增字段。
- Today 只允许 `hotspot`、`news` 和独立 TreeHole。所有“最新 AI Daily”兼容字段也必须显式
  从允许的 Today streams 选择，不能让较新的 papers cache 成为 Today 默认最新期。
- `/dashboard/feeds/subscription-sources` 及其分页接口继续只处理 learning，不返回 papers。
- 打开 papers edition 复用现有 Digest materialization 和 item decision API。

## 7. Dashboard 设计

Reading 的固定 papers 卡放在普通订阅来源网格之前，并复用现有 Feed 卡片的：

- 标题、元信息和状态布局；
- 有界高度与纵向滚动容器；
- 条目标题、摘要、链接和五种人工判断；
- “打开本期原生笔记”动作；
- last-good 内容与同步错误提示。

差异只来自其系统属性：

- 固定标题“AI Papers of the Week”；
- 显示当前 issue 标题、日期和论文总数；
- 卡内可滚动查看本期全部论文，而不是只显示前三条；
- 没有设置、启用、停用、移除或“更多订阅操作”；
- 不参与订阅来源搜索和分页；
- 尚未完成首次 papers 同步时显示稳定的等待状态，而不是隐藏卡片。

`AiDailyStream` 增加 `papers`，但 Today 渲染器继续使用显式的 Today stream allowlist，不能靠
“忽略未知 stream”维持边界。

## 8. 错误处理与安全边界

- 远端 document 仍必须通过 basename、UTF-8 大小、SHA-256、cursor 单调性和 Markdown
  结构校验。
- 任一 papers 文档无效时，本页 papers documents 均不写入，papers cursor 不推进。
- 论文 URL 只能为无 credentials 的 HTTP(S) URL；fragment 不进入公开投影。
- papers 不包含用户订阅 URL，因此不改变 source-admin 的订阅隐私契约。
- Dashboard 不直接解析原 Markdown，也不直接读取远端或持有 SSH key。
- 重放不会自动物化 Vault Digest，也不会自动执行任何人工判断。

## 9. 部署与回滚顺序

1. **先部署 AI Daily producer/exporter**：加入 papers stream；分别验证旧三流请求和仅 papers
   请求。旧 OKF 此时仍只请求三流。
2. **部署 OKF Engine**：包含 parser、独立 cursor、API 和 feature flag；保持
   `papers_enabled` 缺省为 false。
3. **启用并回补**：把生产 `feed-producers.json` 的 `papers_enabled` 设为 true，手动执行一次
   Feed Sync；核对远端 papers artifact 数、本机 cache 数、papers cursor 和主 cursor 未变化。
4. **部署 Dashboard 并重载 Obsidian**：验证固定卡、全部条目滚动、打开 Digest 和判断动作。
5. 至少保留一个发布窗口的旧三流协议 smoke test。

回滚时把 `papers_enabled` 设为 false，并回滚 Dashboard/Engine；保留已经写入的 papers cache
和独立 cursor，不删除、不倒退三流主 cursor。远端 v1 的新增 stream 对旧客户端兼容，可保留。

## 10. 测试与验收

### AI Daily

- 旧三流 request 仍只返回三流 documents/health。
- `streams:["papers"]` 返回正确 document、hash、size、issued_at 和 papers health。
- 未选择 papers 时全局 cursor 仍按既有协议推进。
- Registry mirror 始终不含 papers 系统来源。

### Engine

- 真实 papers fixture 完整解析全部排行，稳定生成 edition/item ID。
- 缺失/重复/跳号、无 Paper 链接、非法 URL、无日期、疑似未解析论文行均失败。
- 预置主 cursor 已越过历史 papers 时，独立 papers cursor 仍可从 null 回补历史。
- 空 documents 页仍推进 papers cursor；重复同步幂等。
- papers 解析失败不改变 papers cursor，也不阻止同轮主三流成功。
- 同一天两个不同 artifact 生成不同 cache edition 和不同 Digest 路径。
- feed summary 有 `ai_papers`；subscription source API 没有 papers。
- Today API 即使 papers 是最新 cache 也不返回 papers。

### Dashboard

- Reading 总是有一个固定 papers 卡，且无订阅管理按钮。
- 最新一期全部论文在卡内滚动显示。
- 点击可打开唯一的原生 Digest；五种人工判断复用现有回执与完成态。
- papers 错误保留 last-good 内容；等待、空、错误状态可区分。
- Today 不出现 papers；普通 Reading 来源卡、搜索和分页行为不变。

### 发布 smoke test

1. 旧三流 feed-export 请求成功。
2. papers-only feed-export 请求成功。
3. 首次本机同步回补当前全部历史 papers，且三流主 cursor 字节内容不变。
4. 第二次同步无重复 cache、无重复 Digest、无重复决定回执。
5. Obsidian 重载后 papers 卡和历史判断仍存在。

## 11. 规格自审结论

- 无 TBD/TODO 或未决产品选项。
- papers 的订阅身份、游标、edition 身份、Today 边界和回滚策略均明确。
- 跨仓库接口只扩展现有 v1 stream allowlist，不引入新服务或开放网络端口。
- 实现范围聚焦于 papers 导出、同步、解析和 Reading 展示，不包含无关前端重构。
