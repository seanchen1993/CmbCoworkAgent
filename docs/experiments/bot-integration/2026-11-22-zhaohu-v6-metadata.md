# 招乎网关 V6 在无删除权限账号下升级

2026-11-22，Asia/Shanghai。网关基于 `master@913b5e9`，App 基于 `codex/merge-uat-into-bot-beta@d26a05a77`，含工作区内的投递改动。本轮验证内网变更单的两个要求：迁移不执行删除语句，只为此次新增的表和字段写入数据库注释。[上一轮投递验证](2026-11-22-zhaohu-delivery-existing-tables.md)

## 输入与执行方式

在本地独立 MySQL 5.7.24 实例上建好 V5 库，给已有发件箱和已有字段写入测试用的中文注释，并预置三条历史记录，其中同一回复的第二段先于第一段入库。另建迁移账号，只授予该测试库的 SELECT、INSERT、UPDATE、CREATE、ALTER、INDEX 和 CREATE TEMPORARY TABLES 权限。用该账号在同一连接中执行完整 V6，并在断开前读取临时表的实际建表定义。

在网关目录运行 `APP_REPO=<App源码目录> python3 tools/bot-channel-tests/run-local-journey.py`。设置 `BOT_IM_MEDIA_ONLY=1` 运行附件场景。Java 网关和桌面 WebSocket 客户端在本机运行，招乎平台使用本地模拟服务。

## 验证结果

- 变更脚本通过删除语句检查。受限账号执行了完整回填。临时排序表由 MySQL 在连接断开后回收。
- 数据库中 3 个新增业务字段，以及临时表和它的 2 个字段，都有非空中文 COMMENT。逐项比较升级前后的常驻表清单、表注释及两张业务表的旧字段注释，所有原值一致。
- 历史投递恢复为「第一段、第二段、另一条回复」。出站游标为 3，两个入站计数仍为 1、0。8 个 MySQL 保序回归用例均通过。
- 常规联调得到 12 条入站 COMPLETED、24 条出站 SENT。附件联调得到 6 条入站 COMPLETED、29 条出站 SENT。两次退出码均为 0。原始结果分别取自迁移脚本断言、Surefire 报告和联调数据库终态。
