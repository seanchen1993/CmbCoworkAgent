# Main 原流式投影的完成 name 交接

2026-10-06 收缩：本文件的 writer/CAS/schema 仍仅研究，最终实施票暂 hold。现在优先
评审 `mods-session-append-native-main-partial-actor-name-design-2026-10-06.md` 的六文件
UI映射方案：在真实Work/Call来源下提前给 Main wire名字，保原raw及八facts/23自然同值，
不实施name补写/新receipt/schema/serializedtransport。下文保留已发现故障与候选证据。

本稿是 Root / Official 两个独立 DESIGN 审的精确申请，尚未实施。Root 独占 CPU；
不放宽 native projection 的八项 facts，不删除 name，不把未知 UI 行或 public callback
形状认成来源，不修改 Shared Return / History。

## 已确认的实际故障

真实 Electron 原入口中，Mods-off 第四次 provider 与紧接的 ID-less 第五次 provider
都在 `function-conversation-native-projection.ts:255` 的 `assertFacts` 失败。Root 的
隔离 SQLite 查询确认这两行是普通 assistant：name 为 NULL，provider source 是本地
fixture 原 source，occurrence 分别为 4 / 5，tool_call_id / status 为空，没有 canonical
stamp。此处不是 ID-less 首 input 捕获失败。

实际时序是：原 model callback chunk → Host partial typed 副本（稳定 uuid、原 provider
tuple）→ 原 Main IPC queue / flush 普通行；SDK `AgentNode.js:93–94` 在原 model await
完成后才给实际返回 AI 的 root.name 与 lc_kwargs.name 写入原 AgentNode.name；随后真正
NativeNode completed Slot → Host finalize → Adoption seal / flush(uuid) → baseline read。
parser 当前仅 Tool 保留 name，而早期 chunk 本身通常也没有最终 AgentNode name。因此
单改 parser 不会关闭本故障。

原 `assertFacts` 的 thread / uuid / role / provider source / occurrence / tool-call-id /
status / name 八项及后续完整 raw 23 字段、projection receipt、Store / ledger A/B 全保。

## 选择的最小行为

只为真正 Main 原流式 writer 已写的、未 marked 的 assistant 行补交完成 name。
保持原 body / reasoning / calls / timing / ordinal / provider 与其余所有原列，不用完整
snapshot 覆写正文，也不从 caller metadata / node 字符串取得 name。首 name 为 NULL
的普通 UI 映射只能过渡到同一次真实 model completed Slot 的已认证 name；已有正确 name
不更新，已有其他非 NULL name 明确拒绝。不存在旧行时保持原 insert 路径。

只有原 Main IPC private queue 已认证的 partial write 可以取得这次补交；没有原 writer
receipt 的普通同 uuid 行、clone wire、未知 frame、foreign runtime / Attempt 均拒绝。
该能力不是 Message / append / Source / ACK / receipt 权限；不会改变 live partial sealed
reader 的拒绝合同，不借 SSE token 给非 SSE 赋权。

## 精确私有来源与 API

### 1. 记录已经真实交给 Main 的 partial writer

`partial-native-message-capture.ts` 只在原 `projectFunctionConversationNativePartial` 实际
成功返回其 private wire 地址后，增加独立 private WeakMap（不扩 SSE 的 sseWires 表）。
record 固定原 wire / metadata、实际 partial token 的 runtime / Call / Attempt、稳定 uuid、
原 provider tuple 与生成副本的完整 typed digest。Calls 在原 partial token 私记录中固定
这几个原地址，新增的纯选择 seam 只供归档 writer；原 live read / full / sealed 判定不变。

Main `queueStreamTranscriptFromPayload` 仅能从上述 exact wire + metadata 两地址取得私有
view；parser / role / id / provider tuple 必须与 view 原事实一致。不能从 JSON / public id
补 receipt。只有原 queue / flush 真正成功落行，才在当前原 run 私表中登记 writer receipt。
receipt 固定该 actual queue owner、original flush closure、database / thread / incarnation /
lease / run、Call / Attempt / runtime 与原副本摘要。失败 / 未落行不登记。

归档 receipt 证明过去这次写入的来源，不能重新调用已 sealed 的 live partial reader；
其数据尾重核原 private wire 副本 digest、固定关系与原 run 生存事实。新的 completed
校验仍独立验证真正返回对象全量；不以归档证明原 chunk 现在获得完成或显示权限。

### 2. 真正 completed Slot 的 name 交接

Host 在原 finalize model 分支、完成 raw 全量 typed capture 与原 full guards 之后、
Keeper 首 captureProjection 前，自产 opaque
`FunctionConversationNativeModelProjectionCompletion`。record 只能由该词法路径建立，
不提供 caller registration 或 callback inspector。

它固定成功安装的本 graph / Host / runtime、actual completed Slot / Work、Calls 本次
returned Attempt / Call / task / read / namespace / provider / uuid、原 raw 返回地址与
已经选定的完整原 digest、genuine policy certificate / signals / absolute cut，以及
原 `input.flush` 函数地址。name 来自 existing private Node model-name proof：真实 builder
runnable === installed original bound，原 name own data / prototype / flags 保持；Slot 实际
runtime 与本 Host runtime 相同。真正 raw root.name 与同 lc_kwargs.name 都严格等该 name。

这里不按字符串 model_request、metadata.name 或同 UUID 猜关系；聚合返回对象可不同于
早期 chunk，但必须是本 Attempt 真正 returned 原地址。无真实 model Attempt、step-limit
替代消息、foreign graph / runtime / Work / Slot 不取得本 token，保持原路径。

新增私 reader 的具体合同：

```ts
readFunctionConversationNativeModelProjectionCompletion(token, originalFlush)
// frozen { runtime, call, attempt, uuid, providerSourceId, providerOccurrence,
//          name, assertCurrent(), assertDataCurrent() }
```

先 exact WeakMap / originalFlush gate，unknown / clone / foreign 零 Source 拒绝。首次
reading / failed latch 必须先于任何 full callback；full 保原 Slot / Work / runtime / policy
回调后全原 raw digest / name / private refs；data 仅相同事实、原 signals / cut / policy 与
全 typed raw / 副本摘要。caught 重入与任何失败 sticky，不接受输入断言函数。

### 3. 原 flush 唯一消费

原 Host `flush(uuid)` 对 model 增加可选 opaque 第二参数；Tool / Human 与没有旧行的
路径不改变。旧 generic flush 参数数量兼容、没有能力消费这份 token。Main 原
`captureNativeConversationTranscriptFlush` 返回的 actual closure 自持 its own identity；
它先按原方式封并 flush 同 uuid buffer，再 exact join completed token 与已登记 writer
receipt 的 runtime / Call / Attempt / uuid / provider tuple / original closure / database /
当前 run。不是只按 uuid 查询普通数据库行后升级。

新增补交在原 baseline capture 前。先占当前 run / occurrence 私 once reading / failed，
选取完整旧 23 列与 fragments / state；要求无 canonical marker、同 uuid 的待写 queue 已
真正 flush。已经 durable 的 fragments / state 全部保留，不把它们当未写 queue、压平或删除；
原八 facts 除 name 全相等。完成 native 的真实 private UI 副本必须与旧行的正文 / reasoning /
tool calls 等原输出事实完整相容；不刷新返回对象 digest。原 NULL name 必须符合这个
private Main writer 的普通 assistant name 映射。

所有原 physical / completed source full callbacks 都在写前完成，之后重读完整旧行并比
原 23 列摘要、完整 wire / returned / name / policy / owner / lease / cut 的纯尾。只有仍
相等才对同一旧行做单 name CAS：WHERE 比较原 23 列的全部原值及无 marker，SET 仅 name。
写后再次完整读同一行，严格只该字段从 NULL 变为已认证 name；其它原 22 列逐项相同。
不能调用 renderer append、任意 serializer、消息类 constructor 或 unknown callback。
不通过 override SQL function 的 changes() 取成功证明；实际 fresh row 仍须完整验证。

原 guard 若在前面的 full 中更改任何旧 raw 字段、provider / namespace / policy / alias /
lease / signal，必须 fail closed；不能把 late 修改当新 baseline。Name 消费成功后随后
原 adoption.capture 的八 facts 仍照旧严格验证，Store 整行保护 / canonical23 / receipt /
ledger A/B 全保持。没有 token / receipt / current row 时，不进入该例外。

## 原子 ownership 窗口

待两个设计票齐全后只编辑这些 named seams：Calls partial private immutable refs /
archive selection；Partial exact wire archive；Host completed capsule / model flush 参数；
Main IPC queue writer receipt / 原 targeted flush 的单 name CAS；runtime option / callback
type-only 参数透传。Core ordinary / completed / live typed算法、SSE omission 与 Shared / Tools
全路径不扩。需补完整精确代码签名后方可实施，不以本稿部分描述跳过 private join。

## 实际回归顺序

先新增 unwrapped SDK golden：真正 localhost ChatOpenAI token + callback / StreamMessages
Handler 记录早 chunk root 与 kwargs name absence，最终真正 AgentNode 返回双 name ==
original bound；default / 自定义 options.name 分别验证。只输出布尔 / count，不正文。
同第一 chunk 与多 chunk aggregate 地址关系也固定断言。Root 唯一 runner。

随后实际 Main IPC / AppDB regression 必须用原 run lease / queue / native Host / actual
provider，不能复制造 synthetic iterator：OFF false policy 原 token buffer真实落行；true
SDK完成后原 name补交；provider1、原 UUID/provider tuple、原真实 Tool / Hook次数、body/
kwargs/calls全 native codec、Store / CP成员 / canonical23 / receipt完整保。完整 ON原路径
也保，不能只用 OFF mock。自定义 Node名必须从真正 options.name 来源。

阴性包括：无 writer / clone wire / foreign completed Slot或Attempt（同providerID/UUID
也拒）；只改单边 root/kwargs name、name getter（零getter）；写前末 source改旧name /
正文 / args / provider / ordinal或fragment，零canonical commit；source caught重入sticky；
真实 abort / closed / lease reacquire；使用真实两个 chunk aggregate验证不同早chunk地址。
首真实 Electron gate须继续到 terminal done，不只 output存在和停止按钮消失；当前
CORE_USER / ID-less失败日志保留，不以原 composer前两轮通过替代普通 OFF完成。

renderer canonical echo 的身份错误独立诊断，不与本name例外混改；本稿不放宽 Echo 的
canonical id / role / provider tuple 比对。

## 实施前的精确接口补充（待最终两票；尚未生产）

下列接口名称固定本轮申请的边界。所有 opaque token 都为空 frozen 地址；品牌或
TypeScript 类型本身不作认证。读取只认各模块自造 private WeakMap，使用已捕获集合
intrinsics。所有可选私字段始终有 own `undefined` 初态，不从 Object.prototype 找值。
不能增加 `register(fn, inspector)`、public coverage 标志或任意 callback writer 认证。

### Calls：实际返回与过去 partial 的两个 data reader

```ts
interface FunctionNativeModelPartialArchiveData {
  readonly runtime: FunctionNativeConversationRuntime
  readonly call: FunctionNativeModelCall
  readonly attempt: FunctionNativeModelAttempt
  readonly message: object
  readonly configurable: object
  readonly taskId: string
  readonly read: object
  readonly namespace: string
  readonly uuid: string
  readonly providerSourceId: string
  readonly providerOccurrence: number
  readonly policy: NativePolicyCertificate
  readonly signal: AbortSignal
  assertDataCurrent(): void
}
readFunctionNativeModelPartialArchiveData(
  partial: FunctionNativeModelPartial
): FunctionNativeModelPartialArchiveData

interface FunctionNativeModelReturnedData extends FunctionNativeModelPartialArchiveData {
  readonly message: BaseMessage // actual call.returned.message，不是早 chunk
}
// 本 Calls 的 class-evaluation 固定原方法，不能晚查 this/prototype 方法。
FunctionConversationNativeCalls.readReturnedData(
  configurable: object, actualReturned: BaseMessage
): FunctionNativeModelReturnedData | undefined
```

archive record 只在原 `capturePartial` 为真正 callback chunk 建立 token 时保存本
Call / Attempt / runtime / actual task / read / namespace / policy / provider 的原地址。
这个 reader 不 mint partial，不重新选择新的 callback、不重新 bind provider；原 live
`readFunctionNativeModelPartial` / `assertCurrent` / `assertTail` 仍严格拒 sealed。
archive data 允许同 Attempt 后来正常 sealed/completed，目的仅证明过去这个 token 的
身份，绝不核准现在 raw chunk 的显示/完整消息/Slot。failed Attempt、closed Calls、
原 maps / task / runtime / provider 变化、真实 signal / policy / cut 失效仍拒绝。

returned reader 仅从同 Calls 私 maps 选择本 configurable 的实际 call.returned；核
results → same Attempt、private call.byTask/read/task、completed status、provider 与
actualReturned 地址。未知返回/clone/foreign Call 返回 miss 或固定拒，不能按 UUID
找到另一返回。它不执行 `assertCall` 或任何 Source；普通 `returned()` 原 full 次数和
调用位置不改。新 data closure 首 reading/failed latch 在任何外部 callback 之前固定，
catch 用独立 failed 保首 reason（包括 undefined/null），caught 重入永久失败。

### Partial：只有原生成 wire 的归档，不重读 sealed raw

```ts
interface FunctionNativeMainPartialArchive { readonly __opaqueMainPartialArchive: never }
interface FunctionNativeMainPartialArchiveData {
  readonly identity: FunctionNativeModelPartialArchiveData
  readonly wire: object
  readonly metadata: object
  readonly wireDigest: string
  readonly metadataDigest: string
  assertDataCurrent(): void
}
readFunctionNativeMainPartialArchive(
  wire: unknown, metadata: unknown
): FunctionNativeMainPartialArchive | undefined
readFunctionNativeMainPartialArchiveData(
  archive: FunctionNativeMainPartialArchive
): FunctionNativeMainPartialArchiveData
```

只在原 `projectFunctionConversationNativePartial` 成功准备 generated wire / copied
metadata、原 full guard 与 typed tails 全部成功后，于 return 原 frame 之前自产 record。
其原 partial 必须是 Calls 真 token、原 policy.protected 为 false、本次无 SSE Source；
Main 档案不使用或改变 `sseWires`，未来 Source 不能事后补身份。record 以原 wire 为 key，
并 exact 比较原 copiedMetadata 地址；完整 ordered own descriptors / proto / flags 与
原 wire/metadata typed digest 都固定。archive reader 仅 data，unknown/clone/Proxy
先 miss，不能运行 caller getter。当前 wire / metadata / 私身份 / 原 policy / signals /
fixed cut 的纯尾照旧；不再调用 `captured.assertDataCurrent()` 的 live sealed raw 分支。
实际完成返回的全 raw digest 由独立 returned / Slot proof 保持，不能用历史 wire 摘要代替。

### Main：自造 run / queue / flush 和每次成功 durable observation

Main IPC 模块只在三个原真实启动分支已经成功登记 actual controller 到 `activeRuns`、
取得本 `runToken` 的 queue owner 和真实 lease 后，调用**私有**
`createNativeMainTranscriptRun(threadId, runToken, actualController)`。私 record 固定该
actual controller / original controller signal、原 activeRuns entry、queue owner、lease
closure、database / fixed incarnation 与当前 run。无 export 或 caller registration。
现有 public `captureNativeConversationTranscriptFlush(threadId,runToken,signal)` 保旧
行为；只有同 private run record 的 exact signal / lease / owner 才能给它返回的原 flush
closure 建立 private MainWriterOrigin。单独调用它、知道 runToken 或提供相似函数不 mint。
无这份私 origin 的 generic/direct flush 保原行为，不能消费 Name token。

原 `consumeStreamWithSideEffects` / resume / interrupt consumer 在收到实际 source frame
后、首 filter / acknowledgement await / serializer 之前，以 descriptor-only 原 tuple
选择 exact archive。不能在 `persistStreamTranscriptChunk` 重新查 archive：真实
`createStreamDataSerializer({projectMessageChunks:true})` 复制 wire / kwargs / metadata，
其后 `serializeNativeConversationStreamData` 又 JSON.parse 出新地址。采用下节的 Main
私 transport 将首 archive 沿这一次实际 serializer 输出传到 parser / queue，私 record
最终关联到**实际 queued message 地址**；不按输出 digest / UUID 重新注册 partial。
完整 parser 结果 id / role / provider tuple / 正文 / reasoning / calls 必须与本已固定
wire 的已知 UI 映射相容；mapping 不以 substring/trim 证明来源，不调用 raw native 的
toDict/toJSON/getter。解析生成时间与原 queue metadata 原样保留。queued copy 的 own
fields / flags / proto、archive 原地址也固定，不能通过拷贝 queued message 获来源。

```ts
// 全部仅 Main IPC 私接口，不公开 mint / inspect / update receipt。
interface NativeMainWrittenObservation {
  readonly columns: FunctionConversationProjectionColumns // 完整 23，或首写前 undefined
  readonly fragments: readonly NativeMessageFragment[]     // 原 5 字段逐项、原 fragment_id 顺序
  readonly state: NativeMessageFragmentState | undefined   // 原 4 字段
}
interface NativeMainWriterReceipt {
  readonly run: object
  readonly originalFlush: NativeTranscriptFlush
  readonly identity: FunctionNativeModelPartialArchiveData
  readonly archives: readonly FunctionNativeMainPartialArchive[]
  readonly revision: number
  readonly observation: NativeMainWrittenObservation
}
type NativeTranscriptFlush = (
  uuid: string, completion?: FunctionConversationNativeModelProjectionCompletion
) => void | Promise<void>
```

每次原 `flushPendingStreamTranscriptMessages` 的实际 selected 数组将同 occurrence 的
全部 queued 原地址 join 到这些 archives。必须同 runtime / Call / Attempt / provider /
uuid，原顺序一项不漏；混入 unknown、同 UUID foreign queue 或被替换项不取得 Name 资格。
给该 occurrence 的私 operation reading/failed 占用先于原 resolver / physical guard。

**首次 durable observation 不能推迟到 completed。** 已有 receipt 时，在本次原写入前
fresh 固定执行读 23 + fragments + state，严格等上一 revision 的 observation；首真
writer 要求原不存在该 occurrence 的 durable 行/parts，已有普通同 UUID 行不补基线。
然后保原 resolver、partition、upsert/appendDelta 的正文语义、原 return count 和原 Source
检查次数。只有原写入成功并核完原当前 owner 后，立即用固定执行 fresh 读全部 durable
状态；完整重建的正文 / reasoning / calls 必须等本次 selected 原算法的真实结果，才能
由**这一词法写入分支**将 receipt revision 推进一次。没有接受 caller row/receipt 的接口。
写入失败、被吞错误、postwrite owner 变化、不符映射或 unknown writer 均不登记成功。

后续多 chunk/delta 只能按本原 writer 顺序推进 observation。一次 timer flush / targeted
flush 若含多个真 chunks 仍核全部 archives 和全部 selected，再固定一次完整后态。
不能从任意 ordinary callback 或外部同 UUID update 重新观测后刷新 receipt。原 fragment
路径合法保存 prefix + ordered fragments；重建必须完整，不截断尾部来强行相等。原
fragment state.total_chars / updated_at 与所有原行字段保持并纳摘要；不在 Name 路径压平。
qualified observation 固化后若任一字段被改，下一 writer 或 completion 必须拒绝。

### Host：原 finalize 的 capsule 和精确 flush 交接

```ts
interface FunctionConversationNativeModelProjectionCompletion {
  readonly __opaqueModelProjectionCompletion: never
}
interface FunctionNativeModelProjectionCompletionData {
  readonly runtime: FunctionNativeConversationRuntime
  readonly call: FunctionNativeModelCall
  readonly attempt: FunctionNativeModelAttempt
  readonly slot: FunctionConversationNativeNodeSlot
  readonly returnedMessage: BaseMessage
  readonly uuid: string
  readonly providerSourceId: string
  readonly providerOccurrence: number
  readonly name: string
  readonly originalDigest: string
  readonly ui: Readonly<NativeCompletedAssistantUiData>
  assertDataCurrent(): void
}
readFunctionConversationNativeModelProjectionCompletion(
  token: unknown, originalFlush: NativeTranscriptFlush
): FunctionNativeModelProjectionCompletionData
```

Host 的 private record 只能由 actual finalize model 分支建立；不能提供 public factory
参数或 caller cert。Host 原 input.flush 在创建 Host 时从 own data descriptor 固定 fn /
receiver / flags，Main 消费比较原 fn，不能比后来 `.bind` 的 wrapper 或函数 shape。

finalize **首任何未知 full 之前**，先用 genuine SlotData / Calls returnedData / existing
Node modelName opaque proof join：actual slot.runtime===Host.runtime，slot 原 graph / Work /
Task / configurable / read / builder runnable / original bound，实际 returned.message===
slot.raw，Call/Attempt 原 owner，Host 成功 installation private graph 及原 runtime /
target / store/producer 均相同。先装 reading/failed record，固定 whole raw 与 safe copy
typed baseline、root.name + same lc_kwargs.name 和原 Node name proof 全数据/flags；期间
不能调用 full、constructor、raw serializer 或用户 fn。名字来源不是传入 name 字符串。

保原 finalize assertCurrent / readSlot / Calls.returned / policy / baseGuard / typed capture /
safeInput / guard 全检查；这些 full 返回后都与首 pure baseline 比较。safeInput 的完整
UI 映射从既有 typed copied data 做已知 data-only mapper，并固定整个 UI 值/全 native raw
摘要；Tool calls 用原完整 `{id,name,args}` UI 协议，usage/kwargs/native-only facts 仍在 raw
摘要，不能拿 UI 较少字段代替原全消息验证。step-limit替代消息/无 actualAttempt 不 mint。

该 capsule 的 fixed full closure 包的是**原 seal 中已有一次 `guard()` 原地址/原 receiver**，
其后仍原 Calls.seal，不额外跑一次新的 Source。即原 seal 的 guard full 被同一次 wrapper
执行，检查范围/次数位置原样，随后加原私 data tails；不是以历史 archive 代 guard。
原 flush(uuid) 仅 model+true cap 时透传 `flush(uuid,completion)`，其它路径仍一个参数。
Main reader exact token / originalFlush gate 后只运行自造 data tail，不重跑 sealed partial
或追加 Source。normal full 已在原 seal / flush existing physical guards 中完成。

完整原 raw / returned 地址、双 name / kwargs 地址与 flags、Slot/Work/Calls/Host 私 refs /
policy/signals/absolute cut、safe/UI copied baseline 在 Main CAS 前后均纯重核。capsule 失败
sticky、expired/retired/closed 拒绝，caught 同一 finalize/cap/consume 重入不让外层恢复。
cap 不注册消息、append、ACK 或 completed权限。

### Fixed NativeSqlite 专用执行与 23 列 name CAS

现有 `NativeSqliteCurrentExecution` 只提供 fixed prepare/get。本轮不调用晚期的
database.run/exec/prepare 或 native.prepare/statement.get/run 公共属性。增加**只服务本表
这次 name 补交**的 fixed execution seam：

```ts
interface NativeSqliteProjectionNameExecution {
  assertDataCurrent(): void
  read(threadId: string, uuid: string): NativeMainWrittenObservation
  compareAndSwapName(
    original: NativeMainWrittenObservation, completedName: string
  ): NativeMainWrittenObservation
}
readFunctionConversationNativeProjectionNameExecution(
  database: unknown
): NativeSqliteProjectionNameExecution | undefined
```

资格仅 existing private openfactory 的 exact Adapter/native pair + 原 own isOpen getter /
closed bool/proto/flags；direct/custom/alias constructor miss，不提升 generic writer。
这是固定存取事实，不认证 uuid/name/permission。没有 config、Source callback、guard setter、
caller SQL 或 inspector 参数。Main 独立 private origins 全 join 成功才调用此 seam；reader
本身不 mint writer receipt / Host 来源 / append 权。

模块 load 捕获 DatabaseSync.prototype.prepare 与 StatementSync.prototype.get/run；
实际原 statement 由 fixed native.prepare 产生，所有调用用 captured Reflect.apply 同
native / statement receiver，不晚取 .get/.run/.bind/.call，不 spread caller iterable。
仅完整 dense 已复制 scalar bindings（本表原 23 类型）按 index 传入。保原 read-one
factory 首 open 与每 fresh read 的三处完整 closed/open checks。run 同样每原阶段核这个
原 pair；closedError/sticky 语义不被成功读覆盖。不用 `changes()` / `count()` / JSON SQL /
GLOB / user function 验证成功，不调用 public save/flush 作为 CAS 的成功认证。

固定 SQL 显式列出原 23 列；fragments 每次 fixed get 按 fragment_id 严格递增读取原 5 列，
state 读原 4 列，无聚合函数 / override function / iterator。main schema/table qualification
只针对这三张实际表和 receipt marker：普通原 column 类型/nullable/PK/hidden flags 保持，
name 必须是原 plain nullable TEXT；unknown virtual/generated expression、触发器或表达式
index 不能在 UPDATE 执行时接 unknown JS，因此同一 fixed plain-schema gate 必须明确拒。
原 AppDB 已知普通 indexes 保持；不把任意 first-seen SQL 字符串当 trusted schema。
TEMP shadow/qualified pointer改变严格拒或原 SQL error，不借空查询当 absent。此项不认证
Destination m.* 或全库 SQL pure，只封本次具体 CAS 的真实执行 callee。

CAS 前顺序固定：原 seal full → 原 targeted flush / all existing physical full → exact
completion / WriterOrigin / all archive joins → fresh 23 + parts **严格等已成功 writer 最后
observation** → original raw/returned/safe/UI/metadata/policy/name/lease/owner/schema纯尾。
不能在它们之后调用 FlushSource/fullcallback或刷新观察。same occurrence 私 operation
reading/failed 首先占用，判断用显式状态，异步/非法 result 不伪装成功。

行不存在且原 receipt/parts 也不存在，保原 no-row insert 路径；已有普通行但无该 actual
writer receipt 明确拒。完整 row 八facts除name全相同、function_row_json/receipt marker
为空；name NULL 只能过渡到该实际 completed 双 name。已有同正确 name只完整验证不写，
其它非 NULL拒。完整 UI 的正文/parts重建、reasoning/toolCalls/status 等值必须成立。

单 UPDATE 的 SET **仅 name**，WHERE 对所有原23列逐项 `column IS ?` + 原未marked条件，
绑定原 observation 全值（不是新读的晚值）。CAS 后 fresh fixed read要求原其它22列
逐项相同、name==verified completedName，fragments/state完全原样，所有 private data
tails 再核后才返回。rows不存在、多行/PK/schema变化、任一份parts或raw变化都拒绝；
不通过 run 返回对象的可变字段或任何 SQL changes() 断成功。后面的 native projection
首baseline和原assertFacts八项、Store原23/CAS/receipt/ledger A/B仍完整执行。

## 精确修改文件申请

两个最终票通过后，建议按独立 additive 区域原子落：

1. `function-conversation-native-calls.ts`：partial私data identity、返回data选择、固定class
   method reader；原live/SSE/select/Work full不扩。
2. `partial-native-message-capture.ts`：独立 Main wire archive WM 与两纯 reader；SSE不改。
3. `function-conversation-native-host.ts`：finalize首pure capsule、model seal同guard一次与
   optional flush参数；原 Side/Human/Tools/Shared guard区不改。
4. `ipc/agent.ts`：actual IPC私run birth、queue私origin、true durable observations、原
   targeted flush消费；generic旧写入/SDK调用/渲染协议不变。
5. `native-sqlite-adapter.ts` + 新 `db/function-conversation-native-projection-name.ts`：
   actual factory pair的固定本表 execute seam / literal SQL / schema与23 CAS；不碰
   Legacy Parent original read-one / Store / Destination性能区。
6. `agent/runtime.ts`：flush optionalopaque参数的type-only透传，无额外安装资格。

这不是完成声明。新增纯SDK reference4已冻结等待实际；Source/IPC/Electron各门仍待实施
与 Root 真跑。name的only-column例外不放宽全facts、projection proof、policy或ordinary
input。后续测试必须真1/2 chunks、default/customname、ON/OFF、完整23/parts与0未知callee；
仍严格保旧5秒门和当前Electron两次真实失败证据。

## Serializer 原地址变化的私运输接缝（最终票前补充）

实际入口是 `agent.ts` 的 invoke consumer、resume consumer、interrupt consumer 各自的
`createStreamDataSerializer({projectMessageChunks:true})` 原局部函数。普通 messages 的
原 wire / metadata 经 `projectMessageChunkForSerialization` 复制，随后 native serializer
JSON.parse 产生另一 tuple；这种正常复制不能用最终地址查 Partial 私表。这里不新增
serializer 可调用的 provenance register，不把 JSON 相等或相同 id 当来源。

以下类型和函数均留在 Main IPC 模块私有区，无 export；纯 Factory / Worker 不 import：

```ts
interface NativeMainPartialTransport { readonly __opaqueMainPartialTransport: never }
interface NativeMainRunSerializer { readonly __opaqueMainRunSerializer: never }
// 仅三个 actual IPC consumer 创建原 serializer 后立即在本 private run 下登记。
function createNativeMainRunSerializer(
  run: NativeMainTranscriptRun, serializeForRun: StreamDataSerializer
): NativeMainRunSerializer
function captureNativeMainPartialTransport(
  serializer: NativeMainRunSerializer, mode: string, originalTuple: unknown
): NativeMainPartialTransport | undefined
function serializeNativeMainFrame(
  serializer: NativeMainRunSerializer, mode: string, originalTuple: unknown,
  transport: NativeMainPartialTransport | undefined
): SerializedStreamData
function readNativeMainPartialTransport(
  transport: unknown, run: NativeMainTranscriptRun, mode: string,
  actualSerializedPayload: unknown
): NativeMainPartialTransportData
```

`createNativeMainRunSerializer` 仅真实 consumer 的词法调用点可用。它固定本私 run 的
original serializer 函数、原 receiver（现为 undefined）、相同 options 的创建事实和
consumer operation 地址；未知 public serializer、另一个 run、另一次 failover consumer
不能挂到已有 record。三个局部 `forwardStreamChunk` 承载 optional opaque transport，
依次原样透传给 `persistAndForwardPhysicalRunStreamChunk`、`persistStreamTranscriptChunk`
的 options，后者只读私表。不对外暴露捕获/settle reader，也不按传入 fn 形状登记权限。

每个实际 frame 收到后先 descriptor-only 捕获原 outer tuple、mode、messages tuple、
wire / kwargs / metadata 的全部原地址、ordered own keys / flags / proto。只 mode
messages 且 exact Main Partial archive 命中才建 transport。unknown ordinary frame
返回 undefined 后仍原路径；真实 archive 的坏拓扑/foreign run 失败不能降为 unknown。
此步骤位于现 `isCoordinatorWorkerStreamChunk`、acknowledgement await、compaction filter
以及原 serializer 前；首 reading/failed 占用在任何未知 callback 前。await 之后还核
同 archive、完整首 raw wire/meta 摘要、run/queue/lease/policy/cut 数据，不能 late 补档案。

`serializeNativeMainFrame` 只执行该自造 record 固定原 serializer 一次，同原参数和
receiver，不读晚 .call/.bind；内部原 messageProjectionScopes、text/reasoning/tool args
delta/snapshot 模式、values epoch 和 callbacks 逻辑仍原样。调用前后都完整纯核原 archive
和 tuple；失败固定状态、不登记成功。成功后只取此次真实返回对象的 own data `data`、
`valuesMessageIndexOffset`、`valuesSnapshotKind`，将返回对象/serialized tuple/kwargs/
metadata 地址与完整 typed digest、所有 mode 字段和所有 text/reasoning/tool-argument
投影值固定在同 transport 私记录。此数据来自本次固定函数的实际返回，不是 caller
复传的 output，也不接受摘要作为 mint 参数。返回 promise/Proxy/accessor/不符 messages
完整形状明确拒。没有新增原 serializer 的第二次运行或影子投影状态。

transport 的 output 基线在 parser 之前固定，并在 queue 登记、每次实际 selected write
前后、completion CAS 前后纯核。UI mapper 仍按原 delta/snapshot 和 hydration 算法完整
重建 text/reasoning/全部 tool args；其中间状态由原 writer 成功 revision 固定。最终
durable 全量 UI 必须与 true returned completion 的完整已知映射相等，不能把只是经过
serializer 的任意 output 当安全内容。raw archive 身份与当前 full returned proof 各自
保存，output 摘要不能替代其中任何一个。

`persistStreamTranscriptChunk` 先 exact 查本 transport 的 run / mode / 实际 payload 地址
及 data 尾，再执行原 parser/resolver。原 completedRoute 若成立，只允许其**实际自造**
stable identity 与该 transport 的 uuid/provider tuple 全等，并保其原 payload 重写分支；
这个身份已来自 archive/Call，不是 route 的 public id 授权。其他字段改变拒，不以本分支
刷新 serializer 输出基线。初窗若真实 qualified partial 走 completedRoute 需要改变原
非等字段，就明确该帧不取得 Name writer 资格，不能忽略差异。queue 私表再固定实际
queued copy 的地址和完整字段。无 transport / public同looking tuple / JSON clone / 相同
uuid 的普通写入不能推进 writer receipt。消费成功后原 UI forwarding 和 side effects
同次数；运输失败仍真 stream finally/drain，不写 ordinary fallback 伪成功。

真实新增门：serializer 确实复制 wire/meta 且 archive 仍只能从原地址读；一次原 HTTP
consumer 委托保持 serializer 调用数；换 serialized payload/metadata/index、换 run 或
consumer、clone opaque、await 后改首 raw/meta、输出 mode/args 改动，均 0 Name CAS。
这些门须完整 durable23/parts/provider/真正末 Source 检查，不以 helper 人工复传 result
代真实 IPC 运输链。公开 serialization API 本轮不新增来源权限。

## 本次 fixed SQL 的具体 plain schema 资格（最终票前补充）

资格只针对 `main.thread_messages`、`main.thread_message_fragments`、
`main.thread_message_fragment_states`、`main.function_conversation_projection_receipts`。
所有业务 SQL 用 main-qualified 固定标识符，不经 TEMP 同名表解析；unknown ordinary
generic 写入原路保留，只有完成 Name 交接选此资格。qualification 不能用首见 DDL
字符串做基线，expected 清单来自现 `db/index.ts` 与 projection receipt migration。

Schema reader 使用原 native factory pair 的 captured `DatabaseSync.prepare` +
`StatementSync.all/get`，业务 CAS 用 captured `StatementSync.run`。`all` 只为四个固定
`PRAGMA main.table_xinfo("literal_table")` 和 schema 查询读取有限完整清单，固定原
receiver/Reflect.apply，不接 caller SQL/bindings/iterable。不能在表值函数形式调用
`pragma_table_info(...)`/`pragma_table_xinfo(...)`，避免 TEMP shadow 或重定义 table-function
解析；不执行 schema SQL 本身。资格查询为：

```sql
SELECT type,name,tbl_name,sql FROM main.sqlite_schema
WHERE tbl_name IN ('thread_messages','thread_message_fragments',
  'thread_message_fragment_states','function_conversation_projection_receipts')
ORDER BY type COLLATE BINARY,name COLLATE BINARY
```

四张表各 exact 一条 type=table/name=tbl_name，四个 xinfo 的 own scalar 行全部核完再
允许 prepare/read/run；每次实际写前后 fresh 重读，不跨 Source/await 留成功资格缓存。
`cid` 为唯一连续非负数且原顺序保留，但迁移追加列可改变物理次序；按 name 固定完整
集合，不把当前 firstseen 顺序认成权限。每列 `hidden===0`，无额外列、缺列或 generated。
declared type 严格 TEXT/INTEGER，`notnull`/`pk`/`dflt_value` 逐项核下表：

| 表 | 原列与类型 | NOT NULL | PK 位置 | 原默认 |
| --- | --- | --- | --- | --- |
| thread_messages | thread_id TEXT,message_id TEXT | 两者1 | 1,2 | NULL |
| thread_messages | role TEXT,content_json TEXT | 两者1 | 0 | NULL |
| thread_messages | provider_source_id,prompt_origin_json,function_row_json,reasoning,tool_calls_json,tool_call_id,name,status,goal_id,active_window_id：TEXT | 全0 | 0 | NULL |
| thread_messages | provider_occurrence,is_error,content_priority,recovery_integrity,start_at,end_at：INTEGER | 全0 | 0 | NULL |
| thread_messages | stream_authority INTEGER | 1 | 0 | 原literal 0 |
| thread_messages | created_at INTEGER,ordinal INTEGER | 两者1 | 0 | NULL |
| thread_message_fragments | fragment_id INTEGER | 0（真实 INTEGER PRIMARY KEY 的 xinfo） | 1 | NULL |
| thread_message_fragments | thread_id TEXT,message_id TEXT,content_text TEXT,created_at INTEGER | 全1 | 0 | NULL |
| thread_message_fragment_states | thread_id TEXT,message_id TEXT | 两者1 | 1,2 | NULL |
| thread_message_fragment_states | total_chars INTEGER,updated_at INTEGER | 两者1 | 0 | total_chars 原literal 0，其余 NULL |
| function_conversation_projection_receipts | thread_id,incarnation,uuid：TEXT | 全1 | 1,2,3 | NULL |
| function_conversation_projection_receipts | target_json,canonical_receipt_id,canonical_row_digest,native_payload_digest,projection_json,projection_digest：TEXT | 全1 | 0 | NULL |

table SQL 还必须属于**编译期固定 migration grammar**：普通 CREATE TABLE 的上述 exact
列声明及 PK；thread_messages 唯一允许原 `CHECK(role IN ('user','assistant','system','tool'))`，
fragment_id 唯一允许原 INTEGER PRIMARY KEY AUTOINCREMENT；两个原 0 defaults 仅 literal。
来自当前 schema 的合法列定义次序与已知 ALTER ADD COLUMN 后的次序可同语义核，但每个
token 都在这些固定 declarations 中，不能只删空格/substring 搜 CHECK/GENERATED。
无未知 CHECK/DEFAULT 表达式、COLLATE、foreign key、UNIQUE、STRICT/WITHOUT ROWID、
virtual table、generated declaration或额外约束；不知道的迁移形式资格 miss/明确拒，
不能 firstseen 后自登记。这里不执行未知 SQL 来判等。实际实现前的 parser 小窗还需独立
source 票及下述真实 native tests，不能只 xinfo 合格就宣布无 unknown callee。

schema 查询中这四表的任何 type=trigger 都拒；任何 unknown view/index/table 映射拒。
普通 indices 仅以下 repository literal definitions（不按 name alone）：

| 原 index | 固定 columns/order 和原 partial predicate |
| --- | --- |
| idx_thread_messages_thread_order | thread_id,ordinal,created_at |
| idx_thread_messages_provider_occurrence_order | thread_id,provider_source_id,role,provider_occurrence,ordinal DESC,created_at DESC,message_id DESC |
| idx_thread_messages_role_order | thread_id,role,ordinal DESC,created_at DESC,message_id DESC |
| idx_thread_messages_active_window_order | thread_id,active_window_id,ordinal,message_id WHERE active_window_id IS NOT NULL AND active_window_id != '' |
| idx_thread_messages_goal_order | thread_id,goal_id,ordinal,message_id WHERE goal_id IS NOT NULL AND goal_id != '' |
| idx_thread_message_fragments_message | thread_id,message_id,fragment_id |
| idx_function_conversation_projection_thread_uuid | thread_id,uuid |

还有 PK 产生的原 sqlite_autoindex：SQL 必须 NULL，所属表/唯一对应原 PK 的自动 index
名称与 `PRAGMA main.index_list/index_xinfo` 的 key 列/排序/BINARY/非表达式完整相符。
fragments INTEGER PRIMARY KEY 不需要 autoindex。上述普通 index 的 SQL grammar 必须
exact literal column/ASC-DESC/BINARY + 固定两条 IS NOT NULL/!= '' predicate，无 function
或表达式；创建同名 expression index 不能通过。缺少可选普通性能 index 不授额外来源；
出现未知 index 明确拒。不读取/执行 sqlite_sequence 的内容，AUTOINCREMENT 本 name-only
UPDATE 不触其写入。marker 必须已有真实 migration 表，不靠缺表返回 0 mint unmarked。

marker 查询固定 `SELECT uuid FROM main.function_conversation_projection_receipts WHERE
thread_id=? AND uuid=? LIMIT 1`，任何行存在都拒补 name（包含其它 incarnation 的已marked
行）。业务 23 和 parts/state SQL 全显式列、不 m.*、不 function/count/changes/json/GLOB。
CAS 前保 function_row_json IS NULL、name IS NULL 和全部23 `IS ?`，UPDATE 只 SET name。
fragment/state 只 fixed SELECT、不写，所以新 unknown trigger 仍资格前拒，不等 run
执行后才发现。原 full source 最后回来之后，这些固定 schema/query/run 调用无未知 JS；
schema/row/parts 变化仅使 qualification/CAS 失败，不刷新旧 durable observation。

真实边界测试需要 openNativeSqliteDatabase 创建 pair、完整 AppDB migration，并安装
能计数/改普通行的 actual native.function。新增 generated name/其它 generated 列、
unknown CHECK、name expression index、UPDATE trigger、同名替换已知 index，必须在任何
业务 query/run 接这些 functions 前拒且计数0、原23/parts/receipt不变；main-qualified
读取遇 TEMP 同名表不借其值，unknown actual-main table SQL 必须拒。晚 public prepare/
get/run getter/replacement 也0callback；closed/direct/custom/same-native-alias miss 保。
正常1/2chunks完整原 parts、所有已有普通 indices、合法 ALTER 追加列布局应真实通过。
此资格不能为 Destination m.* 或 Manager postflight 背书，也不影响它们仍独立 BLOCK。
