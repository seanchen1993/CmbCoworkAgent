# 文件提及准备期取消与真实请求终态

状态：只读设计，待 Root 与独立审阅。第六轮桌面 focus 的 typed、mixed、file-only
drop、忙碌 FIFO 和 reload 已通过；取消按钮的时间问题仍需原 DOM 时间线定位。本稿
不把这五个子项当整体通过，也不以新增 loading 状态代替尚未定位的 UI 原因。

## 已核实际来源与缺口

`src/renderer/src/lib/electron-stream.ts` 的 `submit` 调用原 SDK `StreamManager.start`。
当前实际 `node_modules/@langchain/langgraph-sdk/dist/ui/manager.js` 的 `enqueue` 在
调用 action、transport 和 IPC 之前设置 `isLoading: true`。`ThreadStreamHolder` 通过
真实 `useElectronStream` 订阅并把 snapshot 的 loading 交给 thread-context；
`ChatContainer` 直接以这个 loading 显示原“停止生成”按钮。structured 提交只增加
原 config 中的 composer submission，不存在另一个已证实的 preparation loading 分支。

Main `src/main/ipc/agent.ts` 在 run replacement 原 critical section 中先 claim 真正
desktop lease、建立 opaque queue owner，再登记真正 AbortController 与
activeRunSettled；随后才进入 `prepareComposerMentions`。该 preparation、Manager
Owner、权限 Scope、Activity 与 Reader 使用同一个原 signal。现 `agent:cancel`
仍经过原 thread mutation lock 和 foreign lease 门，取得该 actual controller 并 abort；
不会立即删除 activeRuns。取消准备期无需新的取消 API、来源 token 或 authority。

已核另一项独立缺口：`awaitPhysicalStreamRunSetup` 等 operation 真正完成或拒绝后，
调用原 guard 的 abandon/fail。guard 已将 `isActive` 与 `ownsLease` 分开，取消的原
controller 仍拥有 lease，因此原 release 与 owner cleanup 会运行；但 `onActiveError`
只有 `wasActive` 时报告。取消令 isActive=false，准备期尚未 handoff 到主 runtime 的
terminal finally，于是该实际 request 可以没有 Main done。renderer consumer 的本地
abort 结束不等于 Main 请求终态，Guest 的词法 sleep-finally 也不能替代这个通知。

## 最小产品窗口

只改两个生产接点：

1. `src/main/agent/physical-stream-run-setup.ts` 的原 guard factory 增加可选
   `onOwnedCancellation?: () => void`。原 close 仍先设置 closed，再保存原 wasActive、
   wasOwner，依原顺序 release、执行全部已登记 cleanup。只有整个原 cleanup 循环后，
   且 `!wasActive && wasOwner`，才调用该可选 callback。原 active error 的
   `if (error && wasActive) onActiveError(error.value)` 保持。handoff 清原 cleanup 并
   关闭 guard，之后不能回到取消通知；重复 fail/abandon 也只执行原一次 close。
2. `src/main/ipc/agent.ts` 首 invoke 创建 guard 时，仅真实
   `runExecutionContext.fileComposerSubmission` 路径提供 callback，给本次保存的
   `window/channel` 发送原 `{ type: "done" }`。channel 是原 streamRequestId 导出的
   request channel，不能改为 ambient thread 广播，也不能从当前 replacement 重选。
   resume/interrupt 及没有文件引用的原路径不提供该 callback，行为保持。

该 Main 的 isActive 定义为原 signal 未 abort 且原 queue owner 仍同地址；ownsLease
定义为 original controller 仍在 activeRuns 且原 queue owner 同地址。因此在这个
实际接点，`!wasActive && wasOwner` 确实代表仍拥有本请求的已取消 controller。
失去 controller 或 queue owner 的 predecessor 是 stale，不发送本通知。不能按异常
名字、公开错误码、Guest JSON 或对象形状伪造这项判断。

通知绝不在 signal abort listener、agent:cancel RPC 返回或 deadline shell 早拒处发送。
原 setup helper 没有新增 race；它仍 await 同一个 actual operation。Manager 原
preparation finally 必须先观察所有有限 Host/Core/protect 实际工作、Activity drain、
全部已登记 handles close，然后真实 restore query/unbind/release，才令 operation 结束。
新增 callback 只补结束通知，不跳过这些工作，不执行模型，不写 user/assistant/CP。

成功 handoff 后的原 runtime finally 继续负责同请求终态；正常 drop 已在原路径发
done，wasActive=true 不触发本 callback。未知 owner、foreign lease、已更替 run 和
late inherited entry 继续原拒门，不以结束通知赋予文件权限或恢复旧 Owner。

## 回归与实际门

`src/main/agent/physical-stream-run-setup.test.ts` 增量应明确原同 guard 的时序：真实
AbortController 中止且仍持 owner 时，held operation 尚未 physical finally 不 close、不
通知；其实际 finally 返回后，release 与全部 cleanup 先完成，再一次 done。拒绝原因
可为 undefined，判断只依所有权/取消状态；重复 close 不重发。失配 replacement
owner 不发；active error 保原 error+done；成功 handoff/正常 active abandon 不发新通知。
这组纯 helper 回归不是 Main 文件或权限来源证明。

Main 实际接线再以原 Desktop focus 验：取消段只用真实 textarea/Escape/Enter、同 Guest
有限 clock.sleep 与原 Stop 按钮；原 5000ms sleep 与 locator budget不变。在真正
sleep-entered 且尚无 finally时点击，原实际 request 必须仅一个 done、没有 error，真实
Guest/Host/Activity/handles 结算；provider 请求数及全部 durable rows、CP 保原基线。
后续 Mods OFF 原读取与模型请求也须正常，最终六完整 HTTP、八独立请求终态、全文
rows/CP/IDs/Echo 和 app-close 后检查保持。若按钮问题仍有，保持 RED并用只读 DOM
时间线继续定位，不通过减少 sleep、直接 IPC cancel或延长验收预算替代。

Root 独占 CPU。生产必须在两票设计后才原子落；Source 两票与窄实际回归、完整桌面
focus分别记录。RawCore deny 与 pending-reload 后继窗口仍等待整组 Mention 通过。

## 第七轮的真实 holder 生命周期与 renderer 修正候选

真实 DOM 时间线保存于
`output/stage24-desktop-mention-cancel-timeline-current-20261006/prompt-mention/prompt-mention-results.json`。
Stop 在 10:45:40.810 出现、41.104 消失；原 audit 前 40.935 仍有一个可点击按钮，
audit 返回 41.269 时已经没有，第二次 audit 41.575 确认真正 sleep-entered，但点击前
41.576 仍没有按钮。Main 同请求在 40.829 收到，准备约五秒后才继续模型，因此不能
归因 audit 用尽了五秒。原模块同时在 39.368、39.929、41.034 报真实 legacy checkpoint
bootstrap 失败；这些时间支持 history retry 路径，但日志没有直接记录 React mount，
不把相关时间单独当成已观测的 mount 收据。

源码已核完整可达关系：`loadThreadHistory` 每次把
`subagentTranscriptBaselineReady=false`，而 Provider render 直接用该字段决定是否挂
`ThreadStreamHolder`。holder 已以真实 `useState` 建立 transport/stream，卸载后旧
Main 请求仍工作；重新挂载却建立新的 idle stream。`handleStreamHolderDispose` 保留
旧 loading snapshot 不能保住 React 组件，新 holder 的首 false snapshot 会覆盖它。
仅在 retry timer 开始前检查 loading 不够：retry 可以在闲时已经进入 hydration，用户
之后开始真正 submit，再由这个旧 hydration 的 await 结果触发卸载/重建。

候选的最小产品窗仍在实际 `thread-context.tsx` 与必要的相邻 UI 生命周期 helper，
不新增 IPC、准备权、loading setter 或源收据。采用 **已实际挂载、已完成首次 seed 的
同 key holder 保持**，而非在 unknown baseline 上制造 ready=true：

1. ThreadProvider 的私有 continuity 表记录 actual committed holder。首次只能由
   `ThreadStreamHolder` 在原 `new ElectronIPCTransport` → 原
   `seedSubagentTranscriptBaseline` → 原 `useElectronStream` 完成，并在真正 commit
   effect 时自产 frozen empty token；私记录固定同 thread、原 managed-run key、当前
   `threadListenerEpochRef` 的原 opaque actor 地址。它不从 IPC/localStorage/message
   数据或公共 stream shape登记，没有公开 setter、caller callback注册或权限用途。
   effect cleanup 只按同 token删除自己的记录，旧 holder 不能删后继记录。
2. Provider render 仍在第一次 baseline 未就绪且无同 actor/key 的实际记录时返回
   null。对于已经 committed 的同 actor/key，只允许保留原 React key 和原组件；
   后续 history-ready=false 不再卸载该已有 holder。managed run key改变、线程
   retire/dehydrate、原 actor epoch移除或替换都不能借旧记录进入新 holder；新 holder
   必须重新通过原首次 seed barrier。未 commit 的临时 render 不得留下资格。
3. 反复 hydration 的 ready、presence、错误和 retry budget仍反映原真实读取结果；
   不将 false 改为 true，也不把 failed bootstrap认作 empty/complete。holder 的存在
   只保存同一个已初始化 UI transport生命周期，不授 Main Source、文件权或 native
   message proof。Main真实 CP/permission/Owner/FS B和 typed namespace检查全保。
4. 完整的新 subagent baseline 只在真实 hydration 成功、同 actor/key仍当前、原 stream
   **真实 idle**时交给同一个原 transport。idle判断读这个私实例原 factory返回的
   `getSnapshot` 当前布尔，不能用旧 render spread的 isLoading常量或名字/形状认
   新实例。活跃流期间不重播 constructor seed、不清其原 active/pending ID maps；
   必须等它真正结束后再合并成功读取的完整 baseline。首次 seed仍严格发生于原
   transport订阅前。具体 `seedSubagentTranscriptBaseline`的 reset语义需再逐项源审，
   如果同 transport的 idle re-seed会改变既有累计关系，应把更新收缩为当前原 baseline
   merge API，绝不在实施时自造新的 alias/namespace规则。
5. 自动 history retry可额外在原 run/wait/cancel disposition中等待真实 stream或本次
   activeTurnStartTime结束；原用户 older/target/historical intent的 cancel优先和原
   hydrate wait、250ms wait、六次 budget/退避均保持。这只是减少不必要的并行工作，
   holder连续性不能依赖它避开全部 race。idle→retry已入→submit的情况仍由第1–4项闭合。

实施前须把上面 continuity record 与 idle baseline更新的精确签名补齐、取得两票，
不能先用 ready或 loading布尔占位。新的 focused regression要钉首次 unknown barrier、
同 actor/key在 hydration false期间保持 **原 transport/stream地址**、既有 active流
首/末 snapshot与 Stop、闲时合法完整 baseline更新、managed key/actor换代及旧 cleanup
不能删后继。若只在 Node测纯过渡函数，必须明确它不是 React effect/mount证明；
原 Desktop focus继续用真实 textarea/Stop、真实五秒有限 Host工作、零 HTTP/零新增
rows/CP与精确 request done验全部生命周期。不得通过缩短 sleep、延长 locator、手造
busy或直接调用 cancel替真实 UI。

### 精确 continuity 接线与 baseline 更新

首实现不把私记录接口导出给 IPC、Guest 或其他组件。仅在 `thread-context.tsx` 的
ThreadProvider/ThreadStreamHolder 两个既有实际组件之间新增内部 commit/cleanup接点：

- actual actor仍是 initializeThread本来创建并放进 `threadListenerEpochRef`的 opaque
  对象。Provider私 WeakMap为每个实际 actor一次分配递增 ordinal，React key改为
  thread +该 ordinal +原 managed runId；history generation不得作为 key。actor替换
  即使同 thread字符串/managed runId也不复用旧 React实例。
- Holder在原 transport state initializer完成 seed、原 useElectronStream建立之后，
  首 committed effect创建 frozen record，固定 `{threadId, key, actor, token,
  transport, getSnapshot}`。token只本实例自产empty frozen对象，getSnapshot为该
  useElectronStream原返回的稳定函数地址。内部 `onHolderCommitted(record)`校核
  同实际 actor/key后把原record地址存Provider私表；返回cleanup闭包只在表内仍同
  record地址时删除，并执行原 handleStreamHolderDispose。无从调用者传入函数来
  声称 coverage的接口；这个 record也不传给Main或作为 message/文件Source证明。
- render准入只判原 ready=true，或私表记录的实际 actor/key严格匹配。读取false仍
  保false，首次无记录不挂；actor/key失配不会读取公共stream属性重建正资格。
  原retire/dehydrate移除actor、activeThreadIds删除或key变化照原卸载；旧effectcleanup
  不能删已经由另一actualrecord接管的表项。StrictMode临时render未commit不得登记。
- Holder props增加原 `subagentTranscriptBaselineReady`，不改其他 input/message
  格式。原 initial transport seed保持完全原位置。另一个effect只有该ready为true且
  该actual stream原getSnapshot().isLoading为false，才对同transport调用原
  seedSubagentTranscriptBaseline(threadId,原hydrated transcripts)。记录最后已seed的
  transcripts地址，防止同快照重复seed；active期只保latest完整props，结束后再seed。
  它不使用每render的spread isLoading作为idle校核，不清tuple/active/pending/tool maps。
  每次idle seed还需同Provider私表当前record地址、当前真实actor与managed key全部仍
  相同；旧record或已换代actor不能因旧snapshot恰为idle更新后继transport。这个比较
  不调用公开stream属性来建立新资格，也不把UI record当作Main授权。

Root 精确实施条件同时固定：没有当前实际 actor（或 actor 已 retire/dehydrate）时，
即使旧 state.ready仍为true也不得创建没有绑定actor/key的holder。commit effect必须
位于原 managed submit effect之前，让真实初始化/订阅和commit记录先完成，再允许
managed开始实际请求。cleanup不仅按same record删除；若已有不同successor record，
必须直接不执行原 onDispose，避免清掉后继实际snapshot。拒绝的commit也不返回能清
别人的cleanup。active期新props只保完整最新baseline引用，原末loading snapshot确实
变idle之后再经稳定getSnapshot校核并seed，不能在仅React props更新时猜运行已结束。

已实读原 `electron-transport.ts:1580` 的 seed正文：它按原完整transcripts添加
seeded execution IDs、prompt/final signatures与原bounded prune，并不重置当前active/
pending/tool maps或创建新的parentnamespace规则。因此上述idle新baseline接线只调用
同一个原算法；不用复制算法或新增alias鉴定。原 `setFallbackIndexBaselines` effect也
保持原位置与原算法，其主消息fallback与subagent seed职责不合并。新的完整baseline
必须是原 hydration成功后 mergeHydratedSubagentTranscripts发布的对象，不拿failed/
unknown结果或renderer query的empty对象刷新实际transport。

自动retry的辅助门可在原 `thread-hydration.ts` disposition加可选busy参数（默认false）：
原hydratewait和用户older/target/historicalcancel先按旧优先级判断，只有原本run时
busy变wait。Provider从原stream snapshot与activeTurnStartTime固定view事实提供它，
仍用原250ms等待，不增加attempt/退避预算。此辅助门不是actualcommitted记录的来源。

精确测试窗为原 `thread-hydration.test.ts`增加真实busy/intent边界，原
`electron-stream.test.ts`增加actual StreamManager+heldtransport的首loading与同stream
末结束/新baseline不重置对照；continuity token/actor/key的可测试纯过渡如果抽成相邻
helper，只输出render保留判定，不提供Source授权/外部callback注册。原真实React
effect/同mounted实例仍由本次Desktopfocus验证；不得把SSR没有effect的render称成
commit证明。实现冻结前将准确文件/定义数交两位Source审，Root独占所有实际门。
