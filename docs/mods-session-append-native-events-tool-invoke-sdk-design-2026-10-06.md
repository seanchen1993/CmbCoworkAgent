# EventsV2 selected invoke 的版本锁 SDK 基础窗

日期：2026-10-06。SDK 基础窗已按两人设计和源码评审实现；实际生成、安装及回归由
Root 单独执行，本文 owner 没有运行 CPU。既有七目标补丁保留，新增九目标作为 overlay。
本窗不开放 App Source、Events 帧、ToolReturn、ACK、23/ledger 或 Shared stream。
它接续 `mods-session-append-native-events-v2-design-2026-10-06.md` 的 selected invoke 节。

## 实际构造与原调用顺序

实际版本为 langchain 1.2.37、Core 1.1.36。agents/index.js 的 createAgent 只有
`new ReactAgent(params)`。ReactAgent 的 middlewareTools/filter/flatMap 和
`toolClasses = [...options.tools ?? [], ...middlewareTools]` 只拼接原工具地址。
两处 `toolClasses.filter(isClientTool)` 分别用于 returnDirect 和 clientTools；
isClientTool 只委托 Runnable.isRunnable。clientTools 原数组直接交给
`new ToolNode(clientTools, { signal, wrapToolCall: wrapToolCall(middleware) })`。
这里没有 tool clone/schema转换，不能登记不存在的“转换关系”。原 filter、name、
returnDirect、middleware/schema 求值次数与时机不改，不新增 isClientTool 探测。

ToolNode constructor 保存同 tools 数组；RunnableCallable 保存
`func: (state, config) => this.run(state, config)`。run 的 Send/并行分支仍动态调用
this.runTool，本窗不认证完整 RunnableCallable.invoke/run 调度。基础 golden 直接
执行 SDK 私表选定的原 runTool。后继 Event driver 必须另接实际 runTool 入口；不能
从已经运行的 wrapToolCall 里重新执行 runTool 补来源、重复工具效果。

runTool 构造 runtime、查 registeredTool、创建 baseHandler。每次 baseHandler 又按
request.tool 或原 find 选择 invokableTool。原表达式的 `.invoke` 成员求值先于两个
参数；configExpression 内的 mergeAbortSignals 仍先于真正 invoke。native 分支在
原成员位置选择早固定的 fn，再同序各构造一次原 input/config，纯核已固定关系后
Reflect.apply 原 fn、原 tool receiver 一次。参数构造失败没有 invoke outcome。

原 await 后才做 ToolMessage.isInstance/isCommand/JSON.stringify；失败后才包装
ToolInputParsingException，外层才调用私 #handleError。结算小块放在这些原 parser/
handler 之前，保所有 catch 与 middleware error 包装。utils.wrapToolCall 原先会复制
request、合并 state、解析 schema并传 wrappedInnerHandler。App 当前 request/handler
并非原 baseHandler 地址，本窗不以 shape/name猜运输关系，后继 request-only另接。

Core StructuredTool.invoke 仍 ensureConfig/mergeConfigs→动态 this.call；call 仍 schema
parse→CallbackManager/ToolStart→this._call/生成器→ToolError→格式化/ToolEnd。本票只
证明声明原 invoke 被执行，不封 call/_call/schema/func/Core dispatch。Runtime 合法
wrapToolErrors own invoke 可声明；wrapper返回字符串时 outcome如实 fulfilled。

## Producer API 与真正私关系

新增 `langchain/native-tool-invoke-origin` 子路径；下面品牌均为 SDK 自产空 frozen
opaque token。reader 只查本模块私 WM，不接受 inspector、predicate 或注册 callback。

```ts
createNativeToolInvokeAgent: typeof createAgent
createNativeToolInvokeOperation(actualAgent: object, rawCall: ToolCall,
  actualConfig: RunnableConfig, actualState: unknown): NativeToolInvokeOperation
executeNativeToolInvokeOperation(operation: NativeToolInvokeOperation): Promise<unknown>
readNativeToolInvokeSelections(operation: NativeToolInvokeOperation):
  readonly NativeToolInvokeSelection[]
readNativeToolInvokeSelection(selection: NativeToolInvokeSelection,
  operation: NativeToolInvokeOperation): NativeToolInvokeSelectionFacts | undefined
readNativeToolInvokeOutcome(outcome: NativeToolInvokeOutcome,
  selection: NativeToolInvokeSelection, operation: NativeToolInvokeOperation):
  Readonly<{ status: "fulfilled"; value: unknown } |
    { status: "rejected"; reason: unknown }> | undefined
closeAndDrainNativeToolInvokeOperation(operation: NativeToolInvokeOperation): Promise<void>
```

这里替代前稿的 public actualToolNode 参数：SDK 从 AgentInstance 私表选其真正 node，
caller 不能从 graph.nodes/名字/当前 public 方法补来源。SelectionFacts 固定实际 tool/
fn/receiver、原 request/toolCall、SDK 当次新建 input/config 地址、序号/status/outcome。
它不声称 nested args/config/state 全部不可变；App 后继仍须原 Tools complete捕获及
full/data门。unknown/clone/foreign token reader先WM exact，0 property/Proxy traps。

controlled factory 在原 constructor 之前自产 ConstructionRequest，descriptor-only
固定本次 options.tools 与 middleware.tools 的原容器/dense own成员顺序、各声明 tool
的 invoke own/inherited完整path/flags/fn/receiver。没有晚 fn 基准刷新。accessor invoke
不读 getter、不声明；普通 createAgent不走新更严格捕获，原输入行为不变。Caller 可以
声明自己的工具，但这只是 SDK 输入来源，不能由这个 factory 获得任何 App authority。

请求作为 SDK 内部第三个词法 constructor 参数传给真正 ReactAgent，只私 WM mint
的同 request/options/executing 可 consume；不放 options/config/ALS/first-call槽。
constructor 的 StateManager Map field initializer早于首body，故不能让同 options 的
嵌套构造抢first-call。外部普通两参数 constructor/withConfig 没有此请求。constructing/
used 在调用前占用，失败sticky，首bodyconsume后局部持request，不从晚 callback取回。

原真实 middlewareTools/toolClasses/clientTools 生成后，仅登记其实际地址关系；每个
clientTool须是首声明 exact成员，原invoke path/flags仍相同。不调用额外 name/classifier。
真正 ToolNode构造成功后，SDK自产 NodeConstruction 把 actualAgent/node/clientTools/
declarations与class/module evaluation固定的原 runTool联系；graph.compile成功及原
声明复核后才publish AgentInstance，失败不留可消费半构造来源。私Node helper仅由
ReactAgent原词法创建点调用，无 public register(fn, inspector)。

首基础窗不自动认证普通 withConfig 的 child。后继若需 controlledderive，另以parent
私声明→原merge→私constructionRequest→真正newchild接线，不借parenttoken认证child。
当前无私表child明确未适配；不能在构造后读child.invoke来恢复来源。

### CJS 两种模块加载顺序

ReactAgent 与 ToolNode 的互读仅固定两个/八个 SDK 自产原函数。CJS 在 require 对方
之前先将 hoisted free 函数定义为不可写、不可配置的 export data；消费者在模块求值
期间固定这些函数地址。ESM 使用原 import binding。两边自己的 initialized 数据位
只在原 class 定义及原方法/constructor 固定后置 true；部分加载的 create/execute 必须
明确拒，reader 不从 undefined namespace 建基准。ToolNode-first 顺序中 ReactAgent
不能提前读取未完成的公开 ToolNode class；它捕原 constructNativeToolNode free 函数，
真正该函数执行时仅 new Node 模块自己已固定的 constructor。没有晚 namespace 查找、
public callback/inspector 登记或 caller 提供 constructor。普通构造仍走原分支。

### 两补丁的完整组合校验

新九目标的 ReactAgent 两文件与 package.json 覆盖旧七目标中的三文件，union 是
十三文件。新 overlay 的 before 就是已验旧 foundation 完整 after；不得让旧 checker
因单个新 hash 忽略其余文件。新独立 readonly union verifier 必须校验旧 manifest/
patch/两 template、新 manifest/patch/三 template、version/MIT、旧非重叠四文件与
新九目标的全部 exact postimage。overlay artifact 存在时，旧 installer 必须在旧七
installed fastreturn 之前先完整分类：pristine 是旧七 before 加非重叠六 before；
base 是旧七 after 加新九 before；overlay 是十三 after。不能让旧七尚未变化但新
ToolNode 单文件已变化的半应用通过。readStreamBase 同样先证明完整 base/overlay，
任何混合或未知 bytes 都在写前/fixture 返回前明确拒；artifact 不存在才保旧七原路。

新组合入口顺序为 base install → overlay install → full union check。overlay 安装
在任何目标写入前验证旧完整七文件、九个 before 和所有 artifact，stage 九个输出；
失败仅回滚还保持本次 exact postimage 的目标到原 base bytes，其他写入不被覆写。
predev/prebuild/postinstall 需统一接该组合入口，原 native rebuild 次序保持。

旧 stream installation 四个 fixture 当前从 node_modules 读取七 after，再 reverse
旧 patch。组合安装后须先证明实际完整 union13，再 exact reverse 新 overlay 恢复
九 before（旧 base 三文件、官方 Node 两文件、四新增文件为缺失），严格验证旧七
after，才执行其原 pristine fixture/reverse及所有字节/EOF/rollback断言。旧四 fixture
还须保存已核官方 Node 两 before，供十三文件 pristine 分类；原七项断言不删。
旧 SDK 十个运行 golden 一项不删。此夹具只恢复已核代码 bytes，
不执行 runtime 或获得来源权限。

Operation 保存原call/config/state地址、agent/node/声明refs，new→executing→entered→
settled，同operation重入/重复sticky。原 ToolNode.runTool 在class定义完成、任何未知
constructor前固定。executor在Reflect.apply原runTool之前自产独立outerStartingTicket
与pending deferred并登记；runTool首consume后的runtime/config getter、tools.find/name
均可能在原async函数尚未返回outerPromise时重入close，这个外票保证drain不能提前
把缺Promise/零handler票当terminal。拿到真实outerPromise后固定intrinsic观察其真正
settlement与finally才退票；同步调用失败也保原reason与真实finally，不用phase推断。
executor Reflect.apply原fn/node/三参数一次；同步私request keyed
actualnode，runTool首词法语句exact node/call/config/state/executing后consume/delete，
baseHandler闭住原局部operation。没有request的普通runTool原分支完全不变。

## 每次 selection、严格 await 与实际 drain

每次baseHandler在原selection/任何request getter等未知代码之前，先自产独立
StartingTicket和pending deferred并登记真实工作占用，再原selection。同步invoke内
重入close也必须看见此票；只有原handler真实finally及settlement后才retire。retry/parallel
两次实际handler各有token与进入序号，不当同selection重入。missing graceful ToolMessage、
middleware short-circuit、参数构造失败均不伪invoke。dynamicoverride无首声明记录时native
未适配且0invoke，ordinary仍原行为；选另一真实静态成员按地址认证，不按同名补关系。

selected fn在原成员求值位置选择、原两参数完成后复核，再占invoking；tight try/await/
catch仅包实际Reflect.apply原invoke。原await后自产一次outcome，独立status保存value或
reason含undefined/null，绝不读message/stack/toString。rejected随后throw同reason给原
parser/#handleError，后续parser/handler异常不覆盖该结算。thenable只由原await消费一次，
不能另读.then推断settlement。原fn已开始后真实value/reason不因后来的公开End/Error补登记。

native baseHandler wrapper只Reflect.apply当次自造原handler同this/args一次，返回并
保存那个真正Promise；generic保原handler。StartingTicket在handler同步未知invoke前
已经登记，completion仅当真正handlerPromise settle且原finally退出后解除，不能在
尚未拿到返回Promise的同步重入缝让drain看到零任务。SDK保留实际Promise引用，用固定
Promise/Set intrinsics观察，不将selected返回值或outer成功当callback/资源终态。

outerrunTool已settle但unawaitedhandler仍占pending。close先封newselection，再观察
outerPromise和每个真正handler，含undefined的失败亦保留。SDK不新造signal/listener，
不称工具返回代表后台资源terminal；App后继仍须真实Work/Host原finally/资源来源。
nativeclosing后拒新handler是明确受控行为，需golden，不声称普通无限迟来middleware
完全透明。Core主动public ToolError或生成器callbackerror仍独立未认证。

## 版本锁和唯一补丁范围

新增第二份additive patch/manifest/template/installer，依赖已验官方1.2.37 tarball/SRI/
MIT及现stream foundation精确postimages，不重写既有七target patch，不把node_modules
当唯一交付。当前stream patch SHA为
`0155242ca1c6b44e793f19c86f1e71cb56c43156ccda05dcac733e1a481378f7`。

候选只九targets：ReactAgent.js/.cjs构造词法追加；nodes/ToolNode.js/.cjs原class-final
method捕获/constructor私记录/runTool首consume/baseHandler选定及await小块；package.json
subpath；新native-tool-invoke-origin.js/.cjs/.d.ts/.d.cts四入口。不改普通index/createAgent
正文、utils.wrapToolCall、RunnableCallable、Core/LangGraph/AgentNode或已落stream执行算法。

manifest逐文件原始bytes before/after SHA。ReactAgent/package before须等现stream批准
after；ToolNode before从同官方tarball实际提取验证，不能用late当前文件SHA冒官方原件。
Root soleCPU提取/生成/安装校验，本稿不编造新hash。ESM/CJS私品牌互不借用；安装器先
全旧七＋新九target/templates校验后stage，保EOF/no-LF原始bytes，失败仅回滚exact自己的
postimage。package普通/browser路径不新引Node-only依赖。

SDK声明捕获并非App对Proxy的品牌认证，不能宣称任意toolProxy的descriptortrap为零。
真正Node App后继在constructor前还须原types.isProxy准入；空opaque reader自己只WM，
unknown/Proxytoken仍0traps。这项边界不得写成整SDK/tool对象纯尾已关闭。

## 无权限 SDK golden 与未闭合项

普通/controlledreference严格比完整ToolMessage.toDict、returnvalue或reasonidentity、
callback全顺序/次数、actualeffect、原fn/this/真正input/config与finally。真实Core inherited
和Runtime ownwrapper均覆盖。至少静态成功/syncthrow/rejectundefined/null/schema早失败、
三个handleToolErrors、GraphInterrupt/实际abort、retry/parallel/另一静态工具、dynamic
native拒ordinary保、unawaitedheldhandlerdrain、生成器ToolEvent失败后invoke成功。default5
不改，不删codec字段或固定rawerror string求绿。

getter/latefn或flags、cloneagent/foreignop/caughtreentry、参数求值期间改invoke后restore
在0effect处拒；确已执行的原invoke只记录其真实结算。Core两个catch及public fake
handleToolError provenance、App请求经过utils复制的关系仍BLOCK，不能借runId、ALS、
原reason相等授事件。完成此基础后才另两审App request-only；本窗不给任何Events帧。

## 首次实际 43 门后的四项精确收口

Root 已实际应用旧七加新九的完整十三目标。首门四文件 43 definitions 中 39 PASS、
4 RED，另有一个真正未处理的回调拒绝，日志为
`output/stage24-tool-invoke-sdk-first-current.log`。旧十四和安装器新五全部通过。
本节先申请两人设计票，不把夹具的失败改写成通过，也不改变普通 SDK 错误处理。

### 私有构造失败必须同步锁住当前 operation

原参数展开读取 `configurable` 时可以改选定工具的 invoke。随后
`nativeToolAssertOperation` 调用真正私有 `readNativeToolAgentInstance`，其完整
declaration 检查会抛出固定 origin 错误并毒化 construction；目前这次 throw 没有
同步设置当前 operation 的 `failed`。真正原 baseHandler 与 `#handleError` 仍执行，
可以把 origin 错误转换成 ToolMessage，导致 controlled executor 向外返回该消息。

只将该现有 cross-private reader 的调用置于 try/catch：同一原调用、参数、次数与
receiver 不变，捕获任何实际 reason 后先将当前私 record.failed 置 true，再原值
rethrow（包括 undefined）。其它完整 operation/node/tools/descriptors 检查原样。
不得以晚函数值刷新 construction，也不调用额外外部 callback。

真正 outer/handler Promise 的票仍记录原函数实际 settlement；原 handler 可以依原
合同生成消息，该事实不改。controlled executor 的实际 Promise fulfillment 回调
先保存 settled phase，再只检查该私 failed latch，失败则抛固定 origin 错误，不把
原 outer ticket 的 fulfillment 改成 rejected、不重写 raw invoke outcome，也不授
App Source。当前 template 已有 `if (record.failed) nativeToolInvalid(record)`；若
实际生成目标缺此行，必须同窗精确补齐此同一已批准 latch gate，不能只 poison 后
继续返回。原 rejected 回调仍抛真正 outer reason。

现有真实 config getter 用例保持原同一动态 getter、一次原参数构造、零原工具 effect、
零 fake invoke、一个 selection 且没有 outcome。加明确 status/failure 保存，原对象
先恢复再匹配固定 origin 错误，并确认真实 outer/handler settle 后 drain，不能把
callbackError 或清理失败代替首拒绝。

### null 保留原 SDK 的两层真实失败

实际 Graph `isGraphInterrupt` 仅排除 undefined，随后读 e.name。普通工具 reject
null 时，真正 ToolNode 错误分类因 null.name 抛 TypeError；这是原 SDK 行为，本窗
不修它。用独立 tagged settlement 先完整观察 ordinary 与 controlled 两个真实
runTool Promise，不因为 null 的 ordinary 拒绝而跳过 controlled 运行。

undefined 路径仍比较完整 ToolMessage.toDict、原 raw outcome.reason===undefined，
drain 必须抛精确唯一 undefined。null 路径两个 outer 均真正 rejected TypeError，
保其实际 constructor/name/message 与原 callback 顺序；controlled selected outcome
必须 rejected 且原 reason===null。drain 按实际票注册顺序严格为 AggregateError，
errors 是 `[controlledOuterActualTypeError, null]`，第一项同 actual outer rejection
地址，第二项原 null。没有返回值就不能伪造 ToolMessage codec 或把分类异常当 invoke
失败来源；不同实际调用的 stack 不硬认同一字符串。

### schema 完整 codec 以实际原错误实例对照

实际 `ToolInvocationError` 将 parse error 的完整 stack 写入消息 content；两次
ordinary/controlled 的真实 await 链不同，因此两次独立 schema 错误的完整消息本来
不同。不能删 stack、过滤行、删 codec 字段或修改原 parser 输出。

首构造前为真正 Core tool 固定测试 own invoke wrapper，严格 Reflect.apply 原 invoke
同 this/args 一次；仅捕获并保存每次真实 schema reject 的原实例后 rethrow 同值。
ordinary 与 controlled 都仍实际执行原 schema 解析，工具 body effects===0。
controlled outcome.reason 必须 === 其原 wrapper 捕获的实际 parse error，ordinary
与 controlled 记录各自独立结果及 reason，不把一个结果代替另一个运行。

另外只用于 expected-value 的两个普通 ToolNode reference 分别持有真正 Core tool，
其测试 own invoke 严格重抛对应已观察的 exact parse error（不创建 native Agent、
operation、资格或来源）。真正原 baseHandler 将同实例经同 ToolInvocationError 与
原 #handleError 转换。分别将每个 actual schema result 的整份 toDict 与其对应
ordinary reference 整份 toDict 作 strict equality；真实全部 stack 及所有字段保留。
该 reference 证明原格式化行为，不能称 reference 重新执行了 schema 或授原 invoke
结算；只有前两次真实原 invoke 建立 schema 和 outcome 证据。

### 生成器回调使用真正 awaited callback 合同

BaseCallbackHandler 的 awaitHandlers 默认取环境；创建后仅赋 raiseError=true 不会
重算 awaitHandlers。首夹具因此把真实 ToolEvent rejection 放到后台，Core 的
consumeAsyncGenerator catch 未收到它，导致 errors 为空且一个 unhandled rejection。

本用例的两个真正 ordinary/controlled Observer 均在运行前明确设
raiseError=true、awaitHandlers=true，保原真实 handleToolEvent throw 同一个 Error，
原 Core catch 转给 handleToolError，再保生成器最终 return 和 handleToolEnd。
两次完整 ToolMessage.toDict strict equality，两个 observer 各原 error 地址、完整
start/error/end 顺序与 ToolEvent exact once；controlled invoke outcome 仍 fulfilled，
drain 正常且实际 generator finally 完成。不能以 process unhandled listener 吞拒绝，
不能从 public ToolError 补 rejected outcome，原 Core 不在此窗修改。

生产窗口只 node template 的原 cross-private latch，并在必要时保同原 fulfillment
latch gate；版本锁 generator 重建新九 patch/manifest 后由 Root 复核与实际应用。
旧七 patch/原 stream runtime/API、CJS exports、完整 union 分类及所有其它 20 SDK
definitions 不变。测试窗口只上述四原用例（null/undefined each 仍两定义），默认
五秒、全部资源真实 finally/allSettled、完整 codec/未知参数/零 effect 门均保持。

### 修订后的实际证据和只读组合准备

Root 先用仍未变的旧完整十三目标 artifact 校验并精确恢复 base；维护日志为
`output/stage24-restore-verified-tool-base-current.log`。随后才修改上述一个 template
和四个原用例，重新从已核官方 tarball 及原七 after 生成九目标。新 patch SHA256 为
`7de6a1bf204ec01a3d0d35d4e320cc8de01db4ce45b8d8d299ba8f1437e08529`。
Root 实际安装与完整 union13 校验成功，四文件 43 项全部通过，unhandled 为 0，
记录在 `output/stage24-tool-invoke-sdk-corrected-current.log`。首次 39/43 和 unhandled
日志保留；此后证据不替代 App Source、Core raw callback 或 Events 帧的后继要求。

三个包的 27 目标组合设计另见 Shared stream 设计文末。当前本 owner 只在
`apply-langchain-native-tool-invoke-origin.mjs` 加入 readonly
`prepareLangchainNativeFoundationPlan` 及对应静态类型：保原 classifier/旧执行 API，
先完整核十三目标的官方来源、Root pin、模板、LICENSE 与实际 bytes；pristine 在
内存应用七再九，base 只在内存应用九，overlay 保完整十三 after。固定 targets 与
artifact/Root/模板/LICENSE evidence 都携带实际 bytes/SHA。没有暂存、写入或加载
SDK，也没有业务权限。该两文件已获独立两份源码票；27 批次执行及其真实 FS 回归
仍由其独立窗口验证，不能把返回只读计划当已经安装。
