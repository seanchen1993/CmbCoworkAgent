# 实际消息改写接线与流输出一致性

日期：2026-10-05。开发树 `C:/ai/CmbCoworkAgent-mods-v2`，UAT 只读。
本页是待两位独立评审的实施合同，不能作为产品已完成证明。

## 用户看到的效果

真实输入、模型完整回复和工具结果各经过一次 Mods 的消息改写。改写后的内容会出现在
聊天、保存的历史和下一次模型请求中。原工具只执行一次，改写或保存失败不能重跑工具。
没有消息 Hook 时沿原核心保存；不为每一行重新加载插件。SDK note 的接纳顺序不变。

本次先打通 main 的实际模型回复和工具结果。输入、delivery、共享子任务、事件流、
临时附件和系统通知仍单独接线验收，不以基础测试替代它们，也不归为框架无法实现。

### 2026-10-05 主对话入口补充合同

实际显示路径不能把已有消息上的公开标记当成成功保存凭据。旧显示解析器重新生成
时间且丢失完整保存字段，不能靠“遇到标记就从数据库补数据”解决。原生 Host 在
Keeper 真正提交并确认后，为返回的真实安全消息实例登记私有凭据，固定原物理运行、
完整消息内容、实际 Store 行和显示数据库的完整保存结果。模型与工具均登记。

显示序列化在第一次调用消息的 `toJSON` 之前认证这个真实实例。完整消息走单独的
完整快照路径，不进入旧的文字增量和工具参数裁剪。values 的切片保持真实消息引用；
只给对应的已认证序列化对象转交私有凭据。显示正文、推理、工具错误标记和保存时间
取已确认的显示结果。之后任何复制或转换均在已知转运入口明确验证和转交，普通
JSON 复制、公开标记和调用者提供的编号不能重建凭据。

原保存解析入口先核这个私有凭据，复核实际安全内容、显示对象和数据库保存结果，
再接纳完整快照；该分支跳过旧完成消息改名、文字替换和工具参数累积。没有私有
凭据的原用户继续走原路径，原生记录的禁写边界保持不变。错误正文、复制的标记、
撤权、线程重建和运行所有者换代都必须拒绝，不能转成成功确认。

实际调用包装保持 ReactAgent 的默认配置、初始化、其余方法及私有字段接收者。
单模式、多模式和子图流依真实框架输出形状路由。停止时先中断原 combined signal，
再等待原 `_streamIterator` 的真实 finally 和 Host 中仍进行的工作；原流外壳的 cancel
返回不代表模型、工具或 checkpoint 保存已经结束。真实迭代完成观察器仅装在已知
CompiledStateGraph 实例，使用本次私有调用上下文，不能凭线程编号重建。

事件流的工具完成通知早于原生工具节点保留，不能直接复用模型 token 路由。尚未
接通确切工具回调来源前，新原生路径明确拒绝该 API；普通旧路径保持原行为。
这是待实现的入口，不是框架无法实现的结论，主对话验收后继续补齐。

## 真实来源与编号

`FunctionNativeConversationRuntime` 由原 graph 工厂捕获，固定 actual AppDB、物理 lease
对象、线程 incarnation、authority、原 main binding 和原 signal。Guest 配置 epoch 与原生
保存来源分开。策略在每次 admission 捕获，旧策略被替换时已等待的 admission 拒绝；
未来行可走当前策略的 core。已进入 Hook 的异常绝不再次调用 core。

每次 `wrapModelCall` 进入时固定私有 producer、occurrence、实际
`__pregel_task_id` 与完整 `checkpoint_ns`。真实框架在同一个 task 中产生相等的
`metadata.langgraph_checkpoint_ns`；metadata 只在原 run 的私有表中选择该已有地址，
不能单独生成来源。不同实际调用的重复 provider ID 不得导致图 reducer 覆盖前一行。

`wrapModelCall` 不提交 canonical 行。已知实际 `createAgent.graph.nodes.model_request`
的原 `bound.invoke` 执行一次，完成 AgentNode 真实改名、步数耗尽替代和 Command 选择后，
在原 writers/reducer 前执行 native finalizer。只操作此真实 node 返回的明确
`Command.update.messages` / 原生 state-update.messages 地址，保持其余控制字段和历史
原对象，不扫描保存历史。真实 node output/slot 与原 task 配置、bound 对象及私有 call
绑定为原生来源 receipt。工具用同样的已知 tools bound 返回接缝，在真正 recovery 后保留。

原 bound 完成后的 output 记在该 actual task 的私有 once；后续 keeper/COMMIT/ACK失败
只能重读此已完成 output，不能再次调用原模型或工具。原 bound 尚未完成就抛出的原生
错误继续沿原既有重试机制；不能把原始模型 retry 与已完成工具的重跑混为一谈。
adapter 保原 bound 的 config、name、callbacks、writers和getState/setState语义，不改库。
Framework升级改变已知节点/输出合同则明确拒接此能力，不猜节点名或历史 role。

最终 native 行在任何 codec 或 Hook 前先做原 typed capture。新增 occurrence helper
仅把安全副本的 ID 改为原工厂固定 UUID，保留安全原 ID 和原 digest；副本重算 digest。
不改 structured calls、call ID、status、artifact。原 raw 不修改，也不以编号获得权限。
原 provider ID 和 occurrence 由 actual binding 保存；保留图消息携带已有内部 provider
metadata，UI 投影使用同一 tuple。缺 ID 的 ToolMessage 也走此明确工厂。

## 同一次调用的暂存输出

实际 graph 返回的 `stream` 是所有桌面和 Standard consumer 共有的原生接缝，在这里、
各 consumer 的 JSON/serializer 之前添加 run 私有路由。普通未登记 graph 保持原接口。
路由不是基于线程 ID 的全局入口。它只操作本工厂已经登记的 model task 地址。

已到达的合法部分输出继续正常显示。路由在原消费者序列化的等价位置对 messages
模式进行一次原序列化，再仅修改副本的稳定 ID 与内部 provider tuple；consumer 后续
序列化不得再次改其已标明的 delta/snapshot 协议。完整模型行则必须先 typed capture，
不能使用这个流投影来生成 keeper 输入或执行记录。

完整 handler 返回时同步 seal 本次 actual occurrence。该 namespace 的晚到 raw chunk
此后不进入原 buffer，也不转发到界面。其他模型 task、工具、子任务和新调用不封存。
严格 flush 原 run、该稳定 UUID 的合法 pending partial 后，再捕获实际 SQLite 的原行、
fragments、aliases 和 absence receipt。模型保护与该实际 flush 的真实 finally 都结束
以前，Registry 容量不能归还。unknown close 保留占用，不把取消等同完成。

同 task 的内层 retry 不依赖 provider ID 选择：原 graph invocation config 用 mergeConfigs
保留原 callbacks 并加入私有 BaseCallbackHandler（`_awaitHandler:true, raiseError:true`）。
独立 Node AsyncLocalStorage 捕获 actual call，真实 ChatModelStart 的原 runId 在该 call
及 exact namespace 下固定 attempt 和稳定 UUID；真实 token chunk 对象的 WeakMap
绑定该 attempt，LLMEnd 原 generation.message 的对象 receipt 绑定完成结果。原 handler
完整返回必须匹配 actual End/result receipt，失败attempt同步封存，不凭最后一次或ID猜。
若同一结果对象属于多层 model callback，必须核原 parent/实际入口层级唯一，否则拒绝。
已有 ModBoundary 的 raw leaf callbacks 隔离不改变，只消费它实际 outer 已变换的输出。
无 token callback 的 generate End 全文不得作为 partial 提前转发。

最终 native node 对原 provider 结果的真实改名/替代由上述 actual bound-output receipt
认证，不能拿 LLMEnd receipt 单独证明 framework 后续替代。raw retry 的旧 partial 清理
需原 transport 已有失败恢复决定，不由 keeper 擅自删除。

本次 admission 的 `policy.protected` 为 true 时，该 occurrence 的原 partial 全部不
序列化、不进buffer、不转发，直到完整 typed 双pass/keeper 后只显示安全 canonical 行。
不使用单chunk publish证明跨chunk literal已保护。关闭Mods后的真实native source仍核
lease、binding和当前强制策略。取消不提前释放被忽略取消的真实模型/flush/Worker工作。

## 完整提交与原消费者

每行建立实际 NativeProjectionAccess，绑定本次 producer/run/occurrence 与原 destination。
admission 传入原 flush、原 aliases 和实际 finalExecution 回调。Keeper 首次 full protection
后建立 Retainer，公开 Hook 超限时仍完整保存 native core，不截断正文和附件。

真正 Store commit、实际 app DB transcript writer 和严格回读沿现有同事务接缝；只有
private finalExecution 可以更新原 partial 不完整的 tool_calls_json。保存后生成同 class
消息并附实际 canonical stamp，交回原 graph reducer。原对象和 protected receipt 不变。

原消费者遇到 canonical full echo，仅以实际 DB 的完整 echo 验证计为已消费，不再 upsert
或要求 changed count 为一。公开 stamp 本身不能授权绕过验证。任何晚到 raw snapshot、
delta 和 alias 仍保留 DB 已有 canonical 禁写防线；原 updater 的 changed count 不改变。
界面最终必须用完整 canonical snapshot 替换 provisional 内容，下一请求用完整 native。
values/旧snapshot也在原 graph 私有路由验证：已保留行只能消费实际完整canonical echo，
不能依靠DB禁写防线继续向UI转发raw；原public stamp不提供该验证能力。

native 行不是 SDK inbox note，提交不会把 intake frontier 跳过尚未接纳的 note。后续
Saver exact checkpoint membership 仍独立确认实际图采用了哪些 native 行。

## 工具与真实回归

### 历史消息和新备注的实际来源

第二轮对话、审批后继续以及空输入恢复，都从原图的 `getState` 读取历史。
固定这次返回的 checkpoint ID、线程和命名空间，随后用同一个实际 SqlJsSaver
读取该 checkpoint 的私有 membership proof；同时验证 Store 中固定 checkpoint
的持久 membership。完整消息数组的数量、摘要、成员位置，以及每个成员的
完整原生内容、stamp、row receipt 和 23 列显示快照都必须相符。
公开 UUID 或 stamp 相符不能补进未来尚未采用的备注，也不能替换这次 checkpoint。

登记历史只让本次原对话在输出时读取已经保存的完整快照，不产生新的写入、
append、checkpoint 或执行许可。输出时继续检查原 proof 和本次任务的存活状态。

新备注在原 `prepareFunctionConversationIntake` 完成采用校验后生成私有 publication，
固定实际 store、target、原 notes 对象、完整内容摘要、row receipts 和采用范围。
原输入准备和原 beforeModel 两个采用入口在交给图以前登记该 publication。
关闭本机制的旧调用不生成 publication，保留原有准备方式。

上述合同已经 latest_mods_binary_review / legacy_boundary_review 的历史来源审查，
以及 official_mods_review 的实现方案审查；实际代码与回归另行验收。

### 单独订阅回答流时的最终完整输出

原 AgentNode 返回 Command 数组，原框架的 messages callback 不遍历 Command 中
的新完整消息。因此不能把早到的原 LLMEnd 当成处理完成的回答，也不能人为补发
LLMEnd。新路由在实际原图中增加私有 updates 观察；只有原 writers 成功产生的
updates 与本次 NativeNode 已处理完成的同一个对象、同一次 source 和实际 slot
一致时，才补发一个完整 messages 帧。自然产生的安全 messages 帧共用本次去重记录。

新增观察模式不对外泄漏，不改变模型、writers 或 checkpoint。原有 messages 的任务
命名空间不能误当成子图过滤，否则会丢失主图的正常部分输出。对外保持原请求的
单模式、多模式、带子图和不带子图四种形状。official_mods_review 和
legacy_boundary_review 已通过此设计及该命名空间修订条件。

工具入口包住原实际 handler，一次返回后，真正 paired ToolMessage 为 tool-result。
Command.update.messages 的旁行由该明确返回地址登记为 tool-message；保 Command 的
其他 update、resume、goto、graph 语义。失败诊断和旧 recovery 先完成，不能绕开旧工具
权限、Plugin hooks、Harness checks，也不能以 role 扫描历史触发 Hook。

最低验收：真实 createAgent + AppDB + localhost HTTP，模型回复改写影响下一自然请求，
工具 effect=1、args/status/artifact完整；缺 ID/重复 ID 两调用保留两行；late raw chunk、
旧 values 和 timer 不覆盖；实际 strict flush held 时取消不提前归还；workspace OFF、
policy-held revoke、global OFF 原 binding 撤销各验证各的行为。再做实际 Electron 和原
Plugin/项目/Harness 回归、流输出时间与大行性能比较。streamEvents 与 shared child
未接前继续列明，不宣称全门完成。
