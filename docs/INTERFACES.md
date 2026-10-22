# 接口与集成

[文档入口](../README.md#文档入口) · [架构与数据](architecture/README.md) · [部署配置](DEPLOYMENT.md)

本文维护公开协议与调用约定；模块职责见架构，Artifact 格式见 Contracts。

按需阅读：[API](#领域-api) · [转换协议](#conversion) · [Feed](#feeds) · [CLI](#cli) · [Claudian Bridge](#bridge) · [插件命令](#commands) · [Web Clipper](#web-clipper)。

## 本地 API 生命周期

Dashboard 持有本地 Engine，使用 `--exit-on-stdin-close` 随标准输入关闭退出。
常规启停见[开发指南](DEVELOPMENT.md#更新与启停)；独立诊断先停止受管测试服务，再使用匹配测试配置：

```powershell
uv run --project engine okf-server --config '<测试 State>\config\deployment.json'
```

调试结束退出手动进程后再恢复受管启动。首次 token 写入 State 的 `secrets/local-api-token`。
Vault 读取、原生写入与 Engine 命令的归属见[模块边界](architecture/README.md#module-boundaries)。

## 鉴权与路径

- `/health` 无需 token，只返回服务状态；
- 其他接口要求 `Authorization: Bearer <random-token>`；
- 服务器拒绝绑定非 loopback 地址；
- 浏览器跨域只放行 Obsidian 桌面渲染器等明确的本地来源、`GET/POST/OPTIONS` 和 `Authorization/Content-Type/X-OKF-Vault-Fingerprint`；其他来源的预检会被拒绝；
- API 返回 Vault 相对路径，不返回 Original 绝对路径、token 或 Runtime export 路径；原件访问使用 Source 中已有的 SHA-256 标识；
- 完整异常和转换工作目录只进入本地日志；
- token 放在 Vault 外，不经 LiveSync。

Dashboard 向 Engine 发起写入时附带当前 Vault fingerprint；Engine 拒绝身份不一致的写入，防止落入另一个 Vault。

## 领域 API

| 方法与路径 | 用途 |
|---|---|
| `GET /health`、`GET /workspace/identity` | 服务状态（无需 token）与鉴权后的 Vault fingerprint |
| `GET /today` | 从真实 Markdown 和可重建状态生成 Today |
| `GET /dashboard/{area}` | Inbox、Learning、Projects、Knowledge、Life 投影 |
| `GET /dashboard/feeds/summary` | 最新 Feed 全部条目的紧凑摘要，不返回全文 |
| `POST /daily`、`POST /captures`、`POST /reflections` | 创建人工笔记入口 |
| `POST /captures/publish-web` | 将 Web Capture 确定性发布为 Source + Source Text，并按四个离散人工动作选择是否生成 |
| `POST /courses`、`POST /lessons`、`POST /projects` | 创建课程、课堂笔记和项目 |
| `POST /projects/{slug}/log` | 追加项目进展 |
| `POST /projects/{slug}/category` | 设置或清除项目类别；可携带 `expected_category` 与 `check_expected: true` 拒绝覆盖旧值已变化的项目 |
| `POST /ai/ask` | 检索、读取真实章节并返回 `actual_reads` |
| `POST /ai/organize` | 把普通人工 Capture 的正文写入一个长期目标，成功后删除 Capture；Web Capture 必须走发布接口 |
| `POST /ai/lessons/organize` | 读取 Lesson，只更新 `organized-lesson` 区域；目标在生成期间变化时返回 409 |
| `POST /ai/projects/{slug}/summarize` | 读取 project/log 并刷新项目概览 |
| `POST /ai/learning/plan` | 从指定笔记生成 Study Guide，AI 内容写入 `study-material`；输入为 Source 时跟随读取 Source Text |
| `POST /ai/self-test` | 根据指定笔记返回自测题，不写入 Vault |
| `POST /ai/knowledge/create` | 从明确选择的材料创建 `status: draft` 的 Wiki；同名目标返回 409 |
| `POST /ai/section/rewrite` | 只改写指定章节；目标在生成期间变化时返回 409 |
| `POST /documents/import` | `action=store` 仅保存原件并登记 Source；`action=convert` 转换，旧调用缺省仍转换 |
| `POST /documents/sources/{source_path:path}/route` | 为已有 Source 记录明确用途，必要时复用正文生成笔记 |
| `GET /documents/originals/{sha256}/content?filename=...` | 认证读取本机 Vault 原件；本机缺失则等待 LiveSync |
| `POST /documents/originals/{sha256}/open?filename=...` | 已停用（410）；Dashboard 直接调用 Obsidian 原生打开 |
| `POST /documents/uploads/cleanup?apply=false` | 已停用（410）；全量同步原件不再自动清理 |
| `GET /documents/converters` | 读取默认方式、支持格式、配置状态与能力限制；不探测或启动服务 |
| `GET /documents/conversions?status=failed` | 列出转换失败任务 |
| `POST /documents/conversions/{id}/retry` | 不指定方式恢复原任务；指定 `method` 重新转换，执行中返回 409 |
| `GET /documents/conversions/{id}/result` | 只读返回本次 Markdown、QC、具体方式与附件路径 |
| `POST /semantic/operations` | 快速持久化一个后台学习材料或 Wiki 生成任务 |
| `GET /semantic/operations` | 列出后台语义任务 |
| `GET /semantic/operations/page`、`GET /documents/conversions/page` | 分页读取运行记录及其增量变化 |
| `GET /semantic/operations/{id}` | 读取真实阶段：`queued/retrieving/generating/publishing/indexing` |
| `POST /semantic/operations/{id}/cancel` | 停止检索或 Codex 子进程；进入发布阶段后不再接受取消 |
| `POST /semantic/operations/{id}/retry` | 从保留的来源和任务参数重新排队；目标尚未生成也可重试 |
| `GET /feeds/{feed}/digests`、`GET /feeds/{feed}/digests/{digest_id}` | Feed 期次列表与条目 |
| `POST /feeds/{feed}/digests/{digest_id}/prepare`、`POST /feeds/{feed}/digests/{digest_id}/open` | 准备 Digest 路径/正文或由 Engine 直接打开；Obsidian 按准备结果通过 Vault API 创建缺失文件 |
| `GET/POST /feeds/{feed}/items/{item_id}/decision` | 读取回执或提交五种人工决定 |
| `POST /feeds/sync` | 执行外部生产者增量同步 |
| `GET /feeds/subscriptions` | 获取远端订阅 registry 的本机镜像；离线时明确返回 stale/unconfigured 状态 |
| `POST /feeds/subscriptions/preview`、`POST /feeds/subscriptions/confirm` | 先安全发现并预览来源，再以 revision + idempotency key 确认添加 |
| `POST /feeds/subscriptions/{source_id}/enable\|disable\|remove` | 以 CAS revision 启停或明确确认移除订阅；移除保留历史状态 |
| `POST /index/sync`、`POST /index/rebuild` | 合并增量同步，或显式重建全文索引和任务投影 |
| `GET /changes/latest`、`POST /undo` | AI 改动摘要和可恢复撤销 |
| `GET /system/status` | 只返回用户可行动的系统问题 |

## 运行状态与超时

普通浏览不重复健康探测，明确写入动作检查一次，失败时恢复服务并提供可重试错误。
增量索引为 single-flight，未完成期间只合并为下一轮同步。转换目录只读配置，执行时才连接服务。

`POST /index/sync` 的可选 JSON body 为 `{"paths":["knowledge/wiki/example.md"]}`，最多 1000 个 Vault 相对文件或目录路径。
重命名同时提交旧、新路径；删除可提交已不存在的路径。空列表不更新文件，省略 body 或 `paths` 时核对整个 Vault。
路径在修改索引前统一校验，拒绝越界、绝对路径、Windows 设备名和 ADS。同步只更新有变化的内容，显式提交的文件会重新核验，
以覆盖时间、大小未变化的修改；完整重建继续使用 `/index/rebuild`。每轮问答统一刷新一次索引，最终上下文仍重新读取真实文件。

运行记录分页入口返回 `items`、`total`、`next_offset`、`version`、`index_id` 和 `requires_reset`。
`limit` 为 1–1000、默认 200，`offset` 默认 0；后续页携带首次返回的 `snapshot_version` 和 `snapshot_index_id`，
快照变化返回 409，调用方丢弃未完成的拼接结果后重新读取。`after_version` 与 `after_index_id` 可查询上次版本之后的记录；
索引恢复、记录删除或身份变化通过 `requires_reset: true` 返回完整替换快照。带 `status` 的增量请求也返回替换快照，
确保移出该状态的记录从结果中消失。既有数组列表入口及其状态筛选保持原有完整语义。

语义 Worker 不用心跳伪装进度：心跳只表示进程存活，Operation Record 的 `stage` 和
`stage_detail` 才表示当前步骤。每次检索和 Codex 生成都在可终止的子进程中执行；默认整项上限
600 秒、单次检索上限 12 秒，可通过部署配置中的 `semantic_timeout_seconds` 和
`semantic_retrieval_timeout_seconds` 调整。Worker 日志位于 Runtime State 的 `logs/semantic-worker-YYYYMMDD.log`。

`POST /projects` 可携带可选 `project_category`；详细语义见[项目类别](architecture/README.md#项目类别)。
CLI 创建使用 `okf note new project --slug <slug> --title <title> --category <类别>`；
修改使用 `okf project category <slug> --category <类别>`，空字符串清除。

<a id="conversion"></a>

## 转换协议与重试

`POST /documents/import` 增加可选 `method`，取值 `auto` 或上述三个方式 ID。
`auto` 在入队时固定为具体方式，改变默认配置不改变已有任务。
旧 `parser=mineru` 固定映射到云端，`parser=markitdown` 固定映射到 MarkItDown；
同时指定不一致的 `parser` 与 `method` 会被拒绝。接口与 CLI 都执行同一格式校验。

```powershell
okf import paper.pdf --intent source --method markitdown-service --quality high
okf conversion retry conv-EXAMPLE --method mineru-self-hosted
```

`POST /documents/conversions/{id}/retry` 不传方式时恢复原任务；传 `method` 时明确重新转换。
导出 manifest 和尝试记录保存具体方式。缓存必须匹配方式，云端/自建结果不会混用。
显式重新转换产生新的执行 revision，避免复用服务端旧幂等结果。
云端暂时失败仍使用兼容状态 `waiting-for-mineru`；其他转换服务使用 `waiting-for-parser`。
QC 失败记录为 `quality=failed`；只有 QC 通过且发布失败才可“继续保存”。
`GET /documents/conversions/{id}/result` 返回本次 Markdown、QC、方式及附件路径，供只读查看。

### 云解析与补充 OCR

Engine 先确保原件已保存到 Vault 的 `sources/originals/`。图片输入直接以 `is_ocr=true` 解析；PDF、PPTX 和 Word
先以 `is_ocr=false` 解析。Engine 使用结果包中的 `content_list.json` 按页或幻灯片生成 Markdown，
将图片作为 Vault 资产引用，不把图片数据放进 AI 文本提示词。

对有图片且可提取文字少于 50 字的页、完全没有文字的 PDF 页，
或 PPTX 中有图片占幻灯片面积三分之一以上的页，
自动补做 OCR。PDF 仅提交目标页范围；PPTX 优先提交嵌入的 PNG/JPEG 等原图，
原图为 TIFF 等不受 API 支持的格式时使用 MinerU 返回的 JPG/PNG；Word 使用结果包里的图片。
每份文件最多补识别 40 页，每页最多 4 张图片。补出的文字追加到相应页，
标明机器解析来源；不会覆盖原生文字、表格或备注。没有新增文字时保留图片和原件引用，
并使用相邻页文字给完全无正文的页提供简短检索线索。这个线索明确标记为相邻页内容，
不能作为该页原文引用。预算外页面也保留图片，并在 Markdown 标明待按需查看。

页级结构来自 MinerU 返回的可选元数据。如果它缺失，就保留 MinerU 的 `full.md`；
如果按页重排明显漏掉原始全文的文字，也保留 `full.md`，将补充识别结果单独列出。
自动规则只是筛出值得 OCR 的页，不保证识别完整；图示内容若仍不足，需要在实际分析该页时查看原图。

Engine 申请签名上传 URL，上传目标文件，按 `batch_id` 查询解析结果，下载 ZIP，
通过 QC 后发布 Source 与 Source Text。
云任务 ID 和上传阶段保存在 State 的转换工作目录。进程重启后继续查询原任务。
签名 URL 只临时保存在 State，上传成功后立即移除。

HTTP 限流、服务异常、网络中断和轮询超时进入延迟重试；认证错误、文件格式错误、
解析失败和结果结构错误进入失败状态，供用户检查后重试。重复提交的极短窗口
仍可能出现在云端接受请求与本地写入任务 ID 之间。
补充 OCR 的临时失败会延迟重试，确定失败则发布基础解析并记录警告。

<a id="feeds"></a>

## Feed 生产者与订阅协议

AI Daily 和 PkuHoleObserver 继续作为外部生产者。AI Daily 使用专用只读 forced-command SSH alias 和 `feed-export.v1` 游标，从上次成功位置增量补齐所有期次；只有一页中的文档全部校验并写入本机 cache 后才推进本机游标。任一 stream 暂时失败时保留其它 stream 与 last-good 内容，断网后由下次计划任务从原游标补拉。PkuHoleObserver 继续获取 JSON/ZIP 快照。原始 Feed cache 放在 Vault 外的 `Runtime State/feed-cache/`；同步不会确认、移动或删除远端文件。

四个导出 stream 分别路由：

- `hotspot` → Today 的“中国热点”；
- `news` → Today 的“AI 资讯”；
- `learning` → Reading 的“订阅阅读”，包括 RSS、周刊、教程和工具更新。
- `papers` → Reading 顶部固定的“AI Papers of the Week”系统卡片。

远端 `ai_papers` collection 映射到 `feed-export.v1` 的 `papers` stream，但不进入可管理的 learning Registry。它在本地使用独立的 `Runtime State/feed-sync/ai-daily-papers-export-cursor.json`，因此首次回填历史周刊和后续增量同步都不会移动原有的 `ai-daily-export-cursor.json`。论文卡片保留最新一期的完整排名、标题、说明和原始链接，不提供启用、停用或移除等订阅操作。

PkuHoleObserver 的 TreeHole 快照进入 Today 的树洞热榜。界面操作见[订阅阅读](USER-GUIDE.md#订阅阅读)。

Reading 的订阅管理通过另一把专用 forced-command SSH alias 调用 `source-admin.v1`，不允许本机拼接或发送远端 shell 命令。新增来源必须先预览再确认；预览短期保存在 Runtime State，并绑定规范 URL 和 registry revision。确认、启用、停用和移除都使用 CAS revision 与 idempotency key。移除表示停止后续抓取：有历史内容的来源卡继续保留并标为“已移除”，尚无历史的空卡从 Reading 消失。

`Runtime State/feed-producers.json` 中的新协议配置使用两项明确 alias；二者必须由 OpenSSH 配置绑定各自的远端 forced command，不能复用可执行任意命令的普通登录 alias：

```json
{
  "ai-daily": {
    "remote_kind": "ai-daily-bridge-v1",
    "feed_export_ssh_alias": "ai-daily-feed-export",
    "source_admin_ssh_alias": "ai-daily-source-admin",
    "papers_enabled": false
  }
}
```

`papers_enabled` 缺省或为 `false` 时保持旧行为；确认远端导出器已经支持 `papers` 后才能改为 `true`。回滚时只需重新设为 `false`，不要删除 papers cache、papers 游标或主游标。

用户打开一期内容时，系统才创建 Obsidian 原生 `Digest`：

- `feeds/ai-daily/YYYY/<digest>.md`
- `feeds/treehole/YYYY/<digest>.md`

Today、Reading 和 Digest 共享条目与决定身份。三个每日 stream 独立加载和保存 last-good，Today 排除 learning/papers。
普通订阅按稳定 `source_id` 分组；旧缓存缺身份时归入“来源未标注”，不根据文章域名拆分来源。

### 决定与后台交接

界面与 API 接受 `learn-now / learn-later / wiki-now / source-only / ignore` 五种动作。兴趣、学习和长期价值由用户判断；不操作不创建 Source 或待决定用途。`action: later` 只读兼容历史回执，API/CLI 不再接受。长期用途与上下文幂等规则见[Source 与用途](architecture/README.md#source-与用途)。

- “现在生成”先原子保存 Source 和 Source Text，再创建 Semantic Operation，并立即给 Dashboard 返回任务编号。
- “稍后生成”不创建空白 Study Guide 或 Wiki。Learning 从 `uses[].purpose: study` 且尚无目标成果的真实 Source 汇总“待生成”；Inbox 只汇总 Capture 和 Intake 中明确选择暂存的 `undecided` 用途。用户以后可在 Dashboard 启动生成，也可在可见 Codex 会话中调用对应 Skill。
- `study` 生成的成果进入 Learning，`wiki` 生成的成果进入 Knowledge，`reference` 不创建 Study Guide 或 Wiki。
- 后台状态 `queued → running → completed|failed` 只存在 Runtime State。
- 完成后卡片直接显示目标链接并发送通知；页面切换或重启不会重新变成“是否学习”。
- 失败保留 Source 和 Source Text，不留下失败占位笔记，可从卡片或 System 重试。
- 同一有效任务不会重复入队；只有用户明确要求重新生成才创建新操作。

后台生成 Study Guide 使用 `prepare-study-guide`；继续完善用 `update-study-guide`；直接形成长期知识用 `distill-wiki`。后台无人审阅 Wiki 会带 `generated` 标记，Study Guide 不因此被当成高风险 AI 内容。

<a id="cli"></a>

## CLI

以下命令从仓库根目录执行；正式安装且 `okf` 已在 PATH 时可直接调用 `okf`。
普通 CLI 使用命令参数或 `OKF_BRAIN_VAULT`、`OKF_BRAIN_ORIGINALS`、`OKF_BRAIN_STATE`
环境变量；只有支持 `--config` 的入口（例如 `okf-server`、`doctor`）直接读取部署文件。
以下示例先为当前 PowerShell 会话设置已核对的测试路径，`ORIGINALS` 仅表示旧迁移来源。
导入和 Feed 命令可能写入数据或调用外部服务，使用合成输入和测试配置执行。

```powershell
$env:OKF_BRAIN_VAULT = '<测试 Vault>'
$env:OKF_BRAIN_STATE = '<测试 State>'
$env:OKF_BRAIN_ORIGINALS = '<测试兼容 Originals>'
uv run --project engine okf --help
uv run --project engine okf import paper.pdf --action store --intent source
uv run --project engine okf import paper.pdf --action convert --intent source --method mineru-cloud
uv run --project engine okf context "my question" --scope auto --json
uv run --project engine okf doctor --verbose
```

CLI/API 旧导入调用缺省仍为 `convert`；与工作台默认仅保存原件的交互分别定义。

<a id="workspace-resources"></a>

### 初始化、资源同步与数据迁移

| 命令 | 用途与前置条件 |
| --- | --- |
| `okf init --vault <路径>` | 在空目录初始化 Vault；不建立完整的测试部署身份 |
| `okf resources sync --vault <路径>` | 更新已有 Vault 的受管资源，要求目标已有根 `index.md`，`--vault` 必须显式传入 |
| `okf migrate --vault <路径> --state <路径>` | 迁移旧字段及布局，并同步资源；会修改笔记，执行前明确迁移范围和恢复依据 |

`resources sync` 更新 Contracts、canonical/core 模板、views、policies 和 Web Clipper 集成，
并删除这些受管目录中已不在资源包内的文件。interactive 模板只补缺失文件，已有内容保留。
它还合并 `.obsidian/app.json`、`daily-notes.json`、`templates.json` 中的受管设置，保留其他键。
业务笔记不执行迁移；Skills、插件及 Vault 根 AGENTS.md 不由该接口安装。

命令输出实际变更列表，失败返回非零退出码；不保证全部资源跨文件事务回滚。
调用前核对目标及授权，执行后检查差异和 Contracts；日常测试更新优先通过
[统一更新入口](DEVELOPMENT.md#更新与启停)完成身份校验及配套安装。

### Feed 调试

```powershell
uv run --project engine okf feed ingest ai-daily .\ai-daily-issue.json --content-map .\ai-daily-full-markdown.json
uv run --project engine okf feed ingest treehole .\treehole-batch.json
uv run --project engine okf feed list ai-daily
uv run --project engine okf feed open ai-daily 2026-08-17-news
uv run --project engine okf feed decide ai-daily "item-id" learn-now
```

日常使用优先 Dashboard 和 Obsidian 原生 Digest；CLI 仅用于批处理、测试与故障定位。

### PowerShell 中读取 CLI JSON

CLI 的机器可读 JSON 在标准输出中保持为单一 JSON 文档；进度和错误写到标准错误。为兼容
PowerShell 7 与 Windows PowerShell 5.1 的不同原生进程编码规则，非 ASCII 字符在线路上会
写成标准 JSON `\uXXXX` 转义。`ConvertFrom-Json` 解析后得到的仍是原始中文，不是数据丢失。

```powershell
$report = okf doctor --verbose | Out-String | ConvertFrom-Json
$report.actionable
```

这个命令不依赖当前活动代码页；无需运行 `chcp 65001`，也不要先用文本替换修补输出。
需要保存原始 JSON 时可直接重定向，随后按 JSON 读取。

<a id="bridge"></a>

## Dashboard 与 Claudian Bridge

Dashboard 通过 Claudian 暴露的冻结对象 `okfBridge v1` 交接。请求／结果形状或语义变化需要新协议版本；
保持公开协议的内部改动维持 version 1。上游来源、适配边界及更新流程见[Claudian 上游记录](../claudian/UPSTREAM.md)。

公开类型如下：

```ts
interface OkfBridgeV1 {
  version: 1;
  open(): Promise<void>;
  handoff(request: {
    prompt?: string;
    contextPaths?: readonly string[];
    actionMode?: 'read' | 'write' | 'plan';
    skill?: string;
    autoSend?: boolean;
    newSession?: boolean;
  }): Promise<{
    accepted: true;
    sent: boolean;
    contextCount: number;
    actionMode: 'read' | 'write' | 'plan';
    skill: string | null;
  }>;
}
```

调用示例：

```ts
okfBridge.handoff({
  prompt: "整理今天的记录",
  contextPaths: ["life/daily/2026/08/2026-08-19.md"],
  actionMode: "write",
  skill: "organize-daily",
  autoSend: false,
  newSession: true,
});
```

Claudian 校验 Vault 相对路径与模式，打开或创建并主动显示 Codex 会话，把文件显示为可移除的
上下文 chip，并把任务预填到输入框。已有 Claudian 位于右侧栏但被日历等标签遮住时，交接也会
先显示该 leaf 再聚焦输入框。默认不自动发送，用户确认后 Codex 才执行。

上下文路径按规范 Vault 路径去重。Source 与 Source Text 可能具有相同 basename，但分别代表
来源身份卡与完整正文，因此两者都要保留；chip 使用 YAML `type/title` 或父目录标识角色，不再
只显示两个看似相同的文件名。

Bridge 始终选择 Codex。当前活动页若是 Claude，会新建 Codex 会话；Codex 未启用或没有可用模型时明确报错，不回退到 Claude，也不复用 Anthropic 登录状态。

### 提示模式

| 模式 | 用途 |
|---|---|
| `okf-native` | 默认；短基础指令 + Vault AGENTS + 按需 Skill |
| `claudian-full` | 上游完整提示；用于通用 Claudian 行为或兼容排查 |
| `custom-replace` | 高级用户提供完整替代基础指令 |

模式替换基础指令，切换仅影响新会话。上下文组成和后台任务归属见[Claudian 接入](architecture/README.md#claudian-接入)。

`read` 用于问答和比较；`write` 用于用户明确要求的整理或修改；`plan` 只制定方案。最终写入仍受 Codex 审批、Workspace 边界和适用 Contract 约束。

<a id="commands"></a>

## Obsidian Command IDs

用途：全局快捷键与动作菜单。Dashboard 暴露稳定命令：

| Command ID | 动作 |
|---|---|
| `okf-workspace-dashboard:open-action-menu` | 打开统一 OKF 快捷动作菜单 |
| `okf-workspace-dashboard:open-today-daily` | 打开/创建今日日记 |
| `okf-workspace-dashboard:append-today-daily` | 打开今日日记的随手记录区 |
| `okf-workspace-dashboard:quick-capture` | 打开统一快速记录编辑，提交后保存到收集箱 |
| `okf-workspace-dashboard:open-appearance-studio` | 打开外观工作室，编辑并保存自定义主题 |
| `okf-workspace-dashboard:new-reflection` | 新建反思 |
| `okf-workspace-dashboard:new-review` | 打开或新建当前周期 Review |
| `okf-workspace-dashboard:new-course` | 新建课程 |
| `okf-workspace-dashboard:new-lesson` | 选择已有课程后创建 Lesson |
| `okf-workspace-dashboard:new-project` | 新建项目 |
| `okf-workspace-dashboard:import-document` | 保存原件，或明确转换资料正文 |
| `okf-workspace-dashboard:open-tasks` | 打开任务页面，提供日期视图、状态历史及查询 |
| `okf-workspace-dashboard:inspect-task-boundary` | 读取历史工作台任务与原 Tasks 配置差异，提供来源定位 |
| `okf-workspace-dashboard:new-task` | 打开共用任务表单，明确保存位置、关联与日期 |
| `okf-workspace-dashboard:open-today` | 打开今天 |
| `okf-workspace-dashboard:open-inbox` | 打开收集箱 |
| `okf-workspace-dashboard:open-reading` | 打开订阅阅读 |
| `okf-workspace-dashboard:open-sources` | 打开资料 |
| `okf-workspace-dashboard:open-learning` | 打开学习 |
| `okf-workspace-dashboard:open-projects` | 打开项目 |
| `okf-workspace-dashboard:open-knowledge` | 打开知识笔记 |
| `okf-workspace-dashboard:open-life` | 打开日记与复盘 |
| `okf-workspace-dashboard:open-system` | 打开后台处理与系统诊断 |

QuickAdd 可绑定第一个命令；路径、YAML 与模板由 Workspace 维护。

<a id="web-clipper"></a>

## Web Clipper 发布

Web Clipper 模板输出 `ingested_via: web-clip` 的 Capture，不调用 AI、不持有本地 API token。浏览器配置见[使用指南](USER-GUIDE.md#网页剪藏)。

Capture 成功发布为 Source/Source Text 后删除；明确丢弃进入本地回收站。是否待处理由文件存在表达，不额外写 `capture_status`。归属和用途写在 `Source.uses[]`，不改写来源身份。

同一 URL 忽略 fragment 和常见跟踪参数去重；重复全文更新 Source Text，选区和高亮合并。与 Feed 的相同来源双向复用，保留首次 `ingested_via`；后来渠道的独有正文、指标和评论写入幂等补充区，不覆盖先前正文。

先保留网页远程图片链接，发布后后台将安全可访问的常规图片镜像到 `sources/assets/<source-slug>/` 并改写正文；失败保留远程链接且不阻塞发布。`OKF_WEB_MEDIA_MIRROR=false` 关闭镜像，也可手工调用 Obsidian “Download attachments for current file”。

布局迁移仅将旧 `Clippings/` 中具有官方默认 `source/created/tags: clippings` 精确签名的笔记移入 Capture 路径，
补齐 Workspace 元数据并保留正文/未知字段；个人结构与已有同名目标不覆盖。
