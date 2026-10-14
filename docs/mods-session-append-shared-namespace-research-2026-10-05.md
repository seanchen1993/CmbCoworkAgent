# session.append：shared task 的真实 namespace 接点

2026-10-05，开发树 `C:/ai/CmbCoworkAgent-mods-v2`。只读研究，不修改 runtime、不运行
测试；下述实际源码关系不是 shared child 全链已验收。固定参考 Claude Code 2.1.289，
本地实际依赖为 deepagents 1.8.5、langchain 1.2.37、LangGraph 1.2.5。

## 已核源码与时序

| 实际位置 | 事实 |
| --- | --- |
| `src/main/agent/runtime.ts:2155` task wrapper | 收到真正 ToolNode config，保留 toolCall/Command；为每调用 mint `mod-task:UUID` |
| `runtime.ts:3137` runModTask / `src/main/mods/manager.ts:2596` withSharedAgent | known role 从实际 access 表进入；原 parent binding/epoch/authority 与 child actual authority 在运行前建立；opaque role 不猜 SDK 权限 |
| `node_modules/deepagents/dist/index.js:1414` getSubagents | 已知 spec 通过真实 createAgent 构造；有 runnable 的 spec 使用原 runnable；无独立 checkpointer，继承真正调用配置 |
| `index.js:1452–1454` createTaskTool | 从实际 task state 过滤少数键，替换 messages 为真正 HumanMessage，再直接 `subagent.invoke(subagentState, config)` |
| `node_modules/langchain/dist/agents/nodes/ToolNode.js:211–219` | 给 tool 原 config/toolCall/state 和合并 signal；同 batch 可并发执行多个 task |
| `node_modules/@langchain/langgraph/dist/pregel/index.js:860–863` | 未明示 false 的 child graph 使用 config 中原 `__pregel_checkpointer` |
| `pregel/loop.js:137–148` | 初始化按真实 scratchpad.subgraphCounter 调整 checkpoint_ns；非 nested 会重置非空 namespace；checkpoint_map 可指定同 namespace 的恢复 ID |
| `loop.js:149–153` | 第一实际 checkpointer.getTuple 接收已确定的 graph namespace/config；此时尚未 `_first` 应用 input 或写 input checkpoint |
| `loop.js:413–469` | `_first` 实际应用输入、更新 channels，然后保存 source=input checkpoint |
| `pregel/algo.js:197–256`、339–352 | 为内部 node 建新 node namespace，checkpoint_map 保留祖先并加入 `[ownGraphNamespace]: currentCheckpoint.id` |
| `langchain/dist/agents/nodes/middleware.js:46–63` | middleware.runtime.configurable 来自该真实 node config，不能把 node namespace 当 child graph namespace |

实际常量是 `CONFIG_KEY_CHECKPOINT_NS = "checkpoint_ns"` 和
`CONFIG_KEY_CHECKPOINT_MAP = "checkpoint_map"`，不是 `__pregel_checkpoint_map`。

因此 task wrapper 收到的 namespace 不总等于最终 child Saver namespace：同一个 tools
node 内第二个子 graph 可以被真实 counter 追加后缀。beforeModel 的 namespace 又包含
child 内部 node 身份。不要 split `|`/`:`、删后缀、拼 public agent 名或 toolUseId 猜值。

## 最小可实施宿主路线

1. 在 `withSharedAgent` 建立 actual authority/binding 后，为该 exact invocation 创建
   私有 task receipt，保存原 parent authority/ref、workspace/incarnation、真实 physical
   lease、epoch/signal、真实 task tool config 的祖先 map/parent checkpoint ID。公开 `agentId`
   只是索引标签，不能创建此回执。opaque 未知 runnable 保持原行为而不注册新 backend。
2. task 执行配置中的 `__pregel_checkpointer` 使用该 invocation 的宿主 router，仍委托
   同一个真正 SqlJsSaver。第一次 **真实 child graph** `getTuple(config)` 是 graph namespace
   admission 点：先核 actual invocation/parent/config 关系，再固定真实 thread_id、有效
   namespace、checkpoint_map 和可选恢复 ID，不改 graph namespace 或 scratchpad counter。
   不为取得 namespace 人工调用 getTuple，也不合成 saved tuple。
3. 该 getTuple 发生在 input checkpoint 之前。宿主在调用/返回原 native getTuple 周围注册
   actual child conversation/backend；`checkpointThreadId` 是实际 parent physical thread，
   ref 是父 durable family 下的新 invocation conversation，checkpointNamespace 是捕获的
   child graph namespace。没有实际原 callback guard/lease/epoch 不登记。原 query 或登记
   失败需要精确 retire/rollback；不能遗留可被 SDK 名字解析的假 running child。
4. router 后续 getTuple/put/putWrites 使用同一实际 Saver/namespace。child 的 own put
   通过 exact target 的 DeliveryBridge；父根 graph 仍用 main binding。child 内部节点运行
   的 configurable.namespace 与 Saver graph namespace不同，必须由私有 task receipt
   校验原 checkpoint_map 的归属，不能将每个 node 都创建成新 conversation。
5. child middleware 根据 **current actual authority → private invocation receipt** 取得该
   backend，首次 fresh graph 有宿主证明的 initialState；有恢复 checkpoint 时核其精确
   state。不要复用 root main `conversation.binding`，不要依据 public subagent_type 找
   当前最新 authority。所有 inbox/state/keeper 写入在 registry 完成后方可进入。
6. 结束/取消先关闭 child 注册入口，完成实际 graph/checkpointer 工作后再释放原 child
   lease/authority。archive 读取另持实际只读 data proof，不能复活 SDK append target。

router 不能仅凭任何“getTuple(config)”登记：它由上述私有 factory 构造、仅交给 exact
known child invocation，固定 actual Saver 和原父 config。给 router 的首个 namespace
必须来自真正 child invoke 的初始化；假的 public config、测试预读、另一个 sibling
调用和 metadata 猜测均不能成为源。实际原 graph 默认/取消/恢复规则继续执行。

## 输入与返回隔离是必要迁移

deepagents 的 `EXCLUDED_STATE_KEYS` 实际只有 messages/todos/structuredResponse/
skillsMetadata/memoryContents，**没有 `cmbFunctionConversation`**。一旦将 conversation
middleware 放入 child schema，父 channel 可能被传进 child；结果的 filter 同样会把 child
channel 放回 parent Command。当前本工程 `stripTaskSubagentSummarizationState` 也只清
三个 summary 键。因此需要两个实际宿主 seam：

- 已知 agent 的 native runnable/输入 wrapper 在 child.invoke 之前剥离父 conversation
  channel，保留其余原 state/真正 HumanMessage，child 只接自己的 fresh/restored state；
- 原 task Command 返回 wrapper 排除 child conversation channel，保留 graph/resume/goto、
  ToolMessage 和其他 state updates。不能把 child frontier 改写为 parent frontier。

构造 known runnable 应复用 getSubagents 的实际 createAgent 配方与原 middleware/tools/
model/responseFormat，不运行第二次模型或重复 task；未知 opaque runnable 不装假 schema。
native seed prompt keeper 如需在第一 input checkpoint 前改写，还须明确取得真正 seed
message/graph input 的 producer 接点；不能在 Saver 偷改 message 后声称 graph 内存已
同步。namespace 注册方案给出早于写入的时机，不单凭此证明全部 keeper 已接线。

## 当前 captureFunctionConversationTaskBinding 的静态边界

`src/main/agent/mods-conversation.ts:46` 目前保留真实 thread_id、node checkpoint_ns，并
要求 `checkpoint_map[target.checkpointNamespace]` 是 string。这避免猜 namespace和误用
internal key；当前主 graph 在真实 middleware 路由中可维持这个有界基础。

但 `typeof map[key] === "string"` 本身不能证明该字符串属于原 selected parent checkpoint。
shared child 不能只复用此条件。新增私有 task binding proof 应固定：

- original parent graph namespace 和 wrapper 从实际 config 捕获的 parent checkpoint ID；
- 首次 native getTuple 捕获的 child graph namespace/config 和实际 Saver；
- 实际 child put/prepare 记录的 own checkpoint IDs、真实 authority/epoch/lease；
- middleware 原 node config 中祖先项必须与原 parent map 相同，own graph map 项必须
  与此 invocation 的 actual planned/committed native checkpoint 对应。

LangGraph 的异步 durability 可以在 native put 真正结束前开始执行 node，因此不能误把
每次 node map 检查都写成“该 put 已成功 COMMIT”。实际 prepare checkpoint 归属与成功
delivery receipt 是两种事实；原同锁 native observer 才能给后者。验证接口不接 Guest
JSON 和普通字符串集合，不从当前 latest 根图反推原 parent ID。

## 独立 UI bucket

shared 的 physical Saver parent thread 不代表 UI projection 可以写 main thread_messages。
当前 `subagent-session-capture.ts` 是有界进程观察缓存，按 public export key 归档，不是
可作为 canonical writer 的实际 durable backend。原 streamed subagent bucket 同样须核
actual invocation incarnation，不能凭 `toolCallId::invocation-*` 字符串生成权限。

应为 exact child invocation 创建 actual internal durable transcript bucket/内部 thread
及其 incarnation，保存 host-only projection mapping；SDK child main/ref 仍保留父 durable
family身份。writer、verify、unknown-COMMIT 回读与 ACK 同一次固定 destination。未建立
mapping 时明确 unsupported，不借 parent UI 或随后新 sibling 桶兜底。

## 必须补的真实验证

- 真正 createAgent + createSubAgentMiddleware + 同一个 actual SqlJsSaver，在同一 tools
  node 并发两个同 public label 的 task。逐项记录第一 native getTuple/put config，与各自
  actual authority/Store target/内部 UI bucket 匹配，不 assert 预先猜出的 namespace 字串。
- 后续 nested task 与 scratchpad counter>0；原 parent checkpoint_map 不变，child own node
  namespace可变化，conversation仍 exact 同一个 child。错 parent ID/map、错 physical
  thread、缺 nested native config、同 label 新 invocation、ABA和过期源全部拒绝。
- 子 seed/父 channel 隔离及返回 Command 不污染 parent frontier；notice零provider，note
  自然下一请求消费，原 ToolMessage/Command goto/state tool grammar保留。
- source lease/cancel/revoke/真实 Saver ignored-abort 工作保持到 finally；注册失败无 phantom
  child，完成/取消后 agentId unavailable，archive不重建running权限。
- distinct actual projectionbucket，parent main UI零 child assistant/tool/notice；真正关库重开
  只以原持久 invocation/namespace/data proof 恢复 archive，不复用旧 authority。

以上是可落实的原生适配工作；本次无 CPU、没有声称 shared child 已运行或完整框架对齐。
