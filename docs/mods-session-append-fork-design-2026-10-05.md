# session.append：真实新线程 fork 的 conversation 迁移草案

日期：2026-10-05。开发树 `C:/ai/CmbCoworkAgent-mods-v2`，分支 `codex/mods-v2`。
固定官方参考 Claude Code 2.1.289。本文只根据现有 DevClaw 源码提出实施合同，
**两位独立方案评审已通过，实施中；不是实现或 UI fork 验收**。

与 [主契约](./mods-session-append-design-2026-10-05.md)、
[实际宿主接线](./mods-session-append-native-wiring-design-2026-10-05.md) 和
[同锁提交回执](./mods-session-append-checkpoint-design-2026-10-05.md) 配套。
同线程 graph branch 已有真实基础测试；它没有验证下面的 `threads:fork` 新线程路径。

## 已核对的实际路径

| 源码位置 | 当前真实行为 | conversation 必须增加的工作 |
| --- | --- | --- |
| `src/main/ipc/threads.ts` `forkThread`，约 1666–1884 行 | source mutation lease 与 workflow transition lease；原 busy、审批、稳定完成边界和显式消息校验 | 保留原门禁，另捕获原 source conversation/branch/cut；不根据 IPC 字符串创建 target 权限 |
| `copyCheckpointWithoutSourceSummarizationState`，约 1371 行 | `copyCheckpoint` 后只删除 3 个 summary 私有字段 | 有合法 conversation channel 时做明确映射；不能把父 UUID 留在新线程，也不能静默删除 channel |
| `buildForkCheckpointHistory` / `dedupeForkCheckpointHistoryEntries` | 复制有界保留历史，按可见 transcript 去重，并调整父 checkpoint 链 | 去重不能吞掉仅 conversation frontier/branch 不同的状态；所有实际复制 entry 都需转换 |
| `putForkCheckpointHistory`，约 1501 行 | 新文件中按 target thread/root namespace 写 entry；已有同 ID 就跳过 | conversation entry 不能只凭 ID 跳过，须比较完整已转换 state、消息来源和 metadata |
| `forkThread` 的 target 创建顺序 | 先写并验证目标 checkpoint 文件，后创建目标 app DB thread 行和复制 transcript | conversation 需要实际目标 incarnation/持久行；采用单独准备/就绪状态，不能从源 incarnation 猜目标 |
| `copyForkedThreadMessages` / `checkpointMessagesToThreadMessages` | 按可见消息和 provider occurrence 复制有界 UI 行；后者目前不复制 `function_row` | 普通行保留原路径；实际 marked 行要原子复制完整 canonical 数据、重新绑定 stamp、严格核目标 UI 投影 |
| `copyForkedSubagentTranscriptsPaged` | 复制历史 subagent 展示桶 | 它不是运行中的 child backend，不能注册为新线程的 running target |
| `verifyForkCheckpointPersisted`，约 1650 行 | 查询目标 latest 并比较选中 ID | 旧行为保留；conversation 验证另查指定 exact ID/namespace，核完整映射 state 与已准备 digest |
| `cleanupFailedFork` | 清 checkpoint 文件、DB thread 和 app managed artifacts，分别隔离清理错误 | 清理 conversation/import journal；失败清理不可让未完成 target 被当作 ready |

`src/main/db/function-conversation-store.ts` 的 `forkBranch` 只建立同一 conversation 的
子 branch，不能用于新线程。该 Store 把 thread/incarnation/workspace 固定在 logical
session；将源 `cmbFunctionConversation` 拷到新线程后，coordinator 的
`assertFunctionConversationState` 会正确拒绝。不能放宽该检查来兼容旧 fork。

`dbCreateThread` / `attachFreshThreadIncarnation` 是现有目标 incarnation 的真实生产者。
`buildForkMetadata` 不复制源保留 token；目标仍必须获得新的 UUID，即便公开 thread ID
碰巧相同或 DB created_at 相同。本文不更改普通 fork 的 incarnation 规则。

## 范围与不变规则

1. 没有 conversation channel、没有 `function_row` 的原有 fork 走原路径，原 Plugin、
   项目/Harness、Goal、provider occurrence、附件/大工具结果和有界历史行为保留。
2. 出现损坏 channel、冲突 stamp 或无法找到完整 canonical 行时，明确拒绝本次转换。
   不删来源、不借 latest、不把 UI 截断文本重建成模型正文。原 source 行和 checkpoint 不改。
3. 新线程获得新的 logical session、main conversation、target branch UUID 和 incarnation。
   数据继承与权限重新绑定分开：复制完成不会恢复旧插件 grant、旧 authority、旧 child 或
   旧 callback/SDK invocation。以后运行仍由新线程原生入口捕获真实权限。
4. 新线程 fork 与同线程 rewind/branch 分开。原 `forkBranch(parent, exactCheckpointCut)`
   仍可用于同线程；新线程必须使用独立 clone/import receipt。
5. 不把 `frontier` 解释为“所有原生已保存行的最大序号”。它当前是 note intake 的消费边界。
   同一请求在途时保存的 note 可以尚未进入 graph，而后来保留的 assistant/tool 行已经
   有更高 sequence。把最大 stamp sequence 写回 frontier 会跳过该 note，属于数据丢失。

## 固定 source cut 与私有准备回执

建议新增宿主 helper `prepareFunctionConversationThreadFork`；品牌和认证表在主进程私有
WeakMap 中。输入必须来自 `forkThread` 已持有的真实 source lease、真实 Saver tuple、
实际 source DB 行/Store ref 和实际选择的历史 entry。它不接 Guest/renderer 提供的 UUID
或 `FunctionConversationState` 作为证据。

准备回执固定这些事实，首次 await 前复制标量，之后每次 await 前后检查原 guard：

- actual app DB、source thread incarnation/workspace/lease，原 Saver 路径和 exact root
  namespace/checkpoint ID，以及真实 stable-turn marker/无 pending tool batch 的结果；
- 选中 tuple 和实际复制的历史 entry 的 ID、parent ID、timestamp、合法 channel state、
  full message/stamp digest；若使用原 latest durable-tail materialization，单列它实际增加
  的 UUID/occurrence，而不是声称原旧 checkpoint 已经包含它们；
- 每 entry 的 source branch 私有 lineage、原 intake frontier；另固定 actual canonical
  high-water、原 checkpoint 时间界限和完整已复制 native UUID membership；
- 宿主新目标 thread UUID、其真正 DB incarnation、新 logical/conversation/branch 数据
  UUID 和 immutable branch 映射。公开的 `forkedFrom*` metadata 只是说明，不是该回执。

以上是分开的截点。canonical high-water 只能限制真实行查询，不能推进消费 frontier。
`readRowAtCut` 的 `frontier` 参数是它的行查询上界，调用时需使用上述实际 canonical cut；
不能不加区分地把 note intake frontier 当作所有 assistant/tool canonical 行的上界。

## exact checkpoint 的持久 native membership 证明

当前 `function_conversation_deliveries` 只记 checkpoint ID、generation 和 intake frontier。
这些字段没有保存实际 graph 中哪些完整 keeper 行存在，不能独自授权历史恢复或 fork。
本节是待实施的补充协议，不把当前 41 项同锁基础验收说成已经完成此协议。

### 三种不同事实

| 事实 | 真正来源 | 允许的用途 |
| --- | --- | --- |
| note intake frontier | 实际 graph input/beforeModel 同时更新 messages 与 channel；原接纳回执或已证明 predecessor | 判断哪些 note 已消费；不表示所有原生行的保存上界 |
| canonical cut | 原 actual Store high-water、每层 branch 的实际行继承 cut、exact row 身份 | 限制完整数据的点读；不能证明某行已进入原 checkpoint |
| checkpoint native membership | 同锁 successful Saver callback 读取的 exact tuple 中实际 marked messages | 原 checkpoint 的 native keeper/尚保留 note 精确恢复与复制；不接公共 UUID 数组 |

例如 note 的 sequence 是 7，当前 provider 请求已开始，随后 assistant/tool 被 keeper 保存为
8、9，而 beforeModel frontier 仍为 6。若 exact checkpoint 实际包含 8、9，则恢复它们；
7 不因序号小于 9 而补进该 checkpoint。模型自然下次接纳 7 后，消息顺序仍由原 batch
锚点确定，不能把 DB 插入 sequence 当模型顺序。新 fork 同样保留原 frontier=6。

`function_conversation_branches.parent_frontier` 当前在 `lineage()` 中用作所有 canonical
行的祖先查询上界。新的宿主 branch/fork 接口应将它明确命名/解释为 canonical ancestor
cut，并把独立 intake frontier 留在各 checkpoint 状态和 intake 收据中。创建子 branch
不能把较低的 note frontier 填进 canonical ancestor cut；也不能只提高这个数就让所有
祖先 pending note 合法。keeper 是否属于历史图由下面的 membership 点查决定。存量
尚无此扩展的 branch 数据不猜两种 cut 的关系；有真实 exact tuple 才可明确迁移。

### 最小表与私有 API

建议在同一个 app SQLite 增加两张索引表。它们保存数据选择证据，不保存 authority、
grant、旧 callback 或可重放的 SDK closure：

1. `function_conversation_checkpoint_receipts`：随机 receipt ID；唯一键为实际
   conversation/branch、physical checkpoint thread/incarnation、namespace、checkpoint ID。
   列包括 logical session/目标 thread incarnation、原 checkpoint parent ID/ts、规范 state
   digest、原 intake frontier、canonical high-water、私有 lineage cut 的规范摘要、实际
   native membership count/digest、完整 native message snapshot digest。workspace 与目标
   kind/invocation 身份须与当前 Store/ref 一致，不能由公开 metadata 替代。
2. `function_conversation_checkpoint_members`：receipt ID 外键、实际 graph ordinal、canonical
   UUID/sequence/branch、原 row receipt ID/payload digest/createdAt、完整合法 stamp digest、
   原 native message identity/content digest。以 receipt+ordinal 唯一，并对 receipt+UUID
   建唯一索引；同一个 canonical UUID 重复出现或冲突拒绝，不按正文去重。ToolMessage
   的 tool_call_id、AI tool calls、provider source/occurrence、artifact 和原 message class
   都纳入实际 native adapter 的身份/完整内容校验。工具顺序仍由原 graph 保持。

具体 helper 接口使用模块私有 Symbol 类型加 WeakMap 认证，不能仅接受品牌属性：

```ts
// Native-only signatures; public strings/FunctionConversationState/UUID sets cannot mint proof.
captureCommittedConversationMembership(actualSaverReceipt, actualBinding)
  -> FunctionConversationCheckpointMembershipProof
store.recordCheckpointDelivery(target, actualDeliveryProof, guard, membershipProof)
captureConversationRecovery(actualSelectedTuple, actualReadBinding)
  -> FunctionConversationCheckpointReadProof
store.readCheckpointMember(actualReadProof, exactUuid, guard)
  -> FunctionConversationRow
```

`actualBinding` 固定原 target/ref、actual Store/app DB 对象与 generation、physical thread
incarnation、checkpoint namespace、原 Session/runtime authority/source epoch/signal，以及
真实 saved checkpoint 对象关系。shared child 可以使用 parent physical thread 的独立
namespace；independent child 使用实际 child physical thread。两者都不能省略 namespace
或把 public child label 当 incarnation。图恢复只读 binding 则来自实际 selected tuple /
原 graph config /已核归属的 archive native selector，不需要重造旧运行 authority。

original prepare 在 Saver 第一次 await 前固定实际 Store high-water/lineage/target 与 intake
capture，不能到 callback 里再借当前 high-water 扩大原 cut。actual committed callback 内的
成员必须存在于这个固定 cut，且当时 Store current high-water 不低于它。native keeper 行
必须先完整保存，再由原 producer 把该行放入待提交 graph；这项时序不能用 fallback猜补。

提交捕获复用现有 `SqlJsSaver.putWithCommitObserver` 的 native WeakMap token，并用
`readCommittedCheckpoint` 读取同一 callback 内的 cached exact tuple；不再普通 getTuple
申请第二次锁。固定标量及待保存成员在第一次 await 前复制；成员集合只从实际 tuple
的 `channel_values.messages` 建立，解码器沿真实 Saver/native serializer，不 dump 巨型 VM
或把原生对象转成通用 ModJSON。三个 stamp placement 必须按共享 validator 一致校验，
损坏/冲突 marker 不能降为 unmarked legacy。

每个成员实际 point-read 原 canonical 行，核 Store/ref/private branch lineage、sequence
不超过固定 canonical high-water、row receipt/hash/bytes 和完整 stamp，再经实际 native
adapter 比较消息与完整 canonical payload。不能只核 UUID、sidecar receipt 或 UI 截断投影。
createdAt 固定原行值；不把 `checkpoint.ts` 或当前 wall clock 简单当所有 native 行的时间
证明。实际成员可以是请求后保留的较高 sequence 行。非成员的 note/notice 单独遵守原
intake/notification 截点，不能扩大 high-water 来吸收它们。所有会员证明的 digest 是数据
完整性检查，品牌与 actual binding 才能进入宿主操作；知道 digest 不获得执行权限。

所有 marked 成员核验通过后，在**原 delivery ACK 的同一个同步 app DB transaction** 中
写 receipt/members 和既有 delivery 行，再按已经证明的 note intake frontier 清 inbox。
不为成员另开事务或 await。guard、Saver callback 活性、原 DB generation 和 target 复核
必须覆盖 writer/严格 read-back/COMMIT 前后；thenable verifier 拒绝。原 UUID/payload
receipt 并未因保存 membership 而变更。相同 exact native proof 只可完整核验后幂等采用，
相同唯一键但 snapshot/member/state digest 不同明确冲突。

事务前可以用现有 `readRowAtCut` 预检，但它明确拒绝 `inTransaction`，不能在 ACK 事务
中调用或削弱这个边界。Store 增加最窄私有同步 SQL verifier，在同一个 actual database
事务内按原固定 cut/lineage 精确复核 canonical hash/bytes/stamp 与预检结果；不借公开
readReceipt、另一个 DB connection 或 async verifier 替代。成员与 inbox ACK 原子性由此
完成，而非在 transaction 外核完就默认后续行未变。

claimed intake frontier 增加时，另核真实 input/beforeModel intake capture 的 note UUID 与
原 predecessor consumption 事实；不能用 `max(member.sequence)` 代替。compaction 后
成员中已没有老 note 时，通过原已交付 predecessor/真实 compaction producer 继承消费
事实，不把“UUID 不在当前图”当未消费。不具备这条原生证明则 fail closed，不通过新建
public state 或从当前 Store 全表推断。

### 读取、重启、ABA 与不可原子的失败窗口

恢复 admission 从实际原 checkpoint ID/namespace、physical/logical incarnation、branch
与原 selected state 捕获新的私有只读 proof，再按上述唯一键读 DB receipt。核原 tuple
snapshot digest、实际 membership 与原高水/lineage 完全相同；消息恢复对 UUID 做 member
点查，而不是把整组公开 UUID 交给 Store。`readRowAtCut` 是内部完整数据读取 primitive，
此时使用 receipt 的 canonical cut，并额外要求该 UUID 的 actual membership。seq 高于
intake frontier 的已保留 assistant/tool 因而仍可恢复；未被图接纳的 future pending note
即使 sequence 较低也不能恢复进这个旧 checkpoint。普通 UI hydration 原 notice 可以
呈现，但不会借这个接口变成 provider SystemMessage。

- 只读 proof 必须绑定原 saved tuple，不用 same-thread latest 替换指定 ID，不按公开 stamp
  选择 target。实际 archive selection 也需宿主 ownership/原 exact snapshot 与完整 digest。
- app DB 关闭重开后，持久 receipt 是可校验的数据。新 binding 必须重新核真实 DB/thread
  incarnation、Store/ref/namespace 与原 exact checkpoint；不反序列化或续用旧 WeakMap token。
  配置/guest 重载不改 durable 数据身份，但旧 guard/source epoch 不借新 resident 继续。
- 同 thread ID 删除重建、同 public child label 重用、跨 workspace/namespace、source/target
  owner ABA 或 actual DB generation 改变，旧 proof 拒绝。child 完成/取消后只允许实际归属
  的只读 archive 路径，不能把 archive 当运行中的 append target 或写 parent UI。
- Saver 已 COMMIT、DB membership/delivery 未 COMMIT：inbox 不清，原 exact checkpoint 仍
  可读时可在新的实际 native recovery scope 核全部内容后补原 ACK，不重新注入/重放 Hook。
  默认 root1 已剪掉该 exact tuple 时明确 `RECOVERY_REQUIRED`；不能拿 latest 或 DB UUID
  集合伪造已丢失的原 graph snapshot。既有 root3/完成边界30/48 MiB 保留规则不变。
- DB ACK 已 COMMIT 而 caller 取消/回执丢失：保存事实与 intake 收口保留；旧 scope 后续
  不再接纳操作。unknown COMMIT 按 actual `inTransaction === false` 和完整固定 receipt/
  membership/canonical read-back 处理；不重试 COMMIT、writer 或 native put。
- 同锁 callback 真正 finally 才使临时 proof 失效并释放 namespace；取消不提前释放正在
  核验的实际宿主工作。主线程 thread 删除先 retire actual backend，再同 DB 事务清对应
  receipt/member 行；source/target 的不同 incarnation 不共用清理 key。

checkpoint retention 引发 proof 索引清理时，先用真实 retained exact-ID 集合核本 incarnation
与 namespace，不按 TTL/LRU 忘记仍可恢复的 history。已经移除的 member index 不能让
原 canonical row receipt/inbox ACK 忘记并重放；canonical receipt 保留原持久规则。DB 索引
可以随明确历史删除清理，不能为实现新索引放宽 Saver 原 retention。每次 actual checkpoint
只按自己的 marked UUID 点读，receipt/member 索引不重复保存完整 nativePayload，不在
next request 热路径全历史扫描。

旧 marked checkpoint 尚没有 membership 记录时，当前 recovery helper 继续明确
`MODS_CONVERSATION_RECOVERY_REQUIRED`。唯一可补的迁移是实际 native reader 在持有原
exact tuple/实际只读 ownership 期间，通过同等级 private capture 认证原 canonical rows；
不能从公共 UUID 列表、UI projection 或 `function_row` 自行 mint 收据。SDK 测试kit缺少
这些原生存储适配不能代称框架限制，也不能代称该旧恢复链已经闭合。

### 与本次新线程 fork 的关系

每个实际复制 history entry 都引用自己的原 membership receipt/实际 snapshot，而不是用
最新 entry 的集合覆盖全部历史。复制 native keeper 只复制选中 entry 实际存在的行；
compaction 之前已消费、当前不再在 graph 的 note 可按原消费 proof 保留为历史 canonical
数据，却不能因此重新加入 model messages。notice 和旧 child archive 同样保持独立范围。

新 target 不复制 source 的 successful delivery/member 收据。目标实际转换后的 tuple 由
自己的 Saver callback mint 新 proof，并在 target app DB 原 ACK/import transaction 写新
receipt。目标 membership 的 UUID/sequence 按原内容保留，conversation/branch 映射与新
physical incarnation 固定；只有真实 target tuple 验证成功才能解除 import gate。

### 要复制哪些完整行

准备时从原 Store 的 private lineage 查询，而不是调用 `readRows` 的最新 4096 尾页：

- 已证明消费的 note canonical 行按照每层 ancestor cut 继承；完整 native payload、允许
  内容、origin、door、时间和顺序锚点全部保留。native keeper 不因处在这个序号范围就
  自动成为图成员，仍按下面的 actual membership 筛选；未消费 note 也不能因为较高
  canonical ancestor cut 而变成已消费。
- 实际复制的 checkpoint 或已批准 durable-tail 中的 marked native 行，按 exact UUID
  单独核完整 canonical 行。它们可以晚于 intake frontier，依据是原真实 tuple membership，
  不是通过提高 frontier 接纳它们。
- 未被本 snapshot 接纳的 pending note 不移入目标 inbox，也不清 source inbox。历史 fork
  尤其不能吸收选中 checkpoint 之后的 note、sibling branch 行或 future child 行。
- notice 只作为无 provider role 的通知记录复制；按该 snapshot 的真实时间/lineage cut
  决定范围，不把它作为 `SystemMessage` 加入 graph。默认摘要显示仍按原 bounded 适配。
- 普通 legacy 无 stamp 行仍沿原 transcript copy，不要求它凭空拥有新 canonical receipt。
  存在 stamp 的行必须验证；不能把验证失败行降格为 legacy。

latest fork 若将来要额外继承尚未入 graph 的 pending note，须另有真实 admission cut：
完整 note 与该 cut 一起进入目标 checkpoint，并通过原 intake/grammar/同锁 ACK 验证。
本稿不授权只复制 hidden UI 行就宣称已消费，也不改变 source 的保存 ACK 或 inbox。

分页按固定 cut/keyset 前进；页间源新增行不扩大截点。初值每批最多 64 行及 4 MiB 完整
UTF-8 canonical payload；单行超过 4 MiB 时单独完整处理，仍遵守该实际 native producer
已有的内容/文件限额。4 MiB 是批工作集目标，不是新增截断 native 行的存储限制。不以
4096 API 限额截断一次完整 fork，也不把 SDK 1 MiB 门套在全部历史 native payload 上。
较大复制按 journal 的固定进度分批写目标 preparing 数据；所有批完成前不能返回 ready。
单行或整项超出原实际 native 限制时整项拒绝并保留源数据；不截断块或称部分复制成功。

## 目标数据与 channel 的映射

不复用源 conversation ID。原 lineage 中需要保留的每个 branch 分配新 target branch ID，
重建同一目标 conversation 内的 parent/cut 关系，保留原实际序号和历史截点。target 的
`next_sequence` 至少是固定 source canonical cuts 的最高 high-water 与完整复制集最大原
序号两者的最大值加一。保留原 sequence 空洞，不复制被排除的 pending note，也不把这个
数据计数当 intake frontier。不能重用 gap 或原 receipt。

每个实际复制 history entry 逐项转换：

1. `cmbFunctionConversation.logicalSessionId/conversationId/branchId` 指向新目标持久数据；
   `frontier` 继承该 entry 原 note 消费边界。保留同 checkpoint 的完整 messages、模型状态
   和其他原生 channel；不改 provider ID/occurrence 或工具配对。
2. `function_row` 的 conversation/branch 采用实际行映射，uuid/sequence/door/type/origin
   和允许内容保持。BaseMessage 对象与其 serializer envelope 内的 stamp 同步变换，
   不用 JSON round-trip 丢失 message class、artifact 或原生属性。
3. canonical 行的 native payload 也由实际 message adapter 重写对应 stamp，并重新计算
   bytes/digest；只改可证明的来源字段。JSON 序列化的无 stamp 原数据不靠 split/replace
   猜字段。新保存 receiptId 是目标 DB 的新事实，不复制源成功回执。
4. 顺序锚点涉及 source conversation/branch/physical invocation 时显式转换或保留为
   不可执行的历史 provenance；不能把原运行 receipt 变成新运行权限。无法准确映射则拒绝。
5. imported 已消费 note 的目标物理 inbox 不新建；目标下次 intake 根据正确的 checkpoint
   frontier 不重复插入。历史 rollback 仍可从 canonical payload.inbox 标记按原旧 cut 恢复。
   若目标以后新建 pending note，沿原配额与真实事务进入新目标 inbox。

checkpoint 去重 key 对有 channel 的 entry 增加规范化 state 和完整来源 digest；没有
channel 的旧 key 不变。两个可见正文相同但 branch/frontier 不同的状态不能被合并。
已有 target checkpoint ID 只可在 exact 回读、完整转换 digest 相同且 import plan 匹配时
幂等跳过；ID 相同不是成功证明。

## DB 与 checkpoint 文件非原子：准备/完成协议

不能声称 app SQLite 与独立 checkpoint 文件是一个事务。最小可靠路径是给
conversation-aware fork 增加持久 import journal，以及真实 target admission fence。
旧无标记 fork 不为了统一接口增加这套协议。

建议新 journal 存 actual target thread/incarnation、plan UUID、source exact identity/cut、
target durable IDs、转换 digest、状态 `preparing`/`ready`。它是数据，不是授权；跨重启只
用来完成原生一致性检查或清理，不能重放 Guest/Hook、mint authority 或运行模型。

1. 原 source transition/mutation guard 成立后，在 actual app DB 事务中创建目标 thread
   及新 incarnation，建立新持久 family/branch，写 `preparing` journal。同期确保不存在
   另一 source/target plan 冲突，严格核实际 row/hash。canonical 与 target UI projection
   可以按上述批预算继续写同一个 preparing plan；每批的固定 row/stamp 与 journal 进度
   在同一个同步事务写入，重启只按已保存进度验证/清理，不重新执行 producer。原 thread
   创建 primitive 若不能 join transaction，先补最窄宿主 join seam，不嵌套 BEGIN。
2. target 为 pending fork，不接纳模型/写 SDK/用户提交；捕获它的真实 target mutation lease
   或专用 host-only gate。冷目录/UI 查询不赋予执行权限。应用重启发现 preparing 同样
   保持拒绝，不能仅因公开 metadata `forkedFrom*` 存在而解除 gate。
3. 真实 Saver 写转换后的 history，原大工具结果/附件复制继续执行；指定 exact 选中 ID
   回读，核 messages+channel state+native来源 digest、目标持久数据和目标 incarnation。
   所有 source/target guards 在 await 边界保留。Saver 三参数普通 put 与原保留限制不变。
4. 对每个确已复制的消费状态，由固定 actual import receipt 与目标 Saver 原 exact native
   membership proof 完成目标 delivery/member 记录。
   `source` delivery/inbox 完全不改；不能复制源 DB ACK 代替新目标 checkpoint 事实。
   此阶段不重新执行 append Hook/保护/工具/模型。
5. 所有 projection/canonical/checkpoint 验证和原附件复制成功后，在 actual app DB 事务中
   CAS `preparing→ready`，再次核 plan/digest/incarnation。flushStrict 后返回原 fork response
   并释放目标 gate。配置切换/源权限撤销不能把旧 plan 转到新 workspace 或新 incarnation。

失败只清理本 plan 精确新目标，不删源。unknown COMMIT 时禁止盲重试、重写或新 mint；
先以固定 plan/target incarnation 和完整实际存储回读判定。任何 DB 仍在 transaction 的
结果不算持久成功。清理失败保留 preparing journal/gate，不能返回 ready。重启的恢复只
针对该真实 pending 记录校验/清理，不从公共 thread_id 或原 source UUID 自动重建运行。

原 `cleanupFailedFork` 的 DB 删除需要在同 app DB transaction 清 target family、row、
inbox、delivery、branch 与 journal。目标 checkpoint 外部文件删除失败不能清 journal 后
把残留文件当普通新会话读取；源 checkpoint/keeper 明确保持不变。

## 子助手与后续运行

fork 时的旧子助手只按原规则复制展示 archive。完成/取消/旧 namespace、相同 public label、
`mod-task:UUID` 和 SDK child thread 不能在目标注册成运行中的 append/messages target。
新线程以后生成 child 时仍需要新的 actual invocation authority、physical lease、namespace
及独立 projection bucket。省略 agentId 指新 family main，不沿旧 child ALS 或 parent metadata。

目标重启从实际 thread incarnation 和 ready import record 恢复数据，再由新原生运行绑定
新 authority/grant/signal。不能因 checkpoint 中的字符串相等就恢复原插件来源执行权。

## 实施前必须通过的真实测试

- 无 channel 的原 `threads:fork`/消息 fork、Project/Harness/Goal/provider occurrence/大工具
  结果/附件回归不变；同 source 可见正文相同但不同 frontier 的历史 entry 不被错去重。
- 两 actual SQLite + SqlJsSaver + createAgent：选中有 channel 的 completed checkpoint，
  实际新 DB thread token、实际新 UUID/branch/stamp，下一模型消息正文正确且不重复 note。
  关闭 app DB/Saver 真重新打开后仍从目标 ready 数据恢复；不是数组或 fake checkpoint put。
- source 在 checkpoint 之后保存 note、sibling branch 保存 note、原 in-flight pending note
  早于较高 seq assistant：目标只能继承精确 snapshot，source inbox 不清，目标 frontier 不跳。
- actual frontier=6、pending note=7、tuple 实际 assistant/tool=8/9：membership 点读 8/9
  恢复完整 class/tool/provider/artifact，7 不进旧 graph；不能只以 max stamp 或 wall clock证明。
- copied/fabricated native membership proof、只给 UUID 集合、错 physical namespace、同 ID
  的 tuple/stamp/payload 冲突、receipt token 过期、两 actual Saver 默认root1竞争：0假ACK。
  一个 observer 尚未 finally 时另一相同 namespace writer 不可剪除它；不同 namespace 保持独立。
- app DB 与 actual Saver 真重开：新只读 admission 以原 exact ID/target incarnation 回读
  真实持久 member proof；close/reopen/ABA/取消/unknown COMMIT 不重放 keeper，future note0。
- compact 移除原 note message但 frontier 保留：新目标 canonical 完整内容可查，实际 next 不
  重新插入已消费 note；旧 exact history rollback 不读较晚 canonical 行。
- DB journal 已 COMMIT而文件未写、文件已写而 ready CAS 未完成、unknown COMMIT/失败清理：
  无 model/SDK/Hook 重放，pending 目标拒绝执行，精确恢复或清理不影响 source。
- source/target delete-recreate 同 ID、workspace override、ABA、更换 grant/authority/配置、
  copied/fabricated plan、不同实际目标尝试用旧 plan：0错误 adoption/0越界 provider 权限。
- target已有同checkpoint ID但 channel/body/stamp不一致必须拒；默认 root1 剪掉 source exact
  ID时不能 fallback latest。原有界 root3/完成边界30 保留语义不放宽。
- 两个真实 child 的历史不交叉，复制 archive 后指定旧 agentId 不成为 live target。
- 最后用真正 Electron fork入口验证新线程、重启、读取和下一显式 turn；此前同线程 graph
  branch 和 Saver 同锁 41 项不能代替这个产品入口验收。

## 当前独立审查结论

coordinator 的 main note 基础最初由 root 实际运行 9 项；本轮只读发现注册 guard 失败后
残留 owners/current 的阻断，root 已补精确同步 rollback，刷新源码后该项静态闭合。root
随后报告含该回归的 10 项实际 PASS；本评审未启动测试，不把这份代码审查扩大为所有
native producer/child/fork 已接线。

本文最需要双审定稿的是：canonical keep cut/intake frontier/actual tuple membership 三种
事实的分离、私有 receipt 同 ACK 事务与只读恢复、最新 pending note 不自动纳入 fork、
join transaction/new target gate，以及 import journal 失败与重启规则。这些是现有原生
后端可适配的工作，不因开发量或缺少 adapter 标成框架限制。

## 私有 journal 基础实际落点（2026-10-05，待集中验收）

`db/function-conversation-fork.ts` 已实现 native-only plan WeakMap 和实际 app SQLite
journal；本节不声称 `threads:fork`、跨工作区或实际 UI fork 已接线。现基础只接 main
conversation 的同工作区迁移，历史 child 仍不是 live target。

- `prepareForkImport(store,{sources,selectedSourceIndex,assertSource})` 只能在原 source Saver
  仍活着时接 authenticated membership proofs；整个复制和目标验收均保留该原 scope。
- `beginForkImportInTransaction(plan,actualTarget,assertTarget)` 与真实
  `createThreadInTransaction` 同一次 app DB transaction 创建新的 durable IDs、branch map
  和 preparing record。它不 COMMIT；caller 的未知 COMMIT 只能在 `inTransaction=false`
  后用 `readForkImportView` 核固定目标 incarnation、全 journal 和实际数据身份。
- `assertForkImportCurrent` 是原 ACK transaction 内的私有 facts guard，不返回保存回执。
  `readForkImportView` 明确要求 committed connection；两接口不可混用。
- `copyForkImportPage` 以固定 source cut/keyset 扫描，最多 64 行/4MiB 工作集、单大行
  完整；目标 canonical 行、真实同步 projection、manifest/cursor 同事务。原 payload.inbox
  标记保留，目标物理 inbox 不创建。writer/COMMIT 错误不重发或换 UUID。
- `recordForkImportCheckpoint` 只认真实新目标 Saver membership；新 target delivery/member
  和 journal checkpoint 进度同一个 app DB ACK transaction，不复制 source ACK。
- `finishForkImport` 在 ready CAS 前分页双向核全部 eligible source、完整 target rows、
  manifest、实际 projection 与 exact target receipts，损坏 complete flag 不能隐藏
  compacted consumed-note 漏复制。然后保 source/target/native guards 同步 CAS 并回读。
- `resumeForkImport` 只用新原生 source/target proofs 重绑原 journal/IDs/进度，不从 JSON
  复活旧权限、不重放 Hook/工具/模型。`abortForkImport` 只封 admission，留下 durable gate。
  清 journal 另需原 exact target app rows 已删除和 actual external-file retirement guard。

轻量 `db/function-conversation-fork-gate.ts` 可在 Store/Saver 构造前读取 preparing gate；
无旧表时只读返回，不创建 schema。root 接普通写口、模型启动和 checkpointer 门禁，
私有 native import 回调不得把 bypass 暴露为 IPC/SDK 的 thread ID flag。

显式截短 messages 后不能沿用原完整 checkpoint 的较晚 frontier；目前真实 source adapter
要求整个 retained tuple 身份一致。尚未证明的前缀截点应明确拒本次 marked fork，保原无
channel 行为，不借 latest 或猜 note 最大序号。
