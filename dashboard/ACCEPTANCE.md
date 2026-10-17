# Dashboard 验收台账

更新：2026-10-17。沉浸式工作台源码 `72736b81` 经 [PR #10](https://github.com/Susurrium/okf-workspace/pull/10)
合入 `main`，合并提交 `55ea2c85`。此前项目、快速记录与分区整合经 PR #9 合并，提交 `122286ce`。
这两轮更新未部署正式环境。采用边界见 [UPSTREAM.md](UPSTREAM.md)，验收要求见[开发指南](../docs/DEVELOPMENT.md)。

## 最近验收

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
