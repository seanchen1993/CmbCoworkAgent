# Native 派生默认取消信号的真实来源方案

状态：只读框架调查后的设计提案，尚无生产改动或实际验收。独立评审已发现下述
三个真实 token 传输缺口，本提案尚未通过完整设计双检。当前派生配置仍明确
拒绝非 undefined 的默认 signal；原调用 signal、真实取消与清理流程继续保留。
本提案先解决 Main 的原 invoke/stream 入口，Shared stream 仍需自己的真实来源适配。

## 实际框架路径

当前安装版 `langchain/dist/agents/ReactAgent.js` 第 320 行的 withConfig 通过原
mergeConfigs 合并私有 defaults。第 595 行 invoke 与第 642 行 stream 分别再次合并
defaults 和调用 config，等待私有初始化函数，随后进入真实 compiled graph。
core 的 mergeConfigs 在两个 signal 都存在时调用 AbortSignal.any。因此默认 D 和
外层取消 S2 会产生实际 S3，重新调用 AbortSignal.any(D, S2) 只能得到另一个对象，
不能证明框架实际使用的 S3。

第 541 行的初始化函数先等待 middleware state schema 的解析和默认值回调，再
等待原 graph.getState(mergedConfig)。最后 graph.invoke/stream 接收这个 mergedConfig。
Pregel.invoke 第 1108 行复制 options 后动态调用 graph.stream；Pregel.stream 第 915
行又用其真实内部 controller 产生 S4 并交给 _streamIterator。原 Source 的两层实际
接点都必须保留；不能把 S2、S3 和 S4 的对象身份视作相同。

初始化回调发生在图的首次 stream 之前，可以直接调用公开 graph.stream 或发起
嵌套调用。只用当前 ALS 和 first-stream 布尔值会把这种调用当作原 Agent 的结果。
按输入内容相同、同 signal 状态或相同 thread_id 接受，也不能解决来源问题。

## 固定调用入口和不外传的操作凭证

只允许现有真实 NativeAgentFactory 私表中的 Agent，并固定其原 invoke/stream 数据
方法、原 receiver、原 compiled graph 与已安装 Host/runtime/Source 关系。inner 的
原历史和 intake 准备完成后，最深的真实 Agent 方法入口才登记本次操作。登记在
任何原方法、初始化回调或 full Source callback 之前，占据原调用的独立 latch；
同操作重入被捕获后仍保持失败，不能恢复公开字段使外层继续。

私表为操作产生一个空 frozen token。固定 config 副本的 root 增加一个专用字符串
数据字段，其 value 是该 token；原 mergeConfigs 本来就复制未知 root 数据字段，
因此实际 mergedConfig 会保留原 value 地址。字段不放入 metadata、configurable、
输入 state 或公共 Runnable ALS，未知 caller 字段冲突明确拒绝，不接受外部 token。
只有工厂执行原 Agent 方法的路径能建立 token 私表记录。token 不授 append、Keeper、
policy、checkpoint 或消息保存权限，Host 原全部来源检查保持。

操作记录固定原 Agent、graph、方法种类、原外层 Source 与 runtime、原调用 config
数据快照、独立取消 cut 和原方法 Promise。当前 Main 不接受初始化期间创建的
嵌套新操作借用该运行；合法 child 必须由原真实 child admission 的独立来源路径
处理，不能把相同图或另一个公共包装器当作授权。普通工厂没有真实 Main Host 时
仍走旧框架路径，不能自行登记 native 操作。

## getState 是必须一起封闭的真实接点

原 Agent 初始化会把含 token 的 mergedConfig 交给 graph.getState。如果后来替换
该方法的 callback 可以看到 config，便能窃取 token 再抢占 graph.stream。因此
Main 已知 getState 安装完成后，必须固定真实 adapter 的原函数、receiver、flags
和来源，在公开 Agent 返回之前把该实际 dispatch 定义为不可写、不可配置。
这不是登记 caller 的任意 getState 函数。当前完整历史/恢复读仍由同一个原 adapter
执行，原 Saver、membership、DB 和 callback 次数不减少。

固定 getState adapter 在任何原 Saver/source/caller callback 之前读取 root token。
只有本次真操作的 exact token 和原接收图才登记内部 exact mergedConfig 地址；传给
原 adapter 的副本先删除此专用字段。副本保留其余字段和原 S3 地址，不重新合成
signal。普通历史读不登记操作证明。getState 的返回值不包含 token，真正 Agent
仍持有原 mergedConfig，后续原图入口可以验证同一个操作。

getState 读失败被框架 catch 的原语义保持；它不单独授 stream 资格。若初始化路径
因 Command、null、没有 middleware 而跳过 getState，后续固定 graph 入口仍须持有
该工厂操作产生的 exact token，不凭空补造一次 getState 成功。

## 原图入口与两层信号事实

固定 graph.invoke/stream 入口先验证真实操作 token、原图/Agent/method/Source/runtime
地址和操作阶段，再读取 actual mergedConfig 的 own data signal。对原真实 signal
使用捕获的 AbortSignal intrinsic 检查，不读取晚 own method/getter。真实 S3 只从这个
已认证的原接点固定，绝不从默认列表重算、公共 JSON、任意 ALS 或 caller 回调登记。
在任何下游框架调用之前剥除专用 token 字段；配置中的其它原字段原样传递。

invoke 会经过原 Pregel.invoke 再调用 stream，使用下面三份一次性私有阶段 token，
不是把首入口认证复用成后续任意调用的许可：

1. Agent token A 仅 deepest 工厂入口产生。实际初始化 getState 只验证、不消费 A；
   原 Agent.invoke 的实际 graph.invoke，或原 Agent.stream 的实际 graph.stream，
   才按原 method 种类消费 A。错误接点、重复 A、callback 中的直接图调用或嵌套
   工厂调用令本次操作失败，不能被原 callback catch 后继续。
2. invoke 路径消费 A 后，在全部本接点 full callback 结束且数据重新核对之后，
   固定 wrapper 产生 token B，把它交给固定的原 Pregel.invoke。当前 primary 源码
   的这个原函数在任何 await 之前复制 options 并调用 this.stream。图的实际 stream
   dispatcher 不可临时替换；原 options 中 B 只在这一段固定函数的局部对象中，
   不交给任何 caller。实际 stream 只接受 B 私表中的同操作、原 graph、原 Source
   和 invoke-entered 阶段，消费后保留原 S3 地址。Agent.stream 路径直接消费 A，
   不制造或借用 B。不能仅用阶段布尔和公开 options 相同替代这个精确 token。
3. 两条路径在全部 stream 接点 full callback 结束后，产生 token C 给固定的原
   Pregel.stream。原函数合成实际内部 signal 后，Runnable.stream 的 ensureConfig
   复制 C，随即同步调用已固定的 _streamIterator 包装函数。该包装函数消费同
   操作的 C，捕获真实 S4（含原框架的 timeout 合成结果），并在任何原 generator/
   trace/writer/checkpoint callback 之前，从这个真实新 config 删除 C。此对象
   同时是原 AsyncGeneratorWithSetup 保存的 config，因此不能只剥一个副本，
   留另一份含 token 的 config 给后续 callback。原 Iterable/Iterator 保持。

A/B/C 的值均是同一模块刚产生、私表登记、一次消费的 opaque 地址；不是公共字段
上的成功布尔。传给旧框架后，字段尚未剥离的期间只能运行已固定的上述原函数，
descriptor-safe config 的原 data 字段和 genuine AbortSignal；任何晚函数、访问器
或未知调用路径在发布之前拒绝。没有状态解析成功或 getState 成功的伪造凭据。

Main 的既有 Lifetime stream 和
_streamIterator 安装要在固定 dispatch 之前完成，并保留同函数/receiver及真实
Iterator next/return/finally 观察；不得套用 Shared 已封 graph 来跳过安装。

固定安装也必须覆盖实际 _streamIterator 地址。它是 Runnable.stream 的动态读取
入口，若只封 invoke/stream，初始化 callback 仍能临时替换它、获得 token C 后恢复。
因此本次 Main 的真实 getState、invoke、stream、_streamIterator 四个已知 dispatch
均在其全部实际安装完成后、公开派生 Agent 返回之前，以原已验证函数定义 own
不可写、不可配置的数据字段。私表记录确切 installer 与四个 flags，不能把 caller
自有同名函数视作来源。Main 下一次 Lifetime 创建仍复用这份已知安装和原 percall
Source，不能再次替换图方法。未绑定 native Host 的普通图保留旧框架方法。

Pregel 实际合成 S4 后，已知 _streamIterator 边界只在本次实际 stream 执行记录内
读取其真实 own signal。内部阶段 token 在任何框架 writer、callback、checkpoint
序列化前剥离。两阶段记录保持私有，未知直接 graph.stream/_streamIterator、克隆
config、重复/foreign token 和任何失败后恢复都不能取得来源证明。所有既有
Attempt/partial、completed Slot、Host ownEntry/23+ledger A/B 门继续独立验证。

外层取消只保存原默认输入 signal 的私有引用及本次调用 signal/cut。它们可以用于
AbortSignal.any 取消本次实际运行及等待真实 drain；这个组合不被当作 S3 或 S4 的
证明。连续 withConfig 保原 defaults 合并和 callback/tag 单次合并。原方法 Promise
和真实 Iterator/Host/Worker 全部终态到达前，不退役操作、不关闭 Saver/DB，也不
把公开 cancel 或 Promise 早拒绝当作已清理。

## 需要的实际回归

使用真正 Manager、approved resident Hook、known factory、Host、Saver、HTTP 模型和
真实 ToolNode；原默认 5 秒保持。默认 D、调用 C、连续 defaults 的取消都必须在原
provider/Tool/Hook 与 saved full native、23 列、CP membership 路径中验证。持有 provider
或真实 Iterator finally 时，取消后资源不能提前关闭；释放真实 finally 后才正常结束。
原 callbacks/tags/metadata 与未包装框架对照只执行、合并一次。

反例必须在真实 Zod 初始化 callback 中尝试 direct graph.stream 抢首、nested wrapped
invoke、getState 临时替换并恢复、graph dispatch 临时替换恢复，以及 foreign Agent/
graph/Source 和 clone config。执行 getter/假方法为零，失败 sticky、provider/effect/
append/bytes 为零，原助手在独立下一次合法调用仍可用。正常 raw partial/completed
输出、所有四种流式外形和 SSE 仍须原来源完整检查，不按公共 shape 补资格。

本提案的三阶段凭证、实际 getState dispatch、Main 原 invoke/stream/_streamIterator
安装先后尚待两位独立设计审查。不能因当前工厂私表已有固定 invoke 方法，就声称
整个默认 signal 已支持。若任何原 callee 在剥离前会把 config 交给未知代码，该路径
先明确拒绝，继续给该真实接点增加来源适配，不能削弱 token 私有性。

## 独立评审发现的真实未闭合接点

Latest 与 Official 核对 primary 源码后确认，四个图 dispatch 固定只是必要条件，
尚不足以支持上面的 token 运输。Legacy 已收窄其方向票，Root 已收到以下 BLOCK：

- core `mergeConfigs` 第 8 行通过 `configs.filter(...)` 读取晚 Array.prototype.filter。
  receiver 数组含带 A 的私有 config；替换函数可以直接取得 A，而不只改变合并结果。
- Pregel.stream 第 915 行的固定函数内部仍调用 `super.stream(input, config)`。
  晚 Runnable.prototype.stream 能收到含 C 的 config、窃取 C、恢复原型后冒充路径。
  只把实际图自己的 stream 定义为不可替换不能固定这个 super 入口。
- 原 `ensureConfig` 第 81 行使用 `Object.entries(config)`，晚函数能得到含 C 的
  config。只在 _streamIterator 入口剥 C 会太迟。

这些是新增 token 实际会经过的具体未知 callee，不能用普通前后 descriptor 检查
抵御 caught 临时替换，也不能以四个图方法的固定证明代替。需重新设计避免 token
穿越这些可变 callee，或给确切原执行接点提供不可替换的私有运输；完成新的两次
设计评审前不实施生产代码。不得全局临时改写内建函数以求测试通过，也不得退回
公共 signal 相似性、首 ALS 调用或 config JSON 来认证实际 S3。

## 取消效果适配

状态：替代上面已经 BLOCK 的 token 运输方案。Root 第一设计票、Latest 独立第二设计票
已通过；本节限定实现与回归正在交源码评审，尚无本节的实际通过记录。旧 token
运输方案仍 BLOCK，不因本节实施恢复其票。
本轮先接真正 Main Native Host 的 invoke/stream。Shared 默认 signal/stream 有自己的
admission 与真实调用接点，不能因同一个 factory 存在就自动声称支持。

本适配支持原来的 withConfig({ signal: D }) 使用方式，并保证任一有效默认信号、
调用信号、runtime 或本次 cut 取消时停止本次执行，等待原图、Host 和 Worker 的真实
finally/drain。它不要求与未包装 SDK 的内部合成 signal 对象相同，也不要求在已经
取消后仍执行 SDK 初始化回调。现有 native 调用信号本来就在输入准备、初始化之前
检查取消；新的默认约束纳入同一入口，保持这种早取消行为。

正常 callbacks/tags/metadata/context/未知数据配置仍由原 ReactAgent 方法合并一次，
并与真正未包装框架对照。callback manager 的正常 copy 次数、错误传播和配置顺序
保持；不为取得默认取消资格另执行一遍 mergeConfigs，也不手工重建原 Agent defaults。
取消后的初始化副作用与 callback 中人为竞争多个 abort 的极端时机，不作为透明 SDK
内部行为承诺。连续 derive 当时已经产生的默认取消理由则必须保持 sticky，不能在
真正 invoke 时重新摊平所有原信号而改变理由。

### 默认信号只成为私有取消约束

当前原 createAgent 的 ReactAgent 私有 defaults 没有由 withConfig 引入的 signal。
genuine factory 只在原 Main 安装来源完整、操作 latch 已占用的 native derive 路径
接受新默认信号。普通 caller、未知 agent、generic wrapper 或只有 inner prepare
而没有真实 Main cancellation installer 的入口不能借此登记或静默忽略 signal。
当前 Shared 对未支持默认 signal 的显式拒绝保留。原 createAgent options.signal 的
模型构造语义不在此适配中修改。

每个 genuine Agent 的私有 factory record 增加 effectiveDefaultSignal，初始为
undefined。caller config 仍先经过现有 descriptor-safe snapshot：Proxy/accessor
拒绝；有效 default signal 只能是 undefined 或标准真正 AbortSignal，以模块捕获的原
AbortSignal intrinsic 验证品牌，再用 descriptor 核 exact 原 AbortSignal.prototype、
aborted/reason 原 getter 与 flags，且不能有 own aborted/reason。子类、改写过这两项
public 属性的真实 Signal 明确拒绝，getter0；不替换原 any 为镜像 listener。因为 Node
原 any 内部会读取 signal.aborted/reason，捕获 any 本身不能防 own getter。首次 derive
及后续每次 any 前后都重核这一范围，仍保标准 Signal 原 reason/event/合并顺序。
不可枚举 signal 不进入品牌检查，原 merge 忽略其 value。验证品牌时不因该
signal 已取消而拒绝正常 withConfig：原方法可以创建已经取消的默认配置。

信号合并发生在本次真实 derive 期间，而不是延迟到运行时重新排列。若此前默认
为 D1，本次有效 signal 为 D2，则私有 D12 使用捕获的原 AbortSignal.any([D1, D2])。
原默认为空时直接保留 D2 地址。missing、undefined 或不 enumerable 的 signal
不增加新取消约束，原 D1 地址保持；普通未定义键不能清掉此前默认取消约束。这与
当前 core/config.js 24–28 的信号分支一致。本项目运行时原 any 存在；缺失原 intrinsic
时不猜兼容实现，拒绝该新增默认适配。

例如 D1 尚未取消，D2 在第二次 derive 时已经取消，D12 当时固定 reason=D2.reason。
随后 D1 取消，第三次 derive 未提供 signal，再 invoke：仍使用已固定的 D12，所以
reason 不会变成 D1.reason。保存 [D1,D2] 后到 invoke 才 any 会给出不同结果，因此
不采用那种扁平列表。后续 D3 形成 any([D12,D3])，保持原连续默认的顺序与已产生理由。

### 在原配置键位置更新默认约束

单纯在原 withConfig 之前或之后计算 D12，会改变原 signal 键相对 callbacks 键的
时机。例如 D2 已取消而 callback manager.copy 同步取消 D1，signal 在 callbacks
之前和之后会产生不同的 sticky 理由。Root 已认可这一点需要精确定位。

本方案只在工厂创建的私有局部 config 副本中，把原 enumerable own-data signal
键替换为本模块自己造的 getter，其余键及顺序保持 descriptor-safe 固定数据。原
ReactAgent.withConfig 仍调用一次，原 mergeConfigs 到 signal 的原键位置时读取
这个 getter。getter 仅计算上述私有 D12，返回 undefined；原 Agent 因此前私 defaults
没有 signal，会只读取一次，并且最终私 defaults 不含有效 D。任何 caller accessor
仍被 snapshot 拒绝，不能成为这个 getter；getter 没有消息、policy、保存或来源权限，
不包含 secret token，不把公共 config 变成授权载体。

getter 的 reading/failed/reads 只保存在本模块私表/闭包，首原方法或 Source callback
之前固定本次 derive 和 parent record。同步重入、多读、方法没有按一次预期读取、
parent/方法/原继承基准变化都会使本次 operation sticky 失败，即使异常被 callback
catch 后恢复也不能发布 child。getter 没有未知 callback、guard 或 await；只执行
原 signal intrinsic。原 withConfig 成功且原父/子结构与 Main installer 全检查通过
后，才把计算的 effectiveDefaultSignal 发布到这个真正新 Agent 的私表。构造失败
不得更新 parent，不得登记部分 child，也不得另执行 callbacks.copy 来补结果。

本轮不去固定原框架全部 Array/Object 或 superclass 方法。config 副本中的 getter
没有可以窃取的凭证；对未知重复读取的结果是明确失败，而非授 Source 权。原三个
token 泄漏问题因此不进入这条方案，但原消息来源与原方法真实性门仍独立保持。

### 本次 native 调用只合成一次默认取消

建议私有 factory derivation capsule 新增
resolveCancellation(signal: AbortSignal): AbortSignal。它只接受本次 native 外层
原取消组合的真实 signal，读该 genuine record 的固定 D；没有 D 就返回原 signal
地址，有 D 则返回原 any([D, signal])。这是取消数据适配，不授 Agent、Slot、消息或
Source 资格。该 capsule 仍只能由真实 factory 创建，克隆/未知对象不能得到记录。

实际接口还保留原 derive(config) 的默认 signal 拒绝，另有 factory 自产的
deriveCancellation(config) 数据适配路径。只有 Main outer 先通过现有 Host 私表
readFunctionConversationNativeDerivedInstallation(host, graph, runtime) 才选它；inner
私表同源转运这一方法，但其公开 withConfig 仍调用原 derive。factory capsule 的
frozen hasDefaultCancellation 只是私有 D 是否存在的数据位，不能替代 Main 安装证明。
capture 同样先读取真正安装；缺安装而该位为 true 时拒，缺安装且无 D 的旧路径仍
使用原 B。原 Host 两张安装弱表与 inner 转运表的 get/set/has 使用捕获的原 intrinsic，
没有 caller-made Host/reader 注册，也没有公开配置布尔用来取得安装权。

Main native outer capture 先保留现有 cut/runtime/call 的顺序及检查，形成 B；只在
这个外层接点调用一次 resolveCancellation(B)，得到 S2。S2 用于 input retain、
inner history/intake prepare、Host.configure 和本次 Source Lifetime。inner resolve
只补原四个有限 defaults 并原样保留已传入的 S2，不能再次叠 D；同样不能在 Factory
原 invoke 或 Pregel 层重复组合。inner 的 genuine derivation capsule 必须转运同一
私有 cancellation reader，不接受公开同名方法覆盖。

原 ReactAgent 私 defaults 中没有有效默认 signal，因此它原 invoke/stream 的
mergeConfigs 只接收调用 S2，其真实 compiled stream options.signal 仍是这个 S2。
现有 Lifetime 在真正原图接点认证该实际地址，不改变 exact equality、不凭状态
相同接受信号，不增加 ALS/config nonce 或 public shape 资格。Pregel 自己产生的
后续内部 signal、timeout 与原 _streamIterator/finally 继续走原来源接点。

没有默认 D 的原 native 调用返回同一个 B，组合次数与旧行为相同。没有 native
factory/cancellation installation 的 generic 路径完全保持原来实现。正常 Main
withConfig 其它四个 defaults、callbacks/tags/metadata、原 unknown 配置和 callback
manager 仍由原方法单次合并；本适配不引入派生 checkpoint、权限或 extra Hook。

S2 的早取消按现有 native 入口生效。runtime/assertCurrent 原执行位置与顺序保留，
已取消 runtime、cut 或调用信号的旧失败路径不因新 D 被绕过。取消后仍启动/观察
本次原所有 drain，原 Promise/iterator.return 的早拒绝不能替代物理 finally；
真实 worker exit、Host drain 与持有中的节点全部结束之前不能关 Saver/DB 或退役域。

### 本适配必须的真实回归

测试先以真正原 createAgent.withConfig/mergeConfigs 对照连续 D1/D2/D3 与 missing、
undefined、不可枚举键行为。用两种 signal/callbacks 键顺序和真实 CallbackManager
copy 验证 derive 时的 sticky 理由及 copy exactly once；未知 callback 抛错原 reason
仍传播一次，不重新调用原方法。普通 tags/context/metadata/四 defaults 与原 framework
对照一次合并，调用配置不能用 undefined 清除默认取消。

真正 Main Manager/approved resident Guest/known factory/Host/Saver/模型/Tool fixture
验证 default-only、caller-only、default+caller、连续 derive、新 sibling/并行隔离。
默认取消或调用取消都停止实际 provider/tool/append 的后续工作，保已有真实 committed
行与完整 CP/native/23+ledger；持有真实 provider 或 iterator finally 时，取消必须
等待释放后才结束和清理。四种原 stream 外形与实际 SSE 保源关系不变。

早取消的断言按 native 合同：preaborted D 或 C 在 input prepare/provider/Tool 前
明确拒绝，0新效果/保存，不要求执行 SDK 已取消初始化副作用。有效默认先取消后的
理由 sticky 与逐次 derive 顺序严格核，但不以公共 signal 地址相等声称 SDK 内部
合成身份透明。普通非取消 callbacks/tags 与 baseline 必须完全对照。

反例保现有 Proxy/accessor/foreign/clone、caught 原 derive 重入与原 Main install
失败后 base 可继续；可信 getter 被重复读取或未读取不得发布 child。原 actual
cancelled Call/Attempt/Slot 和完整 policy/Store/Host 23+ledger/full Source 检查均不
减少，live partial、completed 消息与每次真实 drain 的规则原样保持。默认 5 秒不增，
性能与来源验收分别记，不把源码票或本文定义数当作实际通过。

### 实际 Main 调用信号必须在首个 any 之前检查

Root 源审发现 outer capture 的首个 `AbortSignal.any([cut, runtime, caller])` 原先早于
Factory 对合成结果 B 的标准 Signal 检查。Node 原 any 本身会读取输入的公开 aborted/
reason，因此只在后面检查 B 不能阻止 caller C 的晚 own getter。现有 27 个 Factory
和 21 个 Main 定义没有覆盖这个实际入口，先前限定源码票不证明它已封闭。

拟新增纯数据 free reader
`readFunctionConversationNativeStandardCancellationSignal(value)`，只复用原 Factory 的
intrinsic brand、exact AbortSignal.prototype、无 own aborted/reason 与原 prototype
getter/flags 门，不返回任何安装或 Source 资格。outer 必须先读取原 Host/graph/runtime
私有 installation；只有真实 Main join 成功才选择这个前检查分支。无 installation 的
generic/no-default 路径保持原组合方式，不能根据合成 B 的 identity 变化补选资格。

真实 Main 分支固定 runtime.signal 与 resolved config.signal 的 own-data 地址和 flags，
先检查原 cut/runtime/C，再执行原 runtime full guard，然后重新核相同 refs/flags、标准
Signals 和真正 private join。随后用模块加载时捕获的原 any 按原 `[cut, runtime, C?]`
顺序组合一次，核全部原输入与结果 B，才调用一次原 D resolver。Source callback 换信号
或安装 accessor 必须在 any 前拒绝且 getter 执行零；原 full/source 次数、默认 D 合并
次数、abort reason、事件次序与真实 finally/drain 不减少或重组。

该增量已获 Root 第一设计票和 Latest 第二设计票并实现，实际门由 Root 单独运行。
真实 Main 回归覆盖 C own/prototype aborted/reason
的 getter/replacement、晚 static any getter/replacement，以及正常 C、原 reason 和
held finally。prototype 恢复后才执行 matcher；异常 C 为零 provider/Tool/保存，不以
Factory 的 D 测试代替此处 caller C 的证明。

Root 最新实际门记录在 `output/stage23-native-observer-caller-signal-current.log`：
Main 31 定义中 30 通过，新增 caller C 十例均通过，真实 default/call held finally、
四种 stream/SSE 和原弱表来源回归仍通过。唯一原 approved Hook 全链例耗时 5270ms，
触及原 5 秒门，性能问题保持红色；不延长时限、不把本增量功能门当作全项目通过。
同门 Lifetime 21 全过，与 Main 合计 52 定义为 51 过、1 红。此前 Factory 27 单独
全过；这两项统计各自按运行快照记录，不相加称新的联合验收。

晚 static any 的阳性观察只委托真实标准数据 reader 原方法一次，保持其返回地址、
所有验证和实际信号不变。它在最后一次原 full 后的 caller 检查返回时安装晚方法，
首个 post-any 原 reader 开始即恢复，因此只证明 outer 捕获原 any；不把它扩大为
后继 Pregel 全局方法的安全票。两阳性仍要求实际 provider、Store、完整 CP/23 seal
和真实 drain。原 Main 二十一例与新增十例全部保留，定义数按实际门报告。

当前交审文件为 native-agent-factory.ts、mods-conversation-invocation.ts、
function-conversation-native-invocation.ts，以及 colocated factory/main-derived 两测试。
Host 两张原安装表固定 intrinsic 的九个触点由 Root 独占落地并另记限定源码票。
factory 原十一例保留，新增十六个取消数据/真实框架读取回归；Main 原六例保留其全部
HTTP/Hook/Tool/native/23/CP 断言，默认 signal 拒绝改为真实 Main 支持和 standalone
inner 仍拒，新增十五例取消/stream/SSE/实际安装来源回归。定义数待 Root 实际门核对，
不以源码计数宣称实际通过。
