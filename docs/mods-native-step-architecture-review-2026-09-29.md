# Skill / MCP 原生节点架构与兼容性评审

评审对象：`docs/mods-native-step-contract-2026-09-29.md` 及本轮实现。
结论：设计通过；最终独立源码检视与本轮真实 Electron 验收通过，无剩余阻断项。
本文结论针对本轮 Skill / MCP 原生节点契约，不等于全部 Claude Mods 能力完全兼容。

## 必须满足并已落地的契约

- Flow 仍属于已授权的 Function Mod。`prepareFlowScope.withOwnerGrant` 只在宿主内借出该
  流程所属插件的当前 grant，执行前后检查会话、撤权和配置；不在 IPC、保存定义或输出中传 grant。
- MCP 原生 helper 经真实 `ModsManager.invokeFunctionMcp` 进入 `ModCallContext`，复用权限确认、
  审计、legacy Pre/PostToolUse 和内容保护。仅有 `withFunctionExecution` 不足以获得上述语义。
- 保存的是 provider ID/name/config digest、toolName、规范化 input/output schema digest。
  连接 generation 不写入可移植定义；运行时冻结并在真正 transport 和结果发布边界复核。
- 原生 MCP 精确执行所选工具。宿主 `directMcpInvocation` 关闭浏览器自动选页及重路由；
  普通对话保持原分支。helper 要求真实 ModCallContext，单节点尝试一次、transport 入口最多一次；
  原 SDK 在该 context 中不进行网络自动重试或 fallback。
- Schema 拒绝 MCP 自身失败路线，也拒绝任意后续节点向前跨越已启用 MCP 的回边；
  NativeHost 的 run/step 集合再防重复。不能只禁止 MCP 的 `onFailure` 而放行其他节点回退。
- 前步对象仅取通过且未失效的 plugin-action / mcp-tool 最新结果，遵守既有 JSON 指针与大小限制。
  MCP 返回对象仅保留受保护的 text/structuredContent/isError；不持久化原始 content 中的
  image/blob，不把任意 text 猜测为 JSON。运行计划仅保留来源/工具身份、摘要及本次连接 generation。
- 工具目录只有显式点击才发现连接；IPC 在 await 前后复核项目、线程 incarnation、Claw binding
  revision。UI 也用读取代次、配置变更和卸载取消旧结果。空选择不初始化连接。

## Skill 与 UI 的独立检视

`createFlowSkillTurn` 复用标准可信显式激活；共享 HookScope、skillUseTracker、已触发键。
PreSkillUse 拒绝会阻断模型，PostSkillUse 拒绝会使本次尝试失败，不能发布为通过。
选中来源在 prepare、主模型请求前后、完成发布时复核，普通未绑定运行不增加此 guard。
输入来源、schema 保存、跨 MCP 回边限制、手动目录和迟到结果保护未发现阻断问题。

准确限制：显式激活当前复用桌面标准语义，即给模型附加可信 Skill 路径标记并激活生命周期；
它并不直接注入 SKILL.md 全文，文档读取仍由模型完成。成功完成路径执行 PostSkillUse；
异常或取消不能承诺完成 Hook 必定运行，更不能承诺模型严格完成技能文档每项业务步骤。

## 明确保留的边界

- 使用共享 MCP 连接池；非空目录发现可能启动全部 enabled 服务。限制的是工具调用权限，不是连接隔离。
- 原生节点支持现有有界 JSON Schema 子集。复杂或不支持的 schema 在目录中显示 unavailableReason，
  不能选用；不会把不支持的约束默认为有效。`$schema` 仅作为元数据，不解析外部资源。
  MCP 合法参数 `tool` / `agentId` 通过显式 `allowReservedKeys` 支持；注册工具默认保留原限制。
- 外部操作断线后可能已经生效；不重放不代表远端事务可回滚，也不代表业务目标已经完成。
- 原生工具调用是宿主精确工具步骤，不宣称等于执行插件自定义 `$.mcp.call` 命名函数覆盖逻辑。
  它保留实际工具调用的权限、观察、保护链，不允许插件把所选工具暗换成另一个 provider。

## 验证记录

- `native-mcp.test.ts`：真实双 provider stdio 与生产 ModsManager，6 项通过。包括同名精确来源、
  合法参数 tool、拒绝不触达 transport、PreHook 阻断/改坏输入、审批期间来源变化、重连失效、
  取消、断线仅一次、isError、无执行作用域拒绝、保护 raw/structured/text、撤 grant。
  浏览器辅助函数在测试中若调用即抛错，确认 direct 分支没有额外调用。
- 与 `tool-schema-contract`、旧 scoped MCP runtime、冷 SDK command、旧真实 stdio 来源限制合跑：
  5 文件 / 31 项通过。
- `completion-policy-manager.test.ts`：30 项通过，新增所属 grant 精确匹配、撤权后结果拒绝，
  保留既有 completion policy 回归。
- Node TypeScript 检查通过。首次测试失败来自审计字段读错与缺少 policy worker 测试配置，
  修复测试设施后重跑通过，未掩盖首次结果。

## 最终交叉验收与首次真实失败的修复

首次 Electron Skill 链在模型调用前出现 `MODS_THREAD_CONTEXT_REQUIRED`：Skill 的准备与完成
回调运行在 `runtime.stream` 之外，未携带实际子 Agent 的作用域，宿主尝试查找不存在的 main
绑定。此前仅靠被替换的 Hook 单测未能覆盖该链，此处明确更正验证范围。

修复使用 `runtime-host-lifecycle.ts` 捕获真实 runtime authority，由完整构建后的 runtime
回传宿主闭包。NativeHost 用同一闭包运行 prepare/complete；`withFunctionAgentExecution`
恢复精确线程、Agent、turn、authority，并在执行前后检查存活，不重造绑定、不提升用户授权。
Hook 的 Agent 元数据也显式透传。只读复核确认同 ID 的新 runtime 不能接管过期闭包。
真实 ModsManager 回归覆盖原失败、两次回调使用相同非 main authority、撤销及运行中撤销；
实施方反馈相关 4 文件 / 43 项及 Node 类型检查通过。

最终亲自读取并核对 [Electron 报告](../output/mods-claw-sources-e2e/report.json) 和对应断言：
`passed: true`，10 组检查，`errors: []`。包括真实 Skill `read_file` 内容进入模型请求、
Pre/PostSkillUse 执行、MCP journal 恰好新增一次 native-chain 调用、结构化结果进入 QuickJS
动作、PreSkillUse 否决时模型/MCP 请求均零增量，以及跨 MCP 回退保存被拒绝。
也覆盖线程选择隔离、空选择、使用过的线程切换 Skill、普通 Flow 子线程继承和重载保留。
模型供应端为受控 fixture；这些证据验证产品执行链，不承诺任意外部模型的业务表现。

最后新增 MCP 输出白名单及最小 plan 后，真实 stdio 单文件 8 项通过：包括图片块不进入
Flow 持久化结果、内容保护改写后不符合 output schema 时拒绝结果且真实调用仅一次。
NativeHost 集成 24 项通过，覆盖 MCP→action、重复调用拒绝、等待期间来源/撤权变化和
异步发布之后的二次核查。额外独立 Skill/schema 回归 3 文件 / 29 项通过。
旧 Flow 的 [9 组 Electron 报告](../output/mods-v3-validation/e2e/report.json) 也已读取确认通过。
全仓与其他 Legacy/Harness 汇总以本轮主交付报告为准；本评审未将未亲自读取的结果冒充独立验证。
