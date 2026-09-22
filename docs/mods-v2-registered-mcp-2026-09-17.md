# Mods v2 命名 MCP 与注册工具

基线 `236f4aef`，开发分支 `codex/mods-v2`，宿主修订 `desktop-registered-mcp-v17`。
旧宿主授权摘要需要重新批准。本批没有数据库迁移或新增依赖，完整 Claude Mods 对齐仍未完成。

## 上游依据与调用效果

冻结 Claude Code 2.1.273 的 Ecr 按 vcr 的三个名称候选查找真实会话工具，再经 JZ/uV
进入工具执行链；因此 `$.mcp.call(server, tool)` 可以调用插件注册的工具。pn/XPe
决定名称归一化：非字母、数字、下划线、连字符变成下划线，`claude.ai ` 服务前缀另有
连续下划线折叠。j0s 还拒绝注册覆盖已配置服务的命名空间。本批继续使用已有静态产物，
未把这些源码观察增加到 39 项真实上游契约测试计数中。

现在注册名称遵循相同归一化。例如插件 `my.claw` 注册 `probe`，返回
`mcp__my_claw__probe`。调用应优先使用注册返回的名字；命名入口也可写成
`$.mcp.call("my.claw", "probe", args)`。注册工具没有外部 MCP 进程，调用进入已有
注册工具宿主，不因接口叫 MCP 就建立物理连接。

命名调用先分发 mcp.call operation，Hook 修改后的参数才用于匹配；接着进入 tool.call
Hook、真实角色约束、工具准入、注册者授权与执行记录。跨插件调用保留实际调用方和
注册所有者，二者不会混同。共享子代理保留原有实例、目录和父子记录，不借用 main。

结果与真实工具消息采用同一投影：数组保留 MCP 内容块；其他结果转成工具文字；
isError 保留，deny 变成 operation 错误。也修复物理 MCP 的 tool.call Hook 合成对象时
丢失文字的问题。直接 SDK tool.call 的 Hook 合成返回不因此强加 text 字段。
所有投影仍经过输出保护，不用原始数据重新拼出被过滤内容。

## 检视与边界

- 注册、列表、查询、准入后和返回时检查实际宿主工具名以及已经配置的服务命名空间。
  配置名称查询不初始化传输、不调用模型或执行工具；新配置与热更新不能遮蔽已注册工具。
- 宿主原生目录和 MCP canonical/toolId 冲突按当前 workspace/thread/agent 检查，包括
  因角色限制而隐藏的宿主工具；不能借其他代理的目录作判定。
- 不同插件归一化后撞名时拒绝。相同插件改变说明或 schema 会替换注册项；等待旧注册
  准入的调用不会执行新定义。内容相同、对象字段顺序不同的重复注册保留原定义身份。
- 取消、撤权、实例失效仍走已有生产生命周期。物理 MCP 的 D01 最终审批、配置/连接
  复核和没有回复时不重试继续生效；注册入口不会为内部原生写操作或物理 MCP 扩权。
- `tool.list()` 的完整冷工具目录、通用引擎工具 SDK 和 opaque/provider 代理仍待后续；
  本批不能据此宣称完整 B3/B4 或最终产品对齐。

## 验证记录

专项 401/401 通过，覆盖真实 QuickJS、SQLite、LocalSandbox 和共享子代理关系；
名称与元数据检查覆盖尚未发现工具的配置、无连接的注册、定义变更、会话关闭与冲突。
Node/Web 最终类型检查通过。跨进程 37/37、最终 Electron E2E 46 组通过；新增冷命令
自身及跨插件调用，以及运行中配置命名冲突，确认输出保护、caller/owner/parent 和
每次一条执行记录，物理 MCP 没有额外执行。普通构建已恢复，测试专用入口不存在。
最终画面已检查，夹具输出中的嵌套结果和敏感字段保护符合预期。

规范检查修复了两个 prefer-const 和性能清理中 finally 抛错的问题；改动代码没有新增
ESLint 问题，runtime.ts 的一个已有显式 any 保留为基线问题。全仓 Vitest 3440 项中
3409 通过、26 失败、5 跳过；26 项均与基线同名同原因，没有新增失败。v16 的浏览器
首用超时在本轮没有重现。81 个独立套件中 73 通过、8 个同原因基线问题；对照为
`registered-mcp-standalone-comparison.json`。本轮没有重跑额外的计数观测源码断言脚本，
仅核对其自身和 trace collector 与基线均未变化；不将它计入 81 项或宣称通过。
全仓既有失败仍是最终发布门禁的待处理事项，不把专项通过写成全仓全绿。
完整报告为 `vitest-registered-mcp-full-final.json`，逐项比对为
`registered-mcp-failure-comparison-final.json`。

首轮 E2E 的真实读取禁用路径 P95 为 2.239 → 2.229 ms（−0.44%）；最终为
2.458 → 2.614 ms（+6.38%），超过 5% 目标。最终 no-op 1000 次 P50 8.189 /
P95 11.090 ms，冷启动 192.321 ms，pendingRequests 为 0。保留两轮结果，整体性能
门禁尚未完成；仍需五轮、空闲和两小时长期稳定性检查，不能用单轮结果代替。

证据位于 `output/mods-v2-validation/registered-mcp-*`，E2E 分别保存为
`registered-mcp-e2e-first-result.json` 与 `registered-mcp-e2e-final-result.json`。

性能工具增加 `registered-mcp` 模式：相同注册处理器、真实 QuickJS、私有实例和 SQLite，
基线用 direct tool.call，新版用 named mcp.call；1000 个宿主目录项、100 个配置名称夹具。
这衡量增加命名调用及检查的端到端开销，不是同一 API 的逐字节对照，不含策略进程、
命令队列、配置文件 I/O 或外部服务。四轮 ABBA/BAAB、每版累计 800 次：
首轮 P50 11.292 → 11.713 ms，P95 16.265 → 15.470 ms（−4.89%）；最大值新版 80.294 ms。
不能据尾部的波动宣称优化，也不能拿注册调用套用 no-op 的 15 ms 预算。

首轮性能包因 ESM 中缺少宿主编译器的路径初始化失败；已为独立测量包提供模块路径和
createRequire，复跑成功，原始错误保留。该修复仅影响性能构建脚本。
结果为 `output/mods-v2-validation/registered-mcp-performance/result.json`，两版摘要不同。

最后修复清理路径检查后重跑相同测量：P50 11.148 → 11.624 ms，P95 12.081 →
12.998 ms（+7.59%，+0.917 ms），最大值新版 31.748 ms。两轮原始数据均保留；先前结果
为 `registered-mcp-performance-before-cleanup-review.json`，最终结果为上述 result.json。
最终 baseline/current bundle SHA-256 分别为
`25567d0ca67ca5b1983b51a92a32bc4ae296567c73d6ed742df71a444a522343` 与
`6a5c993532fad0eb9c50236fc48d21712679eeff82b5baf8a937d61acc55bbeb`。
此处测量的是新增入口开销，不能把前一轮下降解释为优化，也未完成整体性能验收。
