# Shared 原生 stream 的实际交接、输出和清理接点

本稿只读设计，尚未修改生产代码。它接续已通过的 SDK 27 目标基础、App preflight
七项，以及 `mods-session-append-shared-stream-design-2026-10-06.md` 1913 行起的
inner iterator 私停止窗。私停止窗的源码归 Official，不重复设计或覆盖它。
SDK/Scope 执行事实不授业务 Source；停止窗也不是用户 stream 完成。

## 已核定的真实调用链

`mods-conversation-shared-invocation.ts` 的 native 工厂已保存实际 capture 地址、
Factory/agent/compiled graph 关系，安装 Node/Tools、getState adapter 和 Lifetime
observer，并经一次私 seal 固定 graph 的三个 own 方法。当前 public stream 尚是
Proxy 的普通方法绑定，不能仅把它转发到已通过的 preflight 函数而开放输出。

State 的首输入/config descriptor 基线必须早于 original capture、defaults/schema
callback 和所有 full guard。实际 SDK stream 原 merge、middleware 初始化、getState
和 dispatch各沿原实现；SDK dispatch 的 state/S2 地址固定，随后原 Pregel 产生 S3，
Core ensureConfig 产生 S4。Graph child Core operation、S3/S4、实际 selected observer
iterator 和安装私记录共同证明这一条调用。ALS只用于恢复已经登记的操作。

业务接纳来自 Scope 原 `getTuple`：真实 Saver tuple/nativeRead → 原 host.admit →
原 restore/Producer/registration → Manager 原 admitted callback →
`admitFunctionConversationSharedNativeInvocation`。后者已有完整 runtime/policy/Host/
history 接纳，原两次 view guard及 Shared Tools attachment保持。原 `phase=ready`
发生在最后 Tools/full 返回之前，因此不能单独作为 stream 输出门。

Node 的实际 OriginalWork/Task、Calls/Attempt 和 Host Keeper仍是消息来源。SDK选择
了某个 iterator不意味着它生成的任意 AIMessage都有这些来源；新增 unknown unmarked
回复必须由最终返回来源分类拒绝，不能借 generic validate 的普通 noop 放行。

## 私停止基础窗的限定第二票

仅 State/Lifetime 两生产区域，新增独立八项真实 fixture。State dispatch helper只
调用一次：无本次 pending时返回 miss，Lifetime原路径保持；真 inner pending时返回
自产 handoff，Lifetime原位返回该次 Graph execute 的原 Promise，不再调用普通
originalStream。Graph.options===实际 SDK S2；Core.options===Graph.actualConfig S3；
Core.actualConfig===实际 iterator S4。iterator首行先占 once claim，再执行任何原
full；同真实 pending缺 Core词法 boundary使该 pending永久失败。

Gate完整核 installation/selected fn/owner/flags、SDK handle、Scope receipt的原 read
地址与 Graph/Core两个 operation后，抛本 pending自造 exact stop。它尚未调用原
generator，因此 provider/admit/frame均0。真实 Graph/Core Promise都必须等原 settle，
用 readonly settlement核 rejected及 exact stop；失败后不得调用 executable reader
刷新证明。未知他图/clone/Proxy在私表未命中处拒绝，不毒化独立操作。

这一票不开放 public stream，不生成成功 terminal，也不证明物理 drain。

## 开放真实 generator 前必须补的 Scope 生命周期

当前 `ScopePreflightExecution.stateFields` 捕获 `initializing`、`binding` 的首
undefined。`receipt.assertDataCurrent` 与 runOperation末检查会严格核这两个值。
原 getTuple正常赋值后继续使用该 preflight receipt会拒绝合法接纳。不得以删这两项
检查、重读当前字段作为新基线、或在 State接受 caller stage setter绕过。

下一窗在 Scope构造私 WM新增独立 stream execution record，使用与现有固定 run
相同的 original guard/context/invocation/tracked执行图。只允许新本次 operation
进入一次，first full之前 reading/used占位，旧公共 run、旧 preflight及停止窗不改。
record保存原 namespace、initializing Promise、binding、delegated的 own flags与
真正转换地址；转换只能在本 Scope 原 getTuple的词法赋值位置登记：

1. 原 validate成功后固定真实 namespace；原 starting ticket在任何 admit callback前
   已登记。只保存实际创建/赋值的 initializing Promise，不按 later字段猜。
2. 真 Saver/nativeRead/host.admit返回后，保原 entered和 binding.assertCurrent；
   只有原 checkpoint thread/namespace验证成功、原 binding/delegated赋值完成，才
   mint空 opaque admission-settlement token。全部实际 binding/Producer/history
   指针与原 tuple/物理 checkpoint点沿现私记录取值，不从 UUID/JSON重造。
3. token纯 reader核 exact Scope、operation、namespace、initializing、binding、
   delegated、authority、两信号及完整原 own flags。unknown/foreign先 miss；真实
   record变化或 caught reentry sticky失败。原失败/关闭/quarantine不能升级。

原 preflight receipt仅证明实际 SDK getState成功，在接纳前按原全检查消费一次。
之后由上述私 token证明本 Scope发生了原合法转换；不能复活已失败的 preflight
执行器或延长被删除的 NativeRead proof。此新增完整签名/转换源码须 Root与Official
再核，不能直接套用现 preflight runOperation给真实 generator跑至结束。

## 实际 admission 的最终 ready 交接

State只从自己创建的 pending、实际 installer/SDK operation/Scope建立 Domain
association；不接受 caller view、guard、bool或 inspector。Domain只记录 routing
地址，不创建消息权限。association必须在 SDK execute前同步固定。

`admitFunctionConversationSharedNativeInvocation` 最后一次现 assertCurrent返回后，
新增词法 completion记录固定本次实际 original Producer/view/Host/Tools关系。这个
记录只是 host-admission完成。State的最终 activation还必须与 Scope原 getTuple尾
所造 admission-settlement token双私 join，再核原 callback后全部 data关系。因
Scope binding原赋值在 host.admit返回之后，不能在前一个 completion位置提前宣称
Scope binding已完成。public phase/view、已有真实另一个 graph/operation不补资格。

Lifetime的 Shared Source只能由实际 installation加本次 State operation创建，
不接受 caller assertCurrent。opening guard固定到Scope自产 full/data；ready guard
固定到双私 join选中的原 view full/data，function地址在首 unknown callback前选定。
stream/iterator/shell/首次 next是 opening接点；每个非done输出、writer、completion、
partial、diagnostic都明确要求ready，不能由一个可替換泛 guard猜阶段。

首次模型/工具依旧用原 Node/Work/Calls/Host全部 full。activation不代其 来源、政策、
reservation、registration、canonical Store、23列或 ledger A/B；无pending的旧 invoke
不新增 activation，也不改变其 Source回调次数。

## 一个后台 Scope 执行与逐次 demand

新增 `function-conversation-shared-native-stream.ts` 只服务真正 native Factory公开
stream；generic代理保持旧行为。后台进一次真 Domain和新 Scope stream executor，
在同作用域执行 SDK handle，取得真实 shell与其 iterator，持续保留原 SDK/Graph/
Core及 Lifetime工作直到实际 finally结束。函数返回 shell并不是这些工作退役。

调用者的 next/return/throw请求进入私有顺序队列。每个实际需求最多调用原 iterator
一步，adapter无额外预取；SDK自身 setup/预取行为保留，不声称它也被逐demand限制。
同一操作每次只有一个 step。需求票在第一次未知代码前占位，保存原 Promise及
包含 undefined/null的真实拒绝理由。没有消费者需求时也保取消 waiter。

S2只由首标准 call signal、原 Scope host/controller约束与本次 cut形成；Shared
default signal继续原明确拒绝。Pregel真实 S3 combined signal和Core S4及其signal由
真词法 reader固定，不重新算 any，不以相同信号补配置来源。Host.configure原 callback
merge仍一次；Node/Calls原runtime与实际provided.signal联合取消保持。

调用者 return/throw、readable cancel、call abort、Scope/controller abort、owner退出
均先使私cut不可逆abort并唤醒无demand waiter。后台随后真实return/throw并必要时
继续驱动原 iterator至done，观察原 generator/runLoop finally与Lifetime.drain；
同时保留 Node、Tools、Host、Keeper/child全部原排空。不能把 reader.cancel、SDK
execute fulfilled、Scope.close或主动丢队列当作实际工作结束。

cleanup独立记录 bodyFailure和各cleanupFailure（含undefined），先完成全部实际观察
再在finally外抛。quarantine与未知drain原语义保留。Manager.withSharedAgent原
finally会close Scope并await whenDrained，后台必须能独立醒来退Scope.pending，不能
反向等待Manager先释放authority。listener按同操作原地址移除，资源最后才释放。

## 完整 values/updates 帧的最小首输出窗

首公开输出窗只开放原普通 messages输入的 values/updates四种原形态：单mode、
mode数组及其subgraphs真namespace版本。形态从真实S4入口固定；decode不靠猜数组。
不是借SSE Source：Shared ready Source与Domain/token/Runtime独立。完整payload不截
正文、metadata、工具参数、native codec或任何预算，原默认五秒验收不改。

首输入来源复用已落 Shared Return基线：capture之前严格原值/原地址；真实reducer后
仅既有无ID Human正常双ID赋值例外，选择最终snapshot后不刷新。历史只从真实restore
的已认证完整tuple/membership、T1/T2桥与物理checkpoint点取；own输出只取本Host的
exact private Entry。updates按原节点/state messages地址同序分类；未知新增AI、clone
同ID、foreign Entry、public stamp一律拒绝，不扫描本帧建立“历史”。

每帧先完整选源/捕原容器与全部消息，再完成 typed private copies；所有history/full/
ready callbacks在本帧原Host.validate(mode, originalPayload)整batch之前完成。原23列、
presentation和ledger A/B之后只有源、原输入/历史、copy/full digest、容器/domain/
signal纯尾，随后同步出队。不得逐Entry B后再执行下一条full，也不在最后纯尾之后
调用另一个unknown serializer/permission回调。独立copy不登记Entry/ACK或新grant。

必须先补 updates/values真正完整copy协议和原schema/middleware输出SDK对照，禁止
默认把任意非messages state当已认证NativeMessage。原delivery私channel仅在指定
native copy处剥离，其他state/routing按原合同保持。Command/null/interrupt没有正门
时保明确拒绝并继续后继，不称框架不支持。

## messages、Command/null和SSE继续窗

messages live chunk不能用上述completed Return classifier认证。下一独立窗从真实
Calls/Attempt/Work partial token取全部raw及metadata，ready Domain/runtime/private
Source双join；保护策略、完整typed capture、callback后raw/wire纯尾照原Main/SSE保留。
sealed/completed排队帧必须另读原completed Attempt/Slot，不延寿live partial API。
protected OMIT只由实际已完成protection/receipt证明，不能遇到未知chunk就丢弃求绿。

Command/null须原SDK initializationSkipped、真正parent replay/update/goto及checkpoint
namespace对照；caller Command私rootcopy和原args/update身份基线规则保持。SSE再接
原编码器及完成/保护/OMIT门。EventsV2/Core rawerror callback当前仍BLOCK，与本窗
独立；SDK toolinvoke outcome不提供这些权限。

## 文件与独立验收窗口

| 窗口 | 生产文件/精确区域 | 独立真实回归 |
| --- | --- | --- |
| 私停止 | `function-conversation-shared-native-stream-state.ts`；`function-conversation-native-lifetime.ts`首两个同步接点/current observer reader | 新 iterator-foundation八项；旧App七项、Scope32项、SDK全基础保 |
| Scope与admission交接 | `conversation-shared-checkpointer.ts`独立stream record、原getTuple转换尾；State；`mods-conversation-shared-invocation.ts`原admit末；`function-conversation-shared-native-domain.ts`私association | 真parent/SqlJsSaver、admit末full重入/退役、错token/原binding、held initialization/undefined失败/原Scope排空 |
| 后台与values/updates | 新 `function-conversation-shared-native-stream.ts`；State/Lifetime Shared Source；SharedInvocation native public stream及完整Return copyhelper | 新真实Shared stream integration；原derived/history/IDless/provider reuse/fullCP/member/23与四shape；no-demand owner退出、真实held model/tool finally |
| 完整messages | Calls/Partial/Host的Shared命名来源小区域；State/Lifetime和新stream模块 | 真HTTP多chunk及工具事件、每帧fullcodec、晚raw/getter/metadata/Source变更、protected OMIT、sealed queued帧、首错误与0canonical阴性 |
| Command/null/SSE及用户入口 | 上述各原native分支的指定区域；SSE encoder仅独立来源消费 | SDK普通黄金对照、真实resume/new operation、真实stream所有shape/SSE、parent/child隔离与所有finally |

具体API和每个新增Source接点逐窗双设计/源码评审后才能实现，不批准本表全部同时写。
SDK templates/artifacts/27 installer、本次Main/Renderer Name、DB fence均不在这些窗内。

最终Electron验收使用真实获批Function/真实Shared child，不手造capture/Scope/receipt。
每次真实request终态done且error0；完整HTTP/provider/tool/callback次数、CP/membership/
原23列/UI canonical ID/Echo前后0、父子隔离、Mods-off普通路径都保。用户break/abort、
owner退出和窗口关闭后必须真实资源排空。只保存固定facts/计数与截图，不记录完整
正文、模型凭据或私能力。任何测试shape临时拒绝不当最终能力完成，仍继续后继窗口。

## Scope 与 admission 交接窗的精确 API 提案

以下是下一独立窗，不包含后台队列或任何输出。请求 Root DESIGN1/Official DESIGN2，
源码仍冻结。须先通过前述 inner 私停止窗；本节不覆盖 Official 的 State/Lifetime修改。

### 新 Scope 私执行记录与接口

`conversation-shared-checkpointer.ts`在真实构造末与现 opening/preflight表并列保存
`scopeStreamExecutions: WeakMap<Scope, StreamExecution>`，不导入 Main Host/Manager。
它共享原 ctor captures，不从首次使用时的 current方法值建立原执行基准。所有可选
字段在私literal里 own初始化为undefined；不按继承字段选择执行资格。

```ts
interface StreamExecution {
  readonly opening: ScopeOpeningRecord
  readonly originalContext: AsyncLocalStorage<object>
  readonly originalInvocation: object
  readonly originalPending: Set<object>
  readonly originalResolveDrained: () => void
  readonly fieldFacts: ScopeOpeningFields
  operation: object | undefined
  graph: object | undefined
  iteratorOperation: NativeRunnableStreamOperation | undefined
  iteratorConfig: object | undefined
  namespace: string | undefined
  initializing: Promise<CheckpointTuple | undefined> | undefined
  binding: FunctionConversationGraphBinding | undefined
  delegated: SqlJsSaver | undefined
  admission: SharedCheckpointStreamAdmission | undefined
  runReading: boolean
  runUsed: boolean
  iteratorClaimed: boolean
  admissionReading: boolean
  failed: boolean
  failure: unknown
}

// 此execute与现Scope run接口一样，仅是执行参数，不是来源/guard注册。
runFunctionConversationSharedCheckpointStreamOperation<T>(
  scope: FunctionConversationSharedCheckpointScope,
  operation: object,
  graph: object,
  execute: () => Promise<T>
): Promise<T>

// 本Scope执行中，只有SDK Core真实同步iterator词法点可成功消费。
claimFunctionConversationSharedCheckpointStreamIterator(
  scope: FunctionConversationSharedCheckpointScope,
  operation: object,
  graph: object,
  actualConfig: object
): Readonly<{ coreOperation: NativeRunnableStreamOperation; assertDataCurrent(): void }>

// 空token只在下述原getTuple成功尾产生，不能由调用者注册。
readFunctionConversationSharedCheckpointStreamAdmission(
  scope: FunctionConversationSharedCheckpointScope,
  operation: object
): Readonly<{
  admission: SharedCheckpointStreamAdmission
  graph: object
  coreOperation: NativeRunnableStreamOperation
  namespace: string
  binding: FunctionConversationGraphBinding
  assertDataCurrent(): void
}> | undefined
```

run首句选 ctor私 record，纯facts门后占 runReading/runUsed，首原guard之前固定
operation/graph。只执行原 run guard一次、started同flags赋true、固定原context.run/
invocation/tracked票及actualawait/finally。execute必须返回实际后台完成Promise；返回
SDK shell的Promise不能替代它。本窗fixture只驱动真实单次graph直至admission或取消，
不给消费者frame。记录真实failure含undefined，caught reentry不可被外层成功抹去。

iterator claim先 exact本Scope/run operation/graph/context关系，再同步读取模块捕获的
SDK `readNativeRunnableStreamBoundary(graph, actualConfig)`；无 boundary或重复claim
永久失败。reader来的coreOperation/config/receiver/input/selectediterator仅是Scope
执行事实，State还须先核其本次 Graph.child/Core/installation私关系。claim不接受
boundary对象、fn、flags或ready bool。它固定实际coreOperation/S4，读取整config own
基线并复核，首可运行getTuple之前完成。preflight期间仍沿原preflight tuple无接纳；
stream执行中未claim的直接非preflight getTuple拒绝并sticky，不抢晚正版接纳。

同一claim还须从原Scope私preflight表选出已经成功settle的本operation/actualS2/read/
receipt记录，在任何initializing/binding转换之前完整验证并固定该历史事实。State
比较同installer原read地址。此后新stream记录保该原私记录地址、成功状态与failed
位，并检查原S2/config/read身份；不能调用旧receipt的“仍未初始化”data合同来刷新
ready事实，也不改旧public receipt使它容忍接纳后的字段变动。真实preflight失败或
之后被caught攻击毒化的failed位仍拒绝。新的admission token证明具体合法转换，
旧成功事实只证明之前确实发生过原getState，不自行升级成持续Source。

### 原 getTuple 的自有转换点

此窗不能只固定 getTuple函数地址后仍声称其所有内部调用已固定。stream私分支采用
本模块 class evaluation捕获的同原执行图：原 entered/validate/guard/context/tracked/
finishDrain，实际 Scope/Saver/host原 own data方法及receiver沿ctor facts选择，原
SqlJsSaver getTuple方法在未知callback前固定。同原参数、完整校验、full次数、真实
查询和失败关闭保持；普通/旧invoke仍原dispatch。不得接受外部 inspector证明它们。
若这一执行图需共享lexical函数正文，旧generic调用保持原dynamic行为。

精确转换顺序如下，不设置新公有stage属性：

1. 原preflight分支先选，返回undefined且不登记namespace/admission。stream非preflight
   分支检查自己的iteratorClaimed及entered context，然后完整原validate(config,true)。
2. 在原 namespace赋值处同步保存该实际值/descriptor。原initializing实际工作与
   tracked票创建、原Saver读取及完整tuple config/checkpoint验证顺序保持。私record只
   保存本实际Promise；后续调用不能用同值新Promise或晚字段值刷新。
3. NativeRead按原路径产生、实际host.admit原callback执行，仍保原 reads.delete finally。
   Scope token不保存NativeRead为后续权限，也不延寿它。拒绝、任意reason、读退休或
   callback reentry使本stream record failed且照原Scope.close/quarantine规则处理。
4. 原 entered与actual binding.assertCurrent仍完整执行。只用原返回binding；其物理
   checkpointThreadId/namespace仍与本authority/namespace严格核，原所有字段规则不减。
   在原binding赋值与实际delivery创建/赋值处记录精确地址及flags。
5. 所有这些原callback返回后，再纯核 opening、operation/Core/config、namespace、
   initializing/actualbinding/delegated/fields与signals；此时才保存opaque admission。
   token私WM记录这些自产地址，snapshot/native成员沿真正原Restore/Producer保存，
   绝不从当前结果、消息ID、UI bucket incarnation补造。

后续getTuple原validate/read/write流程保持。合法重复读取沿同私记录，不重mint首次
admission。只读admission reader先Scope/op私表exact门，再原全部data tail；没有
成功记录返回undefined，未知/foreign0callback，真实字段变更/closing/reentry sticky。
它不调用Source/SQL，不返回可执行外部guard，不授权caller写checkpoint。

### Host 完成记录、双私消费和 once activation

`mods-conversation-shared-invocation.ts`在实际admit最后原assertCurrent返回后的词法
行自造私 `HostAdmissionCompletion` 空token。record完整固定实际Domain token/factory/
agent/graph/Scope/Producer proof与原view/Host/Tools/Runtime/authority。既有Domain私表与
真正Producer reader及原Tools installation都须命中；phase/view形状不补资格。
普通无stream pending的admit不创建这个新token，原两full与Tools调用次数保持。

新增只读消费者（签名限定exact object地址，不接受callercallback）：

```ts
readFunctionConversationSharedNativeHostAdmission(
  domain: FunctionConversationSharedNativeDomain,
  scope: FunctionConversationSharedCheckpointScope,
  operation: object
): Readonly<{
  completion: HostAdmissionCompletion
  binding: FunctionConversationGraphBinding
  assertDataCurrent(): void
}> | undefined

completeFunctionConversationSharedNativeStreamAdmission(
  domain: FunctionConversationSharedNativeDomain,
  operation: object
): SharedNativeStreamActivation
```

completion的operation不是Manager实参猜出来的：实际admit只通过State当前pending与
Domain自产association两私表取得它，再反查sameScope/factory/graph/SDK handle。State
association在新run开始、SDK执行前登记；从Domain public view手造association不合法。
unknown/foreign读取先miss，无Source；同真record wrongRuntime/Scope/Producer/closing
明确失败，不能fallback。闭包在第一次原full之前固定所需原data函数地址。

Scope原getTuple成功尾只能通知本次State固定消费者去完成activation；通知本身不
把caller stage置ready。消费者从双私表原记录自己读取Host completion和Scope
admission，不接token参数、view、binding或guard。须 exact completedProducer.binding
=== Scope实际binding，并核original Scope、namespace、Saver、authority、invocation、
database、Runtime target/owner/run/signal及图/安装关系。通过后从原view选full/data
原函数地址，保存一次空activation；第二次完成、caught reentry、表/字段变化均sticky。
所有最终data核晚于Host/Tools和Scope binding原full，publish后不再跑未知callback。

若Scope模块valueimport State构成不合适cycle，采用独立Main-free私routing模块承载
自产records和消费器，固定constructor/executor调用路径；不改为公有
register(callback/inspector)或bindScope setter。此布局须在具体源码前两审，不能因
循环难写而用ALS-first/sameSignal或公有receipt补认证。

### 两个来源缺口的固定布局补充（待重新双审）

上述“State先核”和“通知固定消费者”不能作为调用者约定。本窗选择现有Main-free
State模块自己持有全部handoff/association私表；不新增接受record/inspector的routing
注册器。Scope导入它的固定free函数，State导入Scope固定执行器，互读只发生在模块
初始化完成后，不在module顶层执行。所有free函数采用原function declaration；双方
初始化时捕原函数地址，调用固定Reflect.apply同原receiver。部分加载时先拒，不能
把未初始化表/函数当基准或在调用时从public namespace重新选函数。实际Worker构建与
ESM/CJS初始化都需Root验证；它们只含目前State已有的Main-free依赖，不导入Host/IPC/
Manager value。若实际bundle不支持此布局，先回到DES审修布局，不能添加setter替代。

State新增三张私表和以下具体消费者：

```ts
interface SharedStreamAssociationRecord {
  readonly pending: Pending
  readonly operation: NativeStreamOperation
  readonly factory: FunctionConversationSharedNativeFactory
  readonly domain: FunctionConversationSharedNativeDomain
  readonly scope: FunctionConversationSharedCheckpointScope
  readonly agent: object
  readonly graph: object
  readonly actualDomainRecord: SharedNativeDomainRecord
}
interface SharedStreamIteratorHandoffRecord {
  readonly token: SharedStreamIteratorHandoff
  readonly association: SharedStreamAssociationRecord
  readonly pending: Pending
  readonly graphOperation: NativePregelStreamOperation
  readonly coreOperation: NativeRunnableStreamOperation
  readonly actualS2: object
  readonly actualS3: object
  readonly actualS4: object
  readonly installedIterator: Function
  readonly iteratorOwner: object
  readonly iteratorDescriptor: Readonly<PropertyDescriptor>
}

// 只Scope运行在真正iterator第一行时能找到此原地址关系；不接token/boundary入参。
readFunctionConversationSharedNativeCurrentIteratorHandoff(
  scope: FunctionConversationSharedCheckpointScope,
  operation: object,
  graph: object,
  actualConfig: object
): Readonly<{
  token: SharedStreamIteratorHandoff
  coreOperation: NativeRunnableStreamOperation
  assertDataCurrent(): void
}> | undefined

// 私关联来自本State实际Domain构造词法点，不收callee或caller record。
readFunctionConversationSharedNativeCurrentAssociation(
  scope: FunctionConversationSharedCheckpointScope,
  operation: object
): Readonly<{
  domain: FunctionConversationSharedNativeDomain
  factory: FunctionConversationSharedNativeFactory
  agent: object
  graph: object
  assertDataCurrent(): void
}> | undefined
```

association producer不是新export。State的真实stream执行器按固定原
`runSharedNativeFactoryDomain(actualFactory, actualScope, ownLexicalBody)`执行；在该
本模块body首同步行、SDK execute前，用Domain新增readonly birth reader从原
domains/domainFacts表核 actualDomainRecord/token/factory/Scope，再由State创建
association，按SDK operation与domain token两key保存。这个reader不给callback：
`readSharedNativeDomainBirth(domainToken,factoryToken,scope)`只核原Domain ctor WM/全
facts后返回原record地址。State同时核自己的current pending/operations map、actual
installer、sameScope/factory/agent/graph/SDK handle，且同op未关联。Caller自造Domain或
另一个genuineDomain不命中State association，不能把“runDomain成功”认成授权。

handoff producer同样不是新export。Lifetime真实observed iterator第一行进入State
后，State在首full前占iteratorClaimed，再读取真Core boundary及它自己的Graph operation
reader，完整核SDK dispatch/S2、Graph.child/Core token、Core.options===S3、S4与
selected Lifetime安装私origin。核自己的existing association及Scope receipt原read
地址后自造token/record；按pending与coreOperation私key保存。没有此private producer
动作的另一真实Core词法点，或同graph直接普通Core执行，都不存在这个handoff。

随后同一同步栈内立即调用Scope claim，不在mint与Scope消费之间运行新的unknown
callback。Scope claim必须自己调用上面的captured State reader，然后也自行读当前
真实SDK Core boundary；两边coreOperation/S4/receiver/config/iterator facts严等。
State reader自己复核 current pending/operations/association双私关系、原Graph.child/
Core boundary、SDK operation与installation原flags，不能仅把调用者给的四地址当证。
unknown/foreign返回undefined；已匹配真实pending却wrong Core/config/graph或重复
claim，两个相关record永久失败。Scope保存同私token/data函数地址；后续admission
纯tail再次通过State reader的固定同record closure核当前私关系，不按later Core栈
复活权限。后续调用只允许之前固定的data closure，不让旧token重claim。

Host admission末也不从公有phase选择operation。SharedInvocation实际词法完成者先
用captured `readFunctionConversationSharedNativeCurrentAssociation(scope,operation)`
选既有关系；operation由此State当前private pending消费者取得，不由参数伪造。
新增 `readFunctionConversationSharedNativeCurrentAdmissionOperation(scope,domain)`
只从 current pending/operations/association两私表返回原opaque SDK operation，
没有matching association返回undefined（旧invoke继续无新票）。同原Domain但换图/
scope/runtime失败，不能fallback成旧invoke。Host completion的私WM归原
SharedInvocation模块；State只是读这个词法产生的完成事实。

Scope getTuple最后纯尾先调用captured current-association reader选自己op的exact
domain，然后调用captured `completeFunctionConversationSharedNativeStreamAdmission`
固定原函数，两个入参只domain token/operation；不传receipt、view或callee。此函数
由State拥有：先占本pending activationReading/used，自己读取Scope admission私表及
SharedInvocation completion私表，完整比较同actual binding/Producer/图与已固定handoff，
原纯关系通过后才创建activation。两张真实成功表尚未齐时不能完成，提前直接调用使
对应真pending failed；unknown/foreign op零Source，不能注册新association。State不能
因Scope“通知成功”省掉自己的双私读取，Scope也不能接受外部消费者回调。

这些cross-read free函数都在模块evaluation固定地址，不收传入函数/record或
registration；函数自己来源是上述真实自产WM，而不是某个export调用成功。原
getTuple/admitted传参和full次数不变，只追加privatemint及纯消费者。必须新增另一
真实Core boundary的反例（包括同graph的independent operation）以及premature
public complete/自造Domain/replace free namespace而原捕获函数仍拒的反例，证明
这两处不是caller约定。未知Scope/op/Proxy在私key门之前零trap，不能把SDK普通Proxy
构造的反射行为也冒称0trap。

### 本窗生产与测试定界

精确生产候选五源：Scope newstream表/执行与原getTuple native私分支；State关联/消费；
SharedInvocation实际admit末completion；Domain私association；新Main-free routing仅当
解决运行cycle确需（不含Desktop/Host valueimport）。Lifetime/SDK/private stop八项在
Official窗口冻结后再接，不修改SDK27目标或原工具outcome。

新增独立 `conversation-shared-checkpoint-stream-admission.test.ts`，使用真Manager/
parent StateGraph、sameTask/SqlJsSaver、原scopeHost factory/registration与实际Native
restore。不stubtuple/proof。八个精确test类：真实新接纳全过程；真实历史恢复及物理
point/membership；preflight仍无namespace/Saver读；normalize中直接getTuple抢接纳0；
lastHost/Tools回调caught reentry；binding full最后Parent退休（首error单独保存）；
未知/foreign/op/configclone/Proxy前置0Source；held original Saver/admit拒undefined或
ownerabort时truePromise/finally/Scope pending排空。逐类展开定义数冻结时准确计数。

同窗State独立真实integration核completion早于binding时仍无activation、成功后exact
binding双join与callback次数原样、latefields/getter0/sticky、Scope关闭后activation拒。
provider/frame仍0的接纳fixture不能拿来冒充generator正常模型输出；真实模型的输出
与cancel drain门在下一后台/values窗继续。该窗口通过也不是用户stream最终完成。

### completion 依赖的修订：Main 消费，纯模块只保存执行事实（待两审）

上节让 State 读取 SharedInvocation 的 completion 私表不可实施。实际依赖是
SharedInvocation → conversation-shared-restore → db/index → storage → Electron；
把 reader re-export 到薄模块仍保留该 value 链。这里撤回 State 拥有 completion
消费者、Scope getTuple 尾部通知消费者和新增 routing 注册器三项，不放宽原纯模块
边界，也不把“稍后通知”当合法来源。

新的分工是：State 仅保存实际 SDK operation、Domain association 和 iterator handoff
执行事实；Scope 仅保存真正原 getTuple 的合法 namespace/Promise/binding/delegated
转换事实。实际 Host completion 与输出 activation 都留在 SharedInvocation 模块，
由它本来拥有的完整 admit 词法流程与未来受控 stream driver 自产。Domain 只增加
readonly birth reader，不保存可由公有 setter 写出的完成票。这些数据不会让 State
或 Scope 授予新的业务 Source、Producer、消息或 checkpoint 写入权。

精确接口改为以下分层。State/Scope 的原候选 association、handoff 与 admission
reader 保留，但删除 `completeFunctionConversationSharedNativeStreamAdmission` 对
SharedInvocation 的导入以及调用。Main 以下两个 producer 都是模块内部函数，不
export，不接受 caller 函数、receipt、view 或配置中的 stage：

```ts
interface HostAdmissionCompletionRecord {
  readonly domain: FunctionConversationSharedNativeDomain
  readonly operation: NativeStreamOperation
  readonly association: SharedStreamAssociationRecord
  readonly scope: FunctionConversationSharedCheckpointScope
  readonly factory: FunctionConversationSharedNativeFactory
  readonly agent: object
  readonly graph: object
  readonly producer: FunctionConversationSharedProducer
  readonly original: FunctionConversationSharedProducerView
  readonly view: FunctionConversationSharedNativeDomainView
  readonly binding: FunctionConversationGraphBinding
  readonly host: FunctionConversationNativeHost
  readonly tools: FunctionConversationNativeTools | undefined
  readonly assertProducerData: () => void
  readonly assertViewData: () => void
  readonly assertHostData: () => void
  readonly assertToolsData: (() => void) | undefined
  reading: boolean
  failed: boolean
}

// 实际 admit 最后一个原 assertCurrent 成功后，同步自产；没有新 export。
function finishActualSharedHostAdmission(/* 只使用该词法流程自己的局部变量 */): void

// 只由实际安装的 Main stream driver 的局部循环调用；没有新 export。
function activateActualSharedStreamOutput(/* 只使用该局部 driver/pending */): void
```

上述示意中的局部函数不接外部对象注册。实际实现可把它们直接写在原词法正文；
completion 私 WM 的 key 为实际 operation，value 固定原 association/domain 的地址，
另以 domain token 保存同 record，两个 key 都必须命中。没有 association 的旧 invoke
继续原样，不创建新 completion。命中本次真实 operation 但 Scope、factory、graph、
binding、runtime 或生命周期不等时严格拒绝，不退回普通路径。

`finishActualSharedHostAdmission` 必须在第一未知 full 之前固定实际本次所需的原
Producer/view/Host/Tools data 函数与 receiver；未知回调之后不能重新选择当前函数。
实际末尾保持原 `assertCurrent → attachSharedTools（如有）→ assertCurrent` 的原
full 次数和顺序，之后只以这些固定函数核原 data tail，保存同 proof/original/view/
runtime/binding 关系，才自产空完成 token。这些函数的真实来源分别仍由各原模块
private reader/constructor 确认；缺少只读原 Host/Tools data seam 时先另作精确设计，
不能保存一个当前 public method 就声称它是真实私记录。completion 不借 phase=ready
或 view.shape 单独认证接纳，也不刷新任何 NativeRead 生命周期。

Scope 的成功尾只在自己的私表保存 admission，不运行 Main 回调。原 initializing
Promise 在真正词法赋值点固定，NativeRead 原 finally delete 保留；原 binding FULL、
checkpointThreadId/namespace、actual delivery、所有 data facts 完成后才自产 admission。
它只是“这一真实 getTuple 转换完成”的事实，不是 ready、Source 或输出许可。

后继 Main driver 的真实调用点限定为：本模块安装的受控 stream shell 保存其真实
factory/agent/graph/Scope/operation/domain，驱动一次 actual inner iterator.next，
await 原 next Promise 的本次结果；取得结果后、任何 frame FULL、分类、复制、writer
或返回前，先运行 `activateActualSharedStreamOutput`。它从 Main completion 双私表、
Scope admission 私表及 State association/handoff 原 reader 自己读取并完整 join，
不得把 next.value、公有 phase、配置 signal 或第一次 frame 当来源。

Main driver 与其 iterator/next 方法必须是实际已安装的本模块自产关系；不能接受
任意 driver 或 caller callback 建立 record。它的输入与 operation 来自已固定的真实
App/SDK 接线，不能靠当前同值参数注册。原 frame Source 仍来自实际 Producer/runtime/
Node/Calls/23 校验；activation 不代替任何一个原 full 或 data 检查。首次 callback
前占 activationReading/used，异常包括 undefined 都保存 sticky，未知 op/clone/foreign
在私 key 门前零 callback；真实已知却失效不能 miss 到 generic。

这个调用点只保证**输出前**已经双私接纳，不宣称 activation 在 generator/model 开始
之前发生。原模型/节点业务执行仍由已经完整执行的原 admit/Host/Tools 规则授权；
其行为与旧 invoke 一致。若下一窗口还要求在模型前使用新的 stream ready 权限，
必须另外列出真实 controlled node 接点并双审，不能从 next 返回反推提前授权。

最小先行 Scope 接纳窗口因此不开放输出、不实现整个 driver，也不产生 output
activation。它只交付 association/handoff 与 getTuple admission 两类执行事实，并由
Main 原 admit 词法完成 record。测试可在原 getTuple 成功 binding/delivery/data 尾
之后以本 foundation 自产的私 stop 结束实际 generator 路径，保真实 outer/inner
Promise finally 与 Scope.pending 排空；不手调 admit/getTuple 或造配置代替真正 SDK
checkpoint 调用。私 stop 的选择必须来自本模块 foundation 执行器的私 operation
关系，不能接受 caller stage/布尔参数开放或跳过后续执行。

这部分测试只断真实接纳事实和 provider/frame 0。下一 Main driver 窗口才证明完整
values/updates、历史、model/provider、Source、copy、checkpoint ACK 与输出前 activation，
再持续完成 messages/Command/SSE；不能把首窗停止当产品 stream 完成。

更新后的最小生产候选四源为 Scope、State、SharedInvocation 和 Domain birth reader。
State 不 import SharedInvocation/Host/IPC/Manager value；Scope 不 import Main completion
模块、不接消费者参数；SDK27、Lifetime 已冻结 observer 正文与旧 invoke 路径不改。
与这四源同时新增真正 Manager/StateGraph/Saver 接纳 fixture，并保原 source reentry、
物理 membership、NativeRead 退休、held Promise/abort/finally 和晚字段 getter 零执行。
全部尚待本段两审；未编辑 Scope/admission 生产源码。

### Main driver 的原词法安装与 Host 纯数据接缝（待两审）

Main driver 不是未来传入的回调。选择已有 `wrapSharedInvocation` 的真实安装链：原
`createFunctionConversationSharedAgent` 创建 genuine Agent →
`installSharedInvocationGraph` 完成 getState/Observer/Factory 私接线 →
`wrapSharedInvocation`，以及原 `deriveSharedNativeFactoryRecord` 的 genuine child
完成相同安装后调用同 wrapper。新内部 `createActualSharedNativeStreamDriver` 仅在
这个 wrapper 的 factory 分支同步自调用；不 export producer，不接受 stream fn。

它在 wrapper 返回 Proxy 之前创建实际 method closure 与本模块私
`streamDrivers: WeakMap<Function, SharedStreamDriverInstallation>`，并按实际 agent
保存同 installation。record 固定本次 agent/factory token/original factory record/
actual graph/source derivation/original capture/State installer 与 sealed Lifetime observer
关系，所有 optional 初值为 own undefined。原 Factory/Domain/State private reader
必须 exact join；当前公有方法、同 UUID/config 或相同 callback 不能创建此 record。
返回 Proxy 的 `get("stream")` 在读取 target 公有 stream 属性之前选择该私 closure；
不把 Reflect.get 得到的 late method 当基准。原 invoke、withConfig 和 generic 没有
factory 的 stream 原行为保留。child wrapper 自产自己的 closure/record，不复制父票。

新 method 的 receiver 规则沿原 wrapper 的 bound-target 行为：执行固定实际 agent，
不使用调用者 this 改换图。首句在任何 capture/resolve/full 之前固定原 input/config
descriptor 基线并创建本模块自己的 pending。真实一次 claim 先于未知 callback，
reentry/caught reentry 保存 failed/reason（包括 undefined）；后续只从 State 本次
真实 SDK operation 与原 installer 的私表读取 handle，不注册 caller 提供的 op。
SDK 原默认合并/初始化、getState、Graph/Core 配置转换仍实际执行各原次数，不在
Main 重写 defaults/schema，也不再调用 public agent.stream 或 graph.stream 制造第二次
执行。受控底层执行仍是 State 选择的原 SDK/Graph executor 与 sealed observer。

每次 driver call 的输出 iterator 由该 closure 自产，另两张 Main 私 WM 保存 shell
和 iterator → same driver/pending；next/return/throw 方法自造并在调用者见到之前固定。
第一次 next 首同步占 opening/reading，保存本次实际 underlying iterator 与原 next
方法/receiver/flags，在任何未知 next 代码前登记 deferred 及 actual work ticket。后续
需求串行化，不多调用原 next；不能据此否认 SDK 自己原有预取。原 Scope run 包住
该真实驱动的完整期间，Scope/Domain/State 上下文不是输出来源替代物。

实际内层 next Promise 完成后，Main 同一 driver 循环先核 next 结果容器，再执行
本模块内部的 once output activation，之后才进入本帧完整 Source、origin 分类、
copy、23/A-B 和返回。这一步不从 next.value 建 origin：activation 自读既有私
completion、Scope admission、State association/handoff，完整比较同 operation/
factory/agent/graph/Scope/binding/config/owner/runtime。每帧 Source 之后还重新核这
些 memory/data facts；全部原返回分类/完整 raw/独立 copy/container 尾保持。
首返回 frame 前的 activation 不称模型前 ready。模型前原 getTuple 初始化实际完成
了如下因果链，原业务资格来自这条原链，全部照旧执行：

```
actual SDK iterator setup 调 Scope checkpointer.getTuple
  → 原 validate/namespace + 原 tracked initialization Promise
  → 原 Saver getTuple + 原 tuple/NativeRead 检查
  → 原 scopeHost.admit → completeActive/registration/Producer
  → Manager admitted 原 binding/Producer 私关系
  → SharedInvocation 原 admit Host/Tools 两个最终 FULL
  → await admit 返回同 binding
  → Scope 原 entered + binding FULL + checkpoint/thread/ns
  → 原 binding/delegated 赋值 + NativeRead 原 finally delete
  → 本 Scope admission 私事实完成
  → 原 getTuple Promise 兑现，原 SDK setup 才能继续模型
```

这条链没有新 external callback。`initializing` 的 Promise 身份在真正
`.tracked(...).catch(...)` 赋值行固定，不能在 tracked delegate 内猜该字段已经写入。
委托可先进入真正 Saver，故 initialization latch 在委托前占；实际返回 Promise
选定后先保存原地址，再记录原 initializing own data/flags。Scope 保存的 namespace/
binding/delegated 只能来自上面原赋值点，不接受 driver 实参补写。Stop/cancel 仍必须
唤醒无需求的真实驱动，观察其 actual next、return/throw、run finally 与所有原节点/
Host/Tools/Keeper 真实 drain，最后才 Scope pending 排空；shell 返回不当 resource 完成。

Host 当前一般安装 reader 核 `graphInstallations`，Shared admission 的新 Host 没有
调用 installGraph，故本窗明确不使用它冒充 Shared ready。新增精确 readonly reader
放在实际 `function-conversation-native-host.ts`：

```ts
readFunctionConversationNativeSharedHostDataCurrent(
  host: object,
  runtime: FunctionNativeConversationRuntime,
  factory: FunctionConversationSharedNativeFactory,
  domain: FunctionConversationSharedNativeDomain,
  graph: object,
  tools: FunctionConversationNativeTools | undefined
): Readonly<{ assertDataCurrent(): void }> | undefined
```

private producer 是原 `createFunctionConversationNativeHost` 自己：在现 derivedHosts
同 Host key record 中创建固定 `readSharedData` closure，并捕原 closed/sourceLatch/
nativeTools/sharedToolLedgers。它只读这一本次 Host 的私变量；不接受 guard、inspector
或后注册 token。runtime 的原 own data/proto/flags 在该构造首 unknown callback 前
尝试 descriptor-only 固定；generic Host 不因这项尝试立即改变旧行为，但缺少原
own-data基线的 Host 不具备这项新 Shared completion data seam，命中 native pending
却不合格必须拒，不能走 generic fallback。实际自产 frozen Host 的全部原 own fields/
proto/flags 在原 Host literal 构造处保存；不是收到公有 Host 时建立新基准。

free reader 先 fixed WM 查 Host，unknown/clone/Proxy 返回 miss 零 trap；known Host
wrong runtime 明确失败。closure 同时核 closed=false/sourceLatch.failed=false、原
runtime refs/flags、当前 Domain birth 私事实的 exact factory/domain/graph/Scope 和
view.host===本 Host、view.runtime===原 runtime。Domain birth reader 只核自身私 WM/
fields，不调用公有 view.assertDataCurrent；completion 的 Main producer另与 State
association 精确 join，因此 caller 另造一个 genuine routing domain也无本次完成票。

有 tools 时，使用模块 evaluation 固定的原
`assertFunctionConversationNativeToolsBinding(tools, graph, factory)` 与原 undefined
receiver；该原 reader 只读 toolsBindings/assertStructure，不新增 FULL。返回的原 bound
必须使本 Host nativeTools WM 中 same bound → same ledger 且其 sharedToolLedgers
原 Set intrinsic has 命中，证明原 attachSharedTools 真正完成。无 tools 时固定 absence，
不能 late 添 ledger。所有原 Host/runtime/Domain/tools函数和 flags 变化均 sticky。
最后 runtime FULL callback 可以 close Host，故 completion 最后纯尾必重核该
Host 私 closed/latch/attachment closure，不能只核公有 view/data或 ready phase。

Producer 的原 `assertDataCurrent` 包含 fresh destination SQL，本窗不能把它改名为
零 callback 的纯内存尾，也不删除其原调用。若 completion/activation 需要证明 Producer
本身没有退休，Main 从 Restore 新 readonly 私 producer-local reader 读取该本次原
token/view/Active/completed/reservation/source 字段事实；该 reader 只复用原
activeDataReaders 的内存/authority/signal/Scope/source-ref尾，排除 registration/
destination SQL，不授 fresh permission。exact token/authority 门先于所有字段；
Source/full、原 Producer.assertDataCurrent 与所有 destination/registration fresh SQL
仍在原 admit 与每帧原 FULL 接点保留。新 local reader 的私记录仅由原
completeFunctionConversationSharedActive 词法创建，不能接受传入 view/register，
成功/失败/退休位与原 producer record 同步。该 leaf须单独两审及真实 history/fresh/
retire反例，不能把未知 fallback data 方法称 pure，也不能为少一次 SQL 改旧 full。

因此这一精确后继候选最多六个 named source：Scope、State、SharedInvocation、Domain
birth reader、Host 新共享 data reader、Restore 新 producer-local readonly reader。
工具只消费既有原 private reader，不改 SDK27/Tools安装执行或原业务次数。
Scope 接纳基础先交付 execution facts，Main driver/output 使用仍待下一精确源票及
完整模型/所有 shapes/Electron验收；两类票不互相替代。当前这些生产均未修改。

### 撤回旧 Lifetime 分支及首次 getTuple 方案

上版第七源分支建立在错误的 Lifetime 阅读上，现整段撤回。当前真实
`function-conversation-native-lifetime.ts:615–617` 在无 Source 或 Source.graph 不等时
直接 `original.call(graph, input, options)`；同图 Source 才执行原完整 Source/observer
正文。普通调用继续这两条原路。本窗不能把 Source 缺席称为执行失败，也不能把
公有 fromInstallation 产生的 same-graph caller Source 当作 Shared association。

仅 State iterator claim 和 Scope ALS 不能证明后续 getTuple 的调用来源。真实 SDK
`pregel/index.js` 的 `_validateInput`、`_validateContext` 与 `handleChainStart` 都在
实际 iterator entry 之后、`createAndRunLoop → PregelLoop.initialize` 之前运行未知
代码。它们可以对真实 Scope router 提交另一合法 namespace 的 config，甚至直接调用
公有 Loop.initialize。旧“首次合法 getTuple”方案会先运行 Saver/admit，再拒正版调用。
以下 SDK 词法方案替代该来源部分；没有两审之前不修改 Scope 或 SDK。

### 真正 Loop checkpoint 调用的版本锁方案（待 DESIGN1 / DESIGN2）

已读取当前批准的 Graph1.2.5 实际源码：`dist/pregel/index.js:1171–1283` 与
`dist/pregel/loop.js:128–150`。原 caller 是 iterator 局部的
`createAndRunLoop`，其参数对象由同一正文依原顺序读取 `validInput/config/checkpointer/
this.nodes/channelSpecs/outputKeys/this.streamChannelsAsIs/store/cache/stream/interrupt/
runManager/this.debug/this.triggerToNodes/durability`。原 static receiver 是真实
`PregelLoop` 类。Loop.initialize 自己依原 scratchpad counter、nested/read 与
checkpoint_map 规则派生 `config` 和 `checkpointConfig`，然后原样调用
`params.checkpointer?.getTuple(checkpointConfig)`。不能由 App 重建这一派生值。

SDK 新功能只证明以上两次实际调用，不证明 Host/Tools/Producer、ready、Event 或消息。
普通调用不带任何私参数，保原表达式、默认值、回调、namespace counter、预取和
错误处理。新增 helper 不接受 caller callee、guard、stage、initializer 或注册函数。

#### 1. 真实 iterator entry 自产 body ticket

Graph 原 private operation 增加始终 own 的 `checkpointIterator/ checkpointStarted/
checkpointBody/ checkpointFailed` 初态字段；其中 optional 字段明确为 undefined。
仅以下固定 SDK producer 可创建一次 empty opaque body ticket：

```ts
// 同步真实 Core selected-iterator boundary 内调用；返回原 async generator，未启动 body。
createNativePregelCheckpointIterator(
  operation: NativePregelStreamOperation,
  graph: object,
  input: unknown,
  iteratorConfig: object
): AsyncGenerator<unknown, unknown, unknown>
```

producer 首先只读 Graph operation WM，然后读模块 evaluation 固定的原 Core boundary
reader；必须 same graph/input、Graph.child === Core operation、Core.options === 原 S3、
Core.actualConfig === 本 S4、两边 selected observer fn/owner/全 descriptor flags 严等。
同 operation 的 starting/used 在任何参数反射或外部 callback 前占用，caught reentry
与任意 reason（含 undefined）均共用其 failed。未知/clone op 在 private WM 门先拒，
不把任意 SDK Proxy 的构造反射行为冒称零 trap。

producer 从该真实 S4 的 own-data `configurable` 及其 own-data
`__pregel_checkpointer` 保存完整 descriptors 和 exact receiver，不接受传入 receiver
作为来源。App State 在调用它之前，通过 Scope ctor 私 tuple-origin reader 自己核同
值 === 原 Scope.checkpointer。此 receiver 是 Scope 本来自产的 router Proxy，不能用
types.isProxy 一概拒；它的 private handler 没有对外注册/替换入口。

SDK 再提供 readonly `readNativePregelCheckpointIteratorOrigin(operation)`：WM 首门后
返回原 graph/iterator fn/receiver/descriptor 与内存 data closure，只消费模块 class 完成时
的原事实，不接 fn 入参。Lifetime 用它确认原安装捕获的 iterator 确为 SDK 将执行的
原函数；actual selected observer 仍由原 Graph/Core 两私表与 installation证明，不能
以这个 raw origin reader 给任意 wrapper 来源。

SDK 自己选模块 class 完成时捕获的原 Pregel `_streamIterator` fn/receiver，以固定
Reflect.apply 调一次，第三参数是刚才私造的 empty ticket。签名保持 async-generator：
`async *_streamIterator(input, options, nativeCheckpointTicket = undefined)`，默认第三参
使原 length 仍为 2，普通两参语义不变。ticket 不在 input/config/metadata/ALS/公有
settlement 中，也不传给验证器、callbacks、Store 或 Loop params。

原 generator 第一条语句消费 ticket：SDK 自读 body WM、operation/graph/input/S4、
原 iterator fn/proto/flags，首 unknown 前 occupied/consumed；失效 sticky。不存在或
非此自产 ticket 不可开启 native body。直接 public `_streamIterator` 仍是普通调用，
不获得 body record。body 的私局部持有它，后续异步 await 不依靠 ALS-first 重认来源。
普通 extra third argument 未命中 private ticket 时仍忽略，保原 JavaScript 两参函数
忽略额外参数的语义；只有已知 private ticket 的错误 tuple/重复消费才 sticky 拒。
返回 shell、进入 body 与真正 generator finally/drain 是三个不同事实；本 helper
仅创建原 shell，不声称 physical drain。App 保原实际 next/return/throw Promise 和
原 generator finally 的独立 retain/drain。

Lifetime 仅在 State genuine handoff 返回时消费此 producer：State 先占真实 iterator
claim，核 Installer/Pending/Domain/Scope receipt 与 Graph/Core/immutable observer 双私
表后自产 handoff；Lifetime 再核自己 observerGraphs/observerRecords 和 captured original
iterator === SDK 原 iterator origin，在首原 Source full 前创建一次原 native iterator。
无/foreign Source 的原分支返回这个真实 iterator；same-graph Source 保原 FULL/shape/
observer wrapper、原时机和实际参数规则。首窗若 same-graph Source 会修改 S4（例如
messages 增补 updates），则该新 foundation 明确拒该额外 shape，不能把改造 config
当原 S4；values/updates 正路覆盖无 Source 与 same-graph unchanged-options Source。
普通非 handoff 两条分支完全原样。caller Source 不能代 State association 或完成票。

#### 2. createAndRunLoop 私局部交固定原 Loop.initialize

native body 的 `createAndRunLoop` 首句从 body record 自造一次
`LoopInitializationRequest`，先置 starting，再做 callee/data 选择与原 params 对象求值。
故 this.nodes/streamChannels/debug 等真实 getter 中的同步 direct/Loop.initialize 抢读，
无法借一个尚未占用的空 slot。请求未写到 params，也不暴露在回调 arguments 中。

native 分支先用 Loop 模块自产的固定 origin helper 核原 static initialize data
descriptor/fn/class receiver/prototype/flags；拒 late accessor/fn replacement，不能把当时
公共属性重新认作原函数。随后按原顺序构造 params 字面量一次。构造完再由 Graph
本模块 private producer 把 exact params pointer 与其完整 own descriptors 绑定到自己
的 request，并立即调用 Loop 原 fixed executor。没有 caller params 注册函数。
ordinary 分支仍使用原 `PregelLoop.initialize({ ...原字段... })`。

Loop 的 native fixed executor 自读 Graph private request free-reader，再以本 Loop
module class 完成时捕获的原 static initialize fn、同 PregelLoop receiver、同 params
及第二 opaque request 调一次。原 initialize 第一条语句消费该请求，核自己当前
class/fn/params 与 Graph body 私关系，先 reading/used 后才原 config/scratchpad 求值。
第二私参写作 `nativeRequest = undefined`，保原 static initialize.length === 1。
bootstrap/public `PregelLoop.initialize(params)` 没有 request，走原普通语义；它传
Scope router 时仍被 Scope native gate 在 Saver 前拒。clone params/复制 ticket/另一
真实 graph operation 不能消费已有请求，也不能重新登记请求。

这个相互读取不允许 late public namespace/getter。ESM 双边 free function declaration
在模块完成前即可固定地址，但执行必须两边 initialized === true。CJS 双边互读函数
以不可写、不可配置 own data export 在 require 对方前发布，消费方固定同地址；Loop
helper 只在本 class 完成后使用捕获的原 initialize，Graph 不读取部分加载的公开
PregelLoop 值作基准。index-first 与 loop-first 都须实际 golden。不能用 setter补循环。
新 CJS free helpers 本身使用函数内 strict directive，禁止 `.caller/.arguments` 暴露
尚在同步栈内的私 request/params；不把整个官方 CJS 文件改成 strict、影响旧普通函数。

#### 3. getTuple getter 前占位，真实 member/argument 后短边界

native initialize 的原配置转换、scratchpad++、checkpoint_map 查找及 namespace split
全部原位置保留。到原 getTuple 表达式前，private initialization record 先占一次
checkpointCallStarting，随后依原顺序读取真实 `params.checkpointer`。必须 exact ===
body 从原 S4 保存的 receiver，且那些 S4/params descriptors 当前仍等；错误 receiver
在其 getTuple getter 前拒，不允许 unknown _defaults 替换为自己的 checkpointer。
native params 在原 literal 创建后就私 pin prototype/全部 own data descriptors，初态或
晚出现 Proxy/accessor 均不执行 getter。真正 derived checkpointConfig 在 Loop 原转换
完成后 pin exact pointer与 root/configurable/checkpoint_map own data/flags；不深读 callback
对象或把 sibling 可继续推进的 scratchpad counter冻结成恒值。陌生 request在私门先拒，
不因它的坏 params 毒化另一 operation。

对该实际 receiver 仍只求值一次 `.getTuple`，并只取该局部实际 checkpointConfig 一次。
起点票覆盖 getter 执行期间，getter 中的 direct Scope 调用没有下面的 call boundary，
public Loop.initialize 又没有 body/request，均不能抢真正票。真实 Scope router 的
get('getTuple') 始终返回 ctor 词法的同 readTuple；SDK 不调用 caller 提供的函数。

member/argument 完成后，在无新 callback 的相邻语句自产 checkpoint-call boundary，
pin actual Graph/Core operation、body/request、original static receiver、exact params、
actual checkpointer receiver、selected getTuple fn 及派生后的 actual checkpointConfig。
以模块 captured Reflect.apply 对刚才实际 fn、同 receiver、单原 config 调一次。
boundary 仅本次同步 apply 栈有效，在 finally 原地址 pop；异步成功不延长栈来源。
实际原 getTuple Promise 在任何后验门之前固定保存并用 captured Then 观察，rejected
undefined/null 都记录原 reason。后验拒不能把已经开始的 Promise 从任务中删除。
原 getTuple 返回 undefined/null 时仍保持原 `saved ?? fallback`，不将空返回改成异常。

SDK 新的公开 API 只有 exact 私事实消费/读取，不接受注册：

```ts
interface NativePregelCheckpointCall { /* opaque empty object */ }

// Scope readTuple 第一条同步语句使用其 ctor 私固定值；首消费占位后才返回。
claimNativePregelCheckpointCall(
  checkpointer: object,
  checkpointConfig: object,
  selectedGetTuple: Function
): NativePregelCheckpointCall | undefined

readNativePregelCheckpointCall(call: NativePregelCheckpointCall): Readonly<{
  operation: NativePregelStreamOperation
  coreOperation: NativeRunnableStreamOperation
  graph: object
  input: unknown
  iteratorConfig: object
  initializeParams: object
  initializeReceiver: object
  checkpointer: object
  checkpointConfig: object
  selectedGetTuple: Function
  assertDataCurrent(): void
}> | undefined
```

claim 参数中的函数只用于 pointer 比较，SDK 既不调用它，也不将它写成新来源基准。
unknown/foreign 先 identity miss 不 poison unrelated record；同真实 boundary 已消费、
caller/callee/config 失配或已 failed 则其 execution sticky 拒。返回 record 的 data tail
自己核 SDK 私表和原字段/flags，不读取传入 call 属性，也不代表业务授权。

#### 4. Scope 自核 SDK call 与 State association

Scope ctor 把自己已有 `readTuple` closure 和原 checkpointer Proxy 地址保存到新私
tuple-origin record。free readonly origin reader 只从该 ctor WM 返回冻结的原两地址，
不接受 callee 参数登记。State 首 handoff full 前固定该 reader与其 data tail，并核
SDK S4 中真正 own checkpointer 值同地址。Scope router 不能 late 读取 `.getTuple` 或
class private method来重新捕原；native 分支执行图使用模块原固定闭包。

```ts
readFunctionConversationSharedCheckpointTupleOrigin(
  scope: FunctionConversationSharedCheckpointScope
): Readonly<{
  scope: FunctionConversationSharedCheckpointScope
  checkpointer: SqlJsSaver
  originalReadTuple: (config: RunnableConfig) => Promise<CheckpointTuple | undefined>
  assertDataCurrent(): void
}> | undefined
```

该 reader 只有 ctor 元数据与原 Scopeopening 全数据尾，不执行 tuple/namespace/Source。
originalReadTuple 只返回 readonly 地址供比较，不因读到它而授予执行资格。

Scope readTuple 首同步语句区分其原 preflight execution 与已登记的 native checkpoint
association：原 preflight 完整路径保；native association 时先占自身 reading/used，
用 ctor 原 checkpointer/readTuple 与本 config 调 SDK claim。缺 boundary、另一 namespace
config clone 或 public initialize 的 config 即失败，发生在原 validate/Source/Saver/admit
之前。known pending 的失败保 sticky，caught direct 抢读后正版也不能复活。

Scope 自己再调用 State 固定 free-reader：

```ts
readFunctionConversationSharedNativeCheckpointHandoff(
  scope: FunctionConversationSharedCheckpointScope,
  call: NativePregelCheckpointCall
): Readonly<{
  operation: NativeStreamOperation
  graphOperation: NativePregelStreamOperation
  coreOperation: NativeRunnableStreamOperation
  domain: FunctionConversationSharedNativeDomain
  factory: FunctionConversationSharedNativeFactory
  assertDataCurrent(): void
}> | undefined
```

该函数自读 SDK call WM，以及 State 原 Pending/operations/association/handoff 私表，
Graph child/Core token、graph/input/S2/S3/S4与 exact Scope/Domain 全部比较。它不依赖
“State 调用者之前核过”，不接 boundary/ready/Boolean/guard。此时原 Core同步栈已
退出，不能要求重新 read current Core boundary；使用真实 first entry 已固定私 handoff
与本次 SDK call 的 child-token 精确连接。Scope 保存同 reader 返回的原 data closure，
每原 FULL 后核全部 facts，不重新 mint/刷新来源。

之后才沿 Scope 原完整 initialize 执行图：validate/ns、actual Saver、tuple proof、admit、
binding FULL、physical thread/namespace、actual delivery/字段赋值、原 NativeRead finally
delete。原 initializing Promise 必在其真正赋值点保存；初始化 body 可能在赋值前进入
Saver callback，不能在 callback 猜 currentPromise。

首 admission-only foundation 的 stop 位于 readTuple 的外层控制返回层：await 同
original initializing Promise 成功且原 NativeRead finally/delete、tracked finally已完成后，
完整 data tail与 readonly admission保存成功，再抛该本 pending自产的 private stop。
stop 在原 initializing `.catch(error => close...)` 外面，不能塞到 Host.admit 或 NativeRead
存活区；它结束 Loop 的 getTuple await，因此模型/节点/帧仍 0。原 error 保实际 reason，
failed/closed/retired execution reader 仍拒；测试用只读 terminal facts 报告早先真实
transition，不能调用失效 reader 重获资格。Graph/Core shell settlement、getTuple Promise、
iterator实际 next/finally和 Scope.pending 四种结算分别保留，互不伪改。
原 createAndRunLoop 的 `loopError = e` / `if (loopError) ... else stream.close()` 不修改。
若 getTuple 真拒 undefined/null，readonly call settlement仍精确 rejected+原reason；原
公开 iterator可能按官方 falsy处理完成，不能伪造它也以同reason拒。native data capability
已failed而实际SDK外层状态仍按原事实报告，App后继最终gate不得用外层fulfilled刷新它。

#### 5. 精确 SDK / App 窗口与全原子安装

SDK 只改 @langchain/langgraph 1.2.5，Core1.1.36 与 langchain1.2.37 语义不改。
现 Graph manifest 的七目标扩为九目标：原 `dist/pregel/index.js/.cjs`、package.json、
`dist/native-stream-origin.js/.cjs/.d.ts/.d.cts` 七项保留并按需更新，加原版
`dist/pregel/loop.js` 与 `dist/pregel/loop.cjs` 两项。没有额外 package/subpath；两个
公开 reader 与 iterator producer 仍在现 native-stream-origin。新 private Loop runtime
模板一份，现 Graph runtime/type 模板更新，Graph 模板数 2→3。

全批次原 LC13 + Core7 + Graph7 的 27 目标改为 LC13 + Core7 + Graph9 的 29，exact
evidence 从现 22 增到 23（多一份 Loop runtime template）。现 artifacts 四组数不变；
Graph 的同一完整 patch/manifest新增两 before/post hash，不对 index/loop 单 hash豁免。
新 Loop 两 before bytes 必从 Root 已核 SRI/sha1/MIT 的官方1.2.5 tgz重新抽取/校验；
已安装 postimage 不能作前像。EOF bytes、全部原 API/source校验与 own exact rollback保。

Generator、inner prepare/installer、batch29/entry/types/实际FS fixture固定全targets/evidence
列表同时更新。Root 独立维护窗先凭旧完整 artifact+全27状态证明核验并备份，再准确恢复
inner14 官方前像，新增 Loop2官方字节不动。正常新安装器只接完整 pristine/base/new29
三态；旧27、mixed/partial 都先拒，不新增运行时旧27豁免。
安装前从当前 coherent27 验证并保存 exactbefore/after，再按Root维护窗口恢复/迁移；
模板与旧 manifest 不可在恢复授权前随意改坏旧checker。Root sole CPU生成、源审、安装。

App 最小候选为 Scope/State/Lifetime 的 checkpoint handoff＋Domain birth、SharedInvocation
原 completion、Hostdata、Restore-local，逐窗而非同时开放所有输出。SDK-only 首窗不接
Scope授权；之后 Scope 接纳-only 窗再真实绑定以上 SDK call，provider/frame仍0；Main
driver正常输出/Source/ACK完整数据以后另开。各窗 production/source/test清单冻结再双审。

SDK新测试独立与原80定义全保：ordinary完整 codec/callback/default/config/CP对照；
native真原Loop/getTuple各once/fn/receiver/params/config地址；scratchpad++及checkpoint_map
非零counter黄金；真实 validate/context/chainStart 三入口的 directScope或 publicInitialize
抢读，0Saver/admit/rows且caught sticky；callee getter同步抢读后正版拒；clone params/token/
foreignGraphCore/noContext；index-first/loop-first ESM/CJS原模块初始化；undefined/null真实
getTuple失败及actualPromise先观察；held Saver/ownerabort→真正 finally/delete/drain。App
再加 same-graph caller Source不能替association、原history physicalpoint/membership、
lastHost/Tools退休/full后closed、NativeRead不延寿与stop位置真证。原预算不增加。

### Producer-local reader 的准确内存布局（待两审）

上文 Producer-local 示意补为以下真实 Restore API；不把旧 Producer.assertDataCurrent
（含 fresh destination SQL）改名 pure，也不删除其原任何 FULL/SQL调用。

```ts
interface FunctionConversationSharedProducerLocalData {
  readonly producer: FunctionConversationSharedProducer
  readonly original: FunctionConversationSharedProducerView
  readonly authority: ModRuntimeAuthority
  readonly scope: FunctionConversationSharedCheckpointScope
  readonly database: ReturnType<typeof getDb>
  readonly saver: SqlJsSaver
  readonly invocation: object
  readonly binding: FunctionConversationGraphBinding
  readonly signal: AbortSignal
  assertDataCurrent(): void
}
readFunctionConversationSharedProducerLocalData(
  producer: FunctionConversationSharedProducer,
  authority: ModRuntimeAuthority,
  original: FunctionConversationSharedProducerView
): Readonly<FunctionConversationSharedProducerLocalData> | undefined
```

新 producerLocalRecords 仅 completeFunctionConversationSharedActive 的原 producer词法
创建：same actual Active proof/record、completed pointer/全flags、activeDataReaders私record与
固定原 assertCurrent 地址、reservation Map/key/value、authority/scope/signal、原 view/target/
binding/coordinator等所有 private值与 descriptors。一并固定 genuine sourceCurrent 的
原内存 data closure；没有该 private source origin 的旧 fallback Producer不提供此新
reader，仍保持所有旧业务路径。readonly view在原 producerRecords发布同token/view时
与之存同 private localRecord，不接 caller record/view/callback注册。

exact token WM门先，再 authority/view pointer与同producerRecords对象门；unknown/clone/
foreign入参返回undefined不运行 Source、不毒化无关producer，已匹配原record失效则拒。
data closure与原 assertCurrent 共享同词法 `failed` 位，新失效catch任意reason都置failed。
activeDataReaders 原函数是内存/authority/signal/Scope/source-ref尾，getDb 仅读原db变量
（未初始化原throw，不开库/SQL）；不调用 NativeRead assertCurrent，不延期其reads WM。
completed 的 fresh/restore标记保持原值，历史Producer不能因为restored被默认排除。

local 每次核 active/producers/completed/privateMap原关系、字段flags、retiring/released false、
reservation、原Scopeclosed、原authority数据、原signal intrinsic、原source内存尾，前后
重复只做上述数据。排除 registration.assertDataCurrent、destination/dataChecker SQL，
不把它们“优化掉”；它们仍在原 Producer FULL/data和Main completion full位置执行。
Main 首 full前从本API固定实际 original closure，每原 full/旧SQL后再调用local、Host与
Tools纯尾，再存 completion。缺资格/known mismatch严格拒新stream路径，不用普通
fallback获得completion。新reader只证明尚未退休的私对象关系，不刷新SQL/permission。

App/Restore仍仅设计，旧已通过54/51/SDK基础与性能RED证据不改。SDK-only29在两票及
Root 完成原 inner14维护恢复后独立实施，以下冻结只覆盖 SDK 基础。

### SDK-only29 最终源码冻结

首四为 Graph runtime、NEW Loop runtime、Graph type 与 inner generator。Root SOURCE1、
Official SOURCE2已核原 private body/call 关系、全反射任意throw即时failed/invalidate、
旧三个 private record helper的body strict、原 async Promise/ordinary/falsy语义。Core两
模板与Root58备份逐SHA相同；LC13、node_modules、四组artifact未由本agent更改。

剩余固定源码为 inner installer/matching type、batch/matching type。安装目标16与29，
Graph9/Core7/LC13及23 evidence全部受原全批次检查，不接受旧27或半安装状态。
Root own composite type改29，不在本agent编辑清单。

测试冻结：NEW langchain-native-checkpoint-origin.test.ts 24展开定义；原 inner installer
5保留＋Loop2未知前像/末rename回滚3＝8；原 batch21全部保留＋末rename29/Loop2未知/
Loop2单文件post/Graph七post配官方Loop拒绝6＝27。最后一例明确是新Graph部分安装，
不冒称复建历史旧27字节。SDK测试只真实 StateGraph/MemorySaver/Core boundary、原Loop
及真实CJS两加载顺序，无应用Source/Scope注册、无假tuple；保完整codec、原5秒与CJS
4500ms、原getTuple rejected null/undefined独立readonly结算及原falsy公开completion。

本agent scoped SOURCE1自读通过、scoped diff-check无输出；未运行生成/安装/测试/类型。
正式剩余SOURCE2后仅Root执行generator、完整manifest/安装、真实SDK/FS与类型回检。

Root 首轮真实113＝107PASS/6新fixture RED，原7 suites全部GREEN；安装/生成29已成功。
日志 stage24-sdk29-whole-runtime-installation-current.log完整保留。唯一SDK新test六处两票
收口：scratchpad0原namespace absent不命中checkpoint_map，而1原转换后命中；原普通
rejected null/undefined的falsy loopError仍完整观察fulfilled[]，native共用failed使既有
Graph shell后验精确STREAM_INVALID，原raw getTuple reason独立保存。不为普通SDK的
falsy错误吞掉行为改变安全守卫。CJS同assert.rejects覆盖真实opening+完整consume，
原claimed/callback/leak/node/CP及4500ms不变。生产/templates/artifact与另外7 suites零改。
