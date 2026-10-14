# Stage23 原生消息保留点接线附录

日期：2026-10-05。开发目录 `C:/ai/CmbCoworkAgent-mods-v2`；UAT 只读。

这是下一组生产接线的方案，不是各门已完成的声明。SDK note、当前输入 intake、实际
Saver delivery/membership 和原生 keeper 各门分开验收。本附录需 Latest 与 Legacy
独立评审后实施；本文编写期间未运行 CPU 测试。

## 固定契约及现有基础

固定 2.1.289 声明 `SessionAppendInput` 明确：事件只提供可重写的公开内容；原生
structured tool record、时间、parent links、来源和附件 payload 不在事件中。`door`
由实际产生该行的站点决定，不能从一个事后 messages 数组的 role 或文本推断。

当前可复用的真实基础：

- `v2/manager.ts.appendConversation(workspace, thread, ticket)` 是 loaded-only 入口。
  无 resident 时只执行同一 ticket 的真实 core，不启动插件或制造 ACK。
- `session-append-ticket.ts` 固定一次 core、原 target/source/signal，保护后再校验，
  Store commit 与完整读回后才接受 ACK；post-commit 错误不回滚、不重试。
- `db/function-conversation-store.ts.commit` 用实际 app DB，keeper 与不可变 transcript
  projection 同事务。`sdk:false` 不受 SDK 的 1MiB 内容截断规则。
- `db/function-conversation-transcript.ts` 固定完整 logical ref、actual physical
  destination/incarnation/guard。工具写入只接实际 `ToolMessage`，UUID、原 call ID、
  `tool_use_id`、完整 native payload 必须一致；child 缺实际独立 bucket 不写 parent。
- `agent/function-conversation-native-message.ts` 保留实际 LangChain class、完整内容及
  AI/Tool metadata；renderer/stream 的缩略文本不是重建原生消息的材料。
- `function-conversation-delivery` 与 membership 使用真实 Saver 同 gate 的 exact
  commit receipt。app DB 与 Saver 文件是两个 DB，不能宣称跨两者原子提交。

本次新增事件流取消适配实际窄测已由 Root 运行：
`output/stage23-native-membership-events-first.log`，8 文件 95 项 PASS，包括
6 个 helper、10 个 invocation 和实际 graph 第三模式/held getState cancellation。
它证明输入/取消接缝，不证明本文列出的所有 producer 已接线。

## 私有 retainer，不使用字符串造来源

建议新增 `agent/function-conversation-native-retainer.ts`，由原 runtime/transport 工厂
创建实例；调用方在第一个 await 前捕获 actual producer closure、原 graph binding、
完整 target/branch、physical authority 或原 native lease、signal、incarnation 和原
scope guard。public SDK、IPC args 和已保存 stamp 都不能创建该实例。

私有 admission 包含 actual row occurrence 与 stable producer identity；UUID 在该真实
producer 建立完整行、尚未提交时固定。已有 provider ID 先走现有 occurrence/alias 规范，
使用实际保留的 stable row ID；不能按正文合并，也不能每次 values replay 给新 UUID。
parent/ordering links、原 tool/provider metadata、实际 `agentId` 和目标由宿主固定。
外部 row JSON 不能带调用证明。engine source 不以公开 event/label 代替实际工厂对象。

每个原生 admission 同一个 once Promise；以下顺序不可绕过：

1. 固定完整原生 serializer 输出及真正 producer door/origin，校验原 source/target。
2. 若公开投影可完整满足现有 Hook 预算，建立 native Ticket，调用 loaded-only append。
   Hook 只改允许的 `content`；缺字段补回原固定事实，非法候选在 claim core 前拒绝，
   optional 恢复仅回同一原行。guest `{message,uuid}` 不是保存证明。
3. core 根据已保护公开内容生成**同一原生 class** 的新实际 message，保存原 UUID、
   tool ID/call ID、provider tuple、usage/artifact/response metadata 与 parent links。
   不能把 ToolMessage 降成 HumanMessage。Tool result 的内容/错误呈现可改，但真实执行的
   `ToolMessage.status`、artifact 和原 structured tool record 始终固定，完整 native codec
   仍保存原执行事实。公开 `tool_result.is_error` 只保存为独立呈现/出站 projection 字段，
   不能反写真实 status。若 provider 需要此错误呈现，由明确 adapter 消费已核 canonical
   public rendering 与实际同一 tool occurrence，修改出站呈现；不得用公开 stamp 造授权，
   不改 native execution record，也不让 API/renderer 的呈现再成为 keeper 输入。
4. 最后同步 source/target 检查、Store + projection 同 app DB 事务、strict canonical
   join。保存后即使原 owner 失效仍保留数据，旧调用 ACK 拒绝。
5. 返回同一个真正保留的 message 给原 graph/原 producer；不额外 invoke/stream。
   原 native checkpoint 的成功仍由 Saver receipt 证明，不由 Ticket ACK 代替。

graph checkpoint 后续失败时 app DB 已保存事实不撤销。需使用原 UUID/branch 的 pending
retention journal 与 exact checkpoint membership 恢复；不能 rerun Hook、再次执行模型或
工具，不把未入原 checkpoint 的未来行强塞到历史 cut。重放、hydration、export 和
普通 stream flush 只消费已保留事实，不成为新的 append 入口。

## 大原生行与公开 Hook 预算

现 Ticket ctor 和公开 validators 使用 ModJSON 1MiB/depth32/nodes30000；不能把一个更大
原生行直接交 ctor，再把其拒绝扩大成普通任务失败。新增 retainer 必须把公开可用性与
原生完整保存拆开：

- native class/UUID/call/provider 原始数据无效是实际 producer 错误，不当成超限隐藏。
- 完整公开投影仅因公开字节/深度/节点或无法无损表示而不可用时，明确跳过该行的
  `session.append` Hook，执行同一原生 protected core；不构造截断投影、不把子片段分别
  当完整 append、不为缩略结果伪造 ACK。
- 该路径沿用原生产管道的内容保护及原 owner guard，完整 native serializer 与 canonical
  row 不截断。若当前原生管道已保护内容，复用其已验证值；不能借 Hook unavailable 绕过
  强制保护。新的保护 adapter 若不能处理完整行，应在独立内容保护契约中解决，不把
  1MiB SDK 上限施加给普通 LangChain 任务。
- no resident、没有 append handler、公开不可用分别记录固定的 availability reason；
  均不 cold-load 插件。native 核心结果和 Hook 公共结果的类型不能混作一个 ModJSON。

须补 >1MiB AI、Tool（artifact/metadata）、media 原生回归：普通任务/真实后续 HTTP
保留完整内容；Hook 0 次，canonical bytes 完整；保护仍生效、无放大权限、无重跑。

## 各门的实际站点

| Door | 实际 producer / 要接的保留点 | 固定来源与接线约束 |
| --- | --- | --- |
| `prompt` | `ipc/agent.ts` 普通接纳分支，最终 `userHumanMessage` 建立后、真实 `agent.stream` 输入前；`standard-turn-stream.ts.persistStandardTurnUserMessage` 的 managed transport 对应分支 | desktop 用实际 composer submission；plugin prompt 用已私有验证的 host prompt origin；IM/Goal/auto 等用真实 transport/run context。raw display 与 effective model payload 保持既有差别，同一 user UUID，不按 `/goal` 文本升级来源。已持久 user 行不可再由 stream flush 新开 Ticket。 |
| `command` | `ipc/agent.ts` 真正 non-starting control/local command 分支；`v2/command-scheduler.ts` 和原 command job 完成接缝只在宿主实际决定保留 conversation 行时接 | 捕获本次 command binding/结果对象。命令 UI job 表不等于 conversation；只显示的旧 job 不伪造模型 user 行。保原返回 id、按钮、取消与 job body；要加入 canonical command notice 时沿实际 once producer，而非猜文本。 |
| `response` | 新 runtime middleware 的 actual model handler 完整返回后、向 graph 返回最终 AIMessage 前；位于现有输出保护/完整性恢复的明确顺序内 | 来源来自本次 actual model invocation 的真实 resolved model ID；UUID/完整 tool_calls/usage/response metadata 固定。需要消费真实完整 message，不用 `message-delta`、renderer 纯正文或 final answer 字符串。主/child 用本次 actual graph binding，不重取 main。 |
| `tool-result` | `agent/tool-hooks.ts.createToolHookMiddleware.wrapToolCall`：原 handler 一次返回、PostToolUse/输出改写后、返回 graph 前；对 native `Command.update.messages` 选确切 paired ToolMessage。MCP 分支 `runtime.ts` 的等价最终返回点 | 原 request 的实际 tool binding、tool name、tool_call_id 和 runtime 固定。先执行真正工具及既有 hooks，再 append；append 失败不能再调用 handler。已被 native recovery 替代的错误 ToolMessage 用恢复后真正被保留的值。 |
| `tool-message` | 同一真实 tool handler 返回的 `Command.update.messages` 中额外完整行，或工具明确交付的旁行；由该返回契约逐项登记 | 门由 handler 的旁行返回地址决定，不由行 role/name 推断；原 Command graph/resume/goto/update 其他字段不改，paired result 不再重复归此门。UUID/native class/parent/call metadata 仍 fixed。 |
| `delivery` | `runtime.ts.setCurrentRunInjectionNotifier` 对真正 steered queued user 行；workflow/coordinator managed delivery 在真实 claim 到特定 run/result、生成最终 HumanMessage 的分支 | 固定实际 queue message/run token 或 claimed transport delivery receipt。当前注入会先 flush 前面的完整 assistant occurrence，再写 user；必须保实际 anchor/order。通知触发 marker 只是输入语法，不是权限证明；实际 claim 决定 door/origin。 |
| `attachment` | `runtime.ts.createOutputStyleTurnReminderMiddleware` 等真正附件 producer，以及实际文件/记忆附件在 native framing/录制 payload 前的保留分支 | 复用 `mods-prompt-attachment.ts` 捕获的 actual runtime/producer occurrence。prompt.attachment 先完成，随后 session.append 重写录制 rendering，不改原 payload。**当前 output-style reminder 仅临时 request clone，不在 graph messages 中**：需显式 retained attachment record + request consumption；不能事后把整个 user/tool row 再标 attachment，也不改原更高优先级位置。 |
| `hook-context` | `runtime.ts.createSkillHookContextMiddleware` 的真实 `drainSkillHookContexts` 及 UserPromptSubmit/PreSkillUse/PostSkillUse 的实际 additional-context 归属分支 | 目前 Skill Hook Context 仅 `request.systemMessage.concat`，不是持久 graph 行。需该 producer 创建独立 recorded rendering/payload receipt，保持原 request system 位置/信任边界；retainer 不能把任意 system prompt 当 session notice，也不重复向 effective user text 添加同一段。原 hook event/实际结果对象决定来源。 |
| `compaction` | `agent/context-summarization-middleware.ts` 真正 summary message 形成且即将被返回为 state update；`context-compaction-hooks.ts` 的实际 compactionId/commit receipt 用于最终确认 | 私有 compaction controller pending object、原 summary model invocation 和原 namespace/cut 固定。只保真正被采用的 summary/boundary，不 append 被丢弃的 precompute，不把中间 summarizer response 当普通 response。Post receipt 不重跑修改；先改 retained summary，再原 Saver 保存并确认 membership。 |
| `notice` | `ipc/agent.ts.emitGoalNotice` 及原 engine-only notice publisher 的真实保留决定；SDK system note 仍属于 `note` | 实际 native notice source/subtype/UUID固定；系统行无 model role，不能加入 request。Goal 原有 event 表/卡片/控制副作用保留，不能以新泛化通知替换原 Goal 呈现或改变按钮/状态；专用 display producer 必须与 canonical system row 同 ID 去重。纯 toast 非 conversation notice。 |

`note` 已接 SDK，不能拿它代替缺失 native 门。`stream-converter.ts`、
`stream-transcript-flush.ts`、`StandardTurnStreamConsumer.observe` 和 checkpoint restore
是消费/投影站点；不得从这些位置扫描 role 并重新触发所有 append hooks。

## 身份、顺序与持久投影

真实 final model/tool keep 需要在原 graph reducer 前保留结果。新 retainer 持有实际
caller authority/signal；source 退休先封新调用，再等真实 work finally，不把当前 main
resident/相同公开 agent label 当替代。child 有独立 physical thread 时使用已有 factory
mapping；shared child 未接实际 namespace +独立 UI bucket 仍明确 unavailable。

首次迁移已显示 user/assistant 的 native projection 不能让 immutable writer 与既有
stream row 冲突后无限重试。retainer 接入顺序必须先捕获原 occurrence、flush 旧 partial，
在同 app DB 事务核原 complete projection/alias 后采用 native stamp；若需新增私有
`adoptExistingNativeProjection`，只允许原 run 的 native receipt，核完整 role/UUID/tuple、
全内容 projection 和无未来 fragment，不能借 renderer `function_row`。旧流消费随后
只允许与该 canonical 行相同的 echo，不降级已保留优先级；不能把已保护内容改回旧 raw。

这项 existing-row adoption 尚未实现，须独立审查具体源码/真实 SQLite 回归，不删
immutable writer 的 existing conflict 断言来获得测试通过。

## 分批实施和验证

第一批：原生 retainer / bounded availability / 完整 native class adapter / existing-row
adoption 基础，随后实际 `prompt`、完整 `response`、`tool-result`/`tool-message`。
第二批：实际 current-run delivery、managed input、command 与 notice。
第三批：retained attachment/hook-context payload record、actual compaction boundary。
每批保留精确不足项，不把暂未接线称框架限制或已覆盖所有门。

最低回归：实际 LangGraph/SQLite + localhost HTTP 验证各门一次、原文本改写实际进入
后续请求、metadata/call pairing完整；两 live child、主调用/独立子调用与真实 shared
namespace；same-ID replay、同正文不同 ID、provider occurrence碰撞；重复 next/假 ACK/
optional failure/native deny；内容保护 await 后撤权/ABA/换 branch；未知 COMMIT 无重试；
tool effect计数1且保存失败不重跑；大行完整；idle notice零请求；各入口 invoke/stream/
streamEvents、queued steering、恢复/fork只读不 rehook。renderer/standard IM/project/Goal/
原 Plugin/Harness 单独回归，不能用统一 fake core 代替实际 keep 点。

工具错误呈现必须单独验证：原 `ToolMessage.status` 为 error，Hook 将公开 `is_error`
改为 false 后，实际 provider 请求只采用已核出站呈现，canonical native codec/status、
artifact、原 call ID 与 structured execution record 仍保持 error 原事实；真实工具执行
次数 1。反向改写也同样不能捏造一次实际执行失败。该 provider adapter 尚待接线和验收。

## 已存在原生投影的采用合同（新增，待两票）

本节细化前述 existing-row adoption，尚未实施或运行测试。它不改变普通 immutable
writer 的 existing-conflict 语义，不允许 Guest、renderer、历史 values 或公开 stamp
调用采用接口。第一批 retainer 接线须先实现本节的真实事务和晚流防线。

### 已核实际存储接缝

`db/index.ts.insertFunctionConversationThreadMessage` 只插新行，现有 UUID 或 provider
occurrence 冲突均拒绝；继续保留此规则。`createFunctionConversationTranscriptAccess`
只承认既有完整相同 canonical stamp/projection，并核 fragments 为零。它不能把原先无
stamp 的 user 行或 partial assistant 当作已提交 keeper，也不能用可见正文相同代替证明。

现 `upsertThreadMessagesCore` 会更新既有行正文、工具字段和时间，却不先检查
`function_row_json`；`appendThreadMessageTextDelta` 和 `replaceThreadMessageId` 也没有
canonical 禁写条件。仅提高 `content_priority` 不能防止晚到 authoritative snapshot、
alias 或 delta 改回 raw。三个实际写口必须与新 retainer 同批加 canonical 防线。

`ipc/agent.ts` 的 `pendingStreamTranscriptMessages`、assistant identity、tool accumulators
按真实 thread/runToken 管理；`persistStreamTranscriptChunk` 检查当前 native run owner，
`flushPendingStreamTranscriptMessages` 按实际 provider occurrence 解析并写行。现有
`stream-transcript-flush.ts` 的文本前缀只用于合并，不证明某个 model completion 拥有
该数据库行。既有 alias map 是 `index.ts` 私有宿主状态，不从收到的 metadata 重建。

### 一次捕获，封存实际 occurrence

真实 producer 得到完整最终 `BaseMessage` 时，在第一个 Hook、保护或数据库异步等待前：

1. 捕获原 actual producer binding、runtime authority 或 native 接纳租约、run object/
   runToken、thread incarnation、完整 logical target/branch、physical destination、signal
   及原 guard。pre-runtime 普通 user 使用本次已接纳原生发送租约，不制造 main authority。
2. 通过本次 run 的原生 message identity 路由固定真正 stable UUID/provider tuple；若原
   native ID 与 stable UI ID 不同，由实际一次 identity adapter 同步生成同 class 的保留
   message，固定原 provider ID/occurrence，并让原 graph 接受相同 stable UUID。不得只改
   UI ID、事后猜 suffix，或把同 provider ID 的上一 run occurrence 当本次消息。
3. 同步 seal **该实际 occurrence** 的 transport 写入地址，再严格 flush 此 occurrence
   已在本次 run 缓冲的合法 partial。seal 不封整个线程，其他消息/note 仍沿原规则运行。
   后续该 occurrence 的旧 token chunk/values 只等待或消费本次 seal 结果，不再入旧 buffer。
4. flush 完成后、Hook 前，从实际 app DB 捕获 immutable receipt：原 DB object/generation、
   actual thread incarnation、完整 `SELECT *` 原行或确切 absence、原 ordinal、相关 alias
   entries/revision、provider 冲突查询结果、按真实 fragment_id 排序的全部 fragment rows
   及 fragment state。保存真正原 UI projection 和完整 native serializer，分别校验。
   普通 user 的 raw display 与 effective model text 本来可不同，不能要求二者正文相等，
   但必须来自同一次原生发送/投影 binding；public text/ID 不提供此关系。

receipt 用私有 WeakMap 注册实际对象；传相同字段的克隆、跨 run/child/branch、旧 DB
generation、租约 ABA、另一个同 label invocation 均拒绝。只有实际原 producer 可 seal；
不允许 renderer 发一个 UUID 来冻结任意行。已 canonical 同 UUID 的 replay 直接读取原
retainer once 结果，不重新 Hook、保护或从可见快照创建新 admission。

### 最小私有接口及所有权

接口名称可按实现调整，权限及顺序固定：

```ts
// Native factory minted; never a wire/ModJSON type or publicly constructible field record.
interface FunctionNativeOccurrenceReceipt { readonly nativeOccurrence: unique symbol }
interface FunctionNativeProjectionReceipt { readonly nativeProjection: unique symbol }

// The runtime/transport factory seals the actual occurrence synchronously.
sealNativeOccurrence(actualBinding: object, actualMessage: BaseMessage):
  FunctionNativeOccurrenceReceipt

// Root owns the real flush/alias/database capture seam; no Hook executes here.
captureNativeProjection(occurrence: FunctionNativeOccurrenceReceipt):
  Promise<FunctionNativeProjectionReceipt>

// Called only inside the Store's original app DB transaction, with no await.
adoptNativeProjectionInTransaction(
  projection: FunctionNativeProjectionReceipt,
  target: FunctionConversationRef,
  row: FunctionConversationRow,
  protectedProjection: ThreadMessageWrite
): void
```

私有 occurrence/projection 类型只作不透明参数，`unique symbol` 标记本身不是证明；实现
仍须查实际 WeakMap、原 factory object、原保存的字段/guard。Root 负责 `index.ts`、alias、
stream seal/flush 和 transcript access；独立 `function-conversation-native-retainer.ts`
持 once、完整 class adapter、公开可用性和 host-only protector/writer 回调。不能在纯
retainer 里假造实际 source、DB commit 或 flush 成功，单模块测试不代称 native doors 已接。

`createFunctionConversationTranscriptAccess` 可增加私有 adoption 参数：write 只在取得
真实 projection receipt 时走采用分支；未带 receipt 保持当前 insert-or-exact-verify。
verify 必须同时核 fixed receipt 的 destination、canonical keeper row/stamp、最终所有
projection fields 和原 ordinal；SDK note/普通 public writer 不获得此参数。

### 同一个 app DB 事务的 compare-and-adopt

Store 的原事务先核 source/target，插 keeper row 后调用同步 adopter。adopter 再核当前
DB/transaction/incarnation、captured full logical ref、run/lease/alias guard，然后：

- absence receipt：实际同 UUID/provider tuple 仍不存在，沿原 immutable insert；若后来
  出现一行则整事务 conflict，不把它当可采用的新 baseline。
- existing receipt：当前原行每个已捕获 column、ordinal、原 stamp/prompt origin、provider
  tuple、全部 fragment rows/state 和相关 alias 状态必须完全等原 receipt。任何内容、
  alias、时间、工具状态或 incarnation 改变均整事务 rollback；不可 await 后 recapture。
- 只替换获准的受保护 rendering fields，如 `content_json`、明确保留的 reasoning 和
  独立 `is_error` 呈现；UI 工具 body 的允许内容改写通过 actual paired call adapter。
  `tool_calls_json` 的实际 call ID/结构化执行参数、`tool_call_id`、原 native status/name、
  provider tuple、goal/active-window、created/start/end、prompt_origin、ordinal 均保留。
  原完整 class/tool metadata 仍在 canonical native codec，不能用 UI clamp 重建它。
- 对本次采用行写入新 canonical stamp，把受保护完整 UI snapshot 写在原 message_id 上；
  删除已核该行 fragments/fragment-state。message_count/next_ordinal 不加一，不把原行移到
  末尾，不影响其他新 note 的顺序。keeper sequence 与 UI ordinal 是不同事实。
- 最后 no-await verify 核 canonical keeper 的完整 receipt/native payload、全 projection/
  stamp、固定 ordinal、fragment 零残留和 alias 没有改指其它行。所有写失败同事务 rollback。

UI 的已有真实展示上限继续诚实；canonical native codec 无截断。若 UI 需要缩略，缩略
只属于明确的 display projection，不得回填 graph/keeper 或用于 canonical payload hash。
现 `projectFunctionConversationThreadMessageStorageColumns` 会应用 UI normalizer；采用
不能用它生成 null prompt origin/新时间后覆盖原固定列，须显式融合原 full-column baseline。

receipt 从 `open` 进入 `claimed` 后只保留同一个实际 commit Promise。正常 COMMIT 后以
原 UUID/input digest/完整 row + mandatory projection verifier 读回；未知 COMMIT 必须先
确认原 connection `inTransaction === false`，只查原 exact key + actual canonical join。
未确认不重发、不补第二 UUID、不把 current connection 的未提交可见行当成功。
post-commit source 失效拒 ACK，但不清已存 keeper/投影。实际 host work 一直计到 finally。

### 晚流 echo 和普通写口

采用前 seal 暂存/拒绝的旧 occurrence 数据，在实际 commit receipt 成功后转为只读 echo
消费；丢弃原 raw rendering，不重 Hook、不再 append fragment，也不把原无 stamp snapshot
重新广播成健康正文。提交失败/取消保持原错误和真实终态，不借旧 raw flush 发成功 ACK。
原工具/model side effect 不重跑。其它 occurrence/线程/新的 run 不受此 seal 影响。

数据库最终防御不依赖内存 seal：

- `appendThreadMessageTextDelta` 查询并拒已存在 canonical/invalid stamp 行；对应私有
  seal consumer 明确消费晚 echo，不能把返回 false 的已采用 delta无限放回 retry buffer。
- 普通 upsert 遇已 canonical 行时不改任何 canonical 字段；实际私有原 run echo 可
  no-op 消费并返回明确的 consumed outcome，公共普通快照不能授予这种 receipt。可见
  正文恰相同也只允许 exact read/no-op，不替换 stamp/metadata。损坏 stamp fail closed。
- alias/replace 操作在**记 alias 之前**检查 source/target canonical，拒重命名/合并；
  adoption 已固定 stable UUID，后续历史 provider alias 只经私有既有 map解析查询，不能
  改 keeper UUID、checkpoint membership 或跨不同 occurrence 迁移 canonical 行。
- 消费端的 late raw renderer values 也使用原生 seal 路由输出 canonical safe snapshot 或
  已消费事实；不能仅保护 DB 而让旧消息事件把当前卡片临时改回 raw。display hydration
  永远从已核 canonical 行恢复，不产生新的 append admission。

seal/replay map 以实际 occurrence object 为键，单 native run 最多 256 个尚未终结 admission，
超限在本次 producer keep 前明确拒绝；已 ACK 数据不驱逐，durable去重仍由 keeper exact
UUID/branch/input digest 提供，不用 TTL/LRU。host object 退休先封新 admission，原实际
work finally 后释放临时 map/占用；旧 continuation 不从新 run 借最新地址。

### 大原生行的完整保护接缝

实际源码 `publication.ts.filterModData` 和 `ManagedModPolicy.filter` 会在 policy VM 前
以 1MiB/depth32/nodes30000 拒绝，`filterModText` 也有上限。因此不能把新 native 大行
直接传现 `publish(fullNative)`，再宣称 no-hook 路径已保留完整且保护成功。

新增 host-only `protectNativeMessage` 合同与 SDK/public publish 分开：输入真实 native
serializer snapshot，输出同一 native class 的完整**受保护** payload；无保护模式保留
全部原 native data。活跃/required 保护模式必须执行实际应用固定 `cmb.baseline/v1` 的
同序规则：非文本/截断输出压制、敏感字段、token、Bearer 和 deployment literals，
原 routing/call/status 等执行事实沿原管道固定。所谓完整不是保留被策略明确删除的秘密，
而是不因公开预算截断未受策略删改的正文/native metadata。

固定 baseline 是应用内纯规则，不是插件可换任意 filter。实现可抽取共享的应用可信
规则执行器，提供独立 native traversal/分段工作计量而不把每片段送成 append；长字符串
须保持完整 token/Bearer 边界和每个 literal 的原处理顺序，不能任意切块漏 redaction 或
改顺序。保原 native 接纳容量，周期检查原 signal/guard、在真实工作间 yield，不抬 SDK
ModJSON 上限；任意 policy 可替换形式未适配时明确不支持，不静默 allow raw。

已有受保护 native 值只能凭实际 private publication receipt 复用：绑定原 producer/
occurrence/full payload digest、policy digest/deployment epoch、original signal/guard，
不是公开 `protected:true` 或旧 observer 日志。失败不回 raw、不写 keeper、不发布部分值。
完整 protector 是采用/retainer 的独立生产依赖，必须两票源码/真实大行验证后接；纯
retainer 基础通过不表示此 adapter 已实现。

### 新增必须运行的回归

- 真实 app SQLite：普通 user 的原 raw-display/模型正文分离仍同一次 UUID，采用保
  prompt_origin/goal/时间/ordinal；原 partial assistant+多 fragments adopted，keeper/全
  projection 同事务，message_count 不增长，后续实际 HTTP用已保留内容。
- 保护/Hook held barrier 下第二连接修改任一原列、追加 fragment、alias改指、同 provider
  occurrence 被另一 row占用：0 keeper/0改原行；不同 live child/branch/old lease ABA亦拒。
- commit后迟到旧 raw delta、values snapshot、authoritative priority 和 alias：DB/实际
  renderer均不能覆盖 safe正文，buffer最终清理不无限重试；合法其他消息/新run照常。
- 重复 next、postcommit throw/deny/撤权、unknown COMMIT/连接仍 transaction、projection
  verifier失败：同 UUID一次物理写、真实副作用一次、错误不重试；exact replay不重 Hook。
- >1MiB AI/tool artifact/media完整native codec/实际 HTTP；Hook0、公开API诚实 bounded；
  literal/token跨工作chunk边界仍 redaction，保护epoch/撤权期间0commit，无部分 raw fallback。
- 原 tool error↔public is_error 双向呈现、完整 original call/status/artifact；same text
  different UUID/occurrence 不合并；attachment/context原位消费及compaction exact cut独立门。
- 非 Mods/无 resident/普通 Plugin/IM/Goal/Harness 原流程单独回归，旧侧效不重放。
