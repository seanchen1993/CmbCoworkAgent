# 函数 Mods 开发与当前支持范围

当前分支实现了标准函数插件的加载、授权、直接命令、交互 Pane/Client、原生工具调用、自定义工具注册、独立文本模型请求与主 Agent 流式控制，以及应用项目完成规则。目标兼容版本固定为 Claude Code
v2.1.278（官方声明文件头为 2.1.277）；这不是全部 Mods API 已经可用的声明。实现和验证状态见
[最新契约审查](mods-v2-claude-latest-audit-2026-09-22.md)及[兼容差异表](mods-v2-compatibility-matrix.json)。

## 在应用里使用

1. 打开有项目目录的会话，进入“自定义 → Function Mods”。
2. 点击“安装示范插件”，启用项目 Mods，在 `function-commands` 一行授权显示的版本。
3. 返回会话，输入 `/claw-info 我的备注`。命令在输入框上方显示项目、会话和本会话查询次数。
4. 可以在模型运行时使用这条命令；页面重载保留计数。应用重启或重新授权会重建模块实例，
   最近填写的备注通过插件存储保留；下次不带参数执行即可看到。
5. 修改插件源码后重新检查并批准新摘要；撤销权限后菜单和旧命令描述符同时失效。

同一示例还提供 `/claw-files` 列出项目目录，`/claw-files README.md` 读取文本文件。
启用内容保护时，文件结果会先经过保护再进入插件与界面。
`/claw-board` 打开交互面板；下文说明如何用 TSX 定制它。
`/claw-brief` 调用自定义项目概览工具；也可以发送普通消息“请调用项目概览工具”。
模型是否选用工具取决于已配置模型。首次发消息前就可用 `/claw-tools` 查看当前会话工具摘要，
用 `/claw-tools read_file` 查看某个工具的完整说明；包括当前已注册工具。
`/claw-session` 查看主模型、用户轮次、消息数量、当前上下文占用、最近回复及 Git 仓库；查询不会调用模型。
`await $.session.usage()` 返回 `{ context: { window, tokens?, percent?, breakdown? }, rateLimits, cost? }`。
上下文占用取当前压缩窗口内最近一次有效模型响应的输入用量（包含缓存），与本轮累计用量分开。
新会话或刚压缩后尚无实际读数时省略 `tokens/percent`；没有价格账本时省略 `cost`，没有限额读数时返回空列表。
`await $.session.compact({ instructions? })` 请求桌面主会话做一次显式压缩，返回
`{ messages: FunctionSessionMessage[], tokensBefore?, tokensAfter? }` 或 `{ skip }`。压缩经过同一套摘要质量检查和上下文预算计算，只有在同线程
检查点未变化且持久化成功后才返回结果；活动中的主回合、已撤销会话或无绑定主图会拒绝。准备阶段不调用
外层会话模型，也不伪造用户/助手消息。归档写入使用独立的显式压缩文件路径，但路径只保存在内部
`SummarizationEvent`，不作为插件结果字段返回；checkpoint 写入失败会在具备内部归档删除能力时补偿清理。
`session.usage({ breakdown: "summary" | "full", columns })` 只在有真实 live 模型请求时可用，返回 system prompt、system tools、messages、unattributed 和 free space 分类、估算标记、消息明细及独立的 provider `apiUsage`。
无法确认的 MCP、memory、skills 或 agents 数据会省略，不填充静态数值；没有有效 live request 时返回 `MODS_CONTEXT_BREAKDOWN_UNAVAILABLE`。
`/claw-turn` 查看本会话的轮次事件，`/claw-turn abort` 停止正在执行的主轮次；结束时会显示插件附加说明。

自建插件用已有的本地插件安装入口安装，随后在函数插件区域授权。

## 一个直接命令

目录布局：

```text
my-claw/
  .claude-plugin/plugin.json
  hooks/hooks.json
  hooks/register.ts
```

`plugin.json`：`{"name":"my-claw","version":"0.1.0"}`。
`hooks.json`：`{"modules":["./register.ts"]}`。

```ts
export function register(on) {
  let count = 0
  on("session.start", async ($, e, next) => {
    await $.command.register({
      name: "hello",
      description: "显示本会话的问候次数",
      argumentHint: "[名字]",
      immediate: true
    })
    return next(e)
  })
  on("command.run", { command: "hello" }, async ($, e) => ({
    text: `你好，${e.args || "朋友"}。这是第 ${++count} 次问候。`
  }))
}
```

注册入口是同步的；事件处理可以异步。模块变量属于当前会话，跨命令保留。
同一事件不能重复注册无 matcher 的处理器；需要不同处理器时使用明确的 matcher。

## SDK 事件和返回值

当前生产会话开放：`command.register/list/run`、`session.id/cwd/surface/surfaces/model/messages/turns/repo/usage/compact/authorize`、
`clock.now/sleep`、`store.get/set/delete/keys`、`fs.read/list/exists/stat`、`turn.abort`，以及 `$.plugin.name/root` 元数据。
上述 SDK 操作同样经过事件链。另已接入有限的桌面 Pane：`ui.open/close`、
同步元素表 `ui.resolve` 与 `ui.invalidate("ui.render")`，以及 `tool.call/register/list/check`、`model.complete`，范围见下文。

普通操作 hook 返回 `{ value }` 或 `{ deny }`，调用 SDK 得到拆出的值；
`command.run` 是引擎事件，返回 `{ text }`。例如：

```ts
on("session.id", async ($, e, next) => {
  const answer = await next(e)
  return { value: `会话：${answer.value}` }
})
on("clock.sleep", { ms: 10 }, () => ({ value: undefined }))
```

`$.command.register(spec)` 返回 `{ command: spec.name }`；`clock.sleep` 返回 `undefined`。
从 hook 中再次调用 SDK 会跳过发起调用的那一个处理器，同插件的其他匹配处理器仍会执行。
`command.describe` 的 `isHidden: true` 隐藏菜单条目，但保留按完整命令名执行的能力。
在 `command.run` hook 内不能再调用 `$.command.run`，经其他 SDK 间接调用也会拒绝，
与 Claude 的会话执行通道规则一致；应直接返回当前命令的 `{ text }`。

## 观察轮次和停止主任务

在 `register(on)` 中订阅实际运行事件：

```ts
on("turn.start", async ($, e, next) => {
  await $.store.set("last-turn", e.turnId)
  return next(e)
})
on("turn.complete", async ($, e, next) => {
  const result = await next(e)
  if (e.agentId) return result
  return { ...result, text: `本轮状态：${e.reason}，耗时 ${Math.round(e.durationMs)} 毫秒` }
})
```

`turn.start` 提供 `{ text, turnId }`，默认返回 `{ turnId }`。`turn.complete` 提供
`answer/durationMs/isAborted/turnId/reason` 及实际可得的 `usage`，默认返回
`{ text: answer, usage? }`。只聚合实际有效用量；同响应 ID 的后续有效统计覆盖旧值，
缺失统计的响应不参与聚合，没有有效统计时不返回用量。完成 Hook 的新文本
作为附加说明，空文本或与回答相同的文本不再显示。

示例的即时命令使用 `await $.turn.abort({ turnId })`，只停止当前身份匹配的主轮次。
停止成功后可以继续发消息；旧轮次 ID 不能停止新任务。每个插件每会话最多尝试 50 次，
间隔至少 2 秒，错误 ID 也消耗已进入核心的尝试次数。停止的返回值不授予后续工具执行权。

当前已接入桌面 invoke、审批恢复、中断恢复、定时任务、心跳和旧远程执行入口；
模型重试不重复触发开始事件，审批暂停不触发完成事件。已知共享子代理只发送完成事件，
包含 `agentId` 和独立 `turnId`，用量与主任务分开；父任务停止时保留子任务已经收到的
部分回答。子完成不等待父任务释放租约，其 Hook 返回文字不追加主聊天通知。
`/claw-turn` 的 `lastChild` 可查看最近子任务，`childCompletions` 为子完成次数。

提供商明确拒绝时，`reason` 为 `refusal`，额外的 `refusal` 对象包含可空的
`category/explanation`。取消优先；普通正文不会被推断成拒绝，拒绝不会自动触发
空回复恢复。`/claw-turn` 显示这些实际字段。

已知共享子代理明确拒绝时，原生任务也按失败处理，父任务可以继续处理工具错误。
附加说明跟随实际回答所在行，空回答定位到同轮可见行；分页缺失的历史不会错挂到新轮次。
说明保存在当前插件会话中，最多 64 条，重建插件会话后清空；持久转录与 opaque 代理
继续实现。宿主修订为 v24，更新后需重新批准插件摘要。

## 给 Claw 增加自定义工具

在 `session.start` 里注册工具；工具通过 `tool.call` hook 实现。以下代码放进 `register(on)`：

```ts
on("session.start", async ($, e, next) => {
  await $.tool.register({
    name: "project_note",
    description: "读取用户保存的项目备注",
    inputSchema: { type: "object", additionalProperties: false }
  })
  return next(e)
})
on("tool.call", { tool: "mcp__my-claw__project_note" }, async ($) => ({
  result: { note: (await $.store.get("last-note")) || "尚无备注" }
}))
```

完整工具名中的 `my-claw` 来自插件清单的 `name`，点等特殊字符按上游规则变成下划线。
建议保存注册返回的 `tool`，避免手写完整名字。注册返回
`{ tool: "mcp__my-claw__project_note" }`；同插件同名注册会覆盖说明和 schema，下一次模型
请求使用新定义。未提供 schema 时默认 `{ type: "object" }`。注册本身不会实现工具，
缺少匹配处理器时返回 `MODS_REGISTERED_TOOL_UNHANDLED` 工具错误。
命令或其他 hook 也可用 `$.tool.call({ tool: "mcp__my-claw__project_note" })` 调用。
也可写 `$.mcp.call("my-claw", "project_note", {})`，包括调用另一个已授权插件注册的工具。
命名入口同样经过 tool.call Hook 和准入；返回 `{ content, isError }`，非数组结果使用工具文字。
相同配置服务名或归一化后的工具名冲突会拒绝注册或调用，不会覆盖物理 MCP 服务。
等待准入期间注册定义发生变化会拒绝旧调用，完全相同的重复注册不使旧定义失效。
注册和列举是操作事件，后置 hook 返回 `{ value }`；调用是引擎事件，直接返回 `{ result }`、
`{ result, isError: true }` 或 `{ deny }`。这些接口与固定版本的公开契约对照，不能推及未开放的 API。

模型会在首轮请求看到已授权插件注册的工具，包含名称、说明和参数 schema。执行前检查
schema、授权、项目和组织策略，完成后检查输出；撤权后下一轮移除工具，旧调用不能继续
执行。输入错误转成模型可见的工具错误，插件处理器不会先执行。本批能力扩大，宿主摘要
升到 v10，旧授权需在界面重新批准。示例插件更新需重新安装示例并授权当前摘要。

当前边界：

- 主助手和宿主明确绑定的一般/registry 子代理可以使用；工具目录与执行入口遵守角色限制。
  未确认权限的 opaque Runnable 暂不开放，不能借用主助手后端。
- 模型调用内可以读文件、读写插件状态；原生写文件和执行命令仍要求正在进行的用户操作，
  不能从模型 hook 自动取得写权限。非即时命令中的工具调用保留既有写入审批流程。
- `$.tool.list()` 返回实际工具装配的 `{ name, description, mcp }`，并合并注册工具、过滤角色禁用项。
  主图和已知共享子代理在首个模型请求前已有各自目录，之后随模型请求更新。普通桌面冷会话
  使用同一生产工厂准备元数据，反映 Solo、内存、LSP 和 MCP 设置；不创建模型或执行工具。
  MCP 发现可能初始化已配置服务。已有远端/任务实例使用自己的目录；冷 IM、定时、心跳、
  feature 会话不推测前台目录，返回 `MODS_TOOL_CONTEXT_REQUIRED`。配置或实例变化使在途查询失效。
- 每插件最多 32 个、每会话最多 128 个工具；元数据 JSON 合计最多 256000 字符，工具说明
  最多 8000 字符。超限替换不会破坏旧条目。
- schema 最多 16000 字符、256 个节点、12 层，输入最多 64000 字符；不做类型强转或默认值填充。
  支持 `type/properties/required/additionalProperties/items/enum/const`、
  `anyOf/allOf/oneOf/not`、`uniqueItems`、长度/数量/数值范围和 `multipleOf`。
  `title/description/default/examples/$comment` 仅作注解。其余关键字（含 `$ref`、`pattern`、
  `patternProperties`、`format`）明确拒绝，不声称支持完整 JSON Schema。比较和组合校验有工作量预算。
  顶层参数不能使用宿主身份名 `tool/tool_use_id/agentId`。
- `tool.check` 已支持权限查询；Claude 内建工具参数映射仍待补齐。MCP 使用下述独立 SDK。

宿主调用会记录真实轮次、代理和父子调用关系。自定义工具内部调用原生工具或
`$.model.complete()`，审计能追溯到外层工具；每次实际执行仍单独记账和保护输出。
原生读取 SDK 支持宿主明确绑定的子代理，子代理不能借用其他实例的后端。排队任务保留
原调用实例身份，同 ID 重建、取消或调用方结束后，遗留任务不能重新获得授权。
当前宿主修订 v21，需要重新批准旧授权快照。
运行时禁用的工具在 SDK 查询和真实调用中也会被拒绝，不依赖是否安装 tool.check Hook。
隔离执行目录与授权项目分别保留；session.cwd 和文件 SDK 使用实际执行目录，授权及审计
继续属于原项目。文件 SDK 复用后端路径检查，不能读取被工作树边界禁止的 .git 文件。
范围和验证记录见 [运行目录与宿主权限基础](mods-v2-runtime-authority-2026-09-17.md)。
子代理接入边界见 [代理实例与共享任务权限](mods-v2-agent-instances-2026-09-17.md)。
架构边界及后续顺序见 [宿主调用基础复核](mods-v2-host-foundation-2026-09-17.md)。

## 查询和定制工具权限

权限查询可先使用 `/claw-check {"tool":"read_file","input":{"file_path":"README.md"}}`。
在处理器中调用 `await $.tool.check({ tool: "read_file", input: { file_path: "README.md" } })`，
返回 `{ decision, reason?, rule? }`，没有 `value` 外层。查询不执行工具、不审批、不运行
classic Hook，也不产生工具执行账本。已有有效 MCP 元数据才可被查询，不会为查询连接服务器。

在 `register(on)` 中可以添加权限规则：

```ts
on("tool.check", { tool: "read_file" }, async ($, e, next) => {
  if (e.input.file_path === "private.txt") return { decision: "deny", reason: "项目规则禁止读取此文件" }
  return next(e)
})
```

查询与实际调用都经过此事件；后者由宿主提供 `tool_use_id`。`tool/input/tool_use_id` 固定，
模型来源是 engine，SDK 来源是发起插件。Hook 不能放宽宿主强制约束；查询结果也不能
代替实际审批。理由经保护后供用户和模型查看。详见 [权限机制复核](mods-v2-tool-permission-2026-09-17.md)。

## 调用已配置的 MCP 服务

重新安装示例、批准当前插件摘要后，普通项目会话可直接输入：

```text
/claw-mcp {"server":"服务名称","tool":"工具名称","args":{"参数":"值"}}
```

服务必须已在本机 MCP 设置中配置并启用；命令不会启动模型。审批显示实际工具和最终
参数。插件命令中使用与 Claude 相同的调用签名：

```ts
const result = await $.mcp.call("Company Mail", "search", { query: "需求" })
// result: { content: [...], isError: boolean, structuredContent?: unknown }
```

省略第三个参数等价于 `{}`。`server` 可使用服务显示名或工具标识中的规范化服务名，
`tool` 使用服务提供的原始工具名称；重名有歧义时明确报错。
参数最多 16000 字符；结果保留原始 MCP 内容块的顺序，经项目策略过滤后返回。
服务返回 `isError: true` 是工具错误结果；拒绝授权、连接断开等宿主错误会拒绝 Promise。
后者只返回稳定错误码，不把连接详情或凭据带回插件。

其他 Hook 可以用 `on("mcp.call", matcher, handler)` 改写 `{ server, tool, args }`，
`next(e)` 返回 `{ value: result }`，也可以返回 `{ deny: "原因" }`。
短路合成或直接拒绝结果仍经过输出保护，不创建宿主执行记录；进入宿主路径后，
账本分别记录执行状态和发布状态。

目前仅支持主助手中的存活用户操作，例如非即时命令或按钮。模型 Hook 和即时命令不能
自动取得 MCP 写入权限；项目、会话、服务绑定或授权发生变化后旧调用不能继续。
冷启动命令限普通本地项目会话，工作流、受限子代理和远端只读会话不会借用此入口。
同一会话的冷命令 MCP 调用按顺序进入宿主，最多保留 16 个待处理调用；可以用
`Promise.all` 等待多个结果。嵌套在自定义工具中的调用继承父调用轮次和审计关联，
等待期间取消或调用方结束的任务不会重新取得执行权。

这里保留了明确的 D01 差异：Claude 将插件调用视作 MCP 授权、不再弹权限提示；本工程
继续执行强制策略和最终参数审批。MCP schema 的实际参数校验沿用现有 MCP 服务端，
不会套用自定义注册工具的受限 schema 子集。`$.tool.call({ tool: "mcp__…", ...args })`
可使用当前目录中的 scoped 或 canonical 名称，歧义名称会被拒绝。命名 `$.mcp.call`
解析实际工具后也会经过 `tool.call` Hook；直接 `$.tool.call` 不额外触发 `mcp.call`。
权限查询使用当前运行的工具作用域，过期绑定不会回退到全局目录。
完整范围及证据见 [MCP SDK 实施复核](mods-v2-mcp-sdk-2026-09-17.md) 和
[MCP 工具入口对齐](mods-v2-mcp-tool-routing-2026-09-17.md)。

## 调用已配置的模型

`/claw-ask 问题` 使用模型设置中的默认模型回答一次问题。自建插件可以调用：

```ts
const text = await $.model.complete({
  model: "default", // 或模型设置中的明确 ID / custom:ID / builtin:ID
  prompt: "请为这个项目列出三项自检建议。",
  system: "用简洁的中文回答。",
  maxTokens: 512
})
return { text }
```

它只发送这一次文本和系统说明，不附带聊天历史、不调用工具；工程身份说明由宿主添加。
返回字符串。模型地址和密钥始终由宿主配置，插件不能传入。模型名不存在或缺少密钥会报错，
不会悄悄改用另一个模型；Claude 的 `haiku` 等别名只有匹配本机已配置模型时才可使用。
拦截 `model.complete` 的 hook 返回 `{ value: "文本" }` 或 `{ deny: "原因" }`；
多次 `next` 会产生独立请求和实际用量。普通 hook 自己抛出的错误仍遵循跳过规则，
需要显示 SDK 拒绝原因时应在命令中捕获并返回文本。

默认输出上限 256 Token，可指定 1–4096，并受模型配置的更低上限约束。
提示词最多 32000 字符、系统说明最多 8000 字符、返回最多 64000 UTF-8 字节。
应用最多同时 4 个请求，同一项目/插件最多 2 个；每个项目/插件的滚动一分钟限制为
30 次调用、32768 个预留输出 Token。预算随执行记录持久保存，重载插件或重启不会清零。
每次请求最多 60 秒；取消会关闭实际响应流，不自动重试不确定的请求。

在项目 Mods 的执行记录可看到配置引用、输出上限及服务返回的输入/输出 Token；
服务未返回用量时显示“未返回”，不能视为零消耗。调用记录只保留提示词摘要，不保存原文或密钥。
启用内容保护时，模型完整文本先经保护，再进入插件后置 hook 和界面。
本次新增模型权限使旧授权摘要失效，需要在 Mods 页重新批准明确列出的能力。
`model.fork/classify` 与主会话 `turn.step` 已通过独立的宿主边界接入；它们不是上述单次
`model.complete` 的别名，具体上下文、预算及差异见[主模型 step 说明](mods-v2-model-step-2026-09-23.md)。

## 插件状态

`$.store.get("key")` 对未设置的键返回 `undefined`，保存的 `null` 则原样返回。
`set` 保存 JSON 数据；日期转换为字符串，对象中的 `undefined` 字段丢弃，函数与循环数据拒绝。
`keys` 保持插入顺序，覆盖已有键不会移动它，删除后重建会放到最后。

```ts
await $.store.set("preferences", { language: "zh-CN" })
const preferences = await $.store.get("preferences")
```

状态按项目和插件名隔离，在应用重启、源码重载和重新授权后保留。与 Claude 按用户配置目录
保存整个插件状态相比，这里增加项目隔离；`store.*` 仍是可被已授权 hook 观察和改写的事件。
写入前及读取结果交给插件处理器之前，都执行适用的宿主输出策略。

存储总量最多 4 MiB；当前跨进程 JSON 单次上限 1 MiB，键名必须是合法 Unicode，
最多 4096 UTF-8 字节，最多 8192 个键。
这些属于宿主资源限制。单次 `set` 是事务，但 `get` 后再 `set` 不是原子加一；并发计数需要另行设计。
数据库备份包含状态，控制库迁移与回退限制见 [运维说明](mods-operations.md)。

## 项目文件

`$.fs.read(path)` 读 UTF-8 文本，`list(path = ".")` 返回按名称排序的
`{ name, kind, size }`，`stat(path)` 返回 `{ kind, size, mtimeMs }`；
`kind` 为 `file`、`dir` 或 `other`。`exists(path)` 对缺失或不可访问路径返回 false。
取消、撤销和 hook 拒绝仍会使调用失败。

相对路径在进入 hook 之前转成项目下的绝对路径；`next({ ...e, path })` 改写后再次解析。
所有真正访问磁盘的请求都经过项目边界检查，读取通过稳定文件句柄完成，结果先经过宿主内容保护。
外部目录、逃逸链接、Windows 设备路径和替代数据流不能通过此授权读取。

这是明确的宿主差异：Claude 允许访问宿主可达路径，并对读写设 4 MiB 上限；当前 CMB
这一授权仅允许项目内只读访问，单文件最多 512 KiB、单目录最多 1024 个条目，并受 1 MiB
JSON 传输上限约束。超限报错，不截断伪装为完整文件。`fs.write/ancestors` 仍未交付。

## 交互面板

更新内置示例并批准新摘要后，输入 `/claw-board` 可打开“我的 Claw”：反复点击计数、
保存项目备注、切换视图、关闭后重新打开。偏好跨应用重启保存；面板本身归属会话，
应用重启后需重新输入命令打开。示例源文件为
`resources/mods/function-commands/hooks/board.tsx`，通过第二个 `hooks.modules` 加载。

```tsx
on("ui.render", { component: "Pane", requestId: "board" }, ($, e) => {
  const { Box, Text, Button } = $.ui.resolve(e)
  return <Box flexDirection="column">
    <Text>我的工作面板</Text>
    <Button label="刷新" onPress={() => $.ui.invalidate("ui.render")} />
  </Box>
})
// 在已注册命令的处理器内：await $.ui.open({ id: "board", title: "我的面板" })
```

`ui.resolve` 同步返回冻结的构造器表；回调可以直接捕获 `$`，在渲染结束后继续使用。
无需把函数序列化或自己维护按钮句柄。不要将 `$` 本身赋给其他变量：Claude 的静态检查
会拒绝这种写法；可以保存直接调用 `$.noun.method()` 的闭包。
`ui.open/close` 是返回 `undefined` 的操作，hook 使用 `{ value }` / `{ deny }`。
`ui.press/input/select` 在原回调之前运行，回调结束后可以请求重绘。
`Input` 必须提供 `onSubmit`；`onInput` 可选。`Select` 提供唯一值的选项和 `onSelect`。

每个会话最多 8 个面板、每个 VM 最多 1024 个存活回调、每棵树最多 1000 节点/24 层，
最多保留 4096 个操作 intent；超限明确失败。新点击使用新 intent，IPC 重试使用原 intent。
旧绘制、关闭、撤权、运行时替换后的句柄不能执行；卸载清理资源。重绘通知按 100 ms 合并。
普通 `next` 始终绑定原分发；SDK 使用异步延续自己的调用身份，失效调用不能借用新回调。

**当前仍是桌面 Pane 子集**：仅 inline 位置与 Box/Text/Button/Input/Select/Link/Code 的
明确属性白名单及下述 Client。Code 支持源代码高亮、行号、折行和统一 diff；路径仅作语言
推断，不读文件。Pane/Client 提供有界焦点和滚动事件。其余 13 个渲染位置、Svg、自定义
构造器 hook、实际尺寸上报、快捷键及 hover 仍未交付；`holdToasts` 明确报不支持。
`ui.invalidate` 目前仅支持 `ui.render`。面板回调可以 `await $.command.run({ command, args })`：
普通命令等待统一会话队列，`immediate: true` 命令可以在模型运行时查询。返回值保持 SDK 原样，
任务栏保留执行记录。回调等待期间仍可重绘进度；用户关闭面板或撤销授权会取消其未执行任务。
已经开始的任务取消后保留待核查状态，不重放。插件自己的 `$.ui.close` 不会取消自己的回调。
命令处理器内直接或间接等待 `$.command.run` 仍被拒绝，避免在已持有执行权时等待自身队列。
`focus: true` 申请一次键盘焦点，宿主会避免打断用户编辑，选择首个 `autoFocus` 控件；重绘
不会重新抢焦点，关闭或换代会使请求失效。见[焦点范围](mods-v2-pane-focus-2026-09-23.md)
及[Code 范围](mods-v2-code-ui-2026-09-23.md)，不能据此声明所有桌面属性兼容。
插件中的 async/await 和异步生成器在载入时编译为 Promise 延续；
动态创建的原生 async 函数不保证保留该上下文，应使用源码中声明的异步函数。

## 检查和边界

构建后运行 `node bin/cli.js plugin check <目录>` 可检查包、快照摘要和事件注册。
它不是授权，也不证明所用宿主能力全部已经接入。`inspect` 输出相同范围的检查报告。

`engine.create` 已支持有界的跨插件 JSON 方法提供方，见[构建与限制](mods-v2-engine-nouns-2026-09-23.md)。
当前尚不能用这一入口交付官方完整多站点 diff、网络 SDK、`fs.write` 与祖先指令读取、
配置表单或完整 classic 事件；经典 Hook 的逐事件范围见[契约表](mods-v2-classic-contract-2026-09-23.md)。主 Agent 的
`turn.step` 已经过宿主 opaque-frame 边界，`model.fork` 使用清洗后的实时会话快照，
`model.classify` 使用固定宿主提示；这些是 adapted desktop 能力。每个主模型 step 可选择
已配置模型和明确支持的 effort，未知值拒绝；插件不会获得凭据或未发布 provider 流。
模型选择和流式兼容差异仍应按兼容矩阵查看。
命令文本以桌面结果区呈现；终端的显示宽度与布局不能等同于 Electron 窗口尺寸。

运行中最多保留 6 个函数会话，每个会话最多 8 个插件；单命令参数上限为 32000 字符。
普通命令等待会话执行租约，`immediate: true` 命令可立即运行，只能调用只读工具。
基础 hook 的超时、CPU、内存和递归预算仍受宿主限制。
命令及 UI 动作最多等待 120 秒；每段 JS 的 CPU/内存预算不变。删除会话会取消排队任务、
释放 VM，并使旧会话描述符失效。内置 `/claw-board` 的“查看项目文件”演示面板调用命令。

v1 的 `/mod 模块:命令 [JSON]` 和权限模型继续独立运行；v1 授权不等于函数插件授权。

## Client 持续交互组件

更新并重新批准内置示例后，`/claw-client` 打开交互工作台。点击“本地加一”更新组件状态，
向所属插件发送消息并获得确认；“重绘面板”保留计数。备注、选择、方向键、指针及计时器
都在独立组件 VM 内处理，不请求模型。Escape 离开组件焦点。关闭后重新打开会重置本地状态；
需要跨重启的数据由宿主 hook 显式写入 `$.store`。

```tsx
on("ui.render", { component: "Pane", requestId: "board" }, ($, e) => {
  const { Client } = $.ui.resolve(e)
  return <Client key="counter" module="./counter.tsx" props={{ label: "计数" }} />
})
on("ui.message", { element: "counter" }, async ($, e) => {
  await $.store.set("last-count", e.data)
  return { props: { label: "已保存" } }
})
// counter.tsx：独立模块，无 $、Node 或 DOM。
export default function Counter(props = { label: "计数" }, surface) {
  const { Button } = surface.elements
  const count = surface.state ?? 0
  return Button({ key: "add", label: `${props.label} ${count}`, onPress() {
    surface.setState(count + 1)
    surface.post({ count: count + 1 })
  } })
}
```

`module` 必须是静态字面量，按源文件相对位置解析；组件及依赖一起纳入批准的快照。
组件通过 `surface.state/setState`、`columns/rows`、`every`、`onKey/onPointer` 和 `post`
运行。相同面板、插件、key、module 的组件在外层重绘时复用；移除或换模块后销毁。
消息只发给所属插件的 `ui.message`，返回的 `props` 更新组件；外层重绘重新应用父 props。
发布内容及消息先经过工程的输出保护。卸载会取消正在等待的回调，旧动作无法恢复组件。

当前差异：仅同步组件绘制和同步组件回调；每会话最多 8 个活跃 Client，每组件最多 16 个
计时器及 256 个控件。计时器最快 16 ms，积压事件合并；尺寸按桌面 8×24 px 网格估算。
Client 元素与 Pane 共用明确的属性白名单。超预算只停止该组件；它不加载任意脚本、网络资源
或尚未批准的模块。已验证官方 Client 描述符契约；自身生命周期和 React E2E 的通过不等于
所有上游 Client 行为已经完成对照。

## 调用工程工具

`$.tool.call({ tool, ...args })` 已接入生产原生工具，返回 `{ result, text, isError? }` 或
hook 给出的 `{ deny }`。例如 `/claw-tool-read README.md` 读取文本；
`/claw-tool-write 一条记录` 经批准写入项目的 `mods-sdk-note.txt`，示例 hook 会先添加标题。
授权对话框展示的是 hook 和宿主处理后的最终参数。普通新建项目会话可以直接使用，无须先问模型。

```ts
on("tool.call", { tool: "write_file", file_path: "notes.md" }, async ($, e, next) => {
  return next({ ...e, content: `# 项目记录\n${e.content}` })
})
// 已注册命令或用户发起的面板回调内：
const answer = await $.tool.call({ tool: "write_file", file_path: "notes.md", content: "检查完成" })
```

当前可调用 `read_file/write_file/edit_file/ls/glob/grep/execute/task_output`，名称、参数、
`result` 使用本工程原生工具格式；还不是 Claude 的 `Read/Bash` 等内置工具 schema。
`execute` 支持 `run_in_background`，`task_output` 支持 `block/timeout`。后台任务仍绑定
原 run lease、runtime、授权与用户取消信号；撤权、关闭、换代或 lease 释放主动终止。
受管执行保持前台语义。仅允许相应适配器已支持的字段，未知选项明确拒绝。输入最多 16000 字符；
这不是 `fs.write` 的实现。插件工具注册见上文；模型发起的工具调用也会进入同一 hook 链。

SDK 发起的 `tool.call` 经过函数 hook 链，允许改写普通参数、拒绝、短路及有界多次 `next`；
工具名称和调用身份不能改写。每次进入真正的工具核心都重新做范围检查、审批和执行记录，
后置异常不会重复执行。原生工具的输出先过宿主策略，再交给观察它的函数 hook。
普通命令复用已有会话租约，面板工具操作排队等待；即时命令允许读，拒绝写。
自动回调不能沿用已经结束的用户动作权限。取消、关闭或撤权向等待和执行中的调用传播。
工作流等特殊会话仍要求已有的相应工具上下文，不自动降级到普通项目沙箱。

## 定制模型使用工具的行为

更新并重新批准示例插件后，输入 `/claw-tool-hooks on`，再让 Claw 读取 `claw-notes`。
实际会读取项目的 `mods-sdk-note.txt`（可先用 `/claw-tool-write 一条记录` 创建）。
读取 `claw-blocked` 则被示例拒绝，不执行原生读取。`/claw-tool-hooks off` 关闭示例规则；
开关保存在当前项目的插件偏好中。普通对话经过真实的模型工具调用，无须手动调用 SDK。

```ts
on("tool.call", { tool: "read_file" }, async ($, e, next) => {
  if (next.origin.plugin !== "engine") return next(e)
  if (e.file_path === "blocked.txt") return { deny: "此文件不允许读取" }
  const result = await next(e)
  return { ...result, context: ["请结合项目规则解释读取结果。"] }
})
```

模型调用的 `next.origin.plugin` 为 `engine`；SDK 调用为发起插件。可改写普通参数，
以 `{ result }` 短路，或 `{ deny }` 拒绝。`tool`、`tool_use_id`、`agentId` 由宿主固定。
与这些保留名称重名的原生工具参数仍按原值传给工具，不能通过事件字段改写。
每次显式 `next` 都是独立执行并单独审计；后置 hook 异常保留最后一次结果，不重复执行。
hook 中嵌套 SDK 读取复用当前执行权，写入仍需要存活的用户动作，不能借模型调用取得写权限。

模型工具的下游结果包含仅在本次调用有效的 `ref`：保留它会选择原始宿主消息，
`result/text` 的改写不会替换该消息。要更换展示结果需去掉 `ref`，返回 `{ result, context? }`。
真实执行记录、错误状态及代理调度控制信息保留；改写展示不能撤销已经执行的操作。
`context` 只进入下一次模型请求，不显示为工具正文；新用户消息或模型回复后不再重复附加。
多工具同轮上下文合计上限 128000 字符。宿主策略继续检查实际参数和最终输出。

本批接入工程现有的模型工具入口，并未把原生工具换成 Claude 的 Read/Bash schema，
工具注册和 MCP SDK 见上文；主模型流已通过宿主边界接入。升级宿主能力会改变授权摘要，
须重新批准，不能沿用旧摘要静默取得新增能力。

## Guest 字节字符串 Base64

hooks与Client可用只读全局 `atob` / `btoa`；示例 `atob(btoa("hello"))` 返回 `hello`。btoa只接受Latin1字节字符串，中文应先由业务明确编码，不能把它当作UTF-8转换器。512 Ki字符上限、原VM计算/内存预算及InvalidCharacterError类型差异见[Base64使用范围](mods-v2-base64-2026-09-24.md)。这不会开放Node/Buffer或二进制文件读取权限。

文件读取可显式指定 `{as:"text"}`，操作事件含as字段；非法选项或尚未支持的bytes模式明确拒绝，详见[读取模式与差异](mods-v2-file-read-options-2026-09-24.md)。
