# Dashboard 验收台账

更新：2026-10-17。当前功能提交为 `65884bdc`（添加菜单与顶部快速记录），基线 `77381edb`。
已在固定 OKF-Test 安装验收候选，正式环境未部署。采用边界见 [UPSTREAM.md](UPSTREAM.md)，验收要求见[开发指南](../docs/DEVELOPMENT.md)。
本地专项验收通过；提交 CI 存在失败项，尚未满足完整 CI 通过条件。

## 最近验收

证据根目录：`work/top-capture/`。`receipt.json` 记录提交前快照及全部 19 个变更文件哈希，已与
`65884bdc` 核对一致；`installed.json` 和 `deployment-receipt.json` 记录三个候选/安装文件的完整哈希与身份。

| 范围 | 结果与证据 |
| --- | --- |
| 提交 CI | [workspace-ci](https://github.com/Susurrium/okf-workspace/actions/runs/39002561496) 五项通过，Claudian Windows 失败：`CodexConversationHistoryService.test.ts` 两项历史恢复测试在第 85 行断言父历史文件读取次数时失败，原因尚未定位。完整日志保存于 `work/docs-review-65884bdc/ci-failed.log` |
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
| `55ea2c85` 沉浸式移植 | PR #10，源码 `72736b81`；`work/immersive-workbench/work/upstream-port/receipt.json`。布局、拖动/缩放、Capture、并发与实机视觉；上游/本地核心在共享夹具中的卡片几何一致，未安装完整上游插件；未部署正式环境 |
| `122286ce` 项目与快速记录整合 | PR #9；`work/branch-integration/` 含根检查、实机、候选和清理回执；Apex 日志 `work/integration-apex-checks/`；未部署正式环境 |
| Apex 选择性更新 | `work/apex-runtime-results.json`、`work/apex-visual-20261016/receipt.json`、`work/apex-prepush-checks/`；网易云只验证搜索，未验证微信读书在线调用 |
| 快速记录与分区 | `work/capture-native-20261016/receipt.json`、`work/capture-visual-20261016/`、`work/capture-unification-apex-checks/`、`work/section-experience-evidence/`；源码归档和清单在 `work/branch-integration/` |
| 较早验收 | `work/surface-visual-final/`、`work/tasks-boundary-accepted/`、`work/fixed-test-*-result.json`；旧环境归档 `E:\ObsidianData\Archives\20261015-test-consolidation`；原项目类别独立目录已不存在，复查使用整合证据 |
| 历史正式切换 | 2026-09-29 `v0.8.0`/`7a9ea715`；切换前备份 `E:\ObsidianData\Backups\okf-pre-cutover-20260928T234914`，仅证明当次部署 |

最近一轮的原始详细台账见 `git show 65884bdc:dashboard/ACCEPTANCE.md`；实际运行状态依据目标环境的部署回执和文件核对。
