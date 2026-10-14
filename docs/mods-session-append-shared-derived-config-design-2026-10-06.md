# 子助手配置派生继续适配方案

状态：方案已通过两次独立设计评审，生产适配与真实集成测试正在源码双检及实际
回检，尚未验收。改造前共享子助手只有
`invoke` 接入真实保存和调用清理；直接把 `withConfig` 绑定回原对象会得到未包装的新
助手，不能称它已具备同样的 Mods 能力。没有发现这一项的框架实现限制。

## 用户得到什么

组合产生的子助手可以继续设置自己的默认标签、普通配置和模型调用上下文，然后
直接调用它。它的历史、追加提醒、模型回复和工具结果仍保存到这次真实子任务，
原助手继续可以使用。派生失败只清理本次新助手，不关闭原助手或其他子任务。

本次接入的是默认完整结果的子助手调用。原框架会根据流式、子图和编码配置改变
`invoke` 返回形状，不能把其中未完成消息或编码帧当成已安全保存的完整回复。
native 路径在委托原调用之前按实际有效配置检查：streamMode只能未设置或字符串
`values`，subgraphs只能未设置或false，encoding只能未设置；数组 `['values']`
也属于另一种返回形状。派生默认与本次覆盖都须检查。其他形状须紧接着增加真实
原迭代器来源、保存投影与完整清理后开放，不靠公共字段认证或绕过检查。

默认取消信号与流式调用各有独立的真实来源和清理问题，不能仅靠这项派生包装
宣称已经完成；它们会在同一轮持续迭代中继续适配与验证。

## 当前源码与不能采用的捷径

`createFunctionConversationSharedAgent` 创建真实 ReactAgent，在实际 compiled graph
安装共享 Node 与 Tool 接点，以及原 `graph.getState` 预查询包装。实际共享 Saver
初始化后，才由 genuine Producer/Manager 创建本次 Host、规则来源和保存目标。

原框架 `withConfig` 返回一个新的 ReactAgent 和 compiled graph，同时沿用原 options
对象与 middleware。当前 native middleware 闭包固定原 shared factory；仅在新图安装
Node 并不能让这个闭包找到新域，它会错过本次 Host。不得接受公开名字、图形状或
同样的任务 ID 来补出权限，也不得把原父图 Host 借给新图。

## 原始工厂与派生关系

native shared 创建路径采用现有 genuine Agent 工厂；普通 shared 路径继续原行为。
从模块私表读取该实际 Agent 的派生能力，委托原框架 `withConfig` exact once 创建
新 Agent。原 prototype、options 地址、graph getter、method descriptor 与真实新图
继续由原工厂检查，不自行模拟原框架私有配置或重新执行 middleware。

原 shared factory 增加一个模块私有的族地址；它只表示这些真实派生图属于同一个
原创建链。原 factory、派生 factory 和 graph 的实际关系分别存于私表，族地址不是
保存、模型调用或子任务权限。派生只能由同一 genuine 工厂的实际派生返回结果登记，
不增加 caller 注册族或任意 graph 的入口。

原 native middleware 从这个原族的当前真实域路由到实际派生 factory。必须核该域
来自同族私表、当前 graph 等于派生工厂实际 graph、phase 已准备、当前原 Node Work
和真实 Producer/Host 关系。无当前域走原普通调用；foreign 或关闭域明确拒绝，不能
将检查失败当成普通路径继续。

## 包装与失败边界

known shared 包装在第一次原派生方法运行前固定本次同步操作的重入状态。原方法、
图 getter或构造过程捕获重入错误后，外层仍失败，不能登记半成品。操作失败后原
factory恢复可用；新 factory、Node/Tool 安装与预查询包装须完整清理，原图不关闭。

每个成功派生图有自己的 factory、节点安装、工具 ledger 和预查询原方法。沿用
原捕获 scope 函数与固定原 native options；原 middleware callback 不重复运行，
原框架 options 不改写。后续 `invoke` 仍由真实 scope.run、Saver 初始化和本次域的
Host 接管，并在真实 finally 完成该域节点与 Host drain。

原预查询不能从 parent/sibling checkpoint 借出历史、目标或 Producer。派生默认
配置与本次配置合并后仍须保持 actual parent task/read/scratchpad/checkpoint facts，
本次共享 checkpointer由原 scope固定。普通业务 configurable 字段可以继承；改动
原物理任务事实继续拒绝。tags、metadata、callbacks、recursion/context 仍交原框架
合并，不重复执行；默认 signal仍按现有 genuine 工厂限制明确拒绝，普通调用取消
信号和父子撤权保持，待真实合成信号来源方案继续补齐。

泛型或未登记 Agent 的历史包装不取得新能力，沿用原方法和检查。测试不能通过
伪造一个 frozen runtime、caller callback、旧 Producer 或 JSON 模式取得 native 资格。

## 真正验证

- 实际 AppDB、Manager、物理 lease、父 ToolNode、共享 Saver 和子助手：原调用与
  派生调用都执行真实模型与工具，真实 Hook、完整行、checkpoint和来源字节保持。
- 默认标签、普通配置、上下文与单次原 callback 对照；连续派生和普通调用覆盖，
  原助手继续使用，实际模型请求数和工具副作用数不变。
- 两个真实子任务并发调用原图/不同派生图，目标与 namespace 不混；预查询不读取
  sibling状态，两个实际 finally都结束后才关闭数据库。
- getter/Proxy/clone/foreign graph、原 options/method/graph变化、原派生重入捕获与
  部分安装失败，0新增模型请求或保存；失败后原助手继续运行。
- 真取消、父撤权、组件版本变化、目标关闭、忽略取消的真实工作仍有原 drain 与
  reservation归还规则，不靠 public Promise提前释放。

实施窗口限 shared invocation、shared domain、原工厂私有派生读取的必要窄接点及
独立真实集成测试。方案双评审、源码双检、原功能门、原 5 秒性能门与桌面回检
之后才验收，不把这一项扩大为所有 shared stream或默认信号都已对齐。

## 最终交付与清理补充

派生助手除同族记录外，还要核对本次实际模型节点、原 bound 地址和真实任务
运行关系。存在当前任务时，调用另一个图不能退回普通调用，更不能借当前图
的 Host 保存结果。任务与工厂的引用、状态和值必须先通过原数据字段检查再读，
失败保留在私表中，恢复公开字段不能使旧任务重新有效。

成功结果先等待本次真实节点和 Host 全部清理可用的实际工作，再制作只在本次
返回操作里持有的完整消息副本。副本保留原生消息类型及完整字段，原消息与
副本摘要必须严格相同；有丢失字段或被抑制内容的复制直接拒绝。之后仍对原结果
执行完整保存核验和最后纯数据核验，副本不取得保存、模型或工具调用权限。
原 Host 的关闭回调只能接触旧图持有的消息，不能改动尚未交给用户的副本。

因此 native 子助手的返回消息是独立对象，值和原生类型保持；普通旧调用的
对象身份保持原行为。这项兼容变化须用原字段、完整保存字节、原生类型及真实
关闭回调的用例验证。新图安装失败会先撤销新图路由，全部关闭和清理均实际
核对；无法证明清理完成的新图单独保留并隔离，不能声称已经结束，也不关闭
原助手。流式子助手和默认取消信号仍属于下一项可行适配，未证明框架阻碍。

## 原调用方法的固定地址补充方案

共享包装不能先读取公开 `agent.invoke` 再绑定：用户后来加的访问器会执行，
替换函数还可能委托原调用后添加未经过保存处理的假回复。native 路径增加
`readFunctionConversationNativeAgentInvoke(agent)`，只从现有真实工厂私表返回
固定的原调用能力。记录真实 ReactAgent 原型上的 invoke 数据方法、flags 和
原接收对象；真实 compiled graph 的 invoke、stream 方法及继承地址也记录，
不限制合法的 getState 和本工程流式来源对 _streamIterator 的原插装。

该能力在调用原方法之前、等待原 Promise 完成之后都核对这些地址与原工厂
结构；不读取后来改写的公开调用方法，不接收 caller 提供的函数。共享 native
包装在任何 Reflect.get 之前返回这个固定入口；普通历史包装沿用原行为。
新增回归须证明晚访问器执行次数为零，替换函数无法伪造返回结果，正常原调用
次数、配置合并及完整保存字节保持。此增量已通过两次设计评审和限定范围源码双检，
新增真实调用仍待回检；原超时记录保留，不据源码票声称性能达标。
### 原追加提醒自动接入共享子助手核验

真实旧子任务回归发现：没有手动配置追加提醒登记回调时，提醒已经进入模型和保存记录，
但未登记到新增的最终回复核验中。因此最终回复被正确的未知记录检查拒绝。

修复只发生在实际模型执行前的提醒准备过程。存在已就绪的真实共享调用时，要求同一个
原保存实例、原提醒目标、原线程、原取消信号、原初始状态和原接收范围，才自动申请内部
提醒发布凭证。准备保护完成后，先调用用户原有回调一次，再让本次原宿主用该内部凭证
登记。前后检查本次调用仍有效；宿主继续完整核验提醒正文、原记录和保存投影。没有这
个真实调用或关系不符时保留原流程。不得忽略带标记的未知消息，也不得凭消息编号授权。

Root 和 Official 已通过窄设计评审。实际旧子任务失败记录保留；源码双检和原时限回归
通过后才可验收。
## Shared invoke 的原方法地址与执行分派补充

状态：Root、Latest 两次设计评审已通过，实现与限定范围源码双检已完成；新增
真实调用待根节点运行。实际
`ReactAgent.invoke` 先 await 初始化，再调用其原私有图的 `invoke`；原 Pregel
`invoke` 又动态调用该图的 `stream`。只在外层调用前后核 descriptor，会遗漏初始化
middleware 临时替换方法、返回伪造消息后恢复 descriptor 的情况。

NativeAgentFactory 的私有记录固定 genuine Agent 原 prototype 的 invoke data descriptor、
原函数与原 receiver，并核 own invoke 不存在、prototype/data flags 不变。Shared Proxy
取 invoke 时在任何 Reflect.get 之前返回私 cap 的 controlled 方法；generic 路径保持。
原方法以 Reflect.apply 执行一次，实际 Promise 结算后再核结构，不能读晚 bind/call/getter。

仅在 known Shared graph 的全部 getState、Node、Tools 安装成功后、publish factory graph
与公开 agent 之前，私 factory 固定实际 compiled graph 的原 invoke 与 stream inherited
path/data descriptor。随后把两个实际原函数定义为同一 graph 的 own、不可写、不可配置
data 地址。记录这个真实 installer 产生的完整 flags；不能把任意 caller own 方法当作安装。
原 Agent invoke 和原 Pregel 动态分派仍调用同一原函数、同一 receiver，getState 与
_streamIterator 的已知安装保留。Main Lifetime 的合法 stream 安装不走此 Shared-only
seal；未来 Shared SSE 必须先安装其 genuine adapter，再经单独合同 seal。

原父图的 seal 不能替派生图认证继承方法。派生构造前仍核父图保存的原继承路径、
原 owner 和 descriptor；新子图必须匹配这份安装前基准，只允许其根图对象不同。
真实工厂私表读写使用模块捕获的原 WeakMap 方法，晚原型访问器不能替换私有能力。

入口与真实结算后核 exact Agent/graph/原路径/最终 own flags。late own/prototype getter、
替换、原调用委托后伪造返回都不得取得 native result 资格。真实初始化 middleware 在
defineProperty 或赋值失败后 catch 并恢复也不能换掉实际分派；fake invoke/stream 调用零。
回归保真正 provider、ToolNode、Saver、native codec、23列与 membership；generic identity
与 Main 原 stream 语义另保持。seal 只是既有来源的固定方法地址，不 mint append/ACK。

### Shared 实际 _streamIterator 的同范围补充

Legacy 与 Official 的后续 primary 检视发现，Runnable.stream 第 119 行在原 stream
内部仍动态读取 this._streamIterator。当前 Shared invoke/stream 的 own seal 不阻止
真实初始化 middleware 临时替换该入口，返回未知普通 AI 后恢复。这是当前已实现
调用路径的缺口，原两入口源码票不涵盖这个第三入口，真实旧性能失败也不代此反例。

窄增量只扩充当前工厂 NativeMethodAddress 的 _streamIterator 类型和 OriginalAgent
安装前基准。首次真实 createAgent 登记时捕获其原继承路径、实际 owner、原函数和
完整 descriptor flags；与现 invoke/stream 一样拒 Proxy、accessor 或 caller 自有
覆盖。仅在 genuine Shared 的全部 Node/Tools/getState 安装完成后、publish 之前，
把该原函数以原 enumerable 和 own nonwrite/nonconfig 定义在真实图上。私表保存
这次真实 seal 后的地址和 flags，调用前及真实 Promise 结算后完整核它。

连续派生先核父图保存的原安装前 _streamIterator 继承路径，不能用父图的 own seal
代替；新 child graph 的继承 owner/函数/flags 必须匹配同一原基准，只有根 graph
地址不同。原 callback 临时污染 Pregel.prototype._streamIterator 不能被登记为新
真实派生图。复用当前固定 WeakMap 操作和 descriptor-only 路径，不加 caller 认证口。

Main 图不走 Shared seal，也不新增对 Main 当前 _streamIterator 的继承地址要求。
Main Lifetime 的实际安装保留，未来 Shared stream 须先安装其 genuine observer 再
按独立合同登记，不能借本增量授权任意新 observer 或把不支持的流式形状放行。

新增真实 Zod 初始化 callback 分别尝试 accessor 与替换函数，caught defineProperty
及 Reflect.set 失败后继续原调用，必须 getter/fake 调用零、provider 一次，full Store/
23/CP/member 和原 same-function/flags 严格成立。另保存真实原型 owner 后临时污染
其 _streamIterator，派生须在 provider/fake 执行前拒绝，恢复后原助手仍完成真实
原调用。原 21 定义、默认 5 秒及真实 body/drain/resource 清理全部保留。

状态：等待 Root 与 Latest 两次精确设计评审后实施，不改 Host 的未知消息分类。
