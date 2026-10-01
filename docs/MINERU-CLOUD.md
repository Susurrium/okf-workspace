# MinerU 云解析

MinerU 云解析是默认转换方式；还可选择 MarkItDown 或配置好的自建 MinerU，见
[转换方式与配置](DOCUMENT-CONVERSION.md)。选择云解析时由 Engine 调用官方精准解析 API。
Dashboard 只提交文件和显示进度，
不会读取 MinerU token。默认模型是 `vlm`，`quick` 与 `high` 只区别本地图片完整性检查。
自动补 OCR 的路由与这两个质量选项无关。

## 凭据与部署

将 token 保存为仓库、Vault 之外的受限 UTF-8 文本文件。Windows 部署配置只保存文件路径：

```json
{
  "mineru_token_file": "E:\\ObsidianData\\OKF-Brain-State\\secrets\\mineru-client.token",
  "mineru_model": "vlm"
}
```

也可通过 `OKF_MINERU_TOKEN_FILE` 和 `OKF_MINERU_MODEL` 配置 Engine。
运行 `deploy/windows/install.ps1 -MinerUTokenFile <路径>` 时，安装器会保留已有模型设置。
token 不进入仓库、Vault、Dashboard 插件设置或日志。更换 token 后更新文件并重启 Engine。

## 处理流程

Engine 先把文件保存到 Originals。图片输入直接以 `is_ocr=true` 解析；PDF、PPTX 和 Word
先以 `is_ocr=false` 解析。Engine 使用结果包中的 `content_list.json` 按页或幻灯片生成 Markdown，
将图片作为 Vault 资产引用，不把图片数据放进 AI 文本提示词。

对有图片且可提取文字少于 50 字的页、完全没有文字的 PDF 页，
或 PPTX 中有图片占幻灯片面积三分之一以上的页，
自动补做 OCR。PDF 仅提交目标页范围；PPTX 优先提交嵌入的 PNG/JPEG 等原图，
原图为 TIFF 等不受 API 支持的格式时使用 MinerU 返回的 JPG/PNG；Word 使用结果包里的图片。
每份文件最多补识别 40 页，每页最多 4 张图片。补出的文字追加到相应页，
标明机器解析来源；不会覆盖原生文字、表格或备注。没有新增文字时保留图片和原件引用，
并使用相邻页文字给完全无正文的页提供简短检索线索。这个线索明确标记为相邻页内容，
不能作为该页原文引用。预算外页面也保留图片，并在 Markdown 标明待按需查看。

页级结构来自 MinerU 返回的可选元数据。如果它缺失，就保留 MinerU 的 `full.md`；
如果按页重排明显漏掉原始全文的文字，也保留 `full.md`，将补充识别结果单独列出。
自动规则只是筛出值得 OCR 的页，不保证识别完整；图示内容若仍不足，需要在实际分析该页时查看原图。

Engine 申请签名上传 URL，上传目标文件，按 `batch_id` 查询解析结果，下载 ZIP，
通过 QC 后发布 Source 与 Source Text。
云任务 ID 和上传阶段保存在 State 的转换工作目录。进程重启后继续查询原任务。
签名 URL 只临时保存在 State，上传成功后立即移除。

HTTP 限流、服务异常、网络中断和轮询超时进入延迟重试；认证错误、文件格式错误、
解析失败和结果结构错误进入失败状态，供用户检查后重试。重复提交的极短窗口
仍可能出现在云端接受请求与本地写入任务 ID 之间。
补充 OCR 的临时失败会延迟重试，确定失败则发布基础解析并记录警告。

## 验收

使用仓库内公开测试 PDF 做一次真实解析，不会读取生产 Vault：

```powershell
uv run --project engine python scripts/smoke-mineru-cloud.py `
  --token-file E:\ObsidianData\OKF-Brain-State\secrets\mineru-client.token
```

此命令会实际提交云端任务并消耗服务额度。它只打印解析器、正文长度、图片数量与 QC 结果。
然后在 Dashboard 分别导入 PDF、DOCX、PPTX，检查正文、图片与重试状态。
添加 `--pipeline --file engine/tests/fixtures/documents/slides.pptx` 可在临时 fixture Vault
中执行完整的 Engine 导入与发布流程，不触及生产 Vault。
