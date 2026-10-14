# Stage23 原生完整消息保护器小方案

状态：Latest 与 Legacy 两位独立方案评审正式 PASS。隔离 foundation 正在实现，
尚未接入 native keeper doors 或通过实际运行门禁；本文件不是阶段验收声明。

本方案只增加隔离的 native protector、纯规则 Worker 和各自测试。Root 继续拥有
runtime、index、实际 producer、投影 seal/adopter 与 policy 接线。已有
`FunctionConversationNativeRetainer` 是一次保留的 foundation：真实 SQLite 基础
12 项通过，不能代称下面的完整保护器已经存在。

## 1. 真实源码基线与范围

当前 `src/main/mods/publication.ts` 的 `filterModData(value, true)` 在 policy VM 前
执行一次复制、类型压制、敏感字段和 token/Bearer 保护；其 1MiB、depth32、nodes30000
上限不能接完整大原生消息。`src/main/mods/policy.ts` 的
`ManagedModPolicy.filter` 随后执行应用内固定 `POLICY_CODE`，再次处理 token/Bearer，
再按 deployment 中的顺序逐个替换 literal。`observer` 不是这个完整异步链的替代品。

新接口只接受实际原生 producer 提供的消息对象和宿主证明。SDK、公用 JSON、renderer、
插件清单及 `protected: true` 字段不能创建该证明。SDK Hook/API 仍保持当前 1MiB
公开上限；大原生行公开 Hook 不可用时走真实完整保护、原 keeper/core，不截正文、
不把一条 native occurrence 拆为多个 append、不重跑模型或工具。

只适配当前固定、应用自带的 `cmb.baseline/v1`。未来可执行自定义 policy 没有通过该
完整 adapter 验证时，明确拒绝保护操作，不能当作没有规则而放 raw。不会抬高现有
普通 Guest Hook 的 own/CPU/memory/wall 预算，也不会把纯 Worker 的规则执行说成原版
插件回调或原版测试工具证明。

## 2. 私有输入、actualBytes 与 JSON 顺序

保护输入是实际 HumanMessage、AIMessage、SystemMessage 或 ToolMessage。实际 producer
在首 await 前捕获原 occurrence/目标/source/physical incarnation/epoch/signal，以及
原类、UUID 和完整原生字段；不是先序列化一段 JSON 再猜原对象类型。只接受可信 native
factory 已登记的真实 message，不通过 `BaseMessage.isInstance` 单项检查给任意 SDK
对象授予权限。

每个非 primitive 在任何 reflect、brand、遍历或原生方法调用之前先以 Node
`util.types.isProxy` 拒绝 Proxy，包括包裹 native message、Array、Buffer、prototype 或
普通对象的 Proxy。`Object.getOwnPropertyDescriptor`/`Reflect.ownKeys` 对 Proxy 仍能
执行 trap，不能把它们写成天然不运行代码。随后只接受 actual known native class、
plain/null-prototype object、Array 和明确支持的真实 binary；未知自定义 prototype 明确
拒绝。判断原生类使用可信 factory/已知 prototype identity，不调用 raw 的可覆盖
getType/toDict/toJSON；原类型、UUID、固定字段从已核 own data descriptor 捕获。

捕获先读取原生实例的已知字段以及递归的 own data descriptors。对象属性 accessor、
未知可执行 toJSON、cycle、function/symbol value 与不支持的 native value 明确拒绝；
不调用它们作复制。数组也检查 own descriptors，不以 `Array.map` 触发 getter。拒绝
不会回退到 JSON.stringify(raw) 或把无法判断的对象变成安全字符串。原生消息类的方法
来自可信 factory/已知构造器，payload 内的同名字段不能选择构造器或运行方法。

分类发生在任何 JSON/structuredClone 之前：

| 实际值/字段 | 活跃保护下结果 | 注意 |
| --- | --- | --- |
| Buffer、ArrayBuffer、DataView、typed-array view | `[Binary output suppressed]` | 用实际 native brand/view 判断；Buffer.toJSON 后的 `{type:Buffer,data:[...]}` 不能证明原字节已处理 |
| own `type` 为 image/image_url/audio/file/resource | 原基线文本压制块 | 必须读取 own data descriptor，不运行 type getter；字符串 base64 不能漏过 |
| own `truncated === true` | 原基线 incomplete 压制对象 | 保留原允许的 exitCode 和 truncated 事实；不得把尾部缺失当完整正文 |
| 敏感字段/base64/dataUrl | 原同序规则的遮蔽值 | 原生 structured execution facts 另按第4节固定，不从遮蔽字符串推权限 |
| 普通完整字符串 | 完整字符串交 Worker | 不因公开字节预算切尾、分开 regex 或转换 Unicode |

SharedArrayBuffer 等不在当前 `filterModData` 可表述的原类型不推测为普通 JSON；首版
明确拒绝 unsupported native value，后续若接真实字节 adapter 必须另有证明和测试。
无保护模式沿原管道保留原 native 值/完整 codec，不启动 Worker；此结果不生成可供
以后保护开启时复用的 protected receipt。

实际入口顺序是本方案的生产依赖，不能仅给 standalone helper 提供正确顺序：

1. actual producer 在任何 raw codec/toDict/JSON 之前同步 seal 原 occurrence/projection，
   捕获原真实类/source/epoch/private lifetime 与安全 typed snapshot；第一次 await之前
   已安装一次 admission，后续旧 stream echo沿原 seal等待/消费，不继续改本 occurrence。
2. 第一轮完整 protector只消费该 native capture，取得真实 safe BaseMessage和private
   protection receipt。期间以同一个 capture复核原raw数据与source，没有重新读最新
   occurrence。原raw的变动比较使用拒Proxy/accessor的 typed capture，不借 raw JSON。
3. **此后才**创建 `FunctionConversationNativeRetainer({message:safe,...})`、调用现 native
   codec或进入keeper。retainer的固定baseline是safe实例；host.captureProjection返回
   已同步封好的actual owner/flush receipt并重新核原capture，不能再次seal别的消息。
   retainer的实际source guard包含原raw capture/lifetime，因此safe对象不脱离原发生事实。
4. retainer Hook apply之后的protect仍绑定同一source/policy；只凭exact private receipt
   复用已保护的相同实例，否则完整执行。Hook修改不得把原raw或新自定义实例传入codec。

当前 retainer constructor 先调用 `serializeFunctionConversationNativeMessage(raw)`，
codec内先toDict再JSON.stringify；其host.protectNative在run中更晚。**该旧调用顺序不是
本方案已闭合的接点**。Root实际producer/adopter必须采用上面的pre-protect seam；如未
接好禁止接keeper/声称binary-before-JSON完成，不用直接helper测试掩盖raw toJSON已运行。

Host 捕获的纯数据包与 private classification receipt 绑定。Worker 只见已分类的纯
data；实际 message/source/权限对象、callback、AbortSignal、capability 和 raw 二进制
不发送给 Worker。structuredClone 是运输手段，不是原类型判断或权限证明。

## 3. 完整规则的精确顺序

Worker 实现两个明确的 pass，不以合并的单个 regex 近似原链：

1. host-preflight 对每个可观察字段按原 descriptor traversal 顺序处理：上述 binary/
   media/truncated 压制、跳过 `__proto__`/`constructor`/`prototype`、undefined 属性省略、
   非有限 number 变 null，以及原 preflight 敏感字段、token、Bearer。
2. 固定 policy pass 对第一步输出递归处理：token、Bearer、deployment literals 顺序；
   同时执行原 policy 的 case-insensitive credential/base64/dataUrl 字段遮蔽。

精确字符串规则来自当前源码：

```js
/\b(?:sk-[A-Za-z0-9_-]{12,}|AKIA[A-Z0-9]{16})\b/g
/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi
// token => "[REDACTED]"; bearer => "Bearer [REDACTED]"
for (const literal of deployment.redactLiterals)
  text = text.split(literal).join("[REDACTED]")
```

必须保留两次 token/Bearer pass 与 literal 次序，包括 literal 匹配第一轮生成的
`[REDACTED]`、相互重叠 literal、Unicode、大小写和 word-boundary。规则统计来自
第二个 policy pass 的真实命中，加原 `baseline-v1`，不能声称第一轮已被压制的 token
仍在第二轮命中。字段遍历和 Set 插入顺序与原 POLICY_CODE 相同。

每一条字符串在隔离 Worker 内整串执行以上规则；只在字段之间作工作检查/进度通知。
不采用“固定 overlap 64/256 字节”的分块 regex：Bearer/token 长度可不受该 overlap
限制，UTF-16 word-boundary 与任意长匹配不能靠猜最大 token 长度重建。消息和文字
仍是一份完整结果；Worker 期间 main 的取消/epoch 检查不依赖 regex 主动 yield。

当前 deployment 来自 actual ManagedModPolicy 已解析并冻结的快照，仍保持最多64个
literal、每个最多256个 JS code units 和原去重/顺序。不能 Worker 端重新读取 workspace
文件或让 SDK提供 deployment。native policy snapshot 包含 actual policy object identity、
id、digest、deployment epoch、protects 状态、冻结 deployment 与 original source guard。

原 digest 定义保持：`sha256(POLICY_CODE + encodeModJson(parsedDeployment))`。
新 pure mirror 另有应用 source/version digest；只声明是该固定基线的通过 golden 验证的
native adapter，不冒称其不同源码与 POLICY_CODE 的 digest 相同。Root 的宿主 admission
提供原实际 policy digest；Worker request/response 都核 exact mirror version 和固定
request identity。非匹配/缺失 adapter 不执行、无 raw fallback。

## 4. 类、执行事实、artifact 和可观察内容

保护器不把 native 类变为公共 API message 再重建。Host 基于原真实 native class 创建
同类完整保护后实例，保留 id/name、原 Tool.tool_call_id/status 和 AI call 的 id/name/type/
顺序；原 usage/provider occurrence 等执行字段从 captured native facts 保留，不能从
受保护可见正文推断。原消息不原地修改。

执行字段与输出字段的边界由实际 producer 的可信 adapter 固定，不让 public JSON
指定一组“免过滤 paths”：

- 实际 UUID、tool/call/provider/run 路由、原调用顺序、status/exitCode/isError 等执行
  事实由 private native factory 保存；这些字段不能被 Hook、policy或渲染回执重选。
- 实际 AI tool call 结构和完整实际参数保存于原 execution snapshot；protector 不允许
  模型消息的受保护 args 反向覆盖已执行/已批准的真实 tool input。producer 尚将该
  AIMessage 交给 tool dispatcher 时也不能悄悄替换 call 参数。如果实际基线会改变
  尚未执行的固定参数，adapter 必须沿原发布/授权管道完成明确的 input保护决策，或
  拒绝本次 keep/执行；不能免过滤 raw 参数，也不能让本模块发一个新的工具调用。
- Tool.artifact/metadata/additional_kwargs/response_metadata 中的正文、秘密、二进制等
  输出数据按完整基线处理。artifact 的非秘密完整结构不因公开预算丢弃。实际执行
  状态和 structured tool record 不从处理后的 artifact 反推；原发生事实保存在实际
  execution record/receipt。canonical protected codec 保持保护后的完整数据，不能把
  “完整”解释为仍存未受保护的原秘密。
- 如 artifact 中含 actual status/call 等执行字段，实际 producer 同时捕获其固定值。
  保护输出必须保持该事实；若同一字段的真实值与 mandatory redaction 冲突，拒绝且
  零 keeper/零 raw 输出，不把 `[REDACTED]` 当新 status。该边界需单独负例，不能靠
  任意字段名为所有 artifact 内容自动赋予执行身份。
- 第一轮完整保护后成为 retainer 的 safe baseline。Hook仅改允许内容；后续 protector
  与 apply 必须保持此 baseline 的所有非content事实，包括原保护后的完整 artifact、
  usage、metadata 和 native class。普通 public `tool_result.is_error` 是独立呈现
  sidecar，永不覆盖 Tool.status 或执行 artifact。

private is_error sidecar 由实际 adapter 在 original→applied→protected-new-instance 每次
变换显式继承。不能仅 WeakMap存在于 applied 对象，而 protectNative返回新实例后
静默丢失。调用 provenance仍是原 actual message/producer，公开 sidecar 不授予执行
能力。完整 ctor字段的保留清单来自当前 native codec，不只复用 UI content 字符串。

## 5. 主线程/Worker 生命周期与容量

新增独立 `native-message-protector.ts` / `native-policy-worker.ts` 和纯 rules helper。
Worker入口是应用固定 source，不读 workspace、不执行插件源码、无SDK/文件/网络/
模型/工具能力。首版每次 work 一个隔离 Worker，main全局最多4个实际live Worker；
等待任务最多256个（包括原 run 的256个 admitted occurrence约束），队列仅持有原
native work reference，未取得执行位前不额外序列化复制巨大 payload。容量或排队期间
取消明确拒绝，不 evict 已ACK行，不把某个排队值放 raw。

不新增 1/16MiB 文本截断或正文上限。原 native producer/DB/authority 的实际接纳上限
仍执行；这个 pure adapter 不以 public ModJSON 的 bytes/depth/nodes 拒合法大行。
有限对象结构的处理使用显式栈，避免 JS递归栈把合法原生结构误当保护失败。Worker
内存仍受当前应用/Node运行时实际限制；不声称无限容量/零复制。如果平台 OOM或
Worker failure，保留真实失败且无 raw/partial commit，不能提高 heap假装解决泄漏。

每 work使用源真实 signal/hard deadline，并新增一次30秒 Worker链总上限（捕获后排队、
创建、工作、响应/退出均在同一 monotonic cut；不每字段重给30秒），作为本工程明确
有界保护适配而非原版数值。其源原更短期限始终优先。不扩 Guest/原任务预算，超时
取消自己的 worker，不能 abort caller/parent signal。Root若源已有更严格 work期限，
需显式传 min cut，不把截止作为新的 capability/authority。

Host work 从接纳到真实finally一直 retained，包括排队和 Worker：

1. 首await前 capture source/target/policy guard 与 active snapshot；await前后复核。
2. 对 Worker 添加 message/error/exit listeners 后才发送实际 request；每条 message只
   本 request ID可接纳，progress不返回正文、不算完成、不释放占用。
3. 结果可提前保存但不返回；Worker完成后关闭 port并真实退出。成功只有原guard复核、
   完整响应shape/digest、同类身份、**实际 exit**及 Host结果采用都完成才 resolve。
4. signal/epoch失效或超时同步封本work结果接纳，发 terminate；await真实 termination/
   exit receipt。不能 `void terminate()` 后 finally立刻release/让safeapply退休。
5. error/坏response/nonzero exit/termination拒绝只记录一次原失败。cleanup尝试不重做
   保护、不创建替代Worker重放、不从原raw补“成功”。termination uncertain 保留
   occupied/quarantine直到实际exit，显式close不把发送kill当exit。
6. `whenDrained()` 等所有原work真实finally与实际Workerexit，close同步封新admission。
   取消返回可以先暴露拒绝，独立actual terminal Promise仍持全部work/activity/credit
   至真正结束；生产adapter必须用actual terminal保留计数，不能只看caller Promise。

main watchdog不能只依赖setTimeout；接纳/response/最终采用均核 monotonic expiresAt。
worker只能完成纯文本处理，无法以消息声明“原guard有效”。main接纳所有异步消息后
都核固定source/target/policyepoch，没有第二次capture最新drawing/owner或重新grant。
日志/错误只输出固定安全code和计数，不回显原字段、原字符串、Worker异常的任意payload
或秘密。Worker failure是实际失败，不拿其未验证message伪造成功或新的policy权威。

## 6. 精确宿主接缝与保护receipt

新隔离 foundation 已按以下宿主接口写入源码；尚未运行门禁或接真实 producer。
私有类型仍查actual WeakMap，不靠unique symbol或可复制字段：

```ts
interface FunctionNativeProtectionAdmission {
  readonly message: BaseMessage
  readonly producer: object
  readonly signal: AbortSignal
  readonly policy: FunctionNativeProtectionPolicy // actual snapshot，不是public JSON
  readonly expiresAtNs?: bigint
  assertCurrent(): void
  retainActualWork(): () => void
  assertExecutionFacts(original: BaseMessage, safe: BaseMessage): void
  inheritPresentation(original: BaseMessage, safe: BaseMessage): void
}

class FunctionNativeMessageProtector {
  capture(admission: FunctionNativeProtectionAdmission): FunctionNativeProtectionCapture
  protect(capture: FunctionNativeProtectionCapture): Promise<FunctionProtectedNativeMessage>
  assertProtected(receipt: FunctionNativeProtectionReceipt, safe: BaseMessage, producer: object): void
  close(): void
  whenDrained(): Promise<void>
}
```

`FunctionProtectedNativeMessage` 返回实际同类 `message`、私有 `receipt`、原 policy digest、
真实规则 IDs 和保护状态。无保护结果保留同一 original native 对象，但不能通过
`assertProtected` 或在后来开启保护时复用。每个原 admission 对象只 capture 一次，
相同 capture 的 protect 返回同一 Promise；异步 worker 期间仍固定该原对象/私有证明。
保护后实例变化不会隐式继承 WeakMap sidecar，必须调用上面的实际 adapter callback。

实际 Root factory 注册/捕获 admission，包括 target/ref/physical incarnation/source/runtime/
grant/config/policy epoch。纯模块不能冷启动 Session/模型或 mint main authority。候选
只读初始化禁止创建写keeper；native producer没有actualregisteredtarget时沿原普通
native管道或明确该door尚未接，不伪造protector ACK成为append能力。

Root adapter的seam明确为 `seal + captureNative + protect -> safe message/receipt ->
new Retainer`，而非仅给当前更晚的host.protectNative换实现。seal owner、typed snapshot
和protection receipt都是私有actual对象；它们的JSON副本/相同字段不提供授权。第一轮
Worker开始前仍不序列化raw artifact，不调用raw toDict/toJSON。公开is_error sidecar在
safe实例构造时由实际adapter显式继承；原授权/input保护已完成的tool参数只从原实际
pipeline接受，不发新tool call、不把raw secret可见保存、不用任意paths免过滤。

可复用的 protected receipt仅private WeakMap：actual original message/occurrence/producer、
完整输入/output digest、policy object+digest+epoch、original signal、原 fixed facts与实际
result对象身份共同固定。每reuse重查原guard。跨消息复制、same text/different UUID、
同label不同 child、变更policy/撤权重授ABA、unprotected result均不通过。首版可不提供
复用缓存；无需为了性能存raw或把旧receipt绑定新scope。

Worker仅负责完整可观察payload。原executionfacts/authority与 is_error sidecar留host；
pure output不能制造新的执行字段。实际 retainer host.protectNative adapter在采用新实例
后继承private sidecar；host.prepare再核 protectorreceipt+projectionreceipt+target，在
原appDB同步事务使用现 mandatory writer/verify，不给Worker事务写能力。

## 7. 必须验证的基础与真实门禁

基础测试分开登记，不能 fake worker成功或 fake storegreen：

- 真 Node Worker，text远大于1MiB且无秘密：完整原native codec字节/字符保留，同类
  UUID/Tool.call/status/AI结构不丢；publicHook0/原API诚实limit，实际SQLite完整写/read。
- 在合法原公开预算内，把相同输入交 actual ManagedModPolicy.filter 与 newpureworker，
  比较value与ruleIds精确；字符串/body/Tool可观察aggregate、字段大小写、number/null/
  undefined、危险key、media、truncated、真实binary均覆盖。部署digest使用真实policy
  给的快照；不能用新mirror生成的期望再测mirror。
- 整长token/Bearer超过任意常用chunksize、跨UTF16/Unicode字边界、literal跨1MiB边界、
  overlapping/order依赖literal、literal匹配前轮mask、secret在artifact/metadata等：
  完整redaction正确，零分片漏出、原status不变；两次pass真实rule统计一致。
- actual Buffer/typed view含secret bytes及自定义toJSON，getter/type getter、Array getter/
  toJSON、truncated输出、cycle：不执行guest代码、不先JSON丢binary类别，安全明确拒
  或原压制；无保护原路径保持原值与现codec行为。
- actual factory→pre-protect→Retainer→真实Store路径：raw消息/数组/普通对象/Buffer Proxy
  各ownKeys/getOwnPropertyDescriptor/getPrototypeOf trap计数0；恶意rawtoDict/toJSON和
  getter计数0，实际binary按原brand压制，unsafe原对象0codec/0keeper。不能只测standalone
  protector而让实际Retainer原构造顺序仍先跑rawtoJSON。
- raw native AI固定参数需要redaction但没有真实input决策、伪executionfactpaths、
  tool/call/status改写、保护新实例丢is_error、private receiptclone/replay：明确拒绝；
  两向public is_error仍展示而原Tool执行事实正确。
- Worker held结果→policy/source/targetepoch改变、撤权重授、childretire、取消queued/
  running、terminate delayedexit/拒绝、badmessage/duplicate message/nonzeroexit：
  0adopt/0rawfallback，actualactivity一直到真实finally，父signal不abort，容量不假回收。
- Worker真实CPU stuck/异常/巨大输入、close并发、反复正常work、4worker/256pending：
  totaldeadline和真实exit/drain，不无限wake/无Unhandled，临时listener/map/worker资源回收。
- appDB/adopter真实双连接/unknownCOMMIT/原projectionseal/lateecho与实际HTTP大AI/Tool
  使用第已有producer门禁，单纯pureprotectorpassed不算native门已经接线。
- 实际ordinary Electron build和production worker入口，renderer/preload不能创建admission；
  无Mods/noPolicy原流程，无冷load/no paidmodel/no工具重跑。

本小方案通过后先实施新隔离模块与上述foundation tests，不修改 Root index/runtime。
生产采用前仍须两位源码review及 Root串行真实Worker/SQLite/类型/build/Electron门禁；
当前retainer 12PASS与sharednativehost 1PASS只作前置接缝证据。
