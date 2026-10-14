# Main 原生 V2 事件的真实来源：具体设计稿

状态：只读设计。总体推进顺序已获 Root DESIGN1 与 Legacy 条件 DESIGN2；下述三个
实际 API 接缝仍须各自精确两审，尚未获得生产窗口。本稿不能说明 streamEvents 已经开放。
当前 native Main 仍在原 wrapper 中明确拒绝，generic 旧事件路径保持原行为。Shared
stream 的 observer/activation 由另一窗口实现，本稿不改其 opening 或 ready 合同。

## 实际入口和不能借用的来源

本机 ReactAgent.streamEvents（ReactAgent.js 683）仅合并原私 defaults，再直接调用
实际 graph.streamEvents；它没有 ReactAgent.stream 的初始化阶段。Pregel.streamEvents
（pregel/index.js 916）再合成 signal，并合并 graph.config callbacks。Runnable 的原
_streamEventsV2（runnables/base.js 364）创建原 EventStreamCallbackHandler，按原分支
将它加入 callback array 或 copy 一次 CallbackManager，再生成自己的 signal 调用
graph.stream。现 Main Lifetime 的 graph.stream 壳层要求 exact invocation.signal；
不能把 V2 另一次 any 的结果与上游 signal 按 aborted 状态或 JSON 当成同一来源。

原 EventStreamCallbackHandler 的 onLLMEnd 从原 generations 取 provider message，
onToolEnd 从原 tool outputs 取结果。二者均可早于 NativeNode finalize、Keeper ACK 和
原 writers。事件 data.output 不因出现在 end 事件而安全，原 run_id、name、metadata
或 public stamp 不提供 Slot、ToolReturn、policy 或 canonical 资格。

原 V2 的首个实际过滤后事件还会写 data.input=原调用 input，后续同 run 的 end 会
去掉该 input。这是实际协议规则，不能只保护 chat_model_stream 而漏掉首 input。
当前安装版本的 event 对象不生成 parent_ids，本稿不凭别的版本文档添加它。

## 拟定的固定原执行接缝

新增内部 `native-conversation-events-v2.ts`。只允许已知 Main native factory 的实际
Host/graph/runtime 私 installation 加入；不导出 caller callback 注册、blind token
factory 或 accepting arbitrary event 的认证入口。原输入和配置先 descriptor/typed
捕获，first reading/failed latch 在任何原 callback 前占用。

保持真正 ReactAgent.streamEvents 的原 method/receiver/default merge，保持真正
Pregel.streamEvents 的 signal/callback merge；在实际 compiled graph 的私 installation
中记录收到的 merged config 和原 invocation。native shell 固定原 encoding 意图，给
原下层的是 own encoding undefined，阻止 Runnable 先执行 raw HTTP encoder。普通
无 native installation 路径不改。

在该真正工厂内安装模块自造的 controlled V2 driver 作为实际 `_streamEventsV2`
接缝。它保留原 ensureConfig、runId 选择、callbacks 三种合并分支和原过滤语义，
但由本模块建立原 V2 controller、实际 final stream signal 和队列。这个实际 signal
在调用原 graph.stream 前固定到本次 Lifetime，而不是接受未来 observed signal 的
任意注册或事后换绑。每次只启动一次原 graph.stream；模型、工具、writer 不重放。

controlled driver 的方法和 receiver 必须来自已知 factory 内安装记录；不能仅靠
ALS 存在或函数名称证明执行。compiled event shell 与 driver 的一次 operation、
返回的私 iterator、实际 graph、Host/runtime 与 final signal 互相 exact join。原
callbacks.copy 若抢先调用 compiled shell，会使同次 operation sticky 失败，不能
发布另一个 stream 或降回 generic。派生助手必须分别安装原图，不借父安装记录。

Events Source 必须有独立的私 kind/installation 记录。现
currentFunctionConversationNativeSseSource 只有真实 SSE encoding 才返回 token；不得
给普通 V2 graph.stream 假造 text/event-stream 以开启旧 ACK/partial 能力。Calls 的
首 modelStart 分别 pin 本次 genuine Events Source，后续 returned/Name/ACK reader
只能 exact 该首 Attempt 的 Event token。没有 Event 的普通调用和已有 SSE proof 不
变，SSE token 不能作为 Event token，不能在 End 后给旧 Attempt 换 Source。

这替换的是原 V2 内部队列驱动，不能宣称完全保留其内部回调实现。实际 SDK 对照
必须钉用户 callbacks/copy 的次数、过滤顺序、首 input/end 规则及默认配置；如果
对照不等，修该真实接缝，不以硬写 callbacks/defaults 掩盖差异。

## 事件私有记录与输出分类

原 factory 自建 EventStreamCallbackHandler 的实际 producer 与队列地址固定在同一
record 中。只能由其实际 observer 的原 enqueue 记录捕获 event/container/metadata
拓扑和 cut；外部 JSON、同 runId、复传已见 event 或相同值均不能补登记。每个事件
先完成 Proxy/accessor/symbol/完整 own-data typed 检查；不运行 raw toDict/toJSON。

消息来源与诊断来源分开：

| 事件的数据 | 所需实际关系 | 交付规则 |
| --- | --- | --- |
| root/chain input 和完整 messages | 本次首输入、真实历史读取或当前 Host own Entry | 全组分类；未知新增 unmarked 拒；完整原生副本后原 canonical A/B |
| chat_model_stream 的原 chunk | 本 Calls actual Attempt/chunk 地址 + 同 Events Source/Work/runtime | 原 protected partial 门；没有真实 chunk token 不猜 ID 或构造消息补权 |
| chat_model_end 的原 aggregate | Calls actual returned 地址、Node actual slot、同 Source 与原 ACK | 显式 deferred，待真 Keeper/own Entry/drain 与成功 writer，再用实际 safe 消息；不把原 End 当保存完成 |
| tool_start input | 原 Tools factory 真实 request/Work/args/策略与本次 Source | 独立 typed policy diagnostic，无 Tool/append 权限 |
| tool_end/tool_error 的原 result | 同 actual request 的真实返回/失败记录 | 显示副本走 diagnostic；若包含原生消息，还须 actual ToolReturn/own Entry，不按 role 猜 |
| chain_stream/chain_end state messages | 原 iterator/writer + 本 Host/input/history | values/updates 原完整规则，noBubble 省略只用实际 disposition |
| name/tags/已支持 metadata 自由显示值 | 同源完整字段 baseline + genuine policy capsule | 共享 diagnostic Worker 保护；协议路由字段不因字符串正则获得资格 |

Start 事件不能等到 end 后再证明原输入，必须使用首 input/request 来源。工具早回调
亦不能用 model token reader 代替请求证明。新增 request-only pure/full reader只能由
原 Tools 工厂私 record 产生，不能接受 caller 传函数或公开 runId 自称 actual request。
本稿没有已实现这个 reader；它是实施前需单列的精确源码合同。

metadata 先沿现固定 framework 字段合同。未知 state、custom/retriever/非 chat LLM
等本窗未适配类别明确拒绝，下一项补真实 diagnostic adapter；不能仅 plain copy 或
regex 后原样外发。error 对外只新固定 safe code，绝不读未知 message/stack/toString；
内部 firstReason（包括 null/undefined）与 failed boolean 分别保留，真实失败不吞掉。

## End 不死锁与原顺序

EventTracer 的 end callback 发生在实际 Node finalize 前。其 callback 不能 await
Keeper ACK，否则原模型/工具不能返回给 Node，形成实际循环等待。该事件只预留
原共享 admission 容量、保存 actual returned baseline、登记 pending，再归还 callback
控制；pending 不出 DTO/bytes，也不代表成功。原 graph 的真实消费继续到 finalize、
writer 和 ACK。不同地址的 aggregate 不以首 chunk 代替，完成改名仅沿现真 Name proof。

普通可交付事件保持原序；pending end 阻挡后续公开帧，而内部只按原有限协议推进
实际 graph。用单一共享 4 Worker/256 admission driver，不复制池、不伪装 Message
proof；first cut 不续期。普通背压不预拉全部图；为到达真 ACK 的额外推进和 pending
记录必须独立有界并钉实际来源，end/missing writer/failed ACK 明确失败。

## 最后完整核验与取消

每次准备交付前，先完成所有 event/request/Attempt/metadata/policy/history full 回调，
然后原 Host 对整组 canonical 消息做完整 23/receipt/presentation/ledger A/B。B 之后
只能检查原 event/frame/namespace/container、raw/safe/返回 aggregate、policy epoch、
Slot/Work/Source/域/信号/cut 与副本的纯尾。同步组装 DTO/编码/enqueue，无额外 source
callback。不能逐条 B 后又执行下一条 full，不能在出队时用 late callback 补资格。

普通 IterableReadableStream 与 SSE 共用同一实际 driver；SSE 只对上述安全 DTO 编码。
本机原 convertToHttpEventStream 使用固定 `event: data` 加完整 event 的 JSON，最后
固定 `event: end`；不是 Pregel 普通 SSE 的 mode/namespace 事件名。JSON 中原 Base
调用 Serializable.toJSON，得到 lc/type/id/kwargs constructor 形状；也不是普通 SSE
的 toDict 平铺。新的纯 encoder 必须按这份真实 LC 原合同生成安全数据副本，并用
实际 safe native instance 的原 codec 黄金对照。raw 的 toJSON/getter不执行，B 后也
不调用 serializer；未知 constructor/secret/alias 不猜。不能为迁就测试改用另一种
扁平 shape 或删完整 native 字段。

return/throw/ReadableStream.cancel/原 signal/natural end 共用 once finalizer：先禁止
出站并 abort，真实原 generator finally 和所有 pending next/return 逐项观察，然后
same-source Node/Host/diagnostic/Worker 全 drain。unknown 终态继续隔离，不能把返回
壳关闭或 terminate resolve 当真实退出。公开错误固定化不改变真实 terminal status。

## 实施前后必须的真实门

1. 未包装 SDK V2 对照：普通和派生 defaults、三种 callback 合并/copy once、filters、
   首 input/end 删除、原事件顺序/完整字段、一个 provider 与实际 Tool effect/Hook。
2. genuine Main Host/Manager/Saver/Calls/ToolNode/Worker；真 end 早于 finalize 不提前
   出站且不死锁，实际 aggregate/chunk 地址不同、成功 writer/ACK/全 23/CP。
3. 跨 Main/child/并行 Source、clone/复传事件、假 runId、假的 callback/未知原生消息
   拒绝；原 Getter/Proxy/toJSON 零执行，政策自由字段 canary 不出站。
4. 原 input/历史/ToolReturn/aggregate/metadata/ledger 在最后 callback 改变均 0bytes；
   未登记工具结果不能借同名 model Attempt，cached updates 不补 writer。
5. V2 cancellation 再组合后仍在原 call/default/binding signal 取消时真正 finally/drain；
   held provider/worker、first pull 前取消、停止消费、undefined failure与unknown隔离。
6. 原 Main streams/SSE/derived/Shared/generic 行为、类型/lint/整库与真实 Electron，
   保原 5 秒门。源码票、功能门、性能门分别记录；本设计不开放 v1/全部 Event 类别。

## 三个实际 API 接缝的第一份精确提案（只读，尚未批准实施）

这部分是下一轮精确审核输入，不是上述总体方向票的自动扩展。Factory、Tools 和
Calls 的现有私表没有这里的新能力；原 native streamEvents 拒绝保持。下面的 API
名称是建议，不接受同名 caller 对象、函数地址或公共 callback 注册代替私来源。

### 1. 原 Factory method、controlled shell 与真正 final signal

拟由 `native-agent-factory.ts` 的实际 `register(agent)` 同时固定原
ReactAgent.streamEvents own/prototype descriptor、method 与 receiver，及该原 graph
的 streamEvents / _streamEventsV2 继承路径。派生对象在原 withConfig 真构造前后
沿原 parent 私记录核其原路径，不能从一个后来可替换的 getter 或当前方法重新建来源。
新增 optional 私字段须始终 own undefined，不能通过 Object.prototype 补默认值。

实际下层 Pregel.streamEvents 在调用 `_streamEventsV2` 前先运行 combineCallbacks；
仅靠 ALS 与它收到的 merged signal 无法区分 callback.copy 内重入真实 driver。
因此须安装模块自造的 compiled event shell，而非只覆盖最后 driver 后接受任意
merged config。shell 在其 private operation 已 busy 后执行原 Pregel 的 signal /
callback 合并正文；所有可观察 callback 合并完成后，才将该 operation 的私阶段
推进到 driver，并直接调用固定模块 driver 地址。opaque operation 不放进 options、
config、callback 数组或 callback manager 的 receiver，也不穿原 ensureConfig。

建议只读接口与 mint 点：

```ts
// Factory 内部实际 agent 私表选原地址，安装实现只能是模块自造的 shell / driver。
installFunctionConversationNativeEventsV2(agent, observerInstallation): EventsInstallation
// Host 私 successful graph-installation + exact Factory installation 双 join。
readFunctionConversationNativeMainEventsDomain(host, graph, runtime, installation): MainEventsDomain
// 只由 controlled driver 的原 controller / combined signal 创建点 mint；不接受 signal setter。
createFunctionConversationNativeEventSource(operation, domain, finalStreamSignal): EventsSource
```

上述 installation 与 domain 只能由各自词法私表产生；第一个接口不得接受 driver
函数参数，第二个未知 Host / wrong runtime / foreign graph 直接拒绝。domain 自带
原 Host / runtime / graph 的固定 full 与纯尾闭包，但没有调用者登记 guard 的入口。
安装完整 observer、getState 和原 Node / Tools 后才 publish 实际 installation；
失败或半安装永久失败，不把当前 false flags 当合法原安装。这里不接 Shared ready。

外层 native invocation 保首输入 / cut / original runtime 与一次原 retention。调用
真正 Factory 私 method / receiver 一次，仍由它合并原 ReactAgent defaults 一次。
shell 建立原 Pregel controller 与 S3；driver 原 ensureConfig / callback 三分支后，
在原 C4 + S3 合成真正 S4 的位置自产 Events Source 并建立本次 Lifetime。紧接着
固定 observed graph.stream 以 exact S4 启动一次；下游 Pregel.stream 的 S5 由真正
Node Work / runtime 双私关系核，不按 aborted 状态把 S4/S5 认成同一对象。

opening operation 不是消息来源。首 driver 的原 ensureConfig / CallbackManager.copy
也处在 busy / failed latch 内；caught 重入永久失败，不能另启动原 stream。driver
不经 late super.streamEvents 或 public _streamEventsV2 调度。unknown direct driver
调用没有 exact operation / domain，必须在 Source 和 SDK 启动前拒绝。

必须先跑未包装 SDK 对照，确认两层 callback 合并、copy/addHandler 次数、signal
取消理由与顺序、filters、首 input / end 删除、defaults 与原 iterator finally。
这会复制一个确定版本的框架驱动正文，需要报告这种内部实现选择；对照不等时
不得删除原 callbacks、覆盖 provider 默认 metadata 或把 observed signal 当授权。

### 2. Tools request-only 来源及 raw failure 的真实执行边界

`function-conversation-native-tools.ts` 的原 wrapper 在调用 original runTool 前已有
真正 token / Work / rawCall / config / name / args / runtime / policy。只在完成其原
policy 与 full guard 后，以模块私 AsyncLocalStorage 包住同 original runTool 的一次
Reflect.apply。建议新增如下 reader；它不按 run_id 查找，也不接受 event 注册：

```ts
currentFunctionConversationNativeToolEventRequest(expectedRuntime, expectedEventsSource): ToolEventRequest
readFunctionConversationNativeToolEventRequest(token, expectedRuntime, expectedEventsSource): ToolEventRequestView
```

current 只返回原 wrapper 自产 token。view 首 full 前有 reading / failed latch，固定
原 Work、实际 ledger / bound / receiver、call / config 原地址与完整 args typed digest、
原 task / read / thread / namespace / signal、原政策 certificate、首 Events Source。
每次 full 保原 Work / runtime / policy 回调；末纯尾固定原记录、所有容器 topology、
完整 args 与 policy / signals / cut。unknown / foreign / clone 先无 Source 地拒绝。
即使此 request view 通过，也不授 ToolReturn、Slot、append、ACK 或消息 class 权限。

原 StructuredTool 先 schema parse 再 handleToolStart，event.data.input 是 tracer 的
原输入形状，而非当然等于 rawCall.args。display adapter 必须记录原实际 callback
传来的完整 typed input，并与上述 request / Work / Source 同时 join；不能 JSON
重算或同 name / id 为它造来源。原生 output 仍须独立 ToolReturn / own Entry。

特别是失败来源尚未闭合：本机 ToolNode.runTool 的 #handleError 会在 original
runTool 返回前把真正 Error 变成 ToolMessage；EventStreamCallbackHandler 的
onToolError.data.error 又已经是 BaseTracer.stringifyError 的结果。因此仅在外层
runTool catch 保存 error 只能覆盖原未处理 reject，不能认证全部 handled tool error。
public EventHandler.handleToolError / 相同 run_id / ALS 存在也不能 mint raw failure。

需要下一份独立的 actual selected-tool 执行合同，候选为仅 Events 分支的自造
ToolNode 执行器：沿原真实 bound.tools / wrapToolCall 选择 actual requestTool，固定
原 selected invoke method / receiver 后 Reflect.apply 一次；其真正 Promise 成功 / 失败
结算点自产 outcome token，失败独立 failed + firstReason（含 undefined / null），
然后执行与原 ToolNode 完全相同的 middleware / parsing / handleToolErrors 分支。
它不能用 caller 提供的 inspector、callback 或后来的 invoke getter。generic / SSE
原 runTool 路径保持；动态 middleware tool 必须有真正 selection 记录，不能借静态
同名工具。由于原 #handleError 为私方法，此选择会需要一段确定版本的 SDK 正文
适配，不是现有 wrapper 的零成本 reader，必须先精确方案两审与 SDK golden。

替代候选是由实际静态 tool factory 一次安装固定 invoke wrapper，私记录真正
selected tool / invoke / receiver 的 outcome。它必须证明多 graph 共用工具、派生
工具与普通调用行为，且不能靠晚 pre/post method 检查抵挡临时替换后恢复。没有
这种完整执行证据前，handled error 仍明确未适配，不能把 on_tool_error 裸字符串
通过 regex 或假 fixed enum 接到完整事件权限。本稿尚未选择或批准这两个实现。

真正 outcome token 只供 event 诊断显示副本，与 request 同 source / Work / policy
联合认证；公开错误始终固定安全码。真实 native 返回消息仍需原 ToolReturn 与
整个 Host canonical 23 / ledger A-B。End / Error 的 callback 本身只登记 pending，
不能等 outcome / Keeper 而阻止 original runTool 返回。

### 3. Calls 的首 Events Source pin 与实际 Attempt / aggregate

拟在 `function-conversation-native-calls.ts` 的原 handleChatModelStart 入口，和现有
currentSseSource 同一时点（首 owner.assertCall 回调前），只读当前 genuine Events
Source。两者是不同私品牌；一份 actual source 不同时表现为 SSE 与 Event。
原 Attempt 增加始终 own 的 eventsSource 字段，保 SSE / no Source 原路径不变。
原 model-start 成功后 mint 的 actual Attempt 与这个首地址绑定，不得后来在 End /
chunk / 同 run_id 事件中换绑或为无 Source 的旧 Attempt 补来源。

建议新增独立 reader，而非扩大现有 SSE reader 接受任意 source：

```ts
readFunctionNativeModelEventPartial(actualChunk, runtime, eventsSource): EventPartialView
readFunctionNativeModelEventReturn(actualAggregate, runtime, eventsSource): EventReturnView
```

两个 reader 只沿 Calls 私 chunks / results 的实际地址查选唯一 actual Attempt，核
同 Call / runtime / Work task / read / namespace / policy / original signal 和首 Source；
不能从 event.run_id 或 event.metadata 构造 Attempt。raw chunk 来自原 callback 的
fields.chunk.message；没有实际 chunk 时 EventHandler 自造的新 AIMessageChunk 不
获权限。aggregate 来自原 handleLLMEnd.generations 的真正 message 地址；两 chunk
累计的新对象不能借首 chunk 地址。首完整 raw digest 仍在真正 Keeper 前固定。

原 onLLMEnd 发生在 Node finalize / Keeper 前，EventHandler 与 Calls 的回调次序
也不应被假设为认证来源。队列可先保存未认证 typed event，但只在真正 Calls 已
登记 outcome 后选择上述私 reader；不能把这个早队列值作为初 baseline 或权限。
成功 End 继续显式 pending，需同 actual Slot / Name proof、真实 Keeper ACK、own
Entry / drain 与 original iterator 成功 writer，才准备 safe event。原 256 reservation /
4 Worker、first cut、失败 sticky / unknown quarantine 与完整 raw returned 尾均保。

本次首 API 稿不扩大 completed Chunk ModelCurrent，不把 EventSource 传入 SSE
current reader，不删除原 sealed-live 阴性，也不改变 ordinary/no Source Calls 行为。
Factory final-signal seam、Tools selected-outcome seam和这些首 pin / reader 需分别
完成准确两审、SOURCE 审与真正框架对照后，才有开放 EventsV2 的生产入口。

## actual selected invoke 的结算基础窗（精确提案，未获实施票）

本节收缩第二接缝：不复制 ToolNode 全部 runTool 或它的私 `#handleError`，先研究与
已落 SDK stream foundation 同样可重现的版本锁词法增量。当前原版代码的准确顺序是：

- `langchain/dist/agents/nodes/ToolNode.js` 的 baseHandler 先选 request.tool 或原
  tools 中的工具，构造原 toolCall/config，再 await `invokableTool.invoke`。
- 这个 await 成功以后才调用 ToolMessage.isInstance/isCommand、构造 ToolMessage。
  失败以后才检查 ToolInputParsingException 并可能包装 ToolInvocationError；最外层
  middleware/no-middleware 两个 catch 再调用原私 `#handleError`。
- `@langchain/core/dist/tools/index.js` 的 StructuredTool.call 在 invoke reject
  之前已 await 原 runManager.handleToolError。生成器 chunk 的 callback 失败也调用
  handleToolError，但原 invoke 可以最后成功。因此 selected reject 和 error event
  不等价，更不能把 event.data.error 的 tracer 字符串说成原异常。

第一基础窗只认证原 selected invoke 的执行和真实 await 结算，不公开 Events 帧，也
不授 ToolReturn/append/ACK/23 资格。原 ToolNode 的 selection、middleware、参数、
错误包装、处理器与返回值仍执行原正文；普通和 SSE 的 runTool 路径完全原样。

### 原 invoke 基准必须早于未知构造与 full callback

实际 `runtime.ts` 的 wrapToolErrors 会合法地给工具设置 own invoke，保 HookHalt、
FailureFuse 和 WorkflowStructuredFatal，同时可能把普通拒绝转为字符串。因此不能
只接受 StructuredTool.prototype.invoke，也不能在 runTool 的晚 selection 点把当前
invoke 重新登记成可信原地址。基础表必须有两个具体来源：

1. NativeAgentFactory 的真实 createAgent 入口，在 Reflect.apply 原 constructor
   之前，descriptor-only 固定本次 options.tools 的实际 dense 成员、各 tool 的
   invoke fn/receiver 与完整 own/inherited path/proto/flags。这个函数正是调用者在
   构造前声明的执行器，包含真实 Runtime 自造的 own wrapper；它不是按名字搜索或
   接受 caller 注册 inspector。后续 constructor 合法转换工具的关系，必须由 SDK
   实际 ToolNode constructor / createAgent 内部私表记录真实转换与成员地址，不能
   用相同 name/JSON 补关系。未经转换的工具必须一直是同一原成员。
2. Middleware 的 request.tool 覆盖不借静态同名成员。动态工具要有其实际构造工厂
   的私 provenance：例如固定 Core 原 constructor/module method 的自造实例表，或
   本工程真实 Runtime wrapper 的词法自造表。这个新增来源另需准确两审；首基础
   窗可以观察动态 override 的 selection，却不能以晚 method snapshot mint 原地址。

晚 getter、Proxy、method 替换或路径 flags 变化均不能被刷新掉。真实已有 record
失配是 failed；unknown/dynamic 没有原 record 是未适配，不能转为已认证 outcome。
工具 `.invoke` 内部的 `this.call`、`_call`、func/schema/callback 仍可能动态执行。
基础票只证明调用了已声明原 invoke，同原 receiver 一次，不能宣称这些内层 callee
全固定，也不能声称返回的原生消息已经授权。后面的 ToolReturn/Host 原门不缩减。

### SDK 自造 operation 与每次实际 selected invocation

建议新增版本锁 SDK subpath `langchain/native-tool-invoke-origin`。名字与签名仍为
提案；它必须像 stream foundation 一样以官方包 preimage/postimage、ESM/CJS/types
与可复现安装器锁住，不能改 node_modules 作为唯一交付物。

```ts
createNativeToolInvokeOperation(actualAgent, actualToolNode, rawCall, config, state)
executeNativeToolInvokeOperation(operation) // 固定原 runTool，同 receiver/args 一次
readNativeToolInvokeSelection(selection, operation) // 数据事实，不运行 caller
readNativeToolInvokeOutcome(outcome, selection, operation) // 数据事实，不授消息权限
```

SDK 的原 runTool fn 在 class/module evaluation 后、首 constructor callback 前固定。
actual instance/agent/ToolNode 的构造关系由 SDK 自身私表自产。App 的真实 Tools
wrapper 已有 request token、原 Work/runtime/call/config/policy 与首 Events Source；
只在该 wrapper 原 full/policy 接点成功后自造 operation 并先把 exact operation 与
原 request 私表 join，再受控执行。SDK operation 单独存在不构成 App Source。
无 current Work/本次 Source 或错 runtime 的 caller 不取得 event request。

受控 executor 在调用原 runTool 前同步登记私 request，原 runTool 首词法语句 exact
consume，随后 delete request；operation 只保存在原函数局部变量。baseHandler 闭包
直接闭住这个原局部 operation，不从公共 config、callback receiver、run_id、ALS
或可替换属性找回。原 requestTool 的实际选择发生后，先核原地址基准，再执行原
参数构造顺序；其中 mergeAbortSignals 等未知 callee 后须复核已 pin 的 request/
selection/data facts，再 Reflect.apply 已固定 fn 同 tool receiver 一次。不能靠
invoke 前后 method 看起来相等，抵挡临时 fake→restore。

每次 baseHandler 调用各自生成 private selection token，包含实际 request/tool/
toolCall、SDK 构造的 invokeInput/invokeConfig、fn/receiver、原 operation 与序号。
middleware retry/并行调用原 handler 两次就保存两份真实 selection，不能折叠成
原 runTool 的一个结果。原工具缺失的 graceful ToolMessage 不伪造 invoke selection。
selection reading/failed 在首未知 invoke 之前占据，原异常 caught reentry 永久失败。

结算正文只包住实际 Reflect.apply + 原 await：成功保存 `status="fulfilled"` 与原
await 后 value 地址；失败保存 `status="rejected"` 与原 reason，随后 throw 同一个
reason，让原 parsing/#handleError 继续。同步 throw 与 thenable/Promise reject
都保原 await 语义。undefined/null 是合法失败理由，不能用 truthy 判断 status，
也不读取 reason.message/stack/toString 来决定分类或形成安全码。

outcome token 仅在对应 selection 第一次实际 settle 后自产，private facts 固定完整
执行关系，不能因 callback 所说“end/error”补登记。后续 parser/handler 又发生错误
是原 runTool 的另一结算事实，不覆盖这份 invoke outcome。Runtime own invoke 把
内层错误变为字符串时，这个原 wrapper 的 outcome 应如实为 fulfilled；不得挖掘
一个后来字符串反向制造 raw reject。

### 原始错误 callback 是独立未闭合接缝

对确实 rejected 的 selection，outcome 提供真正 reason 来源，可以与本次真实
request/Work/Source/policy联合形成固定 safe failure diagnostic；它本身不能认证
任意 public handleToolError 调用，也不能用 event 字符串与 reason 相等来认证。
工具或 middleware 可以主动调用 public callback；仅在 invoke 活跃期间的 ALS
相同、run_id 相同或 handler 相同并不证明 callback 来自原 Core catch。

若要完整开放 on_tool_error，必须追加 Core 两个准确 catch 的词法来源：`_call`
失败 catch，以及 consumeAsyncGenerator 中 handleToolEvent 失败 catch。原 runManager
地址、原 reason 与 actual selected invocation 必须由真实词法接点 pin，真实 callback
交付也须有受控原 dispatch 关系；尤其 stringifyError 可调用未知 toString，不能
在该未知 callee 期间让嵌套 fake callback抢“第一事件”能力。此准确 API 尚未设计完，
本节不授权它。stream callback error 后 invoke 成功必须有独立事实，不能删此事件
求绿；schema parse 失败在 ToolStart 前亦不得补造一个从未发生的 start/error。

### 真结算、背压和资源终态

原 End/Error callback 只登记 pending，不 await invoke outcome/ToolReturn/Keeper。
SDK/App 记录每个已开始 selection 的真实 Promise，直到它实际 settle 才移出 pending。
middleware 在 outer runTool 已返回时留下未 awaited baseHandler，不表示其效果或
callback 已结束；不能因 outer Promise/shell 已结算就释放 Work、Source、Host或 Saver。
closing 后的新 selection 须在执行工具前拒绝，已开始的全部 selected Promise、原
ToolNode/Node finally 与 Host/Worker drain 都逐项观察，unknown 继续原 quarantine。
这项 native retained-work 行为和取消时机需独立 golden，不称与未等待行为完全透明。

Event adapter 在每次公开交付前仍先完成所有 request/selection/outcome/Work/policy
full，原消息走独立 ToolReturn/Host own Entry 整批 23/ledger A-B。B 后只原 facts、
args/config/outcome 完整数据与原 Source/信号/cut 的纯尾，fixed safe code 不含 raw
error。任何 event outcome/callback 包装都不新增 Tool、append 或 ACK 权限。

### 基础窗真实对照与实施顺序

先做无 App 权限的 SDK foundation/goldens，原 runTool generic 不改：静态工具正常/
同步 throw/reject undefined/null、Runtime own invoke handle/rethrow、schema parse
早失败、handleToolErrors true/false/function、GraphInterrupt与真实abort、真实
middleware replace/retry/parallel/dynamic、生成器 callbackerror后成功。逐项比较
原 value/reason identity、callback顺序/次数、实际 effect count、原 ToolMessage全codec
与真正 drain，不过滤差异字段或取消时机。

其次接 App request-only 与 exact static selection 私 join，不公开 event frames；
真实 Work/Source/runtime/cloned request/foreign operation/getter/fake→restore与首
reentry阴性，所有未知输入保持0新权限。动态工具 origin 与 Core raw callback各自
另窗两审。完成完整来源后才接 End pending/dispatcher/纯LC codec与 SSE encoder，
原 Handler error 字符串不能作为临时兼容 fallback。本提案未改变 native EventsV2
当前拒绝状态，Root 和 Official 精确两票前不编写生产代码。
