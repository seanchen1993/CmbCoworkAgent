# 已完成模型尝试的 SSE partial 省略证明

当前 Root 实际 `NEW18 + old95` 为 112 PASS / 1 RED，日志是
`output/stage23-native-sse-diagnostic-second.log`。唯一 RED 是 OFF 的真实 streaming
partial 在 metadata diagnostic await 期间完成，同 Attempt 已 seal，严格 live reader
因而拒绝。namespace getter、固定公开错误及旧 95 已 PASS。本文已获 Root 第一与
Official 独立第二 DESIGN PASS，Root 已授下述窄生产窗口。当前七个生产文件的第一稿
接口已闭合，暂冻供类型快照与独立源码审；新实际回归尚待 Root 串行运行。不把这个
功能缺口写成框架限制，也不放宽现有 live reader。

## 两个实际时点

第一种是原 `_streamIterator.next` 返回真实 chunk 帧时，同 Attempt 已 completed、
returned 且 seal；还没有调用 Host.message 或 mint live partial wire。第二种是已经
得到 live wire / diagnostic receipt，在诊断 await 后、encoder 第一次重新读取前同
Attempt 完成。两者都只能通过明确完成候选进入新协议，不能 catch live-reader 的
任意错误后改为忽略，也不能只检查 `sealed`、UUID 或 provider ID。

若原完整 source callback 在一次同步 live validation 内改变 Attempt，现有 strict
post-tail 仍失败。该次失败不升级成候选。新协议只在上述显式异步边界、进入 strict
reader **之前**纯选择原完成状态；完整 source / policy / raw / metadata 失败仍 sticky。

## 原源码与等待约束

`function-conversation-native-calls.ts` 的 `chunks` 将真正 callback message 地址绑定
唯一实际 Attempt；`run` 才把 exact provider return 绑定到 `call.returned.attempt`。
`seal` 发生在原 flush / adoption 路径，不表示 Keeper ACK 或 writer 已完成。

`function-conversation-native-host.ts` 的 finalized slot 目前先记录 ACK safe Base，
finally 再等待真 Keeper drain 和完整 finalized data tail。只有这个完整终态成功后
才能登记下面的 ACK receipt，不能利用较早的 finalized 地址。

`function-conversation-native-lifetime.ts` 的 completion record 在 Node finalizer 后、
原 writers 前登记。它本身不是 writer receipt。真实成功证据须另从原 iterator 的
`updates` 帧中取得 same safe object / node / Source / original slot 的联合关系。
本机 `pregel/loop.js` 的 `_outputWrites` 从真实 task writes 产生 updates；
`pregel/index.js` 1066 启动真实 runLoop，1070 起读取 stream，finally 等 runLoop。

所以当前 partial prepare 不能原地等待后续 writer update：该 update 需要消费者的
下一次原 iterator.next 才能观察。新协议分开 pending disposition 与成功 OMIT，
前者仅阻止当前 partial 出站并继续原有限 pull，后者必须等完整 writer 证据。

## 最小私有接口

以下名字是拟定 API，品牌与所有记录都在实际工厂 WeakMap 中。调用者不能注册 raw
对象、assert callback、policy 或 alreadyCompleted 布尔。

```ts
interface FunctionNativeCompletedPartialCandidate { readonly privateBrand: true }
interface FunctionNativeSseDeferredPartial { readonly privateBrand: true }
interface FunctionNativeSsePartialOmission { readonly privateBrand: true }

// Calls 的纯选择只认原 chunks/attempts/calls/byTask 记录。undefined 仅表示真实 live
// partial 或非本 partial；failed/ambiguous/foreign 状态明确抛错。
calls.selectCompletedPartial(message, originalSource):
  FunctionNativeCompletedPartialCandidate | undefined

// exact candidate + actual Host runtime/Source；full 保留原 assertCall 的所有 callbacks。
readCompletedPartial(candidate, runtime, originalSource): {
  readonly call: FunctionNativeModelCall
  readonly attempt: FunctionNativeModelAttempt
  readonly chunk: object
  readonly returnedMessage: BaseMessage
  readonly policy: OriginalPolicyAdmission
  readonly signal: AbortSignal
  assertCurrent(): void
  assertDataCurrent(): void
}

// 明确 outcome；pending 不是 protected metadata receipt，也不是成功的省略许可。
type SseFramePreparation =
  | { kind: "protected"; receipt: FunctionNativeProtectedDiagnostic }
  | { kind: "deferred-partial"; pending: FunctionNativeSseDeferredPartial }

// 保原 Protected opaque receipt 契约和真实 override / await 驱动。
host.prepareSseDiagnostic(token): Promise<FunctionNativeProtectedDiagnostic>
// union 只位于 wrapper 私有 prepareFrame，不授公开 DTO。
prepareFrameInsideWrapper(frame): Promise<SseFramePreparation>
host.deferCompletedSsePartial(token, protectedReceipt?, exactProjectedTuple?):
  FunctionNativeSseDeferredPartial | undefined

// Lifetime 内部闭包，仅在截获 original iterator.next 的真实返回地址时调用。
// 不导出、不挂在 lifetime 返回对象上，不接受 caller update 注册或复传真 frame。
observeSuccessfulWriterUpdateInsideOriginalStep(actualFrame): void

// same private Source / Attempt / ACK / writer，完成 original canonical A/B + ledger B。
host.confirmSsePartialOmissions(originalSource, finished?):
  readonly FunctionNativeSsePartialOmission[]
readSsePartialOmission(omission, originalSource): void
```

接口表达中的 privateBrand 只是文档记号，生产 symbol 不导出，JSON/clone 不可 lookup。
`protected` 路径继续使用原 live reader；普通 strict read API 保留原行为。encoder 不
从 `undefined`、空 DTO 或异常推断省略。wrapper 只消费明确 pending / omission 品牌。

Calls candidate 必须同时满足原 exact chunk、唯一原 Attempt、原 call/byTask/attempts
关系、`status === completed`、`sealed === true` 和
`call.returned.attempt === attempt`。returnedMessage 必须是该实际 Attempt 的原
results 地址。失败尝试、重试旧 task、只有 LLMEnd / completed flag、其它 Attempt
或与原 Source 不同全部拒绝。首 full callback 前设置 reading/failed latch，caught
重入毒化外层；完整原 policy/runtime/task/read/namespace/thread/signal 校验保留。

Host 另外按 opaque Attempt 记录自己的 ACK：原 slot / runtime / returnedMessage /
safe Base / row / policy / first cut，且是真 Keeper ACK、完整 drain 和原纯 finalized
seal 成功后登记。只原 model branch 可写，不能通过公开 completed 回调、输入消息、
Tool side 或 historical register 增加这个资格。实际 AgentNode step-limit fallback
可以是不同原 node output，但同 Attempt 的 returned 地址仍固定；ACK 必须绑定那个
真实 slot 和最后写入的 safe Base，不能以 fallback 文本猜关系。

Lifetime writer witness 在 observed 原 iterator step 中、route/filter 之前读取原
`updates` 地址。descriptor-only 解实际四种 shape，逐已登记 completion 的 exact
safe Base 核 same node / graph / Source / live slot / original completion address；
只原成功 writer update 可以把该 completion 置 witnessed。cache 重放、相同 ID 的
另一个对象、caller 调 lifetime 方法、history/intake 或补帧自己的 tuple 不可 mint。
内部仍只补 updates，保原 subgraphs，不展开子图或改变外部 mode/default/metadata。

## 原 typed 数据与明确状态转换

第一时点未取得 live token时，新增 completed-candidate-only 的 typed digest 路径
复用原 exact AIMessageChunk descriptor / Proxy / 1M 核心，但只产生全 raw digest
和纯 assertDataCurrent，不构造输出类、不调用 raw serializer、不授 partial display
或 completed capture 权限。它接受的唯一输入是 Calls candidate，不能传 raw 对象。
第二时点则保存原已成功 typed wire 的 raw / safe / wire / metadata 摘要与地址；
新增 completion-only 尾另核这些数据，不修改原 live reader 的 sealed 拒绝。

diagnostic 在每个原同步 phase 入口先显式选择完成候选。若候选已成立，不再调用
strict live proof，也不 mint 可出站 metadata DTO。已经启动的真实 diagnostic Worker
仍须 exit / actual release；其全部 callbacks、政策/metadata/raw 拒绝都保留。OFF
仍是真 never-started，不能拿 pending 伪造 exit。成功终态可以返回 deferred 品牌，
failed/null/undefined 或 unknown release 保持原失败与 quarantine，不能变 deferred。

接口收缩增量已获 Root 第一与 Official 第二 DESIGN PASS。第一实现窗先闭正常 OFF
partial 的两个真实异步时点：OFF 的诊断 phases 无 Worker 异步等待，strict 同步
source callback 内发生 seal 仍 sticky 拒；wrapper 在 prepare await 后、strict read前
重新明确选择候选。强保护 ON 原 route 对 partial 为零，仍保持该行为。如果后续
独立 ON diagnostic Helper 异步 phase 自身等到 seal，须另落显式 candidate phase，
不能 catch 它的 strict failure，也不把本 OFF 窗口称为所有 completion 处理完成。

post-await completion-only diagnostic checker只接受真 released 且未 failed 的原
Protected receipt / token / metadata / same completed candidate；完整 source/policy/meta
检查保留，但不返回 metadata DTO、不改普通 strict read的sealed拒绝。

已经拿到 protected receipt 的第二时点在 await 后、strict reader 之前同样显式
检查 candidate。只有 token / receipt / original metadata / actual Calls Attempt 全部
联合通过才转 pending；receipt clone、foreign、已失败 diagnostic 不进入转换。
任何阶段一旦发生 genuine validation failure，不再重新选候选复活。

## 有界 pull、顺序与完成核验

每 Source 保留最多 256 个未结算的 **实际 Attempt** pending 小记录，不建立新 Worker
池或 admission 池。每记录固定原 token、原候选、首 typed 摘要、policy/cut 和实际
地址；不复制或保存全 partial 正文列表。同 Attempt 的后续已排队 chunk 逐帧做真实
typed / source / metadata 认证，随后只并入该 pending 的计数；不刷新首基线，不把
另一帧变成新的返回对象。每帧仍保持原 1M budget，Source 总计最多 1M 个 pending
partial frame 认证；满额明确 adapter unavailable，并走真实清理，不丢其它帧继续。
这是本 adapter 的显式有界 admission，不是框架不能流式运行的结论。

没有 raw partial bytes、protected metadata 或成功 OMIT 在 pending 阶段出站。wrapper
继续原 iterator.next；普通已独立认证的其它输出仍按原顺序流出，未请求的 updates
保持私有。多 modes / subgraphs 的四种 shape 不变，未解决 partial 不生成占位事件，
没有额外 raw buffer 或重排完成帧。其它安全输出已发布而最终 writer 失败时，stream
仍以固定安全错误结束，不能声称该 pending 已完成省略。

看到 matching writer witness 后，在当前 Source ALS 先完整重验 Calls candidate、
原 diagnostic token/raw/meta、genuine policy/runtime/Host 原图关系和 ACK/drain；
然后 own Projection Entry 执行完整 raw23 / Store / presentation / strict partition
A/B + ledger B。所有真实 callbacks 先于 B；B 后只能 pure raw/native/meta/namespace/
containers/policy/maps/signal/cut/ticket 状态尾，再原子标记 OMIT。原固定 cut 取各相关
first cut 的最早值，每次 read / pull 不续期。任何 closed/cancel/epoch/receipt/ledger
变化失败；Source 结束时仍有 pending、missing update、failed writer 或 hidden writer
没有可证明 update 都拒绝，不能仅 ACK 或 CP 内容补猜。其它 writer 接点可另审补齐。

同 Source completion frame仍由原 updates→exact safe completion ledger生成一次，
natural/generated共原 dedup；OMIT 不新发完成消息，不跑 Hook/Keeper/writer/model。
取消先切本 invocation signal，再启动原 iterator true finally、Keeper 与 diagnostic
真实 drain全部观察，未解决 pending 永久失败，不关闭 global Host或恢复旧 Source。

## 源码窗口与门禁

已授权窄改 Calls 的 candidate/read 私表、Host 原 model ACK终态与 diagnostic disposition、
lifetime 原 updates observer/writer witness、invocation pending 路由与真实完成检查、
diagnostic outcome 和 encoder 显式省略入口。typed capture 只新增 candidate-only raw
digest proof，不改 ordinary/completed/partial live 权限。生产窗口需 Root 单独授予；
本文不授权其它 Owner 区。第一稿冻结范围是 `function-conversation-native-calls.ts`、
`native-message-capture.ts`、`partial-native-message-capture.ts`、
`function-conversation-native-lifetime.ts`、`native-sse-diagnostic.ts`、Host 的 ACK/diagnostic
区与 invocation 的私有 pending 路由；不扩 Host 的 derived、model-current 或各 side
factory 区。原严格 reader 与普通 API 保留。本文的修前 112/113 证据不作为本稿验收。

真实回归保留当前唯一 RED 的 safe completion=1/provider1/row1/真CP 全断言，另补
首次 next 前已 seal、多个排队 partial、same ID 两 Attempt、retry失败、ACK但writer失败、
missing update、foreign Source/Entry、epoch/cut/cancel、最后 guard 改 raw/meta/ledger、
null/undefined failure不转候选、clone与caught reentry，以及容量/原shape/subgraphs
顺序/实际 truefinally。原 113、Message driver与原 live sealed阴性全部保留，默认5秒
不改。两设计票、两源码票和 Root 实际门分别记录，不沿用旧103作为本协议证据。

## ACK 原完整返回数据的窄追加提案（两设计票通过，源码待审）

第一稿分别固定 partial callback 的全 raw digest、已复制的 live safe/wire/meta、以及
ACK safe Entry 的完整 native/23seal。它的 ACK map 对 provider `returnedMessage` 主要
固定地址；多个 chunk 聚合出的原返回消息可与那个 callback chunk 是不同对象。
必须另固定这个真正返回地址的完整原 typed 数据，不能用地址相同或 safe Entry 的
digest 代替。Root 第一与 Official 第二 DESIGN PASS 已通过并授权该窄段；实现与
实际门禁另记，不扩 completed Chunk ModelCurrent。

最小接口在 Calls 原工厂的 actual Attempt mint 私表中增加 data-only 返回来源：

```ts
readFunctionNativeCompletedModelReturn(originalAttempt, actualRuntime, originalSource): {
  readonly message: BaseMessage
  readonly uuid: string
  assertCurrent(): void
  assertDataCurrent(): void
}
captureNativeCompletedModelReturnData(originalAttempt, actualRuntime, originalSource, bounded): {
  readonly originalDigest: string
  assertDataCurrent(): void
}
```

原 Attempt symbol/WeakMap 才可 lookup。当前真正 `status===completed`、
`call.returned.attempt===attempt`、results 唯一 exact message、原 calls/byTask/task/read/ns/
runtime/Source/signal 全关系必须齐；未 seal 可固定这个只读 raw 基线，仍不能创建
partial completion 候选。full 仍原 assertCall；首任何 full callback 前 reading/failed
占用，caught 重入永久失败。纯尾重查完整私表/地址/原配置/原 Source 和 signal intrinsic。
既有 partial candidate 另外继续要求 sealed，普通/completed/live 三个 capture 权限不变。

typed 核心只接受这个 genuine Attempt 来源，拒 raw 参数。完整 AIMessage 走既有
known full 原 descriptor 核心；真正聚合 AIMessageChunk 只走 internal completed raw
descriptor 核心。两者都只返回 digest 和 pure assertion，不构造、parse、serialize，
不返回 snapshot 或新安全消息，不调用 readSlot/full Source。拒 Proxy/getter/函数、
suppression 和展开预算，所有字符串完整 UTF16 字节保持原算法。它不是 completed
capture 或 ModelCurrent 的替代来源。

Host 在原 model finalizer 首次取得真 `calls.returned` 后、Keeper 工作前固定一次
returned 数据。若原 slot.message===returned.message，须与原 finalizer capture 的
originalDigest 严格一致；step-limit fallback 地址不同则分别保两份原基线，不猜文本。
ACK 的 Keeper/drain/finalized A/B 终态成功后，纯核这份 returned 基线才登记 ACK；
以后 confirm 的 full/source/policy callbacks 后、末 canonical B 之后仍纯重核该基线。
因此普通 provider 原返回数据在 diagnostic await/drain/最后 guard 中改变，OMIT
必须拒绝，不能拿未变的 safe clone 盖过变化。

真实回归使用两个真正 streaming chunks 的 aggregate 返回地址，证明它与首 callback
地址不同。在 diagnostic await 后只改变 aggregate 的 content/kwargs/tool_calls，
首 partial raw 和已 ACK safe Base 保原；要求 mutation 真成功、0 OMIT/0 bytes/provider1/
原已 committed row 保留，未修改的正向仍 completion1。不会手工 mint Attempt、clone
receipt 或读取 codec/JSON 后再赋予来源。

## 单 chunk 的原 AgentNode name 完成转换（方案，待两票）

第一 OMIT 实际门为 123 定义、120 PASS / 3 RED，保存于
`output/stage23-native-sse-omission-first.log`。其中两个 single-chunk 场景在
defer 前拒绝；第三个 subgraphs 场景是测试把 SSE event 的 namespace 错当成 data
外层数组，已经按原 `pregel/stream.js:245` 的合同窄修，实际复验另记。

原 `chat_models.js:199` 将首 chunk 自身作为 aggregate；只有后续 chunk 才 concat
成新的对象。原 `AgentNode.js:93–94` 在真正 model handler 返回后，执行
`aiMessage.name = this.name` 与 `aiMessage.lc_kwargs.name = this.name`。实际
`ReactAgent.js:88` 构造该 AgentNode，`159` 将同一对象作为 `model_request` 的
builder runnable。因此 node key `model_request` 不能当作实际 name：原
RunnableCallable 的 own name 是 `options.name ?? "model"`，这才是原赋值来源。

这个修改发生在首 partial typed 基线之后，却在真 NativeNode finalizer slot 之前。
当前 completion-only 摘要把它当成 raw mutation，导致合法单 chunk 不能转 pending。
方案只认证这两个确切字段的原 host 转换，不删除 name 的校验、不刷新正文基线。

Node 增加一个数据事实 reader，建议接口如下。它不是 display、target 或 ACK 权限：

```ts
captureFunctionConversationNativeNodeModelName(slot, actualRuntime): OpaqueModelName
readFunctionConversationNativeNodeModelName(proof): {
  readonly slot: FunctionConversationNativeNodeSlot
  readonly message: BaseMessage
  readonly config: Readonly<RunnableConfig>
  readonly name: string
  assertDataCurrent(): void
}
```

安装 actual known graph 的 model node 时，在任何 source callback 前固定原 builder
runnable===原 bound、bound prototype、own name 的 data descriptor/value/flags。
实际 name 必须是非空 string，不能由 caller 字符串、图 node 名或 metadata 给出。
每个原 structure 检查重核这些固定描述符。只有本模块既有 slots 私表中的真
`model_request` slot、原 Work runtime 与传入 actualRuntime 地址相同，才可 mint
opaque proof；clone/foreign/tools/不同 runtime 拒。proof 只绑定这个 slot 的原
message，不为 step-limit fallback 或同名其它对象补推关系。首 callback 前的
reading/failed latch 与既有 slot pure structure 都保留。

Host 原 model finalizer取得真实 `calls.returned` 与 slot 后，只有
`slot.message === returned.message`、exact AIMessageChunk 才记录此 proof；记录仍
按 original opaque Attempt 固定。Calls completion reader 纯核此 proof 对应 slot 的
task/read/namespace/thread 全事实与原 call 的固定事实一致，以及 runtime、Source、
unique results、returned address 和 completed/sealed 关系。matching config 只是
两个真私有来源的附加等值条件，不能单独 mint proof。defer 只从原 Host 记录取 proof。

首 partial typed capture另保存原 root/`lc_kwargs` name 的 own descriptor、原
lc_kwargs 地址/prototype 与完整 ordered own keys/flags。完成转换只允许：

1. 当前 root name 和 lc_kwargs.name 都是 own data string，值严格等原 bound.name。
2. 原已有 name 保持原 descriptor flags；原缺失 name 只允许普通 assignment 产生的
   enumerable/writable/configurable data 字段，位于原 keys 尾。root 与 kwargs 分别核。
3. 所有其它 root/kwargs key、prototype、descriptor flags与原完整基线一致。未知新字段、
   accessor、Proxy、删字段、换 kwargs 地址、改 flags 或错误 name 都拒且 getter 零。
4. 原 typed 核心在私有 copied raw 构造阶段，将这两个已认证 name 的值/缺失恢复为
   首基线；若原 kwargs 无 name，则不把后来镜像的 name 插入原 raw 的 key 顺序。
   全部其它字段沿原遍历顺序、完整 UTF16/结构/预算重新 hash，必须严格等首
   originalDigest。原对象不修改，不能靠删除 arbitrary field 放宽。

这份恢复只用于 completion-only 数据断言。原 live partial reader、普通 full helper、
completed helper、ModelCurrent 均不增加新权限；真实 raw 正文/calls/args/kwargs 中
其它值的变化仍拒。首 safe partial clone、wire 与 metadata 全摘要仍保持原值。
没有此 genuine proof 时，completion-only 继续严格原 full digest；two-chunk 首 partial
与 aggregate 不同对象，仍走原未改变基线路径，不允许拿 aggregate 的 name 掩盖 chunk。

原 returned raw ACK 基线在 host name 完成以后、Keeper 前固定完整摘要，不做 name
忽略；ACK 和 confirm 末 canonical/ledger B 以后照旧纯重捕完整 returned 数据。
所以任何后续 name 再变、正文改变、原 bound name 换代都拒，不能继承这一次转换。

真实门保留原唯一 positive completion1/provider1/row1/fullCP，与 writer fail
pending>0 / ACK已有 / OMIT0 / bytes0。新增原 name/kwargs 错值、descriptor getter、
bound name late mutation、同 UUID foreign slot，以及两 chunk aggregate仅正文/kwargs/
calls改变的阴性。默认 5 秒不改。该方案未实现、未以旧 120 PASS 宣称闭合。
