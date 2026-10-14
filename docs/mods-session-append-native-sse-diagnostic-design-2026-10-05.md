# 原生 SSE metadata 的实际诊断适配器

2026-10-05。本稿的 metadata 契约及共享 driver 精确附录均已获两份独立设计票。metadata
producer/encoder 接线尚未实施；不把 driver 的验收当成自由 metadata 已支持。当前最小
SSE 的第五次实际门禁为 95 项全部 PASS，记录在
`output/stage23-native-sse-fifth.log`。默认 invoke 形状已由真实未包装 ReactAgent 的同
默认配置对照校验；此前第三次 94 PASS/1 fixture RED 的日志保留。已通过的 bytes/multi-mode/取消
用例不等于自由诊断字段、全部 provider、v2 events 或派生 withConfig 已经支持。

本阶段仅补 messages 帧的 metadata 显示副本。messages 的完整 native/partial 保护、
actual Keeper ACK、noBubble 省略与 canonical A/B 仍由已有接点负责；本稿不开放未知
state、custom/debug/tasks/checkpoints、Tool args/error 或 v2 events。

## 实际来源与必须保留的协议

本机 `langchain/dist/agents/ReactAgent.js:595/642` 在 invoke/stream 内合并真实私有
defaults 并初始化 middleware，然后调用同一个 compiled graph。Pregel 的
`index.js:905/914` 会选择编码外壳，`:1072` 附近才输出真实 mode/subgraphs 形状。
当前 lifetime 在这个实际 compiled graph.stream 地址捕获 merged SSE intent，原
encoding 在实际副本中为 own undefined；不能由诊断层重新 invoke graph 或绕开初始化。

`pregel/messages.js:44/71` 从原 callback metadata 创建 `{tags,name,...metadata}`。
该新对象不同于 Calls callback 收到的 metadata，不能凭字符串等值把两地址视为同一
receipt。`:35` 发出实际 `[namespace,"messages",[message,metadata]]`；partial 必须
另外保留原 Attempt/chunk 与开始时固定的 Source。完成补帧则来自 NativeNode 已完成
slot、真正成功 writer updates 中的 exact safe Base，与同 Source 的 completion ledger。

`core/language_models/chat_models.js:93/169/274` 合并实际调用配置、provider 参数和
model.metadata。`:143` 的默认 provider 值来自真实 getName；`:156` 固定 integration
为 `langchain_chat_model`。这些值可以被合法模型配置影响，不是任意正则可以证明安全
的字段。`core/language_models/base.js:140` 固定加入 core 版本 1.1.36；本机 OpenAI
`chat_models/base.js:236` 加入 1.3.1，Google GenAI `chat_models.js:427` 加入 2.1.26。
OpenAI `base.js:169` 与 Google `chat_models.js:481` 实际输出 model name、temperature、
max tokens、stop 等字段。`runnables/config.js:86` 还会把 configurable primitive 复制
进 metadata；不能对所有新增 key 开放。

原 defaults、mode、subgraphs、nostream、namespace 的选择先按真实 graph 执行；诊断
保护只改变显示 DTO。私有 Source/task/parent/slot provenance 不由显示字符串授予。

## 两个确切 mint 接点

新增 opaque `FunctionNativeStreamDiagnostic`，仅模块私有 WeakMap 可读。它不包含
append target/source/SDK grant，也不能进入 NativeProtector 的完整 Message receipt 表。

1. 自然 messages：在 lifetime 所观察的 original `_streamIterator` 的真正 next 结果中，
   按该 Source 已固定的 actualShape 取 exact messages tuple、原 Base/chunk、metadata
   以及原 frame/namespace 地址，私有登记诊断记录。这里只登记地址和 descriptor 数据，
   不调用 raw toDict/toJSON/JSON，不接受 caller 提供的模式或任意相同 ID。
2. 完成补帧：NativeNode 的 exact slot 已 finalize/true drain 且原 writers 已发成功
   updates 后，现 Source completion ledger 构建实际补帧时登记 exact safe message 与
   它自己固定的 metadata 地址。登记必须再次核原 slot/source/graph/exact object；公开
   stamp、history、SDK note、失败 writer 或重放 updates 不能单独 mint 诊断记录。

source ledger 只保存这两个原事实；public helper 只能 read 已存在记录。若 graph 外壳
调整 frame 容器，允许传递的是已登记原 payload/metadata 地址以及同 Source 的实际
frame 地址，不按 role/provider ID/name/ns 的相等值重新登记。两个同 graph invocation
有独立表。actual Source 在 model-start 首 callback 前固定的 Attempt 来源继续独立核，
不能在 read 时把普通 Attempt 绑定到新 SSE Source。

## 独立 policy 接纳与 typed-first 顺序

Root 的真实 NativeHost 为每个 actual SSE Source 创建诊断 owner，首 callback/await
之前占用一次 latch，并捕获 genuine runtime.capturePolicy 的 exact admission。只接受
现 private NativePolicySource certificate 与该 actual runtime 地址匹配的接纳；缺失时
沿现最小固定字段合同或明确 unavailable，不接受 claimed policy/protect callback。

每个诊断 admission 固定原 Source、原记录、真实 runtime、policy identity/epoch/digest/
protected/deployment、合并的 runtime/target/invocation signal 及首次捕获的绝对 30s cut。
预算不在每次 read 或字段之间续期。所有 descriptor/Proxy、容量及周期检查遵循已有
native typed 规则；原 metadata 的 getter、toJSON、迭代方法、Proxy trap 均不得执行。

接纳顺序为：首 latch → 原 source/policy full guard → typed complete copy → 原 full
guard → 无 callback 的完整 raw/data/policy/latch/source/cut 尾。原数据变更只拒绝，不
从新 metadata 重新捕获一个成功结果。重入被捕获后外层也 sticky fail。

本轮 schema 仍有限：现 messages metadata 固定 key 集中，仅放开 name、tags、
ls_provider、ls_model_name、ls_stop 的字符串或密集字符串数组显示值。数字字段保持
现精确类型；thread/task/node/trigger/path/namespace 与 CM state 的固定框架合同保持。
未知 key 不放行。versions 只增加从真实安装包证实的固定 package key 与 exact version
组合，不接受 arbitrary semver/map。更新名称、event namespace 及自由 state 的另一个
adapter 要独立设计，不能因 metadata 已保护而开放。

## 应用 baseline 保护，不伪装完整 native Message

新增独立诊断 protector，只接受上述 opaque diagnostic，不接任意 JSON/value；与完整
Message Protector 是不同 receipt 类型。原 typed metadata 是 Worker 唯一输入，原
Source、callback、权限、AbortSignal 与 native 类不发给 Worker。不包装 HumanMessage，
不调用 Keeper/Hook，不改 graph channels 或原执行参数。

应用 baseline 使用既有 `NATIVE_POLICY_WORKER_SOURCE` 的原 preflight 和 policy 两 pass、
原 literal 顺序及版本/digest golden。最多 1M expanded nodes，完整字符串不截断。
active policy 才产生明确 protected diagnostic receipt；明确 inactive policy 只返回
typed 副本与原政策事实，不声称已经 redaction。policy-required 仍由 genuine admission
强制，Guest off 不绕开它。

不得为诊断新增另一套独立 4-worker/256-admission 池而使原 process 上限翻倍。实现前
把原 Worker 排队/起动/退出/终止与 reservation 窄抽取为共享 private capacity driver：
Message 的现 private guards/receipt/mutation held 语义不变，诊断使用独立 work brand、
Source pending set 与 retained release。Worker real exit 加真正 release 后才释放名额；
failed termination/未知 release quarantine，公共取消不能抢先返额度。此抽取必须随原
Message 的 starting/finishing/重入/容量/取消回归一起验收，不能只跑新 helper。

safe reply 保留合法 metadata primitive 类型/结构。protects 状态、原 deployment 和
reply rule/version/request identity 都完整核；任何异常仅用固定 safe code，不回显 raw
字段或未知 Error。result 对象、policy/data 或原 metadata 被修改时拒绝，不回退 raw。

## 非阻塞执行顺序与最后同步编码

建议 API（名字可在双审后窄定，能力不可扩大）：

```ts
interface FunctionNativeStreamDiagnostic {} // opaque module-private brand
interface FunctionNativeProtectedDiagnostic {} // different opaque private brand

host.prepareSseDiagnostic(token: FunctionNativeStreamDiagnostic):
  Promise<FunctionNativeProtectedDiagnostic>
readFunctionNativeProtectedDiagnostic(token, originalSource, originalMetadata): {
  readonly data: Readonly<Record<string, unknown>>
  assertDataCurrent(): void // pure full raw/safe/policy/source/cut/owner check
}
```

wrapper 在其同一 lifetime.run 内 await prepare 完成及真正诊断 work drain，然后才
调用当前同步 encoder。encoder read 该 exact receipt 和同 metadata/Source，执行所有
原 source/policy full callbacks；之后原 canonical batch 完整 A/B 与 ledger B；最后
执行诊断和 partial 的全部纯尾、原 containers/namespace/DTO 尾，再同步编码/enqueue。
编码成功与 enqueue 之间不再 await 或执行 source callback。这样不能在 async metadata
保护返回后沿旧 canonical B 直接发送，也不因后续 callback 修改另一个成员而漏核。

每次独立 read 仍完整复验 original data/proof/current policy，不能跨 read/await 缓存
成功授权。Source 结束时只拒绝新 admission；已进入工作仍留到 actual original generator
finally 和本 Source 诊断 whenDrained。原 Host 仍保持真实 keeper drain；正常一次消费
不会 close 全局 Host，goal resume 仍可继续。

## 实际门禁与后续边界

需要真实 createAgent/SqlJsSaver/Managed policy 的 generate/stream 两种路径：合法自定义
model name/tags/stop/provider metadata 的原 canary 经 active literal 保护；inactive 必须
显式证明政策事实而不假称受保护；OpenAI/Google 的真实 getLsParams/version 结构用实际
类或已有本地 HTTP provider driver，不换 fixture 默认 metadata 凑 allowlist。

必须保 getter/Proxy/toJSON 0，same graph 两 Source 不互借，partial 原 Attempt pin、
完成真实 slot/writer join、被取消 Source 无 late output，以及末 guard/最后 canonical
callback 改 metadata/policy/DTO/其它行 ledger 时 0 bytes。真实 Worker held/terminate/
starting/finishing/reentry/capacity 全门禁与原 Message 共享；所有测试使用原默认 timeout。

错误帧、更多 state/namespace producer、v2 event driver 和 native withConfig derived
factory 都仍有明确实际切口，另行两审实施；本次 metadata adapter 不宣布这些完成。

## 共享进程 driver 的精确窄抽取（设计及源码双审已闭合）

原 `native-message-protector.ts` 的容量事实目前是模块级 `works`、
`captureReservations`、FIFO `queue`、`workers` 与 `workerOwners`。新的诊断 protector
不能仅引用 LIMITS 再复制这些集合。拟新增 host-only `native-policy-process.ts`，只拥有
进程 reservation、排队、Worker 身份和真实终态；它不解析 native Message、不选择政策，
不产生保护/Message/SDK receipt。以下接口不暴露给 IPC 或 Guest：

```ts
reserveNativePolicyProcessAdmission(owner: object): NativePolicyProcessReservation
commitNativePolicyProcessAdmission(reservation, callbacks): NativePolicyProcessWork
releaseNativePolicyCaptureReservation(reservation): void
quarantineNativePolicyCaptureReservation(reservation): void
startNativePolicyProcessWork(work, useWorker: boolean): void
cancelNativePolicyProcessWork(work, error: unknown): void
readNativePolicyProcessState(work): NativePolicyProcessState
whenNativePolicyProcessWorkDrained(work): Promise<void>
```

reservation/job 均由独立 WeakMap exact-object 登记；clone、跨 owner 或重复 commit 拒绝。
owner 是本机 protector 地址，仅用作内部计数/归属，不授 source/target 权。reserve 在任何
source/policy/retain callback 前计入同一 256；commit 只转移这同一名额，不新增额度。
capture 失败只有原 retain 未发生或真实 release 已同步成功才 release reservation；任何
不确定 retain/release 进入 quarantine，不自动解除。

callbacks 只由两个真实 protector factory 固定：`assertCurrent` 保完整原工作来源检查；
`createWorker` 是原本机 Worker factory；`createPacket` 返回其 typed-safe request；
`onResponse` 保原 exact request/version/rules/full-data 校验；`onCancel` 只固定错误并拒绝
公开 result；`onFinish(exitCode)` 执行原 protector 的政策事实/结果 adoption/actual release，
返回固定 `released | quarantined`；`onQuarantine` 固定 safe 错误并保 owner 的未闭工作。
它们不是诊断 token 传入的 claimed callbacks，driver 不把 callback 返回数据视为授权。

driver 将真正 FIFO head 先变 starting 并占同一 4，再执行纯 owner 状态桥接和原完整
assertCurrent，所有 source callback 都在预扣之后。源 guard 可同步接纳其它品牌；它们
只能占余下三槽。guard 取消/失败且 factory 从未调用时，显式 never-started 分支只归还
这个物理预留，admission 仍需原 owner 的一次真实 release。实际
Worker 返回后先绑定唯一真实 exit，再检查取消并 terminate。factory 抛错、返回非法值
或无法绑定实际 exit 都保 worker slot 与 admission quarantine；不重试。message 只在
running 接收一次且先原 full check；真实 exit 才进入 finishing，finishing 在任何 owner
callback 前固定。terminate promise 不是 exit，公开 reject 不是 release。

`onFinish` 的原函数保持 Message 的 fixed execution/inheritPresentation/adoptResult/full
guard 与真实 release 顺序。它捕获结果错误与未知 release，不让 driver 改这些事实。
release 未获证明时 admission 保留；已证明真实 Worker exit 后可归还 worker slot，符合
原代码的释放区分。正常 release 后 driver 归还 admission，解析 drain；原 Message 的
结果仅在 release 后最新 error/full source 检查成功时 resolve。driver 的真正 terminal 与
owner `whenDrained` 关联；diagnostic 也遵循同一 exit/actual release 门。

work state 的名字与现有 captured/queued/starting/running/finishing/finished/quarantined
保持。原 Message 独立 pending、capture/result receipt、policy/data、原 producer guard
及 stats 合同不变；只把共享调度/计数读取委托给 driver。取消队列项必须从同一 FIFO 移除，
腾出实际 Worker slot 后同一 pump 公平唤醒两个品牌，不能只唤醒 Message 或诊断自有队列。
原 factory 同步触发 nested admission 时，starting 已计数而 nested pump 仍可按原 FIFO
推进其余空位；不新增阻止原 reentrant pump 的总锁改变现有实际调用顺序。所有状态先于
callback 固定且各自 exact work 复核，原“factory 内最多四个真实 worker”反例保持。
所有 driver callback 同步返回；Proxy/Promise/thenable 返回依原规则拒绝，不执行 then/getter。

抽取必须先保留完整 Message 回归，再加跨品牌 4 Worker 与 256 reservation、排队取消、
同步 factory/release 重入、真实 exit 和未知 termination/release 的实际门禁。原 Worker
源码/digest/golden、原 30s cut、Message receipt 和消息效果均不改变。此段是实现前具体
补合同；Root 的实际首轮为 driver 12、原 Message Protector 46、原集成 3，共 61 项全部
PASS，记录在 `output/stage23-native-policy-shared-driver-first.log`，同快照 Node35 类型
检查通过。Official 与 Legacy 均已独立给出 scoped SOURCE PASS。首次 source 审阅发现的
guard-before-reservation 第五 Worker 漏缝及相应真实回归保留，不用无关旧总体票替代源码审。

## 下一个原子窗口的具体接口（待增量审阅与授权）

这些接口只承接上述两个真实 mint 地址，不给 public frame 增加字段：

```ts
// lifetime 私有表；mint 不导出，clone 无 lookup。
interface FunctionNativeStreamDiagnostic {} // opaque
readFunctionNativeStreamDiagnostic(token, expectedSource): {
  readonly source: FunctionConversationNativeSseSource
  readonly message: object
  readonly metadata: object
  readonly namespace: readonly string[] | undefined
  readonly signal: AbortSignal // actual compiled invocation's fixed original signal
  assertCurrent(): void
  assertDataCurrent(): void
}

// 新独立 metadata owner，source 只接受上面原记录所属的 exact source。
createNativeSseDiagnosticOwner({runtime, source}): {
  prepare(token: FunctionNativeStreamDiagnostic): Promise<FunctionNativeProtectedDiagnostic>
  whenDrained(): Promise<void>
  close(): void
}

// 主 Host 是固定 actual runtime 的工厂；不接受 caller policy/full-guard。
host.prepareSseDiagnostic(token): Promise<FunctionNativeProtectedDiagnostic>
```

自然记录在原 iterator 的 next 结果中按已固定 actualShape 取 messages payload 和实际
namespace；completed 记录只在已有 completion ledger 对成功 update 的 same object、
same Source、live slot 复验后构造。metadata 的完整 descriptor 拷贝不使用 native serializer。
getter/Proxy 或原 frame 拓扑在后续 source callback 中变化则拒绝，不能重新 mint 新基线。

wrapper 队列内部改为 `{frame, diagnostic}`；这不是出站 DTO。partial route 会生成新
wire/metadata 地址，但仍携带原 iterator diagnostic token。这个地址关系只能由原 wrapper
的真实 Host.message 调用建立，不能凭 partial public kwargs、metadata 字符串或 provider ID
补证。编码前分别复验原 diagnostic、该次 partial 私有 receipt 与 same Source；full Base
仍使用原 canonical projection receipt。noBubble 已省略帧不产生新 metadata 输出。

metadata owner 在每个诊断的首 callback 前占同一个 process reservation 与 sticky latch，
再读取真正 runtime/policy capsule、完整 typed metadata、原 source 前后 guard。Worker 只处理
批准的自由显示字段；其余 routing/version/numeric 字段按原真实固定 schema 核验并按原 key
顺序保留。所有字段仍纳入原 raw digest，不能把未交 Worker 的任意字符串当成 fixed 协议。
OFF 是真实 inactive policy typed-copy 事实，不借 Message receipt 或构造 HumanMessage。

wrapper await prepare 的公开 Promise 后仍等待本次真实 diagnostic work terminal；取消时
同 Source owner 先拒新 admission，再保留 pending 到实际 Worker exit/release。原 iterator
finally、Keeper drain 与 diagnostic drain 全部开始后再等结果，不因第一个拒绝跳过其余清理。
正常 stream 结束不 close 全局 Host；本 Source 的 owner 结束只撤销本域。

encoder 的新可选参数是已完成 private diagnostic receipt。其 reader 在所有真正 source
callbacks 之后给出安全 metadata DTO 和 callback-free `assertDataCurrent`，随后统一原
canonical raw A/B 与 ledger B，最后执行全部 diagnostic/partial/metadata/namespace/container
纯尾，再同步 stringify/encode/enqueue。源码窗口拟为 NEW diagnostic owner/tests、lifetime
两 mint/read 窄段、invocation 私有队列/await/cleanup、SSE reader 参数；Host 只新增上述方法
与本域 owner drain/close。Worker 源码/digest、Message proof、未知 state 和普通无 Source
stream 路径均不扩。这一增量 API 尚待 Root 与独立审阅者确认后授权落地。

精确门函数与文件归属如下，未授权前只读：

- `function-conversation-native-lifetime.ts`：private Source 记录 compiled stream 的 original
  signal；两个 mint 闭包、`readFunctionNativeStreamDiagnostic(token, expectedSource)` 和同
  Source 的路由地址绑定。reader 首验 WeakMap/same current ALS/source，再运行原 source
  full guard，返回冻结 original metadata/message/namespace 和 pure full topology/data tail。
  公开 Source 或相同 tuple/ID 不可登记。namespace 仍由真实 frame 或 completion slot 提供。
- NEW `native-sse-diagnostic.ts` / `.test.ts`：实际 runtime+policy certificate owner、typed
  admission、same driver reservation/Worker、私有 protected diagnostic receipt。导出
  `readNativeSseProtectedDiagnostic(receipt, token, originalMetadata, expectedSource)`，返回
  `{data, assertDataCurrent}`；每个地址 exact，clone/foreign Source/capsule 拒绝。
- `function-conversation-native-invocation.ts` / `.test.ts`：队列保存 private token，只有
  SSE messages 帧 await `host.prepareSseDiagnostic(token)`；公开拒绝也必须等待同 work
  drain。非 SSE、invoke 和普通无 native Source 路径保原输出/defaults。
- `native-conversation-sse.ts` / `.test.ts`：可选 private receipt reader替代 metadata 显示
  值，不替换原 tuple/metadata 地址。先完成所有 diagnostic/partial source callbacks，再
  原 canonical batch A/B+ledger B，最后执行每个 private data tail，保持最后同步编码。
- Root 的 `function-conversation-native-host.ts` 只接
  `prepareSseDiagnostic(token): Promise<FunctionNativeProtectedDiagnostic>`、同 Source 的
  owner 缓存和 drain/close。owner 从真正的 Host factory runtime 捕获 policy，不接受
  caller 传入 policy、source guard 或需要信任的 `alreadyProtected` 标记。

Host 的 actual runtime/source 关系与消息自身的 partial/canonical proof 独立复验；若帧
属于尚未接入的 foreign child domain，不能借 main runtime 的显示政策捕获，必须拒绝或由
该真实 domain adapter另行选择实际 runtime。原 private Source token 不是 domain/目标权限。
固定 protocol 字段仅接受已核的真实有限值；display 自由值只能在 Worker/明确 OFF receipt
完成后出站。上述第一增量 Root 已给设计 PASS；独立第二票及实际 source 窗口另行确认。

## Host、原图与此次 invocation 的额外私有联合证明

Lifetime 在原 wrapper 创建时固定 original runtime 对象地址和本次 combined invocation
signal；真实 compiled stream 合并 defaults 后仍须使用这个 exact signal。Source 记录
保留 actual compiled graph/runtime/signal，诊断 reader 必须同 current ALS、同 Source。
Host 只在其原 successful install 完成后将图地址加入私有 installedGraphs。诊断准入要求
Source.graph 在该集合、Source.runtime 等于 Host factory 原 runtime，不能由 public
configurable、namespace、thread UUID 或 Source 地址单独代替这三个关系。

消息自身仍有独立证明：partial 只能来自此 Host Calls 的 actual Attempt/chunk 且 pin
同 Source；full Base 只能来自此 Host projection 的 exact Entry 和实际完整 23 列 seal。
unknown/foreign Entry 或尚未接入的 child 域拒绝，shared attach 本轮不登记为 main 图。
Host 自造的 bound validator 只重验这些原关系，不提供新 mint，也不接 caller policy。
metadata owner 在 genuine PolicySource 下运行这个固定 full validator，所有 callback
先于 canonical A/B；B 后只有完整 typed native/meta/frame/namespace/DTO、政策数据、
private maps、signal/cut 的纯尾，随后的 bytes/enqueue 同步完成。Root 已正式给该增量
第一 DESIGN PASS，独立第二票与后续 SOURCE/实际门禁分别记录。

共享 FIFO 可能在另一个 Source 的 exit callback 中启动本工作。已有 genuine token
reader 返回的私有 run closure 因而只恢复该 token 固定的原 Source ALS，供同 work 的
driver callbacks 使用；它不重捕 Source、不增加 mint，也不接受其它 Source/token。
reader/encoder 入口仍必须 current Source exact 匹配，跨 Source 的 wire/receipt 不可读取。

## 首次实际门禁后的窄补

Root 已记录旧 95 与诊断初稿 8 合计 103 项实际 PASS，证据为
`output/stage23-native-sse-diagnostic-first.log`。这个快照不覆盖以下源码补丁，也不证明
异步诊断等待期间已封存 partial 的最终省略路径。

full Base 准入使用本 projection factory 的 `captureOwnedMessage(message)`，要求原
`natives` 中 exact message、entry 和 owner 地址一致。通用 `validate` 对普通 unknown
unmarked 的兼容 no-op 不提供这个资格。新的独立 proof 在首 source callback 前占用
reading/failed latch；full 保留原 Store、23 列、presentation、partition 和 A/B，纯尾
只核原 native 全量摘要、entry/map/owner、DB 与原 signal。wire、clone、foreign 与未登记
原 full callback 地址均拒绝。原普通 validate 行为保持。

诊断失败使用独立 boolean，内部首次 reason 包括 undefined/null 原样保留。公开诊断
prepare、result、read、pure tail 及 Host select/drain 只产生新的固定枚举 ModFunctionError。
归一化只读 non-Proxy 原错误的 own data `code`，不读取 message、getter、toJSON 或任意
MODS 前缀。真实 Worker exit、release、unknown quarantine 仍按原 terminal/status 核验。

wrapper 对真实四种 shape 的解析只取 dense Array 的完整 own data descriptors；不调用
原 frame 的 index getter、iterator 或 `.every`。namespace 与 messages tuple 同样先取
固定局部值，原 token 仍核真实地址拓扑。异步 prepare 后变 namespace accessor 的真实
iterator 阴性必须确认 mutation 成功、getter 为零、没有 bytes。

真实 inactive streaming partial 在诊断等待期间 seal 的回归保留最终完成 frame 的期待。
当前严格 live partial reader 会拒已 seal Attempt；该回归需要 Root 实际运行确认并另审
同原完成证据的安全省略协议，不能放宽 live reader 或把任意失败当作可忽略 partial。
