# Mods v2 下一阶段：代理权限与绑定

本文件记录对实际入口的复核结论，是待实施设计，不代表子代理能力已经开放。
先完成 [权限批](mods-v2-tool-permission-2026-09-17.md) 的回归，再按以下依赖推进。

## 现有入口不能混为一种

| 入口 | 实际宿主边界 | 需要保留的约束 |
| --- | --- | --- |
| 普通主代理与命令 | 项目线程、独立 LocalSandbox、已有 MCP 绑定 | 项目授权、最终审批、命令租约 |
| Workflow / coordinator 子代理 | 独立线程/后端，可能是隔离工作树 | 工作树、角色 shellAccess、原生 disallowedTools、父 UI 审批 |
| deepagents task 子代理 | 共享主后端，owner tool-call ID 区分代理实例 | 实例身份、工具禁用清单、只读执行上下文、取消和生命周期 |

已核对 `runtime.ts` 的 `createAgentToolGuardMiddleware`、`createDeepAgent`、
`createAgentRuntime`，`tool-hooks.ts` 的工具目录/调用中间件，以及
`hooks/execution-context.ts` 的 `cmb_subagent_owner_tool_call_id`。共享后端的代理不能
靠查找不到时回退到 main 获得权限，也不能把代理类型名称当成一次代理执行的身份。

## 必须先实现的宿主契约

1. **授权项目与执行目录分别表达。** 隔离工作树里的代理仍属于原项目，但执行根不同。
   `createAgentRuntime` 已以 workspacePath 表示授权项目，fileRoot 表示隔离目录；问题在
   LocalSandbox 的 Mods 绑定仍使用 workingDir 作为 workspace。绑定应显式保留授权项目，
   增加执行目录，不能从 projectDir、父线程或目录结构猜测授权域，也不能补默认 grant。
   session.cwd、文件 SDK 的路径归一化与实际读取必须使用同一执行目录；授权、状态和
   输出策略继续归属原项目。目录或绑定实例更换使旧调用失效。
2. **实际代理权限记录。** 由创建代理的宿主入口提供允许/禁用工具、shellAccess、
   工作树范围、信号和实例代次；SDK 不能传入或改写这些值。目录仅是展示元数据，不能
   充当此权限记录。授权、绑定、规则和实例存活分别复核。
3. **显式绑定共享后端。** 独立后端直接提供自身调用与查询闭包；共享后端由创建代理的
   代码明确绑定受限闭包，并进入原有只读执行上下文。禁止通用 main 后端兜底。
   同一代理 ID 的重建使旧绑定失效，旧释放器不影响新绑定，父运行结束取消所有子绑定。
4. **统一 SDK 的范围检查。** native/MCP/registered 的调用与查询、工具目录、文件 SDK
   都检查实际代理范围；不能通过另一个 SDK 绕过代理的能力约束。嵌套模型请求保留代理
   身份、输出保护、费用预算和实际父记录。归因不授予写权限。
5. **最后开放注册工具。** 模型目录、调用入口与内部 SDK 三者一致后才向子代理公布
   可执行工具。跨插件调用同时核验消费者和提供者，调用者 origin 与所有者 grant 分开。

2026-09-17 追加入口复核：`createRuntimeToolDenylistMiddleware` 和 filesystemAccess
的工具清单还需要进入宿主 SDK 准入，不能只在模型 middleware 隐藏或拒绝工具。
LocalSandbox 构造绑定后才设置 readOnlyShellEnforced，因此只在构造时复制 readOnly
也不足以表达最终权限；由运行时给出完整的初始权限，并在查询和执行时继续复核实际后端。
工具 Hook 的上下文必须使用已解析的实例 agentId，不能重新使用 options.agentId。

## 回归门槛

覆盖独立后端和共享后端两种真实路径，至少包括：并发主/子调用；被禁工具从目录消失
且调用/查询拒绝；只读命令被 classic Hook 改写后仍受限制；同名工具作用域选择；
关闭、撤权、换工作树、替换绑定与等待审批竞态；旧异步回调不能重新获得 main 身份；
父子账本不重复记录；失去回复保持 unknown。最后通过真实模型协议和 Electron E2E。

实施中继续保留明确的未支持错误，不能用删除 `MODS_TOOL_AGENT_UNAVAILABLE` 检查来
代替上述宿主接入。完成这些契约后再扩展 session/turn、代理 Hook 与能力提供方。
