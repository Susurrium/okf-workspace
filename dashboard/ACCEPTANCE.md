# Dashboard 验收台账

更新：2026-10-17。沉浸式工作台源码 `72736b81` 经 [PR #10](https://github.com/Susurrium/okf-workspace/pull/10)
合入 `main`，合并提交 `55ea2c85`。此前项目、快速记录与分区整合经 PR #9 合并，提交 `122286ce`。
这两轮更新未部署正式环境。采用边界见 [UPSTREAM.md](UPSTREAM.md)，验收要求见[开发指南](../docs/DEVELOPMENT.md)。

## 顶部快速记录与添加菜单（2026-10-17）

基线 `77381edb`，本次源码为未提交修改；源码快照、完整 SHA-256 和具名结果见
`work/top-capture/receipt.json`。安装目标为固定 OKF-Test，正式环境未部署。

| 范围 | 结果与证据 |
| --- | --- |
| 自动化 | Dashboard 类型检查、65 个文件/472 项测试、构建通过；Apex immersive-render、immersive-grid、layout-stacked、refresh-scope、widget-span、scroll-root 六项专项、lint、独立构建通过；文档生成校验及 7 项回归通过；日志为 `work/top-capture/*-final.log`、`apex-*.log`、`docs-*.log` |
| 菜单实机 | 顺序、分隔线、分区选择器和实际添加；缺少便利贴时创建分区，分别添加单张备忘录/清单卡片，添加小组件及重复禁用；`menu.json`、`section.json`、`menu-final.png` |
| 显示与生命周期 | 四种顶部开关组合、空快捷操作、配置窗口读取/保存/渲染，顶部/侧栏/网格独立显示；刷新及布局切换保留节点、焦点、选区，双窗格/展开编辑共享草稿、销毁取消订阅；`matrix.json`、`shared.json` |
| 保存与恢复 | 真实只读设置文件引发保存前失败、记录写入后的草稿清理失败和配置保存失败；提示、草稿保留、原目标重试及重复提交保护通过；冷启动后重新打开工作台恢复布局、默认及课程/项目草稿；`faults.json`、`cold.json` |
| 键盘与视觉 | CDP 原生 Enter 保存、Shift+Enter 换行；输入法确认使用合成事件验证。明暗主题、1200px/430px、空快捷行、配置快捷操作、菜单和真实失败提示完成视觉检查；`native-input.json`、`scroll.json`、`light-*.png`、`dark-*.png`、`failure-narrow.png` |
| 产物 | `main.js` SHA-256 为 `ba1da22b4f071c4cb2b5409912554c454d8dbc4508c60c60c04a1751674572b6`；CSS/manifest 完整哈希与安装核验见 `installed.json`，部署回执为 `deployment-receipt.json` |
| 清理与退出 | 恢复原有插件配置、用户草稿及窗口配置，核验 178 个原有文件字节一致；删除 14 个合成文件及备份、清理索引。保留候选插件和自动生成的原生接管回执；测试窗口、API、自动启动和 LiveSync 关闭，8766/9366 无监听；`cleanup.json`、`index-cleanup.json`、`exit-status.json` |

证据均位于 `work/top-capture/`。未验证真实手机、系统输入法候选选择、远端同步和外部在线服务。
首次安装/旧配置兼容由自动化验证；实机使用已有 OKF-Test 配置。

## 沉浸式工作台既有验收

实机证据根目录：`work/immersive-workbench/work/upstream-port/`。
`receipt.json` 记录基线 `6eb0fb7c` 上提交前源码快照、候选/安装文件哈希及场景结果；最终提交 CI 单独记录。

| 范围 | 结果与证据 |
| --- | --- |
| 提交 CI | [workspace-ci](https://github.com/Susurrium/okf-workspace/actions/runs/38997636551) 六项通过：Engine、Dashboard、Claudian Linux/Windows、MarkItDown、Windows 发布资源 |
| 本地自动化 | Dashboard 类型、构建、64 个文件/460 项测试；Apex 49 项专项、lint、构建；原始输出为 `tests-final.log`、`typecheck-final.log`、`build-final.log`、`final-test-*.log`、`lint-final.log`、`apex-build-final.log` |
| 实机 | 固定 OKF-Test 验证拖动、三向缩放、取消、业务刷新、组件移除重加、Capture、双窗格、独立弹窗、布局隔离、冷启动及旧格式只读打开；对应 `drag.json`、`resize-*.json`、`flow-*.json`、`popout.json` |
| 故障与并发 | 真实 EPERM 后保留输入，解除限制后重试成功；同卡片冲突拒绝覆盖，不同卡片合并；`flow-fault.json`、`flow-retry.json`、`flow-conflict.json` |
| 视觉 | 最终 11 张图覆盖明暗主题、业务分区、430×950、菜单、无背景及保存失败；同一宿主夹具中上游/本地核心的 5 张卡片几何一致，未安装完整上游插件；`visual-review.md`、`reference-*-geometry.json` |
| 安装与退出 | `candidate/` 固定候选，安装哈希匹配；恢复原文件、清除合成文件与索引，测试窗口、Engine、自动启动、LiveSync 关闭，8766/9366 无监听；`cleanup.json`、`index-cleanup.json`、`exit-status.json` |

未验证：真实手机、远端同步和外部在线服务。以上截图与实机结果仅证明各自回执标识的产物。

## 保留证据索引

路径均相对仓库根目录；原始日志、失败记录、截图与恢复资料继续保留。

| 主题 | 证据位置 |
| --- | --- |
| PR #9 整合 | `work/branch-integration/`：根检查、候选、实机、部署/清理回执；Apex 日志 `work/integration-apex-checks/` |
| Apex 选择性更新 | `work/apex-runtime-results.json`、`work/apex-visual-20261016/receipt.json`、`work/apex-prepush-checks/`；网易云只验证搜索，未验证微信读书在线调用 |
| 快速记录 | `work/capture-native-20261016/receipt.json`、`work/capture-visual-20261016/`；原始故障日志 `work/capture-unification-apex-checks/` |
| 分区与任务 | `work/section-experience-evidence/`；源码归档在 `work/branch-integration/section-experience-source.zip` 和 `section-archive.json` |
| 较早验收 | `work/surface-visual-final/`、`work/tasks-boundary-accepted/`、`work/fixed-test-*-result.json`；旧环境归档 `E:\ObsidianData\Archives\20261015-test-consolidation` |
| 历史正式切换 | 2026-09-29 `v0.8.0`/`7a9ea715`；切换前备份 `E:\ObsidianData\Backups\okf-pre-cutover-20260928T234914`，仅证明当次部署 |

详细旧台账用 `git show 55ea2c85:dashboard/ACCEPTANCE.md` 查阅；更早完整记录见 `122286ce` 的同一路径。
原项目类别独立目录已不存在，复查使用整合证据。实际安装状态依据目标环境的部署回执与文件核对。
