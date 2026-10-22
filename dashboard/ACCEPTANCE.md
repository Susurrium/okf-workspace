# Dashboard 验收台账

更新：2026-10-22。整合候选位于 `codex/integrate-performance-and-fixes`，
包含性能优化 `f2336aab` 与修复 `ecf34f4d`。两轮原始验收记录保留在下文，整合验收进行中；正式环境未部署。
采用边界见 [UPSTREAM.md](UPSTREAM.md)，验收要求见[开发指南](../docs/DEVELOPMENT.md)。
1.0 发布验收见[版本记录](../docs/releases/1.0.0.md)。

## 性能优化（2026-10-22）

证据位于 `work/performance-optimization-20261022/`；完整结果清单为
`deliverables/acceptance.json`。实机部署与恢复回执在
`E:\ObsidianData\OKF-Test-State\reports\performance-20261022`，安装身份以 State 的
`reports/deployment-receipt.json` 为准。

| 范围 | 结果与证据 |
| --- | --- |
| 自动化 | 根检查通过：Engine 628 项、跨组件 13 项、Dashboard 498 项、Claudian 6320 项及 72 项脚本检查；Claudian 3 项既有跳过。MarkItDown 36 项、Ruff 通过；Apex 八项相关专项、lint、独立构建通过。`final-root-check-3.log`、`final-markitdown.log`、`final-apex.log` |
| 文件系统与队列 | 5000 篇文件、20 次采样：无变化扫描、单路径更新、含刷新及实际读取的检索、空闲队列 P95 分别为 336、62、488、10 ms；首次队列核对为 1.82 s，全部原始样本保留。无变化扫描不解析 YAML，空闲队列不读取终态 JSON。`measurements/filesystem-final-5000.json` |
| 检索规模 | 10 万文本块的全文及合成向量预算通过；另用实际 BAAI 中文模型验证推理、无变化时生成 0 个向量及矩阵复用。`measurements/vector-full.json`、`measurements/real-vector.json` |
| 业务区域 | 两个读取器共享一次扫描，49 篇文件各读取一次，热扫描读取 0 次；文件创建、修改、重命名、删除后全文索引与投影正确，Capture 节点、草稿、焦点及选区保持。关闭全部业务视图后缓存清零。`test-dashboard-cache-counts.log`、`test-event-*.log`、`test-dashboard-cache-release.log` |
| Claudian | 冷模块求值中位数由审查基线 207 ms 降至 130 ms，50 ms 指示线仍有警告。240 条历史全文及 Markdown 完整，渲染后保持底部，原生滚轮向上移动后保留阅读位置；实际 Codex 读取、后台生成、闲置 10 分钟自动释放及同会话再次发送通过。`test-history-*.log`、`test-post-idle-resume-status.log`、`test-semantic-status-2.log` |
| 导入 | 工作台实际提交 PDF/DOCX/PPTX，均由配置中的 MinerU 云端完成、QC 通过；Office 图片保留。当前 MarkItDown 源码的本地真实 API/Worker/Engine 流程通过，远端现有服务的带图 DOCX/PPTX 兼容性通过。`test-cleanup-ui.log`、`markitdown-smoke.json`、`real-remote-markitdown.log` |
| 构建 | Dashboard 程序由审查基线 6729434 降至 3947331 字节；Tasks 缓存覆盖并发、校验、过期生成文件和失败保留产物。候选包及安装文件哈希匹配。`build-cache-tests-2.log`、`final-candidate-hashes.log` |
| 恢复与退出 | 44 个原文件内容不变，布局逐字节恢复；20 个合成文件、3 个转换记录和 1 个后台操作已清理，全文/向量索引无合成残留；会话与临时模型设置已恢复。测试窗口、API、自动启动、LiveSync 关闭，8766/9366 无监听。`test-final-restoration.log`、`test-final-status.log` |

以上为本地候选、固定测试环境和注明的在线接口验证；GitHub CI、正式部署、服务端容器部署及多设备同步不属于此次执行结果。

## 文件导航（2026-10-22）

过程资料位于 `work/navigation-acceptance/`，归档位于
`E:\ObsidianData\OKF-Test-State\reports\navigation-20261022-8f5a1c84531e`。
`installed.json` 记录源码提交、未提交文件哈希及候选/安装产物哈希；程序 SHA-256 为
`8f5a1c84531ecdf3d6836b167d6e34e41fb339e9ea147b4eb6971abfe86fe791`。
标准测试部署回执同时保存在 State 的 `reports/deployment-receipt.json`。

| 范围 | 结果与证据 |
| --- | --- |
| 自动化 | Dashboard 类型检查、67 个文件/489 项测试、构建通过；Apex 日历、文件夹属性筛选、移动端交互、刷新范围、滚动五项专项及 lint、独立构建通过。`dashboard-*.log`、`apex-*.log` |
| 文件与位置 | 返回工作台重复打开同一文件 20 次保持一个标签页；块/任务行定位、已有光标位置、固定笔记、文件快捷操作、同名不同目录、PDF/Canvas、固定页签通过。`files-1792660204057.json` |
| 多窗格 | 优先来源标签组、保留已有重复页签、复用独立窗口中的目标通过。`windows-1792660205868.json` |
| 弹窗 | 转标签页时复用目标、保留定位，编辑内容已写入原文件。`popover-1792660207205.json` |
| 功能页面 | 命令重复打开、清除内存关联、不同业务范围及明确工作台归属通过；状态标识和返回历史保留。`pages-1792660209798.json` |
| 重启与布局 | Obsidian 进程重启后，通过原生 API 恢复序列化布局；工作台和功能页均延迟加载时，无显式工作台参数的命令复用原页面，保留状态标识与历史。`cold-1792660198719.json` |
| Tasks | 真实快速搜索和查询结果来源定位、Ctrl/中键新建、连续明确新建请求通过；来源页面关闭后不打开迟到弹窗。`tasks-1792660211064.json`、`queries-1792660213493.json`、`closing-1792660214872.json` |
| Feed | 树洞、中国热点、AI 资讯使用真实本地 API 重复打开汇总与切换条目，均复用对应文件标签页。`feeds-1792660220342.json` |
| 输入 | CDP 浏览器原生鼠标事件验证固定笔记、Ctrl 连续新建及中键新建；确认事件 `isTrusted`，当前原生新标签页偏好为前台打开。后台窗口使用 CDP 焦点模拟，回执明确记录。`native-input.json` |
| 故障边界 | 导航隔离测试覆盖过期请求、并发创建、来源/弹窗关闭、缺失文件、打开失败和重试；后台新标签页偏好由隔离测试覆盖。`file-navigation.test.ts` 对应测试日志 |
| 恢复与退出 | 三份原布局/设置及三份原汇总逐字节恢复；合成文件、页签及全文/向量索引残留为零。测试窗口、API、自动启动和 LiveSync 关闭，8766/9366 无监听。`restoration.json`、`cleanup-1792660860390.json`、`exit-status.json` |

上述记录对应具名回执中的开发候选。原始失败回执和后续通过回执均保留。
移动端完成自动化及加载检查，未使用真实手机；本次没有远端同步、外部在线服务或正式发布验收。

## Bug 修复（2026-10-22）

修复提交为 `ecf34f4d`，业务源码为 `a080a147`；固定 OKF-Test 验收后恢复原工作区程序。

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

## 添加菜单与顶部快速记录（2026-10-17）

该项功能提交为 `65884bdc`，基线 `77381edb`；源码基线 `57e29c21` 的六项 CI 全部通过。

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
