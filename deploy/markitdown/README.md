# CLab 专用 MarkItDown 服务器部署与运维手册

本文档用于把本仓库中的 MarkItDown 服务部署到一台**专用 CLab 服务器**。服务只承担
PDF/PPTX/DOCX 到 Markdown 的文本优先转换计算；源文档、下载后的结果 ZIP、转换账本、QC 结果和最终
Obsidian 笔记仍以客户端本地副本为准。

> 本仓库当前服务版本为 `1.4.0`，结果协议为 `markitdown-result/v3`，
> build 为 `markitdown-0.1.6-py31213-assets-v3`。实际服务器版本必须通过健康接口确认；
> 本文不把历史开发环境状态当作部署事实。
> 新服务器部署仍必须先确认 SSH alias、Tailnet HTTPS FQDN、数据根、预期挂载点和
> `findmnt` 返回的 filesystem source。本文不记录 Token。

## 1. 执行门槛：先补齐部署参数

开始任何写操作前，记录并由用户确认以下参数：

| 参数 | 必需 | 建议或说明 |
|---|---:|---|
| `CLAB_SSH_ALIAS` | 是 | 本机 OpenSSH 配置中的目标服务器别名，不在本文预设 |
| `MARKITDOWN_FQDN` | 是 | 专用 Tailscale 节点的完整 `*.ts.net` 名称 |
| `MARKITDOWN_DATA_ROOT` | 是 | 支持的默认值为 `/srv/markitdown-data`；若实际数据盘不同，必须先确认 |
| `MARKITDOWN_EXPECTED_MOUNT` | 是 | 数据根所在的实际挂载点；使用系统盘时必须明确写 `/` |
| `MARKITDOWN_EXPECTED_SOURCE` | 是 | `findmnt` 对上述挂载点返回的精确 SOURCE，防止漏挂后写错盘 |
| CPU / RAM | 是 | 至少 2 vCPU / 4 GiB；不足时先调整实例规格 |
| SSH sudo | 是 | SSH alias 对应账号可显式使用 `sudo`；部署脚本不依赖宽松 Token 权限 |
| Tailnet 客户端身份 | 是 | 哪些用户、设备或 tag 可以访问该节点的 TCP 443 |

在本地记录时可以使用以下模板，但在所有 `REPLACE_ME` 被替换前不得执行后续部署命令：

```text
CLAB_SSH_ALIAS=REPLACE_ME
MARKITDOWN_FQDN=REPLACE_ME.ts.net
MARKITDOWN_DATA_ROOT=/srv/markitdown-data
MARKITDOWN_EXPECTED_MOUNT=REPLACE_ME
MARKITDOWN_EXPECTED_SOURCE=REPLACE_ME
AUTHORIZED_TAILNET_IDENTITIES=REPLACE_ME
```

## 2. 服务定位与能力边界

MarkItDown 是当前默认的文本优先解析器；暂不使用 MinerU，但这不改变其能力边界：

- 适合有数字文本层的普通 PDF 和结构化 PPTX；
- 二进制旧 PPT 必须由 Windows 客户端先转换并验证为派生 PPTX；
- 不提供 OCR；
- PDF 不提取图片资产；DOCX/PPTX 会提取常规内嵌位图并改写为内容哈希附件；
- 不安全的 SVG 和无法可靠识别的图片格式不会发布，而会形成明确的缺图 warning；
- 不提供页级内容映射；
- 公式、复杂表格、双栏布局和阅读顺序只做尽力转换；
- 客户端必须继续执行严格规范化、QC 和人工复核；
- MarkItDown 结果默认进入 `review_required`，不能因手动选择解析器而绕过质量门禁。

服务端 SQLite、上传暂存和结果 ZIP 都是有 TTL 的可丢弃状态。服务端损坏或重建时，不应造成
正式资料丢失。

## 3. 最终拓扑和不可变安全规则

```text
授权客户端
    │
    │ HTTPS 443 + Bearer Token
    │ Tailscale Tailnet
    ▼
https://<MARKITDOWN_FQDN>/
    │
    │ Tailscale Serve：根路径反向代理
    ▼
http://127.0.0.1:18010
    │
    │ systemd TCP socket proxy（不解析、不缓存正文）
    ▼
internal:true Docker 网络中的 API 容器 ── SQLite + spool ── 无网络 Worker 容器
```

必须始终满足以下规则：

1. 宿主机只有项目专属的 systemd socket 绑定 `127.0.0.1:18010`；API 容器不发布宿主机端口。
2. 不在云安全组、CLab 防火墙或 UFW 中开放 `18010`。
3. 不使用 Tailscale Funnel；Funnel 会把服务暴露到公网。
4. 专用节点使用 Tailscale Serve 的根路径 `/`，客户端基址为
   `https://<MARKITDOWN_FQDN>`，不再使用 `/markitdown/` 子路径。
5. `/v1/*` 始终要求 Bearer Token；只有 `/livez` 不鉴权且不泄露版本和队列。
6. Worker 使用 `network_mode: none`，MarkItDown 插件保持关闭。
7. 不把 Docker Socket、宿主机任意目录、Obsidian Vault 或用户主目录挂入容器。
8. 不把 Token 写入 Git、Vault、命令历史、日志、工单或聊天记录。

Compose 内 API 监听 `0.0.0.0:8080` 仅发生在 `internal: true` 的容器网络命名空间中，且没有
默认路由。Docker 29 不会为这种 internal-only endpoint 实现宿主机端口发布，因此本项目明确
禁止 Compose `ports`，改由 `/usr/lib/systemd/systemd-socket-proxyd` 在宿主机回环地址接收纯
TCP 流并转发到当前 API 内部地址。代理不解析 HTTP、不记录 Token，也不挂载数据目录或 Docker
Socket；其目标地址在每次受控启动后重新验证并生成，不硬编码 Docker 子网。

## 4. 完整部署快照目录布局

每个 bundle 安装到以其 manifest SHA-256 命名的独立目录。`current` 和 `previous` 只是由安装器
原子替换的指针；升级绝不把新 tar 解压到正在使用的 release tree：

```text
/opt/markitdown-releases/
├── current -> releases/<当前 bundle manifest SHA-256>/
├── previous -> releases/<上一 bundle manifest SHA-256>/  # 或首次迁移时的旧绝对目录
├── rollback-records/                                      # 被替换的回滚审计记录
└── releases/
    ├── <当前 bundle manifest SHA-256>/
    │   ├── release-metadata.json
    │   ├── release-manifest.sha256
    │   ├── deploy/markitdown/
    │   │   ├── .env                    # 0600；运行配置，不在 manifest 中
    │   │   ├── .current-release*       # 0600；已验收运行身份
    │   │   ├── .last-known-good*       # 0600；上一健康运行身份
    │   │   ├── install-release-bundle.sh
    │   │   ├── rollback-release-bundle.sh
    │   │   ├── release_bundle.py
    │   │   ├── deploy.sh / rollback.sh / start.sh
    │   │   └── 其余部署与验证文件
    │   └── services/markitdown/
    └── <上一 bundle manifest SHA-256>/   # 完整保留，不覆盖
```

从旧布局第一次升级时，已有 `/opt/markitdown-backup` 保持原样并成为 `previous`；安装器不会移动、
覆盖或删除它。以后所有人工操作都从 `/opt/markitdown-releases/current` 进入。systemd 单元固定到
实际版本目录，而不是依赖可变符号链接；只有新版本通过 Canary 后，`deploy.sh` 才替换该单元。

服务端 Token 不放在仓库中，固定候选位置是：

```text
/etc/obsidian-markitdown/api-tokens.txt
```

必须部署打包工具生成的**完整部署快照**，不能只上传 `deploy/markitdown`。该快照是生产部署所需
文件的白名单集合，不等于工作站上的整个开发仓库。`compose.yaml` 位于
`/opt/markitdown-releases/current/deploy/markitdown`，其中构建上下文
`../../services/markitdown` 需要访问同一快照内的服务源码。所有 Compose 命令都应先进入：

```bash
cd /opt/markitdown-releases/current/deploy/markitdown
```

如果从其他目录直接运行 Compose，`.env` 和构建上下文更容易产生歧义，因此不纳入
支持流程。

## 5. 第一阶段：只读盘点

用户补齐第 1 节参数后，先通过指定 SSH alias 登录，只执行只读检查。以下占位符必须先替换为已确认值：

```bash
ssh CLAB_SSH_ALIAS
```

在服务器检查系统、Docker、端口、账号、磁盘和 Tailscale：

```bash
uname -a
cat /etc/os-release
docker version
docker compose version
docker info
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
tailscale serve status
tailscale serve status --json
sudo ufw status numbered
```

盘点通过标准：

- `18010` 未被其他进程占用；
- Docker Engine 和 Compose v2 正常；
- 挂载点和 SOURCE 与用户确认值精确一致；
- 目标数据盘有足够空间和 inode；
- 计划使用的 UID/GID 未冲突，或已经明确选择其他值；
- Tailscale 节点在线，MagicDNS 与 HTTPS 能力可用；
- 现有 Serve 配置已保存；专用服务器原则上不应承载其他业务路由；
- 防火墙和云安全组中没有 TCP 18010 入站规则。

如果挂载点或 SOURCE 不符合预期，立即停止。脚本会在任何目录创建前硬性比较两者，Compose
bind mount 也禁用了自动创建宿主路径。

## 6. 第二阶段：安装完整部署快照

本节由本地工作站生成并上传当前已测试的白名单部署快照；也可以从组织批准的固定 Git revision
生成等价快照。无论哪种分发方式，都不能只复制 Compose 子目录。示例中的大写占位符不能原样
执行。

在 Windows 工作站生成快照：

```powershell
cd E:\code\okf-workspace
.\scripts\package-markitdown-deployment.ps1
```

工具只打包服务源码、锁文件和 MarkItDown 部署文件，不包含 `.env`、Token、Vault、测试缓存或
本地账本。包内 `release-manifest.sha256` 固定每个文件，包外同名 `.sha256` 固定整个 tar.gz；
输出还给出 release manifest SHA-256。该值在新部署中同时作为当前 bundle 和运行镜像的初始身份。
`release-metadata.json` 还固定 service `1.4.0`、build
`markitdown-0.1.6-py31213-assets-v3`、schema `markitdown-result/v3` 和默认 profile
`fallback-assets-v2`，部署前应把这些值与 `.env`、compose 和 health 逐项对齐。

通过 SSH/SCP 上传 tar.gz、同名 `.sha256`，以及固定 revision 中的
`install-release-bundle.sh`、`release_bundle.py`。工作站先记录两个引导文件的 SHA-256，服务器
必须逐一核对；引导文件与 tar 必须来自同一 revision。以下是**首次安装**模板，所有占位符必须先
替换为实际值：

```bash
cd /absolute/staging/markitdown-release
sha256sum --check --strict --warn ARCHIVE_NAME.tar.gz.sha256
sha256sum install-release-bundle.sh release_bundle.py
sudo bash ./install-release-bundle.sh \
  --archive /absolute/staging/markitdown-release/ARCHIVE_NAME.tar.gz \
  --checksum /absolute/staging/markitdown-release/ARCHIVE_NAME.tar.gz.sha256
```

安装器先严格核对包外 SHA-256，再逐项解析 tar；它拒绝绝对路径、`..`、重复成员、符号/硬链接、
设备文件、FIFO、白名单外根目录、超量成员和超大展开体积。文件只会解压到 release store 内的唯一
暂存目录；包内逐文件与闭集校验通过后，才把目录原子改名为 manifest SHA-256。目标版本已存在时
只允许复验或幂等返回，绝不覆盖。不要用通用 `tar -xf` 直接覆盖 release tree，也不要从未固定的
远程默认分支构建生产镜像。

部署后验证快照拓扑：

```bash
cd /opt/markitdown-releases/current
test -f deploy/markitdown/compose.yaml
test -f deploy/markitdown/.env.example
test -f services/markitdown/Dockerfile
test -f services/markitdown/requirements.lock
realpath deploy/markitdown/../../services/markitdown
bash deploy/markitdown/verify-release.sh "$(pwd -P)"
```

`realpath` 必须指向 `current` 所在的同一个实际版本目录下的 `services/markitdown`。若不是，
Compose 构建上下文不完整，不能继续。首次安装此时还没有 `.env`，继续执行第 7 节；升级则严格
按第 16 节进行。

## 7. 第三阶段：显式初始化运行目录、`.env` 和 Token

生产流程不手工拼接目录和 `.env`，统一调用 `prepare-runtime.sh`。这个脚本只接受规范的绝对
路径，拒绝 `..`、符号链接路径和过宽目标；它不会格式化、挂载或递归清理任何磁盘。

初始 Token 应先在受控客户端生成并保存到 Vault 外，再通过安全文件传输放到服务器的临时
文件。聊天、命令行参数和终端输出中都不能出现 Token 内容。临时文件必须是部署用户或 root
所有、权限 `0600`，并使用绝对且无符号链接的路径，例如：

```bash
chmod 0600 /absolute/staging/markitdown-client.token
cd /opt/markitdown-releases/current/deploy/markitdown
sudo bash ./prepare-runtime.sh \
  --data-root /srv/markitdown-data \
  --token-file /etc/obsidian-markitdown/api-tokens.txt \
  --token-source /absolute/staging/markitdown-client.token \
  --service-uid 10002 \
  --service-gid 10002 \
  --host-port 18010 \
  --expected-mount MARKITDOWN_EXPECTED_MOUNT \
  --expected-source MARKITDOWN_EXPECTED_SOURCE \
  --expected-tailnet-fqdn MARKITDOWN_FQDN
```

脚本会完成以下可审计写操作：

- 只创建或收紧 `/srv/markitdown-data`、`state`、`spool` 三个明确目录为
  `10002:10002`、`0700`；内部 spool 子目录由服务以同一身份创建；
- 把 Token 安装到 `/etc/obsidian-markitdown/api-tokens.txt`，权限为
  `root:10002`、`0640`；
- 从 `.env.example` 以 `0600` 原子生成不含秘密的 `.env`；
- 若已有不同 `.env`，先保存权限为 `0600` 的唯一备份；
- 最后自动调用 `preflight.sh --require-runtime` 复验。

它不会删除 `--token-source`。等服务端、客户端均使用同一 Token 验证成功后，再删除那个已明确
确认的临时文件；不要对 `/tmp` 或其他宽目录做递归清理。已有 Token 不同时，脚本默认拒绝覆盖。
`--replace-token` 只适合首次单 Token 引导或有意替换**整个**服务端 Token 文件：输入必须恰好一条
有效 Token，执行后不会保留其他设备行。多设备单项轮换必须使用第 15 节“先新增、后切换、再
删除旧行”的流程，不能使用 `--replace-token`。

生成后的关键配置应为：

```dotenv
MARKITDOWN_IMAGE=obsidian-markitdown-service:1.4.0
MARKITDOWN_ENGINE_BUILD_ID=markitdown-0.1.6-py31213-assets-v3
MARKITDOWN_BUNDLE_MANIFEST_SHA256=<当前release-manifest.sha256文件的SHA-256>
MARKITDOWN_RELEASE_MANIFEST_SHA256=<运行镜像烘焙的release-manifest SHA-256>
MARKITDOWN_UID=10002
MARKITDOWN_GID=10002
MARKITDOWN_HOST_PORT=18010
MARKITDOWN_DATA_ROOT=/srv/markitdown-data
MARKITDOWN_TOKEN_FILE=/etc/obsidian-markitdown/api-tokens.txt
MARKITDOWN_EXPECTED_MOUNT=<已确认挂载点>
MARKITDOWN_EXPECTED_SOURCE=<findmnt显示的精确SOURCE>
MARKITDOWN_TAILNET_FQDN=<专用节点>.<tailnet>.ts.net
```

`MARKITDOWN_ENGINE_BUILD_ID` 是客户端转换身份的一部分；wrapper、MarkItDown 或任何可能改变
输出的依赖发生变化时，必须提升 build ID，不能让新输出复用旧缓存。

两个 manifest 字段职责不同：`MARKITDOWN_BUNDLE_MANIFEST_SHA256` 标识当前磁盘上的脚本、Compose
与服务源码快照，预检会把它与当前 `release-manifest.sha256` 文件的 SHA-256 核对；
`MARKITDOWN_RELEASE_MANIFEST_SHA256` 标识运行镜像，必须与镜像 label/环境及 `/v1/health` 一致。
正常新部署要求两者相等。受控回滚时运行镜像可以保留旧 release 身份，而当前 bundle 身份反映
实际执行回滚的脚本；能否回滚还取决于当前 bundle 是否可精确重现旧 Compose 配置。

初始资源限制按专用 2 vCPU、4 GiB RAM 主机设置：

| 项目 | 默认值 |
|---|---:|
| 最大上传 PDF/PPTX/DOCX | 64 MiB |
| 最大结果 ZIP | 128 MiB |
| 最大页数/幻灯片数 | 500 |
| 活动任务上限 | 3（单 Worker，通常为 1 个处理、2 个等待） |
| 并发上传 | 1 |
| spool 总量上限 | 2 GiB |
| 运行时最低剩余空间 | 2 GiB |
| 单任务超时 | 600 秒 |
| API 内存/CPU | 256 MiB / 0.5 CPU |
| Worker 内存/CPU | 2 GiB / 1.5 CPU |
| 成功结果 TTL | 2 小时 |
| 失败任务 TTL | 24 小时 |

不要用取消内存、单元数或上传限制来掩盖 OOM；应使用代表性 PDF/PPTX/DOCX 压测后调整输入上限或升级
服务器资源。

## 8. 第四阶段：渲染配置、构建与回环启动

先运行仓库提供的只读预检；它会验证 Ubuntu 24.04 x86-64、Docker/Compose、Tailscale、
Compose 渲染、端口绑定、磁盘空间、规范路径、Token 权限和运行目录所有权：

```bash
cd /opt/markitdown-releases/current/deploy/markitdown
sudo bash ./preflight.sh \
  --data-root /srv/markitdown-data \
  --token-file /etc/obsidian-markitdown/api-tokens.txt \
  --host-port 18010 \
  --service-uid 10002 \
  --service-gid 10002 \
  --expected-mount MARKITDOWN_EXPECTED_MOUNT \
  --expected-source MARKITDOWN_EXPECTED_SOURCE \
  --expected-tailnet-fqdn MARKITDOWN_FQDN \
  --expected-bundle-manifest-sha256 BUNDLE_MANIFEST_SHA256 \
  --runtime-release-manifest-sha256 RUNTIME_RELEASE_MANIFEST_SHA256 \
  --require-runtime
```

通过后再执行：

```bash
sudo bash ./deploy.sh
```

新部署首先要求 bundle manifest 与运行镜像 release manifest 身份相等。若已有健康版本，
`deploy.sh` 会先确认运行容器、`.current-release` 和 `.current-release.env` 三者完全一致，再保存
完整上一健康审计快照：rollback tag、不可变镜像 ID、build ID、运行镜像 release manifest、旧
bundle manifest、旧 `.env` 及其 SHA-256，以及旧 `.env` 渲染的 Compose SHA-256。其中元数据写入
`.last-known-good-release`，完整环境写入 `.last-known-good.env`，均为 `0600`。

随后脚本执行带 `--pull` 的构建，启动 API/Worker，验证实际容器网络拓扑，并原子配置项目专属的
loopback socket proxy；之后再执行固定身份健康检查并用 `generate-canary.py`
生成含 `Obsidian MarkItDown deployment canary` 的真实单页 PDF，通过鉴权 API 完成提交、轮询、
ZIP 下载、manifest/哈希及 Markdown 固定文本验证。只有这个端到端门禁通过，才以 `0600` 原子写入
`.current-release`（不可变镜像 ID、build ID、运行镜像 release manifest、当前 bundle manifest、
渲染 Compose SHA-256）和 `.current-release.env`（本次完整 `.env` 快照）。部署验收因此不只是
health。随后安装并启用 `obsidian-markitdown.service`。该 systemd 单元通过
`RequiresMountsFor=` 绑定已确认挂载点，每次开机都先运行 `start.sh` 的完整预检；Compose
只使用 `on-failure:5` 处理进程级崩溃，不绕过开机挂载守卫。部署失败时会输出有限日志，并只
停止未验证的本项目容器与回环代理；不会删除状态、Token 或覆盖上一健康镜像。

仍应人工确认：

- build context 指向 `/opt/markitdown-releases/current/services/markitdown`；
- state/spool 指向 `/srv/markitdown-data`；
- API 没有 Compose `ports`，其唯一网络为 `internal: true` 的 `api-internal`；
- `obsidian-markitdown-proxy.socket` 只监听 `127.0.0.1:18010`，代理目标是经运行态门禁确认的 API IPv4；
- Worker 为 `network_mode: none`；
- API 内没有默认路由和外网出口；
- 两个容器均为非 root UID/GID；
- 没有 Docker Socket和无关宿主机目录挂载；
- Token 文件为只读挂载。

正式环境优先把镜像推送到受控 registry，并在 `.env` 中使用
`repository@sha256:<digest>`；不要使用 `latest`、Watchtower 或其他无人值守自动更新器。

再次查看状态：

```bash
sudo bash ./status.sh
```

`status.sh` 会显示 Compose 状态并调用鉴权健康校验器，严格核对 service、engine、build ID、
result schema 和 Worker heartbeat。Worker 首次启动后才会写入 heartbeat；若刚启动时短暂显示
`degraded`，先检查 Worker 状态和日志，不要绕过健康检查。

查看有限日志：

```bash
sudo docker compose logs --tail=200 api
sudo docker compose logs --tail=200 worker
```

日志中不应出现 Authorization、Token、文档内容、Markdown 内容或原始文件名。

## 9. 第五阶段：验证 18010 只在回环监听

在服务器执行：

```bash
ss -ltnp | grep ':18010 '
docker compose port api 8080 || true
sudo systemctl --no-pager --full status obsidian-markitdown-proxy.socket
sudo python3 ./verify-runtime-topology.py
curl --fail --silent --show-error http://127.0.0.1:18010/livez
sudo ufw status numbered
```

验收结果必须显示 `127.0.0.1:18010`，不能是 `0.0.0.0:18010`、`[::]:18010`、服务器公网 IP
或 Tailscale IP；`docker compose port api 8080` 必须没有映射；运行态门禁必须确认 API 只有
internal 网络、无 PortBindings，Worker 没有真实网络。云安全组和 CLab 入口策略中也不得有
18010 规则。

从另一台设备直接访问以下地址应失败：

```text
http://<服务器公网地址>:18010/
http://<服务器Tailscale地址>:18010/
```

这项失败是正确的安全结果。远程访问只能通过下一节的 Tailnet HTTPS 443。

## 10. 第六阶段：Tailscale Serve 根路径发布

本手册假定服务器是 MarkItDown 专用 Tailscale 节点，因此把 HTTPS 根路径 `/` 完整转发给服务。配置前
必须先得到用户确认的 `MARKITDOWN_FQDN`，并保存现有 Serve 状态：

```bash
tailscale version
tailscale serve --help
tailscale serve status
tailscale serve status --json
```

Tailscale 1.52 之后 Serve CLI 语法发生过变化；执行前应以服务器当前 `--help` 和
[Tailscale Serve 官方命令文档](https://tailscale.com/docs/reference/tailscale-cli/serve)为准。当前支持的
根路径反向代理形式为：

```bash
sudo tailscale serve --bg http://127.0.0.1:18010
```

不要添加 `--set-path=/markitdown`，也不要运行 `tailscale funnel`。配置后检查：

```bash
tailscale serve status
tailscale serve status --json
curl --fail --silent --show-error https://MARKITDOWN_FQDN/livez
```

Serve 状态必须表现为：

```text
https://MARKITDOWN_FQDN/
    -> http://127.0.0.1:18010
```

客户端最终 API 基址是：

```text
https://MARKITDOWN_FQDN
```

不是 `http://...:18010`，也不是 `https://MARKITDOWN_FQDN/markitdown`。

同时在 Tailnet 管理策略中，只允许用户确认的客户端身份访问该专用节点 TCP 443。网络授权不能替代
Bearer Token；两层必须同时保留。至少验证：

- 授权客户端能访问 HTTPS 443；
- 未授权客户端不能访问 HTTPS 443；
- 任意远程客户端都不能访问 TCP 18010；
- MarkItDown 规则没有额外授予 SSH 22 或其他端口；
- 没有启用 Funnel。

## 11. HTTP API 契约

### 11.1 路由

| 方法与路径 | 鉴权 | 说明 |
|---|---:|---|
| `GET /livez` | 否 | 只证明 API 进程存活 |
| `GET /v1/health` | 是 | 返回 Worker heartbeat、版本、build ID、队列和固定能力 |
| `POST /v1/tasks` | 是 | 原始 PDF、PPTX 或 DOCX 流式上传；新建返回 202，幂等命中返回 200 |
| `GET /v1/tasks/{id}` | 是 | 查询 `pending/processing/completed/failed/cancelled/expired` |
| `GET /v1/tasks/{id}/status` | 是 | 状态接口兼容别名 |
| `GET /v1/tasks/{id}/result` | 是 | 等待中返回 202，成功后返回 ZIP，过期返回 410 |
| `DELETE /v1/tasks/{id}` | 是 | 取消等待中或处理中任务，或提前清理缓存 |

### 11.2 上传请求

```http
POST /v1/tasks
Authorization: Bearer <device-token>
Content-Type: application/pdf
# PPTX 使用：
# application/vnd.openxmlformats-officedocument.presentationml.presentation
Idempotency-Key: <16-200 safe ASCII characters>
X-Source-SHA256: <64 hexadecimal characters>
X-Filename: <optional percent-encoded display name>
X-MarkItDown-Profile: fallback-assets-v2

<raw PDF, PPTX, or DOCX bytes>
```

服务不接受 multipart、URL、服务器文件路径、旧 PPT/DOC 或其他文档格式。服务端会流式限制大小：
PDF 检查 `%PDF-` 魔数；PPTX/DOCX 检查 OOXML ZIP 结构、路径安全、加密/重复条目、解压总量、
必需部件、VBA 宏和逻辑单元数量；三种格式都会重新计算 SHA-256。`X-Filename` 只用于显示和
manifest，不作为磁盘路径。

客户端把 profile、health 返回的 build ID 摘要和源哈希共同写入 `Idempotency-Key`。同一键与
相同源哈希/profile 会返回原任务；同一键绑定不同输入时返回 409。新 build 会获得新的幂等身份，
不会误取升级前的缓存；成功结果 TTL 过期后，该键也可以安全创建新任务。

### 11.3 结果 ZIP

PDF 结果严格只包含前两项；DOCX/PPTX 有安全可发布的内嵌位图时还会包含内容寻址附件：

```text
manifest.json
document.md
images/<完整SHA-256>.<扩展名>  # 可选；同一图片只保存一次
```

manifest 会绑定：

- 源文档 SHA-256；
- Markdown SHA-256 和字节数；
- MarkItDown、service 和 build 版本；
- `fallback-assets-v2`；
- `source_format=pdf|pptx|docx`；
- `unit_kind=page|slide|document`、逻辑单元数和输入字节数；
- OOXML 图片 relationship/reference 数量和实际输出引用数量；
- 每个附件的相对路径、SHA-256、MIME 和字节数；
- PDF text-only、外链图片、危险 SVG 或缺图等明确 warning。

服务不会伪造 PDF 图片目录、页映射或 `content_list.json`。DOCX/PPTX 附件只来自原始 OOXML
关系引用，并会在服务端和客户端分别校验。客户端下载 ZIP 后仍须检查 Content-Type、ZIP 魔数、
压缩/展开大小、`X-Result-SHA256`、Markdown 哈希以及每个附件的 manifest 元数据。

## 12. 真实 PDF 冒烟测试

`deploy.sh` 和 `rollback.sh` 已自动调用 `generate-canary.py` 生成无敏感信息、含固定文本的真实
PDF，并把提交、轮询、下载、manifest、哈希和 Markdown 固定文本检查作为提交部署/回滚的门禁。
这保证基本端到端链路，而不是只验证 health。

以下手工测试用于在回环、Serve、Grants 和 Token 均验收通过后，再用代表实际文档特征但不含
敏感信息的小型 PDF 做补充回归：

```bash
cd /opt/markitdown-releases/current/deploy/markitdown
sudo bash ./smoke-test.sh /path/to/non-sensitive-small.pdf
```

脚本不会打印 Token。它会完成鉴权健康检查、提交、轮询、下载和清理，并验证源哈希、响应结果
哈希、ZIP 魔数与精确条目、manifest schema、engine/service/build 身份、固定能力声明以及 Markdown
字节数和哈希。成功后测试任务会用随机幂等键显式清理，避免占用 spool；幂等重放和冲突语义由
服务 API 自动化测试覆盖。

不带 PDF 参数时只验证服务身份和 Worker 健康：

```bash
sudo bash ./smoke-test.sh
```

## 13. 客户端配置与手动直达入口

每台客户端只保存自己的单个 Token，文件必须位于 Vault 外。客户端配置项为：

```text
OBSIDIAN_PDF_INGEST_MARKITDOWN_API_URL=https://MARKITDOWN_FQDN
OBSIDIAN_PDF_INGEST_MARKITDOWN_TOKEN_FILE=<客户端本地受限Token文件>
```

手动直用 MarkItDown 时选择：

```text
obsidian-ingest ingest <PDF|PPTX|DOCX|PPT> --flow learning --parser markitdown
```

该入口必须完全跳过 MinerU。首次结果通过硬安全检查后仍会进入人工复核；复核完成后再使用本地
`approve <conversion-id>` 流程发布。`--profile quality` 只属于 MinerU，不能传给手动
MarkItDown；`auto` 回退后也仍固定使用 `fallback-assets-v2`。MarkItDown 即使使用
`--no-publish` 也会先停在 `review_required`，不会改为 `ready`。服务端不参与 Obsidian 写入。

## 14. 日常运维

### 14.1 状态检查

```bash
cd /opt/markitdown-releases/current/deploy/markitdown
sudo bash ./status.sh
sudo docker compose ps
sudo docker compose logs --tail=100 api
sudo docker compose logs --tail=100 worker
du -sh /srv/markitdown-data/state /srv/markitdown-data/spool
df -h /srv/markitdown-data
df -i /srv/markitdown-data
tailscale status
tailscale serve status
```

建议监控：

- API 和 Worker 容器重启次数；
- `/livez` 与鉴权后的 `/v1/health`；
- Worker heartbeat 是否新鲜；
- 队列深度和最老任务；
- OOM、超时和重复失败；
- 数据盘容量和 inode；
- health 中的 `storage_healthy`、`spool_bytes` 和 `filesystem_free_bytes`；
- Tailscale 与 Serve 状态；
- 宿主机 18010 是否仍只在回环监听。
- `systemctl status obsidian-markitdown.service` 及数据挂载依赖是否正常。

### 14.2 常见状态解释

| 现象 | 重点检查 | 处理原则 |
|---|---|---|
| `/livez` 失败 | API 容器、proxy socket、运行态拓扑、日志 | 通过 `start.sh` 恢复完整链路，不给 API 添加 `ports` |
| health 返回 503/degraded | Worker 容器、heartbeat、数据权限 | 恢复 Worker，不绕过客户端版本检查 |
| health 中 `storage_healthy=false` | spool 上限或磁盘最低水位 | 等待 TTL 清理、下载结果或扩容；不要取消守卫 |
| 401 | Token 文件、设备 Token 是否撤销 | 不在日志或终端打印 Token |
| 413 | 文档超过 64 MiB 或逻辑单元数上限 | 使用 MinerU 或拆分经授权的副本；不随意取消限制 |
| 429 | 活动任务已满 | 等待并使用相同幂等键重试 |
| 409 | 幂等键绑定了不同输入 | 调查客户端 conversion identity，不生成随机绕过键 |
| 410 | 任务或结果已过期 | 从客户端保留的源文档重新提交 |
| failed/cancelled | 查询错误类别和客户端账本 | 保留审计，不把失败伪装成服务不可用 |
| OOM/反复重启 | Worker 内存、输入大小、代表性 PDF/PPTX | 升级内存或降低限制，不移除 cgroup 限额 |
| health build/version 不符 | 镜像、`.env`、实际 digest | 禁止提交，恢复匹配版本或完成受控升级 |

### 14.3 正常停止和启动

通过 systemd 正常停止并保留状态：

```bash
sudo systemctl stop obsidian-markitdown.service
sudo systemctl --no-pager --full status obsidian-markitdown.service
sudo systemctl is-active obsidian-markitdown-proxy.socket || true
```

重新启动时必须让 systemd 调用 `start.sh`，先完成挂载、release、FQDN、Token 和目录守卫：

```bash
sudo systemctl start obsidian-markitdown.service
sudo systemctl --no-pager --full status obsidian-markitdown.service
cd /opt/markitdown-releases/current/deploy/markitdown
sudo bash ./status.sh
```

停止主服务会通过 `PartOf=` 同时停止项目专属 proxy socket。若 systemd 主单元尚未安装，只能
从部署目录执行 `sudo bash ./start.sh`；不要用裸 `docker compose up` 代替启动守卫，因为裸启动
既不会验证运行态拓扑，也不会安全生成 loopback 入口。停止服务不会主动删除 bind mount 中的
SQLite 和 spool。
不要使用 `down -v` 作为日常操作，也不要对 `/srv`、数据盘根目录或未解析变量执行递归删除。

## 15. Token 轮换和设备撤销

推荐无中断轮换顺序：

1. 在服务端 Token 文件新增该设备的新随机 Token；
2. 仅重建 API 容器并验证新 Token；
3. 安全更新客户端的单 Token 文件；
4. 从服务端删除旧 Token 行；
5. 再次重建 API 容器；
6. 验证旧 Token 返回 401、新 Token正常；
7. 记录轮换时间和设备标识，但不记录 Token 内容。

应用 Token 文件变化：

```bash
cd /opt/markitdown-releases/current/deploy/markitdown
sudo docker compose up -d --force-recreate api
sudo docker compose ps api
```

设备丢失时，同时从 Tailnet 撤销该设备身份并删除对应应用 Token。只做其中一项不完整。

## 16. 升级、回归和回滚

### 16.1 升级前

1. 固定新仓库 revision 和依赖 lock；
2. 使用中文论文、双栏、表格、公式、图片和扫描 PDF 回归集进行离线比较；
3. 记录当前 Git commit、镜像 ID/digest、`.env` 和 build ID；
4. 确认客户端已经下载所有仍需保留的结果；
5. 如果输出可能变化，提升 `MARKITDOWN_ENGINE_BUILD_ID`；
6. 确认 `/opt/markitdown-releases/current`（或首次迁移时的 `/opt/markitdown-backup`）仍能通过
   `verify-release.sh`，且 `.current-release*` 与健康容器一致；
7. 生成新 tar，上传 tar、同名 `.sha256` 以及同一固定 revision 的两个引导文件；不要预先删除
   任何旧镜像或旧 bundle。

服务器先核对引导文件的已记录 SHA-256，再安装新 bundle：

```bash
cd /absolute/staging/markitdown-release
sha256sum --check --strict --warn ARCHIVE_NAME.tar.gz.sha256
sha256sum install-release-bundle.sh release_bundle.py
sudo bash ./install-release-bundle.sh \
  --archive /absolute/staging/markitdown-release/ARCHIVE_NAME.tar.gz \
  --checksum /absolute/staging/markitdown-release/ARCHIVE_NAME.tar.gz.sha256

readlink -f /opt/markitdown-releases/current
readlink -f /opt/markitdown-releases/previous
cd /opt/markitdown-releases/current/deploy/markitdown
sudo bash ./deploy.sh
sudo bash ./status.sh
sudo bash ./smoke-test.sh /path/to/non-sensitive-small.pdf
```

安装器不会写入正在使用的 release tree。它在独立暂存目录完成 tar 安全检查、包内哈希和闭集校验，
再原子安装为 `releases/<manifest SHA-256>`。若存在健康旧版本，它从新 `.env.example` 取得新镜像、
Python 基础镜像、build 和双 manifest 身份，同时保留旧 `.env` 中的主机路径、端口、UID/GID、资源
限制和 TTL；未知旧配置键会使升级停止，不能静默丢弃。旧 `.current-release*` 被复制到新目录，仅用于
让 `deploy.sh` 精确确认当前健康容器并生成回滚点。最后 `current` 原子指向新 bundle，`previous`
指向未改动的旧 bundle。此时旧 systemd 单元仍固定在旧实际目录；只有新版本完整验收后才被替换。

`deploy.sh` 自身会自动执行固定文本真实 PDF Canary；`smoke-test.sh` 用代表性 PDF 做额外回归。
构建时仅使用宿主机网络下载哈希锁定的 Python 依赖；API 运行时仍只接入内部网络，Worker
运行时仍无网络。若镜像仓库暂时不可用，部署脚本会复用主机已有的指定 Python 基础镜像，
否则主动拉取基础镜像。上线仍以完整 Canary 和运行镜像身份核对为准。
升级后还要检查 health 中的 engine、service、build ID 和 result schema。新 build 必须形成新的
客户端转换身份，不能复用旧 build 的成功缓存。

客户端仍可读取已经下载的 `markitdown-result/v2` 结果，但升级不会改写已经发布的 Source Text。
若早期 UAT 导入存在缺失图片、失效图片链接或缺少正文 H1，应保留原件并在 `1.3.0` 部署完成后
显式重新转换；这属于重新派生，不应通过迁移脚本猜测或修补旧正文。

### 16.2 回滚

每次从健康版本升级时，`deploy.sh` 都会保存完整上一健康运行快照：`.last-known-good-release` 记录
rollback tag、不可变镜像 ID、build ID、运行镜像 release manifest、旧 bundle manifest、渲染
Compose SHA-256 和完整环境文件 SHA-256；`.last-known-good.env` 保存对应的精确 `.env`。两者权限
均为 `0600`。bundle 管理器另外完整保留旧 release tree，因此 Compose 或部署脚本发生变化时也能
用旧 bundle 重现旧配置。

升级失败或验收后决定退回时，调用 bundle 级回滚器：

```bash
sudo bash /opt/markitdown-releases/current/deploy/markitdown/rollback-release-bundle.sh
```

回滚器不接受任意镜像或目录。它解析受控的 `current`/`previous` 指针，逐份校验两个 release，且
要求 `.last-known-good-release` 记录的旧 bundle SHA-256 与 `previous` 完全相等。随后把完整回滚记录
原子传给旧 bundle，由旧 bundle 自己的 `rollback.sh` 核对环境 SHA-256、不可变镜像 ID、build、双
manifest 和旧 Compose，使用 `--no-build` 启动旧镜像，并执行真实 PDF Canary。旧服务验证通过后，
才安装旧 systemd 单元并原子交换 `current`/`previous`；替换前已有的更早回滚记录保存在 release
store 的 `rollback-records/` 中。若旧版本验证失败，指针不变，并尝试恢复当前已验收版本。

同一个 bundle 内仅回滚运行镜像时，底层 `rollback.sh` 仍只允许无参数调用；跨 bundle 升降级必须
使用上述 bundle 级回滚器，不能手工改符号链接、复制 `.env` 或把 tar 覆盖到当前目录。

旧 build 在服务器上通过 Canary 后，当前客户端仍可能因 build、schema 或能力身份不匹配而严格
拒绝它。此时必须配套恢复与旧 build 兼容的客户端，或改用服务端与客户端共同兼容的 release；
不能放宽客户端校验，也不能只回滚镜像而继续声明新 build ID。

服务端回滚不得删除或覆盖客户端已下载、已 QC 或已发布的结果。若数据库与旧版本不兼容，优先把当前
数据目录作为事故快照保留，再在用户确认的新空数据根中重建；不要就地试探性修改 SQLite。

## 17. 备份与灾难恢复

需要备份或记录：

- 固定源 revision 或部署快照 digest；
- `/opt/markitdown-releases/current` 与 `previous` 指向的两份已验证完整 bundle；
- Compose 配置，以及权限为 `0600` 的 `.env`、`.current-release*`、`.last-known-good*` 审计记录；
- 镜像 digest；
- 当前 engine/service/build 身份；
- 经过加密保护的 Token 恢复材料；
- Tailnet 授权与 Serve 配置的审计记录。

不作为正式备份对象：

- `/srv/markitdown-data/state/jobs.sqlite`；
- incoming/results/failed spool；
- 服务器上的临时 PDF 和结果 ZIP。

灾难恢复可以在新专用服务器上重新部署完整部署快照、重建数据目录、恢复 Token 和 Tailscale 授权。客户端
保留的源文档、结果与账本才是正式恢复来源。

## 18. 最终验收清单

部署完成前逐项签字确认：

- [ ] 用户已提供并确认 SSH alias；
- [ ] 用户已提供并确认 Tailnet FQDN；
- [ ] 用户已确认 `/srv/markitdown-data` 或替代数据根；
- [ ] 用户已确认预期挂载点，实时 `findmnt` 的 TARGET 和 SOURCE 与记录值精确一致；
- [ ] 用户已确认 CPU/RAM、sudo 能力及获准访问的 Tailnet 用户、设备或 tag；
- [ ] `/opt/markitdown-releases/current` 指向 manifest SHA-256 命名的完整 `deploy` 与 `services`；
- [ ] 升级时 `previous` 指向未改动且通过闭集校验的上一 bundle（首次旧布局迁移可指向
  `/opt/markitdown-backup`）；
- [ ] Compose 构建上下文正确指向部署快照内服务源码；
- [ ] tar.gz 包外 SHA-256、包内 release manifest、逐文件与闭集校验均通过并已记录；
- [ ] `.env` 为 `0600`，且数据根、挂载/source、UID/GID、端口、build ID、bundle manifest 和运行
  镜像 release manifest 身份正确；
- [ ] 生产镜像及基础镜像 digest 已记录，没有 `latest` 或无人值守更新器；
- [ ] data root marker、state/spool 的所有者和权限通过预检；
- [ ] Token 每设备独立，未进入 Git/Vault/日志；
- [ ] 多设备 Token 新增/撤销测试不会覆盖或中断其他设备；
- [ ] API 无宿主机 PortBindings，项目专属 proxy socket 仅监听 `127.0.0.1:18010`；
- [ ] 安全组和 UFW 未开放 18010；
- [ ] Worker 无网络，插件关闭，资源限制生效；
- [ ] 变更前的完整 Tailscale Serve 状态已保存，当前版本的恢复/撤销命令已人工确认；
- [ ] Tailscale Serve 在专用 FQDN 根路径 `/` 转发；
- [ ] 未启用 Funnel；
- [ ] Grants 只允许指定客户端访问 TCP 443；
- [ ] 健康检查的版本、build ID、schema 和能力完全匹配；
- [ ] `systemctl restart` 后完整预检和健康检查通过，计划内重启主机后服务仍能恢复；
- [ ] `deploy.sh` 自动生成的固定文本 PDF 已通过上传、轮询、下载、manifest、哈希和内容验证；
- [ ] 客户端手动 `--parser markitdown` 不接触 MinerU；
- [ ] `auto` 的精确 MarkItDown 缓存优先与 MinerU 提交前回退语义均已验证；
- [ ] `quality` 不传给 MarkItDown，`--no-publish` 的 MarkItDown 结果仍停在 `review_required`；
- [ ] MarkItDown 输出停在人工复核门禁，不自动覆盖已有笔记；
- [ ] `.current-release*` 与 `.last-known-good*` 的镜像、双 manifest、完整环境和 Compose 审计完整；
- [ ] bundle 级回滚已验证旧 Compose/镜像/Canary、systemd 单元和 `current`/`previous` 原子交换；
- [ ] 升级、无参数运行镜像回滚、Token 轮换和灾难恢复记录完整。

在第 1 节全部必填参数得到用户确认且本次执行获得明确授权以前，本手册只作为待执行方案，不授权
连接或修改任何服务器。
