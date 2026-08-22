# 本地 API 与 Dashboard 开发说明

## 启动

正式使用时不需要手工启动服务：Dashboard 插件随 Obsidian 加载时启动服务，插件卸载或 Obsidian 退出时停止。开发调试时可以手工启动；服务仍只允许绑定 loopback：

```powershell
$env:OKF_BRAIN_VAULT = 'E:\ObsidianData\OKF-Brain'
$env:OKF_BRAIN_ORIGINALS = 'E:\ObsidianData\OKF-Brain-Originals'
$env:OKF_BRAIN_STATE = 'E:\ObsidianData\OKF-Brain-State'
uv run okf-server
```

首次启动会在 `OKF_BRAIN_STATE/secrets/local-api-token` 生成随机 token。开发阶段把服务地址 `http://127.0.0.1:8765` 和 token 文件路径填入 Obsidian 插件设置；正式安装由 Windows 安装脚本完成。插件通过标准输入持有服务进程，服务器使用 `--exit-on-stdin-close` 感知宿主退出，不依赖反复轮询父进程。

Dashboard 构建：

```powershell
npm install
npm --workspace dashboard run build
```

产物为 `dashboard/dist/main.js`，配合 `dashboard/manifest.json` 和 `dashboard/styles.css` 安装到 Vault 的 `.obsidian/plugins/okf-workspace-dashboard/`。

## 为什么仍然需要本地 API

Dashboard 分为“读取面”和“命令面”：

- Today、Inbox、Learning、Projects、Knowledge、Life 通过 Obsidian Vault API 直接读取 Markdown，不依赖 HTTP；
- 普通日记、Capture、课程和项目可由插件直接写 Vault；AI 调用、文档导入、Feed cache、索引写入、撤销和 System 状态需要访问 Vault 外的 Runtime State、Original Store、Codex、MinerU/MarkItDown 或 Git，因此由本地 API 执行；
- Dashboard 打开普通页面不会重复探测服务。用户点击明确的写入动作时检查一次；请求失败时再恢复服务并显示可重试错误。

这种边界保证“笔记能不能看”不受后台服务影响，同时把浏览器插件不应直接持有的 token、外部进程和 Vault 外文件留在受控服务中。

## 安全边界

- `/health` 无需 token，只返回服务状态；
- 其他接口要求 `Authorization: Bearer <random-token>`；
- 服务器拒绝绑定非 loopback 地址；
- 浏览器跨域只放行 Obsidian 桌面渲染器等明确的本地来源、`GET/POST/OPTIONS` 和 `Authorization/Content-Type`；其他来源的预检会被拒绝；
- API 返回 Vault 相对路径，不返回 Original 绝对路径、文件哈希、token 或 Runtime export 路径；
- 完整异常和转换工作目录只进入本地日志；
- token 放在 Vault 外，不经 LiveSync。

## 领域接口

| 方法与路径 | 用途 |
|---|---|
| `GET /today` | 从真实 Markdown 和可重建状态生成 Today |
| `GET /dashboard/{area}` | Inbox、Learning、Projects、Knowledge、Life 投影 |
| `GET /dashboard/feeds/summary` | 最新 Feed 全部条目的紧凑摘要，不返回全文 |
| `POST /daily`、`POST /captures`、`POST /reflections` | 创建人工笔记入口 |
| `POST /captures/publish-web` | 将 Web Capture 确定性发布为 Source + Source Text，并按四个离散人工动作选择是否生成 |
| `POST /courses`、`POST /class-notes`、`POST /projects` | 创建课程、课堂笔记和项目 |
| `POST /projects/{slug}/log` | 追加项目进展 |
| `POST /ai/ask` | 检索、读取真实章节并返回 `actual_reads` |
| `POST /ai/organize` | 把普通人工 Capture 的正文写入一个长期目标，成功后删除 Capture；Web Capture 必须走发布接口 |
| `POST /ai/class/organize` | 只更新课堂 AI 受管区域 |
| `POST /ai/projects/{slug}/summarize` | 读取 project/log 并刷新项目概览 |
| `POST /ai/learning/plan`、`POST /ai/self-test` | 显式学习动作 |
| `POST /documents/import` | 上传并执行 Original → 转换 → Source 发布 |
| `GET /documents/conversions?status=failed` | 列出转换失败任务 |
| `POST /documents/conversions/{id}/retry` | 指定转换器重试 |
| `POST /semantic/operations` | 快速持久化一个后台学习材料或 Wiki 生成任务 |
| `GET /semantic/operations/{id}` | 读取真实阶段：`queued/retrieving/generating/publishing/indexing` |
| `POST /semantic/operations/{id}/cancel` | 停止检索或 Codex 子进程；进入发布阶段后不再接受取消 |
| `POST /semantic/operations/{id}/retry` | 从保留的来源和任务参数重新排队；目标尚未生成也可重试 |
| `GET/POST /feeds/...` | Feed 列表、阅读和六种人工决定 |
| `POST /index/sync`、`POST /index/rebuild` | 合并增量同步，或显式重建全文索引和任务投影 |
| `GET /changes/latest`、`POST /undo` | AI 改动摘要和可恢复撤销 |
| `GET /system/status` | 只返回用户可行动的系统问题 |

## 有意义的开发验证

```powershell
uv run ruff check src tests
.venv\Scripts\pyright.exe --pythonpath .venv\Scripts\python.exe
uv run pytest
npm --workspace dashboard run check
npm --workspace dashboard test -- --run
npm --workspace dashboard run build
```

不需要为每次普通读取做重复健康检查。增量索引是 single-flight：上一轮未完成时只合并为下一轮一次同步；根 `index.md` 是稳定人工目录，不写入最近活动或任务投影，也不是 AI 检索依赖。MinerU、MarkItDown、索引和备份状态在打开 System 或运行 `okf doctor` 时检查一次；具体动作失败时保留失败记录并提供重试。

语义 Worker 不用心跳伪装进度：心跳只表示进程存活，Operation Record 的 `stage` 和
`stage_detail` 才表示当前步骤。每次检索和 Codex 生成都在可终止的子进程中执行；默认整项上限
600 秒、单次检索上限 12 秒，可通过部署配置中的 `semantic_timeout_seconds` 和
`semantic_retrieval_timeout_seconds` 调整。Worker 日志位于 Runtime State 的 `logs/semantic-worker-YYYYMMDD.log`。
