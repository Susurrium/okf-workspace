# 文档转换方式

Engine 默认使用 `mineru-cloud`，同时保留 `markitdown-service` 和显式启用的
`mineru-self-hosted`。Dashboard 从鉴权接口 `GET /documents/converters` 读取支持格式、
配置状态、运行位置和能力限制；读取目录不会发起服务探测或启动 SSH/GPU 服务。

## 用户流程

- 导入窗口分别选择转换方式、质量检查、用途及 Course/Project。
- `quick` 表示标准检查；`high` 表示严格检查图片，不改变转换方式或提升解析器能力。
- 混合文件夹逐文件检查格式与大小；含不支持项时，需调整方式，或明确选择只提交支持项。
- 未配置的方式保留可见，并显示配置提示。云 Token 缺失不阻止使用配置好的 MarkItDown。
- 失败、等待重试及最近完成的任务可选择原方式重试或明确重新转换。
- 重复上传复用已有任务/Source，不隐式覆盖正文；替换结果使用重新转换入口。
- 重新转换沿用原件、任务和 Source 身份，更新未被人工修改的 Source Text。
  人工修改产生冲突时保留笔记；可通过“查看本次转换结果”查看只读 Markdown 和 QC 报告。
- 正在执行的任务拒绝切换（HTTP 409）；任务完成或进入等待后再选择。

## 当前格式与边界

| 方式 | 输入 | 边界 |
| --- | --- | --- |
| MinerU 云端 | PDF、DOC/DOCX、PPT/PPTX、PNG/JPG/JPEG/WebP/BMP/GIF | 默认；保留选择性 OCR；机器结果需复核 |
| MarkItDown 服务 | PDF、DOC/DOCX、PPT/PPTX | 不提供 OCR；PDF 文本优先，不提取图片；DOCX/PPTX 提取常规内嵌图片 |
| MinerU 自建 | PDF、PPT/PPTX | 配置后启用；旧 Office 路径不执行云端补充 OCR；其他格式暂不开放 |

旧 DOC/PPT 使用本机 Microsoft Office COM 生成 DOCX/PPTX 后提交，原件不变。
自建 PDF 可使用服务本身的解析能力；不能把“支持自建 MinerU”解释为所有格式、所有云能力相同。
MarkItDown PDF 的严格检查不会证明图片完整，应显示“PDF 图片完整性未验证”。
所有输入当前上限 64 MiB。实际服务可能拒绝超出其页数、存储或处理能力的输入。

## 部署配置

配置位于 Vault 和仓库之外的 `deployment.json`。示例仅展示相关字段，需合并到完整配置：

```json
{
  "default_conversion_method": "mineru-cloud",
  "mineru_token_file": "E:/ObsidianData/OKF-Brain-State/secrets/mineru-client.token",
  "mineru_model": "vlm",
  "markitdown_url": "http://127.0.0.1:18010",
  "markitdown_token_file": "E:/ObsidianData/OKF-Brain-State/secrets/markitdown-client.token",
  "mineru_self_hosted_enabled": false,
  "mineru_url": "http://127.0.0.1:18000",
  "mineru_ssh_managed": true,
  "mineru_ssh_host": "bjmu-inner",
  "mineru_ssh_remote_port": 8000
}
```

自建直连使用 `mineru_self_hosted_enabled=true`、`mineru_ssh_managed=false`；
受管 SSH 使用 `mineru_ssh_managed=true` 和明确的本地回环 URL、SSH alias、远端端口。
只有实际执行这种转换才会进入原 SSH 服务生命周期。部署资产见 `integrations/mineru`，
启用前按其手册验证目标服务；旧部署记录不是当前运行状态证明。
MarkItDown 远端地址必须使用 HTTPS；其网络隔离 worker 与 Vault 发布保持独立。

Windows 安装器提供 `-DefaultConversionMethod`、`-MarkItDownUrl`、`-MarkItDownTokenFile`、
`-MinerUSelfHostedEnabled`、`-MinerUUrl`、`-MinerUSshManaged`、`-MinerUSshHost`、
`-MinerUSshRemotePort`；未显式传入的选项沿用既有部署配置。
日常入口 `scripts/deploy.ps1` 也转发这些参数，包括显式的 `$false` 和空 Token 路径。
相应环境变量为 `OKF_DEFAULT_CONVERSION_METHOD`、`OKF_MARKITDOWN_URL`、
`OKF_MARKITDOWN_TOKEN_FILE`、`OKF_MINERU_SELF_HOSTED_ENABLED`、`OKF_MINERU_URL`、
`OKF_MINERU_SSH_MANAGED`、`OKF_MINERU_SSH_HOST`、`OKF_MINERU_SSH_REMOTE_PORT`。
Token 内容始终仅存储于外部凭据文件。旧 Dashboard `documentParserPolicy` 不再限制可选方式。

## API、CLI 与恢复

`POST /documents/import` 增加可选 `method`，取值 `auto` 或上述三个方式 ID。
`auto` 在入队时固定为具体方式，改变默认配置不改变已有任务。
旧 `parser=mineru` 固定映射到云端，`parser=markitdown` 固定映射到 MarkItDown；
同时指定不一致的 `parser` 与 `method` 会被拒绝。接口与 CLI 都执行同一格式校验。

```powershell
okf import paper.pdf --intent source --method markitdown-service --quality high
okf conversion retry conv-EXAMPLE --method mineru-self-hosted
```

`POST /documents/conversions/{id}/retry` 不传方式时恢复原任务；传 `method` 时明确重新转换。
导出 manifest 和尝试记录保存具体方式。缓存必须匹配方式，云端/自建结果不会混用。
显式重新转换产生新的执行 revision，避免复用服务端旧幂等结果。
云端暂时失败仍使用兼容状态 `waiting-for-mineru`；其他转换服务使用 `waiting-for-parser`。
QC 失败记录为 `quality=failed`；只有 QC 通过且发布失败才可“继续保存”。
`GET /documents/conversions/{id}/result` 返回本次 Markdown、QC、方式及附件路径，供只读查看。

## 验收

针对性测试覆盖三种方式、两种质量档位、默认冻结、格式拒绝、旧参数兼容、
跨方式缓存隔离、等待中的切换、执行锁、质量警告和人工修改保护。
执行 Engine pytest/Ruff/Pyright、Dashboard Vitest/TypeScript/build、fixture-Vault 跨模块测试
及 `scripts/check.ps1`。真实云端、MarkItDown 和自建端点需各自使用公开 fixture 验收；
mock 通过只证明协议及工作流，不证明外部服务在线。
