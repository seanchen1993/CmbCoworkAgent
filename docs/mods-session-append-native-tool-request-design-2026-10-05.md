# 原生 ToolRequest 与 Command 旁行来源

日期：2026-10-05。工作树 `C:/ai/CmbCoworkAgent-mods-v2`。
状态：Root 第一票与 Legacy 独立第二票正式设计 PASS。已开始隔离模块实施；实际
测试由 Root 串行运行，设计票不代表 Tool/Human 产品门已经验收。

## 本轮要闭合的行为

真实工具结果使用原请求的工具名作为 `origin.tool`，即使实际 ToolMessage 没有
`name`。原工具及其旧 hooks、输出改写、错误转换先真正完成；只在已知 tools node
的最终返回地址、原 writers 前保留一次。一个真实 Command 的配对工具结果和它明确
交付的 user 旁行分别进入 `tool-result`、`tool-message`，非 messages 的控制字段保持。
保存或保护失败不能再次执行已完成 tools bound。

本轮不以任意 BaseMessage 的 role 或公开 call ID 制造 producer。SDK note、历史回放、
原 input 历史和 RemoveMessage 不获得新 ToolRequest 来源。AI/System 旁行的呈现与
model-priority 合同在下文明确列出，不假称当前 Tool-only Host 已支持所有 Command。

## 已核真实源码

本机安装包 `langchain/dist/agents/nodes/ToolNode.js`：

- `runTool(call, config, state)` 在第 156 行进入；第 244 行生成真正
  `{toolCall: call, tool: registeredTool, state, runtime}`。`runtime.configurable` 和 signal
  来自真正 node config，不来自 SDK JSON。
- `runTool` 的 base handler 第 211 行执行已选工具；第 221 行原样接受 ToolMessage
  或 Command，否则由原框架生成 ToolMessage。第 254 行等待所有 `wrapToolCall`。
- 第 305 行 `run` 按实际模型 tool-call 数组顺序启动各 `this.runTool`，原 Promise.all
  决定输出顺序；第 307 行起聚合 Command。parent Send Command 可能只保留 goto，
  它未实际进入最终 messages update 的原对象不能因此新增保留行。

`langchain/dist/agents/utils.js:304–379` 明确第一 middleware 为最外层，且每层会复制
request/state；因此不能把某层 request 的对象地址当成所有层共同地址，也不能只接
`tool-hooks.ts` 一个内层返回点。实际 `ToolNode.runTool` 最终返回点包含整个原链和
ToolNode 本身的错误转换。

本工程 `agent/tool-hooks.ts:335–449` 在 PreToolUse 后执行真实 handler，随后完成
PostToolUse、classic output 与反馈替换；`runtime.ts:2940` 的 toolErrorCatch 还能把
原异常换成真正被保留的 error ToolMessage。`deepagents/dist/index.js:1051–1117` 的
文件系统 middleware 可在原结果之后 evict 大正文，生成新 ToolMessage/Command。
这些早期对象不是新的最终 Keeper 地址。MCP 原生工具仍经 ToolNode 的最终返回；
直接 SDK MCP invoke 没有 conversation row 时不能因此新增一条工具结果。

固定 Claude Code 2.1.289 归档 `chunk-7y8w7np9.js` 的 `userDoorOf/doorOf/appendOriginOf`
静态事实：user 中 tool_result 为 tool-result；user.sourceToolUseID 为 tool-message；
assistant 默认 response，system 默认 notice。tool origin 通过原 tool-use ID 对应的
原 tool name，不使用结果 message.name。这里只引用静态源码，未扩大原 kit 后端验收。

## 最窄接线：原 ToolNode.runTool

新增隔离模块 `function-conversation-native-tools.ts`，由实际 graph 工厂安装在已知
原 `langchain` ToolNode 实例。该实际包的 ToolNode 没有公共出口，不能深导入、看
constructor.name 或假称 library brand。真实工厂固定 compiled node、builder runnable、
原 bound、它的实际 prototype 和原 runTool/run descriptor 地址；不接 LangGraph
另一同名节点或调用者提交的通用 runnable。这个安装 API 是宿主实际工厂接点。
安装发生在 native node finalizer 安装前，保原 `this`、参数、返回对象和执行次数。
不修改 node_modules，不另创建一个绕过原 middleware 的工具执行器。

拟接口：

```ts
interface FunctionNativeToolRequest { /* opaque private brand */ }
interface FunctionNativeToolReturn { /* opaque private brand */ }

interface FunctionNativeToolReturnView {
  readonly receipt: FunctionNativeToolReturn
  readonly request: FunctionNativeToolRequest
  readonly message: BaseMessage
  readonly door: "tool-result" | "tool-message"
  readonly origin: { readonly kind: "tool"; readonly tool: string }
  readonly uuid: string
  readonly originalCallId?: string
  assertCurrent(): void
}

installFunctionConversationNativeTools({ graph, runtime }): {
  read(slot: FunctionConversationNativeNodeSlot): FunctionNativeToolReturnView
  seal(receipt: FunctionNativeToolReturn): void
  close(): void
  whenDrained(): Promise<void>
}
```

token/对象表只在 utility/main 私有模块，不能进入 configurable、metadata 或 Guest globals。
这个模块只证明真实工具返回地址；target、branch、authority、policy 和保存仍由当前
NativeRun/Registry/Keeper 原合同决定，不能从 tool name 取得端点或权限。

### 首 await 前捕获

NativeNode 在原 bound.invoke 周围进入私有 Work ALS；它固定原 bound、真实 task/read/
namespace/config/input 与本次完成记录。runTool 首步必须从这个正在实际执行的 Work
取得 opaque token，config 相等只是事实复核，不能 mint 来源。完成 slot 还必须与同一
Work token 和原 bound 精确 join。ALS 继承到原 async tool 过程，但 actual bound 返回
后不能再捕获新的请求；克隆 token、调用原方法、通用 graph 的相等公开 config 都没有
本次真正 Work 来源。source 读取在 once 前只做结构核，full 宿主 guard 在 latch 后。

原 `runTool` 每次真实进入同步 mint 独立 invocation object；先 latch 私有 once，再
调用任何外部 guard。固定 actual ToolNode/method、call 对象、configurable 的真实
thread/task/namespace/read、signal、原 input 消息对象集、原 physical runtime、原
policy admission。工具名安全 own-data descriptor 取原 `call.name`；必须合法非空，
不调用 name getter，不以最终 `message.name` 或 `native-tool` 替代它。

原 `call.id` 只作为原生配对语法固定；它不选择 invocation，也不选择 authority。
同 call ID 的两个并行真实请求必须仍是不同私有对象。原 selected tool binding 若存在
固定原实例；动态工具覆盖/blocked/invalid tool 的真实控制来源由原 runTool 仍负责。
原 requested name 是公开 origin 数据，不承诺所有内层 invocation 都用了同一 tool
实例。若后续需暴露 effective binding，必须在原最终 base-handler 接点另录真正对象，
不能根据名字查最新地址补权限。

guard 继续核原 task/read/config、原 installed method/node、physical run、policy 和
signal；回调后再核廉价结构/maps。纯 descriptor capture 内部只检查原绝对时间和
signal，沿已有 performance 合同，不按每字段重复执行 DB/目录 guard。

### 实际返回与最终 node join

原 runTool 成功返回后，只检查已知 ToolMessage/Command 返回结构及明确 messages
地址。拒 Proxy/accessor；不执行 getType/toJSON/codec，不遍历任意 control/state
对象。记录 exact returned message、原 Command/路径、原 history 集与 invocation。

whole tools bound 完成后，当前 NativeNode slot 持原实际 output/path/config。`read(slot)`
必须核同 ToolNode/task/read/namespace、same private invocation 与 exact message
address；不能以相等 UUID、正文、role、name 或 call ID 对上。最终聚合丢弃的地址
不会被 read，也不会创建 Keeper。相同 actual message 出现在多个地址沿原 Node
一次 retain/多处回连；如果同对象被不同真实工具返回并且 provenance 不唯一，明确
冲突，不能选最后一个请求。

ToolRequest 只记录，不在 runTool 返回时提前保留；因此所有并行原工具先依旧完成，
原 output 顺序不变。最终 Keeper 失败仍由已完成 NativeNode once 缓存，不再 runTool。
原 runTool 成功返回后发生的来源/结构拒绝先记 sticky failure，保其 original returned
output 交 whole NativeNode；在完成 slot 的 read 拒绝、writers 前停止。不能在成功
return 后抛回 runTool 让 whole bound 看成尚未完成并被 retry driver 重跑副作用。
原 whole bound 未完成的真正框架重试沿既有语义；本接口不宣称使任意工具副作用天然
幂等。取消后 ledger 保原 native actual finally 及 Keeper work，不能公开 reject 即清零。

## 门和返回契约

1. 直接 ToolMessage 是实际原请求的 `tool-result`。Command 内唯一新 ToolMessage 的
   `tool_call_id` 与原 request ID 配对时也是 tool-result。配对只是来自该私有返回中的
   grammar 校验，不是来源证明；call ID 缺失不能制造新 ID 修补原工具语法。
2. 原 Command 明确新增的 HumanMessage/user 旁行可由同原 producer 标为
   `tool-message`，origin.tool 为原请求名。它不是 user submission，没有新 prompt
   origin/Goal/file/command 副作用，不把原 renderer flags 复制成权限。
3. 新 ToolMessage 的 call ID 不配原请求、多个不同对象争同一 paired result，或不同
   invocations 争同一地址，要先给明确原 producer contract；不猜一个 primary。初期
   阴性必须 fail before Keeper，不为了全绿改为所有 Tool 都 paired。
4. 原历史对象/RemoveMessage 保原控制，不重新 Hook。一个 Command 的 goto/resume/
   graph/Send、其他 state update、message 次序/重复地址原 Node transform 保持。
5. AI 旁行不得靠 role 假称本次模型调用。其真实 producer 可以明确保留 response，
   但 origin 必须来自该 actual producer 合同；没有 model attempt 时不能制造 model
   ID/usage/callback 来源。本轮默认不扩大 Tool-only Host。
6. System 旁行不能直接用现 native rendering 的 system 类型 stamp 成 notice：
   当前 `isFunctionConversationNotice` 排除所有 messageType system 的 provider role，
   会改变原高优先级 SystemMessage。要支持它需单独 recorded payload/rendering
   adapter（例如固定 attachment rendering + 原 SystemMessage payload），保持原
   model-priority；真正 engine notice 则仍是 notice、零模型。此处是可实现接线缺口，
   不是框架限制，不绕过保护直接外发 raw System 行。

Human 旁行需要 native projection formatter 新 readonly rendering adapter；现 Parser
忽略 user，且原 prompt flags 只适用于真实 submission。应由 Keeper 返回实际完整
payload 和 raw23 seal 后登记，不用改旧普通 user parser 来扫描重开 Ticket。

## 宿主接线与所有权

- 本模块可由本评审 owner 实现；Root 在 Host.install 已知 graph 上安装，并让
  tools.finalize 使用 read 的原 uuid/policy/origin/door，不再 message.name fallback。
- 当前 model calls 模块/response 不改。Official shared rendering 与真正 Human side-row
  projection formatter另审；Legacy NativeInput 不改，不借 prompt receipt 处理旁行。
- 后续 events v2 可用本 invocation ALS 录实际 ToolStart/ToolEnd callback run object，
  再与本真实最终 return address join；不能拿公开 call ID/事件 name 补该 token。
- 原 SDK Tool/MCP 未进入此 ToolNode 返回契约时不产生 canonical 行。共享/独立 child
  另用实际 native runtime/namespace/destination factory，main proof 不复用到 child。

## 必须真实验证

Root 串行运行，至少 actual createAgent + SqlJsSaver + AppSQLite：

- 原 ToolMessage 无 name/status，但请求实际 name 明确；origin.tool 原值、NULL 显示
  columns、effect1/provider2，下一 localhost 请求是真正改写结果。现 unnamed Tool
  修复已 Root RED 后 1 PASS/3.067s，但还没证明本 request ledger。
- 两并行同 ID/同正文/不同 name 的真实 ToolRequest，逐个 exact 返回对象对应原请求
  和各私有来源，保原 framework 聚合次序；不把 finalizer 访问次序当请求索引，不凭
  最后 callback 或 message.name 选请求。
- 原 PostToolUse/大行 eviction/错误 recovery 换消息对象，最终地址一次 retain；blocked
  和 invalid 请求效果0，实际错误一次；最终保存失败 effect1、原 completed bound 不重跑。
- 真实 Command paired Tool + Human 旁行：door/来源精确，两个 public rewrites 真正进
  下一 localhost 请求、同 checkpoint 完整 messages/members，控制字段原值/次序。
- 原 Command 带 input history/RemoveMessage/control-only parent Send，不新增保留；
  foreign equal clone、同 ID 别对象、原 target/branch/policy 撤销拒。
- 真工具 held finally、cancel/reload、ignored flush；原 native return/Scope finally 未闭合
  不清 quota/ledger；晚完成不得 mint 新 scope 或补流帧。
- 人工 ToolEnd 事件/伪 token/公开 origin/metadata 不创建 ToolRequest 来源；普通旧
  Plugin/Harness/审批/命令邻例保持，不能用 fake handler fixture 宣称完整实际门。

## 私有认证命中后的最小 guard 消重

Root 与 Legacy 已正式批准最小 A，源码已落、Root 待统一运行增量。保留原
options.runtime 地址，当前 policy admission 与该地址须命中 Manager 的私有 exact
PolicySource WeakMap；clone、generic wrapper 或别的真实 runtime 都不能借用该证明。

只有命中时去掉 request.current 中间重复的 runtime.full，原 Node Work.full仍执行，
随后 certificate.full、request/Work 纯结构后验与 certificate.tail。capturePolicy前和
所有 miss 保原 Work.full/runtime.full/policy.full。整个 Node before-bound 原 full
检查、真实任务/read/namespace/signal、method/bound/writers/closed 和 callback 关系均
未放宽。更大 B 优化需要原 Node source callback 与 Host/runtime 的另一个私有关系
证明，当前没有实施。

新增真实 AppDB/Manager/createAgent 两个回归：Work 原 callback同步换policy epoch
后仍拒；generic 独立 runtime guard 即使返回 genuine Manager policy也必须执行。
本次 Tools 预计17展开定义；Node此前18实跑PASS由Root记录，新的性能增量尚待实跑。
