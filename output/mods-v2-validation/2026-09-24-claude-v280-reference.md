# 官方 v2.1.280 参考复核 — 2026-09-24

目标分支 codex/mods-v2，应用生产基线仍3c569546/v63。本次仅文档和矩阵元数据，245条兼容状态未升级。

官方公开Git标签解析为56f36532530f88b572854538d685fcf781141e8c。raw标签固定声明与现有v2.1.278文件做bytes比较，499059字节完全一致，SHA-256 AC107A37C08AD46F8632EDC1639B13A740FAE0B8249A2245532ADFD325E57D0D；文件头2.1.277不改写成release号。

README唯一差异是内建telemetry只允许built-in插件、拒绝installed插件并批量发送。当前本工程没有第一方telemetry SDK；任意同名自定义noun不获得宿主上报权限。未引入新的统计/网络权限，未运行或安装v2.1.280 CLI；历史273上游运行证据范围保持原样。

直接来源与指纹详见docs/mods-v2-claude-reference-2026-09-24.md；忽略目录2026-09-24-claude-v280-audit保存原文/差异/audit.json。官方API限流后用git ls-remote和标签固定raw文件复核，无第三方内容作为结论依据。

独占性能进程退出后，矩阵证据与真实guest/Client globals两文件6项窄测通过（2026-09-24-v280-reference-tests.log）。不新增镜像常量的伪行为测试；没有应用行为变化，不把版本元数据更新当作新增兼容能力。
