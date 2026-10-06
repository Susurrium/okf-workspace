# OKF 第二大脑个性化审计

> 历史记录（2026-10-06 归档）。下文保留当时的方案、状态和验证证据，不作为当前实现要求；当前边界见[系统架构](../../architecture/README.md#system-overview)，有效文档见[文档索引](../../README.md)。

> 日期：2026-08-23  
> 状态：访谈前基线；不把尚未确认的偏好写入系统  
> 权威源码：`E:\code\okf-workspace`  
> 正式 Vault：`E:\ObsidianData\OKF-Brain`

## 1. 审计结论

当前系统的核心架构已经成立：Contract 管字段与路径、Template 管初始化结构、Skill 管任务流程，Dashboard 和 Claudian 提供入口。下一阶段不适合直接“大改提示词”，而应分成两条并行但边界清晰的工作：

1. 先修复不依赖个人偏好的确定性缺陷，恢复可信基线。
2. 通过访谈确认真实工作方式，再设计偏好模型、工作流预设、Skills、模板和提示词。

现有 Vault 中大量内容是验收、测试或外部剪藏，`self/` 下的个人背景文件尚为空。因此，本次审计没有把“保存过的文章”“测试笔记”或 AI 生成内容当作用户偏好证据。

## 2. 应保留的设计

- YAML Contract 是字段与路径的唯一规范，避免 Skill、模板、插件各自发明元数据。
- 原始输入、用户正文和人工笔记默认保留；AI 只写受管理区域。
- `studied_at`、兴趣、长期价值、认同和核验状态不能由 AI 猜测。
- Dashboard/搜索结果只负责定位，回答前读取真实 Markdown。
- `okf-native` 使用短系统提示词，把规则下沉到 `AGENTS.md`、Skills 和实际文件，方向正确。
- 正式 Vault 中的 9 个 Skills 与当前权威源码逐字节一致，部署的 Skill 文件本身没有漂移。

## 3. 问题地图

### P0：先修复，不需要用访谈决定

| 问题 | 已确认的影响 | 处理方向 |
|---|---|---|
| 检索 Skill 调用裸命令 `okf`，当前 Codex/PowerShell 环境找不到该命令 | `$retrieve-vault-context` 的标准路径会直接失败 | 统一可靠的执行入口，并增加安装/路径自检 |
| `okf context` 默认启用可选向量模型；模型未安装时直接失败 | 文档声称可回退 FTS，但实际必须手工加 `--no-vector` | 修正回退逻辑、CLI 默认值和文档，并增加无向量环境测试 |
| Skill 提到 `knowledge`、`self` scope，但 CLI 不支持；`auto` 还排除 `self/` | 个性化问答无法可靠检索个人上下文 | 增加明确的个人上下文 scope，统一 Skill、CLI 和测试 |
| 正式 Vault 校验失败：4 个 `Clippings/` 笔记缺少公共必需字段 | Vault 处于无效状态，但用户不易察觉 | 修复 Web Clipper 入口/模板；对现有文件制定迁移方案 |
| `okf doctor --verbose` 未报告上述校验错误 | “无待处理项”会造成错误安全感 | 让 doctor 汇总或明确链接基础校验结果 |
| 当前工作目录是历史仓库，其旧版 `.agents/skills` 仍会被 Codex 自动发现 | 旧字段、旧状态和旧 Skill 名可能覆盖 OKF v3 规则 | 隔离/退役旧 Skills，并在历史仓库根部设置明确防误用规则 |
| 权威 Vault Kit 与正式 Vault 的 `AGENTS.md`、`index.md` 有实质差异 | Capture 生命周期和入口说明未完整部署 | 明确“受管文件升级”策略，做可审计的同步而非静默覆盖 |
| Claudian 普通会话默认 `yolo`，实际映射为无审批和全文件系统权限 | 普通问答也拥有超出 Vault 的读写与命令执行能力；行为规则不是安全边界 | 采用最小权限默认值；按“问答、明确写入、批量/外部操作”分级授权并做越界测试 |
| Wiki 合并/拆分及媒体移动缺少 checkpoint、并发检测、链接复验和失败回滚合同 | 多文件操作一旦部分失败，可能产生不可逆的知识结构或附件引用损坏 | 先补安全 helper、dry run 和恢复路径；旧笔记保留策略由访谈确认 |

### P1：需要访谈后设计

| 主题 | 当前缺口 | 访谈需要确认 |
|---|---|---|
| 个人上下文 | `self/direction.md`、`constraints.md`、`now.md`、`preferences.md`、`profile.md`、`capabilities.md` 基本为空 | 哪些信息值得长期保存、何时读取、何时失效、哪些绝不保存 |
| 学习与知识 | Study Guide/Wiki 只有通用流程 | 不同材料类型、深度、证据要求、练习形式、Wiki 粒度和“学完”判定 |
| 捕获与阅读 | Web Capture、Feed、临时 Capture 有多条入口 | 什么值得捕获、何时整理、如何去重、何时丢弃、是否保留全文 |
| 项目管理 | 项目日志和 Dashboard 提示较通用 | 项目粒度、状态汇报格式、下一步数量、任务写法、Decision 触发条件 |
| Daily/Reflection/Review | 模板固定，真实使用证据不足 | 日记应保留多少原话、任务提取阈值、复盘节奏、敏感内容边界 |
| AI 协作 | 当前 Claudian 为高推理、`yolo` 权限；Dashboard 多为“生成后不自动发送” | 默认模型、速度/质量/成本偏好、确认点、允许自动执行的动作 |
| 模板入口 | Templater 没有文件夹规则或快捷键；QuickAdd 没有 choices | 真正常用的 3–5 个入口、桌面/移动端差异、可接受的交互步数 |
| 提示词 | Dashboard、后台任务、Claudian、QuickAdd 的提示分散 | 全局风格、领域模式、引用要求、输出长度、反例与例外 |
| 清理与迁移 | 约四分之一 Markdown 带 UAT/测试特征，另有无名 `.base` 等残留 | 哪些是证据需保留，哪些可移动或删除，采用何种回滚窗口 |
| AI 读取与联网 | Inline Edit 默认扩大到整篇/大量上下文，并允许静默 WebSearch | “纯局部、上下文、联网核验”三档如何选择；哪些内容不得外发 |
| 高风险写入 | 项目、Wiki、媒体等 Skills 没有统一调用已有 checkpoint/undo/validate 能力 | 哪些动作必须预览、二次确认和保留多久的回滚点 |

### P1：还需统一的内部合同

- Daily/Lesson Skills 允许在 AI managed region 外写任务，但根 `AGENTS.md` 与 Contracts 又规定整理“只写”指定区域；任务究竟是正式例外还是也应进入受管区域尚未统一。
- `maintain-wiki-map` 会寻找 `wiki-content`，但 Wiki Map Contract 和模板没有该 marker。
- `capture-project-progress` 可创建 Decision，却没有要求读取 `decision.yaml`；`decided_at` 等必需字段存在漏写风险。
- `prepare-study-guide` 与 `update-study-guide`、`distill-wiki` 与 `maintain-wiki-map`、Daily 与 Project 的触发边界存在重叠，需要用访谈后的真实语句重写 description 并做路由测试。
- “优化指令”只看到自定义 system prompt，看不到实际生效的 `AGENTS.md`、Contracts、Skills 和 native prompt，因此无法兑现“避免冲突”。
- 当前只有 Skill frontmatter/命名结构校验，缺少触发、写入边界、权限和真实 fixture 的行为级 CI。

### P2：随个性化改造一并收口

- canonical 与 interactive 的 Reflection、Review、Project Update 结构不一致。
- interactive Review 内嵌较长脚本，与 canonical 模板重复，存在双维护风险。
- Core Templates 与 Templater 同时指向含 `<% ... %>` 代码的 interactive 目录；从 Core 命令插入时可能留下未执行脚本。
- Wiki Map 的默认标题语言与中文主界面不一致。
- QuickAdd 保留通用英文 AI system prompt，但当前没有实际 choice，容易形成第二套未治理的 AI 入口。
- 提示词散落在 Dashboard、后台 runner 和插件设置中，缺少可版本化的预设注册表。
- 宽泛的个人问题可能命中外部剪藏或超长 Feed 正文；来源角色和相关性需要更强约束。

## 4. 观测到的基线数据

- 正式 Vault 共约 79 个 Markdown 文件；按名称识别的 UAT/测试类文件约 18 个。该比例只能说明验收残留较多，不能代表使用偏好。
- `okf validate --vault ... --json` 检查 49 个受管文件时返回 4 个错误，均来自默认 Web Clipper 写入的 `Clippings/` 文件缺少 `type` 等公共字段。
- `okf doctor --verbose` 同时报告“无可操作项”，说明 doctor 与 validator 的健康口径尚未闭环。
- 使用引擎绝对路径并添加 `--no-vector` 后，词法检索可成功；证明不是索引整体损坏，而是入口、默认值和回退逻辑有问题。
- 9 个生产 Skill 均通过 UTF-8 结构校验并与权威源哈希一致；不要为了解决外围问题无差别重写全部 Skill。

## 5. 目标设计原则

访谈后采用分层设计，避免把所有偏好复制进每个 Skill 或堆成一个巨型系统提示词：

1. **事实与边界层**：用户明确确认的方向、约束、当前重点、稳定偏好；记录来源、确认时间和适用范围。
2. **工作流预设层**：例如“快速整理”“深度学习”“证据优先”“项目周报”，只保存会改变行为的参数。
3. **任务 Skill 层**：保持短小、判别明确，只加载当前任务所需偏好。
4. **模板层**：模板只提供最低必要骨架；只有确有不同工作方式时才增加少量变体。
5. **入口层**：Dashboard、Claudian、命令面板和移动端调用同一组预设，避免各写一套提示词。
6. **验证层**：每个重要偏好都对应正向场景、反例和“不应发生”的断言。

偏好采用以下状态：

- `confirmed`：用户明确表达，可作为默认行为。
- `hypothesis`：根据访谈或使用迹象提出，但不得自动生效。
- `experiment`：有期限、有评价标准的试用设置。
- `retired`：已失效但需要保留决策历史。

## 6. 推荐实施顺序

1. 建立可信基线：修复检索、scope、doctor、Web Clipper、旧 Skill 发现和部署漂移。
2. 完成分阶段访谈，形成“偏好—工作流—入口—验收场景”决策矩阵。
3. 先实现最高频的 3–5 条黄金路径，不一次性改所有模板。
4. 统一提示词注册与参数边界，再精简或新增 Skills。
5. 在副本/测试 Vault 迁移并做结构、行为、回归和人工体验验收。
6. 经用户确认后部署到正式 Vault；清理测试残留属于单独、可回滚的动作。

## 7. 完成定义

- 常用入口在桌面端和移动端都能在可接受步数内完成。
- 同一任务从不同入口启动时，Contract、行为和输出结构一致。
- 个人偏好只来自明确确认的信息，外部剪藏不能被当作用户立场。
- 无向量模型时检索仍能工作；个人上下文可被精准、最小化地读取。
- 自动写入、覆盖、删除、发起后台任务的边界符合用户选择。
- 普通问答不能越界写入；恶意或指令化笔记正文不能提升权限。
- Wiki 合并/拆分、媒体移动和批量迁移可预览、可检测并发、可回滚、可复验链接。
- 至少用真实的 Capture、学习材料、项目进展、Daily 和个人问答各验收一次。
- 所有结构修改通过 Contract 校验，旧版本可回滚。

## 8. 本次实际读取的关键 Vault 路径

- `AGENTS.md`
- `index.md`
- `self/preferences.md`
- `self/direction.md`
- `self/constraints.md`
- `self/now.md`
- `self/profile.md`
- `self/capabilities.md`
- `life/daily/2026/08/2026-08-22.md`
- `Clippings/My Obsidian network.md`
- `Clippings/WeChat Article Skills.md`
- `Clippings/AI 工具.md`
- `inbox/captures/2026/08/我日常使用频率最高的十个 10 Skill.md`

后四项仅用于检查捕获与检索行为，不作为个人偏好证据。
