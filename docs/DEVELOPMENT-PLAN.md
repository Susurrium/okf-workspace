# OKF Workspace 统一仓库开发计划

## 1. 最终目标

建立一个可长期维护的私有 monorepo。Codex 是交互式推理核心，Obsidian Vault 是人与
AI 共读写的语义权威，Dashboard 是人类工作台，Claudian 是 Obsidian 内的 Codex
会话界面。系统不建立第二套知识数据库，也不让 Dashboard 或运行状态替代 Markdown。

生产 Vault、Originals、Runtime State、索引、密钥和会话始终在源码仓库外。

## 2. 产品与工程边界

产品可按五部分理解：

1. **Workspace Engine**：资料、学习、知识、项目、生活、检索、任务与 API。
2. **Dashboard**：概览、捕获、导入、判断、状态反馈与原生笔记跳转。
3. **Claudian**：嵌入式 Codex 会话、上下文附件与结构化交接。
4. **Feeds**：AI Daily、树洞等周期信息的读取和人工判断。
5. **Intake**：Capture、Web Clipper、文件上传、转换和 Source 发布。

工程上只有三个应用构建单元：`engine/`、`dashboard/`、`claudian/`。Feeds 与 Intake
是 Engine 内部强边界模块；MarkItDown 是独立服务，MinerU 是外部共享服务。这样既保留
用户能够理解的功能边界，又避免把同一 Vault 事务拆成难以维护的微服务。

Engine 内的依赖方向固定为：

```text
foundation + workspace resources
             ↓
           sources
        ↙            ↘
     intake          feeds
        ↘            ↙
       application workflows
             ↓
 learning / knowledge / projects / life
             ↓
 api / cli / worker / retrieval
```

Feeds 与 Intake 不能互相调用内部实现；二者通过统一 Source Publisher 和工作流编排交接。

## 3. 仓库结构

```text
okf-workspace/
├─ engine/
│  ├─ src/okf_workspace/       # Python Engine
│  └─ workspace/               # Contracts、模板、Skills、Policies、Views、Vault seed
├─ dashboard/                  # 独立 Obsidian Dashboard 构建
├─ claudian/                   # Claudian fork 与 OKF adapter
├─ services/markitdown/        # 独立转换服务
├─ integrations/mineru/        # 远端 MinerU 部署与运维资产
├─ deploy/                     # 主机与服务器部署
├─ scripts/                    # 根级 bootstrap/check/build/deploy
├─ tests/e2e/                  # 跨组件契约与完整用户流程
└─ docs/architecture/          # 当前有效架构
```

Dashboard 与 Claudian 各自保留 lockfile 和发布节奏；统一 Git 仓库不意味着强行共享 Node
依赖。Engine、Dashboard 和 Workspace resources 使用同一 release train；Claudian 与
MarkItDown 在 `release-manifest.yaml` 中锁定兼容版本。

## 4. 实施阶段

### 阶段 A：统一仓库基线

- 导入当前 Engine、Dashboard、Claudian 和仍在使用的 MarkItDown/MinerU 资产。
- 删除旧 Git 元数据、缓存、构建产物、旧设计归档和废弃 V2 服务。
- 把 `contracts/templates/skills/policies/views` 收进 `engine/workspace/`，只保留一个来源。
- Python 包统一为 `okf_workspace`，根脚本提供一次 bootstrap/check/build/deploy。
- 为 Claudian 记录上游 commit，保留 fetch-only upstream remote。

验收：四个构建单元能从干净依赖环境安装、检查、测试和构建。

### 阶段 B：Foundation 与 Sources

- Contract 是新写入的唯一格式权威；外部 OKF 宽容读取，Workspace 写入严格生产。
- Source 与 Source Text 由统一 Publisher 成对、原子、幂等发布。
- URL 用 canonical URL 去重，文件用内容哈希去重；首个 `ingested_via` 永远保留。
- Source 身份不绑定某次 Course/Project 使用；归属沿工作流传播到 Study Guide/Wiki。
- 修复 Obsidian vault-relative wikilink、正文链接和断链诊断。

验收：Web、Feed、文件导入两个顺序均不会重复 Source，失败不留下半个 pair。

### 阶段 C：Intake 与转换

- Capture、Web Clipper、文件上传统一进入 Intake，但保留真实渠道字段。
- 默认 MinerU，失败自动降级 MarkItDown；支持直接 MarkItDown 与必须 MinerU。
- 修复 parser 切换重试 ID、原始文件名、上传超时/取消、转换完成通知与目标跳转。
- 识别转换结果中的无效图片占位；快速转换丢图时明确降级质量而非静默通过。
- 导入前选择已有 Course/Project 或不关联；关系传给后续目标而不污染 Source 身份。

验收：PDF/DOCX/PPTX 的 mock 和真实服务契约均通过；四种用途都得到正确文件和状态。

### 阶段 D：Feeds

- AI Daily 与树洞只负责同步、Digest、快速阅读和记录用户决定。
- 兴趣与长期价值只由用户决定；系统不显式代判。
- “现在学习 / 稍后学习 / 直接 Wiki / 仅参考 / 不保留”映射到离散工作流动作。
- Digest 是 Obsidian 原生完整阅读入口；Dashboard 只展示紧凑摘要。
- 树洞正文、指标、媒体与折叠评论使用稳定可读结构。

验收：所有 Feed 条目可见，决定幂等，source-only 不调用 AI，失败有可重试反馈。

### 阶段 E：Workspace 工作流

- Learning 同时支持 Course、Project-related 和 Independent；`全部`是三者并集。
- Study Guide 只有一份文件，Project/Course 通过关系投影，不在目录中复制。
- 生成、更新 Study Guide 与生成/更新 Wiki 使用不同 Skills 和工作流。
- Project 使用 `project.md + log.md + Decision`；快速想法先落关联 Capture。
- Life 保持轻量，Daily/Reflection/Review 以人工书写为主。
- `studied_at` 只由用户明确确认；AI 未复核长期内容才使用 `generated/verified` 提示。

验收：每个工作流从输入、对话到长期成果均有确定位置、可见状态和原生笔记入口。

### 阶段 F：Dashboard

- Today 宽屏为左行动、右每日更新；每日更新只展示中国热点、AI 资讯与树洞热榜，窄屏按 pane 宽度切换行动/更新。
- Reading 复用 Feed 条目与原生 Digest 判断流程，按期分页承载持续累积的 RSS、周刊、教程和工具更新。
- Inbox 按待判断、待转换、待生成分层；操作后立即反馈，不因整页刷新丢状态。
- Learning 左侧学习归属、右侧学习材料；全部包含 Course、Project 与 Independent。
- Projects 是紧凑状态/下一步列表，不复制重型项目管理器。
- System 只显示可行动异常和真实运行状态，不常驻无意义后台卡片。
- Vault-native 动作不等待 API；后台动作具有进度、完成通知、失败和重试。

验收：真实 Dashboard View 有 DOM/状态测试；切换、刷新、滚动和后台更新不会重置用户位置。

### 阶段 G：Claudian

- 上游主体保持可升级；OKF 特有逻辑集中在稳定 adapter 和 `okfBridge v1`。
- Codex Provider 使用 Codex CLI 登录态，不绑定 Claude API。
- 基础上下文保持短；任务所需规则来自 Vault `AGENTS.md`、Skills 与显式文件。
- Dashboard 交接失败时可退化为打开笔记/复制提示，不使 Dashboard 不可用。

验收：typecheck、lint、架构边界、bridge、provider 和 production build 全部通过。

### 阶段 H：部署切换与清理

- 用合成 Vault 完成 Capture、导入、Feed、学习、Wiki、项目、日记和检索 E2E。
- 构建并安装新 Dashboard/Claudian，配置 Engine `.venv` 与外部 State/Originals。
- 默认不创建常驻本地 API；Obsidian 加载插件时启动，退出时停止。
- 清空无价值测试笔记、旧任务状态和索引，再以正式 Contract 初始化。
- 新部署验收通过后，停止旧 worker/计划任务，删除旧源码目录和废弃运行目录。
- 最后配置一个私有 `origin` 并建立 consolidated baseline；不合并无价值的旧 Git 历史。

验收：生产 Obsidian 只加载新插件和新 Engine；开机没有旧终端/worker；根检查与完整用户
流程通过；旧路径不再被任何配置引用。

## 5. 非目标

- 不修复所有历史测试笔记或迁移前 Runtime State。
- 不做两周试用期。
- 不把 Feed/Intake 拆成微服务。
- 不把生产 Vault、会话、密钥或索引提交到源码仓库。
- 不让 AI 替用户判断兴趣、价值或学习完成。
- 不在开发初期建立多层重复备份；源码由统一私有远端管理，笔记同步以后单独启用。

## 6. 发布门槛

1. 根 `scripts/check.ps1`、`scripts/build.ps1` 全部通过。
2. Engine、Dashboard、Claudian、MarkItDown 的独立测试通过。
3. 跨组件 contract 与合成 Vault 完整流程通过。
4. 新部署配置不引用旧源码、旧 Python、旧 token 目录或旧 worker。
5. 用户能在 Dashboard 看见动作状态和结果链接，也能直接在 Obsidian 原生文件中阅读成果。
