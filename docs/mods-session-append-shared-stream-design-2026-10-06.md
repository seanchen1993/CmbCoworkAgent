# 共享子助手的流式使用：下一项设计

状态：Scope opening、Lifetime observer 分离与 observer seal、getState 原地址基础
分别已有独立设计、源码和实际门。版本锁 SDK 词法接点已安装，14 个基础定义实际通过，
完整 Shared 流式调用链仍未实现：App pending、Scope preflight receipt 与 ready 激活
尚待接线。基础 operation 不是输出许可。本文件不说明流式功能已经可用，普通消息、
Command/null 与 SSE 仍须继续接线。

## 用户能得到什么

现在受保护的子助手主要通过等待最终结果的方式调用。下一项补齐后，插件可以让子助手
边执行边返回内容，并保留原来的配置、取消和保存习惯。例如，一个“先设计、再开发、
最后检视”的组合，在开发助手运行时就能显示进展，不必一直等到整个步骤结束。

这项能力应继续使用原有助手对象的 `stream` 方法。用户无需切换到另外一种助手，也不
需要自己实现消息保存、取消和清理。普通旧插件继续按原方式运行。

## 已确认的问题

当前共享包装只为 `invoke` 建立本次保存范围和真实消息来源。其他方法直接绑定到原
助手，因此不能直接宣布 `stream` 已经具备同样的保护和保存能力。当前明确拒绝的
额外流式形态也不能直接放开。

本工程主助手已有真实流式观察器，记录实际节点完成、原写入器和完整消息，并处理
取消后的真实清理。共享子助手不能直接借用主助手的保存目标：其真实保存范围要在
子图开始读取存档时才产生。需要连接这两个实际阶段，而不是给插件一个公开编号当
作调用许可。

## 建议的实现接点

### 1. 在原工厂发布前安装观察器

只在真正的共享助手工厂中，在节点、工具和读取存档的安装完成后，发布助手之前，
安装本工程的原流式观察器。随后固定原 `invoke`、安装后的 `stream` 和
`_streamIterator` 地址及属性。

固定地址必须由流式模块的私有安装记录证明：同一个图、原方法、原接收对象和实际
观察器。不能接受调用方提供的函数或“已安装”标记。派生助手仍先核原继承地址，再
分别安装自身的观察器，不能借父图的安装证明。

已有主助手的安装行为保持原合同。运行时升级后重新创建共享助手，不尝试改写已固定
且不可配置的旧内存对象。

### 2. 一个后台执行过程持有一个原保存范围

一次 `stream` 只能启动一次原助手、一次共享调用范围和一次原 `scope.run`。该过程
持续持有原上下文，负责打开原流、等待读取请求、执行原 `next`，以及最后的取消和
清理。外部迭代器只请求下一帧或取消，不能自己选择保存范围。

不能为了维持上下文而重复启动助手，也不能每次读取都重新申请一次范围。队列只保存
当前读取请求和必要的安全帧，采用背压，不预先消费整个回复。

### 3. 真实子图接纳后再连接宿主

打开流时可以记录原工厂、原图、原范围和原信号；此时不得借用父助手的 runtime。
在原 Saver 真正接纳本次子调用后，连接同一次域中的真实 runtime 和 Host。连接一次
后固定，不能由公开 config、线程编号或 ALS 的存在本身替代证明。

创建、准备、就绪、关闭和失败各阶段都要有独立规则。创建阶段只能调用固定的原范围
检查；输出任何消息前必须已经就绪。失败不得回退成普通流式调用。这里的具体接口
仍须根据当前取消适配和两窗口性能实现后的代码确定，再进行两人评审。

本轮不把新增的默认取消信号直接搬到共享路径。它必须同时保持本次 Scope、实际
runtime、原图信号和节点工作关系；若需新增连接，单独明确合同后实现。

### 4. 每帧使用实际消息来源

先支持原框架的 values、messages、updates 及其单种、多种和子图形态，随后补齐
主助手已经支持的 SSE。最终能力验收需要全部形态，不以第一种通过代替完成。

共享 values 中的原始输入和旧消息，分别使用本次原始输入记录和原 Saver 的实际
历史读取证明；新回复和工具结果使用本次 Host 的真实记录。未知新增消息必须拒绝。
不能按相同编号、JSON 或公开消息标记补登记。

messages 和 updates 使用原节点完成和实际写入器关系。原始 provider 的片段、最终
替换消息以及省略凭证各按既有具体合同处理。完整保存核验、23 列、两段审计校验和
权限检查保留。所有可执行来源回调结束后，进行最后原对象、安全副本、容器、域与
信号的纯数据检查，才交给外部读取。

已返回的完整消息必须是独立的原生类型副本，关闭旧 Host 不能改写已经交付的结果。
副本不能因此取得再次保存、工具调用或登记许可。

SSE 必须先核验完整安全数据再编码。不得让原框架先调用原消息的 getter、toJSON
或错误 stringify。队列中的帧在交付前重新核对本次来源，取消之后不能补发。

### 5. 结束代表实际结束

外部 `return`、`throw`、ReadableStream.cancel、原信号取消和自然结束都进入同一个
幂等清理过程。原生成器的 finally、实际节点工作、Host、Worker 和原保存范围必须
真实完成后，结束凭证才可结算。

如果不能证明实际工作已经结束，保留原隔离和 namespace 预约，明确失败；不能把
外部迭代器已关闭当作后台已结束。正常等待读取不应被误认为失败或提前释放资源。

## 必须通过的回检

- 真实 createAgent、子工具调用、SqlJsSaver、Manager 和原保存关系；原 provider
  和工具执行次数不增加。
- 原助手和连续派生助手的默认配置、callbacks、tags 以及普通旧调用的兼容性。
- 上述四种外部形态与 SSE，完整字段、原生消息类型、保存字节和最终历史一致。
- 两个实际助手以及同图并行调用不串消息、不串取消、不借父图的来源。
- 保存提醒、实际工具返回、Command、重复公开编号、无编号输入和旧历史恢复。
- 原 getter、临时替换函数、陌生消息、外来宿主或克隆证明不能产生有效输出。
- 取消首次读取、暂停读取后取消、忽略取消的实际工作，以及真正 finally 与清理。
- 保留现有 5 秒门、真实正文、Hook 数量和完整来源校验；另测背压和大完整消息。
- 主助手、旧 Plugin、项目模式、Harness、类型检查、lint、整库回归与 Electron
  实际使用，不能只用单元测试替代。

## 本项结论

当前证据表明这是尚未连接好的可实现路径，尚未发现无法解决的框架限制。上述具体
阶段连接、信号关系及安装证明通过两次设计评审后才开始实施。

## 已通过设计审核的实际接点与接口

以下除明确标注的 Scope opening 接口外仍为拟实施合同，不是功能已经验收的说明。
Root 运行全部 CPU 门；本节不改变上述 Main 取消适配的来源、行为和测试时限。

### 当前源的三个不兼容处

`createFunctionConversationNativeSourceLifetime(graph, guard, invocation)` 当前每次先
`install(graph)`，且创建时固定 `invocation.runtime/signal`。Shared 工厂已经把图的
`stream/_streamIterator` 固定为不可配置；每次调用不能再装，也不能在创建阶段把父
runtime 填进这个固定字段。安装必须与本次 Source 创建分离。

原 ReactAgent.stream 在 await 初始化后调用实际 graph.stream；Pregel.stream 在调用
原 Runnable.stream 前又合成自己的 signal。现 Lifetime 在实际 graph.stream 壳层核
`options.signal === invocation.signal`，其后 `_streamIterator` 使用框架产生的 signal。
这两个地址不能混作一个，也不能用重算 any 或 aborted 状态相同来代替来源证明。

真正 Scope.run 只能进入一次，且保存范围持续到返回的 Promise 完成。直接从这个
Promise 返回一个尚未消费的迭代器，会令 Manager 提前进入关闭流程；每个外部 next
分别 scope.run 也会违反原 single-start 合同。因此需要持续的实际执行 Promise。

### 文件布局和工厂安装

拟增加 `src/main/agent/function-conversation-shared-native-stream.ts`，只负责需求队列、
每帧路由与原后台生命周期；不建立新的 Saver、Namespace、Worker 池或保护权限。
测试放在同名 colocated 文件，真正 Manager/Saver/模型/Tool 集成另外 colocated。

`function-conversation-native-lifetime.ts` 分离下面两个内部操作：

```ts
// 方法来源记录：不授 runtime、消息或 append 权。
installFunctionConversationNativeSourceObserver(graph): NativeObserverInstallation
// 每次只建 Source，不重新定义图的方法。
createFunctionConversationNativeSourceLifetimeFromInstallation(installation, guards): Lifetime
```

installation 是该模块私 WeakMap 中同实际 graph、原 stream/iterator、原接收对象及
真正 observed 两函数的 opaque token。读取方只能核私表和完整原 descriptor；不能
注册 caller-made 函数或同名 object。既有 Main 的 create 入口保留原 install 行为，
委托同一实现，不要求 Main 采用 Shared 的 immutable own flags。

基础窗口的实际 API 保留原 `assertCurrent` 与可选 invocation 两个参数，并只分离
安装：`installFunctionConversationNativeSourceObserver(graph)` 返回原安装 opaque token，
`readFunctionConversationNativeSourceObserverInstallation(token, graph)` 返回固定 graph 与
纯 `assertDataCurrent`，`createFunctionConversationNativeSourceLifetimeFromInstallation`
只从原 token 建立一次 Source。原 Main create 仍先 install 再委托 FromInstallation，
stream/iterator 原观察体、guards、shape、诊断、writer 和真实 drain 不改。

该基础 record 固定实际 graph/prototype、原两个方法继承路径与 data descriptors、
接收对象及 observed 两函数的真实 own descriptors。重复安装只读复用 token，不再
定义方法。unknown/clone/Proxy token 或错 graph 在执行 Source 之前拒绝；晚方法或
flags 变化令原 record sticky failed，恢复值也不能复活。Main 原 observed methods
仍为 writable/configurable true。此时不能把外部 false flags 当作合法 Shared seal。
真正 Shared factory 与 installation 私关系的一次明确 seal transition 属于下一
窄两审接点，基础接口不授 ready、runtime、target、append 或消息权。

基础窗口实现位于 Lifetime 两文件；真实两独立调用复用同一实际图、原两函数并保
原 Saver 精确 checkpoint；另核伪 token、晚方法及未知 seal 0 Source callback。
这不是 Shared stream 可用性或 Producer 权限的实际通过票。

基础实际门：Root 的 `output/stage23-native-observer-caller-signal-current.log` 中
Lifetime 21 定义全部通过，含原 14 与新增 7；Scope opening 的独立门为
`output/stage23-shared-opening-first-current.log` 的 12/12。只记录这两个基础模块的
真实行为。Shared 安装 seal transition 的基础两模块已完成，实际 37 门记录在下文；
Shared 工厂尚未消费它，Source ready 激活及后台消费尚未实现。

Shared 的 `installSharedInvocationGraph` 顺序固定为原 Node/Tools → 原 getState
preflight → genuine Lifetime observer → seal → publish。仅在真正已知 factory 中将
安装后 observer 的同一 stream/iterator 函数落为 immutable own data。原 graph.invoke
继续同原函数；派生图先核父原 inherited 基准，然后独立安装，不能继承父 installation。
Factory seal 需要接受的 observer 地址只能来自原 Lifetime 私 installation 关系。

本阶段还需固定实际 getState preflight adapter 的地址和 flags：这是本次调用尚未
获得 runtime 时的实际初始化查询来源。不能允许未知替代 getState 在同 ALS 中提供
一个配置或“初始化完成”布尔。只固定该真正已安装函数，保原 delegate/receiver/次数。

### 创建时的真实 Scope 检查和取消输入

Scope 原构造函数已有 module-owned `scopeSourceBases/scopeData`。拟从同模块提供
free readonly reader，只认原构造记录，返回固定的 `assertOpeningCurrent`、
`assertOpeningDataCurrent`、原 host signal 和 controller signal 数据。两检查均核
同 Scope/实际 authority/host/parent/physical Saver 与原字段；full 调用固定原 guard，
pure 只读原私表、intrinsic signals 与 descriptor。此时不要求 namespace/binding
已经存在，不调用 captureNode，不建立 Producer，不延长短寿 nativeRead。

这个 reader 只服务于已有实际 scope 的检查，不授新 scope 资格。克隆、Proxy、晚
字段替换、已 closed/quarantined 的 scope 均拒。原 generic scope 或无 native factory
仍按原方式使用；不能因为请求 stream 就自动升级它。

一次 native stream 首 callback 前捕获原输入/消息 data 与 config，建立自己的 cut。
取消组合 S 按 `[cut, scopeHostSignal, scopeControllerSignal, callSignal?]` 原顺序一次
形成；普通 caller signal 仍须 genuine 输入，不能用 shape。Shared 本轮默认 signal
继续原显式拒绝，Main 取消适配的私 D 不搬进这条路径。scope/controller 的真实地址
由 ctor record 取得，不由 caller 传 runtime 推导；组合 signal 只给取消，不授来源。

实际 original Agent.stream 接收 S。其默认 signal 当前为空，原合并保该输入；
Lifetime installed graph.stream 在原 Pregel 合并之前记录并核真实收到的 S。之后
Pregel 自己的 combinedSignal 原样交给 iterator，不在宿主重新计算或改其 reason。
runtime.signal、target.signal 与 S 是独立的原取消约束，ready 后全部保持原检查。

ordinary state 的原初始化会调用已安装 getState。这个 adapter 必须在原 Scope
preflight 成功后，登记本次同 factory/domain/operation 的实际配置 signal 地址；
在这之前从初始化 callback 直接调用 compiled stream 的尝试 sticky 拒绝，不允许
占掉真实 Agent 的第一次 stream。其 descriptor/原 callback checks 全在登记之前，
不把 config 放入新的 nonce，也不向 callback 暴露可注册的 receipt。

Command/null 跳过 ReactAgent 初始化的真实分支，不能借普通 state 的 preflight
receipt；需实际固定原 Agent entry + 原 Scope/Saver 接纳路径的独立分支。初窗若该
分支接口未接齐，必须明确拒绝并保留后续工作，不能从公开 Command/ID/配置补证明。

### Source 从 created 到 ready 的一次接纳

拟在 Shared stream 模块私 WeakMap 中固定本次
`{factory, graph, domain, scope, installation, operation, S, lifetime}`。公开迭代器
没有 activate、runtime 或 Host setter。创建 Source 的内部入口只接受已由实际
`runSharedNativeFactoryDomain` 建立的那一个 domain，与原 scope exact 相等。

Lifetime 对 Shared 使用两个分离阶段：opening 原 Scope guard，以及 activation 后
ready 原 view guard。首 source 回调前占据 reading/failed latch；错阶段、同步重入、
第二次 stream shell、换 signal/工厂/图/Scope 都 sticky 失败。source token 只代表
同一次真实观察范围；未 activation 时不提供 SSE diagnostic/partial/runtime reader。

只有 `admitFunctionConversationSharedNativeInvocation` 的原真实 Saver admission
可调用内部 `activateSharedNativeStreamSource(domain, view)`。这不是通用注册 API：
先完成原 Producer/authority/runtime/binding/owner/target/database/destination/
policySource checks，完成 Host 创建及原 Tools attachment，原 ready view full/data
核成功后，再按私 pending record 一次激活。unknown Producer、假 view、另一 domain
或重复 activation 拒绝；失败记录不能重置或降为普通流。

activation 固定真正 child runtime/Host/原 Producer view，保留原 short read lifetime。
Lifetime 此后 pin 的 invocation 为 `{runtime: view.runtime, signal: S}`。必须强核
原 stream shell 已观察 S、域与 Scope 同一、原 ready 关系仍 current。这里不要求
runtime.signal === S，也不凭二者状态相等授权：runtime/Producer 原 signal 地址继续
由原 admission 证明，S 由实际 graph.stream 原入口证明。两个来源各自检查。

| 阶段 | 可执行操作 | 可交付帧 |
| --- | --- | --- |
| created/opening | 固定 Scope 检查、原初始化/stream shell | 无 |
| preparing | 原 Saver admit、原 runtime/Host 安装 | 无 |
| ready | 同源 next、原 Node/Calls/writer/23+ledger checks | 完整验后可交付 |
| closing | 原 abort、return/finally、所有 drain | 无新帧 |
| closed | 原全部真实终态成功 | 无 |
| failed/quarantined | 继续观察真实终态、保留未知占用 | 无 |

普通等待需求不导致 closing，未激活的初始 values 也不能被当成普通帧放行。原
getTuple 接纳先于任何 provider 回调/输出这一时序必须用真实 Saver/模型回归证明。

### 背压和一个实际后台 Promise

公开 stream 返回真正 `IterableReadableStream` 的外形。内部先登记 work/early-cancel
再启动后台微任务；后台在同一次 factory-domain 与同一次 scope.run 内 await 原
Agent.stream，保存原 iterable/reader 和所有真实 iterator 操作 Promise。不开第二图。

外部 next 将需求放入私队列；后台串行执行真正 next。最多一个实际 next 和一个
已验证待交付帧，不因异步事件预拉全部历史。并发 next 也只串行排队，按原顺序
交付；第二 consumer/readable lock 按原接口拒，不另给它新的 scope。

cancel/return/throw 先同步使本次 cut 取消、标记禁止出站，再 wake 队列；不能等 held
next 完成才 abort。后台分别观察已进行 next、原 return/throw 的真实终态，不以
Promise.all 首拒跳过任何组。普通自然结束走同一 once-finalizer，不额外写入。

已经取消的待交付帧拒绝。所有外部 demand promises 都有确定的结束/错误状态；
cancel 在原 stream Promise 尚未 bind 时由 early latch 保留，bind 后立即执行相同
清理，不遗失首次取消。不能把 stream promise 返回或 consumer 已 return 作为
scope.run 完成证明。

### 每帧的原来源与末尾

复用 Shared return-source 的 initial ordinary input exact baseline、实际 Saver
history 读取视图和本 Host exact Entry，禁止未知新增 unmarked 消息。values/updates
里每条消息都分类，先完整副本，所有原 source/history/membership callbacks 后一次
完整 batch 23+ledger A/B，再逐 original/copy/source/container/domain/S 纯核交付。
history 不能在 B 后重新调带 callback 的 reader，frame object/tuple/state keys 不靠
同 UUID 或 JSON 重建来源。updates 的非消息字段只原已支持框架合同，不任意复制。

messages 原真实 partial 只用本 Host Calls 与本 domain actual Node/Slot/Attempt，
保持已存在 live 与 completed 区分；完成帧只原 Lifetime completion/writer 地址，
不能从公开 stream tuple mint。原 provider 消息、safe 替换、namespace、四种形态
按现 Main adapter 原合同核，不用 parent Host 或另一并行 Source。

本窗按 values/messages/updates 单/多模式与 subgraphs 全回检。SSE 紧接同真 Source
激活后接原 diagnostic/private partial/OMIT/共享 driver；若首窗尚未接 SSE，则明确
reject 并记录未完成，不能先使用 Pregel 的 raw toEventStream。其 deferred pull 有限
记录仍按原 256/cut/1M 合同，不复制池；全部 canonical callbacks 后编码与同步
enqueue，旧帧在出队前再核源。streamEvents/v2/未知模式仍等其独立来源方案。

### 真终态与回归

once-finalizer 次序固定为禁止出站/abort → 原 iterable return 与 pending next 真
finally → 全部 same-domain Node、Host、diagnostic/Worker drain 独立 allSettled →
原 scope.run 结算 → Manager 原 Scope close/whenDrained 与 authority release。
任何 close/drain rejection 包括 undefined 都按 status 保 failed/quarantine；原未知
占用不伪造 idle，不以 consumer cancellation 提前释放 namespace。结果副本无 grant，
Host finally-close 不能改已交付内容。

必须新增实际 ordinary 初始化期 graph.stream 抢先/agent 重入、同图两个 domains、
延迟真正 Saver admit、创建时取消、held actual provider finally、暂停需求再取消、
end-before-ready、drain undefined failure、全部消息来源与四形态/SSE 回归。原 Tool
效应/模型调用/Hook/fullnative/23/CP/member/frontier/default5 断言全保。原 Main 四形态
与 Lifetime installer、generic/旧插件及 Electron 再统一验，不用设计票代实际通过。

### 两个必须落在实际调用点的补充

**activation 的私有 join。** 拟新增 free reader
`readSharedNativeStreamActivation(domainToken, pendingOperation)`，但实现仍在原
`function-conversation-shared-native-domain.ts` 内：先从原 domains/domainFacts 取得
exact record、原 factory/scope、原 module-owned view 与 original Producer 地址；
descriptor/私表关系全核，然后与 Shared stream 模块的 pending operation 私表相互
匹配。不接收 caller 提供的 view/runtime，也不因 phase 字符串相同返回证明。
pending record 必须已经 pin 同 original factory、graph、observer installation、
scope、domain token、实际 stream S 和本次 original Agent 方法操作；clone 或另一
operation 即使字段相同也不能替换。

原 admit 在现 `publishSharedNativeDomainView` 后还有 Host/Tools attachment 与原
full/data 检查。本次 activation 严格放在这些操作全部成功之后。publish 产生的
短暂 ready phase 不开放 Source ready 读取。activation 再完整核 original Producer
及 same runtime/policy/Host/view，最后所有 callback 后纯 join + 原 S/source shell
事实，才将 pending Source 私状态从 opening/preparing 原子置为 ready。重复、错阶段、
Host 安装失败、late view/Producer 替换或第二 activation 都 sticky failed；不能
重新创建 Source 或把第一次失败记录换成新 record。这里只保存已有原 read view，
不让已退休 nativeRead token 重新进入 read API。

**不同 Lifetime 调用点明确分流。** 不是让一个可替换的 assertCurrent 闭包在内部
猜阶段。拟在原 Lifetime 私 Source record 保存固定的 openingFull/openingData 与
激活后固定的 readyFull/readyData，并由下面命名操作按私 stage 检查：

| 原实际调用点 | 必须调用的检查 |
| --- | --- |
| observed graph.stream 首 options/S/encoding 捕获前后 | `assertShellCurrent`：未激活仅原 Scope openingFull/Data，已激活 readyFull/Data；同一次 shell latch |
| observed `_streamIterator` 建立原 generator 前后 | `assertIteratorOpeningCurrent`：允许原 getTuple 尚未运行的 opening；不读取 Host/Slot |
| step 原 next/return/throw 之前 | `assertStepCurrent`：opening 只允许同一原操作推进接纳；ready 必须原 readyFull/Data；closing 仅原受控 drain |
| 原 next 得到非 done 帧后，decode/route 之前 | `assertFrameReadyCurrent`：readyFull/Data；仍 opening 时明确拒，无 ordinary fallback |
| actual Node completion 登记/读取、successful writer 观察/读取 | `assertProducerReadyCurrent`：ready，same graph/runtime/Node/Slot/原 writer 关系全部核 |
| current SSE Source、diagnostic mint/read、partial Source reader | `assertDiagnosticReadyCurrent`：ready；未激活的 encoding 意图不提供这些 reader |
| encode/enqueue 或普通帧待交付出队纯尾 | `assertFrameReadyData`：同 private activation/operation/S 与原消息来源完整纯核，不能再次 full callback |

opening 检查只执行 ctor-fixed Scope 原 guard 与原纯数据 counterpart，不调用
captureNode，不调用 view.assertCurrent，不查找父 runtime，不读 Calls/partial/Host。
实际 generator 的第一次 next 在这一阶段推进真 Saver.getTuple，admit 成功激活后，
所有 producer 操作才可用。原 callback 异常/reentry 即使被 catch，也让该原 Source
stage sticky failed。ready guard 无 mutable public setter；所谓分流只是模块对
固定私函数的命名调用，不能让 caller callback 选择 full 或 data。

return/drain 不借 opening 获得发布权，closing 下也不能读取新 partial/diagnostic。
其原 generator finally 可能继续执行必要内部终态，宿主仍按原实际 Promise 观察；
若不能完成，沿原 quarantine 而不伪造 ready/closed。Command/null 的最终目标仍是
同原使用方式支持；初窗可留明确拒绝，但须继续接它的原 entry/read 接点和 SSE
下一窗，不能用此初窗门宣称全部 Shared stream 已完成。

### 首个独立实现块：Scope opening 原构造事实

已新增 `readFunctionConversationSharedCheckpointOpeningCurrent(scope)`，返回 frozen
`{saver, authority, signal, controllerSignal, assertCurrent, assertDataCurrent}`。它只
消费成功原构造函数保存的私有 ScopeOpeningRecord 和 ScopeSourceBase；不存在 caller
注册 reader、提供 callback 或复制 token 的入口。未知 Scope、克隆或 Proxy 返回无
此记录，不执行它们的 getter/trap，也不据此选择任何 Shared 工厂。

构造时固定 Scope 的 host/controller/parent/ancestors/checkpointer 数据地址、原
prototype 和 descriptor flags，quarantined 初始 own-data false，以及 frozen host、
parent 和 ancestors 的完整 own-data 字段。closed 用原不可逆 scopeData 状态；每次
纯检查核原 authority 私 lineage 和两个原 signal intrinsic，不查 namespace/binding、
不调用 captureNode/Saver.getTuple，也不读取父 Host/runtime。full 方法在首原 callback
前占私 reading/failed latch，执行 data → class static 已捕的原 Scope.guard(actual
scope) → data；捕获的重入或晚字段失败不可通过恢复属性复活。

这份证据只用于已存在 Scope 的 opening 生命周期，不授 Producer、nativeRead、消息、
diagnostic、partial、ACK 或 append 资格。原 guard/source callback 次数与原 getTuple/
admit/run/close/quarantine 逻辑保留。新真实 parent StateGraph/Saver 回归证明尚未有
namespace 时 pure 不回调、full 委托一次而 getTuple 为零，随后原真正 child 仍能运行；
另有各原字段 getter 零执行、caught source reentry、未知克隆和实际 close signal 门。
Root 已在 `output/stage23-shared-opening-first-current.log` 实跑原三例与新九例，
12/12 通过；限定 Scope opening，不使用它代替后续流式接线的实际结果。

### 下一独立窗口：真 Factory 与 Observer 的一次 seal

状态：Factory/Lifetime 的命名 seal 基础块已取得 Root/Latest 两票并实现冻结，
新十个实际来源定义已由 Root 运行通过。SharedInvocation 与 Domain 尚未消费该安装，
未开放 Shared stream。Main 基础安装 record 的 true flags 不放宽；false flags
只来自下面两个模块共同认证的唯一 transition。

原 `sealFunctionConversationSharedNativeAgentDispatch` 增加可选的 genuine observer
installation；没有该参数的既有 Shared invoke 路径保持原三个方法 seal。新分支
只从 Factory 原 agents 私表取得 OriginalAgent，先核原 agent/options/graph 地址与
原 inherited stream/iterator 的 owner、路径、函数、data flags。Lifetime installation
原两个方法必须完整匹配这个首基准；不能用当前 own observer 地址重新建立父原基准，
也不能因为 parent 已 own seal 就略过 derive 前的 original inheritance 检查。

Factory 的该函数内部自产一次 opaque `SharedNativeObserverSealRequest`。私表固定
OriginalAgent、actual graph、同 installation、两原函数/路径、两实际 observed 函数
与首 flags，且 first/used/failed 只在模块 private record。没有 exported mint 或
caller callback 注册。Lifetime 增加只读 request reader 的消费点：unknown、clone、
错 agent/graph/installation/地址在任何 define 前拒绝。这个 reader 是 Factory-owned
私表查核，不是接受函数或 public flags 声明。

具体同步顺序为 Factory 原结构/继承核 → 记录本次 request → Lifetime 原安装纯核
及 request exact join → 固定同两个 observed 函数 own writable/configurable false →
更新该 installation 的 module-owned expected descriptors → 再核两边 private join
并消费 request → Factory 保存实际 immutable dispatch。任何部分失败永久 failed，
不能读取当前 false flags 修复 record，不能另 mint request 重试；失败新 factory
沿原 actual Node/Tools drain/retire，不影响原图。整个 transition 没有 runtime/Source
callback 或 await，也不授 Producer/target/message 权。

Main 不传 request，不增加 immutable 要求，旧 install/create 仍按原 true flags。
每个真正 derive 新图都核父原继承基准、独立安装并独立 seal；不能复用父 token。
Factory/Lifetime 双私表 reader 必须固定原 WeakMap intrinsic；可循环引用的函数只在
实际 construction 后执行，任何新增 value import 不得引入 DesktopDB/Host/Electron。
Worker 实际 import/bundle 回归是这条依赖布局的门，不以类型或源码方向票代替。

getState 的固定 adapter 属于接续的 preflight 来源接点：只接受原 known Shared
installer 自造的 adapter 地址、原 delegate/receiver 和模块私记录，不能在 seal
调用中传 arbitrary getState 函数。它在真正 Scope.preflight 完成前后核本次 private
pending operation 与实际 S。其来源 proof 与 immutable data flags 必须在 publish
前一并固定，不能从最后 `graph.getState` 当前值或公开 config 建基准。此接点未齐时
不开放 Shared stream；以上 observer seal 本身不是原 Agent 初始化完成的证明。

必须的真实门为：same observed functions/receiver 和完整 descriptors；两个 actual
calls 只读复用 sealed installation；unknown/clone/foreign request、晚 prototype
污染及 caught 修改/restoration 0 Source；真实 init 尝试替 stream/iterator/getState
拒且 fake0；derive 新图 token 独立、原 base 仍可运行。旧 Main Lifetime 21 与实际
四形态/SSE、原 Shared 27 全部保留，默认 5 秒不改变。

### ready 激活和普通 partial 仍须独立接齐

`publishSharedNativeDomainView` 目前先写 ready，然后原 admit 还会运行完整 view guard、
Host/Tools attachment 和末 guard。这份短暂 public phase 不能激活 Source。拟在最后
原 guard 成功后的同步行调用 `completeSharedNativeStreamActivation(domainToken)`：
它只由原 admit 实际闭包取得 token；从 Domain 原 private facts、original Producer、
同 factory/Scope/view 及 Stream pending-operation 私表相互查核，不接受 caller view、
runtime、full/data callback 或 boolean。

pending operation 只在真正 known factory 的受控 stream 入口、首 external callback
前占 reading/failed 后创建；实际 `runSharedNativeFactoryDomain` 内将其 pin 到同一次
created Domain。它固定 input 首基准、原 agent 方法、factory、graph、Scope opening
view、observer installation、S 与原操作地址。preflight、stream shell、iterator 与
admit 都必须命中同一 pending operation；任何被 catch 的错阶段/重入毒化它，不靠
ALS-only、signal 状态或 object shape 重新选择。

激活完整原 original/view/runtime/policy 检查结束后，最后纯核所有私关系与原 S，
将 opaque activation 保存一次。Lifetime 的命名调用点从这份 private activation
选固定 readyFull/readyData；opening 只核 Scope，不读父 runtime。重复/错阶段/失败
attachment/换 view 均拒，第二个 token 不能覆盖第一次失败。实际 ready frame 的
来源、完整 CP/history/23/ledger 与全部 finally/drain 仍按前文保留。

普通 `messages` partial 的现存边界也须明确：Host callback 的 AIMessageChunk 替换
没有完整 own Entry/23；现 partial reader 的私 sseWires 仅登记 true SSE Source。
complete Return 的四类 input/history/owned classifier 不能认证这种 live chunk，
也不能用 unmarked validate noop、provider ID 或 JSON 当来源。放开普通 messages
前必须接本 Host exact callback/Attempt、同 actual Source/Node 与完整 raw/safe/wire
digest 的独立 partial reader；opening 不登记，ready 原 full/pure 尾齐才可复制。

背压时 queued partial 可能在下一次 demand 前 sealed：不得删原 live guard或 catch
失败当完成。须沿 true same-Attempt completion/Host ACK/原 writer evidence 明确处理
已完成帧的交付或 omission，输出前整批最后 callbacks/23/ledger B 之后再所有 pure
partial/data/container 尾。SSE 继续用原共享 driver 与 deferred OMIT 来源，不复制池。
首实现若只接 values/updates 完整消息，messages/SSE/Command/null 仍明确未完成并在
接续窗口实现；不能使用该基础门宣称完整原 Shared stream 已经恢复。

### 首个 seal 增量的准确 API 与失败状态

状态：这一节的首独立窗口已经实现、完成独立 Source 审核与 Root 实际门，只改
`native-agent-factory.ts`、`function-conversation-native-lifetime.ts` 及对应真实测试。
SharedInvocation/Domain/getState/stream 的接线保持冻结；因此这项即使通过也不能
打开 Shared stream。当前 Main observer 的 true flags 与原 full 次数保持。

Factory 按原 `OriginalAgent` 地址在 module private WeakMap 保存 `observerSeal` 状态，
不新增可经 Object.prototype 回落的 optional 状态字段。该状态不写进公开
agent/graph/config，包含 `reading/failed/completed`，以及当前唯一 request 地址。
任何开始过的失败都不可重试；原 `assertStructure` 在已有 failed seal 时拒绝，
包括已恢复函数地址的图。没有该状态的 Main 与原 Shared invoke 三地址 seal 原样。

Lifetime 增加 data-only provenance reader：

```ts
readFunctionConversationNativeSourceObserverOrigin(installation, graph)
```

它只从既有 `observerRecords` 固定原 WeakMap get 取实际 record，先核 exact token、
graph 及原安装纯尾，再返回 frozen 原来源数据：stream/iterator 的 original method、
原 path/prototypes/完整 descriptor，以及自产 observed own descriptor。没有 caller
callback、注册来源或 setter；外部复制该数据不进入 Factory 或 Lifetime 私表。
原 record 的 fields 来自第一次 install 时 `captureObserverMethod`，不是 seal 时
重新捕获当前图。Factory 的另一侧基准来自 createAgent/register 当时既有
`OriginalAgent.graphStream/graphIterator`，包括首次 inherited owner、path、函数与
flags。两侧逐项完整相等，original root 必须是同 actual graph。parent 派生前仍
核 original inherited 基准，不能用父的 own observer 或 sealed 地址替代它。

Factory 原 seal API 增加可选 installation：

```ts
sealFunctionConversationSharedNativeAgentDispatch(agent, installation?)
```

新分支在首来源读取前占 `observerSeal.reading`，查原 agents 私表并核 agent/options/
graph/method/原 prototype。先核原 stream/iterator inherited 基准，再读上述 origin，
两侧严等后内部 mint 一个 frozen `SharedNativeObserverSealRequest`。request 的品牌
及全部 `{original, agent, graph, installation, origin, beforeFields, sealedFields}`
只存 Factory 私 WeakMap；不导出 mint，也不接受 public 原函数或 flags 代替 origin。

供 Lifetime 使用的 Factory free reader 为：

```ts
claimFunctionConversationSharedNativeObserverSeal(request, installation, graph)
```

Lifetime 在 claim 前先调用 Factory 的纯关系 reader
`isFunctionConversationSharedNativeObserverSealRequest(request, installation, graph)`。
它仅用固定原 WeakMap get 比较这三个私地址，不读 token 属性，不 claim，不运行
Source，也不返回执行许可。未知、clone、foreign 在 Lifetime 的失败 catch 外拒绝，
不会毒化别的实际安装。已经 failed 的真实 request 仍可命中这个关系；这只说明
后续 claim 失败应永久毒化同一 Lifetime record，不能把失败 request 恢复为执行权。

它先 exact 私表查核 request/installation/graph，未知、clone、foreign 在任何 define
前拒；再核原 `OriginalAgent` 仍是 agents 私表同记录、same active seal operation。
request 从 pending 一次置 claimed；第二次 claim 毒化该 request 与本次 seal。
返回 module-selfmade frozen view，只有固定数据和两份纯检查闭包：
`assertBeforeDataCurrent()` 要求两个 observed own fields 仍是首 true flags；
`assertSealedDataCurrent()` 要求同 observed 函数、enumerable 原值及 false/false。
两者都核 actual Factory/agent 原关系与原 inherited 方法；不运行 runtime/Source/
Scope/Host callback，不接受外部 inspector。第一次还未 sealed 时不能调用后一份
检查得到许可，后一份仅说明该 request 要求的实际状态，不授 Source 或消息权。

Lifetime 实际消费 API 为：

```ts
sealFunctionConversationNativeSourceObserverInstallation(installation, request)
```

内部顺序固定为：actual installation 私记录查核 → Factory exact 三地址纯关系 →
进入同 record 的永久失败 catch → Factory once claim → 原
installation 全纯核与 before view → 依次 define same observed stream/iterator 为
own nonwrite/nonconfig → 更新该 record 的 expected descriptors → 原全纯核与 sealed
view。`streamField/iteratorField` 只由这一段模块代码更新，不因读到外部 false flags
而更新。request view 不含 arbitrary define 函数，实际 define 只执行本模块固定代码。

两个 define 中任一失败，或后续任一 join 失败，Lifetime record.failed 与 Factory
observerSeal.failed 都永久 true。已经落下的 immutable 字段不尝试撤销；第二次
调用不得依据当前半 seal 或另一 request 修复。Factory 外层 catch 同时毒化本次
request，真实 Shared installer 沿原独立 drain/retire 处理失败新图。原 agent/base
的安装记录不受派生新图失败影响。这里没有 await、外部 callback 或可公开重入阶段。

Lifetime 返回后，Factory 才按原地址锁 graph.invoke，捕获三个实际 immutable own
dispatch 并保存原受控 invoke，进行原结构检查；最后私 request 标 used、seal 标
completed。任一原结构失败同样进入永久 failed。原无 installation 路径不经过这些
状态或新 reader，原方法/receiver/flag 检查与顺序保留。

两模块可互相 import 固定 free function，但这些函数只在真实 install/seal 调用期
执行，不在 module evaluation mint 或读图。Factory 不引入 SharedInvocation、Scope、
Saver、Host、AppDB 或 Electron value import。Lifetime 维持当前纯来源依赖。Root
需要实际 Worker import/bundle 门确认这项布局；源码票不能替代该门。

必须新增实际 known createAgent 安装回归：安装 origin 与首次 Factory inherited
地址严格相等、same token seal 后 fromInstallation 两 calls 只读复用、两 observed
函数地址不变且 own false flags；unknown/clone/foreign request 0 define/Source；
分别第一次/第二次 define 失败的半 seal 永久拒且无法用当前 descriptors 重新认领；
派生前污染 inherited owner/functions 拒绝、恢复后原 base 保持可用；Main 既有 true
flags 及 Lifetime21 全保。测试攻击必须委托真实 origin/安装，不造 getter proof。

本次首 observer seal 实现冻结范围为 Factory 与 Lifetime 的上述命名区域，以及
`native-shared-observer-seal.test.ts` 的 10 个定义。包括 claim 首边界 caught 同图重入
导致两记录失败、Factory 最后 invoke 发布失败使 Lifetime 同时失活。实际 run 在微任务
启动前留存原 Promise，清理先 abort 原 signal，再独立观察真实 run、Lifetime drain
和 settled 后关闭 Saver。源码与实际门分别记录；目前未据这些定义宣称 Shared stream
或后续 getState/ready 已经通过实际测试。Root 实际运行新 seal 10 与 Factory 27，
37/37 通过，日志为 `output/stage23-shared-observer-seal-factory-first.log`。

Factory 原私有 OriginalAgent literal 将既有 optional `deriving/dispatch` 明确初始化为
own-data undefined，随后原赋值逻辑不变。首次纯 claim/structure 与真正 derive 不会
通过 Object.prototype 上同名 getter 取初态；真实 claim 与 derive 的原型注入回归须
在恢复后断言零读取。这里仅固定两项已有私字段，不扩大全局对象或 Shared ready 许可。

### getState 来源接口的准确布局（接续窗口，尚未实施）

初始化凭据归 `mods-conversation-shared-invocation.ts` 的真实 installer，不能为了
让 Factory seal 查它而把这个 Desktop 模块 value import 进 Factory/Lifetime。
首 observer seal 没有 getState 参数，不宣称已通过初始化。Source 创建的实际 Shared
入口需要同时读 Factory dispatch、observer installation 和下述私 preflight record，
缺任一仍显式拒绝；公共 phase/config/class/name 不替代其中任何一个。

Factory 在原 register 增加 `graphGetState` 原 method address 数据，来自第一次 actual
createAgent 的 graph 与 inherited original path/fn/flags；Shared installer 用
data-only `readFunctionConversationNativeAgentPreflightOrigin(agent)` 查这个原私表。
该 reader 不能接受 caller 方法，也不把当前 own getState 重新当原来源。Shared
派生构造前核 parent 原 getState inherited 基准，新图仍需同 original owner/path/
function/flags（首 graph 地址独立），防父已安装 own adapter 隐藏 prototype 污染。
Main 原 getState 插装不新增这种 Shared seal 要求。

原 `installSharedInvocationGraph` 内自造 preflight adapter，并在同模块私表记录：

```ts
FunctionConversationSharedNativePreflightInstallation // opaque brand
readFunctionConversationSharedNativePreflightInstallation(token, agent, graph)
```

record 固定 actual known factory、originalAgent、graph、Factory 原 getState origin、
自产 adapter 地址、capture 原闭包地址、descriptor 与 first/failed 状态。没有 exported
adapter registration 或接受 arbitrary function 的 reader。实际 installer 用固定
original getState fn + actual graph receiver，不再晚读 `.bind`。原 generic 无 factory
分支仍按原 capture/preflight 行为；它不产生这份 native record。

Scope 补一份原构造记录 free reader，返回同 actual Scope 的固定 original preflight
调用闭包，调用仍是既有 captured class-static `Scope.preflight(scope, config, read)`
等效 receiver/参数/次数。它只核原 opening facts，不选 namespace，不 mint Producer。
这份 reader 只由 Shared installer/stream 入口读取；Factory/Lifetime 不 import 它。
`read` 是 adapter 固定原 getState 的调用，不是 caller 提供的来源声明。

adapter 在实际 getState 入口依次执行：从本模块私 record 与 Stream pending-operation
私表查 same factory/agent/graph/scope/S/operation → 原 Scope opening data 与 original
preflight FULL → 原 getState actual read → exact config/S/operation 和 opening data
重核 → 记录成功 preflight receipt。record 持本次原 config 地址、signal own data
descriptor、Scope 和 original result 地址；没有 config nonce，不在 callback 参数
新增 receipt。真实 readonly Scope/preflight/graph-getState Promise settle 前不能登记
成功 receipt，也不能用 phase/preparing 当成功。所有原 callback 保原 receiver、
次数与结果/异常；增加的末检查仅纯数据。Command/null 不走该普通 state receipt。

完成真实 Node/Tools/getState installation 后，getState adapter 以同函数 own
nonwrite/nonconfig 固定，私 record 保存准确 installer flags；Shared publish 前同时
核这份 record 与 observer seal 原关系。实际 Source stream shell 只在该操作的成功
preflight receipt 后开放 ordinary state 的 opening advance。初始化 callback 直接
抢 graph.stream、另一次 agent call 或另 operation 的 config 即使相同均 sticky 拒；
receipt 本身仍不开放 frame/diagnostic/partial，ready 必须原 true Saver admit。

上述 getState 接线、Scope preflight free reader、private pending/ready 和后台消费者
仍各需 Root/Latest 两票与真实初始抢先/并行/取消/held finally 门。首 observer seal
通过不能据此发布任何 Shared stream 功能。

### 接续窗口的 private preflight 与 ready API（设计请求）

审核状态：本节的整条流式设计暂未获批准。独立评审指出真实 initialization callback
可能先调用 getState 取得 first receipt，再直接抢 stream；首见地址、同 Scope/S、ALS
或稍后重复拒绝不能证明原 ReactAgent 私初始化调用。此外，pure Domain 对 Desktop
pending 自产资格的双私表消费者尚须落到具体原模块来源，不能 blind register。
以上两点闭合前不实施 pending/ready 或输出，本节保留为待修合同。

本节把上一节的布局落到当前原函数的实际行序，仍未修改产源。首接续窗口先接
getState 来源、一次 pending/ready 激活和基础 values/updates 驱动；ordinary messages
partial、Command/null 的独立入口及 SSE 仍有后续门，不据此宣布全部流式完成。

实际框架接点是 `ReactAgent.#initializeMiddlewareStates`：普通 state 先执行原
middleware state defaults，再 await `graph.getState(mergedConfig)`，并捕获该查询的
异常为 `{ values: {} }`；原 `stream` await 这整个初始化后才调 `graph.stream`。
因此 adapter 失败不能只 throw：其 private operation 必须 sticky failed，随后
observed stream shell 再核失败状态。原成功 getState 的结果不成为消息来源，也不
证明真实子 namespace 已分配。Command/null 在同框架方法里跳过这个 getState，不能
凭缺 receipt 当作普通 state 成功；首窗先明确拒绝，下一窗接其真正原入口。

#### 1. Factory 固定原 getState，installer 固定实际 adapter

`native-agent-factory.ts` 增加 `OriginalAgent.graphGetState`，使用当前 `captureMethod`
同一算法从原 register 的 actual graph 捕 inherited owner/path/function/data flags。
这不是后来从 `graph.getState` 当前值截取。其限定 reader 为：

```ts
readFunctionConversationNativeAgentPreflightOrigin(agent)
  // undefined for unknown; otherwise frozen actual graph + original method address facts
```

reader 不提供 caller inspector、注册、执行或 Source 权。known getter/Proxy/clone 仍
在原私表前门拒绝；true derived agent 在构造前先核 parent 的原 inherited getState
基准，构造后核 child 同 original owner/path/function/flags，只有首 graph 地址不同。
Main 原 getState 插装不新增 immutable gate，Shared 来源分支单独消费这份原数据。

`mods-conversation-shared-invocation.ts` 的 `installSharedInvocationGraph` 在 native
factory 分支自产唯一 preflight adapter，不晚读 `actualGraph.getState.bind`。同模块
私 WeakMap 按 installation token 固定以下数据：actual factory/token、agent、graph、
Factory origin、actual adapter、original delegate 与 graph receiver、capture 原函数、
own descriptor、failed/installed。安装时同原 getState 签名，固定 delegate 只执行
一次；generic 分支保原 capture/preflight 路径，不取得 native installation token。

```ts
FunctionConversationSharedNativePreflightInstallation  // opaque
readFunctionConversationSharedNativePreflightInstallation(token, agent, graph)
  // exact three-address lookup and original descriptor/provenance data check only
```

该 reader 不接受 adapter、guard 或 caller record。实际 install 在 Node/Tools 安装后
定义 adapter，随后 install Lifetime observer、完成 observer seal，最后同 adapter
地址 own nonwrite/nonconfig 后 publish factory。任何已开始的实际安装失败永久毒化
本 installation/factory，并沿原 Node/Tool drain 退休；不按半安装字段重新造基准。
派生图有独立 record。Source 创建前必须同时核此 installation 和既有 observer
installation/seal；copy token 或拿另一图 token 不进入执行。

#### 2. Scope 执行与成功 settle 的 receipt

`conversation-shared-checkpointer.ts` 增加固定 class-evaluation 原 preflight 执行器，
不在读取时查 `scope.preflight`、prototype method 或 `.bind`。它仍运行原 preflight
的 entered、validatePreflight、preflights ALS、tracked(read)，原实际 receiver、
参数、callback 次数和结果/异常保持。Scope opening 原 WM 与 SourcePlan 检查先后
保留；它不复活已经 finally 删除的 NativeRead token。

实际执行图也要固定：`preflight → entered/validatePreflight/tracked`，`entered → guard`，
`validatePreflight → entered`，以及 preflightTuple 的 validatePreflight。各函数由原
class evaluation 捕获，不只固定第一个方法后继续晚读 `this.entered`。原 guard/context/
config 比较与 tracked 生命周期照原顺序，所有内部 receiver 仍是同真实 Scope；首尾
只有数据门，不增加原 Source callback。成功 receipt 的来源因此是这个原完整调用图，
不是刚好返回成功的替换类方法。generic 旧 Scope 调用原行为不增加这种来源资格。

构造期 record 同时固定这个执行图实际依赖的 `context/preflights/invocation/pending`
原地址与完整 own data flags；原 host/parent/ancestors/checkpointer/controller 来自已审
opening record。initializing/binding 的实际阶段值用 own descriptor 读取，preflight
入口仍要求原未选择状态，不能经 Object.prototype getter 读缺省值。receipt 后续
data尾只核原成功事实与固定关系，允许其后原 getTuple 真正初始化，不能把 preflight
时的未binding状态永久拿来阻断合法ready，也不能因后来ready补造早期失败receipt。

```ts
readFunctionConversationSharedCheckpointPreflight(scope)
  // known original Scope only; selfmade executor and data view
runFunctionConversationSharedCheckpointPreflight(scope, operation, config, originalRead)
  // actual installer uses fixed original read; receipt is returned only after true settle
readFunctionConversationSharedCheckpointPreflightReceipt(receipt, scope, operation, config)
  // exact original four addresses, successful-settled status and opening data check
```

`originalRead` 是本 installer 私 record 的固定 delegate 调用闭包；此参数只给原
preflight 保持执行次数，不声明来源、ready 或消息权限。receipt 是 Scope 模块自产
frozen 空 token，私 WM pin Scope、原 invocation/context、same operation、actual config
及其完整 native configurable pointers/flags、原 signal、真实 result、successful。
模块不接受 caller receipt，也不允许以外部 Promise 或 settled boolean 登记成功。
读器用 fixed WM/descriptor/intrinsic，只返回原 successful receipt 的 data check；
失败、close、quarantine、晚原字段变化、caught reentry 均 sticky，不能恢复再调用。

真正 `Scope.preflight` Promise 成功 settle 后，adapter 才在自身 pending record 保存
该 receipt 与 original result；没有 await 完成前的 early receipt。Scope 自己当前
preflightTuple 保持原 `undefined`，不得从 parent getState 或兄弟 CP 取值。Scope
opening/full 不调用 captureNode，namespace/binding 仍只由原首次非preflight getTuple
及 true host.admit 产生。

#### 3. 两个私表的 pending operation 与一次 Source 关联

`function-conversation-shared-native-stream.ts` 的真正 Shared `stream` 受控入口在任何
capture、Source/full callback、config resolver 之前固定首输入与 private operation。
普通原 Shared invoke 不进入这份 stream record。operation 固定 actual Factory agent
stream 原方法/receiver、graph、preflight/observer installation、真实 Scope opening
view、首 input data、fixed config、cancel S，且初态为 opening/reading=false/failed=false。
首次绑定必须在既有 `runSharedNativeFactoryDomain` 自产 created Domain 后、唯一
`scope.run` 开始前；从此 same operation 不能换 Scope/Domain/agent/installation。

pending 的完整执行 record 归 SharedInvocation/stream installer 私 WM；pure Domain
模块只持其自产 opaque capsule 的 exact routing association，固定 Domain 原 record、
factory、Scope、graph 与 same operation token。它不接受 caller-defined ready callback、
runtime 或 view 注册。既有实际 create/admit/run 闭包建立这份关联，不从 ALS、公开
phase、signal 相似性或 config keys 新建关联。复制 capsule 不命中任何私表。

```ts
bindSharedNativeStreamOperation(domain, operation, installation)
claimSharedNativeStreamSource(operation, observerInstallation)
readSharedNativeStreamStage(sourceToken, graph, point)
```

这三项是 module-owned pending/factory/Domain 的双私表消费者。`bind` 只允许原 created
Domain 与首 operation 一次；`claim` 只允许同原 Factory/graph 的真实 observer 私表
安装，并保存一次实际 Lifetime Source token。无 caller guard 参数，实际 opening
闭包只来自原 installer读取的 Scope private opening/preflight executor；ready 闭包只
能取下述原 actualadmit 激活的同 view。Lifetime 通过纯 Domain routing reader 消费
固定 capsule，不能 value import SharedInvocation、Scope、Host 或 DB。该 routing
capsule 本身只认证本次调用关系，不能替代 Host Calls/Entry、Producer、23 或 ledger。

preflight adapter 在首实际 getState 调用前占 operation reading 并查本 installation
私表与 Domain pending association：same factory/agent/graph/Scope/operation/S。普通
state 只成功一次；原 Scope executor settle 成功后保存实际 config 地址与 receipt。
后续 graph.stream shell 要求 receipt exact 同 operation/actual mergedConfig 地址及
原 signal。初始 callback 直接抢 stream、重复 getState、同 operation 嵌套 agent call
或恢复失败数据均毒化该 operation。并行正常 call 各有独立 operation/Domain/Scope，
不会通过全图 mutable last-operation 指针选择对方。

不以以上 shell receipt 声称完成 framework 全部 dispatch 证明：实际输出仍必须
本次首 input、真正历史、Host own Entry/Attempt/Writer 的独立来源。未知新增普通
消息依旧拒绝；superclass 返回 consumer fake 已有 Return 回归仍保留。

#### 4. 激活只在现 admit 的最后 guard 之后

实际改动接点为 `admitFunctionConversationSharedNativeInvocation` 最后两行：当前
`publishSharedNativeDomainView` → 原 `assertCurrent` → attachSharedTools → 最后原
`assertCurrent`。**新增 activation 在这个最后 assertCurrent 返回后的同步行**，
不移除或提前任何原 callback，不将 publish 写入的 ready phase 当作 Source ready。

```ts
completeSharedNativeStreamActivation(domainToken, operationToken)
readSharedNativeStreamActivation(activation, sourceToken, graph)
```

实际完成函数从原 Domain 私 facts 取 original Producer/view，而非接收参数 view。
再与 pending 私表查同 factory/agent/graph/Scope/operation/observer/preflight record、
actual Source、S，要求原 Producer 对同 authority 的模块 read、原 runtime/binding/
target/destination/database 与 true completeActive 关系，Host 原 graph/Tools attachment
私关系及 genuine policy source 已完成。末 original/view/policy full 保持原位置；
其后原 Producer/view/Host installation/policy 的完整 pure tails 与 pending/preflight
receipt 再核，最后才自产 frozen activation，并 pin 原 readyFull/readyData。

pure Domain token 与 Desktop pending 表必须相互 exact lookup；exported完成函数不能
仅按 phase/view shape 接受外来 token，不能接受 caller assertCurrent 或 after callback。
错阶段、重复、未 attachTools、foreign Producer/view/runtime、caught callback 重入和
failed/closing Domain 均拒且本 operation sticky。没有 stream operation 的旧 invoke
仍走原全部原路，不为它额外 mint activation。

Scope 原 `getTuple` 等待 host.admit 返回后仍执行其原 entered/binding.assertCurrent、
保存 binding/delegated；activation不改变这些原时序。Lifetime 第一 producer检查发生
在这些实际原读取成功之后，仍需 ready view FULL；不能因 activation早于Scope后段
而省略首次 Node/Host 原完整 guard。

#### 5. Lifetime 的调用点必须显式分流

Main Source 原 assertCurrent 调用点与次数原样；Shared Source 每个下列点命名调用
`readSharedNativeStreamStage`，无单个可替换的 current 函数或可公开 phase setter：

| 实际调用点 | 必须使用的检查 |
| --- | --- |
| observed graph.stream 首入口，原Pregel进入前 | same operation、成功 receipt、Factory/安装尾、Scope opening FULL/data |
| observed `_streamIterator` 首入口，原generator/setup之前 | same claim与一次stream状态、Scope opening FULL/data；仍无 partial/message/diag 权 |
| 原iterator第一次 next，真正getTuple/admit前 | 原 Scope opening FULL/data，不调 ready/captureNode |
| 首next成功返回任一非done frame | activation 必须已真实就绪；原ready FULL和独立frame来源 |
| recordNativeCompletion、observeWriter、diagnostic、completionDiagnostic、completions、acceptMessage | 同activation ready FULL/data；opening一律拒，不靠encoding分支放宽 |
| frame安全副本/编码/同步交付尾 | 所有原Source回调与wholebatch23/ledgerB后 ready/data + 原raw/copy/container/input/history/partial的pure尾 |
| 后续next/return/throw及关闭 | 已ready用原ready生命周期；未admit仅opening终止路径，不授输出，真finally/drain仍全部观察 |

`_streamIterator` 得到的是Pregel实际生成的后段signal S4，graph.stream shell得到的是
本次Agent实际传入 S。Source 不用重算 any 认证 S4，不因两个signal状态相等绑定它。
本窗 opening不提供SSE invocation runtime；ready之后同实际runtime/Calls/Entry独立
来源再接后续SSE。标准 caller取消在组合前descriptor/intrinsic检查，Runtime/Scope
原signal地址与frame尾保持，不借parent runtime填Lifetime字段。

#### 6. 下一实现的文件与实际门

精确产源布局为 Factory原getState来源（纯）、SharedInvocation实际adapter/admit末
激活（Desktop）、Scope原preflight executor/receipt、pure Domain小pending/activation
读器、Lifetime显式stage消费者、新 Shared stream 后台驱动。任何Factory/Lifetime/
Node→Desktop新value依赖都不接受。若实现需要跨模块reader，先使用其实际私表来源
合同，不临时导出 `register(callback)` 或把结构object当品牌。

首独立实现可先 freeze Factory+SharedInvocation+Scope 的 getState provenance基础，
不开放 stream；再 freeze pending/ready/后台基础窗，Root每窗实际运行。必须包含真实
getState once/result/error、swallowederror之后0provider、首次stream/getState抢先、
同图两个真正parallelScope、failed derive而base可继续、cancel初始化/首next/held finally、
Host/Tools最后guard失败0frame。真实sameSaver/Tool/provider/完整23/ledger/CP成员及旧
Shared29/Main31/Lifetime21/Observer10均保，默认5不改。Command/null与messages/SSE后续
窗的实际门要逐项记录，不能因为基础形态成功结束本任务。

### 先可独立实施的 getState 原地址基础（新 scoped 设计请求）

本限定基础已按 Root DESIGN1 / Latest DESIGN2 原子保存并冻结：
`native-agent-factory.ts` 与新增 `native-agent-preflight-origin.test.ts`，12 个真实定义。
Owner scoped SOURCE1、Root 与 Latest 独立 SOURCE2 均通过。Root 唯一实际 runner 已验证
12 个新增、Factory27、Observer10 与 Lifetime21，共 70 个实际用例全部通过，日志为
`output/stage23-shared-preflight-origin-foundation-current.log`。该结果只证明这些基础与
原行为回归，不证明完整 Shared 流式输出或 pending/ready 激活已经实施。

此首窗只在 `native-agent-factory.ts` 保存实际 known Agent.graph 的原 getState
inherited method 地址，并提供纯 readonly origin。它不安装 adapter、不执行 getState、
不读 Scope、不创建 receipt、pending、Source 或 ready，不允许据此调用 Shared stream。
因此不依赖上一节尚未闭合的首初始化调用资格。

具体保存位置仍为原 register：先通过既有 actual createAgent 私表/原 graph getter 与
完整 Agent/options 方法地址门，然后用原 `captureMethod` 算法捕 getState 的 root、
完整 prototype path、original owner/function 与所有 data descriptor flags。该 key
限定加入 `NativeMethodAddress` 的内部 union，没有 caller register/certify 参数。
OriginalAgent 私 literal 明确 own `graphGetState`；Factory 固定 WeakMap intrinsic 查核。

首 inherited 来源还必须对 actual known SDK module 基准：模块首次 evaluation 在未知
Factory/options callback之前固定 `CompiledStateGraph.prototype` 到原 getState owner
的完整path/function/flags。每个actual graph的首path只增加本graph root，后段必须同
这个module基准。不能把constructor或withConfig未知callback之后首次见到的污染方法
认成genuine。Origin/privatefailed放独立私WM，固定 actual OriginalAgent/parentOrigin。
若这份新增origin的初capture不合格，仅该origin记failed，不改变旧Factory创建/invoke/
Main的既有fallback或full guards；读取这份新origin时才严格拒绝。

```ts
readFunctionConversationNativeAgentPreflightOrigin(agent):
  NativeAgentPreflightOrigin | undefined
// frozen { graph, original, path, descriptor, assertOriginalDataCurrent() }
```

known reader 只按 exact agents 私表选 OriginalAgent，unknown/clone/Proxy返回 undefined
且零trap/执行；actual known但晚 inherited getter/函数/flags/path污染显式拒绝，恢复
不能被重新当成原基准。检查原 inherited path时允许 root后来已有合法 own getState
插装，但该own值不被这份origin认证，也不因此宽跳 inherited owner/path。完整Agent
原结构与 fixed original getter证明实际graph，不读取当前 `agent.graph` 公共getter。

每份view为模块自产own-data frozen数据；其late inherited污染、privateparent关系或
任一flags不符使本origin.privatefailed永久true。同reader/view恢复属性后仍拒，不能
再capture当前值。这个失败只阻断新origin资格，不把旧invoke或Main既有guard变成新
Source语义。父链来自register原parent Origin私指针，reader完整检查同module基准和
各parent/child inherited关系；不知道真实parent或原parent已失败均不能新grant。

Main与旧Shared现有执行/derive不自动增加新的 getState immutable gate。该reader只
证明原来源。future真正Shared installer在derive构造前消费parent origin，并在child
register之后消费child origin；两个root graph应不同，而actual inherited owner/
function/path/flags同原基准。不能在子构造后读父当前prototype作为首基准。首窗测试
验证这份真实parent/child origin数据及晚污染拒绝，不把它作为stream/privateinitialize
已经认证的证明。

回归使用actual known Factory +真正derived Agent：same original function/receiver与
complete flags/path、unknown/clone/Proxy zero trap、method own accessor零读取、晚
prototype getter/replacement/flags拒绝、恢复之后原base真实invoke/CP仍完整。另保
Main现Lifetime/Host插装行为与原Factory27，不更改schema/default/callback merge。

另有必须的实际constructor边界：true withConfig未知callback临时替换 inherited
getState、constructor完成后恢复原值，child的新originreader仍拒（其首capture对不上
module/parent基准），旧base随后实际invoke/完整CP保。不能只测试读时持续污染。

### 受控 SDK shell 的可行性研究（未批准，未实施）

若继续依赖原 ReactAgent.stream 的私 #initializeMiddlewareStates，外部wrapper没有
当前已知真实接点能在未知stateSchema/default之前pin它的actual mergedConfig，同时
防先getState再stream组合抢先。私方法不能通过正规SDK导出调用；这是一项当前私接口
来源限制，不是Shared流式或取消行为不可实现。不能靠ALS、first或signal地址补证明。

可审的替代路径是repo内版本锁的真实SDK语义适配器：保原effective defaults/merge一次，
在自持shell内部先产生actual config并private pin，await全部真正middleware schema/
default，再执行固定Scope preflight及固定compiled stream。这个顺序里preflight与
stream由同一自持函数内部调用，未知schema不能调用 exported finish/claim来跃迁。
原初始化数据规则、getState普通catch与authority失败区别、original错误、callbacks/
tags/metadata/context/unknownconfig、Command/null及truefinally都须与未wrappedSDK
实际对照；不能删schema、临时改options.middleware或手改node_modules。

已核当前 `langchain@1.2.37` 的 `dist/agents/nodes/utils.js` 内部导出
initializeMiddlewareStates，但package exports无此subpath。它约30行的actual
StateSchema/ReducedValue、interop optional/privatefields、safeParseAsync及默认错误
规则可以版本锁到repo自己的adapter；正规public依赖来自LangGraph与core utils。
不把未导出的节点helper路径当成可稳定runtime import，实际Electron/Worker bundle
仍必须验。

另一个必须先解决的实证问题是full defaults：现Factory只tracking configurable/
streamMode/subgraphs/encoding四字段，真正ReactAgent #defaultConfig还有callbacks/
tags/metadata/timeout及unknownkeys。拿四字段重建shell会遗漏配置；再独立merge全量
caller config会让CallbackManager.copy重复或改变错误/顺序，不能接受。需要实际单次
full-default来源，或维护明确的SDK真实dispatch seam；这项尚在研究，不授权生产。

已读原同步 `ReactAgent.streamEvents` 的探针候选：它确实只做一次 full defaults 合并后
调用 graph.streamEvents，无初始化 await，可在真正图执行前截住。但 config 未定义时
它无条件把 `version` 设为 v2，原 private defaults 中这个 unknown key 会被覆写。
因此简单删除新增 version 是有损快照，不能用于普通 stream 的完整配置来源。
另外每个 synthetic probe 增加一次 merge；现有 tags 的 concat/iterator、自定义数组
以及已合并 callbacks 的对象都须核实际可见副作用，不因未启动模型就称完全透明。
当前只记录此只读候选，没有探针或 SDK shell 产源。

### 受控 semantic defaults 路线（研究修订，未批准）

后继不再要求取出或复制 SDK 私 `#defaultConfig` 的地址。改为在真正 known Factory
birth 时记录一份语义配置来源，在 Shared 自持 shell 中保留用户可观察的值、合并和
回调行为。它仍不能从旧四字段 projection 反推 full defaults，不能把当前公共 graph
或一次 streamEvents 探针结果当成原出生配置。

已核实际 `ReactAgent` constructor 的先后：先保存 `options`，以原 `mergeConfigs`
合并 constructor 第二参数与 `metadata.ls_integration`；若 `options.name` truthy，
再以原 `mergeConfigs` 合并 `metadata.lc_agent_name`，之后才进入 model 校验、middleware
和图构造。这两个 metadata 步骤的来源可在真实 Factory 调用 `createAgent` 之前固定。
新 stream birth 资格仅接受非 Proxy options 的 own-data name 或经过原 prototype path
确认的 absence；不得执行 caller name getter。首 callback 前固定 value/flags/path，
construct 后重新核。name 未知、getter、构造 callback 修改后恢复无法证明者只令该新
stream birth record sticky failed；旧 Main/invoke/derive 的原 guards 与行为不改。

初始 semantic config 是原 constructor 的 integration metadata 与固定 truthy name。
这里的 metadata 对象不是 SDK 私对象，不声称同地址。实际 stream 采用其普通值做唯一
effective merge，随后先在自持 shell 完成 schema/default await、再由原 Scope 固定执行
器 preflight、最后原 compiled stream；未知 schema 无法拿到可消费的 finish/ready
nonce。原 callback/tag/config/context 的公开观测仍须与未 wrapped SDK 一致。

对于新 Shared 专用的受控派生，候选是保存实际 SDK constructor 的固定函数来源，先
对 semantic parent defaults 与 caller config 调用一次原 `mergeConfigs`，将这个确切
结果作为第二参数交给真正 constructor。constructor 自己的 metadata 合并照原发生；
之后只按已核语义折叠 metadata/tags/configurable/timeout，并保 callbacks 对象与全部
unknown keys 的原值，不再调用一次 mergeConfigs 来追踪 defaults。否则 CallbackManager
copy/addHandler 可能重复。这是单独的 Shared 专用派生执行路径；不能调用原 withConfig
后再补一次追踪 merge，也不能把旧 opaque child 自动升级为 semantic child。

这条候选尚有精确 constructor 来源前提：`langchain@1.2.37` public runtime 仅导出
createAgent，ReactAgent 在公共声明中是类型，实际 class 位于未导出的内部模块。当前
Factory 在 createAgent 完成后才读取 actual Agent prototype；未知 options/model/MW
callback 可在 constructor 结束前替换该 prototype 的 constructor 字段。故那时首次
看到的 own-data function 不能单独当成 SDK 原 constructor。需要合法 bundle 布局的
版本锁 SDK adapter 或一个没有未知 callback 的真正模块原基准建立步骤，明确完整原
descriptor/receiver/source。不能用 name、toString、function.prototype 形状反证。
未闭合此前提，不实施这个 constructor counterpart，也不注册 caller constructor。

一个更窄的模块基准候选现已只读核源：在任何用户 options 进入 Factory 之前，仅调用
原 public createAgent 构造一次自产常量 options 的内存图，model 为普通字符串，tools
为空，无 middleware/name/checkpointer/callback。实际 constructor 在字符串分支跳过
模型对象校验，AgentNode constructor 只保存 model；initChatModel 位于后续执行，故
此构造本身无需 provider、HTTP 或 getTuple。它的真实 Agent prototype 可提供原 class
constructor 与方法的固定 data descriptor 基准，图随后不用，也不注册 native Scope、
Host、Source、Producer 或执行记录。新 semantic 能力才使用这个基准；旧 Main/invoke
不自动加新门。该候选仍待两位独立设计审与实际 startup/Worker/bundle、零模型/存档
读取回归，不是本稿授权的 bootstrap 生产操作。

semantic fold 同样尚需明确有限支持规则：metadata/configurable 为普通 own-data 容器、
tags 为 dense 普通字符串数组时可只复制原合并值；unknown key 不被删掉或授权限。
CallbackManager 可以保原实例作为普通 SDK callback 配置，但不得被调用来生成消息
来源。unknown getter/Proxy 或对 constructor 合并有可见副作用的 exotic 容器不能静默
改成普通对象。若当前原 native 配置合同本来拒绝它，继续明确拒；若原合同允许，则
须先真实 baseline 对照决定同等行为，而不是在新 shell 丢弃配置。

在获得下一整体两票之前，以下是真实原 SDK 对照的必需门：初始/自定义 name、两代
callback 数组与实际 CallbackManager copy/addHandler 次数和异常、tags 去重及顺序、
metadata/configurable 原键覆盖、context、timeout minimum、未知 version/key 完整保留，
以及 schema async default/getState error/Command/null 的真正数据和错误时序。还要验证
配置 callback 先抢 graph.getState/stream 无 ready/输出、并行同图两 Scope 隔离、初始化
取消及 held finally 的真实 resource drain。runtime/Host/Attempt/Entry/23/ledger 全部
原来源门独立保持，semantic defaults 只给配置值来源，不给 frame 或消息权限。

### SDK 词法接点与 semantic adapter 的可再现比较（只读候选）

当前实际顶层包是 `langchain@1.2.37`，`deepagents` 另有嵌套 `langchain@1.2.36`。
顶层锁项目前没有 resolved/integrity，不能拿 `^1.2.28` 或安装时首次看见的文件当原基准。
顶层已读 pristine 文件 SHA256 为：

- `dist/agents/ReactAgent.js`：d60c4c3634016c3d0ce8d0fbd053c1c4a981493041d1cab499a288b2d6f7dcfc。
- `dist/agents/ReactAgent.cjs`：8ea735e2f6ff797d884a041e299548d6d0d82424fde516688b40cf6513a837cc。
- `package.json`：55718baae214b1957f27f57ba16bb49e99fb94df99e13c2335f3f469cc7b34c6。

原 public exports 没有 ReactAgent 或 initializeMiddlewareStates 的内部 subpath。
MIT LICENSE 允许维护和分发修改版，修改包和随包材料须保留原版权与许可文本。
此处仅记录实际包的许可和安装布局，不把未导出路径变成运行时 API。

可再现 SDK patch 的候选布局为 repo 内精确版本 patch/manifest、校验脚本和显式私接点
export。脚本只接受编译期列出的 pristine 或已完整 patched 哈希，未知/半 patch 拒绝；
核完所有文件后再原子替换，不从当前 node_modules 重新生成基线。npm postinstall 保留
现有 `electron-rebuild -f -w node-pty`，另显式执行该校验/安装步骤；prebuild 再核版本及
全部 postimage。不能手改 node_modules。ESM/CJS 两个实际 ReactAgent、相应 declarations
及 export entries 必须同批维护；嵌套 1.2.36 不自动升级或接受顶层私 token。

更长期可采用源 fork/本地完整版本包，仍固定 upstream revision、构建工具与生成产物
manifest，不在本项目手写 dist。无论 patch 或 fork，实际 Electron main 与 Worker 的
require/import 必须指向同一副本的 ReactAgent 与私 reader；跨 ESM/CJS/嵌套包地址 miss
应拒，不能回退用 class/name/全局 Symbol 判断真假。当前 externalizeDeps 与包装产物
须 Root 实际验证，不能只凭源码 import 推断单份模块已成立。

SDK 最小语义接点在原 `#initializeMiddlewareStates` 的未知 default/schema await 之后、
原 `#graph.getState(mergedConfig)` 之前。词法自产 opaque capsule 固定 actual Agent、graph、
此次 mergedConfig、state 与该次 operation；保原 getState 及其原 ordinary error catch、
defaults 填充、原 callback/tag merge。authority/取消/来源失败不能当普通 getState 失败
被吞后发布；App 私 Source 失败须令原 dispatch 前门拒绝，且真 finally/drain 全部观察。
这个 capsule 不把私 #defaultConfig 拷出，不重新 merge，不给消息/ready/读取权限。

但仅在这一晚点 mint 真 capsule 仍不完整：schema callback 可以先调用同 actual Agent
的另一次原 stream，获得另一个真实 SDK capsule。App 不能按 first/same Agent/config/S
或 ALS 选它为外层 pending。故本候选必须另有 **首 merge/未知 callback 前的真 operation
入口**，以及原 graph dispatch 紧邻调用处的私 stage；这两处是补 whole BLOCK 的必要
条件，不是已批准实现。

一个可审布局是 SDK 模块自产 `createNativeStreamOperation(actualAgent,input,config)`
opaque handle，App 在自己的真实 pending/Scope 双私表中固定该 handle 后再调用 SDK
固定 executor。handle 只从该模块实际构造记录产生，公开 reader/observer 不能 register
任意 callback 或成功值。executor 同步进入固定原 ReactAgent.stream，其首词法语句消费
同 agent 的私 request，发生在 merge 前、无 unknown callback/await 间隔；之后只把
operation 放在私 local 参数中传入 initialize helper，不经 config/tags/metadata 运输。
普通原 stream 不消费 native request，保持旧行为。重复执行/原方法重入 caught 后不得
复活本 handle；另一个真实 nested operation 也不能命中 App 原 pending。

最后原 compiled graph 调用前，SDK 自造的 `dispatching` 窗只包同 operation 的实际调用。
公开 tap 只看到只读观测；tap 执行时是 notifying 状态，不能消费 dispatch receipt。
App 原 observer 从 SDK 私 reader 与自身 pending/factory/Scope 双表精确 join，读取 actual
merged config 地址后才执行原 full checks。getState 与 stream 两个阶段分别一次消费，
不把 getState receipt 当 stream dispatch 凭证。SDK stage 只证实际原 callee，不单独授
Producer；真正 Host/Tools/full/policy 完成后的 ready 激活仍是另一条原 admission 链。
此接口布局还须独立两设计与源审，当前没有 patch/fork/新 exports 或运行资格产源。

| 候选 | 保留原行为的方式 | 必须承担的实际门 |
| --- | --- | --- |
| SDK 词法 patch/fork | 原 private defaults、initialize helper、merge/方法次数及实际配置地址继续由原 SDK 产生 | 安装哈希/双发行格式/模块副本、前述 operation 和 dispatch 私关系、原版本升级维护 |
| semantic adapter | 自持等值配置与完整初始化 shell，原 constructor/merge 的有限语义显式复用 | callbacks copy/error 次序、全部 unknown defaults/name/metadata/context/timeout、初始化读和取消时序逐项 SDK 对照 |

研究优先推荐词法 SDK 路线，因为它不需要在宿主重建完整 defaults 或 initialization。
维护成本真实存在，但没有把私接口不可达当成用户流式能力不可实现。两路线都必须有
完整 golden：原方法一次、actual CallbackManager copy/addHandler/error 次序、两代 tags/
metadata/configurable/context/timeout/unknown version、schema async default/getState error、
Command/null；同图并发两 Scope、初始化偷 getState/stream 与 nested 真 agent 不能抢
operation、初始化取消与 held finally 全 drain；真实 Worker/build/Electron 原用法验证。
没有这些门，不解除 Shared stream ready/values/messages/SSE 的整体 BLOCK。

### 版本锁 SDK operation 接点（基础窗已两审、安装及实际通过）

本节把词法路线写成具体施工窗口，已取得 Root DESIGN1 与 Latest 独立 DESIGN2。
它替代以首 getState、ALS、相同 signal 或语义 defaults 副本辨认原 SDK 初始化的办法。
现有七十项基础实际门与 Shared invoke 的原提交门继续有效。首基础只新增 repo patch、
安装器和真实 SDK golden，现已完成安装与基础实际门，不开放 App Shared stream/Source/ready。

本基础源码冻结清单为七目标 patch、manifest、两个可读 lexical/declaration 模板、
installer `.mjs/.d.mts`、package/lock 精确 pin，以及
`langchain-native-stream-origin-installation.test.ts` 四个安装/回滚定义和
`langchain-native-stream-origin.test.ts` 十个真实 SDK 定义。Root 已执行安装、`--check` 与
14 定义实际门；第一次 13 PASS/1 fixture RED 与随后修订后的 14 PASS 均保留记录。
Root 已从实际 npm tarball 核对 SRI、SHA1、三个 pristine SHA 和 LICENSE SHA 全匹配，
证据为 `output/langchain-1.2.37-official-verification/official-verification.json`。
七目标 patch SHA 为
`0155242ca1c6b44e793f19c86f1e71cb56c43156ccda05dcac733e1a481378f7`。
原 SDK sourcemap 文件保留原发行内容；新增 lexical 行会改变 patched stack 的行号，
本窗不声称调试映射位置透明，原异常对象/catch 控制流与普通行为由 golden 验证。

官方三个原文件均没有末尾 LF。独立 Source 审发现第一 patch 的 sourceMap 尾和下个
header 连行、installer/reverse fixture 强制末尾 LF，因此第一冻结票撤回且未运行安装。
修订只使用标准 `\ No newline at end of file`：严格核前一个 hunk 行的 old/new/context
side，在未触及原 EOF 的 hunk 后继承原真实尾字节；文件 header 独立行。三项 before
SHA 与七项 after SHA 不变，反向夹具恢复相同 no-LF 原 bytes 并显式断言三条末字节。
此 EOF 增量已经 Root DESIGN1 / Latest DESIGN2；修后 actual 安装及十四项门尚待 Root。

修后 Root 实际安装和 `--check` 均成功、七 postimage SHA 严格匹配；首次十四门为
十三通过、一条 ordinary golden 夹具失败，记录
`output/stage24-sdk-lexical-foundation-current.log`。实际 schema default callback 为七次，
它包含原 Zod metadata 的 `parse(undefined)` 与 constructor/withConfig 构图探测，
不是一次私有初始化方法的调用计数。两审 test-only 修订保留五阶段累计 default facts，
两 reference 总数各严格七，全部阶段纳普通/native 整 reference strict equality；
实际 getState 与 compiled stream 各严格一次，原配置/shell、callbacks copy、每帧与
完整 checkpoint/message `toDict` 不过滤 ID、不改正文。runtime/installer/七 postimage
在这次夹具修订中完全不变；修后十四门待 Root。

Node62 的两个 observer 泛型赋值错误与 `consume` 联合类型也在同一 test-only 窗口
校准：观察函数通过 descriptor 安装，与先前赋值生成的 own data 三旗标相同，
参数仍原真实方法 `Parameters`、原 `Reflect.apply` 精确一次且同 Promise；统一消费
`AsyncIterable<unknown>` 后继续逐帧完整 native values 校验与 codec。没有 `any`、
忽略类型或从静态 cast 造 Source；patch/API/hash 不变。两票已过，Root 类型及实际待跑。

实际顶层 `ReactAgent.stream` 原入口只有三条语句：原 `mergeConfigs`、await 原私初始化、
原 compiled graph.stream。原私初始化在真正 middleware/schema defaults 的 await 后，
调用 `#graph.getState(config)`，对原普通读取错误使用既有 `{values:{}}` catch，然后填入
原 defaultStates。Command/null 或无 middleware 时直接返回原 state，不调用 getState。
新接点保留这些原语句、原次数、配置地址和控制分支，不从宿主重建 defaults。

#### 可再现依赖文件与安装

第一窗口新增 repo 内 `patches/langchain-1.2.37-native-stream-origin.patch`、
`patches/langchain-1.2.37-native-stream-origin.manifest.json`、
`scripts/apply-langchain-native-stream-origin.mjs` 与安装校验测试。manifest 的输入基准是
上一节已列实际 pristine SHA；获得实际 registry tarball/SRI 后还须锁定这份 upstream
归档，不能用一次当前安装反推缺失的 npm integrity。精确顶层版本从 `^` 改为该锁项；
嵌套 deepagents 的 1.2.36 不 patch、不自动授同模块 operation 能力。

patch 包含 ESM/CJS 的 `dist/agents/ReactAgent`、一个 Node 专用
`dist/native-stream-origin.js/.cjs` 与对应 `.d.ts/.d.cts`，package exports 新增
`langchain/native-stream-origin` 的 import/require 两路径。它不从 browser 条件导出，
也不通过当前未导出的 internal subpath 绕开 package exports。新增模块与实际
ReactAgent 必须引用同一套内部私记录；跨 ESM/CJS 副本、嵌套版本、另一个安装位置
均 exact miss。保留 MIT LICENSE 与版权文本，不把依赖产物手工复制进本项目 out。

安装脚本先读取全部指定文件并核版本、preimage/postimage SHA。只有完整 pristine 或
完整 patched 状态可继续；未知、半 patch、混合版本拒绝。所有输出预先生成并核
postimage，再以校验后的路径同批替换；出现失败保留可恢复原文件并报告，下一次
不能把部分 postimage 当新 baseline。现 `postinstall` 的
`electron-rebuild -f -w node-pty` 保留，新脚本显式串接；prebuild 也先核完整 postimage，
再执行已有 Windows background controller 构建。原 dev/Worker/build/package 都须
使用同一已校验顶层安装，不以正常 TypeScript 编译代替真实 import/require/bundle 门。

#### SDK 自产记录与准确接口

SDK module 在真实 ReactAgent constructor 成功后，只保存 actual agent、其私 #graph
和模块原 stream function 的私记录。record 不接受 caller baseline，不靠 constructor
名字、class 形状、函数 toString 或全局 Symbol 认证。它只是 SDK 实例与原执行来源，
没有 App Scope、权限、Host、checkpoint target 或消息资格。只有本模块实际原
ReactAgent 构造对象可命中；public observer 不能登记任意对象、函数或成功值。

原 stream 地址在模块 class 定义完成后、任何 constructor 或未知 callback 执行前，
由模块词法 const 固定。constructor 成功登记只引用该原地址；不能把 constructor 末
当前 prototype.stream 重新当作 original 基准。

```ts
// 新 Node-only SDK subpath；具体泛型沿原 stream 参数与返回类型，禁止 any 掩盖接口。
createNativeStreamOperation(agent, state, config): NativeStreamOperation
executeNativeStreamOperation(operation): Promise<OriginalAgentStream>
readNativeStreamBoundary(graph, config, kind): NativeStreamBoundary | undefined
// kind 只为 "preflight" | "dispatch"；readonly view 包含：
// operation / agent / graph / actualConfig / actualState / assertDataCurrent()
```

`create` 产生 SDK 私 WeakMap 的 opaque handle，固定真实 agent/graph、原输入与调用 config
地址、原 stream 地址；它不 merge、不读 getter、不初始化、不执行图。调用方可申请
自己的 handle，但 App 只消费自己原 pending/Scope 双私表中已有的 exact handle。
一个真实但无 App pending 的 handle 不授任何 producer/read/ready 权。

`execute` 首句以私 latch 将 handle 从 new 改为 executing，重复、重入或已失败均拒。
它在没有 unknown callback/await 的同步段内，以固定原 fn/this/输入/config 调用实际
ReactAgent.stream。SDK 原 stream 的第一词法语句消费同一 request，早于 merge/default
或 schema callback；request 随即移除，operation 只留在该次函数的私 local 中。
所有后续普通 SDK stream 调用保持旧入口；未知初始化 callback 另起一次真实 Agent
stream 不会接走这个 local，另一个 create/execute handle 也不匹配 App 原 pending。

同步传递只通过本 SDK 模块的私 execution WeakMap：key 为 actual agent，value 为
该次私 operation record、module fixed original stream fn 与 new→executing 状态。
executor 先核实例私表的 actual agent/graph/fn，保存此 record 后立即 captured
Reflect.apply 原 fn。原 stream 第一语句消费同 key 的 exact record，并再次核实例表、
actual this/graph、same state/config 地址、executing 状态及固定 fn；先删 request 再
运行原 merge。执行器在原调用同步返回后还核 request 确已消费，异常 finally 清掉
仅该 exact request。没有 caller 可写字段、公开 setter 或 config token；普通 stream
找不到私 request 就走旧逻辑。重复执行使该 handle sticky failed，不能 catch 后重用。

首 SDK 基础窗 state 流程只到 new → executing → initializing → preflight →
preflight-settled → dispatch → dispatched。Command/null/无 middleware 的既有 early return 分支标记为
initialization-skipped，直接进入 dispatch；它不能伪造 getState receipt。每个 stage 的
原结果只由同一次词法执行推进，读者不能 set phase、finish 或自行补一个成功值。
任何捕获到的 native 来源失败、重复消费或 caught reentry 都使该 operation 永久 failed。

`execute` Promise 成功只表示原 Agent.stream 返回了同一真实 iterable shell，绝不表示
iterator、Pregel runLoop、checkpointer 或资源已经终态。基础接口没有 terminal/drain
receipt，也不观察、预消费或包装该 iterable；成功 handle 已用且不能再 execute。
后继 App demand 执行器必须真正消费/取消原 iterator，并观察原 node/child/Host/Scope
finally/drain 后才管理终态。基础 golden 自己保留并完整消费真实 iterable，先等真实
run 和已启动子任务 finally 再关闭 Saver；不能以 SDK execute settle 代替这一步。

preflight boundary 在原 schema/default await 完成后、紧邻原 #graph.getState 调用的
同步闭包内安装，绑定此 local operation 和 actual mergedConfig；dispatch boundary
在私初始化真正返回后、紧邻原 #graph.stream 调用的同步闭包内安装。两者是独立一次
stage，不能以 preflight receipt 代 dispatch。没有 nonce/private 字段进入 config、tags、
metadata、context、callbackManager 或 SDK merge/ensureConfig；原 configs.filter、
Object.entries 与 super.stream 因而无法通过新公共 config 窃得 operation 凭证。

首基础窗采用模块私有同步 lexical boundary stack，不将 Node ALS 导入原 browser
依赖。只有原 getState/graph.stream 的真实同步 callee 入口周围 push；原 fn/this/args
仍执行一次，返回原 Promise/iterator shell 后立即 finally pop，异常也必须 pop。
reader 成功仍要求 SDK operation WM、相同 agent/graph/config 和当前词法 stage 全等。
adapter 必须在自身首同步入口读取 view，并在任何 full callback 前占 App once claim；
await 后只读已保存 view 与 App pending 双私事实，不能重查 stack 作为异步权限。
并发 operation 各自在 await 后的真实同步 callee 入口独立 push/pop；未知 nested 同图/
同 config 调用不能偷已占 once，另一个真实 handle 不能替代原 pending。
reader 是 descriptor/data-only，不调用 Source。全部私集合与 stage lookup 固定模块
intrinsics。没有 config 私字段或公共 tap 注册边界。最小首窗不引入新的公开 tap；
操作异常、caught reentry 与所有真实 schema nested/concurrent 路径须有 golden。

#### 宿主 counterpart：exact pending 与两阶段 claim

新增 `src/main/agent/function-conversation-shared-native-stream.ts` 持有唯一 pending 表。
当前 Shared wrapper 首 native input 原始快照、四字段配置与 Scope 来源门继续先执行；
随后只由本模块原工厂入口产生 pending，固定实际 Shared factory/agent/graph/Scope、
opening reader、Lifetime installation 与 SDK handle。它先登记全部私 record，再启动
单一 Scope.run 后台执行器，后台调用 SDK 固定 execute。没有 caller register、传入
stage 函数或 public mode bool；pure Domain routing 只读这个本模块自产 capsule。

Factory 发布前的 getState adapter 只能由现 known factory 安装点自产。adapter 保存
getState Origin 的原 inherited fn/receiver/path/flags，并与本 factory 私安装 record
及 SDK actual graph 地址双 join；不把当前 graph.getState value 作为首基准。
实际 adapter 被调用时，先读 SDK preflight boundary，再以 exact handle/graph/config
查 App pending，claim latch 在任何 full guard/original getState 前占用。

claim 成功后使用 Scope 新 opening full/data reader，再调用固定原
`Scope.preflight(config, originalGetState)`。settled receipt 只由本执行器在原 Promise
真实 settled、全部原 scope/authority 检查后自产，固定 pending/Scope/config/outcome。
未知初始化 callback 提前直接 getState、先 getState 后 stream、重入同图、用相同 signal
或 config clone，都没有同词法 boundary；不得得到 receipt，且本 scope 的 native
pending 被 sticky 标失败。Unknown/foreign 图不污染其它真实 pending。

SDK 保留原 getState 普通 `.catch` 行为，但 App preflight/authority 来源失败不能因
这个 catch 升级为成功：执行器在 catch 前记私 failed，SDK dispatch 前与宿主 observed
stream 两边再核。原普通 getState exception 的 fallback 与 native preflight 拒绝须
以真实 unwrapped golden 区分，不按 Error.message/public code 字符串判断来源。
若现 Scope 无法提供完整普通 fallback 的 settled 事实，该特例保持 explicit reject，
不得暂时补 receipt 以让测试通过；这项需首执行窗真实验证后才定兼容范围。

observed stream 在 SDK dispatch boundary 首入口 claim 第二阶段，核同 pending、实际
mergedConfig 地址、第一阶段 receipt 或真正 initialization-skipped 分支；Scope opening
full/data 与 fixed config facts仍完整。第一原 iterator.next 前仅 opening guard，不给
completion/writer/partial/diagnostic 权。Scope actual getTuple 的原 admission 成功后，
只有 completeActive 的原 Producer/Registration/Host/Tools/policy 最后 full 完成点，
才能以 App pending + Scope + factory + Domain 两个模块私表 join 自产 ready。
ready 一次，错误/重复/错阶段 sticky；最后 Tools/full callback之后还有完整纯 data 尾。

first frame 返回前须 ready，并依新 Return 输入/历史/ownEntry 源分类、完整 typed 副本、
原 batch23/ledger A-B 与末纯尾发布。values/updates 首窗不借 SSE currentSource；messages
需随后真正 plain NativeSource/Attempt/chunk/writer 接点，SSE 则另走原 actual SSE Source。
单一后台 run 按原读取 demand 逐次 next，取消/return/throw 先 abort 再观察原 iterator、
所有 node/child/Host/Scope 真 finally/drain，不以 caller Promise 早拒当资源终态。

#### 实施顺序与必须实际证明的反例

1. 仅 dependency patch/manifest/installer + SDK operation 真实例 unit/golden。未接 App
   stream，不开放 producer。证明 unknown/clone/foreign/module副本 miss；普通 stream
   同原 merge/initialize/getState/compiled stream 次数、完整 config/回调观测；未知
   schema 在首/后 await 嵌套真实 Agent.stream 或另 execute 都不能偷 outer handle。
2. 新宿主 pending 模块 + Factory known getState adapter + Scope settled receipt。
   真实 Manager/Saver 两个并行 Scope 验 actual config、Command/null skip、getState普通
   fallback与authority失败、重复/提前 getState→stream/caught reentry 0provider/0frame。
   此窗仍未放出 frame，先接原 true admission/ready 最后 Host/Tools 双 private join。
3. ready + values/updates demand/drain 和 Return 全源门。再分别接 plain messages、
   Command/null 恢复与 SSE；每窗补原 HTTP/Tool/Hook/fullnative/23/ledger/CP/UI 实际门。

每个原函数必须 exact once；CallbackManager copy/addHandler 的次数、错误和键顺序用
未 wrapped SDK 真实对照，两代 defaults/unknown version 与 context完整保。初始化及
held finally 取消的 reason/时机保现 native 合同；不要求公共 signal 身份透明，也不把
其等价状态当来源。所有原 Shared29、Factory27、Observer10、Lifetime21、Main31 门
按当时实际定义重跑；旧 performance RED 不因本基础窗 green 被抹去。最终还须 Root
独占真实 Worker/Electron/build/package 与用户原调用方式验收。

### SDK 基础之后的 App 接线窗口（Root 限定设计通过，待独立第二审）

本节使用已经安装的 `langchain/native-stream-origin` 接口，不再运输 config nonce，
也不重建 SDK defaults。第一实际门安装器与 `--check` 已成功，七个 postimage hash
不变；14 个基础定义首门为 13 PASS/1 fixture RED。唯一 RED 是原 schema default
callback 累计七次，随后已按真实五个阶段完整记录；测试类型修订与计数修订已两审，
Root 的随后实际 14 定义全部通过。原失败日志不删除；唯一 empty catch lint 已补意图
注释，无语义或 patch 变化。以下新增 App 接线尚未实现，不用基础门代替其许可。

#### 私安装和本次操作的两个来源

`mods-conversation-shared-invocation.ts` 仍是唯一原 Shared 工厂安装者。它的 native
分支在原 Node/Tools 安装之后，读取真正 Factory getState origin，生成一个 getState
adapter；再安装 Lifetime observer、经两模块原 once seal 锁定 observer，最后锁定
同 getState adapter 并 publish。新的 installer 私 record 保存 actual agent、factory
record/token、compiled graph、原 capture 函数、getState origin/delegate/receiver、
adapter 的完整 own flags 和 Lifetime installation。不存在 public registerAdapter 或
注册 callback 的入口。只有这个实际分支生成 installer token；generic adapter 原样。

新 `function-conversation-shared-native-stream.ts` 只负责受控入口、preflight claim、
单一后台过程和最后真实清理。其不可伪造的 installer 与 pending 数据放到一个不含
Desktop value import 的 `function-conversation-shared-native-stream-state.ts`，这样
Lifetime 与 pure Domain 只能导入该模块的 readonly 消费器。该模块的 producer 是
上述真实工厂安装函数调用的固定工厂函数：先查既有 genuine Factory/agent/graph 与
observer/getState 两安装私表关系，再自造 installer 及固定的受控 stream 函数；
参数中没有 full/data/stage/ready 回调。它不能接受传入的 stage record 或任意 Scope
reader作为来源。执行桥只选择其自身 installer record 的原方法与 Scope 私 executor。
模块的 readonly 消费器不创建或补登记 installer、pending、receipt、activation。

受控入口在首原 capture/full callback 前保存输入原始 snapshot 与 config own-data
结构，随后执行原 factory/capture 来源门。选择 actual Scope 后，直接读取其 genuine
opening record；失败不可改走 generic，也不能事后重采输入基线。固定取消输入是原
Scope host/controller 约束和本 call 的标准 signal，顺序沿原 native 合同；Shared
default signal 此窗仍明确拒绝。实际配置仅在原 parent/configurable 结构上加入本
Scope.checkpointer 和本 call 取消组合；callbacks/tags/metadata/defaults仍仅 SDK 原
merge 一次。SDK 的 private mergedConfig 只在后述真词法入口取得，不以外层 config
或相同 signal代替它。

随后 SDK `createNativeStreamOperation(actualAgent, admittedInput, fixedConfig)` 产生
本次 opaque handle。pending 在任何 SDK execute/未知 schema callback 前建成，固定
installer、factory、agent、graph、Scope/opening record、首输入、fixed config、原
signal、SDK handle。`runSharedNativeFactoryDomain` 原 created Domain 同步建立一次
association 后才进入唯一 `Scope.run`。pure Domain 只持 routing token 与原 factory/
Scope/operation 地址，不接受传入 view/authority/runtime，也不因该 token允许输出。
另一个真实 SDK handle仍不命中本 pending；ALS仅选既有 Domain，不能创设关系。

```ts
// 以下是固定模块消费者，均不收 caller guard 或 callback。
readSharedNativeStreamInstaller(token, agent, graph)
readSharedNativeStreamPending(operation, installer, scope, domain)
claimSharedNativeStreamPreflight(installer, graph, actualConfig)
claimSharedNativeStreamDispatch(installer, graph, actualState, actualConfig)
readSharedNativeStreamStage(source, graph, point)
```

`claim` 的第一条操作是同步读取 SDK boundary。仅 exact boundary.operation 对应本
pending，且 agent/graph/config/kind 都相同，才把私 reading/claim 状态占据在首 full
之前。unknown/foreign installer零 Source、零 poisoning；同真实 pending 的重复、
错阶段、caught reentry、输入或 config 换代使该 pending永久失败。没有 boundary 的
直接 getState/stream 不获得 receipt；若发生在本 installed graph 的实际 opening
operation 内，毒化这个本次操作，而不是全图或其它正常并行操作。

#### getState 原执行图与 settle receipt

Scope 新接口只在自身构造私 WM 存执行器与 record。class evaluation 固定原
preflight、entered、validatePreflight、preflightTuple、tracked 和 guard 的执行图，
原 receiver、参数、context/preflights/invocation/pending 集合与调用顺序保持。
原公共方法与普通 invoke 不改用这个来源接口。getState adapter保存的 delegate 是
原 Factory inherited function，经固定 Reflect.apply(original, actualGraph, [config])
调用；不读晚 current getState/getState.bind，不接受外部替代 read 获得 App receipt。

```ts
runFunctionConversationSharedCheckpointPreflight(scope, operation, actualConfig, originalRead)
  -> Promise<Readonly<{ value: unknown; receipt: SharedCheckpointPreflightReceipt }>>
readFunctionConversationSharedCheckpointPreflightReceipt(receipt, scope, operation, actualConfig)
  -> Readonly<{ assertDataCurrent(): void }>
```

`originalRead` 仅由该已认证 adapter 的私 record自造，用来保持原 Scope.preflight
执行参数；它本身不是许可。Scope 从首 full 前占据私 reading，执行原 preflight，
直到真实 Promise 成功 settle并完成原 Scope checks后才 mint empty frozen receipt。
receipt私 facts pin 同 Scope/invocation、operation/config、原 read 地址与真实 result，
并保存成功状态；App消费器还须比较原 installer 的 read 地址，不接外部receipt。
copy/Proxy/foreign/失败或重复执行零授权，caught reentry使原执行失败sticky。

SDK原 getState catch 保留。普通 delegate失败的原 fallback不得误说成功 preflight；
App receipt必须记录真实 successful Scope settlement。adapter的来源/authority异常先
在 App私表标 failed，再 throw；即使 SDK catch它，随后 dispatch也在 original graph
stream开始前拒绝。scope/source失败不按公开 error.code/message判断或转换为普通
fallback。Command/null或无 middleware的真实 initializationSkipped 只能由 SDK
dispatch boundary固定事实选择；不以没有receipt猜测分支。本窗可以先保明确拒绝，
但下一实际原入口窗必须继续完成 Command/null，而不是把缺少receipt视为成功。

Scope 对原 delegate 的普通异常可以提供独立的 settled-failure facts，保存真正
reason（含 undefined）与完整原执行关系；这不是 successful receipt，也不能参与
ready。首窗若不能保原 fallback就明确暂拒，下一窗续接，不称框架无法支持。

dispatch claim只消费已固定 SDK view，一次保存真实 mergedConfig 地址。preflight与
dispatch的 actualConfig应为同地址；原 initializationSkipped 用它自己的真实 branch。
SDKboundary在原 callee调用同步入口finally退栈，await后只核已保存view与私pending，
绝不重查 stack当异步权限。实际 Pregel内部还会产生 combined signal 与 ensureConfig
副本，iterator options不是这个 mergedConfig；不能按 signal状态相似、地址重新合成
或从 later frame猜出 iterator许可。原 observed stream→original Pregel→observer
iterator的同 installation/Source一次关系单独记录，迭代取消字段按实际该入口固定。

#### 接纳末尾与 ready 的唯一 publish 点

`admitFunctionConversationSharedNativeInvocation` 原全部流程保持：真实 Producer/
runtime/capturePolicy/Host/history→publish view→原 assertCurrent→attachSharedTools→
最后原 assertCurrent。只有这最后一次返回后的同步行可以完成 pending ready；早写
Domain.phase="ready" 不是 Source ready。完成者从 Domain原私 facts取 view/Producer，
不接 caller view或 guard，再查 actual installer/pending/Scope/SDK op/Source 与域
association相同。Scope binding/delegated 后段仍照原执行，首次 producer guard不得省。

```ts
completeSharedNativeStreamActivation(domainToken, operationToken)
readSharedNativeStreamActivation(activation, source, graph)
```

activation新空token只在真末接点自产。原 Producer/readPolicy/Host graph+Tools 私安装
关系以及原完整 full次数顺序不变；最后所有 full之后重核 original/view/policy/
installation/receipt 的完整纯数据关系再 publish。完成函数不按public phase或view
形状补资格，错阶段/foreign/重复/失败attachment/closing/reentry永久失败。没有 stream
pending 的旧 invoke不新增activation/Source callback。原 true Runtime/Node/Calls/
Target/Store/23/ledger来源是后继独立门，activation不是它们的替代品。

Lifetime新 `FromSharedOperation(installation, operation)` 只接受双私表已绑定的原
operation，不提供 caller assertCurrent或 stage函数参数。opening full/data来自 Scope
自产 executor/opening view；ready full/data只能从上述实际 activation原 view选择。
stream首入口、iterator首入口与首次next为明确 opening接点；任一非done frame返回、
completion/writer/partial/diagnostic皆先要求ready。drain可以结束未ready的真操作，
但不能借closing开放读取。Main已有FromInstallation与原 guard次数保持原样。

#### 原子实施顺序与独立实际门

第一 App窗仅 installer/getState adapter、SDK pending claim和 Scope receipt，不开放
公开 stream frame：真实 Manager/lease/parent task/SqlJsSaver两Scope对照，证明原
getState实际once、config pointer、scope preflightTuple不读兄弟，提前直接getState后
stream、same signal/config clone、未知 schema嵌套execute、caughtreentry均0provider/
0frame。原getState ordinary exception与native authority failure分开，真close/held
preflight finally先于资源释放。这个窗不得把 public getState origin当ready许可。

第二 App窗再接原admit末activation与一个后台Scope.run，逐demand顺序原 next/return/
throw。取消与外层return先abort本call，再await原iterator/Node/child/Host真finally，
最后Scope close/drain；若调用方离开原 withSharedAgent回调，该原owner生命周期照旧
关闭，不能为已经退休的scope重新获取权限。完整结果与每帧复用已落 Return 的首input/
真实history/Host ownEntry来源，以及完整 typed copy、整batch23/ledger A-B末pure。
values/updates不借 currentSseSource；未知新增消息/source frame拒绝而不假造普通来源。
plain messages/chunk Source、Command/null完整原路径及SSE另续窗，每窗保原五秒、
HTTP/Tool/Hook/full codec/native stamp/CP/UI与真正finally，不能因基础或values窗绿
就把未接形态写成已完成。

后台 demand waiter 必须同时观察实际 Scope/owner/call 的取消信号。原 SDK shell
返回后若父 `withSharedAgent` 回调先离开，Manager 原 finally 会 close/abort Scope；
这必须唤醒无 demand 的后台 waiter，进入原受控 return/throw/drain，最终 settle
Scope.pending，不能等待调用方继续 next或等待自己 Scope.close之后才开始清理。
只有原 Scope.whenDrained 成功、全部 Node/Host/child真实finally后才能释放资源。
失败以独立 status保存含undefined理由，原 quarantine 不改为假 closed。

逐 demand只保证本 adapter 对每次调用者请求不重复调用 next、没有额外本地预取。
它不声称 SDK的 IterableReadableStream/AsyncGeneratorWithSetup没有原预取；这些
原行为、原第一帧 setup 与真实底层runLoop仍照原执行并独立验证，不能拿公共shell
settled或 reader.cancel作为真正 generator已退出。

#### 首 Scope 执行器基础窗的源码冻结

首可独立检查的窗口只改 `conversation-shared-checkpointer.ts`，新增
`conversation-shared-checkpoint-preflight.test.ts` 的十二个定义。构造成功时保存原
context/preflights/invocation/pending/resolveDrained 与完整字段旗标；执行器在首 full
之前占 reading/used，依 class evaluation 固定的 entered/validate/tracked/tuple
执行图执行同 receiver。原公共 run/preflight、原 namespace admission 与普通 invoke
不使用新 gate。只有本私执行处于 reading 时，原 checkpointer 的 tuple 地址选这个
固定 preflight 分支，仍只返回 undefined，不选 namespace、不产生 native read。

成功收据固定 Scope/operation/config/read/result，data reader 对同地址及所有原
字段重核，foreign/clone/Proxy miss 不读 getter、不污染真实收据；Scope 退役或已知
数据失败永久拒绝。它只证明 Scope 的实际执行成功，不能单独证明 originalRead 是
Factory 原 getState，更不授 ready/Producer/消息/帧权限。后续 App consumer 必须
另外联结 SDK 词法 handle、真正 installer 的 private originalRead 地址。

十二个定义用真实父 StateGraph、同 SqlJsSaver 和真实父子 Authority；原 Scope 与新
执行图的 getState/full 次数对照、无子 namespace/admission，未知/foreign/Proxy、
undefined delegate rejection、caught reentry、五个晚 private-method getter、原
字段 getter 的纯尾 sticky、held 原 Promise 真实 finally 后排空均保留。此时只有
源码冻结与静态检查，未跑本窗口实际门；SDK 的十四项实际绿色不替代它。

### App 首窗的 run 执行图精度追加（实施前独立两审）

Scope 原 public run 的正文仍动态调用 this.guard/context.run/tracked。App 新受控入口
不能在 capture/full 后以这些晚属性作为执行基准。新增
`runFunctionConversationSharedCheckpointPreflightOperation(scope, operation, execute)`
只查 ctor 原 execution 私表；clone/Proxy/foreign 在 full 前拒，reading/runUsed 在首
full 前占据，同本次 operation 固定。这里 execute 是原 SDK executor 的本次闭包，
不是 guard、reader 或任何 Scope/Source 注册入口，不授 tuple、ready 或消息权限。

执行图在原 class static 接点固定 originalScopeGuard；纯 Scope refs/state 校核后同
actual scope 执行原一次 guard，再纯核并以原 started data descriptor 写 true，随后
原 context.run(invocation, tracked) 用 captured context intrinsic 执行。tracked 的
ticket 在同原位置进入原 pending Set，原 actual await/finally 用固定 Set add/delete
及原 resolveDrained；closed/quarantined 只 own boolean/flags读取。原 public run 和
先前 preflight execution/receipt 不改变，也不让 run 的 delegate 普通拒绝刷新成
成功 receipt。preflight 仍只自己的同序三 full；本层完整保原 run 的一 full。

同本次 operation 的迟来重入/refs失败 sticky；unknown 不毒化别的真 Scope。
execute 的拒绝含 undefined 原样传播且其真实 finally 后才退出外 ticket。首 App
基础仍只在 genuine SDK dispatch 返回前以私 identity stop，原模型/iterator/Host
都未启动；这个 stop 与未知 SDK/authority失败用私状态区分，不按 error 字符串。
Scope owner 关闭必须观察已进入 ticket 的真实 finally，不以 Promise shell代替。

这次增量只使用 ctor execution 私表的独立 `runReading`、`runUsed` 和 `runOperation`。
它们不复用 preflight 的 reading/used：实际一次 run → SDK getState → 原 preflight
必须合法进入，而迟来的第二 run/换 operation 必须 sticky 拒绝。两个执行层共享原
failed 数据状态，caught 重入后即使原 execute 成功，也不得清除失败或返回成功。

run 首 guard 前只接受 ctor 原 started own-data false、原 flags/prototype/全部固定
refs。占住 runReading/runUsed 后执行 captured originalScopeGuard 一次；再核纯
facts，才用同一原 descriptor flags 写 started=true。不能先写 true 再检查迟来字段，
不能读取 scope.guard/context/tracked 等公开或 private 晚方法。执行原 context.run
时使用 captured AsyncLocalStorage.run 与同原 context/invocation，原 pending ticket
在 execute 前加入，实际 await/finally 后固定 Set.delete、原 resolveDrained 退役。
run 的普通 delegate rejection（含 undefined）仍原值传播，不是成功 receipt；仅
guard/data/重入使私 failed sticky，不把 SDK 首窗私 stop 改成 Scope 权限失败。

该 API 自身不认证 Factory 或 Source。App 必须先把真 SDK handle、actual Scope、
input/config 与本次私 pending pin 完整，再进入此层。现首窗只验证执行/preflight
facts，不发布 ready/frame；Scope 旧二十四定义的 run/preflight/full 顺序均保持。

新 run 层计划八个真实定义（单独测试文件，不改旧二十四定义）：

1. 真父 Pregel task/Authority/Scope 原 run full 恰一次，嵌套原 getState preflight full
   恰三次，完整 receipt/address/value 与零 child namespace/admission 保持。
2. unknown/clone/Proxy Scope 在 full/delegate 前拒，Proxy trap 与实际 SQL 为零。
3. 首 guard 中 caught 同 operation 重入，使外 execute 返回成功也 sticky 拒绝。
4. 首 guard 中 caught foreign operation 重入同样不执行第二 delegate且不可恢复。
5. started getter/descriptor 在首 full 中改变，getter 零次、delegate 零次、恢复仍拒。
6. 原 guard 后尝试晚 context.run/tracked/guard getter，不执行 getter；真闭包执行一次。
7. execute 普通 undefined 拒绝精确保留，真实 finally 后 pending/drain 才结算，
   不 mint preflight 成功 receipt。
8. held execute 在 owner close/abort 后保持 pending，释放真 finally 后才 drained，
   迟来 run 不复活；真正 started=true 的旧 Scope 不获第二 run 能力。

### 首窗 originalCapture 的真实 Factory 私关系增量（实施前两审）

State 的 public prepare/finish 不能把新传入的 capture 回调登记成原 Shared 安装来源。
pure Domain 的 `createSharedNativeFactoryRecord(options, originalCapture)` 在真正
createFunctionConversationSharedAgent 的 native 构造分支保存原 capture 函数到 module
private WeakMap；不在 Factory 的可变公开字段或 options 中放授权标志。子派生只从
parent 的同一私记录继承该函数，derive 不接受另外的 capture 参数。它仍只是原构造
事实，不证明回调返回的 Scope、policy、Producer 或 Source；这些原门完整保留。

publish 沿原已审 actual agent/native derivation/graph/family 关系锁定该 record。新增
readonly `readSharedNativeFactoryOriginalCapture(token, agent, graph)` 先 exact token/
agent/graph 查两个原私表并核 current factory、原 source；unknown/clone/foreign 在
回调前 miss，真实失败沿原 factory 失败拒绝。返回值只原函数地址，不执行函数、不接
caller callback/register/inspector。State.finish 与每个 assertInstaller 必须从这个
reader 取回并严格等于 installer.capture，不能用 source.graph 字段形状替代 agent
私记录关系。State/Lifetime 不 value import SharedInvocation 或 Desktop；这一私关系
留在原 pure Domain 文件内，避免新的 Desktop 依赖环。原 ordinary/generic 路径不变。

### App 第一窗源码冻结范围（尚未实际验收）

当前生产共五条路径：新增 `function-conversation-shared-native-stream-state.ts` 的
真实 provisional→published installer、SDK pending/边界/Scope receipt；原
`mods-conversation-shared-invocation.ts` 的 native 安装 getState→observer→seal→publish
接点；`function-conversation-native-lifetime.ts` 只 observedStream 第一行的私 dispatch
拒绝；pure `function-conversation-shared-native-domain.ts` 的 originalCapture 私关系；
`conversation-shared-checkpointer.ts` 的独立 fixed run 层。旧 public stream API、frame、
ready activation、Scope 二十四旧定义和原 Producer/admission 门均没有开放或删改。

新测试是 Scope operation 八定义和 App preflight 六定义，均真实父 StateGraph、
Saver、Authority 和 Scope。首窗在原 SDK dispatch 之前以私 stop identity 结束，
Scope receipt 只证明真实 preflight 结果，不是 SDK iterable terminal/Source/消息资格。
App 此基础执行只取调用 signal 或本 Scope controller signal，未宣称其为最终 stream
runtime/cut 合成或原实际 S 来源；未来真正帧窗口仍须独立来源设计。源码审票、Node/
实际回归、Worker/build 与旧 Shared native invoke 回归都必须各自记录。

capture 调用始终 `Reflect.apply(originalCapture, undefined, [])`，保留旧词法
`capture()` 的 receiver、零参数和原一次调用；不以私 Installer 作为新 this。
App 六个真实定义的 capture 都使用 ordinary function(this: undefined)，每次严格核
this===undefined，不用箭头函数掩盖 receiver 变化。此只修调用兼容，不改变私地址 join。

新增独立第七 App 定义只观察原 genuine factory/agent 两真实构造返回，持有实际
published factory 的 graph descriptor；替换 getter 后 originalCapture reader 必须先
私 token/graph/agent/source 地址门、再 current descriptor 数据门，getter 零次且恢复
仍 sticky。该 observer 原调用/receiver/参数/结果不改，不造 factory/token/Scope。
当前 App 定义七个（Scope operation 仍八个）；尚未跑这些新增实际门。

首次 SDK14+Scope旧24+operation8+App7 实际为 48/53，五个 App 用例在 capture 返回
undefined 或 schema 尚未到达处失败。源码确认是 fixture 未执行原 Manager 的真实父
conversationRuntime 前置；生产没有因此刷新 Scope、WM 或放宽门。唯一测试修订把
fixture 改为 async，在 cleanup 注册后原样 await coordinator.prepareRuntime 与
manager.prepareFunctionConversationRuntime(parent.authority, controller.signal)，同原
Shared derived fixture 的 native 父准备，再让所有七个调用方等待其完成。旧 schema
attempt/capture receiver/provider/nativeRuntime/真实finally 全断言不减；该修后门待 Root。

修后 Root 实际 App 七项全通过，日志
`output/stage24-app-preflight-parent-initialized-current.log`；test 1.514s、collect 4.73s。
此前同生产 SDK14+Scope旧24+operation8 四十六项已通过；因此当前组合功能事实为
53 项绿色，首 48/53 的五项 fixture 前置失败仍保留在原日志。此绿色只限真实 SDK/
Scope/App preflight 执行基础，不是公开 Shared stream、inner iterator、帧、ready、
plainmessages/SSE 或所有终态/性能验收。Node66/真实 Worker/build/Electron由 Root另记。

### 下一窗：原 Pregel → PartialRunnable → Runnable → iterator 的词法交接

本节已获两人限定设计评审。Core/Graph 十四目标现已由 Root 生成、安装并通过
SDK11/FS5 全十六门；App iterator stop 和后继 Source 生产源码仍未接。已完成的
Langchain 十三目标、原十四 SDK 门与 Scope/App 五十三项基础事实保持各自范围；
不能用它们认证这里尚未执行的 App 内层调用。组合安装状态见本节末的冻结说明。

#### 实际依赖与三个动态接点

当前实际安装 `@langchain/langgraph@1.2.5`、`@langchain/core@1.1.36`。
原 Langgraph `dist/pregel/index.js` 的 Pregel.stream 905–916 先建立本 call 的
AbortController，执行原 combineAbortSignals，再构造 config，913 调用 super.stream。
这个 super 是同模块 PartialRunnable.stream（125–127），它再次动态 super.stream。
最终 Core `dist/runnables/base.js` 119–128 执行原 ensureConfig，然后在 122 动态
`this._streamIterator(input, config)`。只锁住 graph 自身 stream/iterator，尚未固定
两个 superclass callee；首 observed iterator 或相同 signal/ALS 都不是该调用来源。

新 native 分支保留这三个原方法各一次、原 receiver/input/config、原配置处理与
AsyncGeneratorWithSetup.setup。它只把上述三处方法派发限定为 module evaluation
固定的实际函数，真实交接事实保存在模块私表与栈上局部变量，不放入 config、tags、
metadata、configurable、Symbol 字段或全局 ALS。普通无 operation 的正文继续原样。

#### Langgraph 的自产执行事实

在同一 Pregel 模块里，PartialRunnable 和 Pregel 定义完成后、任何实际 graph 构造
回调之前，分别固定 originalPartialStream、originalPregelStream，以及原 Pregel
iterator 的函数和 data descriptor。成功的原 Pregel constructor 在原 validate 完成
后，仅以真实 this 和这些固定模块常量登记 birth 私表；不把 constructor 末尾的
current prototype 方法当 original。未知回调中尚未完成构造的 this 没有完成事实。
App 仍须查原 NativeAgentFactory/真实 installation，birth 本身没有应用权限。

新增 package 私模块接口草案：

```ts
createNativePregelStreamOperation(graph, input, options): NativePregelStreamOperation
executeNativePregelStreamOperation(operation): Promise<unknown>
readNativePregelStreamOperation(operation, graph, input, options):
  NativePregelStreamExecutionFacts | undefined
```

create 只查 birth 私表和实际数据描述符；unknown/clone/Proxy 先私表 miss，不读方法。
它不接 caller 函数、guard、reader、baseline 或 observer 注册。继承的原 iterator
必须仍为固定原 owner/function/flags/path；若实际 graph 已有 own iterator，只记录
该 own data 函数和不可写、不可配置的 descriptor，不宣称这个函数已获 Lifetime
来源。App 必须另以真实 observer installation 的 selected function/descriptor
严格比对；任意 immutable fake method 不能凭这个执行事实成为应用 Source。

operation 是新空 frozen token。record 固定实际 graph/input/options、原两 stream
函数、selected iterator 与完整 descriptor/path，所有 optional 初态均 own undefined。
状态为 new → entering → entered → partial-entered → core-created → dispatched，
独立 failed sticky；dispatched 只指实际 iterable shell，没有 terminal 含义。

execute 在 Reflect.apply(originalPregelStream, graph, [input, options]) 前就登记
outer starting ticket 和本 graph 的 exact request，故原 options/config/Signal 的未知
访问发生时也不能把“尚无 outer Promise”当作终态。Pregel.stream 第一条词法语句
消费同 record/graph/input/options/request，删除 request，保存局部 nativeOperation。
重入、错地址、已消费或 execute 第二次使真实本 record sticky；unknown token 不
污染别的 graph。随后原 AbortController/combine/config 的执行次数和顺序不改。

到原 super.stream 位置，native 分支以同 input 和原实际 config 建立 Partial 的
一次私 request，再 apply 固定 originalPartialStream；不跳过 Partial 原方法。
Partial 第一条语句消费 exact graph/input/config/request，只在 native 分支调用
Core 下述 controlled operation。它自身没有未知回调插在 consume 与 fixed callee
之间；无 request 的普通 super.stream 保留原样。创建/消费都只模块私表，未传输
任何 opaque token 到 config，嵌套原普通 stream 不继承外 operation。

外 ticket 只在原 actual Promise 真结算后退出；同步 throw 和 undefined rejection
分别保持真实结果。Core setup、iterable 返回、reader.cancel 和 public Promise settle
均不能用来宣布 generator/runLoop/Saver/Host 已结束。实际资源生命周期仍由后继
Source 原 finally/drain 接点负责。

#### Core 的 actual ensureConfig 与 iterator 调用

Core 同模块在 Runnable class 定义完成后固定 originalRunnableStream。新增两个
shim 和 opaque 类型导出，与原 JS/CJS 模块共用各自那一份私表：

```ts
createNativeRunnableStreamOperation(receiver, input, options): NativeRunnableStreamOperation
executeNativeRunnableStreamOperation(operation): Promise<unknown>
readNativeRunnableStreamBoundary(receiver, actualConfig):
  NativeRunnableStreamBoundary | undefined
```

这个 API 只证明实际 Core 执行，不证明 receiver 是 native graph 或选中的 method 是
合法 observer。create 不接任何 callable 参数，使用纯 descriptor 查实际 receiver 的
iterator data 函数和路径；Graph 的 consumer 先以自己的原 birth/selected descriptor
验证。单独直接调用 Core create 可能检查普通对象/Proxy，不承诺该 producer 零 trap；
opaque reader 的 unknown/clone/Proxy token miss 则必须先私表，零 caller trap。App
只从已认证的实际 graph 走这一步，不能借公共 create 作为 Source 注册接口。

Core executor 首 full/未知配置 callback 前占 entering/used、starting ticket、exact
receiver/input/options request，apply 固定原 Runnable.stream。该原方法首词法 consume
并删除 request，然后仍调用原 ensureConfig(options) 恰一次。实际 resulting config
和它的实际 signal 在返回后固定；不能用重算 signal 或输入 signal 地址替代它。
普通 options.timeout 的原一次 normalize、implicit config、callbacks/tags/metadata
与未知 config 的处理仍是原 ensureConfig；这个基础窗不宣称全局 Any/entries 等
SDK 内部 callee 已加固或所有取消/权限契约已经完成。

到原 `this._streamIterator` 位置，native 分支先比对 create 时固定的 selected
descriptor/path，拒绝 accessor 或恢复前已发现的改变；再以同 actual receiver/input/
config apply 该 data 函数。这一 synchronous callee entry 的私 boundary 固定 Core
operation/receiver/selected method/input/options/actualConfig，try/finally 恢复上一
boundary；token 不在任何普通对象中。Config normalization 期间未知 callback 即便
持有同 graph/config，直接 iterator 没有这个 boundary，不能冒原 Core 调用。

App observer 的第一句必须消费自己 pending 对应的 Core boundary，reading/used 在
首 full 之前占；后来相同方法的递归调用即使还在同 boundary 栈中，也会因原 private
once 状态 sticky 拒绝。boundary 的只读 data check 可在 await 后重核原事实，但不能
在 await 后新 claim，也不能只读 current stack/ALS 授予权限。

原 new AsyncGeneratorWithSetup({generator, config})、await setup 和原
IterableReadableStream.fromAsyncGenerator 各一次保留。constructor 会立即调用
generator.next；它是 SDK 原有 setup 预取，不能称本 adapter 新增预取，也不能删掉
它取得更好性能。选中 iterator 返回的 wrapper/generator 与 signal 都是实际地址，
后继 drain 必须观察原 iterator finally 中等待 runLoopPromise 的真正结束。

#### App 第二个基础 stop：到 actual iterator，不开放 Source

原 State 的 SDK dispatch 已 exact claim 原 agent/graph/merged config、原 getState
receipt；现在在同一次 actual observed stream 入口保存独立 Graph operation，原
observed stream 在原 originalStream 调用位置执行它，Main/no controlled pending
保持原逻辑。Graph 私 reader 固定其创建的 Core operation，App 必须同 pending
SDK operation/graph operation/Scope/installation/receipt 双私关系严格联结，不能
只取最近一个 Core boundary。它不接受 caller operation/guard/Source 参数。

新增 State 的 iterator gate 是 observedIterator 的第一句，在原 source.getStore/full/
原 iterator 创建之前。它先 exact Core boundary/Graph child operation/private App
pending，然后核 SDK original dispatch 与成功 Scope receipt、真正 installed observer
的 selected iterator 与 immutable flags，并占一次 latch。首基础在这些原调用事实
核成功后同步抛自己新建的私 stop identity，外 executor 只以这个 exact identity 收集
facts；没有原 generator/setup/runLoop/model/admission/partial/diagnostic/frame 开始。
没有 controlled pending 的旧 Main/Shared invoke iterator 路径原样，不能给它新 grant。

因此本窗成功返回的是 actual SDK → Pregel → Partial → Runnable → observed iterator
调用事实及实际 S3/S4 配置地址；不是 Source、ready、运行时 signal 权限、frame 或
SDK terminal。全局配置 callback 临时直接进入同 graph/iterator、fake super 返回、
wrong immutable iterator 等都必须在应用 gate 前拒绝，不能靠后来的合法调用补票。

私 stop 会使这次 SDK/Core/Graph execute 原样 reject；它绝不伪装成 SDK successful
dispatch。各 SDK operation 增加纯只读 settlement facts（exact token 查自产私表，
fixed status/value/reason、entered/selected addresses），报告真实拒绝包括 undefined，
不能执行或清除 failed、不能把 reject operation 恢复成可消费 boundary。App 在 stop
前已占住原 boundary 的一次 claim，并保存原 facts；stop 后只核同 token 的真实
settlement.reason===自己 stop 与原同一 claimed addresses，返回基础诊断事实。
active boundary 的授权式 current reader 仍拒 failed；失败报告 reader 只描述原执行
结果，没有 Scope/Source/ready 能力，任何后继真 frame 路径不能以此失败报告出票。

#### 补丁、安装与真实验证范围

两新依赖都锁当前精确版本。Root 必须先独立下载官方 tarball，核 package-lock SRI、
MIT 与原 JS/CJS/package bytes；当前 node_modules 不是独立官方验证。每个 package
计划七目标：原执行模块 JS/CJS、package.json、两个新 shim、两个 dTS，合计十四。
已有 Langchain 七目标的 patch/hash/postimages 全部保持，不重写或改手工 node_modules。
新 installer 先全 batch 验三 package 当前原像/已知 postimage，再全部暂存/rename；
任一 partial/unknown/version/SRI/EOF/exports miss 在写前拒，失败按原 bytes rollback。
原 postinstall native-pty rebuild 与 predev/prebuild --check 保持。ESM/CJS opaque
品牌各自精确，跨 copy/token miss 不变；Core/Graph 不引入 Desktop、Host、Node ALS。
Latest 的 selected-tool 九目标是另一审批窗口，本窗不混改或默认为已安装。

真实 SDK golden 保普通与 controlled 路的全文 native messages、每 frame、完整 CP/
toDict/IDs、callback/default 次数、配置地址/timeout normalize、原 stream 三方法和
iterator 各 once。另真实两类 superclass getter/replacement（含 restore）不执行 fake
callee；ensureConfig 实际 entries callback 期间直接 iterator/同配置 Core execute
不能盗外 operation，caught reentry 外 sticky；并发两个真 graph/operation 不交叉。
需要 held 原 iterator 与真实 runLoop/CP Promise drain 门，不能用 setup fulfilled 或
reader.cancel 替代。未知/clone/foreign/retired token 不污染真 graph。App 基础用原
七项 fixture、genuine parent prepare，再独立加入实际 iterator 私 stop、S3/S4 地址、
late direct-call/unknown Core operation/receiver method getter零次及 provider/admit/frame0。
所有 matcher 在恢复 prototype/mock 后执行，所有原真实资源先 finally/drain 再关闭。

这一补丁/stop 窗通过后仍必须继续 actual activation、opening/ready Source、完整
取消/runtime/cut、values/updates 的原消息出处、plain messages、Command/null 与 SSE。
这些没有实施的能力不能由新的调用事实或基础绿门推定完成。

#### Core/Graph 首批 SDK 源码冻结范围与真实 Promise 观察

Root 与 Latest 已分别通过上述十四目标方向，以及 outer 真实 Promise 观察的窄增量。
当前源码窗仅准备 SDK 基础，不接 App iterator stop、Source、ready 或公开 frame。
具体源文件为 `patches/langchain-core-native-stream-runtime.js.inc`、
`patches/langchain-core-native-stream.d.ts`、`patches/langgraph-native-stream-runtime.js.inc`、
`patches/langgraph-native-stream.d.ts`、
`scripts/generate-langchain-inner-stream-origin.mjs`、
`scripts/apply-langchain-inner-stream-origin.mjs` 和同名 `.d.mts`。
真实回归源为 `src/main/agent/langchain-inner-stream-origin.test.ts` 十一项，以及
`src/main/agent/langchain-inner-stream-origin-installation.test.ts` 五项；尚未执行。
两套新 patch/manifest 已在完整源审通过后由 Root 生成并实际安装；真实十六门与
准确 hash 见本节末。此前“模板已写、未执行”的首冻结事实仍保留在原记录。

Core 和 Graph 各自私 record 在创建时有 own `actualPromise: undefined`。executor 在
原 fixed async 方法调用前占 starting/pending；取得原 Promise 后，先保存同地址并以
固定原 `Promise.prototype.then` 观察，再检查首 consume 是否完成。已经取得并观察
Promise 时的 gate 失败只能把本 record sticky failed；不能提前把 pending 设为 false，
也不能把该 gate 的错误写成原 SDK 的 rejection reason。实际 Promise settle 时才记录
原 fulfilled/value 或 rejected/reason，包含 `undefined`；原 fulfilled 后仍有纯 failed/
phase 门，所以该 operation 不会恢复执行资格。只有原同步调用没有交出实际 Promise
时，才立即退 ticket 并传播同步失败。readonly settlement 仍没有 Source/ready 能力。

两新增 first-consume 回归用真实 compiled StateGraph，临时把真实继承链的一层改成
描述符 Proxy，在 create、execute 检查完成后的原 async 方法首 consume 处抛真实 Error
或 `undefined`。它们明确是 producer 反射失败反例，不能冒 unknown opaque reader 的
零 trap 证明。调用必须返回受观察的真实 async Promise，立即读 settlement 仍无结果，
await 后才有原 rejected/reason、entered false；真实 node、Saver、模型均未开始。
这类首 consume 拒绝发生在 generator/setup 前，故没有可声称已 drain 的 runLoop。
另外原 held 真实 node 用例继续单独证明 iterable shell fulfilled 不等于节点 finally 完成。

五项安装 fixture 从完整 fixed patch 的原行恢复官方 before bytes，逐文件核原/新 SHA
与 EOF，不执行其中代码，也不依赖 ignored output 的取证文件。检查十四目标正常安装/
重复校验、未知 Graph 阻止 Core 写、Root lock/SRI 变化写前拒、真实第九 rename 失败后
恢复 Core 七文件及首 Graph 文件，以及一包 after/另一包 before 的 mixed 拒绝。三包
依赖地址仍由 Root 的完整安装入口校验；旧 Langchain 7/13 的源文件不在本 owner 窗口。
Root 还须将 Core/Graph 顶层依赖和 root lock 声明锁为 `1.1.36`/`1.2.5`，并把已独立验证
的 resolved/SRI 纳入各 node_modules lock entry；在此之前新 installer 将精确拒绝。
当前旧 SDK/Scope/App 的绿色证据不替代本次 SDK 十一项或真实 FS 五项。
Latest 已对上述九份源码作独立限定 SOURCE2 PASS；owner SOURCE1 范围与之相同。
Root 的源码复核、两包 artifact 生成、完整组合入口及实际安装/十六门仍待执行。

#### 后继精确安装窗：三个包的完整 27 目标

本段只申请组合安装/检查设计票，未修改当前十三目标入口或 package hooks。当前
`apply-langchain-native-foundations.mjs` 只覆盖已批准的 Langchain 十三目标。不能简单
在其实际安装后再调用十四目标 installer：那会让未知 Core/Graph 前像在旧十三已写后
才发现。新入口必须先读完三包、所有 artifacts 和 Root lock，再开始任何暂存或写入。

拟新增 `scripts/langchain-native-foundation-batch.mjs` 和同名类型声明，原 CLI
`apply-langchain-native-foundations.mjs` 最终只委托这一完整批次。两个现有 installer
owner 分别抽出 readonly prepare 函数，保留其逐文件/模板/官方来源检查：

```ts
prepareLangchainNativeFoundationPlan({ workspaceRoot }): Promise<PreparedPackagePlan>
prepareLangchainInnerStreamPlan({ workspaceRoot }): Promise<PreparedInnerPlan>
installLangchainNativeFoundationBatch({ workspaceRoot, checkOnly }):
  Promise<{ status: "installed" | "patched"; targets: 27 }>
```

这些仅是 CLI 文件维护计划，不加载 SDK 模块、不调用 package 里的函数，也不返回
App/Source/权限对象。prepare 只读取与计算内存 postimages，绝不调用任何会写文件的
`install*`，也不捕获“not installed”错误后猜合法状态。old thirteen 的原 classifier
明确提供 pristine/base/overlay/mixed；inner 私 prepare 提供 complete-before/
complete-after/mixed。任何 mixed、unknown 或缺少 artifact 立即拒绝。

计划完整持有三包 root、固定相对路径、原 bytes/absence、实际原 SHA、目标 bytes/
SHA，以及四份 manifest/patch、九份 template、三个 LICENSE、Root package/lock 的
实际已读 bytes/SHA。它不接 caller 自定义 file set、baseline、patch 或回调。
Langchain 的 pristine 场景先在内存 apply 原七目标，再把这份准确 base 与原官方
ToolNode 两文件交给原九目标 overlay，最终只取十三个 distinct postimages；base
场景只在内存 apply 原 overlay；overlay 场景保全部十三原 bytes。不能把 overlap
三文件当独立可任意组合的 hash。Core/Graph 各七必须同时全 before 或同时全 after，
不能接受一个包 after、另一个包 before，即便两包分别都能通过本包检查。

完整检查允许已批准的 Langchain pristine/base/overlay 与两个 inner 包共同 before/
共同 after 的明确组合；仅 overlay＋共同 after 是 installed。其它明确组合表示需要
安装，允许从现有已验七/十三目标或两包已验十四目标升级/恢复；未知部分文件永不
自动补齐。`--check` 读取全部二十七目标与四套 artifacts后，只对 installed 返回成功；
合法但未完成时固定 not-installed，mixed 时固定 mixed。它不得创建锁文件、目录、
临时文件，也不执行任何 SDK，不能因为旧十三通过而漏掉半十四。

Root package、lock root dependencies、三个 node_modules lock entries 全部锁当前
精确 `langchain@1.2.37`、`@langchain/core@1.1.36`、`@langchain/langgraph@1.2.5`，
官方 resolved/SRI 与各自已验证 metadata/manifest 严格一致。只添加当前同版本的
exact pin/来源字段，不改变传递依赖选择。未知版本、其它 registry、Root/lock 声明
不一致，在任何 package 文件写入前拒绝。原 native-pty rebuild/background helper
顺序不变；三个 hooks 切到完整批次需再源审，不能在未安装新 subpath 时先破坏 dev。

实际写入入口持有一个本次专用安装锁，防止两个 npm 生命周期 installer 交错；锁只
属于本次 CLI 安装，不是业务权限。它在取得锁后重读全部计划，先暂存所有 changed
postimages与 rollback 原 bytes，再重核四套 artifacts/Root lock/全部二十七原像。
只对本次原 bytes仍严等的目标逐个 rename，已为准确目标的文件不重写；新四 shim
或其它目标的原 absence 也必须仍是 absence。期间不运行构建、Electron或 SDK 模块。
完成后再次全二十七 after 校验与 Root lock 校验，才返回 patched。

任一真实 stage/rename/final 校验失败时，按逆提交顺序，只在当前 bytes仍等于本次
目标 bytes 时恢复其原 bytes或原 absence。其它进程的新未知 bytes不得覆盖。所有
temps、rollback 文件、安装锁独立清理，首错误包含 undefined，清理失败单独保留。
写前发现 Core/Graph mixed 时二十七个目标和 temp 数量均必须零变化；不能以事后
回滚成功代替这一写前保证。组合锁与临时文件只删本次确已创建且仍属于本次的地址。

真实 FS 独立回归需覆盖 pristine27、已验 base7→27、overlay13→27、全27 check/idempotent、
未知 ToolNode/未知 Core/未知 Graph、Coreafter/Graphbefore与反向 mixed 在旧13未写时
0change、Root pin/SRI误改、真实跨 Langchain→Core→Graph rename 故障全原字节恢复，
以及两个实际入口同时启动的串行/拒绝行为。全部已安装原七/十三 fixture 与 reverse
bytes/EOF 保留；当前 SDK14、selected24和 inner11都须由 Root 重新执行。此组合维护
green 仍不授 App iterator、Source、ready、公开 frames 或资源 terminal。

##### 27 目标实现首窗的精确冻结范围

Root 已验证十四目标实际安装及 SDK11/FS5 全十六门通过；两个 patch SHA 分别为
`d1a44205e65705c20c45c93fc749790a17dc16b996a82211302cd97a502576ee` 与
`740ce86bd23dbd30400cf68eb66ebaac1403464c0644e68d9459c038b956ece1`。
旧十三修正后 SDK43/0unhandled 已通过，但这些记录不代新完整批次的实际门。

首实现窗为 readonly `prepareLangchainInnerStreamPlan`（原两包 installer 与声明）、
NEW `scripts/langchain-native-foundation-batch.mjs/.d.mts`，以及 NEW
`src/main/agent/langchain-native-foundation-batch-installation.test.ts` 的二十一实际 FS
定义。Langchain owner 在原 tool installer 独立新增 prepare13 与静态 typeimport。
共同 shape 只有固定 package/targets/evidence；bytes 的 null 明确表示原 absence。
批次入口只接 workspaceRoot/checkOnly，不接 caller 的 plan、file set、baseline 或回调。
Root 的旧 composite 和 hooks 本窗尚未改变；必须整体源票与实际门后再切换。

全部证据固定为 Root package/lock、四套 manifest/patch、九个 templates 与三份 LICENSE；
重复 absolutePath 必须实际 bytes 和 SHA 都相同。固定三个包、relativePath 的次序、
targets27 distinct 与 complete evidence set 在写入前再核。installed/check 路径不创建锁或
temp；已完成包不重写。实际独占锁通过本次 wx/nonce/FileHandle 身份捕获，锁后重新
prepare，并保持首次整包与 evidence 原像；stage 全 changed post/rollback 后再次全核。
每次 rename 前还核原目标 bytes、同本次锁和 stage 文件身份与完整 bytes。

任一失败保首 reason（包含 undefined）。已提交目标只在同本次 stage inode 且当前
exact postimage 时回滚；foreign bytes 保留并独立报告失败。正常完整 temp/rollback/lock
cleanup 必须同 created inode 加 exact 成功写入 bytes。实际 writeFile 拒绝时，只在同
created inode 前后核过的 current bytes 为 expected 的完整 prefix（允许零长度）时保存
partialBytes；cleanup 还要同 inode 与 exact captured partial。未知或后来变动的 bytes
不能删除。partial 不证明写入完成或 installed。真实 FS 分别验证部分 write 的 undefined
拒绝可清理，以及同 inode 外部改写后 foreign 内容保留与 cleanupfailure。

二十一门完整覆盖 pristine/base7/overlay13→27，inner 已全完成时只写剩余 Langchain，
full check/idempotent0write，三个包 unknown0stage，Coreafter/Graphbefore 与反向0stage，
exact pin/SRI 误改0write，四个真实跨包 rename 故障全 before/absence 恢复，已提交目标的
foreignbytes 不覆盖，真实 partial 两门，以及两个实际 installer 同时启动时第二个 busy
拒绝而第一个原 FileHandle/写入/清理真实完成。测试没有执行 SDK 或授业务权限；
旧14/selected24/inner11 与全部旧 FS 门仍须 Root 同批复验。

### App 下一精确窗：真实 inner iterator 一次私停止门（源码冻结，尚未实际）

本窗只把已通过的 App preflight 与新 SDK 三层实际调用事实接齐；不创建 Source、
Domain ready、Host、producer、frame、setup 或 generator。旧
`runFunctionConversationSharedNativeStreamPreflight` 的外 dispatch 私停止和七项真实
回归不改。新增固定内部入口
`runFunctionConversationSharedNativeStreamIteratorFoundation(graph,input,config)`；它只在
同原 prepare/finish installer、真实 Factory/Agent/Origin/observer/capture 私关系与
本次 Manager Scope 全部通过时创建另一 fresh pending。两个入口不接 bool、callee、
inspector 或 caller stage setter；该 API 的普通执行事实不能授文件/消息能力。

Pending 新增 own 初始化字段：`inner: false|true`、`graphOperation:undefined`、
`graphFacts:undefined`、`coreBoundary:undefined`、`iteratorClaimed:false`。mode 只由
上述两个模块词法入口选择。runReading/preflightReading、SDK operation、Scope原执行
票、first failure sticky 和全部输入/配置 original baseline 继续原独立字段/规则。
实际 capture 仍 Reflect.apply(originalCapture,undefined,[]) once。

Lifetime 的 observed stream 首同步入口仍调用同 State dispatch gate。旧 preflight
pending 在同原点抛原 exact stop；没有 matching pending 的普通 Main/Shared 路径仍
返回原 stream。只对新 inner pending，在 SDK original dispatch boundary 尚同步有效
时固定同 actual state/S2 config，并核 Scope settled receipt 的 originalRead。
然后以真实 graph/input/S2 config 调用固定 SDK
`createNativePregelStreamOperation` 一次，保存其 opaque token；只读 Graph reader 必须
返回同 graph/input/options 三地址。其 selectedIterator/owner/全部 immutable flags
必须严格等同这个 Lifetime private installation 的实际 observed iterator，不能用
当前 own value 自建原基准。验证完成后调用 SDK execute once并把原 Promise交回
observed stream；不调用普通 public graph.stream，也不另执行原 stream 第二次。

Lifetime 增一个只读 module-owned current dispatch helper，输入为 actual installation/
graph，先 exact observerRecords/observerGraphs 双私关系和现有 full descriptor 数据
检查；返回首安装自造 observed iterator 的原地址/owner/当前 flags 与固定数据尾。
它不接 caller 函数/flags，不注册安装，不容忍未批准 flags transition。只给 State 此次
Graph选择核对，Main旧 observer 原 guards/次数和所有 source producers不改。

Lifetime observed `_streamIterator` 的首行新增 State gate，必须早于 sources.getStore、
source/assertCurrent、shape、original.call 和任何 generator/setup 创建。没有 matching
App pending 时保原路径；同 installer 的 pending 存在但缺 true Core boundary时永久
invalid，不能 direct-call 后靠 later正版调用补票。第一行用固定 SDK
`readNativeRunnableStreamBoundary(graph,actualS4Config)`；只有此模块真实原 Core 在
原 ensureConfig 完成后调用 selected iterator的同步词法点才存在 boundary。

同一首行先占 `iteratorClaimed`，随后完整核原 pending/Scope opening/receipt/installer，
Graph operation reader的 coreOperation必须 === 此 Core boundary.operation；Graph
actualConfig 是真实 Pregel S3，Core actualConfig===本调用 actualS4Config，两者地址与
原 SDK产生事实固定，不重算 signal 不按相似 config/ALS/first授权。Core receiver/input/
selectedIterator/owner/全部 descriptor 与已保存 Graph facts、actual observed iterator
必须同原地址；原 SDK boundary/assertDataCurrent 和 observer pure data尾全核。
任一重入、unknown Core operation、错 graph/config/receiver 或 late结构变化先 sticky
失败。caught后恢复字段不复活 pending；未知他图 token不污染另一个独立 pending。

全部上述事实成功后，Gate只创建本 pending 新 exact stop并同步 throw。实际
_streamIterator原 generator函数一律尚未调用；所以不会启动 setup、原SDK预取、
model/Saver admit、completion/partial/diagnostic/frame。此不是SDK正常 stream成功，
更不证明任何 iterator物理 drain。该 execute真实 Promise及Scope pending票仍由原
await/finally退，不因 first gate同步throw提前释放已有真实 Promise。

外执行器只接受自己的 stop identity。旧 SDK dispatch boundary、Graph/Core operation
失败后不可再次消费；只用 SDK readonly settlement分别确认两层 actual status rejected、
reason===stop，原 graph/input/options/selected地址与 Gate保存事实严等。报告 reader
不清 failed、不返回重新执行权；App facts仅保存真实 S2/S3/S4、两个opaque operation、
Scope receipt和模块自造纯数据检查。没有 stop、ordinary delegate error、abort、
undefined reject、captured sticky failure或错误 settlement一律按原失败传播。

生产精确窗仅 State、Lifetime的两个同步接点/私 observer helper，及同 actual Shared
fixture 的独立回归；不碰 Factory/Domain/Scope 旧32项、SDK templates/exports或27
installer。必须新两设计票后才实施。计划八个实际定义：genuine链一次/S2-S3-S4/两
exact rejected-stop facts/provider-admit-frame0；Core normalize期间直接 observed iterator
被caught后仍sticky；同窗口 unknown Core operation；初始化直接 graph/iterator组合
偷用；真实 superclass getter/replacement restore不执行fake且原次数保；independent
两个真实图/token不串；原 outer preflight七项全保；真实 owner abort/close使整个
Scope实际 await/finally结束而返回facts永久失效。计数仅针对本adapter新增调用，不
声称原 SDK预取被取消或所有框架动态callee已固定。Source/ready/plainmessages/
values-updates/Command-null/SSE和真正完整 drain仍须后续继续实现。

独立第二评审后的签名精度：State dispatch helper 返回 `undefined` 或本次自产的
`Readonly<{promise: Promise<unknown>}>`；Lifetime 在首同步接点只调用一次，命中时原位
return 其中同一个 SDK execute Promise，不再进入后面的 originalStream。该包装仅运输
本次已保存的实际 Promise，不是可注册的 Source 或 caller handoff。iterator gate 首先
占 iteratorClaimed，再核所有原 full/data；必须严格核 Graph.options===SDK 的 S2 配置，
Core.options===Graph.actualConfig 的 S3 配置。Graph reader 是当场从同 opaque operation
读取的最新事实，不能把 create 时尚未设置 coreOperation/actualConfig 的初 snapshot
当作执行中事实。actual S4 则必须是 Core 词法调用这次 observer 时的同一个参数地址。

停止后的返回事实只调用两个 readonly settlement reader，对同一 operation 的全部
地址、status/reason/entered/partialEntered/iteratorEntered 严格核定；不能再次调用已
failed 的 Graph/Core execution reader 或 boundary.assertDataCurrent 企图刷新权限。
返回事实的 pure tail 只复核本 pending、原 Scope receipt/opening、实际 installer 与
observer 数据关系，以及同一 readonly settlement，不清除 SDK failure。新增八个定义
与旧 preflight 七项是两组，旧七项不算新增定义也不改变其任何断言。

本窗已按 Root DESIGN1 与 Latest DESIGN2 完成限定源码，冻结文件为
`function-conversation-shared-native-stream-state.ts`、
`function-conversation-native-lifetime.ts` 与新增
`function-conversation-shared-native-stream-iterator.test.ts`。只有两个固定模块入口选择
旧外停止或新 inner 停止；Lifetime 自产 dispatch view 在 observerRecords/observerGraphs
双私表命中后才返回当前已批准 immutable descriptor，没有重新采集来源。实际
handoff 原位返回同一个 Graph execute Promise，iterator 首 claim 在所有原 full 前，
Graph.options/S2、Core.options/S3 与 actual S4 严等。报告只调用两层 settlement reader，
不调用已失败 execution/boundary 的 assertDataCurrent。

新增八个真实定义覆盖链路一次与无 Saver 查询/Provider/Runtime 接纳、unknown/clone/
Proxy observer token 的零 trap 数据门、Core normalize 内 caught direct iterator、另一真
Core operation、Zod 初始化 caught stream/iterator、late superclass getter/replacement、
两个图的真实 owner 退休，以及 Scope close 期间真实 pending/finally 排空。真实 Manager
parent runtime 两个准备调用仍在 cleanup 登记后执行。旧 App 七项、Scope 三十二项与
SDK/Factory/Domain/27 安装目标均未修改。当前只完成 Owner SOURCE1 自审，尚待独立
SOURCE2、Root 类型/旧门与新增八项实际结果；不能把此冻结称 frame、ready 或物理
iterator drain 已实现。

首次实际新增八项为 1 通过、7 失败，旧 App 七项全部通过；失败都发生在 fixture 对
外部 SDK ESM export 安装 spy 的阶段，日志
`output/stage24-app-inner-iterator-first-current.log` 保留。Root DESIGN1 与 Latest DESIGN2
批准仅测试观测修订：观察本仓库 State 的真实 dispatch/iterator 原函数，固定原地址后
Reflect.apply 同 this/args 一次，返回原 handoff 与同一个 Promise，不改 SDK export。
iterator 原 delegate 前只读真实 Core boundary；成功例从返回的实际 Graph/Core token
读取并严格比较完整两层 settlement，原 S2/S3/S4、selected flags 与所有地址断言保留。

normalize 攻击仅在真实 dispatch delegate 期间，用 root 不同于 S2 且 configurable
同地址定位 fixture 候选；这个条件不认证来源。攻击后必须由真实 observed iterator
第一行读取的 Core boundary 严格证明 options 就是被攻击的原对象。foreign Core 在
原 dispatch delegate 返回 handoff 后才另执行真实独立 operation，原 Graph/Core 的
私停止已进入但原 Promise 尚未结算；同 handoff 原样返回，独立 operation 真拒绝与
sticky、原两个 Core 结算事实、0 Provider/Runtime 与真实 Scope finally 全部保持。
本微修订唯一生产差异为零，新增定义仍八项，当前重新冻结待独立 Source 与实际门。

修订后的真实 54 门为 52 通过、2 失败，日志
`output/stage24-app-inner-iterator-observation-corrected-current.log` 保留。旧 App 七项、
Scope 十二项与 Factory 二十七项全部通过；新增八项六项通过。两个失败都在真实
Scope 关闭或原 owner 退休后，原 opening 数据门先抛出
`MODS_CONVERSATION_CHECKPOINT_SCOPE`，State 保存同一首错误而不改写为 Source 错误。
Root DESIGN1 与 Latest DESIGN2 批准仅这两个测试预期改为精确原 Scope code。实际
Core boundary 的 S3 地址、两个 operation、关闭前 pending 占用、未排空状态及实际
finally 后 whenDrained、0 Provider/Runtime 等原门全部保留；其余攻击与 foreign 的
Source code 断言不变。生产代码零改，新增八项再次冻结，实际重跑仍待 Root。

Root 随后的真实 54 门全部通过，日志
`output/stage24-app-inner-iterator-scope-reason-corrected-current.log`：新 iterator 八项、
旧 App preflight 七项、原 Scope 十二项与 Factory 二十七项均通过。Node69 也已实际
通过。此前 ESM 观察 1/8、观察修订后 52/54 的失败日志与原因继续保留。这个结果只
确认 SDK dispatch/Graph/Core 原关系、原 Scope 票与精确私停止及失败结算；尚未运行
generator/setup/model，不产生 ready、frame、Source 或真实 iterator 生命周期排空权限。
