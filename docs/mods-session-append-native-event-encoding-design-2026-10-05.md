# 原生事件与 SSE 编码接缝

2026-10-05。SSE 最小层已获 Root、Legacy 与 Official 的独立设计审阅；当前新增源码
与回归夹具已落。第五次真实 SSE 门禁 95 项全部 PASS，记录于
`output/stage23-native-sse-fifth.log`；默认 invoke 形状已有真实未包装 Agent 的同
defaults 对照，第三次 94 PASS/1 fixture RED 日志保留。v2 事件、自由诊断字段的策略 adapter 和原生
withConfig 派生工厂仍是后续具体任务，本文没有把这些草案计为已实施或产品验收。
普通无 native Source 路径保持原实现。

## 实际边界

本机 `langchain/dist/agents/ReactAgent.js:642` 的 stream 保持原默认配置和 middleware
初始化；`:683` 的 streamEvents 原样委托 graph，默认版本 v2，并不走 stream 的初始化。
包装必须保持这个区别，不能拿另一次 invoke 或伪 callback 代替事件源。

`@langchain/langgraph/dist/pregel/index.js:955` 捕获编码配置；`:1072` 附近 SSE 返回
`[namespace|null,mode,payload]`，与普通 single/multiple/subgraphs 四形状不同。
`pregel/stream.js:172` 的 JSON replacer 会读取并调用原对象 toDict；`:245` 在外部
消费者看到 bytes 前就编码。外层解析 bytes 再保护已经太晚。

`@langchain/core/dist/runnables/base.js:364` 的 v2 event generator 创建真实 tracer，
后台消费原 runnable.stream，读取事件并在 finally abort 后等待后台消费结束。
`core/dist/tools/index.js:157` 在 runTool 返回之前 await handleToolEnd。
`core/dist/tracers/event_stream.js:116` 又 await writer.write。回调等待同一工具的
最终 Keeper 会阻止工具返回，形成自等；私有接纳只能同步登记来源，不等待最终保存。

原普通 ToolNode 使用 `langchain/dist/agents/RunnableCallable.js:32–37`，没有独立
tracing。普通 messages 工具结果先经过真实 bound/finalizer/writers；已通过的 held
Tool stream 反例不能代替 streamEvents 这个更早的实际工具回调边界。

另外本机原 `pregel/stream.js:108–162` 的 streamMode=tools 直接推 core ToolStart/
ToolEnd 的原 input/output/error。这些 mode 没有当前 Host 投影接纳；native source
现已收口准入，不能从未编码 tools 输出绕过。Root与Legacy已对最小实际 source gate
给正式设计PASS：仅
messages/values/updates继续准入，unsupported explicit和真实default都在原
_streamIterator.call/firstResult之前拒绝；后续具体mode adapter完成再开放。
源码已在 native lifetime 内收口，新增真实 createAgent/Tool/SqlJsSaver 的14项展开
定义，已在第五次实际门禁通过。这里的阴性目标为 provider/tool/graph checkpoint 零执行；
Root输入retention先于该接点，因此不据此宣称 input Hook或AppDB零写入。

## 共同前置：partial 来源不等于 completed 来源

原 inactive-policy chunk 的 raw JSON 接点已替换为独立 actual-callback-only partial
typed safe-copy：确切 chunk prototype、descriptor/Proxy/binary/expanded-node 检查在任何
construct/toDict/JSON 之前；来源 guard 在纯遍历前后完整执行，遍历内仅原 signal/time。
实际 callback 的 fields.chunk/message 均以 own data descriptor 读取，不求原 getter。
safe AIMessageChunk 只用空 seed 创建，再恢复已 copied 的完整 own facts/lc_kwargs，
末 guard 后再纯核 raw/safe/metadata/wire/policy/source；不能把部分 args 再交构造器解析。

这个 partial token 不授 Keeper、target、completed slot 或后续 final-message 权限。
required protection 下继续不输出未完成原文；inactive policy 下的原 partial 体验只从
安全副本序列化。原 callback metadata 也要 descriptor-copy，不能调用 getter。
这部分已有 Root 真实82项 PASS，且两位独立 SOURCE PASS；该证据不代表 events/SSE 已
接线。实际 callback token 与已完成 Node slot 仍是两种私有来源，不可互换。

## SSE 的最小可实现层

优先包装同一个真实 ReactAgent 的未编码 native stream，在现 private source lifetime
和 Host.message/validate 后编码。不得调用原 encoded stream，也不得 deep-import 私有
encoder或把 byte parser 当认证器。编码器是独立的纯 DTO → TextEncoder 层。

1. 原 wrapper 内保留实际 requested/actual mode、默认值和 subgraphs，而非从公开字符串
   再造来源。内部追加 updates 仍仅用于已完成 exact safe object 的私有补帧，不外发。
2. 原 messages 实际 task namespace 与 updates graph namespace继续分开。SSE 原
   subgraphs=false 的 envelope namespace 为 null；true 才用对应实际消息/图前缀。
   不强制 subgraphs=true，不把非空 model task namespace 当 child 过滤。
3. 首次 toDict/JSON 前，已注册 safe Base 的 full native digest、Store完整 row、sealed
   raw23 和物理运行检查成功；纯 encoder 使用已核 typed 副本，不执行原对象方法。
   SSE JSON 是显示数据，不产生 wire receipt、ACK 或 canonical写权限。
4. 非 message 的 state、metadata、tools/custom/debug/checkpoint/task payload 不会因为
  旁边有一条 canonical message 就自动安全。需要各自实际 source 的 typed DTO + policy
   diagnostic adapter。第一版可明确仅开放通过这些接纳的 messages/values/updates；
   其余 mode 在原图执行前拒绝，继续逐项实现，不称框架限制。
5. 原 SSE event/data格式按本机实现逐字比较，包括 namespace、Unicode、换行和消息
   type/data格式。错误不得调用 unknown Error 的 raw getter/toJSON；用实际错误来源的
   approved safe DTO。未完成错误 adapter时不承诺原 raw message 等价。
6. 编码采用拉取和有限一帧队列，不复制原 eager start 的无界缓冲。cancel/return 先
   同步 cut.abort，再实际原 generator.return/cleanup yielding finally、原 shell 和
   Host.whenDrained。public bytes结束不是图、Saver 或 ignored Worker 的终态。

这里的 mode admission/default配置检查必须在实际模型/工具执行前完成。现 framework
AsyncGeneratorWithSetup 构造时就启动 firstResult；不能等 public first next 才检查。

仅在外层 config 删除 encoding 不足以覆盖实际私有默认配置。本机
`core/dist/runnables/config.js:55` 使用 `options[key] ?? copy[key]`，因此传入
`encoding:undefined` 也无法移除 `agent.withConfig` 中已有的编码默认值；
`ReactAgent.js:643` 合并后，`pregel/index.js:914` 会在 `_streamIterator` 外面直接
建立原 `toEventStream`。这个事实不能靠外层 parse bytes 或形状推测修补。

具体最小切口改为同一个 actual compiled graph 的原 `stream` 地址，且只在现 native
source ALS 中启用：原 ReactAgent 已完成默认配置合并与 middleware 初始化，私有
wrapper 在首 await 前捕获真实 merged options、encoding/modes/subgraphs，并将唯一
允许的 `encoding:"text/event-stream"` 记入同 source 的 opaque encoding intent。
再给原 Pregel.stream 传独立的 options 副本，其 own encoding 值为 undefined，避免
原外壳创建 raw encoder。原普通 invoke 自身的 encoding undefined 不生成 SSE intent；
无 actual native source 时完全调用原 stream 方法。安装和每次接纳都固定原 receiver、
真实 method 地址与同 source，不能对任意形状相同的 graph 启用。

外层 native invocation 保留原 ReactAgent.stream 调用，不直接调用 graph 来跳过
初始化。它在收到原未编码 stream 后，只凭同 source 的私有 intent 开启安全编码层；
actual source lifetime 观察的 requested shape 才能解码已验证帧，不能让调用方传一个
形状 JSON 作为证明。临时换 graph 方法不允许跨 invocation 全局配置切换：固定安装
只按每次 source ALS 分流，两个同图调用仍各有独立 intent、signal 与 drain。
纯编码层每次从同 live source 取得实际 mode、subgraphs namespace 与受保护完整 DTO，
再按原 `event: mode[|namespace]\ndata: JSON\n\n` 形成 bytes。原 subgraphs=false 的
namespace=null，true 的 messages namespace 使用真实 slot metadata display prefix，
其它 mode 保 graph prefix；旧 single/multiple 外部模式不能丢失 mode 标签。

第一版仅复用已支持 messages/values/updates，不额外开放 tools/custom/debug/tasks/
checkpoints。whole state 仍需 descriptor-only typed DTO 递归器，实际 BaseMessage 地址
必须已通过当前 projection registry；其它对象只接受 plain/null/密集 array/finite
primitive，不执行原 getter、toJSON 或 toDict。消息要从已 typed 的安全实例用已知类
serializer 形成原 type/data 等价 DTO，再核源与纯数据尾，不能直接调用原 raw method。
这层不通过 JSON 反造 canonical proof，不向原 graph 反写，不增加 invocation。

上述纯数据复制只检查结构，不证明自由诊断字段已经受保护。当前实现另外收缩
values/updates 为已知 messages、remaining_steps、cmbFunctionConversation 数据字段；
未知 state 字段明确拒绝。metadata 只接受已知框架字段与固定 node/modelclass/provider/
tag/trigger/path 值，线程与 task namespace 的格式、数字参数逐项检查；自由模型名和
defined ls_stop 尚无 diagnostic adapter，拒绝而不原文输出。原 BaseChatModel 的
own ls_stop:undefined 可用。任何 alphanumeric canary 不能靠正则成为受保护诊断。
这仍需真实主产品/provider 输出门禁，不能将允许字段表视为通用策略保护。

部分消息的 SSE 来源在真实 handleChatModelStart 首个原 source callback 之前固定到
Attempt。后续 capturePartial 与 projectPartial 不可为原普通 token 或 foreign Source
重新授编码来源。只有同一 live Source 中已成功投影的 exact wire/metadata 两地址才
能读取安全平铺 DTO；公开 lc/kwargs、克隆、已完成 slot 和另一 Source 均不获此权限。
reader 保留原 source 两次完整检查，返回的 assertDataCurrent 仅做完整原 raw/safe/wire/
metadata/DTO/policy/attempt/signal/cut/Source 纯尾；整批 canonical A/B 后再调用这些尾，
其后没有 physical callback 或原 raw serializer。

原生 wrapper 的 withConfig 当前明确 unavailable，因为真实 ReactAgent.withConfig 会
创建新的 compiled graph；透明返回该派生图会逃逸现已安装 Node 与 Source 边界。
在真实工厂安装前调用原 agent.withConfig 的编码默认值仍由上述 merged 接点捕获。
下一派生工厂必须给新真实 graph 安装这些边界和独立 owner，不以本次拒绝冒称不可实现。
无 native wrapper 的原 withConfig/编码行为继续 delegate。

当前错误通过原流的受控失败路径拒绝，不编码未知 Error 的 message/getter/toJSON；
安全 error frame/自由 policy diagnostic adapter 尚待具体接纳，不宣称完整原 SSE 对齐。

下一 metadata-only 接纳稿为
`docs/mods-session-append-native-sse-diagnostic-design-2026-10-05.md`，正在独立两审。
它不通过放宽当前字段表补来源，而从实际 rawiterator frame 或真正完成 slot/writer
接点固定私有 metadata receipt，再对显示副本做独立完整 policy 保护。

建议新增 `native-conversation-sse.ts/.test.ts` 只含纯编码和 captured-source handoff，
native invocation 小分支由其原 owner 接入；其公共输出无数据库权限。必须先用真正
createAgent 的已保护 messages/values/updates 与原普通 SSE 建 golden，错误 frame 的
安全 DTO/固定 code 合同也须两审后才能开放，不用 unknown Error 字符串作为完成替代。

## v2 事件：真实 callback → request → final slot

工具 ledger 已拥有 actual original Node Work ALS 和确切 runTool request，但目前没有
core Tool callback run 的私有映射。下一窄 seam 在 original.runTool 的同一 Work 内加
Request ALS；真正 core Tool start/end 在原调用栈同步登记 native runId、original parent
run 与原输出地址。公开 event.run_id 只能索引已登记记录，不能创建记录。

原 runTool 输出可能经 wrapToolCall、恢复、eviction 或 Command 改写。core Tool end
对象与最终 Node message不保证相同。最终保存来源必须与相同 Request/Work、确切返回
地址及 slot完整join；不得根据 name/tool_call_id/role/JSON相等选择 final 输出。

原 event source须持续读取，先让真实 callback writer.write 完成，才能让工具返回。
尚未准入的 end payload不外发；有限队列满时同步 abort 本次 source，并仍等待原后台和
真实工作finally。不能等待Keeper的同时暂停唯一事件读取者。held event 如何显示其
最终 hook-replacement/Command结果须在实现前明确：诊断原effect输出与最终conversation
结果是不同协议数据，不能冒称二者原对象一致。

Model start/input、Tool start args、custom/error 也需要各自的 actual callback diagnostic
adapter；保留 run/name/tags/parent/filter 语义，保护显示副本，不反写实际工具 args或
execution status。现 NativeProtector只认完整 native message，不把随意事件对象塞入
HumanMessage、预 JSON string或公共 stamp来绕过这个缺失 adapter。

CallbackManager使用 Promise.all 启动各handler，一个私有handler抛错不会阻止其他handler。
mergeConfigs(private array, existing manager)还会把私有handler追加到copy。因此来源
登记要使用真实保留 inherited handlers/tags/metadata 的私有 prefix manager，同步
封住该source输出后才让任何本adapter encoder运行；数组与manager两种均需实际验证。

还有原 tracer 自身的前置问题：`tracers/base.js:193` 的 LLMError 和 `:263` 的
ChainError 会先把 error 转成字符串，`event_stream.js:145–160` 的首 model input
保留整份原 messages；v2 的第一条 event 还在 `base.js:409` 直接把本次 input 放入
data。外层先消费原 event 再 typed 不足以保证这些原 getter/stringify 没发生。
仅 prefix handler 抛错同样不能阻止其它 handler，因此本案不把它当保护出口。

可实施的 v2 收缩是另建本地安全 event handler。接缝必须在原 ReactAgent.streamEvents
完成 `mergeConfigs(this.#defaultConfig,config)` 后的真 compiled graph 上，而不是由外层
直接调用 `.graph.stream` 丢失其私有默认值。具体可在 actual native source ALS 内由
原 compiled graph 的 `_streamEventsV2` 接口走本地安全 driver；无本次私有 source 时
继续 delegate 原方法。安装固定 actualgraph/原method 地址，不能给任何相同名字 graph
补权限；同source/默认merge/version/其余config在首await前捕获。driver 再消费这个真
compiled graph 的原 stream，不调用第二次 ReactAgent.invoke，也不执行 ReactAgent
stream 的私有 middleware 初始化；不安装原自动 EventStreamCallbackHandler 的 raw
DTO emitter。这项 seam 仍是待正式两审的具体选择，不是已经实施的API。
该 handler 只在原实际 source
ALS、真正 Node Work/Calls attempt/ToolRequest ALS 下登记回调；run_id/name/tag 等仅
是已登记记录的数据。root chain 与实际 nested callback 的 parent 关系来自这些真实
handler 调用和原 source，不能按名字或 namespace split 猜 Node/工具。

事件诊断的 output receipt 与最终 Keeper receipt 分开：ToolEnd/core LLMEnd 在原 Node
完成前只登记原诊断对象及原 Request/attempt，不等待Keeper；原 writer/read 背压需要
一条持续消费桥。若要输出受保护 ToolEnd 诊断，要有独立 typed diagnostic policy
adapter，不把对象塞进 HumanMessage，不把最终 Hook replacement 冒作原 core output。
最终 conversation 消息只能在完成 slot/实际 writer updates 后以现 same-source 私有
completion 通道生成，不能作为一个伪造的 on_tool_end 或 on_chat_model_end。

这需要新增两类基础而非重用公开 JSON：opaque callback diagnostic receipt（actual
source/parent/Request-or-attempt/exact对象/phase/once）以及 typed diagnostic protector
（原 signal+同绝对 cut、全 own data、同真实 policy epoch/digest/deployment、first/final
纯尾、真正 Worker exit/host release）。它只改显示副本，原 execution args/status/
artifact 与 graph channels 不变；不产生 append/SDK target/source 权限。除已完成消息
外，start inputs、tool args、error、custom/retriever 都要逐类明确字段合同。未接类不能
悄悄 raw passthrough；可以在调用前明确不支持对应 protocol 类型，待下一具体 adapter。

持有未完成诊断不得暂停唯一原 event reader。建议固定最多256帧和4MiB typed safe DTO
缓冲，只保实际诊断 envelope；超限同步 abort 原 source，继续等待背景 stream 真 finally
与 Host drain 后拒绝。单个完整合法大 native 行不能靠截断诊断正文来制造 proof；应沿
该事件的明确 unavailable/error 合同。容量是新设计提案，尚未批准或实施。

v1 RunLog会复制状态/patch，普通外层不能恢复原对象证明。v1要另外接真实 pre-RunLog
source，不根据 parsed patch/同线程latest补登记。当前 native v1/events首执行前明确
unavailable 是具体未实现接缝，不能作为无法实现的框架结论。

## 实际回归要求

使用真实 createAgent、SqlJsSaver 和本地 provider。SSE覆盖原四形状/default/namespace、
实际 `agent.withConfig` 私有编码默认值与普通 invoke 仍未编码、同图两个 source 编码
意图隔离、
自然和补齐完成帧同源去重、nostream、partial typed refusal、首编码前 getter/toJSON0、
真实 byte golden、取消前首次pull及 paused-yield/ignored工作/真实 checkpoint终态。

v2覆盖callback数组和manager、实际 Tool end先于最终Node、替换Message与Command、
原ID缺失/重复、真实重试、两同图source不串、event writer背压和队列溢出、取消后不late
emit、原first-event input/filter/version字段与最后finally。每个开放event/mode须证明
自己的 provenance与保护，不用普通messages窄门或基础proposal票替代。
