# Mods v2 代理实例与共享任务权限

基线 `31de982c`，开发分支 `codex/mods-v2`。本批建立真实代理实例的权限生命周期，
接入 deepagents task 的一般代理及已知 registry 角色，继续对齐冻结版本 Claude Code
2.1.273。完整 API 与产品对齐仍未完成。

## 权限来源

原先只比较 workspace/thread/agent/turn，无法区分使用相同字符串重建的两个实例。
现在创建真实 runtime 的宿主入口通过 ModsManager 签发私有对象；LocalSandbox 只接收
该对象，不因自己被构造就签发完整代理权限。原生后端和 MCP 连接使用同一实例对象。
旧对象被替换、关闭、父实例结束或取消后失效；延迟完成初始化的旧适配器不能覆盖新绑定。
旧释放器不会清除新实例。注册表上限 100，超限拒绝新增，不淘汰其他活跃实例。
原生/MCP 绑定达到上限时先清理已经失效的项，仍满时拒绝新绑定；共享子代理结束后清除
其工具目录，防止累积已退出的子实例元数据挤掉主代理目录。
dispatch 在合并后端闭包前核对项目、轮次与实例，拒绝同线程换项目后旧入口取得新项目绑定。

FunctionExecution、内部 host-call、ModCallContext 和排队任务传递对象身份；对象不会
加入 guest 事件或持久化 ModIdentity。模型中间件持有构造时的身份；用户从 IPC 开始新
动作时捕获当前实例。临时 native/MCP 命令适配器独立释放，不通过重建适配器更新权限。
文件、工具查询/调用、注册工具、模型请求和发布边界仍检查授权、配置与实例存活。

LocalSandbox 的构造绑定使用固定 owner，执行时才读取宿主调用上下文。这样即使后端在
父工具的异步上下文里创建，也不会误绑定到父代理。不同执行目录仍沿用 v15 的显式传递。

## 真实共享 task

`wrapTaskToolWithOwnerMetadata` 包住原始 task invoke Promise。一般代理与 registry 角色
从宿主实际规格取得禁用工具、shellAccess；每次 task 建立子实例、显式绑定共享后端和 MCP，
在 finally 释放。任务执行期间进入原有只读 shell 上下文，classic Hook 改参后仍由真实
后端校验。父后端的委托禁用清单与子角色约束共同生效，不能由 MCP 的父 baseContext 覆盖。

没有真实 ToolCall ID 的任务使用内部实例 ID；不会把该 ID 写进 renderer 的真实 ToolCall
归因字段，同时清除继承的父任务归因。自定义代理覆盖 general-purpose 时，不会仅凭同名
获得内建权限。opaque Runnable 和未确认权限的自定义代理保留 native 生命周期，不推测其 SDK
权限，不回退借用 main。完整的 opaque/provider 代理接入仍待后续实现。

已绑定子代理能使用注册工具、原生读取 SDK、文件 SDK、权限查询和实际作用域工具目录。
SDK tool.list 合并后的注册工具同样过滤角色禁用项，MCP 同时检查实际和 canonical 名称。
session.start 的初始 cwd、session.cwd 与文件路径来自实际执行目录。子代理调用保留真实
agentId、turnId 和父执行记录，SDK 内部新操作各记一次账。

SDK 写入仍要求存活用户动作；代理归因不会变成用户授权。MCP 的强制审批差异 D01 继续
保留，模型子代理不会通过该批获得任意 MCP SDK 执行权。

## 检视中修复的生产链问题

首次真实子代理 E2E 发现 task 被只认识文件/Shell 工具的 LocalSandbox 权限查询误判为
TOOL_UNAVAILABLE。现在仅原生适配器工具进入该查询；task 等引擎工具仍经过角色限制、
受管策略、tool.check 与自己的实际执行准入。定向 deepagents 测试补入真实权限 Hook 链。

第二轮 E2E 的 Client 在点击结束后停止：定时重绘继承了过期点击作用域。后台帧现在由
宿主显式建立独立只读入口，不继承用户写权限或线程写租约；点击动作仍保留自身作用域，
组件关闭与授权撤销仍会取消运行。回归覆盖重绘、定时器继续工作及权限降级，第三轮
Electron 全流程通过。原始失败结果均保留，不以单项重跑替代失败记录。

## 验证

实测覆盖同 agent/turn 替换、旧释放器、父子递归失效、容量、排队时替换、并发共享子代理、
独立后端固定 owner。真实 deepagents 主代理通过 task 创建 Explore，子代理调用注册工具，
其处理器通过真实 QuickJS SDK 读取 LocalSandbox 与文件接口；目录隐藏被禁项，三条记录
保留 task → 注册工具 → 原生读取关系，任务返回后子实例失效。

Node/Web 类型检查通过。变更范围 ESLint 无新增问题，保留已核对基线的 runtime.ts
显式 any。81 个独立套件为 73 通过、8 个同原因基线问题，包含 workflow-worktree 的
180 秒超时；对照记录为 `runtime-instance-standalone-comparison.json`。
另行运行不在上述 81 套内的 subagent-tool-call-count-observability，停在旧 trace 源码
格式断言；其测试与 collector 文件均与本批基线一致，不将该脚本记为通过。

最后一次 Electron HTTP/utilityProcess E2E 44/44 通过，包含真实共享子任务、Client
后台帧、重载与重启。普通构建已恢复，测试入口不在最终 out/main 中。结果见
`runtime-instance-e2e-final-result.json`；前面三次原始结果也保留。
跨进程验证 37/37 通过，Client 的 100 次操作 P50 1.975 / P95 3.794 ms；该场景不含
生产输出策略，不能与完整应用性能混为一谈。

全仓最后一轮共 3426 项：3394 通过、27 失败、5 跳过，449 个文件。其中 26 项与基线
同名同原因；额外一项 browser-script-execution-service 首个用例达到 5000 ms 超时，
该源码及测试没有本批改动，独立复跑在 1117 ms 通过，同文件剩余路径断言仍为基线失败。
原始全仓结果保留，不用复跑覆盖，也不声明全仓全绿或最终发布通过。JSON 中该超时被
Vitest 写作 STACK_TRACE_ERROR，实际原因以文本报告的超时记录为准。
Mods 路径下 50 个文件、382 项全部通过。证据为 `vitest-runtime-instance-full-final.json`、
`runtime-instance-full-final.txt`、`runtime-instance-failure-comparison-final.json` 与
`runtime-instance-browser-recheck.txt`。前一次完整报告另存为 `before-scope-review`，
不与最后一次统计合并。

性能工具新增 `mcp-instances` 模式，两版均经过同一 MCP 名称解析/工具转发链，新版还持有
真实实例权限。旧 `mcp-routing` 模式用于转发引入时的对照，只在新版打开转发层，不适合
单独衡量本批实例权限开销；保留旧结果并明确范围，不用无实例的路径代替本批性能验证。

该模式四轮 ABBA/BAAB、每版累计 800 次：P50 10.579 → 10.702 ms，P95
11.546 → 11.309 ms（−2.05%）。范围为真实实例检查、同一 MCP 路由与 SQLite 账本，
不含 VM、策略进程、队列或网络；小幅下降不视作性能优化。详细数据位于
`mcp-instances-performance/result.json`，版本 bundle 摘要不同。

最后一轮真实读取禁用路径 P95 2.276 → 2.544 ms（+11.80%），超过 5% 预算；前一轮
为 −0.27%。保留波动和超标事实，整体性能验收未通过，仍需多轮复核与长期测试。
最后一轮 no-op 的 1000 次 P50 7.889 / P95 8.642 ms，pending 为 0；不能用单轮
代替方案要求的五轮和两小时压力。

## 仍待完成

完整冷工具目录、MCP SDK 到注册工具、Claude 内建 Read/Bash 参数与结果、通用引擎工具
SDK、opaque/provider 代理、代理事件与委托 SDK、主模型流及 turn/session 生命周期、
classic/config/provider/跨插件接口、其余 UI 站点、开发工具、真实服务和最终安装包、
两小时压力以及逐项兼容验收。
