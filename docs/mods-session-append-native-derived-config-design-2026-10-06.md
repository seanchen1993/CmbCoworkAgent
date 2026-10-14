# 保存消息后继续沿用原来的配置操作

目前原框架的普通 invoke/stream 最小输出已经接线，完整消息和最新诊断信息仍在回检。
包装过的主任务仍拒绝 withConfig；共享子任务的其它方法直接返回原方法，派生配置和
stream 可能绕过真实子任务保存准备。这些都是可继续适配的工程缺口，尚不是框架限制。

## 先完成主任务真实派生配置

本机实际 langchain/dist/agents/ReactAgent.js:320 的 withConfig 不是改当前对象。
它以相同 options、新合并的私有默认配置构造新的 ReactAgent，形成新的 compiled graph。
因此不能只把新对象交给用户，必须先给新图安装同一运行对象的真实 Node/Tool/Host。

由现有 Host 增加固定、自造的派生安装入口。包装器保存原 withConfig 的原函数及原
接收对象，保留框架自己的默认配置合并、连续调用、调用时配置优先等原行为。执行
前后均检查原运行对象，得到真正新 ReactAgent 后在新图安装原 Host 的节点与工具，
登记新图的流式来源，再返回同一包装器的派生对象。每个新图只装一次；原图仍可用，
关闭与清理仍观察原 Host 管理的所有实际节点、工具和流式工作，不关闭共享 Saver。

Host 自造的入口必须核对真正 compiled graph 和实际原节点，不能以公开名字、相同
ID、对象形状或调用者声明作为来源证明。没有该入口的通用包装器继续原明确拒绝，
不能在它上面临时给任意 callback 增加资格。原真正 PolicySource、Work、Slot、Source
和消息保存凭据都仍需完成原验证；派生配置没有新增组件权限或消息身份。

安装或运行失败保留原异常。只得到新图、未成功安装时不发布包装器；安装局部失败
须关闭并观察该新图已创建的资源，原图不被关闭。若物理清理无法确认，就保留失败
状态并拒绝使用该派生对象，不能强制释放或继续发布。回调改变原运行对象或关闭
Host 时同样拒绝。框架构造阶段不发模型请求、工具执行或插件 Hook。

原 withConfig 同步返回新对象，这个习惯必须保持。安装期按原新图建立私有 once/
installing/ready/failed 记录，先固定它再调用原检查；同图重入不能被 catch 后继续成功。
新图局部资源在安装失败时立即禁止新使用并关闭，但不假称异步物理清理已结束。
原 Host 保留这些实际失败资源直到真正 whenDrained，逐项独立观察，最终运行域的关闭
仍等待它们；不因局部错误关闭原图，也不提前释放实际尚未结算的来源或权限。

## 两次评审要求的派生操作保护

新图得到之后的安装 once 不足以阻止构造前重入。包装器必须先为原 agent、原方法和
本次同步派生操作设置私有 preparing/reading/failed 记录，再执行任何原 full guard 或
原 withConfig。嵌套同操作使外层 sticky fail，即使原回调捕获异常也不能发布新对象。
同一实际 Host 内的同步派生同样不能递归安装其它新图以绕过该操作记录。

派生入口资格由真正 createFunctionConversationNativeHost 自己的 private WeakMap
取得：核对原 Host 地址、相同 runtime 地址、原 baseGraph 确实已成功安装且仍 ready。
公开 installDerived 属性、任意同名方法、复制 Host、相同配置或 callback wrapper 不能
得到它。只读 capsule 由该 Host 自造，调用时仍须原 Manager genuine PolicySource、
原 Host 生命周期和原/新图真实安装结构检查；它不接受外部注册覆盖回调。

最后 full callback 之后以纯数据检查核原/新图、Host latch、原运行关系与操作私表；
不得在最后核验后再执行调用者回调。安装图失败也保 sticky，并保留本图实际清理
直到物理结算。新的派生对象只有在整个同步操作及最后纯尾通过后才返回。

实际 runtime.ts:3688 在 native wrapper 里面还有原 conversation invocation wrapper。
原派生方法不能绕过它的输入片段、历史恢复、frontier 与 checkpoint 准备。该层必须
同样保留原 Host/binding 和原方法/接收对象，再包裹真实新 agent；之后外层 native
安装与包装继续接线。只支持裸主 agent 的测试不足以验收真正产品入口。

入口资格落实为 Host 模块自己的只读 reader：按原 Host、baseGraph 和相同 runtime
查其私表。每图安装记录在首 full callback 前固定，状态含 installing/ready/failed、
原真正 PolicySource、原 Node control 和 Tool ledger。只有已成功安装的 ready 图可以
取得派生入口；没有 genuine PolicySource 的普通测试 Host 保明确拒绝。所有 callbacks
都由这个 Host 自建，reader 不接受 caller 回调或注册函数。原/新图最后纯结构检查
走 Node/Tool 原安装私表，不通过可替换的公开 assert 属性取得覆盖资格。

原 conversation wrapper 的派生分支只负责沿用原 Store/binding/history/intake，外层
genuine native capsule 仍执行完整准入、安装与最后纯尾。两层分别为真实原接收对象
占据同步派生操作 latch；同 Host 的 nested derivation 也标记当前操作失败。同步
返回方式、框架原默认合并和调用时优先仍保留，不增加派生权限。

## 真实验收

用实际 createAgent 的未包装基线比较 withConfig 与连续派生的默认配置、调用时覆盖、
回调和原输出形状。然后走真正 Manager、Saver 和插件 Hook：新图输入改写、模型回复、
工具结果只保存一次且继续进入下一次模型 HTTP 请求；原图与派生图并行不串会话；
取消、撤权、原图关闭、构造异常和安装失败均保拒绝及完整实际清理。SSE 消息必须用
派生图自己的真实 Source，原图或相同内容的来源不得借用。未知包装器仍拒绝。

两位独立设计通过后才能落代码；之后两位源码检视和真实回归。类型、完整回归、
旧 Plugin/项目/Harness 与最终 Electron 新快照仍需进行，不沿用旧快照作为验收。

## 后续共享子任务入口

主任务完成之后继续共享子任务的输入、stream 与派生配置。共享工厂的原 middleware
当前固定一个实际图，不能把新派生图直接挂在旧域上。必须先为每个实际图建立固定
工厂/域关系，真实 Saver admission 后再进入该域，并观察每个实际任务 finally。
这个步骤须单独按实际框架构造器与完整来源关系评审，当前文档不授权其绕过接线。

## 源码检视补充：原派生方法的真实工厂绑定

第一源码检视发现，Proxy.get 中先读当前 withConfig，会执行后来安装的 getter，或把
后来替换的方法当作原方法。只核 Host/baseGraph 不足以证明原接收对象和方法身份。
继续采用一个无桌面依赖的已知工厂模块：只有模块自身调用真实 createAgent 后才把
原 Agent 及其原 graph、prototype、withConfig 数据描述和 graph getter 登入私表。
它不接受 caller 注册对象、方法或认证回调。主 runtime 仅在有 native Host 时改用该
真实工厂，未启用路径仍用原 createAgent。原方法同步返回的新 Agent 在同一个模块
直接调用、核验并登记，沿用框架原 defaultConfig 合并，不自行重写合并规则。

纯结构检查固定原对象、原 prototype、原 withConfig 数据描述，以及不存在原对象
自有 withConfig/graph 覆盖。读取 graph 只调用已经固定的真实框架 getter及原接收
对象，并核同一图。未知对象、代理、克隆和替换描述均不取得工厂身份；不会先调用
它们的公开 getter。调用仍用已保存的原函数和原 this，避免自定义 bind/then。

实际 inner conversation wrapper 同样为自身返回的 Proxy 建私表，且仅当接收对象
已经有上述真实工厂记录时提供固定派生来源。外层先查这个私表或原工厂私表；在
withConfig 的 get 分支不再读取 target 的当前方法。真正执行时先占据 Host 同步
操作，再执行完整检查及原方法的纯描述核验，调用原函数，安装新图，核最后纯尾。
inner 继续递归包装同一 Store/binding/history/intake；其派生来源登记在返回前完成。
generic conversation wrapper 保原调用习惯，但其公开方法不能成为 native 派生
工厂证明。未知 native 调用包装器仍明确拒绝 withConfig。

新增真实反例须验证：原对象自己的 getter、prototype getter/方法替换、伪对象持有
同一合法图、foreign genuine Agent、Proxy/clone 都没有 getter/方法执行或 provider
调用；在最后 guard 中替换方法、捕获嵌套错误、调用失败和新图安装失败都不发布派生
对象。实际创建、连续派生、调用时覆盖和双层历史保存仍需正例。此增量等待第二位
独立设计通过后修改生产代码，原第一源码检视尚未通过，不记为完成。

默认配置的源码检查还发现：原 ReactAgent 在 inner 准备之后才合并私有 defaults，
所以只在 withConfig 中设置 thread_id 的合法调用仍会提前被拒。真实工厂为这条准备
路径保存限定默认事实：configurable、streamMode、subgraphs、encoding。
初次真实工厂这些字段无默认；原集成 metadata/name 仍交原框架处理。派生时先通过
普通对象数据描述复制本次 config 及 configurable，拒绝 proxy/accessor，不调用
getter；把该固定 config 交原 withConfig，并用原 mergeConfigs 合并上述有限字段。
限定事实的合并不包含 callbacks/tags/metadata，不能为了准备阶段再次复制 callback
manager 或叠加默认回调。callbacks/tags/metadata/default recursion 等继续由原框架
原方法合并一次。

factory.resolve(config) 仅把有限字段的实际默认及调用覆盖补入调用 config。inner
prepare 据此读真实会话；outer capture 同样据此决定默认流式形状，
调用原框架时原其他字段保留。重复合并会话字段应是相同数据值，不重复添加 callback
或 tag，也不自行替代原私有 defaults。调用时错误会话仍拒绝，原 signal 与关闭等
继续相与；原默认流式输出与调用时覆盖必须和未包装基线实际比较。这个默认事实
增量也需两位独立设计确认。

该四字段增量随后取得两次独立设计通过。默认 signal 另有真实差距：框架会把默认
signal 和 outer 调用 signal 再合成新对象，原流式来源的严格地址绑定不能把二者
当同一信号。因此当前 native 派生显式拒绝非 undefined 的默认 signal，普通调用的
signal 仍沿原取消路径。下一阶段须从真实工厂原 invoke/stream 到真实编译图入口的
每次私有调用关系中固定实际合成信号，不自行预测一个信号或按状态相同放宽。
这是可继续适配的未完成项，不记为框架无法支持，也不称整个 withConfig 已验收。
