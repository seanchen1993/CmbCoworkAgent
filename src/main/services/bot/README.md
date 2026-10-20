# Legacy partner protocol fixtures

此目录保留 M02–M04 的 Java 伙伴协议、客户端与故障验证实现，供 `tests/bot` 的历史契约/HTTP harness 使用。当前 App 的 main、agent、preload、renderer 均不导入这里；不注册 input-only runtime，也不构造旧 controller、worker、router 或 journal Store。原 beta 的 requirements 与标准 Bot Runtime 位于其他模块，继续使用。

这些构造器可能建表、恢复或联网，不能用于当前 App 启动或旧数据读取。M05 不迁移、不读取、不重放旧专家数据，也不主动删除原 SQLite 表。未来后端合仓需要单独设计和授权，不通过重新挂旧 UI 接入。
