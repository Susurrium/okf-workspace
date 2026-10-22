# Dashboard 验收台账

更新：2026-10-22。本轮修复候选位于 `codex/audit-fixes-20261022`，业务源码为 `a080a147`，
另含测试退出控制修复。固定 OKF-Test 实机验收完成后恢复原工作区程序；正式环境未部署。
采用边界见 [UPSTREAM.md](UPSTREAM.md)，验收要求见[开发指南](../docs/DEVELOPMENT.md)。
1.0 发布验收见[版本记录](../docs/releases/1.0.0.md)。

## 最近验收

本轮证据位于修复工作树的 `work/live-acceptance/RESULT.md` 及同目录具名 JSON，
绝对位置为 `E:\code\okf-workspace\work\audit-fixes-20261022\work\live-acceptance\`。
后台运行日志归档在 `E:\ObsidianData\OKF-Test-State\reports\audit-fixes-live-20261022\operations\`。

| 范围 | 结果 |
| --- | --- |
| 实际宿主与元数据 | Obsidian 原生 frontmatter 完成/取消、未知嵌套字段与正文保留；身份变化拒绝写入；12 组核验事件、原生日期、跨读取器诊断与冷启动通过，两端结果一致 |
| 界面与文件 | 学习卡片菜单完成学习及打开原生笔记；真实 HTTP 并发修改保留人工正文；4 进程追加 12 条记录；Windows 大小写、ADS/设备名及目录联接保护通过 |
| Markdown | 80 万字节合成文件通过真实任务日期编辑执行解析与写入，约 2.1 秒；极端文件另出现宿主索引等待，删除并重启后恢复，详情见实机记录 |
| Codex | 真实后台生成发布、排队与运行中取消且无输出；可见 Claudian 通过公开 Bridge 使用 Codex 返回回答，附件显示与移除通过 |
| 退出与恢复 | 修复退出时旧设置写回造成自动启动复启的问题；14 项 Windows 控制测试、Ruff/Pyright 和真实启动/关闭通过；合成笔记、聊天及索引清理，恢复原程序与模型选择，测试窗口/API/自动启动/同步关闭 |

本次按用户要求未新增环境备份或执行产物哈希核对。实机界面通过 DOM 操作及实际文件/API 状态验证；
MinerU、Feed 在线同步、真实手机及多设备同步不在本轮变更范围。

## 2026-10-17 验收

证据根目录：`work/top-capture/`。`receipt.json` 记录提交前快照及全部 19 个变更文件哈希，已与
`65884bdc` 核对一致；`installed.json` 和 `deployment-receipt.json` 记录三个候选/安装文件的完整哈希与身份。

| 范围 | 结果与证据 |
| --- | --- |
| 提交 CI | `57e29c21` 的 [workspace-ci](https://github.com/Susurrium/okf-workspace/actions/runs/39005974068) 六项全部通过，包含 Claudian Windows |
| 自动化 | Dashboard 类型、65 个文件/472 项测试及构建通过；Apex 六项专项、lint、独立构建通过；文档生成及 7 项回归通过。对应 `*-final.log`、`apex-*.log`、`docs-*.log` |
| 添加菜单 | 顺序/分隔线、分区选择器及真实添加；无便利贴时创建分区，分别添加单张便签/清单；小组件添加与重复禁用。`menu.json`、`section.json` |
| 显示与会话 | 四种顶部开关组合、空快捷行、配置读取/保存/渲染；各位置独立显示；刷新/布局切换保留节点、焦点、选区，双窗格/展开共享草稿，销毁取消订阅。`matrix.json`、`shared.json` |
| 故障与恢复 | 真实只读设置文件触发保存前、记录写入后清理及配置保存失败；草稿保留、原目标重试、重复提交保护和冷启动恢复通过。`faults.json`、`cold.json` |
| 键盘与视觉 | CDP 原生 Enter/Shift+Enter；输入法确认由合成事件验证。明暗、1200px/430px、菜单、快捷行及真实失败提示完成视觉检查。`native-input.json`、`scroll.json`、`light-*.png`、`dark-*.png`、`failure-narrow.png` |
| 安装与退出 | 三个安装文件哈希匹配；恢复 178 个原文件，删除 14 个合成文件及备份、清理索引；保留候选插件与原生接管回执。窗口、API、自动启动、LiveSync 关闭，8766/9366 无监听。`cleanup.json`、`index-cleanup.json`、`exit-status.json` |

未验证真实手机、系统输入法候选选择、远端同步和外部在线服务；首次安装与旧配置兼容由自动化验证，实机使用既有 OKF-Test。
上述结果仅对应各自回执标识的源码和产物，本地通过记录不代替提交 CI 的实际结果。

## 保留证据索引

路径相对仓库根目录；原始日志、失败记录、截图和恢复资料继续保留，详细旧台账见表中提交的 `dashboard/ACCEPTANCE.md`。

| 版本与主题 | 结果定位与证据 |
| --- | --- |
| `65884bdc` 历史 CI 失败 | [workspace-ci](https://github.com/Susurrium/okf-workspace/actions/runs/39002561496) 的 Claudian Windows 两项历史恢复测试失败，原始日志保存在 `work/docs-review-65884bdc/ci-failed.log`；当前 CI 状态见上表 |
| `55ea2c85` 沉浸式移植 | PR #10，源码 `72736b81`；`work/immersive-workbench/work/upstream-port/receipt.json`。布局、拖动/缩放、Capture、并发与实机视觉；上游/本地核心在共享夹具中的卡片几何一致，未安装完整上游插件；未部署正式环境 |
| `122286ce` 项目与快速记录整合 | PR #9；`work/branch-integration/` 含根检查、实机、候选和清理回执；Apex 日志 `work/integration-apex-checks/`；未部署正式环境 |
| Apex 选择性更新 | `work/apex-runtime-results.json`、`work/apex-visual-20261016/receipt.json`、`work/apex-prepush-checks/`；网易云只验证搜索，未验证微信读书在线调用 |
| 快速记录与分区 | `work/capture-native-20261016/receipt.json`、`work/capture-visual-20261016/`、`work/capture-unification-apex-checks/`、`work/section-experience-evidence/`；源码归档和清单在 `work/branch-integration/` |
| 较早验收 | `work/surface-visual-final/`、`work/tasks-boundary-accepted/`、`work/fixed-test-*-result.json`；旧环境归档 `E:\ObsidianData\Archives\20261015-test-consolidation`；原项目类别独立目录已不存在，复查使用整合证据 |
| 历史正式切换 | 2026-09-29 `v0.8.0`/`7a9ea715`；切换前备份 `E:\ObsidianData\Backups\okf-pre-cutover-20260928T234914`，仅证明当次部署 |

2026-10-17 的原始详细台账见 `git show 65884bdc:dashboard/ACCEPTANCE.md`；实际运行状态依据目标环境的部署回执和文件核对。
