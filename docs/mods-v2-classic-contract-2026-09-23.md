# Classic Function Mods 契约与生产触发审计（2026-09-23）

本次按官方 Claude Code `v2.1.278` 的 `mods/types/claude-code.d.ts` 校对，参考目录为
`C:\ai\claude-code-v2.1.278`，提交为 `bf7d404e26a5fb6167d21b46c93a2bf6c22ab274`。
审计对象是 Mods 工作树 `ed89c24f` 之后的本轮改动，不涉及 UAT 工作树。本文是分项证据，
总状态以 `mods-v2-compatibility-matrix.json` 为准。**Classic 整体仍为 partial**。

2026-09-23追加：Function PostToolUse 的 updatedToolOutput / updatedMCPToolOutput 已接入
真实工具结果投影，见 [输出效果适配](mods-v2-classic-output-2026-09-23.md)。下文“尚未消费”
是原审计时间点；除这两个字段外的差异仍未解决，传统配置脚本解析器未随之扩展。

2026-09-23运行时复核：通用Mods类型中的 block / preventContinuation 不等于每个事件支持门禁。
最新[官方事件说明](https://code.claude.com/docs/en/hooks#instructionsloaded)明确 InstructionsLoaded
异步观察且忽略决策，直接AGENTS加载不属于官方触发范围。本工程的AGENTS来源映射见
[指令观察适配](mods-v2-instructions-loaded-2026-09-23.md)，不是CLAUDE文件规则的full兼容。
PostToolBatch及真实压缩适配已各有独立报告，下表旧“契约/手动”是原审计时点。

## 33 个事件的实际状态

“生产触发”表示找到应用真实调用点，不代表该事件所有官方字段、结果效果和时序已完整实现。
“契约/手动”表示事件名可注册、可以通过 `FunctionSession.classicEvent` 手动分发并校验结果，
应用尚无相应真实生产触发器；不能据此宣称功能完成。输入校验目前覆盖公共身份和
PreToolUse envelope，尚未逐事件完整校验全部专有输入字段。

以下 `B` 指公共结果 `block?: string`、`preventContinuation?: true`、`stopReason?: string`；
`C` 指 `additionalContext?: string[]`。表中结果列列的是官方允许形状，不承诺应用消费全部字段。

| # | 事件 | 状态 | 实际触发、输入与时序 | 官方结果字段 |
|---|---|---|---|---|
| 1 | PreToolUse | 生产触发 / adapted | `agent/tool-hooks.ts`、`agent/local-sandbox.ts`、`agent/runtime.ts`；工具执行前等待，输入是展开参数后的 `tool` / `tool_use_id` envelope | allow / ask / deny，updatedInput，C |
| 2 | PostToolUse | 生产触发 / partial | 同上；工具执行后，`tool_name`、`tool_input`、`tool_response`、`tool_use_id`；结果转回原后置检查流程 | B、C、updatedToolOutput、updatedMCPToolOutput |
| 3 | PostToolUseFailure | 生产触发 / partial | `agent/runtime.ts`、`agent/local-sandbox.ts`；工具失败通知，含 error、可选 is_interrupt；多数调用是异步通知 | B、C |
| 4 | PostToolBatch | 契约/手动 | 无真实工具批次结束触发器；不能用每次 PostToolUse 冒充批次 | B、C |
| 5 | PermissionDenied | 契约/手动 | 无拒绝后 retry 生产闭环 | B、retry |
| 6 | Notification | 生产触发 / partial | `agent/runtime.ts`；审批提示的 permission_prompt，message 来自宿主；尚非所有官方通知类型 | B |
| 7 | UserPromptSubmit | 生产触发 / partial | `agent/runtime.ts`、`ipc/agent.ts`；提交 prompt 后、模型执行前等待，保留原输入门禁 | B、C、sessionTitle、suppressOriginalPrompt |
| 8 | UserPromptExpansion | 契约/手动 | 无独立 prompt expansion 生产阶段 | B、C、suppressOriginalPrompt |
| 9 | SessionStart | 生产触发 / partial | `hooks/session-lifecycle.ts`；线程首次使用，当前 source 固定 startup，生产调用异步；未覆盖 resume/clear/compact/fork | B、C、initialUserMessage、sessionTitle、watchPaths、reloadSkills |
| 10 | SessionEnd | 生产触发 / partial | `hooks/session-lifecycle.ts`；线程删除 clear、退出 logout，等待有界 drain；并非所有官方 reason 均有调用点 | B |
| 11 | Stop | 生产触发 / partial | `agent/skill-lifecycle/completion-hooks.ts`、`agent/runtime.ts`；完成前等待、可要求修订；stop_hook_active 当前固定 false，未提供完整后台任务/crons | B、C |
| 12 | StopFailure | 生产触发 / partial | `ipc/agent.ts`；模型/API 错误退出，含 error 与可用的最后回复；错误通知不等同于成功 Stop | B |
| 13 | SubagentStart | 生产触发 / partial | `ipc/agent.ts`；task 调用被识别后，agent_id / agent_type；通知路径无完整官方生命周期阻止语义 | B、C |
| 14 | SubagentStop | 生产触发 / partial | `ipc/agent.ts`；子任务结束后等待，可停止父轮次；映射 id/type，缺 transcript 时给空字符串 | B、C |
| 15 | PreCompact | 契约/手动 | 压缩实现尚未生产分发该 classic 事件 | B |
| 16 | PostCompact | 契约/手动 | 压缩实现尚未生产分发该 classic 事件 | B |
| 17 | PreModelSwitch | 契约/手动 | 无真实主模型切换触发与费用/cache 元数据 | B、permissionDecision、permissionDecisionReason |
| 18 | PostModelSwitch | 契约/手动 | 无真实主模型切换完成触发 | B、C |
| 19 | PermissionRequest | 契约/手动 | 原审批流程存在，但没有分发官方 decision / updatedPermissions 的 classic 闭环 | B、decision |
| 20 | Setup | 生产触发 / partial | `hooks/session-lifecycle.ts`；首次 workspace init 在 SessionStart 前等待；maintenance 入口无 sessionId，因此仍只执行 legacy | B、C |
| 21 | TeammateIdle | unsupported | 本应用没有等价 teammate idle 生命周期；不能映射成 SubagentStop。目录识别和公共结果校验不改变此状态 | B |
| 22 | TaskCreated | 契约/手动 | 无官方 task 实体创建事件；不能用 subagent start 代替 | B |
| 23 | TaskCompleted | 契约/手动 | 无官方 task 实体完成事件；不能用 subagent stop 代替 | B |
| 24 | Elicitation | 契约/手动 | 无 MCP elicitation 生产触发 | B |
| 25 | ElicitationResult | 契约/手动 | 无 MCP elicitation 完成触发 | B |
| 26 | ConfigChange | 契约/手动 | 配置保存/失效逻辑未分发该 classic 事件 | B |
| 27 | InstructionsLoaded | 契约/手动 | 真实上下文来源统计存在，但不是此事件的触发器 | B |
| 28 | WorktreeCreate | 契约/手动 | 无 classic worktreePath 接管生产流程 | B、worktreePath |
| 29 | WorktreeRemove | 契约/手动 | 无 worktree 移除生产触发 | B |
| 30 | CwdChanged | 契约/手动 | 无 CWD 变更生产触发 | B |
| 31 | FileChanged | 契约/手动 | 文件监测/证据失效不等于分发此 classic 事件 | B |
| 32 | DirectoryAdded | 契约/手动 | 无额外目录加入生产触发 | B |
| 33 | MessageDisplay | 契约/手动 | 当前流式主模型 boundary 不是 MessageDisplay；未建立 delta/index/final 显示事件和 displayContent 消费 | B、displayContent |

统计：12 个事件有生产调用点，20 个只有契约/手动分发，1 个无等价生命周期而明确 unsupported。
`PreSkillUse` / `PostSkillUse` 是 CMB 扩展，不计入官方 33 项，也不投递到 classic 命名空间。

## 输入、输出与宿主身份

- 官方 `classic.PreToolUse` 独有的输入为 `ToolCallEnvelope`，并非 command hook stdin：
  `{ ...toolArguments, tool, tool_use_id }`。不附加 camelCase `toolName` / `toolArgs`，也不要求
  `hook_event_name`。宿主身份覆盖同名工具参数；转回 legacy 时恢复原参数中同名的
  `tool` / `tool_use_id`，避免损坏原生工具输入。实际 tool middleware 传播原 tool-call id；
  没有可用 id 的其他入口只生成本次调用 UUID，不宣称跨事件关联完全一致。
- 其他输入使用 `hook_event_name`、`session_id`、`cwd`、`transcript_path` 和可用的官方公共字段。
  `transcript_path` 缺失时为空，不伪造可读取的 transcript。完整事件专有输入 schema 仍待补齐。
- `pinned-input.ts` 固定 PreToolUse 的 tool / tool_use_id，以及其他 classic 的公共事件、会话、
  目录、transcript、prompt、agent、permission、effort 身份。`next()` 省略时恢复原值，改值拒绝；
  允许重写普通工具参数。插件不能通过 envelope 换工具或换宿主身份。
- `classic.ts` 按 `ClassicResultOf` 逐事件限制键和形状。PreToolUse 的 allow:true、ask:string、
  deny:string 互斥；updatedInput 必须对象，C 必须字符串数组。其他事件的 block 必须字符串，
  preventContinuation 只能为 true；未声明的字段和 legacy 别名拒绝。
- PermissionRequest 校验 allow/deny 决策分支及 PermissionUpdate 的规则、模式、目录、目的地形状。
  接受 schema 不授予权限，也不代表当前已有审批系统消费它。
- JSON 设置 20,000 节点、32 层和总计 128,000 字符上限；字段文本最多 32,000 字符、
  context/permission 等数组最多 256 项。超限/非 JSON 值按无效 hook 处理。

## 时序、legacy core 与取消

官方链为 managed settings → function modules → other settings core。本应用本轮把原 settings
hook 放到 `next()` core 中，并保留 ModsManager → FunctionSession → dispatcher 的调用链。
现有 HookSourceType 没有独立的官方 managed-settings tier，因此这是 **adapted**，不能声称
已完整实现 managed settings 的优先级。原工具权限、authority、lease、generation 和完成门禁
仍由宿主执行，`allow:true` 不授予绕过这些检查的权限。

下层 legacy core 按本次 `runHooks` 调用 memoize。重复 next、插件在 next 后抛错，以及 optional
hook 恢复均复用已经执行的 core，不重复外部副作用。模块可以短路，或返回/修改合法的下层结果。
CMB 的 human_gate、notice、requiredSkill 等本地字段保留在宿主侧，不作为官方 guest 输出别名。
不同生产调用点原本的等待/异步策略继续有效：异步通知的返回结果不能当作业务门禁。

无效 optional guest 输出由 dispatcher 跳过：未调用 next 时调用原 core；已经成功调用 next
时复用其结果。来自 core/authority 的下游失败继续向上传播，不当成 optional 插件失败恢复。

本轮增加了如下宿主边界：

1. 进入 classic bridge、进入 core、core 返回、模块返回、fallback 前后检查取消与 session generation。
2. FunctionModsManager 冷启动等待、发布输入及 session 分发前后检查 workspace epoch 和 thread 身份。
3. escaped ModError / ModFunctionError 不会触发 legacy fallback，避免撤权/代际失效后启动旧检查。
4. 已经发出的外部命令副作用无法撤销；当前修复确保不在失效后新进入 core、也不接受晚到结果。
   原 fire-and-forget 调用中没有运行时 signal 的入口、已有 legacy 子进程的完整中止仍是差异，
   本轮测试不证明所有外部 legacy 执行器均可即时杀停。

## 尚未消费的官方效果

当前生产投影消费 deny/block、preventContinuation、stopReason、C 和 PreToolUse updatedInput。
**ask 暂时阻止工具并保留理由，尚未弹出官方等价的继续审批对话框**。`sessionTitle`、
`suppressOriginalPrompt`、`initialUserMessage`、`watchPaths`、`reloadSkills`、`updatedToolOutput`、
`updatedMCPToolOutput` 等虽然可通过事件结果校验，生产消费者尚未完整接线。
只有 schema 的 permission/model/worktree/display 结果同样不能描述为已实现业务效果。

## 测试证据

以下为本轮先增加失败测试后修复的证据；测试输出不是 Autobiz 业务验收。

| 文件 | 证明范围 |
|---|---|
| `src/shared/mods/v2/classic.test.ts` | 官方 envelope，互斥决策，逐事件结果白名单，PermissionUpdate，未知事件、公共输入与 JSON 边界 |
| `src/shared/mods/v2/pinned-input.test.ts` | 工具和会话身份固定、省略恢复，普通参数可改 |
| `src/main/mods/v2/classic-session.test.ts` | 真实 QuickJS guest/session；非法别名跳过到 core，next 后错误复用 core，合法官方形状，身份伪造不进入 core |
| `src/main/mods/v2/agent-offer.test.ts` | 既有 classic 用例改为官方 tool envelope 和 deny:string |
| `src/main/hooks/classic-mods.integration.test.ts` | 生产 runner 映射、ask 适配、原始 tool-call id、参数碰撞、legacy core 只执行一次、取消和失效代际拒绝 |
| `src/main/hooks/runner-once-concurrency.test.ts` | 同一次 hook 并发共享结果、失败重试、session 重建隔离、来源身份与重复定义去重 |
| `src/main/mods/v2/manager.test.ts` | 冷启动期间 workspace epoch 变化不运行 core，关闭路径已取消不运行 core，以及原 manager/session 回归 |

本轮七套合并复跑 **67/67 通过**（2026-09-23 08:54，32.30 秒）；包含新增参数碰撞、
冷启动失效和取消回归。相关 classic 文件 ESLint `--quiet` 通过。
最终整体 typecheck、Electron E2E 和性能/关闭对照由主验证批次记录；本表不以局部窄测代替它们。
