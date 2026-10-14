# Shared streaming：按用户能力接通

状态：Root 原则通过，Legacy 与 Official 最终限定 DESIGN2 通过；实现等待 Root
解除 Electron 快照冻结。未修改 App/Scope/Host 或 SDK。SDK29 已正常
安装，首轮113为107PASS/6新fixture RED，唯一新test修后24实际PASS；原另外89已PASS。
不以此证明 Shared 已有输出。

## 现在实际缺什么

`mods-conversation-shared-invocation.ts` 的 native proxy只包装 invoke。stream 与
streamEvents只是绑定原 SDK 方法；安装后的 getState adapter却需要本次 State pending，
因此它们不能直接作为实际 native Shared 公共入口。State 的已测两 foundation 在
dispatch/iterator明确抛 PREFLIGHT_ONLY/ITERATOR_ONLY，尚未进入实际 getTuple/model。

已有 invoke路径已经完成真正 Scope→Saver查询→Host admission→Domain ready、模型与
工具 Node保护、完整返回/历史认证、host/node drain，以及 parent authority/lease/epoch/
signal清理。下一窗复用这条实际业务路线，不再新增逐层内部同构、Producer-local数据
体系、Main completion三私表或为了模拟另一框架而扩 SDK。

## 最小用户路线

新增 native Shared stream包装，与 invoke共享 input捕获、原config.resolve、清除内部
conversation channel、实际capture Scope和runSharedNativeFactoryDomain。config允许原
SDK合法 modes，所有输入/历史/取消门继续执行；未知 factory和普通caller保原分支。

通过已有 State installer/SDK operation执行真正原 agent.stream。新增明确 stream运行
模式保留已有两 foundation的停止行为；实际stream模式通过当前opening检查后继续
原SDK，不把其 shell或 SDK receipt叫业务ready。getState使用已有完整preflight；真正
getTuple仍经原 Scope validate/Saver/NativeRead/Host admission，成功后才有Domain view。
旧安全守卫、SQL/成员/目标/权限和原 admission失败清理不删，不从外部参数选目标。

运行生命周期由一个 Main-owned driver持有。它在原Scope run callback内调用SDK并
消费同一个实际iterator，以单个待处理 demand传递 next/return/throw；原Scope ticket
保持至这个callback的真正 finally，而不是返回shell就清理。SDK原预取保留，不宣称
一帧等于一次模型调用；driver自身不重复next、不引入无界队列。caller拿到的是真正
可取消的IterableReadableStream。consumer不再拉取时，owner abort仍唤醒driver并推进
原return/throw到done，不能靠public reader返回或一个Promise shell认定drained。

SDK原 getTuple完成的业务回调已负责 publish Domain view。driver输出每帧前从现有
private Domain取 view，执行原 view/runtime/Host守卫；没有view或已经closing就拒。
provider和tool仍经已安装的实际Node/Tools middleware。首帧不能反推模型执行许可；
这些许可依原Scope/Node调用点在模型之前认证。生命周期observer使用其既有安装和
已有Main-ownedguard，不向调用者注册额外Source/ready资格。

## 帧和事件

values/updates按现有native frame routing保全部结构和消息；调用现Host.validate，
必要完整message副本复用invoke的prepareNativeConversationReturn。每帧不据UUID、
providerId或显示戳生成canonical资格。历史message沿原history source/member路径。

messages复用已有Calls/Attempt/livePartial、Host.message及Node完成替换投影，完整
message chunk不截断。现有Lifetime已可观察updates里的真正完成消息，保原消息顺序与
去重、受保护partial的OMIT行为。不要为复刻内部来源另建partial协议；若当前Shared
安装确缺一个实际Host/Calls连接，真实测试定位后只补那个业务连接。

streamEvents使用原SDK v2 event迭代器及既有callbacks。事件是经保护的数据输出，
不因event格式生成ToolReturn/消息/文件权。消息字段走上述真实Host投影；其它payload
使用现Function输出保护与预算。原SDK已格式化的tool error可以作为显示事实，不能
把它重新声称为Core原始错误或成功/失败的工具结算资格。若EventsV2要求原rawreason，
只消费已存在的真实selected-invoke outcome，不能从callback error或公共event重建。
因此Core rawerror callback的研究不阻塞普通SDK事件能力，也不扩大该未完成来源票。

SSE可复用原encoder和diagnostic流程；第一窗先完整typed frames，SSE另做原预算与
保护回归。不能把现SSE诊断token当Shared运行授权。明确不限制完整正文/完整chunk。

## 最少文件与验收

候选四处：SharedInvocation native stream入口、State真实stream mode、新
`function-conversation-shared-native-stream-driver.ts`、Lifetime既有installation复用
接点。Scope/Domain/Host/Nodes/Tools/SDK先保原生产；若真实业务连接需小修，再列精确
必要hunk做两审。原NativeInvocation不顺便重写，pure frame算法可局部复用。

不以大型新的私来源测试阵列为前置。必要门是：真正Manager/父子Scope/SqlJsSaver，
一次共享子任务完整values+updates；真实2chunk messages及tool response；SDK events
顺序和完整保护payload；caller cancel、owner close、early return时真实provider/tool/
iterator finally全结算；interrupt/resume与完整历史/CP/member/UI/双ID；撤权与文件
权限/坏输入仍原严格拒绝。原invoke、Scope、SDK、Node、Tools回归保留。

真实Electron用原批准Mod/共享子任务入口消费数据，完整HTTP请求、DB行、CP、终态
done/error与Echo零冲突；需要实际consumer把stream完整留在withSharedAgent.run内。
不能让callback仅返回未消费iterable而触发Manager原finally提前关闭Owner。先测试
现有消费者，再只为此能力补必要入口，不扩大其它项目模式或绕过审批/权限。

## 两条真实 SDK 路线和 driver 胶合

已读当前真实SDK：ReactAgent.stream 1037执行defaults＋middleware初始化，实际到
graph.getState和graph.stream；ReactAgent.streamEvents 1090只mergeDefaults，再到
真实私graph.streamEvents，**不调用前一方法和middleware预初始化**。后者 Core
Runnable._streamEventsV2先建立EventStreamCallbackHandler、启动后台
consumeRunnableStream，再在消费finally abort并await同后台Promise。其内部
outerThis.stream的this是真compiled graph，并不是Shared agent proxy。

typed stream使用State现native operation路径，新模式继续原dispatch/iterator而不抛
foundation stop。events使用真实Agent.streamEvents原函数和原target receiver，在
同次Scope.run/Domain/Lifetime里执行；**不登记State native-stream pending、不造
Agent.stream operation**。现State无boundary的ordinary路径保留；若SDK实际调用
getState，它仍由原captureScope.preflight完整执行。原Lifecycle observer只见真实
graph.stream/_streamIterator，State无本次pending时保原delegate，不重复包装Shared
proxy。因此Scope只run一次、factory不重新派生、模型/工具不为事件多跑一次。

### opening 与 ready

driver创建时就读现Scope OpeningCurrent并固定其两个guard、原调用signal和Scope
controllerSignal。Lifetime guard在未接纳时调用opening.assertCurrent并检查调用
cancel signal；不读取不存在的view，不授消息资格。原getTuple/admit末已经具备
真实Domain view，经过原Host/Tools最后guard后，SharedInvocation在该函数返回前
通知本domain的driver。之后guard执行同opening及view.assertCurrent/assertDataCurrent；
关闭/失败不能再退回opening。节点和工具本身的原ready守卫始终保留。

这只是一个本次运行的ready deferred，用于业务等待，不是新的Source/opaque权限
框架。新driver内部以实际domain对象找自己的运行；SharedInvocation末调用内部
`notifySharedNativeStreamAdmission(domain)`，函数自行读该domain现有实际view，不接
外部view、权限flag或reader注册。没有driver的原invoke完全不受影响。

### Events prelude 的有界保序策略

原Pregel handleChainStart在getTuple之前，且EventStreamCallbackHandler.send会await
TransformStream writer.write。**不能收到第一个event后停止SDK消费并等待ready**：
其它前置callback可能被write背压堵住，连真正getTuple都到不了。

events driver在尚未ready时继续实际eventIterator.next，并保存完整前置events，最多
256项和原保护数据预算1MiB；不公开原input，不剪短消息或正文。达到边界即明确失败、
abort并实际drain，不能丢旧event继续读取求成功。每次只有一个未结算的SDK next。
ready deferred与当前next并行观察：ready先完成就可保护并按原顺序发布已有prelude；
不需要等模型吐下一条event，也不会为first frame反推运行权。下一条SDKnext原Promise
继续被持有，不重复发起。ready前如果真正初始化失败/stream结束，就原reason拒绝，
不造ready；read/ownerabort和本次finally都唤醒等待方。

ready后prelude的data.input按原已捕input/历史来源及同Host保护规则处理，其它字段只
做原Function输出保护；新模型chunks随后仍Host.message/validate。前置event不能
通过显示ID/名称产生canonical、ToolReturn或文件权。过滤选项沿原SDK执行，无过滤
事件时ready由实际admit通知，不能依赖看到on_chain_start。

### 实际接口及取消

新Main-owned driver的候选内部签名（不作为Guest能力导出）：

```ts
startSharedNativeStreamDriver({
  factory, domain, scope, opening, input, config, mode, start
}): Promise<IterableReadableStream<unknown>>

// start仅为本次原SDK executor；不是guard/资格注册。
// stream用State新实际模式，events用固定原Agent.streamEvents/原target。
// driver自己读取actualdomain view、持有Lifetime并调用原Host路由。
notifySharedNativeStreamAdmission(domain: SharedNativeDomainRecord): void
```

SharedInvocation在现runSharedNativeFactoryDomain里创建driver，并让整
scope.run callback执行到driver内部completion Promise真正完成；对typed路线使用
**原 public `scope.run`**，不使用只允许预飞初态的
`runFunctionConversationSharedCheckpointPreflightOperation`。真实 getTuple 合法设置
`initializing` 和 `binding`，它们不会继续等于该预飞执行器捕获的 undefined；完整
流不能沿用它的末尾初态断言。State 新实际模式在该 scope.run 内登记 typed pending
并执行原 SDK operation；preflight receipt 只在 getTuple/admit 前检查预飞结果，
接纳后持续 guard 使用 opening 与实际 Domain view。旧 PREFLIGHT_ONLY、ITERATOR_ONLY
两 foundation 继续使用原预飞执行器、原停止点及原全部断言。callback内部调用start、
收到实际SDKshell、在同ALS
上下文驱动SDKiterator，把opened deferred交公共调用者。不能以返回shell作为该
callback返回。一个demand对应driver的一次推进，完整帧通过现Host校验后才resolve。

signal使用原caller/owner signal、Scope controller signal和driver cut的正常组合；
return、ownerabort、错误都先abort cut并唤醒等待。typed路线复用原Lifetime.drain和
实际return→next至done。events取消后继续同eventIterator消费并丢弃未发布data，
让SDK callback writer不被停止消费堵住；不在仍有待写event时盲目return并等待其
后台consumePromise。真实SDKevent finally及后台consume完成后，再做原Lifetime/
Host/Node drain、Scope.close/whenDrained、Domain closed/failed。取消后的消费只
是清理，不运行发布/新增模型或工具；原signal和Node/Tools守卫持续拒绝新工作。

公共return/throw等待同completion，不吞undefined错误，也不以超时shell宣称物理
结算。关闭可重复但共享一次closing Promise。Owner close发生在opening、等待ready、
idle demand、held provider/tool四处都必须真测；不增加预算或强制多开operation。
上述events等待/取消策略必须由真实SDK/实际Shared HTTP回归确认，不凭静态时序称绿。

公共 API 保持 SDK 签名：typed `stream` 返回 Promise，`streamEvents` 同步返回
IterableReadableStream，可直接 for-await。后者 lazy shell 首次 pull 才打开本次
Scope/driver，不能把该方法写成 async。未发生首次 pull 的 return 直接关闭 opening，
不启动 provider/SDK operation，也不等待不存在的 demand；打开中的 abort 唤醒等待并
等待同 completion。已打开后的 return/throw 仍推进原 iterator/background finally。
真实测试覆盖直接 for-await、无 pull 即 return、打开中 held abort；不新增来源资格。

## 首实现冻结清单

实际只需要三个生产文件：SharedInvocation 新 native stream/events 分支与原 admission
末通知；State 新完整 streaming 模式，保旧两 stop foundation；NEW Main driver。
Lifetime 现有 installation、source.run、completion routing、drain 直接复用，无须为了
文件数修改它。Scope、Domain、Host、Node、Tools、SDK29 都未改。

NEW `native-shared-stream.integration.test.ts` 有 9 个真实定义：typed 非法 input 返回
Promise 拒绝且 own getter0；HTTP tool 的完整
values/updates/CP/member/23；原两 HTTP partial 与完整完成值；直接 events 及保护后的
prelude；没有任何匹配事件的过滤；held provider 下 early return；caller abort；
first pull 前 return；实际 drain 委托完成后拒绝 undefined 的原错误保留。只最后一个
在本仓 Lifetime 创建函数上委托原函数并注入 cleanup 故障，不造 Scope/Owner/权限。
夹具资源先登记 cleanup，递归删 own mkdtemp 目录前验证绝对边界，独立结算全部清理。

清理将本次明确 cut reason/cause 的取消与未知失败分开；原 iterator、drain、whenSettled
未知拒绝不因 caller return 被吞，特别包括 undefined。待两个独立 Source 审核及 Root
单 CPU 实际执行；当前不宣称 stream 能力已通过运行验证。

## 首次运行后的小兼容叶：withConfig 默认流模式

当前真实 ReactAgent.withConfig（709–710）以 mergeConfigs 合并 private defaults，
stream（1037–1045）再次合并该 defaults，因此实际支持默认 streamMode。当前 native
derive 的旧 invoke validator 只允许字符串 values，导致合法
withConfig({streamMode:"messages"}).stream 写法提前拒绝；直接 stream 参数已接通。

Root 限定 DESIGN1 候选：derive 只将 streamMode 放宽至 values/updates/messages 或
非空 dense 合法数组，descriptor/Proxy/data 门照旧，subgraphs/encoding 旧限制不变。
invoke 调用点继续原 strict values validator，不让流配置变成 invoke 返回资格。
原 derived-config 第827负例的 messages 标签实际上是 ["values"]，它应转为合法
derive 后实际 invoke 仍精确拒绝、provider0/runtime0，再保原 base invoke 成功。
另加真正 HTTP 默认 messages 流及显式 values 覆盖对照，保完整 CP/member/23，
不改 SDK/权限/Scope。此小叶待 Legacy/Official DESIGN2，且首次9实际结束后才落。

上述小叶已取得 Root/Legacy/Official 限定设计票，并在 Root 释放的独立窗口实施：
derive 增加流 defaults validator，actual invoke 的 strict values validator 保持原样。
原 array values 负例改为合法 derive 后真正 invoke 拒绝，原 override 拒绝、provider0、
runtime0 与 base 成功都保留。新增一个 it.each 的两个真实 HTTP entry，分别默认
messages（call 不传 mode）和显式字符串 values 覆盖；每 entry 只有一次真实运行，
保原五秒预算与完整 CP/member/23/drain。原9定义未删，现在11个展开定义，待本次
独立源码票与 Root 实际运行；没有 SDK、Scope 或权限修改。

## 首次实际取消失败的信号修复

首轮 new9+old54 是60通过、3失败，旧54全部通过；两个 held 测试保原5秒门均超时。
固定阶段诊断确认约300–450ms已取得首帧，return 开始后原provider直到超时夹具清理
release才结束，不能把它归为 opening 或首帧性能。

真实 PregelRunner._initializeAbortSignals 先取父 task configurable 的
__pregel_abort_signals.externalAbortSignal，只有缺省才取顶层 signal。Shared 沿原父
task复制该 marker，而新driver只组合顶层signal，因此模型节点继续使用父取消信号。
仅本次stream/events attach复制实际own-data marker，将 externalAbortSignal 组合
原external与本次driver完整signal；原timeout/composed/其它字段与flags保留，父marker
的地址、keys、值和flags不改。无marker或nullish值沿SDK旧路，不创造新marker。
Task、namespace、checkpoint_map、Scope、SDK与所有权限检查都不改。

Root DESIGN1与Official DESIGN2通过后，仅driver attach这一叶落源；原两held夹具
增加父marker完整不变断言，仍要求真实provider finally、无canonical写入、undefined
cleanup原值拒绝与完整drain，5秒不改。此前失败日志保留，待实际复验。

取消叶首次实际已使两held return约278–308ms完成；对端HTTP finally在281–354ms
才收到关闭。该网络事件不应被要求先于本地SDK return同步完成。Root与Official限定
两票将严格finished1移到execute后原assertDrained已await所有真实HTTP handler的接点，
不主动release、不sleep、不造ACK；原本地Scope/Lifetime真正finally仍在return内等待。
Tool测试仍超时，实际第一model/tool Host完成耗时约7.5/5.8秒，尚未进入verifySaved，
需继续原5秒功能/性能收口，不能将更长诊断当验收。

### 工具诊断之后的性能候选（仅设计，未授权落源）

Root显式30秒诊断下完整工具/CP/member/23断言通过，耗时19.227秒，不是原5秒验收。
采样热点是NativeSQLite包装、Destination fresh JOIN和Shared Source线程读；帧复制的
连续步骤约65ms，不为修性能删除输出检查。

最小第一候选是SharedSourceCurrent、ChildFamily的shared守卫与Coordinator几个纯身份
读：其getThreadCore返回只使用created_at和完整metadata，可沿现有
readFunctionConversationThreadIdentityCurrent读取这两列。每个原接点仍执行真实SQL，
原callback/租约/authority/namespace检查顺序保；公共getThreadCore六列不改，缓存仅
statement。需要测试保持外writer修改、重入、关闭与异常清缓存，不按当前行值跳过检查。

Destination仍要核原mapping的每个字段、四个thread alias的实际值与两个ref。不得仅凭
四个threadId相等合并SQL alias数据，因为表达式或TEMP VIEW可使同id产生不同alias值。
其parent_ref.invocation_id当前未被消费，可单独评估去掉该未用列；四thread原值保。
另一个需单独两审的SQL候选是把m.*改为capture时的mappingKeys逐列安全quoted投影，
保每个原mapping字段。晚新增字段不进入结果时无需每次pragma做新增alias碰撞检查，
但这会改变旧late-ADD/pragma-shadow测试合同，不能直接借原40测试票实施。

token解释的另一小候选：Destination的固定incarnation副本没有服务私有rawMetadata解释
记录，同一fresh JOIN每次重复解析metadata。只能在某alias首次已经与原incarnation匹配
后捕获等值incarnation，以服务现有的“相同原始文本解释”机制比较之后每次fresh row；
metadata改变仍解析新文本。不得缓存行、匹配结果或权限。这些候选均须独立设计/源审
与原5秒重新运行；当前没有性能通过结论。
