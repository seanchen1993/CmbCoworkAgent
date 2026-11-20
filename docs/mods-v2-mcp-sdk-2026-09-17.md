# Mods v2 MCP SDK 实施复核

开发分支 `codex/mods-v2`，本批基线 `dde4af7c`。对照已冻结的 Claude Code 2.1.273 声明，
修订与 SHA256 见兼容矩阵；没有将本批结果等同于完整产品对齐。

## 使用效果

`$.mcp.call(server, tool, args?)` 使用本机已配置的服务和连接，返回
`{ content, isError, structuredContent? }`。新增示例 `/claw-mcp`，可以在尚未向模型发过
消息的普通项目会话直接调用。SDK 调用经过 `mcp.call` operation Hook，支持参数改写、
合成结果、拒绝，以及 `{ value }` 封装；错误结果保留 `isError`。

## 底层约束

1. **真实服务解析。** 从 production scoped MCP service 的目录解析 providerKey、
   capabilityId、toolName 和实际 inputSchema。显示名称和规范拼写只负责定位；重名
   拒绝，不根据 `mcp__` 前缀猜提供者，也不把 `tool.list` 的展示元数据当授权。
2. **有生命周期的绑定。** MCP 绑定键包含规范项目路径、会话和代理。调用持有特定
   绑定实例和宿主生成的连接代次，旧 disposer 不会清除新绑定。连接入口替换、服务关闭/失效、会话关闭、
   取消或授权撤销都会阻止旧调用。明确轮次的调用不允许跨轮次借用 MCP。
3. **复用实际执行路径。** 冷启动命令使用 `createScopedMcpCapabilityService`，从现有
   hook resolver 取得 classic PreToolUse/PostToolUse 等，随后经过最终参数审批、
   managed policy、raw MCP transport 和输出保护。命令清理只移除自己的绑定，不关闭
   应用共享连接，也不修改 MCP 配置或凭据。
4. **参数和目标复核。** 接收时复制有界参数；宿主固定本次解析出的提供者、能力编号、
   工具名和 schema 指纹。在 raw 入口和审批后再次校验目标身份，防止等审批期间替换
   schema 或绑定。实际发送前再核对连接对象及当前配置指纹，配置删除或替换不能继续
   使用缓存连接。指纹仅在宿主内比较，不会把凭据返回插件。参数的 schema 校验沿用
   真实 MCP 服务端；不另造一套弱化校验器。
   冷命令的并发 SDK 调用按会话串行处理，最多 16 个待处理调用，避免互相覆盖绑定。
   适配器在运行前检查原调用方仍存活；嵌套自定义工具先解析真实父轮次，再创建适配器，
   不会为了取得轮次生成未落账的虚构调用编号。
5. **执行与发布分开。** 与原生 SDK 共用宿主调用身份和 ModEngine 实际执行记录，
   每次 core 调用只记一份。使用过滤后的 raw MCP 内容，不从 LangChain/UI 展示文本
   反推原始资源。输出投影失败会阻止发布，服务断线保持 unknown，不自动重试或切换
   提供者。策略关闭时，成功发布也明确落账；此前该分支可能一直停留在 pending。
6. **权限不由服务注解决定。** MCP 工具默认按潜在副作用处理，要求存活用户操作、会话
   执行租约和最终参数审批。只读提示或工具名称不会自动授予写权限。

宿主修订升为 `desktop-mcp-call-v12`，旧插件摘要授权需重新批准。没有数据库迁移或新增依赖。

## 上游对照与差异

新增 fixture `tests/fixtures/mods-v2/mcp-sdk`。3 项测试已在真正的 2.1.273 `plugin test`
运行：默认参数与调用方 origin、结构化/错误结果、拒绝操作。累计上游契约证据由 33 项
增至 36 项；该测试不连接外部 MCP，不证明 OAuth、远端服务或完整产品行为。

本工程明确保留 D01：Claude 文档中的 MCP 插件调用无额外权限提示，本工程仍执行
强制策略和逐次审批。受限子代理、自动模型 Hook 中的 MCP SDK 暂不开放；`$.tool.call`
对 MCP 名称的调用、无模型时 `tool.list` 完整目录、声明式权限查询、`tool.check`、
跨插件授权委托仍需后续实现。这些没有标为完成。

下一阶段应从现有文件、命令和 MCP 权限入口提取无副作用查询，并接入实际最终参数校验，
再开放 `tool.check`。查询必须不执行工具、不弹审批、不运行 classic PreToolUse 或分类模型。
可选 Hook 的 allow 不能绕过强制策略；差异需要继续单独验收。

## 验证

| 检查 | 结果与证据 |
| --- | --- |
| 全仓 Vitest | 3354 项：3323 通过、26 失败、5 跳过；26 项与基线逐项同名、同原因，无新增失败。`vitest-mcp-full-final.json`、`mcp-failure-comparison-final.json` |
| Mods 目录测试 | 上述完整报告中 `src/main/mods` / `src/shared/mods` 的 42 个文件、315/315 通过；MCP 目录另有 19/19 通过 |
| 独立回归 | 81 项：73 通过、8 个既有问题；7 项失败原因相同，另 1 项仍为 workflow-worktree 的 180 秒超时。`mcp-standalone-comparison.json` |
| 跨进程 | 35/35 通过，覆盖 SDK 跨 utilityProcess 的原始资源块、结构化结果和宿主来源；`mcp-process-final.txt` |
| Electron E2E | 37 组通过，包含真实 stdio MCP、最终审批、嵌套并发父子记录、配置删除竞态、过滤与撤权；`mcp-e2e-accepted.txt`、`mcp-e2e-accepted.json`。截图 `function-mcp-sdk.png` 已检视，普通构建已恢复 |
| 上游契约 | 新增 3/3 通过，累计 36 项；`mcp-upstream.txt` |
| 类型与规范 | Node/Web 类型检查通过；28 个改动代码文件 ESLint 为 0 个新增问题、0 告警，保留 runtime.ts 已存在的 1 个 no-explicit-any（已与 `dde4af7c` 核对）。`mcp-types-accepted.txt`、`mcp-lint-final.json` |

全仓测试期间运行代码及单元测试保持冻结；E2E 夹具单独修正了“首个命令就是指定插件的
命令”以及“撤销一个插件后所有插件的命令都消失”两项错误假设，按插件和命令名称明确
定位，之后完整重跑通过。失败记录分别保存在 `mcp-e2e-command-order-fixture.json` 和
`mcp-e2e-revocation-fixture.json`，没有删除失败证据或通过放松运行预算使测试通过。
最终规范检查仅把 manager.ts 一处换行合并，TypeScript 输出的 JavaScript 完全相同，
校验记录为 `mcp-format-proof.json`；其余运行源码和单元测试没有变化。

### 性能边界

使用 `node tests/run-function-host-performance.mjs dde4af7c mcp-matched`：实际宿主引擎、
SQLite、1000 个工具元数据，四轮 ABBA/BAAB，各版本累计 800 次采样。基线仅在基准夹具
补上等价 publication 落账，以区分名称解析/身份复核与新增持久化成本；生产基线未改动。
最终 P50 为 9.808 → 10.446 ms，P95 为 10.516 → 11.191 ms，增加 **6.42% / 0.675 ms**。
证据为 `mcp-matched-performance/result.json` 和 `mcp-performance-final.txt`。该测试不包含
guest VM、策略进程、真实审批或 MCP I/O，不能称为完整调用延迟。

未补等价 publication 的原始对照为 P95 7.121 → 11.042 ms（+55.07% / 3.92 ms），
主要包含从漏记 published 到新增 SQLite 持久化的成本，保存在 `mcp-performance/result.json`。
不能将其隐藏，也不能直接与完整 MCP 网络延迟比较。中间对照的 +9.20%、+0.89% 仍保留；
使用的是最终冻结宿主代码的 +6.42%，没有挑选最快一轮。

最终 E2E 的实际读取禁用路径 P95 为 2.704 → 2.732 ms（+1.06%）；本批此前还测得
-6.92%、+1.51%、-1.06%、+8.34%。虽然最后一轮小于 5%，已有超限波动，**整体性能
门槛仍未通过**，长时资源压力仍待验收。每轮有 100 次预热、每组 500 次采样，并保留
原始结果；不会用一次低波动覆盖此前记录。

日志保存在 `output/mods-v2-validation/`；E2E 结果和截图保存在
`output/mods-validation/e2e/`，均不纳入提交。
