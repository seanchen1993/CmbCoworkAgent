# Main partial UI 的真实 AgentNode 名字

本稿替代 Main completion-name 的 writer/CAS/schema 方案，申请两个最终精确 DESIGN 票。
旧稿保留故障与研究证据，尚未实施；新方案不需要 durable writer receipt、archive
transport、name-only SQL 或 schema parser。Root whole52775 冻结期间只写设计。

## 行为与实际来源

真实 Electron 的 OFF assistant 普通流式行当前 name=NULL，而 AgentNode 完成时给同一
actual AI root.name/lc_kwargs.name 写入自己的名字，导致原八facts拒绝。单在 parser
保留现有 name 不够，因为首真实 callback chunk 的 raw name 通常仍 undefined。

实际 Node install 在 `function-conversation-native-node.ts:492` 已固定原
builder.nodes.model_request.runnable===original compiled bound，并捕获 original bound
的 own name、prototype、descriptor flags。该 closure 在首 Work/unknown guard 之前
建立；现在只被放入完成后的 Slot。新方案在真实 Work 首创建时保存同一 closure，再
由本次实际 Host/Call/Attempt/chunk 私关系把名字用于 **Main UI wire 副本**。SDK raw
chunk、captured.message 安全 native class、snapshot、originalDigest、lc_kwargs 地址
和原完整 full/typed/data checks 不修改。

Main parser 为 assistant 保存已有 kwargs.name，是普通 UI 数据字段，与当前 Tool 的
name 保存同性质；generic assistant 也可以保留自己已有的 string name。该字段不授
Slot、Source、append、ACK、canonical 或 projection receipt 权。unknown UI 名字仍要
面对原 completed raw 八facts、完整23/CAS/Store/ledger A-B，不能借 UI 保存 canonical。

## Node：真实正在执行 Work 的 data-only 名字

```ts
interface FunctionConversationNativeNodeWorkModelName {
  readonly __opaqueWorkModelName: never
}
interface FunctionConversationNativeNodeWorkModelNameData {
  readonly work: FunctionConversationNativeNodeWork
  readonly graph: object
  readonly bound: object
  readonly runtime: FunctionNativeConversationRuntime
  readonly configurable: object
  readonly name: string
  assertDataCurrent(): void
}
captureCurrentFunctionConversationNativeNodeWorkModelName(
  runtime: FunctionNativeConversationRuntime, configurable: object
): FunctionConversationNativeNodeWorkModelName | undefined
readFunctionConversationNativeNodeWorkModelName(
  proof: unknown, runtime: object, configurable: object
): FunctionConversationNativeNodeWorkModelNameData
```

OriginalWork literal 始终有 own `modelName`（包括 undefined），在原 Work 私表安装、首
external assertCurrent 之前固定到原 install closure；不用完成 Slot 的旧 proof。只有
actual originalScope 正在 running、model_request、exact runtime、domain===undefined、
原 Work 私表地址、原 bound 与 graph 安装结构全一致才 capture。无原 Work 的 generic
调用返回 undefined，已有真实 Work 的错误 runtime/node/配置关系不能 fallback。

configurable 不以 JSON 相等认证：从原 Work captured config 与本实际 request runtime
取 descriptor-safe task/thread/namespace/read，全部原 private task 地址与 read 函数
一致；proof 首固定该本次 request configurable 原地址。既有复制的 Runnable config
按其真实 task/read 关系 join，不能要求 SDK 原本会复制的 configurable 全是同一对象。
pure reader 后续只接受这份捕获地址；clone proof/config、foreign runtime/Work 均拒。

capture/private reader 不运行 Work.view.assertCurrent、Source 或 SQL。固定原 weak/map
intrinsics、原 modelName.assertDataCurrent 和 Work.assertStructure 的纯关系；unknown
token/Proxy 在读属性前拒。reading/failed 独立布尔先占，任何异常/caught reentry sticky，
own optional 初态不继承 Object.prototype。后续 Work 正常完成可保持这份 name 数据
事实，但原 live Partial 独立 sealed/closed/failed 判定不放宽，不能用名字恢复活 partial。

## Host / Calls：具体的 Main 双私来源

Host wrapModelCall 的首原 assertCurrent/calls.capture 之前，先 capture 上述真实 Work
name proof，核本 Host 私 graphInstallations 的 exact graph/ready/runtime 和原完整
graphData；首固定关系不按 public agentId/metadata/node字符串选择。原 assertCurrent
和 calls.capture 所有 existing full callbacks 保位置/次数，之后同 proof 数据尾重核。
Shared Work 的真实 domain 存在，因此不取得本 proof；未成功 installed graph 明确拒。

Calls.capture 只增加 optional opaque proof 参数，Call literal 始终 own proof:undefined
或真token；没有传入 name 字符串/guard/inspector 的 register 接口。新 proof 只携带
name 数据，不授 Call/Attempt 或权限。原 Call private maps、callback local ALS、每个
actual Attempt、chunks WeakMap/select unique ancestor、provider tuple、signals、policy
和 namespace/task/read 的全部 original full/tail 均保。新 partial 私记录只从该实际
Call 选择 proof，不能在 wire 创建时从当前 ALS/futureSlot 补一个名字。

仅证明无 Shared domain 还不足以区分 Main policy。`native-conversation-policy-source`
现两 register factories 已分别用真 NativeRun proof 与真 Shared Producer proof 验证。
各自产 source 私 record 加 own readonly origin:'main'/'shared'（不是 caller参数），
新增纯 `readFunctionConversationNativeMainPolicySource(admission,runtime)` exact 私表
reader；仅真 main register 记录命中。clone/foreign/unknown 返回 miss/固定拒，不执行
Source、读 public kind、callback注册或新增 SQL。新 pure lookup 使用原捕获 WeakMap.get。
原 generic/source full APIs 仍原行为。partial 只在同真正 Main admission/runtime 命中后
提供 actor proof；普通测试/generic policy 不因同字符串升级。

## Partial：只加 UI name，不改原 typed native

本次 actual Partial 在原 project function 中完成所有原 full/typed captures后，只有：
真 Call/Attempt/chunk + 上述 Work/Host/main-policy proof、policy.protected=false，且
original/current SSE Source 均不存在，才能装 Main UI actor name。Shared source miss
保持原生成逻辑，SSE wire/data/native帧完全原样，不能用 Main actor proof补 SSE能力。

raw root.name 与 same原lc_kwargs.name 若缺省/undefined，保持 raw 如此；若原已有值，
必须 own data string 且精确等原 bound.name，不能用 UI覆盖另一个真实 raw 名字。任何
getter/Proxy、晚 bound.name/flags/runnable/Work/task/read 改动都0getter拒。不能放宽
原 capturePartialNativeModelData 对 raw root/kwargs/字段/address/digest 的检查。

在已 descriptor/typed 深复制的 **wire.data.kwargs** 上设置 name；原 serialized native
副本、captured.safe 与原 wire 前级 raw digest 均仍自己原基准。若已有 UI name 必须
同值，不能替换未知其它name。Main wire 自己的完整 typed digest在这一个新增字段后
固定，之后原尾仍完整核 raw/serialized/wire/meta/safe，另纯核 actor proof 数据。
不得把 actorName 当 captureNativeMessage 或 full native Snapshot 的一部分；wire本来
已有稳定uuid/providerTuple的UI映射，actorName只是同实际Node的显示字段。

正常 serializer 原样复制此 kwargs.name；不需要沿JSON克隆保partial能力或登记来源。
parser的assistant分支仅像Tool一样保string name，UI普通写入带正确名字；真正 Native
completion仍SDK原双name、原safeInput/name和原projection八facts/23自然严格相等。
不删除任何fact、不刷新baseline、不改name单列、不新增flush、SQL或Source检查。

原 step-limit synthetic message 本身不因新reader获权。真实Call的早callback有原Work
proof时仍可显示同actorName；无需预测未来SDK替代。actual AgentNode step-limit ctor
自己带同this.name，最终原completed验证照旧。无真Callback/Work名字的人工notice不映射。

## 必要源码与真实门

独占 additive regions：Node的OriginalWork/name reader；Host wrapModelCall前pure join；
Calls Call/Partial optionalproof；Partial wire.data单字段；Policy来源记录/纯Main reader；
`ipc/stream-transcript-payload.ts` assistant保name。共六文件，不改IPCqueue/flush/runtime
透传/SQLStore/Projection/Shared/serializer。旧writer/CAS六组申请撤为研究，不实施。

回归必须同时证明：default/custom actual bound ×真实1/2 HTTPchunks 的 raw callback
root/lc_kwargs仍无name，而 MainUI wire/string名字正确、serializer真实拷贝后完整保存；
实际completed双name/原fullnative codec/23/CP/provider精确，ON/OFF/IDless原IPC/Electron
路径通过。现 unwrapped golden4 保早raw缺省/aggregate地址和全字段仅name迁移，对每
emitted/callback地址新增逐项toBe（whole冻结结束后才改），不是用它代Main实际gate。

阴性需要真 installed Work/Call：首source callback改bound.name/getter/runnable、同uuid
foreign Attempt/Work、clone token/config、rawwrongname、late wire.name/其它rawfields、
policy change/close/abort/caught reentry均拒，getter0/真tool及provider数量全保；SSE/shared
原全frames/digest字节保持。没有name proof的generic oldpartial不新增actor；普通parser
已有assistant name保留是本次明确UI兼容行为。真实E2E必须等待实际request done/error0，
不能以renderer输出/noStop代完成。默认5秒不变，由Root独占实际门。

## 当前实现与窄回归快照

六产源 additive 区域已按上述合同实现，Root SOURCE1 与 Official SOURCE2 均只对
该名字数据来源与 UI 映射区域通过，不扩大整条 Native/Shared/SSE 来源权限。
OriginalWork literal 的 `modelName`、`graph`、`domain` 在首外部回调前都为 own 字段，
无 domain 时是 own undefined，不经 Object.prototype 选择 Main/Shared 路径。

Root 首真实门 `stage23-native-main-ui-actor-name-current.log`：default/custom bound
name ×真实 HTTP 1/2 chunk 四例、parser 两例共 6 PASS；四例分别约 1053/842/806/780ms。
原 early SDK chunk 双 name 保 undefined，真实 UI 深副本保 name，普通 row 落库后原
八事实/23 receipt、完整 native codec/CP、provider1 与 completed1 自然通过。
该门仅这 6 个选中定义，不把过滤的旧用例计为通过。

新增 test-only 阴性 8 个定义冻结在 Host 测试：三例在实际 early
Work proof 捕获后，首真实 physical Source guard 改 bound.name/value/getter 或 builder
runnable 地址，原模型须 provider0/零输出，先恢复 descriptor 再 matcher。此阶段 SDK
已真实建立初始 checkpoint，所以要求 CP 无 AI/canonical，不能错误宣称整个 SDK
checkpoint 数为零。另一例用同实际 Work proof 查 clone、foreign genuine runtime、
copied config 与 Proxy token，Source 计数不增且 0 traps，原 token 随后真实正常完成；
并在仅实际纯 capture 时注入 inherited domain getter，恢复后验证 own domain 隔离。

四例用真实 BaseChatModel callback chunk，原 iterator 在 yield 后持住 provider，消费
原 messages frame 时分别改 root/kwargs name 值或 getter。首 `host.message` 必须以
原 typed/accessor/actor 门拒，保存此首 failure，恢复原 descriptor 后关闭 Host、释放
provider，并观察原运行及 drain。要求 provider1、raw getter0、零 display、零 canonical
及 UI row；不用后续关闭错误代替首拒绝。没有削弱普通 live sealed 检查或修改 raw 基准。

首阴性门暴露了两项测试精度错误：SDK 外层 task error 的固定 message 与 cause.code
才是实际错误关系；外层 readable stream 的提前 break 没有终止原后台 checkpoint 工作。
测试现保存精确首错误，使用真正 caller signal，恢复 descriptor 后 abort/release，继续
完整消费同一 iterable，并核原 provider generator finally 已结束，最后再原 Host drain、
Saver.close 与删除目录。没有忽略 EBUSY 或提高超时。修后 Root 实际选中 8/8 PASS，
日志 `output/stage23-native-main-name-negative-drained-current.log`；过滤的 46 项不计通过。

Root 原 native-append Electron controller 真实 exit0，六个 request 的最新 terminal done
且 error0，普通 build 已恢复。另有三条 renderer canonical_id echo 警告仍在独立诊断，
该 Electron 结果不能被写成整个 renderer 持久化链已经没有异常。
