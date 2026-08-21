# Claudian Assistant 集成

## 1. 职责边界

Claudian 是 OKF Workspace 的交互式 AI 界面，不是知识库，也不承载 Workspace 业务规则：

```text
Dashboard / 原生笔记
          │  okfBridge v1（任务、路径、读写模式、可选 Skill）
          ▼
Claudian Assistant
          │  Codex App Server
          ▼
        Codex
          │  AGENTS.md + 按需 Skill + 本轮真实文件
          ▼
      Markdown Vault
```

- Codex 是推理与执行核心。
- Vault 是长期语义权威。
- Engine 负责导入、Feed、检索、后台任务与结构化写入。
- Dashboard 负责状态概览和快捷入口。
- Claudian 负责会话、流式输出、工具调用、审批、附件和恢复。

Claudian 故障不会阻止 Dashboard 打开、原生 Markdown 阅读或 Engine 处理后台任务。

## 2. 从上游保留的能力

当前分支基于 Claudian 2.1.4，保留其成熟的会话外壳：

- Codex App Server 启动、RPC 和生命周期；
- 流式输出、思考与工具消息、错误、取消和审批；
- 多会话、恢复、标题与会话持久化；
- 文件、图片、附件和外部上下文；
- 模型、推理强度和 sandbox 选择。

没有使用 shell stdin、伪终端或 DOM 注入来模拟聊天，因此不会重现旧内嵌终端的输入、颜色和重登后补发问题。

## 3. OKF 的窄接缝

OKF 专属代码只允许集中在：

```text
claudian/src/integrations/okf/
├─ OkfBridge.ts
└─ OkfPromptPolicy.ts
```

`okfBridge` 的公共协议固定为 version 1。Dashboard 只传递：

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

Claudian 校验 Vault 相对路径与模式，打开或创建 Codex 会话，把文件显示为可移除的上下文 chip，并把任务预填到输入框。默认不自动发送，用户确认后 Codex 才执行。

Bridge 始终选择 Codex。当前活动页若是 Claude，会新建 Codex 会话；Codex 未启用或没有可用模型时明确报错，不回退到 Claude，也不复用 Anthropic 登录状态。

## 4. 实际上下文组成

每轮上下文分为五层：

1. Codex 产品自身的系统层；
2. Claudian 当前提示模式对应的短基础指令；
3. Vault 目录作用域内的 `AGENTS.md`；
4. 本轮任务匹配或 Dashboard 明确指定的单个 Skill；
5. 用户消息、会话历史和已经明确附加或真实读取的文件。

Workspace Kit 位于 `engine/workspace/`，安装时同步到 Vault 的 `AGENTS.md`、`.agents/skills/` 和 `system/`。Claudian 不复制 Contracts、模板或 Skills，也不会在每轮塞入全部 Obsidian 教程。

## 5. 提示模式

| 模式 | 用途 |
|---|---|
| `okf-native` | 默认；短基础指令 + Vault AGENTS + 按需 Skill |
| `claudian-full` | 上游完整提示；用于通用 Claudian 行为或兼容排查 |
| `custom-replace` | 高级用户提供完整替代基础指令 |

模式是替换，不是在长提示后追加“忽略前文”。切换只影响新会话，已开始会话不会在中途悄然改变基础规则。

`read` 用于问答和比较；`write` 用于用户明确要求的整理或修改；`plan` 只制定方案。最终写入仍受 Codex 审批、Workspace 边界和适用 Contract 约束。

## 6. 交互任务与后台任务

两条执行路径共享同一个 Vault、Contracts 和 Skills，但体验不同：

- Dashboard 的“在 Claudian 中生成/完善”创建可见 Codex 会话，用户可以补充要求后发送。
- Engine 的“后台生成”创建可观察的语义任务，不要求打开 Claudian；Dashboard 展示 queued/running/completed/failed 等状态与结果入口。

后台生成不是确定性转换。确定性的部分是任务入队、状态持久化、目标路径和原子发布；语义内容仍由 Codex 生成。Engine 按 source、用途和 course/project 上下文去重任务，避免同一目标被重复提交。

## 7. 构建与部署

源码位于同一 monorepo：

```text
E:\code\okf-workspace
├─ engine
├─ dashboard
└─ claudian
```

生产数据仍在仓库外：Vault、Original Store、Runtime State。Claudian 插件安装到：

```text
<Vault>/.obsidian/plugins/okf-claudian/
```

构建和安装：

```powershell
cd E:\code\okf-workspace
.\scripts\build.ps1
.\scripts\install-okf-claudian.ps1 -Vault E:\ObsidianData\OKF-Brain -SkipBuild
```

安装器只拥有 `okf-claudian`。它会清理历史开发版本误复制的
`.obsidian/plugins/claudian`，但不会禁用或删除官方社区插件 `realclaudian`；如果两个插件
同时启用会干扰使用，由用户在 Obsidian 中自行选择保留哪一个。

上游升级通过只读 `claudian-upstream` remote 获取。`claudian/UPSTREAM.md` 固定上游版本与 commit；OKF 修改尽量限制在 integration adapter 和少量公共接口，以降低升级冲突。

## 8. 验收要求

1. Dashboard 交接打开 Claudian 的 Codex 会话，不打开外部终端。
2. 任务与上下文在发送前可见、可移除，不会在重登后补发旧输入。
3. read/write/plan 权限与指定 Skill 正确传递。
4. 普通问答不加载无关 Skill。
5. 切换提示模式只影响新会话。
6. Claude 会话不会接收 OKF Bridge 任务。
7. Claudian 关闭时，Dashboard、导入、Feed、检索和后台任务仍能独立工作。
