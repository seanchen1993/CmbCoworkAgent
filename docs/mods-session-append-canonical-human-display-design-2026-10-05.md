# Canonical Human 的可信显示与恢复

日期：2026-10-05。此文是待正式双审的接线设计，不是已经实现或验收的功能。
读取性能基础已实际通过 5 文件 152 项；它不证明本显示接点已经接上。

## 问题与不可改变的事实

原生 Human 的完整 checkpoint/model 正文可能包含工具上下文、附件增强、技能上下文。
UI 应显示同一次 native producer 已保护并原子写入 appDB 的可见正文。
完整原生正文仍用于模型、恢复和 checkpoint membership，不得把 UI 正文写回原生消息。

实际接点如下：

- `src/shared/checkpoint-transcript.ts:815` 对 stamped Human 不使用公开的
  `cmb_visible_user_message`，因而当前索引的 text 来自完整 native content。
- `src/main/ipc/threads.ts:2631` 的 `getCheckpointMessageTranscriptContent` 仍直接使用该
  公开 metadata；`:2920` 的转换器还丢失 function stamp，并用当前时间重造日期。
- `:2990` 的 checkpoint/persisted merge 无真实 source 参数，不能因同 ID 就让 persisted
  行替代原生正文，也不能把去掉 stamp 的 canonical 行交给旧正文合并规则。
- 普通 hydration 的 `threads:messages` 已读取实际 appDB worker page；主线程 hydration
  runtime-state 不返回 messages。`threads:latest-checkpoint` 则是另一条 bounded CP 显示路。
- `runtime-projection-store.ts:1253` 的 legacy bootstrap 已明确拒绝 stamped/invalid 行。
  保留这个拒绝，不能借 legacy migration 重新导入 canonical 原生正文。

显示合同不是新的 SDK 能力，也不产生 runtime authority、ticket、ACK、COMMIT 或 checkpoint。
公开 stamp、UUID、renderer 传来的 tuple、同正文、同 provider ID 都不能登记一个显示来源。

## 两种来源，分别验证

### 已持久 UI 行的 hydration

`threads:messages`/page 绑定实际 native IPC 请求，在第一次 await 前捕获原 appDB 对象、
实际 thread ID/incarnation/workspace、原 sender 生命周期与取消状态。结果来源是该次真实
`readThreadMessagesPageInWorker` 请求的已关联 Worker response，而非传入 Message[]。
客户端的 requestId 与实际 Worker/pending 对象匹配保持原样；关闭、重建 thread、替换 DB
或旧请求被取消后，不发布结果。

canonical page 行只作为这次实际数据库读取选出的候选地址。Main 的私有 page adapter
在 `withCanonicalThreadMessageReadScope` 内读取该 ID 的原始 23 列，校验 Keeper、receipt、
目标/branch、incarnation、schema、fragment/state。其显示结果来自该真实封存 projection，
不来自 worker 行的 public stamp 或 full checkpoint。stamp 的 UUID/role/provider tuple
必须与实际 snapshot 相同；坏 marker、缺 seal 或错误角色不降级为普通行。

worker 原有显示裁剪必须写成共同的纯 formatter，输入仅是已读出的存储值，不执行 IO。
对 canonical 候选，先用真实 snapshot 经该 formatter 计算 expected bounded view，再比较
该次 worker 返回的字段；不能直接忽略 worker 的错误正文而给它虚假认证。
最终可见数据沿同一 formatter 的结果输出，日期、ordinal、prompt_origin、stamp 和其他
可呈现事实取真实 23 列。完整 snapshot 只留在 Main 私有读域，bounded display 不作为 ACK。
保留 page 的 limit/byteBudget、截断与 hasMore 等原协议；任何裁剪都从已保护的可见正文
开始，不能从 enhanced native 正文开始，也不能隐去预算失败后回退到 raw CP。

此路径不需要猜测一个 checkpoint 或选择 main/child 的 membership，因为它没有把 CP
消息转换为 UI 行。它读取原生请求已经选择的物理 transcript；更换 selector 不授 SDK 权。

### checkpoint 派生的显示

新增 host-only `withFunctionConversationCanonicalDisplaySource(input, run)`，输入来自原始
borrowed SqlJsSaver 读域或真实 native fork import，而非 renderer JSON。它捕获：

- 实际 appDB/Store、原 Saver 对象与 read lifetime，原物理 checkpoint thread/incarnation；
- 固定 namespace、exact checkpoint ID、original tuple/config/parent/source 状态；
- 已存在 logical target 与选中的 branch，以及 UI destination 的实际物理 ID/incarnation；
- 私有 membership proof、完整消息数组的原 native digest/count、各 member 原 ordinal；
- 原窗口/线程/操作取消 guard，均沿原 native source，不依赖当前 Guest session。

主会话数据源只调用现有 actual Store 的 `findMain` 和 `selectBranch`。没有 Store、原记录
或 membership 就报告 recovery/migration 错误；不得 ensureMain、coldload Guest、启动 run、
ACK inbox，或因阅读 history 创建新的 authority。独立 child/shared child 只有已有真实
native destination/binding 才进入其物理 transcript；无 binding 不 fallback parent/main。

对 actual Saver exact tuple 使用 `captureConversationCheckpointRead`，与
`store.readCheckpointRecoverySnapshot` 的持久 snapshot 逐项匹配。它仅取得读证明；不能
用 `DeliveryBridge.captureRecovery` 的 ACK 副作用来完成 UI 阅读。
完整数组（含 unmarked 原历史）的摘要必须与 nativeSnapshotDigest 一致。先 descriptor-safe
typed capture，再对安全副本序列化；不先调用原 raw toDict/toJSON/getter。旧无 ID 的
unmarked 行沿已有 occurrence-copy 只读适配保留其缺 ID 事实，不给它 canonical 权限。

每个 stamped Human 必须是同一数组地址/ordinal、实际 human class/UUID、完整 nativePayload
与 member 的 nativeDigest/rowReceipt/stampDigest 都相同；`readCheckpointMember` 取得原 row。
随后从真实 destination 的 23 列 sealed snapshot 取得可见 content，而非 `row.message`、
`cmb_visible_user_message` 或当前 main 临时 summary。所有成员都认证，hidden note 仍由
已认证 note/isMeta 规则隐藏，system notice 保持其真实 UI 角色，不送模型。

所得显示来源用 WeakMap 封存 opaque receipt。原 JSON/brand clone、跨 Saver/DB/thread/ns/
CP/branch/incarnation、错误 ordinal、复制 membership、未来 note、旧 closed source 一律拒。
该 receipt 只允许原同步格式化操作使用，不作为长期跨操作的数据缓存。

## 完整原生与显示副本

后台原 tuple/checkpoint/message 对象和 canonical nativePayload 全部保持原样。
索引、导出及 renderer DTO 使用独立显示副本：仅认证的 Human 可见 content 来自 projection，
stamp/ID/role/rawIndex/数组长度及其他事实保持同一来源；不压平或删除空位置。
Legacy 提供的纯 Human formatter 只处理该已认证可见内容，不查 DB、不授 source 权。

`deriveCheckpointTranscriptIndex` 的默认 unmarked 行行为保持。Main 的可信显示分支明确
使用该 display source 的 view；没有认证 view 的 stamped Human 不进入公开 metadata
fallback。membership/fork identity/cut、原 CP reducer、模型请求始终使用完整原 checkpoint。
显示文本改变不改变那些 native proof 或 intake frontier。

`checkpointMessagesToThreadMessages` 加 host-only 可选显示 source：遇 marked/invalid 行先
做实际 UUID/role/stamp 分类，marked 行必须取得本 source 对原 rawIndex/address 的 snapshot。
采用原 snapshot 的 created_at/start_at/end_at/ordinal/状态，不用 `new Date()` 或旧字段兜底。
普通 unmarked 行继续原 formatter、legacy synthetic ID 与公开 metadata 的原语义。

`mergeCheckpointAndPersistedThreadMessagesForSession` 的 canonical 分支不做正文拼接：先
认证两侧实际 projection 与原 source，再保留一份 sealed visible snapshot。相同 ID 只是
去重事实，不是来源证明；wrong tuple/stamp/日期/正文、invalid marker 明确拒绝。
其余 unmarked/ordinary 行保持旧 merge 行为，不能借本修订更改工具结果或普通历史。

## 实际入口落点

1. **Export**：`threads:exportSession` 保持原 `withCheckpointer` 借用域直到格式化结束。
   原 latest list 只选择 exact ID，随后同 Saver exact read/membership/source 认证。
   main export 从认证的可见 snapshot 构造 ExportMessage；子代理 capture 只有其原真实
   binding 及物理 projection 才用此路。既有普通 captured export 不凭 label 升成 canonical。
2. **Fork**：在 source Saver 借用域及 `assertSource` 中，先原 CP membership，再 UI view。
   nativeImport 的 `preflightVisible`/`copyVisiblePage` 保持原 23 列+receipt 导入；source view
   仅用于可见索引/展示与 selector，不能替代 import proof。目标完成后用目标自己的新
   receipt/incarnation/原子投影显示，不能把 source 的 held view 搬到 target。CP history
   truncation、frontier、full native identity 和 native import 都不由可见正文决定。
3. **常规 hydration**：采用前述原 Worker page source + sealed appDB view。runtime-state
   endpoint 不新增 messages。legacy bootstrap 遇 canonical 仍明确拒；已持久 canonical
   transcript 走真实 DB page，不把该拒绝当成无历史并恢复 raw CP。
4. **bounded latest-checkpoint / history DTO**：不把完整历史搬进 Electron Main 来认证。
   在原 Worker 内加入 private native display read request，绑定 Main 首 await 前捕获的
   original source selection/lifetime。Worker 在真实只读 checkpoint DB 读事务内选定 exact
   ID/ns/source row、验证实际 appDB 持久 membership（state/cut/count/完整 native array digest
   与所有 member），才返回预算内 display tuple。全数组核验逐条流式 typed/native 编码，
   不分配完整历史的新的数组副本；有界输出仍保原 limit/byteBudget/原 global rawIndex。
   Main 只接受原 pending request 对象、actual Worker 和原 source selection 的应答，前后核
   DB/thread/Saver read lifetime/cancel，并核 exact CP/source 指纹；不让 worker JSON 回包
   单独 mint 本机 source proof。没有这些真实接点，canonical DTO 明确拒，不发送 raw Human。
   原 unmarked worker/API 行为不变。仅 sender/request 关联也不足以代替 Worker 内的完整
   checkpoint membership 验证。

第 4 项需要明确的 worker/client/protocol narrow ownership；只改 threads 的去 metadata
条件不能声称所有 hydration/history 显示已收口。它是可实施接线任务，不是框架限制。

## 最后鲜活检查与发布

显示 factory/read 使用显式 reader，不用 ambient/ALS 复用。所有原 source/proof callbacks
走 suspended runGuard，最后 guard 之后真实 fresh B 完整比较原始 23 列、Keeper、receipt、
目标、线程、schema 和 fragments。B 后只有纯 typed/raw/view 摘要、closed/signal/DB identity
以及私有 CAS/复制发布；不能又执行 source callback 后返回旧 view。批量 view 全部成功
才发布，任何一项失效都不留下可复活的部分 receipt。

同步格式化 run/guard 若返回 Promise/thenable 必须拒，不调用其 getter/then；scope 退役后
保存的 reader/source 不能继续读。新操作需重新捕获原 native 来源、实际 DB 和新 proof。
无需 dispose 原 Guest，更不能借当前 Guest generation 决定一个有效 native 历史读是否可用。

## 必须验收的真实反例

- 真实 Human full native 为增强正文，原 protected UI projection 为短可见正文：首次 UI、
  关闭重开、history DTO、导出与 fork 后都只显示可见正文；真实下一模型/原 CP 仍为完整
  增强正文，nativePayload/membership/global rawIndex 不变。
- 同 ID 的错误正文、假/复制 stamp、改 UUID/role/provider tuple、错 CP/ns/branch、未来 note、
  missing membership、不同 Saver、thread delete/recreate、DB reopen、窗口关闭/导航撤权拒。
- 实际 guard 同步改 projection 的 content/date/NULL/ordinal、原 native 或 proof 时，不能
  返回旧 view；所有 23 列都保 seal 语义，批量零部分发布。
- actual noSources/Guest disabled 冷历史读成功（存在真实 Store/Saver/membership），不 mint
  Guest/authority/run、零 Keeper/inbox/projection 写入；不存在原记录时明确拒而非新建。
- hidden SDK note 与 system notice 显示/模型范围正确；ordinary Goal/unmarked metadata/
  idless old history/原日期与工具公开错误呈现保持原回归。
- 实际 worker bounded page/latest DTO 不把 enhanced raw content 或全历史发送 Main/renderer，
  取消与真实 Worker finally 不伪成功；较长正文保持旧页预算与诚实截断范围。

需要源码独立评审、真实 SQLite/Saver/Worker 回归和 Electron close/reopen/fork/export 门禁。
基础 formatter 或读 engine PASS 均不代称这些产品链路已经完成。

## noBubble 消费补充（实现门禁另计）

新的 blank/plumbing 输入仍保存完整 native Human 与 canonical projection；空显示正文不作为
省略依据。Main 使用原 `CanonicalThreadMessageReadScope.readPresentation(uuid)`，与同一次
23 列 seal、原 source callbacks 及最终 raw B/ledger B 组合。仅 genuine ledger 的非 visible
结果可省略。getMessages、persisted/CP merge 和 export 均从这一路读取，不能让同 ID 的
旧 persisted/raw metadata 重新填回已省略的正文。真实 legacy 双 absence 行仍 visible。

Main checkpoint view 在原数组位置放 null，并且私有 view.read 不提供该位置的显示 DTO；
原 native 数组、member ordinal、rawIndex、消息总数、membership 与 provider 输入不改。
Worker 的 project 明确区分 null（完整 native member/23 列/ledger 认证的省略）和 undefined
（旧 unmarked 行）。undefined 才允许沿原 formatter；不能用 nullish fallback 读回原正文。

DB page 保持原有限候选窗口，省略项的物理 ordinal/UUID 仍参与游标。即使一页全部省略，
下一页也能前进；不能返回最后可见行游标而不断重复隐藏行。原 pending Worker 回包携带
有限 presentation kind/fingerprint 证据，Main 在原 A/B scope 逐项复核省略及显示，证据在
最后 source callback 后还须纯摘要复核。外部 page 不包含这些私有证据。

CP Worker 全数组省略不能传输无界隐藏行列表。已获 Root 设计认可的方向是只传
`{count,digest}`，逐原 ordinal 对 `[rawIndex,uuid,raw23Digest,kind,fingerprint]` 流式累计。
Main 必须从原 exact membership 全体成员独立重算，不能删 aggregate 后降级成无隐藏。
这一路依赖专门有界的原 reader 观察集：A 每行完整认证，只保存完整 primitive 事实的
type/length/hash 与必要有界 projection/ledger 证据；最后 source callback 后 B 再鲜活完整
读取每一行逐事实匹配。不能让当前完整 joined raw observations 聚集整段 native 历史，
也不能借公开 digest 或 JSON 回包代替原 private scope。该有界 seam 和 aggregate 尚需
第二独立设计票及源码/实际门禁，未接通时不能把 CP noBubble 记为交付完成。

Root 已固定这一内部接口为 `reader.readPresentationSummary(uuid)`，返回
`{columnsDigest:string,presentation:{kind,fingerprint}} | undefined`。它仍先完整 A 认证；
Observation 仅保存 rawFingerprint、columnsDigest 与小私有 ledger receipt，不保存 columns
或原 facts 正文。需要显示正文时才用 readColumns 鲜活全行匹配原 fingerprint 并绑定 exact
columns。最终 B 鲜活全行 fingerprint 加 ledger 回验，无 source callbacks。CP aggregate
仅在该 seam 冻结、独立源码审通过后接入；当前直接 view 与有限 page 消费快照先冻结供
Root 的实际门禁。两票 aggregate 设计已齐，尚无源码或实际交付声明。

本次基础证据为原显示链实际 45/45 PASS，Worker positive 1379ms、Node/Web types26 GREEN，
日志 `output/stage23-canonical-display-third.log`；这不包含本节新 noBubble 消费改动。

### CP aggregate 的实际内部接点

现有 `buildCheckpointRuntimeProjection` 只保留 todos 与 interrupts；不能从它返回的 bounded
tuple 推测或重建原 CM channel。原 CP Worker 已从同一 actual Saver 原行读取 CM state，
并核原 receipt 的 stateDigest。它的私有 membership witness 增加 `stateJson:string`：仅原
version/logicalSessionId/conversationId/branchId/frontier 五字段，保原 JSON 键序；多字段、
非整数 frontier 或缺实际 state 均拒绝。它不包含 native 正文、隐含提示或隐藏消息列表。
Main 只在原 exact pending Worker/source/checkpoint 生命周期内使用这个小字段，重新核
完整 receipt/snapshot/member/cut/真实 thread incarnation；它不能单独生成 CP proof、ACK
或会话 authority。旧版 nativeDisplay 回包缺 stateJson 或 aggregate 不能降级为旧未标记
路径。真正旧 unmarked checkpoint 的 membership 明确为 null，仍带零 count 的 aggregate，
原未 opt-in Worker API 不增加这个新要求。

`createCanonicalCheckpointDisplayVerifier.project` 对每个实际 canonical member 在原完整
native/row/member 校验后读真实23列与 ledger，非 visible 才返回 null。finish 核原全部
native count/array digest/member count 后才提供 omission count/digest。输出窗口跳过 null，
rawIndex 与原消息总数保持不变。Main 同一显式 reader 对所有实际成员逐行完整核
Keeper/member，再读 readPresentationSummary；只保存小摘要和 ledger receipt，不保存全族
native/projection 正文。选中的可见 DTO 才调用 readColumns，最终 source callback 与 fresh
完整 membership fingerprint 位于所有 raw B/ledger B 之前，之后只做完整 wire 纯摘要与
私有字段移除。全部成员可见与隐藏均参与校验，删除 aggregate、改变 count/digest 或把
已隐藏 UUID 加回 DTO 都拒绝。

Membership fingerprint 的分页实现逐64个 member 构造同旧 LEFT JOIN 的原字段顺序，
流式生成相同 JSON 数组 SHA，空 member 仍含原一条 NULL join 行。只缓存本次实际读到的
单一 receipt 字符串，不跨操作缓存行；其逐字节 golden 与真实 Saver/SQLite fixture 钉住。
本段为已获 aggregate 两票后具体实现合同；新增 stateJson 小字段已获 Root 第一与 Legacy
第二正式设计票。当前四个源码/测试文件冻结供独立源码审查与 Root 真实 Worker 门禁，
尚不据此宣称运行通过。
