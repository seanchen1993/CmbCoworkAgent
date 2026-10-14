# Shared invoke 最终消息的实际出处

状态：两人设计审核后的接线实现中，整条 Shared 返回来源尚未实际验收。raw-only
ordinary helper 原 23 项已由 Root 实跑通过；入口前移的两项和三项真实 Shared 来源
回归仍待统一运行。第三 `_streamIterator` seal 不证明原 superclass 整条分派不可替换。

## 已确认的触发路径

实际 `Pregel.stream` 调用 `super.stream`，再经 `PartialRunnable.stream` 调用原
`Runnable.stream`。初始化 callback 可临时替换这个 superclass 方法，委托真正原
stream 完成实际 Node、Host ACK 与 Saver 写入，再把消费者收到的 iterable 换成含新
unmarked AI 的值并恢复。当前 Shared invoke 在真正完成后确有 domain.view，但
`Host.validate('values', result)` 的普通 compatibility 分支对未知 unmarked 消息不授
出处也不拒绝。随后完整 typed copy/hash 只能证明值没有改变，不能证明它来自原
实际 completed producer。因此不能以三份 graph own seal 或 typed copy 代替最终出处。

## 最小合同

只对 genuine Shared native invoke 返回的 `messages` 加严格来源选择，普通调用和现有
公开 projection.validate 的 unknown-unmarked compatibility 原样保留。每条实际
返回消息必须属于以下一个来源：

1. 当前真实 Host projection 的 exact own Entry。只接受原 native Base 地址、同
   private owner/runtime/domain；包含新真正 Keeper ACK、已登记的真实历史 member 与
   已登记的真实 intake。原 complete native digest、actual Store row、23 列、receipt、
   presentation/ledger 与 partition 的完整 A/B 全保。
2. 本次原输入里明确的 ordinary 消息地址。在任何原 Agent/middleware callback 前，
   同一个 genuine factory/domain 内从实际 admitted input.messages 的 dense own data
   descriptors 固定 exact Base 地址、prototype、完整 typed 原值 digest 和容器拓扑。
   ID-less 输入必须用新的内部 typed raw capture 固定首 absence/undefined，不调用
   occurrence capture，不提供 stableUuid，也不产生 snapshot、UUID、row、Entry 或
   ACK。原普通 capture 的必须有 ID 合同不改。下面单列真实 reducer 的两个 ID 字段
   兼容规则，除此之外全部原值与描述符仍严格保持。canonical marker 不属于 ordinary
   白名单；foreign marked 输入不能因为是参数而通过。每次最终读取须 same 地址、
   same original domain 与 signal/cut 原事实一致，clone、同 ID 或相同 JSON 均不能借
   这份证据。
3. 实际旧 CP 中的 ordinary 消息。只能由原 Shared Scope.getTuple 返回的真实 Saver
   tuple，在同 native read/admission 完整 checkpoint membership/native snapshot 验证
   成功后固定 exact tuple/array/member 地址和完整原值。canonical member 必须沿同
   membership proof 登记到当前 Host own Entry，不能落到普通历史白名单。不得从返回
   result 数组、公开 stamp/metadata、caller callback 或当前 Saver 的任意 list 猜历史。

本轮新增加的 unmarked AI/Human/System/Tool 如果不属于上述来源就明确拒绝；合法新
producer 要沿独立具体来源适配继续实现，不能通过兼容分支外发。Remove/Command
仍由原图/reducer执行，消失的原消息不要求重新添加，也不把此白名单变成工具权限。

## 原 ID-less 输入的精确兼容规则

实际 `@langchain/langgraph/dist/graph/messages_reducer.js` 在原消息没有 ID 时给原
`message.id` 与原 `message.lc_kwargs.id` 写入同一个 `v4()` 字符串。只固定首 absence
并在结束时比较未适配的完整摘要，会错误拒绝真正的原 Human 输入。因此新增 raw
capture 只为这里的普通输入保存 actual native class/prototype、exact 原消息地址、
exact 原 `lc_kwargs` 地址，以及完整 own keys 顺序、data descriptor flags 与全部原
值。首 callback 前已经完成 Proxy/accessor/symbol/类型及原展开预算校验；它只产生
私有原数据基准，不产任何可发布 snapshot 或 occurrence 能力。

首 root ID 是 nonempty string 时，两处原 ID 与其他全部字段都不可改变。首 root ID
不存在或其 own data value 为 undefined 时，本次最终读取可保持原 absence/undefined，
也可接受以下唯一新增状态：root ID 与同一原 `lc_kwargs` 的 ID 都是相等的 nonempty
string。首 `lc_kwargs.id` 也必须 absent/undefined；不把矛盾的既有 kwargs ID 当作正常
ID-less 输入。原字段存在时 normal assignment 只允许原 data value 变化，所有 flags
保持；字段不存在时只允许正常 assignment 新增的 enumerable/configurable/writable
data property，并严格核新增 ID 在完整 own-key 顺序中的位置。其他任意 own-key、
prototype、descriptor、body、name、kwargs、tool calls、metadata、二进制与嵌套值变化
均拒绝；不能忽略 ID 之外的字段，也不能刷新原数据基准来接受变化。

此字符串只维持原 reducer 的数据兼容，不被用作 UUID/Slot/row/Entry/CP membership
证据，不要求用公开 ID 猜 genuine reducer，也不接受以 ID 相同恢复原地址。实际
reducer 还处理 root null；本轮输入资格仅为 absent/undefined，原 null 仍沿明确不支持
的 typed 输入分支，除非后续另将 null 的同等数据兼容规则纳入设计。

进行比较时，只在模块自己的完整私有副本中恢复 root 与 kwargs 的首 ID 值或首
absence，再逐 descriptor/value 完整比较首基准；不修改原输入。到最终 copy 阶段，
使用实际当前有 ID 的完整 typed capture；原值与实际同类私有副本的完整当前摘要仍
严格相等。最终 full 检查选择的实际 ID 与完整 current digest 同次固定；后续 B/纯尾
不重新选择 ID，也不刷新该当前基准。首 absence/undefined 在原执行中仍可保持，但
最终原标准 native copy 不为无 ID 消息伪造 ID。ID 已分配时最终 copy 的摘要不再作
恢复或省略。后续末 source callback 若只变 root ID、只
变 kwargs ID、恢复到首 absence、变 descriptor 或其他字段，完整 data 尾均拒绝。

旧 ordinary CP 来源必须固定原实际 read/admission 已认证的 tuple/native view 和其
data/current guards。legacy membership=null 需要同实际 Saver/read 的完整 snapshot
来源，不把全部旧历史错误升级为 canonical membership 必须存在。已退休的 native
read token不能延寿；marked member 始终需要当前 Host own Entry 的完整 A/B 来源。

## 私有接点与顺序

建议 `captureSharedReturnInput` 仅为本模块内部 helper，由真正
runSharedNativeFactoryDomain 闭包在 original invoke 前调用。opaque token 的记录固定
actual factory/domain/scope/admitted input；不会接受 caller 构造的 whitelist 或认证回调。
最早 reading/failed latch 必须在首 external callback 前占用，caught 同操作重入毒化。
它没有 runtime 时只固定原输入数据，实际 admission 后只能绑定该同一 domain 的真实
Host/runtime，不得登记 foreign child/Main Host。

Host 新的 Shared-only 来源 reader 由原 factory closure 选 exact Host，不以公共方法
override 或 `validate` 成功 mint。owned 分支使用原 projection 私表中的 exact
owner/Entry/message 选择 data-tail；这一分类不执行 full、不授 receipt，也不能代替
随后一次原 `Host.validate("values", actualResult)` 完整 batch A/B。ordinary 分支只
消费上面的原输入记录。历史来源需要原 Scope/read/admission
私有接点，不新增以 CP ID、数组 JSON 或字符串 digest 注册历史的公共入口。如果现有
restore 没有把完整 membership proof 交到 Host，必须一起补这个实际接点，不能暂时
把所有历史当输入或按 ID 查行补权。

真正 Node/Host drain 完成后，在最后完整 A/B 之前构造原完整 native 私有副本。先对
所有返回来源执行原 full/source/policy/history guards，再用一次实际 batch read scope
完整核 owned rows 的 A/B 与 ledger B；最后只执行每个 input/history/owned/copy 的
complete data/container/domain/signal/cut 尾。原值与私有副本的完整摘要仍严格相等，
之后同步组装原 native class 返回值。finally 的原 close 只持旧原对象引用，不能变更
已复制值。不能在 B 后再调用 source、动态 serializer 或资格登记 callback。

own Entry 的 full read 由原 batch validate 每次 fresh 执行；本提案不新增逐条 full，
也不缓存跨 await/调用的成功 DB。ordinary input/history 小记录只是原地址与完整值基准，不授 canonical/policy/
Tool/Slot 权限，不写库、不新消息、不重 Hook/writer。

## 实际入口、Command 与历史接线精度

genuine factory 的 invoke 入口先进行 descriptor-only 原输入快照，再执行原
configuration/source/captureScope 等 callback。捕获失败用独立 failed/status 保存；
实际选择 native scope 后必须拒绝，不允许补晚基准。未选择 scope 的 generic 原调用
仍沿原路径处理，不因这次试捕获改变原错误或参数语义。scope 捕获后以及进入原 Agent
前，使用 `assertOriginalDataCurrent` 严格核首数据，此时不允许 normal ID 增加；原
Agent/reducer 已经执行后的数据比较才使用兼容 ID 赋值的检查。

native 输入只接受普通 state 或 exact 原 `Command.prototype` 的 own data。Command
完整原 prototype/own-key/descriptor/control 地址固定；update 可以是普通 messages
state，或 dense 两元素 `[key, value]` pairs 的原顺序，messages 可为单个真实 Base
或 dense 数组。Proxy/accessor、坏 pair、未知子类明确拒绝，不用空白名单伪装支持。
移除私 CM channel 只复制原 own data descriptors；不调用 SDK isCommand、用户
getter 或 Command constructor。保留原 graph/resume/goto、其他 state 和实际消息
地址。最终仍由原框架执行 Command/reducer，没有新增执行权限。

历史只在真正 restore 已验证原 initial NativeRead.tuple、完整 recovery snapshot 与
membership 后保存该 tuple 的原 messages 地址。当前 Producer 的 readonly history
闭包在 admission 中交给当前 Host registerHistorical：该原入口完整核 whole-array
native digest/count/member，再登记 canonical members。普通历史使用完整 raw 基准；
不重读已删除的 NativeRead token，也不从最后结果扫描补源。最后 history full 重新核
原 recovery/membership，放在 batch validate 前；B 后仅核保存的 tuple 指针/flags、
原 raw messages、Scope/authority/signal 与 record 生命周期。无 history 的 fresh 分支
为固定空分类。旧无 CM/membership 的 resume 沿原 migration 合同，不虚构 canonical
proof 或声称本窗已经补齐所有 legacy resume。

首次没有 ID 的普通消息最终若仍没有实际 ID，现标准 native copy 明确拒绝；不生成
虚假 UUID。真实 reducer 阳性必须在原执行中给 root 与同 kwargs 分配相同非空 ID。

## 必须的真实回归

保真正 Manager、Shared Scope、Saver、Node、Host、Worker、23 列、完整 CP/native codec
和原默认 5 秒。用真正 Zod 初始化修改实际 superclass.stream，先委托原真实完成再
返回新的未登记 AI，fake 输出须拒且无法返回，真正 committed 行/CP 保留、原 producer
一次、真正 finally/drain 完成。另核 same-ID clone、foreign Host Entry、返回数组晚
getter/替换、原普通输入 body/kwargs/calls 变化、旧 CP 原 ordinary member clone 与
membership 变更均拒；getter 执行零。正向包括 ID-less 原 Human 输入、真实 canonical
SDK notes、真实 Tool/AI/System side、完整 resumed history 与连续 derive/并发隔离。
ID-less 正向必须与真实未包装 reducer 对照，确认原 root/kwargs ID 同值新增及完整
native class/codec；负向包括只改一处 ID、late ID getter、same-ID clone 与原输入
正文/kwargs 变化。真正新 unknown unmarked AI 不得借正常 ID transition 成为输入。

现有 Shared 性能超时记录保留；源码票、实际功能门和性能门分别记录，不以安全修复
或第三入口 seal 宣称整个 Shared stream/defaultsignal/events 已实现。
## 实际恢复 target 地址的增量合同

实现冻结：Restore private target token/complete publication、Projection 第三个 opaque 参数、
Shared admission 传参三个生产文件；Host 原委托自动保留新参数。Restore 新增六个实际定义，
保留旧十四个与 Shared 原二十七个。Projection 的 exact token/messages/proof/store/T2 前门
在 read scope 之前；通过后其 private operation latch 也在 scope 首 callback 之前占用，
同 token caught reentry 会使外层永久失败。尚未运行本增量的 CPU 门禁。

同次精确末尾补充：bridge reader 在 exact 地址前门后先核原 data tail，退休或切换的
已知 token 不进入 scope。Projection 的 `adoptEntries` 只在原 B 后位置使用 factory
固定的 runtime signal 地址/own descriptor/prototype 与原 throw intrinsic；两个私有
PreparedEntry 数组循环同序 index，optional previous 仅取 own data descriptor。
所有 Entry CAS 与 raw 全比较仍先完成，再统一发布。Projection 原 52、已登记来源分类
4 个及新增 8 个真实 scope B-return 方法/字段反例共 64 定义；Root 此 64 定义实际全过。
Restore 首次 20 定义为 19 过、退休反例 1 红，首异常定位保留。该例原来观察的
Coordinator guard 不在 history FULL 的实际路径上；仅测试在最初真实 bindThread 的
physical assertLive 处观察原回调，末原回调释放同 parent。Root focused 复验通过，
count、full/data sticky、request1/tool0 全保。这里未扩全 Runtime 或全 Object 纯度
合同，也不把这个 focused 门当原 Shared 历史与性能通过。

状态：Root 的真实 Shared27 首门 23 过、4 红，其中 interrupt/resume 为功能失败，
不是 5 秒性能失败。`registerHistorical` 用当前 Host target 读取原 membership 时，
`readFunctionConversationCheckpointMembership` 的 exact target 地址门拒绝。这个门不改。

真实来源是 prepareRestore 创建原 restored target T1 并以 T1 mint 完整 membership；
Coordinator/Registry 随后真正 registerSharedChild，把完整 ref 复制成当前 runtime 的
target T2。T1、T2 具有同一实际映射，但不是同一对象。不能以 JSON、UUID 或简单
sameRef 放开 membership，也不能为了凑过重新造普通消息或遗漏 canonical member。

拟仅增加实际完成后的 history 私关系，不开放 caller alias 注册：

1. Restore 创建 history 时在模块 private WeakMap 保存原 history 地址、store、原
   membership、原 T1、实际 tuple/Scope/Saver/authority/invocation/Active 和原两个
   history 全/纯 closure。它仍保原完整 tuple、count、snapshot、cut 与 members 核验。
2. completeActive 已真正读取同 actual registration，并核 registration.target.ref 和
   binding.target 都 exact 是 expected.target T2、同 Active/destination/Scope 等原
   关系后，才把这个实际 history 的 T2 completion 关系保存到同一私 record。fresh
   无 history 不登记；未知、clone、foreign restore/Active/registration/target 不登记。
   不接受调用方提供函数、原 target 字符串或外部“这些 target 相等”声明。
3. 原 complete 路径在 Producer 私记录已发布后自产 opaque
   `FunctionConversationSharedHistoricalTarget`，私 WeakMap keyed 该 token，记录原
   history/messages、membership、store、T1、实际 T2、原 Restore/Active/completed/
   registration/Producer/Scope/Saver/authority/invocation/DB 地址。没有 exported mint
   或 callback 注册。只在此真实成功分支把 token 附在返回给 Host 的 readonly bound
   history view 中，原 prepare history 和 proof 不改。
4. 新 module-owned reader
   `readFunctionConversationSharedHistoricalTarget(token, messages, proof, store, target)`
   先纯核私 token、exact messages/proof/store 和实际 T2 地址；unknown/foreign/clone
   target 在执行 Source 前拒绝。返回 frozen `{ target: T1, assertCurrent,
   assertDataCurrent }`；full 执行原 history FULL，仍以 exact T1 读取原 membership。
   首 full callback 前 reading/failed latch；pure 核原 Restore/Active/completed 私表、
   producerRecords 同原 view、completion descriptor、当前 registration/Producer
   data、原 history tuple/topology/signals/cut 与 target 地址。异常/caught reentry
   sticky，任何 closed/retiring/released/换 map/换 completed/history/proof/源字段拒绝。
5. Projection `registerHistorical(messages, proof, historicalTarget?)` 仅新增第三个
   opaque token 分支；普通两参数的 store/target exact 合同保持。第三参数不能是
   public ref 或 caller assert 函数。新分支只从上述 reader 取得 T1；原 checkpoint
   recovery/member read 始终用 T1+原 proof。
   所有原 full guards、完整 ordinal/nativeSnapshotDigest/row/native/receipt/member
   检查保留；prepareEntry/23/presentation/ledger Scope 始终针对当前 owner T2。它
   只消费实际 completion 地址关系，不因为 reader 成功而授权未知 message 或 ACK。
6. Host/Shared admission 用原 Producer bound history 的 token 进入这条分支；最终返回依旧
   全组分类与 copy，再 history/view FULL，再原 Host.values 一次全 batch 23/ledger
   A/B，之后仅所有原数据尾。原 proof 不改 target、不刷新 snapshot、不延长已删
   NativeRead；不会再读最终 output 来建立历史基线。

原实际 interrupt/resume 正向和完整 CP4/两个 canonical member/23/UI 断言不改。新增
真实 producer T1/T2 私地址不同正向、同 ref clone T2/foreign real history/另 registration
阴性，以及最后原 history guard 改 member/raw/ledger 阴性；不得以假 tuple 或弱化
membership 代替它们。此增量待 Root/独立第二设计票后实现，当前实际首红日志保留。

### 原检查点物理位置的精确补充

真实 Shared interrupt/resume 的下一首红发生在原 Store recovery receipt 查找：T1 地址
已经正确，但原 Projection 使用了当前 UI destination incarnation。实际 checkpoint
属于父物理线程，不能从 UI ref 或 ID 推测这个位置，也不能改 receipt/member 门。

prepareRestore 第一次实际恢复读取前把 authority.threadId、原 checkpointIncarnation
的完整 frozen 两字段副本、原 tuple.checkpoint.id 与真实 read.namespace 固定为 private
checkpointPoint。原 recovery snapshot 与 captureConversationCheckpointRead 的 admission
始终使用这个同一 point，成功 proof 的 thread/incarnationKey/id/namespace 必须完整等于
point；incarnationKey 保原 Store 的 token/legacy 语义。成功 Restore 私 record 保存该
point，history 全检查每次 fresh recovery/member snapshot 仍核同一 point；data 尾核私
record 地址、tuple checkpoint id own descriptor/flags、原字段与 namespace，不能刷新。

真实 complete 的 target bridge 仅从上述 Restore 私 record 转运 readonly point。reader
先 exact token/messages/proof/store/T2 与原生命周期 data gate，才返回 T1 与固定 point；
无 public point/register/caller inspector。Projection 只有第三 opaque 分支的 recovery
读取选择这个原物理 point，并严格比对本次真实 membership snapshot。所有 member/raw
恢复仍为原 T1/proof，prepareEntry/当前 owner/23/presentation/ledger 仍为实际 T2。
旧两参数路径继续使用其原 runtime destination 位置。所有 FULL、完整 ordinal/native
digest/count/cut/member 门、B 后纯尾与原 27 个真实 fixture 保留。Root DESIGN1 与独立
Official DESIGN2 已通过该补充；实现和实际门分别记录，不以位置修复宣称性能通过。

### 实际 SDK 缓存恢复与新 Command 对照

Root 的物理 point 修复后 focused 历史门不再报 receipt/member 错误，但第二次父节点
重新执行的普通 child input 被真实 SDK 当成已完成 checkpoint 的恢复，provider 仍为
1；原 provider2、CP4/member2/UI2 断言保留，不把它降成缓存重放测试。

新 `native-shared-history-sdk-reference.test.ts` 两个未包装 SDK 对照已由 Root 在原
5 秒门实际全过：同一父 task/namespace 的 ordinary replay 不再运行 provider，原完整
Human/AI codec 不变；第二次首 child entry 使用真正 Command.update 新增 Human 并
goto model_request 时，provider2 与完整四个 native messages 成立。未修改 resuming、
checkpoint namespace、scratchpad 或模型计数，原 finally 全观察。

据此原 Shared27 唯一历史 case/helper 只增加精确 Command input union，并在第二次
首 child entry 传相同真实 Command。首次输入及其余 26 例不变，provider2、runtime2、
同 conversation/namespace、CP4/member2/UI2、原历史全 codec/native23、effect0、
default5 和全部 cleanup 断言仍保留。该 fixture 已获两设计票与独立源码票，待 Root
实际 Shared 历史门；SDK 对照通过不代这个实际生产路径通过。

### Command 输入保留 caller 原基线的私有 root 副本

真实 Command.update 历史门的下一首异常是输入容器变更，不是 member/source 放宽需求。
安装库的 CompiledStateGraph._validateInput（graph/state.js 516、524、542）对 Command
采用 parsedInput=input，再把 validated/interopParse 的结果赋给 parsedInput.update。
这是实际 SDK 的合法原地替换，原 Shared wrapper 在没有私 channel 时把 caller 原
Command 直接传入，因此首 descriptor baseline 正确拒绝了后来不同 update 地址。

最窄增量只在已确定 native Scope 的 withoutNativeConversationChannel Command 分支：
无论是否剥 channel，都由已检查的全部 own data descriptors 构造同 Command.prototype
的 module-local root 副本；不调用 Command 构造器、SDK isCommand、用户 getter 或
toJSON。原 goto/resume/graph/control 值、flags、原消息地址和 update 内容全保，只有
实际私 channel 剥离仍使用原分支的私 update 副本。实际 CommandInstance 构造器把原
args 保存于 Symbol.for("langgraph.command")；已有同 symbol own-data/args.update
身份检查及只剥 channel 的私 args 副本继续保留，不改成另一猜测字段。

SDK 只获得这个 root 副本，可在其原验证点替换副本 update；caller 原 Command、原
update、dense pairs/messages 和所有实际 BaseMessage 仍使用首捕获的完整 strict
baseline。原 reducer 的唯双 ID 赋值兼容不扩大，不按 SDK 替换后的对象补晚来源、不
刷新 caller 基线。无 native Scope 的 generic 路径及其 identity 继续原样。

必须保留真 Command.update 历史门 provider2/CP4/member2/UI2/default5，并加真实早
captureScope 对原 Command.update/body/container 的改变仍在 provider0 拒绝；未知
caller getter/Proxy 不会因为私副本获得来源。这个修复不认证任意新 unmarked 消息，
最终仍全消息分类、完整复制、Host 一批 FULL/23/ledger A-B 后全部原数据纯尾。

该一处产源与 Shared29 的 caller 原 descriptors / Symbol args 断言、首 capture 改原
update/goto 的两项 provider0 回归已获 Root 与 Official 独立 scoped SOURCE 票。
Root focused 实际为 2 PASS / 1 RED：新两项原输入反例通过；原完整历史正向不再报
SOURCE_INVALID，但仍超过 unchanged 默认 5 秒（约 9.378 秒）。日志为
`output/stage23-shared-command-private-root-current.log`。这是实际未完成门，不能以
SDK golden2、源码票或异常消失把完整 Shared 历史正向写成通过。
