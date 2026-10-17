# 自建 MinerU 运维

此目录保存 `bjmu-inner` 外部服务的部署资产。Workspace 默认使用云端，启用此服务的配置见
[部署指南](../../docs/DEPLOYMENT.md#conversion)。运维前核对实际服务器、资源占用和授权范围。

## 配置与启动条件

| 项目 | 锁定来源/约定 |
| --- | --- |
| 工作目录 | `/home/yangg/workdir/mineru`；app、模型、venv、缓存、日志和任务均在该真实目录下 |
| 版本 | MinerU 3.4.4、vLLM 0.11.2、PyTorch 2.9.0+cu128、Python 3.12.3；以依赖锁复验 |
| GPU | 索引 0，UUID `GPU-5a1f2ba5-bbb7-9e1e-c142-21abc5783319`，显存比例 0.25 |
| API | `127.0.0.1:8000`，并发 1；本地 SSH 隧道 `127.0.0.1:18000` |
| 保留策略 | 失败输出 48 小时；日志至少最近 12 次并保留 14 天内记录 |
| 清单 | `requirements-server.lock`、`config/model-manifest.json`、`config/system-deps.lock` |

启动前置检查拒绝链接逃逸、GPU UUID 改变/已有计算进程、端口冲突、模型文件集/大小不匹配、
不足 10 GiB 磁盘空间或非回环配置。启动后按服务 SID 核对全部监听，发现通配/服务器网卡监听即失败并清理本次进程树。
TCPStore 使用预绑定回环 socket 的 `master_listen_fd`，仅允许 rank 0/world_size 1。
用户态锁不替代多用户 GPU 调度；PPTX 的 CPU 解析也保留统一 GPU 配额检查。
回环仍可被同机账号访问；若不能信任同机用户，先由管理员提供隔离，或采用 0600 Unix socket/StreamLocalForward。
真实 workdir 必须满足管理员目录要求；需要独立磁盘时由管理员配置挂载。

## 能力与数据

服务接收 PDF/PPTX。PDF 使用 MinerU 版面/OCR/VLM；PPTX Office 后端提取原生文字、表格、图表、备注和可处理图片，
不对图片执行 OCR/VLM，不保证音视频、OLE、外链或 VBA。balanced/quality 不改变该路径，视觉密集页需人工核对，
可在 Windows 导出独立 PDF 再提交。旧 PPT 由客户端保留原件，PowerPoint COM 生成并验证派生 PPTX。
原件、派生映射、账本、QC 和 Vault 发布由客户端维护，服务任务目录仅作计算缓存。

## 建立与检查

部署资产置于 `~/workdir/mineru/app`，限制其他用户访问：

```bash
cd ~/workdir/mineru/app
./bootstrap.sh
./download-models.sh
./verify-models.sh --full
```

bootstrap 严格同步依赖锁；Python 头文件由 `install-python-headers.sh` 安装并执行真实扩展编译/导入 Canary。
`env.sh` 定义固定参数，`preflight.sh`/`runtime_guard.py` 检查路径、GPU、监听和身份；
`run-api.sh` 仅由 `start.sh` 创建新 session 启动。`client-lease.sh` 提供跨进程/机器的独占提交租约。

## 启停与诊断

```bash
cd ~/workdir/mineru/app
./start.sh
./status.sh
./smoke-test.sh
./stop.sh
```

Windows 适配器管理自己启动的服务。手动隧道使用：

```powershell
ssh -N -T -o ExitOnForwardFailure=yes -L 127.0.0.1:18000:127.0.0.1:8000 bjmu-inner
```

stop 保留输出；只有 ZIP 已下载、归档和发布成功后才调用 `./stop-complete.sh`。
它核对状态文件、PID 启动时刻、UID/SID 和进程所有权，结束本次 session 后仅删除其精确输出目录。
启动按保留策略回收已停止 session/旧 UUID 目录，保留整个输出根目录。

诊断位置：`run/api-state.json`、`logs/api-<UTC>-<随机值>.log`、状态中的 `output_root`、
`jobs/output/session-*` 及 config 下模型、系统/依赖锁记录。

## 恢复依据

历史备份候选 `~/workdir/mineru/app-backup-20260721`，操作前实时确认其存在、内容及对应版本。
回退先 `./stop.sh --force`，核对 stopped 与 GPU 计算进程退出，保留当前应用快照；
使用核验后的备份恢复 app，运行 `bash -n ./*.sh` 和 `./bootstrap.sh`，再完成模型/启动/冒烟验证。
模型、venv、缓存和客户端账本位于 app 外，分别核对兼容性和保留状态。
旧实测占用、模型数量和系统包差异见 `git show 55ea2c85:integrations/mineru/README.md`，实际状态由检查脚本确认。
