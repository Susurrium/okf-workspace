# MarkItDown 服务器部署与运维

本手册用于专用服务器。服务能力、版本基线、HTTP 与结果契约统一见[服务文档](../../services/markitdown/README.md)。
客户端配置见[Workspace 部署指南](../../docs/DEPLOYMENT.md#conversion)。实际服务器状态以实时检查和回执确认。

## 部署参数与边界

执行前取得覆盖目标服务器和操作范围的授权，记录以下明确参数。命令中的大写占位符必须替换为已确认值。

| 参数 | 要求 |
| --- | --- |
| SSH alias | `CLAB_SSH_ALIAS`，具备所需 sudo 权限 |
| 服务名 | `MARKITDOWN_FQDN`，专用 Tailscale 节点完整 HTTPS 名称 |
| 数据根 | `MARKITDOWN_DATA_ROOT`，支持缺省 `/srv/markitdown-data` |
| 挂载身份 | `MARKITDOWN_EXPECTED_MOUNT` 与 `MARKITDOWN_EXPECTED_SOURCE`，精确匹配实时 findmnt；使用系统盘也明确填 `/` |
| 资源/账号 | 至少 2 vCPU、4 GiB RAM；明确服务 UID/GID（缺省 10002）、端口 18010，核对冲突 |
| 网络授权 | 明确可访问该节点 TCP 443 的 Tailnet 用户、设备或 tag |

客户端经 Tailnet HTTPS 根路径 `/` 和 Bearer Token 访问，Serve 转发到宿主机 `127.0.0.1:18010`，
systemd socket proxy 再转发 API 内部地址。API 仅连接 internal Docker 网络且无默认路由/PortBindings；
Worker 无网络。Compose 不使用 `ports`，代理目标由每次启动的运行态检查生成。
容器以非 root 运行，不挂 Docker Socket、Vault、用户主目录或无关宿主目录，Token 只读挂载。
防火墙/安全组不开放 18010，禁止 Funnel，不额外授权 SSH 等端口。

## 盘点与安装版本包

通过已确认 alias 只读盘点 Ubuntu 24.04 x86-64、Docker/Compose v2、磁盘空间/inode、UID/GID、端口及 Tailscale：

```bash
uname -a
cat /etc/os-release
docker version
docker compose version
ss -ltnp
getent passwd 10002
getent group 10002
findmnt --mountpoint MARKITDOWN_EXPECTED_MOUNT -o TARGET,SOURCE,FSTYPE,OPTIONS
df -h MARKITDOWN_EXPECTED_MOUNT
df -i MARKITDOWN_EXPECTED_MOUNT
free -h
tailscale version
tailscale status
tailscale serve --help
tailscale serve status --json
sudo ufw status numbered
```

保存现有 Serve 配置和恢复方法，核对所有目标；挂载身份或端口不符即停止。
在 Windows 仓库运行 `scripts/package-markitdown-deployment.ps1`，保留输出的版本、元数据和哈希。
上传完整 tar.gz、同名 SHA-256 文件及同一固定 revision 的 `install-release-bundle.sh`、`release_bundle.py`，
先逐一核对本地记录的引导文件哈希，再安装：

```bash
cd /absolute/staging/markitdown-release
sha256sum --check --strict --warn ARCHIVE_NAME.tar.gz.sha256
sha256sum install-release-bundle.sh release_bundle.py
sudo bash ./install-release-bundle.sh \
  --archive /absolute/staging/markitdown-release/ARCHIVE_NAME.tar.gz \
  --checksum /absolute/staging/markitdown-release/ARCHIVE_NAME.tar.gz.sha256
cd /opt/markitdown-releases/current
bash deploy/markitdown/verify-release.sh "$(pwd -P)"
realpath deploy/markitdown/../../services/markitdown
```

包包含完整 `deploy/markitdown`、服务源码和锁文件，不含 `.env`、Token、Vault 和本地缓存。
安装器检查 tar 的路径、链接、重复/特殊成员、白名单与展开上限，再逐文件/闭集核验；
版本保存在 `releases/<manifest SHA-256>/`，`current`/`previous` 原子指向完整版本，已有目标只复验不覆盖。
首次旧布局 `/opt/markitdown-backup` 保持原样，可成为 previous。禁止把 tar 直接覆盖当前目录。
Compose 构建上下文必须指向同一实际版本的 `services/markitdown`；后续操作从 current 的部署子目录进入。

## 初始化运行配置

初始 Token 在受控客户端生成，安全传输到服务器上的精确暂存文件，属部署用户/root 且权限 0600。
Token 不进入 Git、Vault、命令参数/历史、日志或聊天。使用受管入口创建目录与 `.env`：

```bash
cd /opt/markitdown-releases/current/deploy/markitdown
sudo bash ./prepare-runtime.sh \
  --data-root /srv/markitdown-data \
  --token-file /etc/obsidian-markitdown/api-tokens.txt \
  --token-source /absolute/staging/markitdown-client.token \
  --service-uid 10002 --service-gid 10002 --host-port 18010 \
  --expected-mount MARKITDOWN_EXPECTED_MOUNT \
  --expected-source MARKITDOWN_EXPECTED_SOURCE \
  --expected-tailnet-fqdn MARKITDOWN_FQDN
```

该入口拒绝非规范、链接逃逸或过宽路径，不格式化/挂载/递归清盘；仅管理数据根、state/spool 和指定配置。
目录为服务 UID/GID、0700，Token 为 `root:10002`、0640，`.env` 和审计快照为 0600。
已有不同 `.env` 先备份；不同 Token 默认拒绝覆盖。`--replace-token` 替换整个文件且只接受一条 Token，
仅用于有意的单 Token 引导；多设备轮换使用下节流程。双端验证后才删除精确暂存 Token 文件。

从 `.env.example` 核对以下配置：

| 配置 | 语义 |
| --- | --- |
| `MARKITDOWN_IMAGE`、`MARKITDOWN_ENGINE_BUILD_ID` | 匹配包内元数据和客户端；生产优先使用受控 registry 的不可变 digest，禁止 latest/无人值守更新 |
| `MARKITDOWN_BUNDLE_MANIFEST_SHA256` | 当前磁盘 `release-manifest.sha256` 文件的 SHA-256 |
| `MARKITDOWN_RELEASE_MANIFEST_SHA256` | 运行镜像的 release 身份，与 label/环境/health 一致；新部署与 bundle 身份相同 |
| `MARKITDOWN_UID`、`MARKITDOWN_GID`、`MARKITDOWN_HOST_PORT` | 服务账号与端口 |
| `MARKITDOWN_DATA_ROOT`、`MARKITDOWN_TOKEN_FILE` | 已确认的规范绝对路径 |
| `MARKITDOWN_EXPECTED_MOUNT`、`MARKITDOWN_EXPECTED_SOURCE` | 精确挂载身份 |
| `MARKITDOWN_TAILNET_FQDN` | 已确认专用节点 |

缺省限制：上传 64 MiB、结果 128 MiB、500 逻辑单元、活动任务 3、上传并发 1、单 Worker、spool 2 GiB、
运行最低剩余空间 2 GiB、任务 600 秒；API 256 MiB/0.5 CPU，Worker 2 GiB/1.5 CPU；成功 TTL 2 小时、失败 24 小时。
OOM 应通过代表性文件压测后调整输入或资源，保留内存、上传和逻辑单元限制。

## 部署与验证

先运行完整预检；两个 manifest 参数取自已核验包与运行身份：

```bash
sudo bash ./preflight.sh \
  --data-root /srv/markitdown-data \
  --token-file /etc/obsidian-markitdown/api-tokens.txt \
  --host-port 18010 --service-uid 10002 --service-gid 10002 \
  --expected-mount MARKITDOWN_EXPECTED_MOUNT \
  --expected-source MARKITDOWN_EXPECTED_SOURCE \
  --expected-tailnet-fqdn MARKITDOWN_FQDN \
  --expected-bundle-manifest-sha256 BUNDLE_MANIFEST_SHA256 \
  --runtime-release-manifest-sha256 RUNTIME_RELEASE_MANIFEST_SHA256 \
  --require-runtime
sudo bash ./deploy.sh
sudo bash ./status.sh
sudo python3 ./verify-runtime-topology.py
ss -ltnp
docker compose port api 8080
curl --fail --silent --show-error http://127.0.0.1:18010/livez
```

部署先记录上一健康容器、`.current-release*` 和完整环境，身份不一致则停止。
构建仅在下载锁定依赖时使用宿主网络，运行保持隔离；指定基础镜像本机已有时可复用，否则拉取。
随后检查拓扑、设置回环代理、核对固定健康身份并运行真实 PDF Canary：生成固定文本 PDF，鉴权上传、轮询、下载，
验证 ZIP/manifest/哈希及文本。通过后才原子写入 `.current-release`/`.current-release.env` 并安装 systemd 单元。
失败仅停止未验证的项目容器/代理，保留状态、凭据与上一健康版本。

记录服务/engine/build/schema/能力与 Worker heartbeat，核对唯一监听 `127.0.0.1:18010`、无 Docker 映射、
API 无默认路由、Worker 无网络、正确 UID/GID/只读 Token。远程直接访问公网/Tailscale IP 的 18010 必须失败。
systemd 固定实际版本目录并使用 `RequiresMountsFor=`；每次启动通过 `start.sh` 完整守卫。
Compose 的 `on-failure:5` 仅处理进程崩溃。

## HTTPS 发布与客户端

执行前根据当前 `tailscale serve --help` 核对语法，保留原配置/恢复依据，再发布专用节点根路径：

```bash
sudo tailscale serve --bg http://127.0.0.1:18010
tailscale serve status --json
curl --fail --silent --show-error https://MARKITDOWN_FQDN/livez
```

确认根路径转发回环入口，未启用 Funnel。Tailnet 策略仅授权约定身份的 TCP 443，分别验证允许/拒绝的客户端，
并确认没有扩大 SSH 等端口权限。Bearer 与网络授权同时保留。
每设备保存自己的单 Token 文件，客户端基址为 `https://MARKITDOWN_FQDN`，配置方法见 Workspace 部署指南。

```bash
sudo bash ./smoke-test.sh /path/to/non-sensitive-small.pdf
```

该补充测试验证真实鉴权、转换、下载、哈希和结果身份，成功后清理自身任务；无参数仅验证健康，不能替代真实转换。
同时验证 Engine 明确选择、缓存身份、标准/严格 QC、重转换和人工修改保护。

## 日常运行与凭据轮换

```bash
sudo bash ./status.sh
sudo docker compose logs --tail=100 api
sudo docker compose logs --tail=100 worker
du -sh /srv/markitdown-data/state /srv/markitdown-data/spool
df -h /srv/markitdown-data
df -i /srv/markitdown-data
sudo systemctl stop obsidian-markitdown.service
sudo systemctl start obsidian-markitdown.service
```

监控重启/OOM/超时、heartbeat、队列年龄、空间/inode、`storage_healthy`/`spool_bytes`/`filesystem_free_bytes`、
实际版本、Tailscale/Serve 与回环监听。degraded 时检查 Worker/存储；429 等待清理或 TTL，503 恢复资源/Worker，
401 检查 Token；身份不符停止提交。日志不包含 Authorization、文档正文或原始文件名。
停止主服务同时停止专属 proxy socket，保留 SQLite/spool；未安装主单元时使用 `start.sh`。
日常不使用裸 Compose 启动、`down -v` 或宽范围删除。

轮换顺序：服务端新增设备 Token → 只重建 API 并验证 → 安全更新客户端 → 删除旧行 → 再重建 API →
确认旧 Token 401、新 Token 成功。应用变更使用 `sudo docker compose up -d --force-recreate api`。
设备丢失时同时撤销 Tailnet 身份与对应 Token，保留其他设备行，仅记录设备和时间。

## 升级、回退与灾难恢复

升级前固定 revision/锁文件，用中文、双栏、表格、公式、图片和扫描 PDF 回归，记录旧 commit、镜像 digest、
环境和 build；下载需要保留的结果，输出变化时提升 build ID。保留全部旧镜像、bundle 和恢复资料。
按“盘点与安装版本包”安装新包：安装器沿用已知主机路径/UID/端口/资源/TTL，更新版本身份，未知配置键报错。
旧 current 原样成为 previous；systemd 仍指向旧版本，直到新版本 Canary 通过。
从新 current 运行 deploy/status/代表性 smoke，再核对客户端和服务身份。

每次健康升级的 `.last-known-good-release` 保存 rollback tag、不可变镜像 ID、build、双 manifest、
旧 Compose/完整环境哈希，`.last-known-good.env` 保存精确环境；权限 0600。跨 bundle 回退使用：

```bash
sudo bash /opt/markitdown-releases/current/deploy/markitdown/rollback-release-bundle.sh
```

回退器验证 current/previous、旧 bundle 哈希和审计记录，再由旧 bundle 无参数 `rollback.sh` 复现旧 Compose/环境，
`--no-build` 启动旧镜像并通过真实 Canary。成功后才交换指针与 systemd，较早审计归入 `rollback-records/`；
旧版失败时指针不变并尝试恢复当前版本。仅同 bundle 镜像回退才直接无参数调用 rollback.sh。
回退后客户端也必须兼容实际 build/schema，保留客户端已下载/QC/发布结果。数据库不兼容时先保留事故快照，
再在用户确认的新数据根重建，不就地试改 SQLite。

备份固定 revision、当前/前一完整 bundle、镜像 digest、受限环境/审计文件、加密 Token 恢复材料、网络授权与 Serve 配置。
服务端任务库/spool 为可重建缓存；先保住客户端原件、结果与账本。灾难恢复使用核验版本包、新数据目录、凭据和 Tailnet 授权。
升级、回退、Token 轮换与计划内主机重启均记录验证结果，只有完整预检、Canary、网络、客户端 QC 和恢复要求通过才确认上线。
