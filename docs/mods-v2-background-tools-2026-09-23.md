# 原生工具参数与后台任务生命周期

`execute.run_in_background` 现在调用真正的后台执行路径，`task_output.block/timeout`
使用现有线程隔离的任务读取器；false 和 0 不再丢失。托管执行保持前台约束。

后台执行必须属于当前 FunctionSession、原始 command 的取消信号、准确的 runtime
authority、授权摘要和原 run lease。短暂 tool.call RPC 返回不会误杀任务；撤权、关闭、
runtime 替换、会话结束、command 取消以及 lease 释放/交接会终止真实进程，等进程树收敛
再移除资源。资源清理可重入，即使一个 disposer 抛错也继续撤销其他资源。

官方工具名尚未作为别名开放。`Read.pages`、`Bash.timeout/description/`
`dangerouslyDisableSandbox` 等没有对应实现的字段仍明确拒绝，不宣称 full 兼容。

验证见 `output/mods-v2-validation/2026-09-23-native-tool-background-lifecycle.md`：
参数拒绝、错误前台执行、短 RPC 提前取消、原 command 取消等均先有失败回归。
6 文件 62 项通过，后续资源清理回归 6/6；真实 QuickJS/FunctionSession/ModsManager/
SQLite/LocalSandbox/PowerShell 子进程验证，包含同一命令关闭 Mods 的对照。
联合 Node/Web typecheck 通过； scoped ESLint 无错误。真实 utilityProcess 联合验证通过。

100ms watchdog 有最多 100 个 active action 的上限且结束后释放。现有测试证明有界资源
清理，完整桌面两小时长稳与空闲 CPU 门禁另行运行，不能从这些窄测推断性能最终通过。
