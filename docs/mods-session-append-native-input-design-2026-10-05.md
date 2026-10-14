# 用户输入进入原生消息链路的设计

日期：2026-10-05。状态：作者第一设计评审与 Latest 独立第二评审均 PASS；来源基础
模块正在实施，用户生产入口/保留/采用/候选 handoff 尚未验收。
实际模型/工具链的通过证据不能作为本输入门已完成的证据。较长调研记录见
`output/stage23-native-prompt-producer-design.md`。

## 实际使用方式与本轮范围

用户照常发送消息；IM、scheduler、Mods 等 managed transport 照常调用原主运行入口。
最终模型输入在同一次图执行前经过完整保护与已加载的 session.append Hook，随后同一
实际 UUID 的安全消息保存到 Keeper、UI 投影和检查点。不启动另一个模型运行，不再次
触发已有 composer/插件/UserPromptSubmit Hook，不新增文件、模型或写入权限。

首轮只认 `ipc/agent.ts` 最终构造的 `userHumanMessage` 原对象（当前约 8111 行）。它
位于原模式、技能、UserPromptSubmit、plugin prompt 等准备之后、首个 runtime.create
await 之前。`humanMessages` 中的旧 durable tail、内部通知，以及后续 Goal revision、
Command/null resume、output-style 临时 Human 不根据形状归入 prompt。主 ordinary 与
managed 用户输入共用这一个实际地址；child/附件/context 等另有真实入口，后续再接。

数据 ID 接点的原问题：AgentInvokeParams.userMessageId 可省略，而
persistVisibleUserTranscriptMessage 缺省自行生成 UUID、只返回 boolean，最终 Human
仍使用原可选 ID。真实用户 entry 在任何本轮 row 保存前固定一次 host ID，有效已有
transport ID 保留，缺省才生成；保存、最终 Human、证据和新 receipt 使用同一局部 ID。
不能按正文、最后一条 user row、constructor class path 回猜 UUID。ID 只作数据地址。
Root 已将入口 request 字段别名为 requestedUserMessageId，首行写入前固定唯一局部
userMessageId；原所有保存与最终 Human 使用它。真实省略 ID 的 Electron/检查点
门禁定义尚未运行，不能把该源修改当作验收通过。

## 真实输入来源和同次提交

新增 main-only NativeInputReceipt，记录仅在私有 WeakMap 中。实际入口捕获原
physical-run/租约、DB/thread incarnation、原 transport/composer/plugin receipt、可见
row occurrence、最终 Human 原地址、typed mutation digest 和原 source guard。同步
typed capture 在首个 await 与 raw codec 前完成；公开 stamp/role/UUID 不生权限，新
输入夹带 function_row/invalid 标记明确拒绝。

source proof 的 guard 独立于某个 candidate 的旧 runtime authority：它固定原实际
physical run、原 delivery/source receipt 和 thread/incarnation，跨候选模型仍连续核验。
每个 candidate 再由真实 NativeRun 验自己的 authority/DB/lease/branch。不能将旧
runtime.assertCurrent 包进 source proof 后，在切换时 catch 错误借新 owner。

接口只留在主进程：

```ts
captureFunctionConversationNativeInput(actualEntry): FunctionConversationNativeInputReceipt
readFunctionConversationNativeInput(receipt): FunctionConversationNativeInputSource
bindFunctionConversationNativeInput(receipt, actualRuntime, actualPolicyAdmission):
  FunctionConversationNativeInputBinding

interface FunctionConversationNativeInputSource {
  readonly message: HumanMessage
  readonly uuid: string
  readonly threadId: string
  readonly physicalRunId: string
  readonly workspace: string
  readonly signal: AbortSignal
  readonly origin: FunctionSessionAppendOrigin
  readonly visible?: string
  assertCurrent(): void
}
interface FunctionConversationNativeInputBinding extends FunctionConversationNativeInputSource {
  readonly runtime: FunctionNativeConversationRuntime
}
```

当前基础的 read/bind 只验证来源和新 actual Manager runtime/policy 的私有认证，不提供
retain、saved、ACK、handoff 或释放占用的方法。source 原 guard 不含旧 authority；bind
再核新 runtime 对同 main 物理 thread/workspace、实际 DB 的固定关联。源消息按原对象
首回捕获一次；重复或同步重入使原捕获失效。任何 public stamp/invalid 直接拒。

后续 Host retention 是另一个需要真实 attempt/ACK/drain 的私有接口。standard runtime
factory 只转交原私有 receipt。outer NativeInvocation 的原 source
lifetime 内，在 inner conversation prepare/intake 前调用 retain，只替换普通 own
messages 数组中的 exact Human 地址，其余字段和元素位置原样。普通无 proof 的
createDeepAgent 保留旧路；不扫描所有 Human，不改变 Command/null。

顺序为 once/seal → typed capture → first full protect/private receipt → Keeper →
loaded-only append → final protect → canonical+完整原生正文+23 列 UI 回执同事务 →
真实 COMMIT 完整读回 → safe Human 携真实 stamp 进入同一次图输入。inner intake 再按
原 frontier 把 pending SDK notes 放在用户输入前。取消、撤权、变更目标或 policy 都
拒原 ACK，不走 raw fallback；真正 ignored flush/Worker 仍持有到实际 finally。

## 原 UI formatter 与完整 Human 的精确区别

已读实际原源码，存在三个不同职责：

1. ipc/agent.persistVisibleUserTranscriptMessage 直接保存 visibleTranscriptUserMessage
   和原 Goal/window；plugin prompt 另在真实 hostPromptOrigin 写口保存来源。
2. 最终 Human.content 是 effectiveMessage；宿主增强时另有
   `cmb_visible_user_message`、`cmb_coordinator_augmented_user_message` 等 metadata。
   shared/checkpoint-transcript 对旧无 stamp user 才选非空 visible 字段；新 marked 行
   则故意不以该公开字段恢复来源。
3. persistedMessageFromStreamPayload 明确忽略普通 user。因此不能复制 AI/Tool parser
   来实现本门，也不能把实际 model Human 的隐藏增强文字全部显示在用户气泡。

新增 Human formatter 只接收已验证 first/final protected safe Human 与私有 presentation
receipt。选定以下明确规则，不能自行猜字符串对应关系：

| 原实际输入 | 模型与完整 canonical native | UI content_json |
| --- | --- | --- |
| 无宿主增强的主输入 | append 可改合法 text，媒体沿原 occurrence；送最终 safe content | 用最终 safe content 沿原用户内容格式保存 |
| 原 factory 已产生 visible metadata 的增强输入 | append 可改完整 native.content；fixed metadata 不被 Hook 改，完整保护仍处理它 | 用最终 protected visible 字段沿原 visible 保存，不宣称 UI 随 native rewrite 改字 |
| 有增强但无法证明确切 visible 映射 | 完整保护/core；公开 Hook unavailable | 必须有原 factory 可保护 presentation，缺失则本门拒绝，不泄露隐藏 context |

增强输入的选择由原 factory presentation receipt 决定，不能仅看到同名 metadata 就
启用。原 visible 与 native 全体一起先保护，固定 media/metadata/execution 身份在两次
保护之间复核；不按 substring、prefix 去隐藏 prompt。原 typed 字段含 image/document
或附件引用时保留完整 native 和真实媒体 occurrence，公开 Hook 仍只允许按既有合同
移动/删除媒体，不新增/修改/复制媒体；无适配的公开格式走 unavailable，不删媒体装成功。
不在这里再读附件文件或再次跑原附件 Hook。

canonical user 的 UI 必须来自实际 AppDB 投影+receipt。检查点索引可用原 UUID/ordinal
定位，但不能拿 marked Human 的模型正文作为 UI 恢复正文，也不能为此重新开启所有
marked 消息的 visible metadata fallback。原 membership/23 列完整验证后读取对应 UI
projection，完整模型恢复则使用 Keeper nativePayload；两者分别验证。fork 原 raw copy
保持这两个正文的映射，不从已截短 UI 重造模型 Human。

## 捕获与采用原 23 列

原 NativeProjectionAccess 已在实际 seal/strict flush/alias capture 后读取完整 raw23 与
fragments/state。Human 门沿这个真实捕获和同 DB claim，禁止 public stamp、显示正文
或 caller 提供 columns 代替它。原字段集合来自
FUNCTION_CONVERSATION_PROJECTION_COLUMNS，不另外维护“24列”的假计数。

| 字段 | Human 已存在投影的合同 |
| --- | --- |
| thread_id/message_id/provider_source_id/provider_occurrence/role | 原实际 row 与 native source 同一身份，固定；role 必须 user |
| content_json | 只采用上面实际 safe Human formatter 的可见正文，原一次有界 UI formatter；完整 native 不截短 |
| prompt_origin_json | 原插件 prompt 真实来源固定，普通 null 保留；Hook 不能改或新增来源 |
| function_row_json | 新 canonical 行、真实 door/origin/sequence 的固定 stamp |
| reasoning/tool_calls_json/tool_call_id/name/status/is_error | 保原 Human 非工具执行列，不生成 tool 身份或借 AI finalExecution |
| content_priority/stream_authority | 原实际来源标记固定；专用 Human variant 不采用 generic AI/Tool 的三个 snapshot bits7 覆盖；不能借 append 修改权重/制造额外权限 |
| recovery_integrity | UI 是否完整的事实按原 formatter 与真实保存核验；不得把截短 UI标为可模型恢复，模型只读完整 Keeper |
| goal_id/active_window_id/created_at/start_at/end_at/ordinal | 原实际 run/visible row 捕获值固定，绝不重新排序、按正文推断 Goal 或刷新时间 |

Human formatter/adopter 必须单独约束上述来源字段；不能仅依赖 AI/Tool 现有 generic
可改列集合。实际 NativeProjection.prepare 目前允许来源三列随 protectedColumns 改，
NativeAdoption.project 目前仅 AI/Tool 且固定三个 snapshot mode；它们尚未支持这里的
Human 合同。Root 已认可必须新增私有 Human variant，固定原 priority/authority，UI
integrity 按真实一次 formatter/实际保存可降级，不能因 full Keeper 而升级。此 variant
是用户采用器接线前的实施门；源基础 read/bind 不改变现有采用器。
已有 Human row 与原 Alias map/CAS 先后逐次核对，fragments/state 按当前
canonical 终态归零且真实回执核验。未知 COMMIT 只按原 claim 完整读回。
原 plugin row 必须已持真实 prompt_origin receipt，不 default recertify；fresh ordinary
row 仅原同事务 bucket 分配 ordinal 后用固定真实 source facts 插入，不能 MAX+1 外部猜。
canonical user late echo由现 sealed-row fence消费，普通 incomingMessage 不能覆写。

## 候选切换与严格一次保存

输入 receipt 按原 physical run 的 occurrence 持 once 状态。只有原 Keeper 的完整
runMutation 后 guard、完整 ACK 已成功的 saved（或原 unknown-COMMIT exact claim 真正
读回并完成 ACK）才能 handoff；原 attempt.whenDrained 必须已到真实终态。Hook失败、
未完成 COMMIT、未知 cleanup 不能给下一 candidate 当 saved，也不能重新 writer 重试。

新 candidate 有自己的实际 NativeRuntime 和新的 capturePolicy admission，独立校验
仍为同原 policy object/epoch/digest/deployment；不用已关闭旧 policy.assertCurrent，
不 catch 撤权后借新权限。原独立 physical/source proof、租约、input occurrence/raw
digest、DB/incarnation 和完整 canonical target/branch 也都必须相同。

合格 handoff 私有读取原 saved row/full native+raw23 receipt，重新构造 safe Human，并
登记本 candidate 的只读 wire；不重 Hook/不重新保存/不借旧 wire/不更新原 source
资格。不同 run/branch/策略或 source失效拒绝，不查 latest。缺该 handoff 实现不得把
“初始化失败后会重发原 Human”的现 failover 直接包装成通用两次 Keeper。

## 文件分工与必须运行的门禁

新增 input receipt/binding 与实际集成 tests；Root 接 agent.ts 固定 ID/唯一 producer，
standard factory/runtime 私有字段、Host/NativeInvocation 顺序、Human protected formatter
和严格 handoff。按 owner 分工协调原 projection/索引，不改泛用 reducer/SDK 权限。

作者第一票为设计 PASS，条件是实施以上 mandatory source/formatter/23列/ACK+drain
和 handoff 门，不是“以后补”的选择项。第二票后才开发。验收至少包括：真实 main与
managed HTTP+AppDB+Saver，普通 rewrite 首请求与下一 turn、原同 UUID；增强隐藏
context 与 protected visible 显示；media、plugin origin、Goal/顺序；缺 ID；getter/
Proxy/raw toJSON 0；同步重入、source撤销、忽略 flush、旧/新候选真实初始化失败且
Hook/保存一次；Command/null/历史/内部通知不误认；oversize public unavailable 仍
完整保护；旧无 proof 路径；真实 Electron 普通气泡发送/managed delivery兼容。

## 实际运行接线与一次保存的具体接口

此补充是 Root 的具体实施提案，待两位独立评审；基础 source/read/bind 的通过不
代表下面的保留与候选切换已完成。

`CreateAgentRuntimeOptions.nativeConversationInput` 只传原私有 InputReceipt。真实
8113 入口构造唯一 Human 后同步捕获，使用 manager 的实际规范化 workspace、原
runToken/signal 和 `throwIfPhysicalStreamRunIsInactive` 加 plugin 原 receipt 的 guard。
不以任何 candidate.runtime 的 guard 当原 source。ordinary desktop 的来源为 composer；
scheduler/heartbeat 用原实际 task source，IM 没有真实 channel server 证明时只记
bridge，不猜 server；真实 plugin 用原 NativePluginPromptRun 的 origin。

新增 `function-conversation-native-input-retention.ts`，接口为实际 Host 的
`retainInput(input, config)`、`close()`、`whenDrained()`。模块私有 WeakMap 以原
InputReceipt 记 once 状态：未开始、处理中、保存完成、失败。每个 candidate 的 Host
有自己的 attempt、实际 protector、policy admission、presentation 和 drain。处理
状态在任何 guard/callback 之前锁定；重入不能再启动 Keeper，失败不能重发 raw。
不提供公开 saved token，不查询同 UUID/正文“补”一次保存结果。

outer NativeInvocation 在原 source lifetime.run 内、inner conversation.prepare/intake
之前等待 retainInput，随后调用原 graph。只有普通 own-data input.messages 数组里的
exact original Human 地址可替换；顺序及其余 own-data 字段保持。原 Command/null
resume 完全保留，不扫描内部 Human、历史或通知。不含原地址的非控制输入明确拒绝，
不将相等 UUID/正文当已提交输入。没有私有 receipt 的旧运行保留旧路径。

首 attempt 在一次真实 Keeper 中执行 first protect、实际 presentation 登记、append、
final protect、same-DB canonical/原生全文/23列提交。Keeper 的真实 Promise 成功只是
第一条件：必须 `keeper.whenDrained()` 真完成，original source 与该 candidate policy
再次有效、完整 row 和原 receipt 读回相同后，才能锁定保存完成。原 guard 抛错、
忽略取消的实际工作未结束、Hook/COMMIT/ACK 失败都记失败。主物理 run 的原 signal
永久取消不能通过下一 candidate 换 signal 修复。

保存完成项只记录由这一次真正 Keeper 返回的 immutable full row、row/native digest、
原 policy identity/epoch/digest/protected/deployment、原完整 target/physical destination
身份和原私有 source。原 scope/策略对象的 identity 与当前 declarative deployment 都
固定。它不记录可重用旧 wire，也不授 Guest endpoint 或权限。

后续 candidate 独立 capturePolicy/bindInput，必须仍为同原 policy identity、epoch、
digest、protected 与完整 deployment，同 DB、同 target conversation/branch/kind/
checkpoint namespace、同实际 physical thread incarnation。原独立 source guard 仍前后
核 raw Human/lease/目录/取消，不调用或 catch 已关闭的旧 candidate policy。

合格切换只读恢复：以新 candidate 的 guard 使用 fresh Store.readReceipt 和真实
canonical snapshot + strict partition，核每一完整 row/native/23列与已保存结果。全部
核验成功才从完整 nativePayload 构造新 safe Human，并加真实当前 row stamp，交给
新 Host 的 private projection.register。不重 protect/Hook/flush/write、不改变 ordinal/
Goal/time/visible body，不借旧 wire。严格读失败直接拒绝，不能改查 latest 或原输入。

新 Human 的原生正文仍是已保护的模型输入；UI 继续读实际 23列 projection。界面或
checkpoint 的显示恢复不能把完整增强正文拿来当用户气泡。真实 threads hydration/fork
若缺此 mapping，输入门不能冒称产品完成。未知 COMMIT 沿原 Keeper 原 claim 的完整
读回才能成功，不在本 once 层重新构造 claim 或重试 writer。

验证必须在实际 createAgent/Manager/QuickJS/SQLite/Saver 中制造第一 candidate 的
stream-opening 失败，再关闭旧 runtime 并创建新的实际 candidate：Hook/flush/canonical
保存一次，下一 provider 收到新 safe Human；改变 policy/branch/raw/source/lease 均拒。
首保护失败、提交失败和 held flush 的真实 drain 完成前均不能切换成功。普通/增强/
媒体/插件/缺 ID 与真实 Electron 下一 turn 另测，不用基础 binding 测试替代。
