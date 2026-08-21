# `bjmu-inner` MinerU 部署与运维

部署位置固定为 `/home/yangg/workdir/mineru`。模型、虚拟环境、缓存、日志、临时文件和
任务输出都位于该目录之下，符合管理员“不要在 `/home` 或 `/` 下散放大文件，统一使用
`~/workdir`”的要求。

`~/workdir` 当前仍是根 ext4 文件系统中的普通目录，不是独立挂载点。普通用户可以创建
目录，但不能把它自行变成真正的独立磁盘挂载点；这需要管理员分配块设备/网络存储并
配置挂载权限。当前部署不依赖独立挂载点。

## 固定运行基线

- MinerU：`3.4.4`
- vLLM：`0.11.2`
- PyTorch：`2.9.0+cu128`
- Python：Ubuntu `3.12.3`
- GPU：物理索引 0，UUID
  `GPU-5a1f2ba5-bbb7-9e1e-c142-21abc5783319`
- GPU 显存比例：`0.25`，空闲服务实测约占 20.6 GiB
- API：`127.0.0.1:8000`，并发 1
- 本地入口：SSH 隧道 `127.0.0.1:18000 → 127.0.0.1:8000`

回环绑定阻止校外/远程网络直接访问，但它不是同机 Unix 用户隔离边界：服务器上的其他
本地账号仍可能访问 `127.0.0.1:8000`。当前部署因此要求同机账号可信；若这一前提改变，
需由管理员提供 owner/cgroup/netns 防火墙，或改为权限 `0600` 的 Unix socket 与
`StreamLocalForward`，不能把回环地址误当成多租户认证。
- 服务端输出失败保留：48 小时
- 日志：至少保留最近 12 次，同时保留 14 天内日志

依赖全集固定在 `requirements-server.lock`。54 个模型文件另有
`config/model-manifest.json`，记录大小与 SHA-256。

> 运行态事实：20.6 GiB 空闲占用、54 个模型文件、系统包版本和下文回滚目录是
> 2026-07-21 的最后实测值。本次 PPTX 验收时 SSH 连接超时；任何运维操作前都应重新运行
> `status.sh`、`verify-models.sh` 和对应文件检查，不能把这些数值当作永久不变量。

## PDF 与 PowerPoint 的服务端边界

本部署当前接收适配器提交的 PDF 和 PPTX，但两者不是同一种解析路径：

- PDF 按 MinerU 的版面/OCR/VLM 能力和请求档位处理。
- PPTX 由 MinerU 3.4.4 的 Office 后端在 CPU 上直接解析 OOXML 结构，读取原生文本、
  表格、图表、讲者备注和符合处理条件的图片；不保证提取音频、视频、OLE 或所有外链
  资源，也不会对幻灯片图片执行 OCR/VLM 理解。
- `balanced`/`quality` 不会把 PPTX Office 解析切换成图片 OCR/VLM。截图式或视觉密集的
  幻灯片需要人工复核，必要时由 Windows PowerPoint 导出 PDF，再作为独立 PDF 任务提交。

服务端不直接接收旧二进制 `.ppt`，也不在服务器安装或调用 Microsoft PowerPoint、
LibreOffice。Windows 适配器会先不可变保留原 `.ppt`，再用本机 PowerPoint COM 生成并
验证派生 `.pptx`；上传到本服务的只是该派生件。原 `.ppt` 仍是权威来源，派生转换不能
称为无损，且普通 `.pptx` 不保留 VBA。

PPTX 任务的解析阶段本身是 CPU 路径，但当前 API 生命周期仍可能按统一部署启动模型并
预留 GPU。因此不能据此跳过 GPU UUID、占用和配额检查，也不能在服务器繁忙时绕过组内
调度规则。

原始 PDF/PPT/PPTX、旧 PPT 的派生映射、SQLite 账本、QC 结果和 Vault 发布物均由
Windows 适配器管理；服务器的任务目录仍然是可清理的计算缓存，不是事实来源。

## 安全边界

`start.sh` 与 `run-api.sh` 都执行不可绕过的检查：

- 基目录真实路径必须位于真实的 `~/workdir` 下；符号链接逃逸会失败。
- GPU 0 必须仍映射到固定 UUID，且不得已有 compute process。
- API 地址、vLLM 地址、Gloo/NCCL 网卡必须为回环配置。
- 模型路径必须留在部署基目录，模型文件集合与清单必须一致。
- 至少保留 10 GiB 磁盘空间。
- API 端口不得被其他进程占用。

PyTorch 默认的 TCPStore 即使收到 `127.0.0.1`，仍可能创建通配监听。本部署通过
PyTorch 官方的 `master_listen_fd` 接口，把预先绑定到 `127.0.0.1` 的 socket 交给
TCPStore；该适配器只允许 `rank=0 / world_size=1`。启动完成后还会按服务 SID 枚举全部
TCP listener，只要存在 `0.0.0.0`、`::` 或服务器网卡地址，启动就失败并清理进程树。

用户态文件锁只能阻止本用户重复启动，不能替代多用户 GPU 调度；与组内其他用户共享
GPU 时仍应遵守管理员/课题组的调度规则。

## 已部署文件

- `env.sh`：固定目录、GPU、回环和运行参数。
- `bootstrap.sh`：创建 venv，并严格同步完整依赖锁。
- `install-python-headers.sh`：用户态 Python 头文件及真实编译/导入 canary。
- `download-models.sh`：下载模型并生成完整模型清单。
- `verify-models.sh`：快速文件集/大小检查或完整 SHA-256 检查。
- `preflight.sh`：不可绕过的启动前置检查。
- `run-api.sh`：内部前台入口；必须由 `start.sh` 以新 session 启动。
- `start.sh`、`status.sh`、`stop.sh`、`stop-complete.sh`：受保护生命周期。
- `client-lease.sh`：跨进程/跨机器独占一个自动化提交者，防止并发客户端互相停机。
- `runtime_guard.py`：状态身份、监听、进程会话与精确清理。
- `smoke-test.sh`：依赖、CUDA、模型、健康字段与全部监听检查。

## 首次或重建部署

文件应放到 `~/workdir/mineru/app`，权限至少保证其他用户不可读写。随后执行：

```bash
cd ~/workdir/mineru/app
./bootstrap.sh
./download-models.sh
./verify-models.sh --full
```

当前服务器运行时包是 `libpython3.12-stdlib 3.12.3-1ubuntu0.13`，仓库可取得的开发头文件
是 `libpython3.12-dev 3.12.3-1ubuntu0.15`。两者共享 Python `3.12.3` ABI；脚本已通过
编译并导入 CPython 扩展的 canary 验证，并把差异记录在 `config/system-deps.lock`。

## 日常命令

```bash
cd ~/workdir/mineru/app

./start.sh
./status.sh
./smoke-test.sh
./stop.sh
```

`stop.sh` 正常终止服务但保留该 session 的输出，用于失败诊断。只有调用方已经确认 ZIP
下载、本地归档和发布成功后，才应执行：

```bash
./stop-complete.sh
```

它会在校验状态文件、PID 启动时刻、UID、SID 和整个会话进程所有权后执行
`TERM → 等待 → KILL`，并且只删除状态文件记录的精确 `session-*` 输出目录。

Windows 一般不需手动运行这些命令；本地适配器会自动管理它自己启动的服务。若要手动
连接：

```powershell
ssh -N -T -o ExitOnForwardFailure=yes `
  -L 127.0.0.1:18000:127.0.0.1:8000 bjmu-inner
```

## 诊断位置

- 当前服务身份：`run/api-state.json`
- 每次启动日志：`logs/api-<UTC>-<随机值>.log`
- 当前 session 输出：状态文件中的 `output_root`
- 失败/中断输出：`jobs/output/session-*`
- 模型清单：`config/model-manifest.json`
- Python 系统依赖记录：`config/system-deps.lock`
- 服务器依赖锁副本：`config/requirements.lock`

启动会回收超过 48 小时的已停止 session 和旧版 UUID 测试目录，但从不宽泛删除固定的
`jobs/output` 根目录。

## 回滚

本次上线前版本保存在：

```text
~/workdir/mineru/app-backup-20260721
```

回滚前必须先运行 `stop.sh --force` 并确认 `status.sh` 显示 stopped、GPU 0 回到约
24 MiB。然后将备份内容复制回 `~/workdir/mineru/app`，执行 `bash -n ./*.sh` 检查脚本，
再运行 `./bootstrap.sh`。模型、venv、缓存和本地任务账本不在 `app` 目录内，不会被脚本
回滚覆盖。
