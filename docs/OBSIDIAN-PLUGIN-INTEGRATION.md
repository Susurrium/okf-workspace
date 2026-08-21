# Obsidian 插件与 Workspace 的集成边界

## 1. 总原则

Markdown/YAML 是权威数据，Dashboard 提供领域操作，Codex Skills 负责语义处理。
第三方插件只增强人工入口或原生阅读，不建立第二份状态，也不成为 AI Provider。

统一调用链：

```text
Templater / QuickAdd / Chinese Calendar / Dashboard
→ OKF Artifact Contract 或 Dashboard Command
→ 同一个权威 Markdown
→ Dataview / Tasks / Recent Files / Dashboard 读取投影
→ OKF Claudian 把任务、上下文和权限交给 Codex
→ Codex 按 AGENTS 与匹配的 Skill 读取真实 Markdown 后回答或修改
```

## 2. Templater

用途：用户主动创建或插入结构。模板目录是：

```text
system/templates/interactive/
```

当前提供 Reflection、Review 和 Project Update。用“从模板新建笔记”执行 `Review` 时会先选择
Weekly、Monthly 或 Yearly，再移动到对应的 `life/reviews/` 路径；若当期文件已经存在则拒绝
重复创建，使用 Dashboard 直接打开已有 Review。Templater 不调用 Codex，Codex 也不“操作 Templater”；
两者共同遵守 `system/contracts/`。日记由 Core Daily Notes 使用
`system/templates/core/Daily.md`，避免 Templater 与 Chinese Calendar 生成不同结构。

安装脚本只设置 `templates_folder`，不启用启动脚本、系统命令或自动整库写入。

## 3. QuickAdd

用途：全局快捷键与动作菜单。Dashboard 暴露稳定命令：

| Command ID | 动作 |
|---|---|
| `okf-workspace-dashboard:open-action-menu` | 打开统一 OKF 快捷动作菜单 |
| `okf-workspace-dashboard:open-today-daily` | 打开/创建今日日记 |
| `okf-workspace-dashboard:append-today-daily` | 一句话写入今日日记 |
| `okf-workspace-dashboard:quick-capture` | 保存到 Inbox |
| `okf-workspace-dashboard:new-review` | 打开或新建当前周期 Review |
| `okf-workspace-dashboard:new-lesson` | 选择已有课程后创建 Lesson |
| `okf-workspace-dashboard:new-project` | 新建项目 |
| `okf-workspace-dashboard:import-document` | 导入 PDF/Word/PowerPoint |

QuickAdd 最推荐只绑定第一个命令；具体路径、YAML 和模板仍由 Workspace Contracts 维护。这样 QuickAdd
配置损坏或未安装时，命令面板和 Dashboard 仍能完成同样操作。

## 4. Dataview

用途：在原生 Markdown 页面中动态查询 YAML。预置视图：

- `system/views/Learning.md`；
- `system/views/Projects.md`。

Dataview 结果不是长期正文，不被 Codex 当证据，也不是 Dashboard 的数据源。删除 Dataview 后，
所有真实课程、项目和学习材料仍然存在。

## 5. Tasks

正式任务使用：

```markdown
- [ ] #task 完成一个明确动作
```

只有带 `#task` 的未完成项进入 Today 和 `system/views/Tasks.md`。普通清单、学习自测问题和来源
中的示例不会被误当作任务。Tasks 插件处理完成、到期和重复语义；Dashboard 只展示需要关注的
子集，任务本身始终留在日记、项目或学习笔记中。

## 6. Recent Files

Recent Files 直接作为 Obsidian 侧栏历史使用。Dashboard 不复制完整历史，只显示“最近学习”、
“最近项目”等有领域含义的入口，因此两者不会争夺同一功能。

## 7. Chinese Calendar

Chinese Calendar 负责日期、农历、节气和完整日历视图。Dashboard Life 页只显示最近日记并调用
公开命令 `chinese-calendar:show-chinese-calendar-view`。从日历点日期时仍落到 Core Daily Notes
配置的同一路径和同一模板，不启用 Chinese Calendar 的 QuickAdd 日记分支。

## 8. OKF Claudian 与 Codex

OKF Claudian 是本机 Codex 在 Obsidian 内的原生会话界面。它复用 Claudian 已验证的
Codex App Server、流式消息、审批、会话恢复和编辑展示能力，但默认使用精简的 OKF 提示模式。

Dashboard 只通过公开的 `okfBridge` 交接：

1. 打开一个 Codex 会话；
2. 传递可见的任务文字；
3. 把目标笔记显示为可移除的上下文文件；
4. 为本轮设置 `read`、`write` 或 `plan`；
5. 需要专门流程时显式加入一个 Skill；
6. 默认只预填，用户检查后发送。

主流程不再模拟终端，不写入终端 stdin，也不依赖剪贴板。Terminal 仍可作为用户自行使用的高级
命令行工具，但 Dashboard 不调用它，也不在其上建立功能依赖。

## 9. 安装与多设备

Windows 安装器会部署本地构建的 OKF Claudian，并只自动启用已经存在于 Vault 的其他插件；不从
网络下载或覆盖第三方插件代码。每台设备
可以只启用适合本机的界面插件；没有本地 Codex、MinerU 或后台服务的设备仍可阅读、编辑、使用
Templater/Tasks/Dataview/Calendar，并通过 LiveSync 同步 Markdown。
