# Skill / MCP 纳入 Claw 的只读架构评审

日期：2026-09-29。范围：`CmbCoworkAgent-mods-v2`，未改生产代码。

结论：**有条件通过，可交付，但必须把展示、注入、真实调用与线程作用域一起实施。**
现有 Claw 仅选择 Function 插件与模型，不会自动约束既有 Skill 或 MCP。
新增能力应描述为“组合本对话可调用的已安装能力”，不能描述为任意文件或进程的安全隔离。

## 1. 现有入口与必须修改的位置

| 链路 | 现有实现 | 需要完成的约束 |
| --- | --- | --- |
| 普通及 Flow 子运行 | `src/main/agent/runtime.ts` 的 `createAgentRuntime` | 从可信线程根取得同一 Claw 选择；不能按 workspace 全局改列表 |
| Skill 自动注入 | runtime 的 `getEnabledSkillsSources`、`getEnabledSkillMiddlewareSources`、`getEnabledPluginSkillSourceMetadata`、`combineSkillMiddlewareSources` | 注入清单、生命周期注册表、运行上下文来源均投影为同一选择 |
| Skill 文件读取与生命周期 | `src/main/agent/local-sandbox.ts` 的 `setHiddenSkillDirs`、`isHiddenSkillPath`、read/ls/glob/grep 与 `validateExecutionCwd` | 对未选中已注册 Skill 处理真实路径及目录别名；执行 cwd 也需检查 |
| 显式斜杠 Skill | `src/main/agent/standard-thread-turn.ts` 的 `prepareStandardUserPrompt`、`activateExplicitSkillFromMessage` | 在 `UserPromptExpansion` 和 `activateSkillLifecycle` 之前按 thread 检查，否则未注入的技能仍激活 Hooks |
| Goal 延续等显式引用 | 同文件 `validateExplicitSkillReference`，`src/main/ipc/agent.ts` 的 `validateExplicitGoalSkillContext` 等调用 | 验证需带线程/工作区，实际激活处再次校验；不能只加初始发送检查 |
| MCP 目录与实际执行 | runtime 的 `createScopedMcpCapabilityService` | 全部 list/get/peek/snapshot/invoke 共用选择；不是只把 eager 改 lazy |
| MCP eager / lazy / code_exec | `createEagerMcpTools`、`tools/tool-search-tool.ts`、`tools/code-exec-tool.ts`、`src/main/code-exec/bridge.ts` | 保持全部接收受限 service，不能另接 global service |
| Function SDK 的 MCP | runtime `bindMcp`，`src/main/mods/manager.ts` 的 `resolveFunctionMcp`、`callFunctionMcp`、`withSharedAgent` | 绑定的 invoke/list/peek 必须也是受限 service；继承父权限而非重建全局目录 |
| 非运行工具目录 | runtime `prepareForegroundRuntimeToolCatalog` | 同样按绑定筛选，避免 SDK/权限探针展示一个实际不能调用的目录 |
| 保存、应用、展示 | `src/shared/mods/claw.ts`、`src/main/ipc/mods-claw.ts`、`src/main/mods/claw-store.ts` | 保存不可变选择副本；由宿主重新核对目录身份，不信任 renderer 传来的路径/别名 |

## 2. MCP 已确认的绕过风险

`scopedMcpTools()` 现有作用是把尚未激活插件的工具转为 lazy；这不是禁用。
只在它返回值上隐藏工具仍有以下旁路：

1. `resolveScopedTool` 在 scoped alias maps 未找到后调用原始 `service.getTool`。
2. `invoke` 也回退原始 `service.getTool`；完全未知的名称继续调用 `service.invoke`。
3. transport fallback 可以选择同名 global connector。目标必须也在选中集合中。
4. Playwright 自动选标签使用原始 service 与额外 `browser_tabs` 调用。它是实际工具调用，
   不能因“宿主辅助”而忽略选择；应显式要求依赖被选中或跳过自动选择并报告准确错误。
5. global service 缓存工具身份可能在重连后变化；单次创建 runtime 后保存的本地 maps
   不能代替实际调用前的源身份校验。

建议抽取可单测 `ClawMcpCapabilityService`，包装 global service 后再交给现有 runtime scoped wrapper。
受限模式下未知/未选中的 ID、canonical ID、alias 都拒绝，不能向原始服务透传。
即使现有 wrapper 有 fallback，底层被包装服务仍保证目标受限。
`configuredServerNames` 也应投影，不能泄露不适用目录；`close/invalidate` 不擅自关闭共享全局连接。
普通未限制路径继续使用原服务，保留原来的 fallback 行为。

包装器按真实 `capabilityId + providerKey + toolName` 判断，不按可碰撞显示名判断。
保存身份使用稳定工具标识和 schema 摘要；不要持久化随机 `connectionGeneration`，否则每次重启都失效。
一次运行内可固定 connection generation 与 schema，在连接/配置更换后终止旧调用，
下次运行重新校验稳定选择。配置、凭据原文不得进入 Claw profile、日志或 UI。

## 3. Skill 的完整最小实现与边界

Skill 不是独立 RPC 工具；其效果来自目录注入、读取 `SKILL.md`、生命周期 Hook 与后续普通工具操作。
因此只筛 UI 或 middleware sources 不够，必须一起处理自动读取与显式激活。

建议建立一个宿主 Skill catalog，复用 `src/main/skills/discovery.ts`、storage 的既有来源和禁用状态，
给条目使用“来源身份 + 相对技能路径”的稳定 ID。记录 canonical root、owner plugin、
`SKILL.md` 摘要；名称可重复，但选择 ID 不可含歧义。renderer 不可自行提交任意磁盘目录为技能。

采用独立 Claw Skill policy，把允许注册条目与禁止条目传给每次运行：

- middleware、SkillLifecycleRegistry、ContextSource snapshot 使用相同条目。
- `activateExplicitSkillFromMessage` 在任何 expansion/Hook 之前拒绝未选中或已变化技能。
- LocalSandbox 的 read/ls/glob/grep 与技能 cwd 复用 policy，并校验 lexical + realpath。
- `validateExecutionCwd` 当前先放行 workspace 内 cwd，再检查 hidden skill。绑定选择要求
  先判断已注册 Skill 的选择，避免 workspace 内技能绕过 cwd 约束。
- 不直接把未选中父技能目录塞入 hidden set：技能允许嵌套，可能误挡其已选中子技能。
  应按最具体注册根判断，并允许为发现选中后代而遍历祖先；祖先的 `SKILL.md` 仍不展示。
- 插件技能的 enablement 与 owner 状态仍由全局插件机制决定；选择不能重新启用被禁用插件。
- 关闭/卸载/更新已选技能后，新运行或下一次使用给出明确失效错误，不自动改选同名技能。

必须说明的边界：`setHiddenSkillDirs` 不是 OS 级文件隔离，通用 shell 可以从其他 cwd 读取
绝对路径，已有文件工具权限也不应被描述为新技能沙箱。MCP 服务本身、普通 shell/网络和其他
Function 插件的现有文件权限不会因取消 Skill 勾选而自动撤销。
本轮保证宿主技能目录/显式选择/技能生命周期与结构化技能读取入口一致，不承诺屏蔽任意文本复制。
`SKILL.md` 摘要也不等同于全部 supporting files 的内容快照，应在说明中区分。

## 4. 向后兼容的最小契约

在 `ClawProfile` 新增可选、各自独立的选择：

```ts
skills?: { mode: "all" | "selected"; items: SkillSelection[] }
mcp?: { mode: "all" | "selected"; items: McpSelection[] }
```

- 字段缺失以及 `mode: all`：保留原来的全局已启用能力，不快照所有未来新装能力。
- `mode: selected, items: []`：明确不注入/不通过相应调用入口提供任何该类能力。
- 旧 profile 解析不能偷偷变成空选；不能用 `items.length === 0` 推断 all。
- 全局可用性、现有 permission/allowlist、Claw 选择取交集；Claw 永不提升权限。
- 未绑定、Mods 关闭、旧 Plugin 项目和 Harness：由既有 `resolveClawThread` /
  `isOrdinaryFlowMetadata` gate 返回无 Claw policy，完整保留旧路径。
- Host 创建的内部 Flow 子线程按已有根线程 + incarnation + workspace 校验继承同一副本。
  不扩大为任意 parentThreadId 可继承；普通共享 subagent 则继承父 runtime 的受限 service/backend。
- 保存模板不会改变已应用对话；应用继续遵守 idle + CAS + closeFunctionThread 的原子次序。
- 运行计划记录选择摘要，Flow 各节点用同一副本。撤权/禁用变化即时拒绝，不把旧快照当授权。

## 5. 可交付增量与验证门槛

推荐一个完整纵向批次完成两类选择，而非先交付无效勾选页：

1. 新增 shared schema 和 host catalog/policy；补存量解析及空选择测试。
2. 完成 MCP 包装器、runtime 注入、metadata-only catalog、SDK/共享子代理与旁路测试。
3. 完成 Skill policy、显式 activation gate、LocalSandbox 与普通/Flow 注入。
4. Claw 侧栏以“使用全局已启用 / 仅使用所选”切换，分别显示来源、搜索、选中计数、失效原因；
   复用全局安装/配置界面，不再做另一份 Skill/MCP 安装器。普通斜杠菜单按当前对话选项显示。
5. 真 MCP 测试服务至少提供 A/B 两工具；选 A 时 eager/lazy/raw ID/code_exec/SDK 都不能调用 B，
   同名跨 provider、fallback、browser_tabs 隐式依赖、重连与撤权均须回归。
6. 两个真实 Skill 与一个嵌套同名 Skill：自动目录、斜杠、伪造直达引用、别名路径、禁用、
   切换线程、Flow 子线程、Goal 延续、未绑定/Mods off/旧 Plugin/Harness 全覆盖。
7. 性能：catalog 按 topology/config revision 复用；不在每 token 扫技能目录、不在 permission peek
   主动连 MCP；技能/工具实际调用的缓存仍须有失效判断，不能以缓存换权限陈旧。

在上述调用门禁均落地且真 E2E 通过之前，不应宣称 Skill/MCP 已完成 Claw 能力组合。

## 6. 收敛实施契约复核与 MCP 后端实现记录

复核 [实施契约](mods-skill-mcp-implementation-contract-2026-09-29.md) 后，结论更新为
**实施方案通过，无阻断**。MCP 本轮改为按 provider 服务选择，保存宿主配置摘要；
上文逐工具/schema 的建议不是本轮实际交付粒度。目录不连接服务，空选不初始化；
非空运行仍可能连接所有全局已启用服务，限制的是调用，不承诺进程/连接隔离。

MCP 后端已实现 `readClawMcpSources` 与 `restrictClawMcpService`，后者对缺省/all 返回原服务，
受限模式投影所有 metadata 方法，并拒绝未选中 raw/canonical/alias，关闭视图不关闭共享池。
实际全局 service 增加可选宿主检查闭包，在初始化后、授权等待后、每次传输重试前、
结果发布前后复核配置/连接身份，防止仅在包装器入口检查而遗漏异步期间的撤权。

后端定向 4 个文件、10 项测试通过，包含两个真实 stdio MCP 服务的执行日志验证：
目录与空选没有连接；非空选择可同时初始化两个服务，但只有所选服务产生实际调用；
未选 ID/别名拒绝；授权等待中禁用来源不会发出请求。旧 Plugin MCP 生命周期测试通过。
本次变更 5 个文件定向 ESLint 与 Node TypeScript 检查通过。
这些结果不代替尚在接线中的 Skill/runtime/IPC/UI 与最终组合 E2E 门禁。

追加生产 runtime 接线检视：foreground catalog 与实际 runtime 的 global MCP service 均先包装，
4 处递归创建子 runtime 显式传递 host-only 来源选择；runtime 内 SDK 绑定复用同一 scoped service。
新增 `claw-mcp-runtime.test.ts` 4 项通过：实际 scoped wrapper 的 raw fallback、SDK 绑定回调、
transport fallback 的选中/拒绝、真实 HTTP CodeExecBridge 与实际浏览器标签辅助函数均受限。
该局部接线代码检视通过；它仅验证 runtime 内绑定，不覆盖独立插件命令的冷启动绑定。

### Electron 发现的独立命令旁路与评审更正

真实 Electron 验证发现 `$.mcp.call` 在独立命令中经过 `v2/mcp-command.ts` 冷启动绑定，
不经过 `createAgentRuntime`，原实现让未选择的 source-b 获得真实调用。
此前把 runtime 内 SDK 回调测试当作完整 SDK 覆盖的判断不充分，撤回这一范围的通过结论。

已补该 cold binding 的同线程 Claw service 包装，同时处理 `v2/tool-permission-host.ts`
冷 permission peek 的全局目录旁路；该文件的 native Skill 权限探针也使用同线程 Skill policy。
新增独立命令与冷权限目录回归，最终是否闭环必须以原 Electron 场景重新验证为准。

重新枚举所有 `getGlobalMcpCapabilityService()` 生产读取点：runtime 两处、cold MCP command、
cold permission peek 都应使用对话选择。另两处保留全局语义：
`ipc/code-exec-tools.ts` 的全局工具管理页预览没有 thread、使用应用目录；
`ipc/mods.ts` 的插件工具名注册检查必须保守禁止冒充任何已配置 MCP 服务，不能因取消选择而放宽。
这两处不是 Claw 对话调用入口，交付不能把对话限制宣传成全应用 MCP 断连或禁用。

## 7. 最终独立代码检视：Skill middleware 与子运行继承

独立检查了 `ClawSkillsMiddleware`、runtime 主 Skill 注入与自定义子代理 Skill 注入两处，
以及 4 处递归创建 runtime 的 `inheritedClawSources`。目录、生命周期和上下文观察的
精确文档列表一致；协调器显式技能也已在激活前校验。`assertAllCurrent()` 直接检查选中项，
没有为了每个文档重新遍历整个注册表。

确认并修复第二处遗漏：子代理传入额外的未注册 Skill source 时，通用文件读取本来允许读取
该目录；仅过滤注册根不足以阻止上游 middleware 把它重新当作技能注入。
受限 wrapper 现在按规范化路径与 `policy.middlewareSources` 取交集，保留调用者的收窄，
不允许新增来源；规范化只做绝对路径、分隔符和 Windows 大小写处理，不用同名或新 symlink
目标替代原身份。真实 backend 测试证明原 middleware 会注入该额外来源，修复后空选及选 A
都拒绝额外来源，同时选 A 仍注入 A。

**最终独立代码检视通过**，范围是本轮 Skill/MCP 选择契约及已检查的入口。
定向两轮分别为 9 个文件 51 项、修复后新跑 3 个文件 22 项通过；两轮有重复，不能相加为总测试数。
后一次覆盖 wrapper 7 项、上下文 5 项、来源 schema 10 项，wrapper 变更定向 ESLint 通过。
主实施者已报告 MCP 独立命令原 Electron 反例修复：本对话 A 允许/B 拒绝，另一对话 B 允许。
完整 Skill 切换、UI 和全量 Electron 门禁尚由主实施者继续验证，本结论不代替它们。
