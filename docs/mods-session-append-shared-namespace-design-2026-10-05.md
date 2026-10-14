# Stage23 共享子任务的真实会话接线设计

日期：2026-10-05。开发树 `C:/ai/CmbCoworkAgent-mods-v2`；UAT 只读。
状态：待两位独立正式评审。这是实施合同，不表示 shared child 已通过运行验收。
依据：[实际 namespace 研究](mods-session-append-shared-namespace-research-2026-10-05.md)、
[原生接线设计](mods-session-append-native-wiring-design-2026-10-05.md) 和已获双评审的
独立 child family 实施。编写期间未运行 CPU 测试。

## 用户得到的行为

主代理启动一个真实共享子任务后，可以向其本次实际 agent UUID 保存 note，或读取本次
子任务的消息。子任务调用 append 时省略 agentId，仍保存到原 parent family 的 main；
明确本次 UUID 才保存到 child。原工具、模型、文件限制仍由 child 自己的权限决定。
两个同名并行 task 是两个目标，不能互借消息、模型权限、checkpoint 或 UI 记录。

共享子任务的 Saver 可以和父线程共用物理文件，但自己的 graph namespace、会话目标和
UI 记录独立。不能因为 Saver 使用父 thread_id，就把子任务回复或通知插进主聊天。

## 原生捕获时序

1. `wrapTaskToolWithOwnerMetadata` 收到实际 ToolNode config 后，在第一个 await 前固定
   actual task invocation object、原 config 数据及实际 producer 闭包。`runModTask` 向
   `withSharedAgent` 转交此宿主回执，不将它放在 metadata、SDK 或 IPC JSON 中。
2. `withSharedAgent` 先核原 parent runtime/graph binding，再按已有 access 分支建立真正
   child authority。只有已知 native spec/runnable factory 可获得新的 conversation adapter。
   未知 opaque runnable 保留旧执行行为，不推断新 SDK backend。parent capture 使用现有
   WeakMap family proof；actual child authority、epoch、owner、信号保持原限制。
3. 已知 child runnable 输入 wrapper 克隆实际普通 state，去掉父
   `cmbFunctionConversation` 字段，保留原 seed HumanMessage 和其余 state；不改变 config
   的 scratchpad counter、task ID、read/send 或 namespace。将原 config 的实际
   `__pregel_checkpointer` 换成本次私有 router 后，恰一次调用原 child graph。
4. router 的第一次**真实 child graph 初始化 getTuple** 是 namespace 捕获点。LangGraph
   此时已处理原 scratchpad counter/有效 checkpoint_map，又尚未应用 input checkpoint。
   固定实际 `thread_id`、最终 graph `checkpoint_ns`、原祖先 map 和确切可选恢复 ID。
   不人工 getTuple 预读来取得 namespace，不 split 字符串、不拼 agent 名或 tool call ID。
5. getTuple 委托原真实 SqlJsSaver，返回后核实际 config/tuple。在 input checkpoint 之前
   登记本次 immutable child ref/backend、真实 graph initial/restored state 和独立 UI bucket。
   首次 null 仅当实际原 native query 返回 null 时可作为新 graph；无旧 channel 的旧 tuple
   需走原 verified legacy migration，不能冒称空历史。query/registration 失败封本次
   admission 并 retire 已建私有 alias，不能再以同 invocation 建第二个 child。
6. child beforeModel 和后续保存只用同一 captured target/router；返回父 task 的 Command
   排除 child conversation channel，保留真正 ToolMessage、goto/resume/graph、其余 state。

首次 getTuple 的可信来源是实际 factory 的调用地址和当前私有运行回执，不是 config
形状。router 不交给其它 sibling、插件、renderer、查询 API 或任意公开 Runnable。
原 native callbacks/source guard 抛出错误原样传递，不降级成冷 main 或读取 latest。

## 私有 router 与 checkpoint 身份合同

新模块建议为 `src/main/mods/v2/conversation-shared-checkpointer.ts`，提供宿主工厂：

```ts
interface FunctionConversationSharedInvocation {
  readonly invocation: object
  readonly parent: FunctionConversationChildParent
  readonly authority: ModRuntimeAuthority
  readonly saver: SqlJsSaver
  readonly parentConfig: RunnableConfig
  readonly checkpointIncarnation: ThreadIncarnation
  readonly signal: AbortSignal
  assertCurrent(): void
}

interface FunctionConversationSharedCheckpointScope {
  readonly checkpointer: SqlJsSaver
  run<T>(invoke: () => Promise<T>): Promise<T>
  // Only the factory-installed native middleware calls this method with actual runtime config.
  captureNode(runtime: FunctionConversationGraphRuntime): FunctionConversationGraphBinding
  close(): void
  whenDrained(): Promise<void>
}
```

工厂对实际 `SqlJsSaver` 使用受控 proxy：保留真实 serde/default version/list 等功能并绑定
原 native this；getTuple、put、putWrites 等地址只选择本次已捕获 namespace。原父 root
Saver adapter 不被覆盖。SDK/Guest 不见 router/receipt/function。实际 child router 可包裹
原 SqlJsSaver，但 DeliveryBridge 的原生 put observer必须绑定其真实 underlying instance，
不能把已有 parent facade 当作 native commit receipt 的来源，也不能将 root observer
复制成 child ACK。宿主类型不能因方便而把未知 checkpointer 强转 SqlJsSaver。

第一次 getTuple 同步固定输入副本后检查：

- 原 actual authority/current registry identity、parent family/ref、scope/epoch、physical
  lease/incarnation/信号仍有效；physical thread 与 captured parent config 完全相等。
- 私有 `run` 的 actual invocation scope 与原 tool config 来源一致；原
  `__pregel_read`/scratchpad 的实际对象来源保持，原 ancestor map 每项与捕获值相等。
  这些内部 function/object 不序列化，公开 agent UUID 仅作已登记索引。
- 最终 namespace 由本次真正 nested graph 初始化产生，不能等于 parent graph namespace。
  原始 tool-node namespace和最终 child namespace可以因原 counter 不同，不要求猜测相等。
- 原 map 中存在该 child namespace 的恢复 ID 时，getTuple必须使用同一 exact ID；不存在
  时只使用原 native 初始化行为。已捕获 exact ID 的恢复查询不得降级成无ID/latest。
  新的实时 API读取可以捕获本次原native query返回的当前快照，但不能用它修补旧proof。

对后续 getTuple/put/putWrites及 native middleware，固定相同 thread/namespace和原祖先
map entries。只有这些原祖先项要求始终与捕获值相等；本 child graph自己的 namespace
项随真正 native node/put 推进，必须由本次 actual planned/read receipt逐项验证。
不能把会推进的 own entry强制恒等旧ID，也不能反过来仅要求它是一个string。
child node 的 namespace包含真正内部 node 身份；它与 Saver graph namespace不同，不能
给每个 node 新建 conversation，也不能削掉后缀猜归属。

### 计划保存与真正成功保存分开

LangGraph 的 async durability 可能先让 node 运行，前一 native put 仍在排队。因此 node
map 中自己的 checkpoint ID 不能要求已经 COMMIT，也不能只用字符串集合证明来源。

- 从首次实际 read tuple 得到的 ID 是 native read fact。
- router 实际 put 入口捕获完整 checkpoint object/id/config，是 native planned fact。
- 若 node 已先运行，只有 factory 在其真实 graph 上安装的 middleware 接收本次 actual
  runtime.configurable，才可经私有 captureNode 登记本次 native planned-node receipt。
  它绑定真实 child authority/router、该 actual config object、native read callback 及完整
  original parent map；不允许外部以普通参数调用这个 capture 创建 proof。持久/公开
  channel 不能提供此回执。后续实际 put 须核对应 ID 和本次来源，未发生 put 不产生 ACK。
- successful delivery/membership仍仅来自 actual SqlJsSaver 同 gate 的 committed observer；
  planned-node proof不给 inbox consumed、repair、fork 或 canonical checkpoint recovery授权。
- 原 child callback/middleware所得 binding 固定本次 object 和 guard；不在 await 后从
  manager 查最新同 agent label/router。异步 source退役时不借新scope。

若依赖实际构造无法证明 planned-node 地址，应在新真实 Graph测试中找 native计划接点，
不改成只验 `typeof checkpoint_map[ns] === 'string'`，也不因未COMMIT误拒正常子任务。

## Families、Coordinator 与主入口职责

Families 给独立/共享成员使用严格 discriminated union。共享成员按真正 authority object
索引，因为多个 child 共用 physical thread；不能重用当前独立 child 的 thread-only map。
共享登记固定 parent proof、invocation、actualauthority、真实 Saver physical incarnation、
独立 transcript destination 和已捕获 graph namespace。检查 child authority 的
workspace/thread/current identity/agentId/turn，以及原 parent owner/ref/branch/lease。
不要求它拥有独立 child 的 `mods` thread lease，不伪造租约；应使用原 shared factory
捕获的 parent actual physical lease和原 child运行 guard。

Coordinator 新接口建议：

```ts
registerSharedChild(
  parent: FunctionConversationChildParent,
  input: FunctionConversationSharedChildInput
): { readonly binding: FunctionConversationGraphBinding; close(): void }

captureSharedRuntime(
  authority: ModRuntimeAuthority,
  actualNode: FunctionConversationGraphRuntime
): FunctionConversationGraphBinding | undefined
```

`FunctionConversationSharedChildInput` 必填实际 invocation、authority、checkpointThreadId/
checkpointIncarnation、graph namespace、原 query tuple/新graph证明、private router capture、
固定 UI destination/incarnation/signal/guard。字段均来自上述 native factory；实际 namespace
不能由SDK selector提交。登记使用原 parent resident 的 Registry.registerChild，target
logical family与原parent相同，checkpointphysical明确为原共享 Saver thread。

当前 CoordinatorHost `readCurrentCheckpoint(threadId,signal,guard)` 缺namespace和exact
source proof；共享实现不得用此thread-only入口。新增由 target privateWeakMap保存的
native checkpoint reader，固定原 router/namespace和当次actual read/capture；API读取用
它的真实 `getTuple`/state/native membership，不能重新从公开 agentId生成 config。
独立和main旧reader合同不因此改成任意用户可选 namespace。

Root 的 `withSharedAgent`、task config/runnable/middleware与主 Saver触点负责传上述实际
对象；本代理负责新router、Families/Coordinator对应接口，不并发覆盖root production。
source方案获两票前不修改runtime/Manager或现有消费源码。

## 独立 UI bucket 与生命周期

共享 factory 为每本次 invocation 创建真实 internal transcript thread/bucket及incarnation，
metadata使用宿主固定的内部类型、原parent关系、workspace和本次UUID；只作显示投影，
不创建 runtime/模型或人类提交/写租约。实际 internal thread从普通线程列表隐藏沿原
internal规则。fixed destination.conversation 必须精确等本次 child ref，writer/verifier
同时固定该实际bucket；parent thread UI零child assistant/tool/notice。

创建失败、无映射或bucket替换明确 unavailable/整事务零写，不能回退parentUI。原 child
结束先关闭新 admission、retire target及live authority alias；保存过的bucket/keeper数据
按原parent历史生命周期管理，历史数据不是运行权限。archive仅在另外真实持久proof
具备时开放，不能凭公开UUID复活append。具体清理与父删除须使用原私有mapping，不按
字符串扫描任意线程删除；不能在仍被宿主真实finally持有期间关库/删数据。

router单独记录真正getTuple/put/putWrites/observer/serde工作直到实际finally。
`close()`封新操作并abort，不假定原Saver忽略abort的工作已经退出；Root必须等
`whenDrained()`终态再释放本次childauthority/ownedresources。取消不提前归还mutation额度。
必要的新运行或新instance只拿新receipt，不能复用旧closure。原ToolNode并行批仍原并行。

## 完成门禁

- actual createAgent/createSubAgentMiddleware + SqlJsSaver + localhost HTTP：同 tools node
  并行两个同名task，记录真实首次getTuple/put配置而不猜ns；实际scratchpad counter>0、
  nested task、parent原map与ownplanned/committed IDs保持精确。
- actual input和Command isolation：父channel不进child，childchannel不回parent；原seed/
  ToolMessage/goto/resume/非message state/结构化结果保持，模型与工具次数不增加。
- main/default与exactchild note自然下一HTTP一次、systemnotice所有HTTP零sentinel；原
  child工具/模型/文件权限不因conversationfamily借main许可。
- 两shared实际内部bucket、同label新invocation、shared+independent混合、跨parent/config/
  checkpointmap/authority/leaseincarnation/ABA/copiedreceipt都不可互借；parentUI零child行。
- asyncdurability真正heldput：node可按actualplannedreceipt运行，inbox consumed必须等
  同gateactualCOMMIT；失败/取消/ignoredabort/revoke真实finally，unknowncommit不重发。
- registration/query失败无phantomrunningchild；completed/取消selector不可写；旧普通task/
  opaque runnable/Plugin项目/Harness/Goal邻域保持，缺adapter不启动额外插件或coldSaver。

上述门禁由Root统一运行并记录实际scope；基础或静态PASS不代称全部共享子任务已实现。
