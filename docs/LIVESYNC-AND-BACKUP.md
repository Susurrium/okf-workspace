# LiveSync、备份与 CLab 迁移

## 同步边界

LiveSync 同步生产 Vault 中的 Markdown、必要 Obsidian 配置和阅读所需小附件。以下内容不进入同步：

- `.git/`、`.trash/`；
- `.obsidian/plugins/okf-workspace-dashboard/data.json`（只含本机路径，也无需同步）；
- 大型 `sources/assets/treehole-media/`；
- 位于 Vault 外的 Original Store、Runtime State、Feed cache、转换工作目录和索引；
- API token、Setup URI、CouchDB 密码、Restic 密码和模型服务 token。

安装器把建议写入 `.obsidian/okf-livesync-exclusions.json`，由用户复制到 Self-hosted LiveSync 的同步排除设置。该文件不是秘密。

## 为什么 LiveSync 不是备份

LiveSync 会同步正确编辑，也会同步误删和损坏。恢复层分三部分：

- Vault 本地 Git：快速撤销 AI/自动修改和普通编辑；
- Windows Restic：加密增量备份 Vault、Original Store 与部署配置；
- 服务器 Restic：备份 CouchDB 逻辑快照和服务器部署配置。

Runtime State、全文索引和向量索引不作为必须恢复对象；恢复 Markdown 后可重建。

## 从 CLab 迁到个人服务器

迁移不改变 Vault 结构，也不需要重建知识笔记：

1. 暂停所有设备的 LiveSync 自动同步；
2. 在 CLab 端生成最后一份 CouchDB 逻辑快照，并记录数据库名与 `update_seq`；
3. 对主电脑 Vault 运行一次 Git checkpoint、Restic backup 和 restore-test；
4. 在个人服务器按 `docs/DEPLOYMENT.md` 启动 CouchDB + Caddy；
5. 用 `couchdb_snapshot.py restore` 把快照恢复到个人服务器；
6. 查询目标数据库文档数量，抽查带附件文档；
7. 为新服务器创建专用非管理员同步账户；
8. 只在一台测试设备更新 LiveSync Remote URI/Setup URI，先执行 dry run 或拉到空测试 Vault；
9. 确认 Markdown 数量、随机笔记内容和附件后，再切换主电脑；
10. 最后切换其余设备并恢复自动同步；
11. 保留 CLab 只读至少一个备份周期，随后撤销旧凭据和 DNS；
12. 将个人服务器 CouchDB 定时快照与 Restic timer 纳入监控。

如果 CLab 无法导出逻辑快照，可以让主电脑完整同步后，以主电脑 Vault 为权威建立新远端；不要同时让新旧远端接收写入。

## 恢复演练的通过条件

- 恢复目录包含至少一份 Markdown；
- 全部恢复 Markdown 可按 UTF-8 读取；
- 每个 `okf-original://sha256/...` Source 引用能在恢复后的 Original Store 找到相应内容哈希目录；
- CouchDB 测试恢复没有 `_bulk_docs` 错误，随机笔记和附件可读取；
- 验证完成后临时恢复目录被安全删除，长期报告只保留数量、时间和 snapshot ID，不保留私密正文。
