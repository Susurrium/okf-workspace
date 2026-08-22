# Obsidian Web Clipper 接入

Workspace 使用 Web Clipper 做确定性采集，不在浏览器里调用 AI。模板生成一篇
`ingested_via: web-clip` 的 `Capture`；之后由 Dashboard 将它发布为一对
`Source` + `Source Text`，再按你的选择决定是否调用 Codex。

## 一次性配置

1. 安装官方 Obsidian Web Clipper 浏览器扩展，并把当前 Vault 配置为目标 Vault。
2. 打开扩展设置的 Templates，选择 **Import template**。
3. 导入 Vault 中的
   `system/integrations/web-clipper/workspace-web-capture.json`。
4. 确认新导入的 `Workspace · Web Capture` 位于模板列表顶部。模板自带
   `https://` 和 `http://` 触发器，会自动接管普通网页；不要再手动选默认模板。
5. Interpreter 保持关闭；本模板没有任何 prompt variable，也不需要 API Key。

每个浏览器配置一次。模板文件会随 Vault 同步；浏览器扩展自己的设置不由
LiveSync 自动同步，Vault 中的 JSON 更新也不会自动改写已导入的浏览器模板。
如果之前已导入过旧版，请删除旧的同名模板后重新导入；导入操作本身
会把新模板放在列表顶部。

如果曾经误用官方默认模板，笔记会出现在 Vault 顶层的 `Clippings/`，并使用
`source/created/tags: clippings` 这组默认 YAML。运行 Workspace 布局迁移后，系统只会
识别这一精确默认签名，将其安全移入 `inbox/captures/YYYY/MM/`，补齐
`type/title/created_at/ingested_via/resource`，同时保留正文和其它元数据。
非默认结构的个人笔记不会被移动，同名目标也不会被覆盖。

## 真实使用流程

1. 在网页上直接剪藏全文、选区或高亮。
2. Web Clipper 把原始内容写入 `inbox/captures/YYYY/MM/`，此时不运行 AI，主机也
   不需要保持开启。
3. 打开 Obsidian 的 Dashboard → Inbox，在“网页剪藏”中选择：
   - **立即学习**：发布 Source + Source Text，在 `uses[]` 记录 `study`，并创建 Study Guide 后台任务；
   - **稍后学习**：在 `uses[]` 记录 `study`，以后从 Learning 的待生成区启动；
   - **生成 Wiki**：在 `uses[]` 记录 `wiki`，并创建 Wiki 后台任务；
   - **仅作参考**：在 `uses[]` 记录 `reference`，不调用 AI；
   - **丢弃**：把仍处于 Inbox 的临时 Capture 移入 Obsidian 本地回收站。
4. 课程或项目归属只从已有列表选择；不属于任何上下文时选择“独立资料”。

不做选择时，网页 Capture 继续留在 Inbox；它是否待处理由文件是否仍存在直接表达，
不再另写 `capture_status`。只有发布成 Source 后才需要 `uses[]`，发布成功后临时 Capture
会被删除。因此网页剪藏不需要为了“稍后决定”提前制造 Source。

Source 的 `resource/kind/text` 只标识“这是什么来源、完整正文在哪里”，不会因为上述
选择而改变身份。用途与可选 Course/Project 放在 `uses[]` 中；同一网页可以服务多个
上下文，重复的 `purpose + course + project` 组合不会重复写入。以后对某个上下文作出
正式的学习、Wiki 或参考决定时，只清理被该决定覆盖的 `undecided`，其它用途保持不变。

同一 URL 会忽略 fragment 和常见跟踪参数进行去重。重复全文会更新 Source Text；
新的选区或高亮会合并进去。若同一网页此前已由 AI Daily/树洞收录，系统复用现有
Source，并保留最先进入时的 `ingested_via`；反向顺序同样成立。后到渠道的独有正文、
指标和评论写入幂等补充区域，不覆盖先前正文。这个流程不依赖 Git；如你主动为 Vault
启用本地 Git checkpoint，自动化写入才会额外留下可恢复版本。

Web Clipper 首先保存远程图片链接，发布 Source 后后台再把可安全访问的常规图片
镜像到 `sources/assets/<source-slug>/` 并改写 Source Text；失败的图片继续保留远程
链接，不阻塞资料发布。设置环境变量 `OKF_WEB_MEDIA_MIRROR=false` 可关闭后台镜像；
也可以随时使用 Obsidian 原生命令“Download attachments for current file”手动处理。
