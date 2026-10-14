# 原生 Tool Command 的 AI/System 旁行

日期：2026-10-05。工作树 `C:/ai/CmbCoworkAgent-mods-v2`。
状态：Legacy、Official 与 Root 已完成正式设计审阅。进入限定生产接线窗口。
本轮 Tool/Human 性能门为 Root 实际 109/109 PASS，默认 5 秒保持；该结果不证明本稿
AI/System adapter 已实现。所有新增门由 Root 串行运行，Legacy 不运行 CPU。

## 行为与原版事实

真正工具返回的 Command 可以交付配对 ToolMessage、新 HumanMessage、新 AIMessage
和新 SystemMessage。已有 Tool/Human 来源链保持。AI/System 旁行也先完成原工具及
全部原 middleware，再在原 tools bound 完成、原 writers 前保护、保留和回连原地址。
原控制字段、原消息顺序、RemoveMessage 与真正历史对象继续按原框架执行。

固定 Claude Code 2.1.289 原版归档：

- `output/claude-code-2.1.289-alignment-analysis-2026-10-04/extracted/chunk-7y8w7np9.js`。
  基线可执行文件摘要为
  `bcc6d9117aec30ad9414490302a25414359c871f5647e32e49b055c92bf84e0b`。
- 原 `doorOf/Te` 默认 assistant 为 response、system 为 notice。
- 原 `appendOriginOf/Oe` 默认 assistant 为实际 model、system 为 engine；user 的
  tool-result/tool-message 通过真正 tool-use ID 取得原工具名。
- 原 `appendInputOf/me` 明确先选 `raising.door ?? doorOf(message)` 与
  `raising.origin ?? appendOriginOf(...)`。因此真实宿主 producer 可以提供明确的
  door/origin；本适配使用原工具请求的来源覆盖，不冒充默认 model/engine producer。

本机真实 `node_modules/langchain/dist/agents/nodes/ToolNode.js` 的 base handler
在 211–222 行调用原工具一次，ToolMessage 或 Command 原样返回，其余对象由框架包
成 ToolMessage。254 行等待原 wrapToolCall。305–323 行按原实际 tool-call 顺序等待
全部 runTool 并聚合 Command；parent Send-only 聚合可能丢弃原 update，未进入最终
slot 的旁行不能保留。故 AI/System 的本轮入口是实际 Command.update.messages，
不是放开裸 AI/System 工具返回，也不是合成 LLMEnd 回调。

当前实际缺口：Tools 源只接受 exact ToolMessage/HumanMessage prototype，Host 的
non-model 分支也只接受 Tool 或真正 ToolHuman。共享 notice 分类排除所有 public
messageType system；直接放开两个类会使 System 原 provider 优先级在恢复时消失。
这三个具体接缝均可实施，不以框架限制搁置。

## 显式类型、door 与来源

| 原实际旁行类 | public rendering | door | origin | native/DB role |
| --- | --- | --- | --- | --- |
| AIMessage | assistant/assistant | tool-message | 原 request 的 tool 名 | ai/assistant |
| SystemMessage | system，无 public role | tool-message | 原 request 的 tool 名 | system/system |

两者的 occurrence 都是真正 ToolReturn receipt。它们没有本次模型 attempt；不调用
模型 Calls.returned，不生成 provider callback/runId，不调用 model-only completed
steering callback，不把 message.name/model/usage 变成 producer 身份。

选择 tool-message 是宿主的明确 raising override，表示这条实际工具旁行；不借
assistant 默认 response 的模型身份，也不借 system 默认 notice 的 engine 身份。
origin.tool 固定原 runTool 首 await 前捕获的 request.name，message.name 是另一个
原生固定呈现字段，不能改变来源、端点、权限或工具执行次数。

完整非文本 System 可保持全 native 内容，但当前 public system schema 只支持一个
text block。多 block/media/native 不可表示时，现 Retainer 的 unrepresentable 分支
继续完整两次保护及真实 core/保存，不调用不可表示的 public Hook；不拼接丢信息，
不截短 native。大于 public 1 MiB 的行同样只关闭 public Hook，不扩大其预算。

## 真正来源与最小新接口

新增隔离 `agent/function-conversation-native-tool-side.ts` 与同目录测试，沿已验收
ToolHuman 的 actual return reader、首 callback 前 once/reading latch、私有 exact
runtime/policy certificate、原 native invocation cut/signal 与 callback-free data tail。
独立 source 不创建 NativeInput、prompt intent、Goal 或 noBubble disposition。

```ts
interface FunctionNativeToolSideReceipt { /* 模块私有 WeakMap brand */ }

captureFunctionConversationNativeToolSide({
  receipt: FunctionNativeToolReturn,
  slot: FunctionConversationNativeNodeSlot,
  runtime: FunctionNativeConversationRuntime
}): FunctionNativeToolSideReceipt

readFunctionConversationNativeToolSide(token): {
  readonly receipt: FunctionNativeToolReturn
  readonly slot: FunctionConversationNativeNodeSlot
  readonly runtime: FunctionNativeConversationRuntime
  readonly occurrence: FunctionNativeToolReturn
  readonly message: AIMessage | SystemMessage
  readonly nativeType: "ai" | "system"
  readonly uuid: string
  readonly door: "tool-message"
  readonly origin: { readonly kind: "tool"; readonly tool: string }
  readonly policy: ActualCapturedPolicy
  readonly signal: AbortSignal
  readonly expiresAtNs: bigint
  assertCurrent(): void
  assertDataCurrent(): void
}
```

Tools 的实际返回地址表仅窄加 exact AIMessage 与 exact SystemMessage prototype。
Proxy-first，消息 type/content/name/id 等必须在任何方法/codec 前 typed capture。
AIMessageChunk/SystemMessageChunk、伪 subclass、公开 brand 或相等 config 不取得
完整旁行资格。配对 ToolMessage 的原 call ID 校验继续。相同地址的不同请求冲突
仍 sticky；原完成 output 不因 admission 失败抛回工具重试。

source 捕获先读真正 ToolReturn/slot/Work/runtime 的完整私有证明，再固定 exact 原
message、prototype、完整 typed digest/shape、policy identity/epoch/digest/deployment、
原第一期限与 combined signal。每独立 source.read 保完整 Work/slot/source/policy
callback，最终 full guard 后完整 raw/policy/maps/cut/latch 的纯尾；不能只凭门/type
组合或缓存一次 SQL 成功开新来源。

禁止外带 function_row/invalid 和 Input 专用增强 visible metadata 取得旁行资格。
原 provider ID 缺失或复用只影响数据：uuid 由原真实 ToolReturn 一次固定，安全 native
副本使用该 canonical uuid，原非空 ID 可记录为 provider_source_id。provider occurrence
按原 physical destination/role/sourceId 的实际 DB 与本 run 私有 counter 分配；它不
选择 producer。相同 provider ID 不合并两个真实请求、两个类或两个 canonical UUID。
明确试图用新对象替换原历史 canonical UUID 的 Command 需另有替换 adapter；本轮
fresh side 不偷偷覆盖不可变历史，也不把它降级为无标记普通消息。

## Host、Keeper 与原生事实

Host 对非模型 slot 先取得实际 Tools ledger，然后按 exact class 分派 Tool/Human/
AI-side/System-side。新分支只接受上述真实 token。producer 仍当前原宿主对象，
occurrence 使用真实 ToolReturn receipt，slot 只用于完成地址回连和 finalized ledger。

保留过程沿现 actual runtime.runMutation、真正同 protector、原 sealing/strict flush、
Retainer 两轮保护、Ticket pinned fields、Store/AppDB 同事务 canonical 与 raw23、
projection receipt、唯一 postcommit finalverify。保存失败不再执行已完成 tools bound。
取消/reload/policy 改变拒 ACK，仍等真正 ignored flush/Worker/host finally 才 drain。

AI-side 使用原完整 AI native codec、Rendering 和 FinalExecution 机制。其 execution
来源为真实 ToolReturn producer，而不是 model attempt；tool_calls/invalid calls/chunks、
usage/name、签名/推理/非文本执行 blocks 都按现完整事实固定。Hook 只能按现 schema
修改可变正文，不能新增、删除或改参工具调用。下一步是否执行原 calls 仍由原 graph
router/ToolNode 决定，不由 Hook 或本 adapter 另执行。

System-side 使用原 System native codec与 system rendering/apply。保持 exact System
class、name、所有 additional/response metadata、原完整 content blocks 与 provider
位置。Hook 的文本改写绝不把它转为 Human、AI、SDK note、engine notice 或新的 Goal。

两分支与原 Host 共享 new-ACK projection entry，并在真正 drain 与所有原 source
callbacks 后执行现 Node/Host finalized pure full-seal helper；descriptor-only 容器快照
和纯尾通过后才 transform→writers。不得在最后 helper 后再读取原容器 index/tuple。
stream safe completion仍来自成功原 writers 的 exact safe update 地址；不产生假的
LLM/Tool callback，不 forward 未保护原对象，不使用 streamEvents 未完成的出口。

## Fresh raw23 与实际显示

实际 Adoption 的 protected projection 已是 full snapshot，但现 project 只支持
AI/Tool。窄增加 System 并由真实 tool-side branch 提交；保留现 original formatter 一次
归一化，不走 ordinary upsert/alias merge。旧 Tool/Human/Input branch 不改变。

新 side 通过独立 opaque `FunctionNativeToolSideProjection` 选择 fresh 合同。token
只能由已取得实际 ToolSide source 的专用工厂创建，绑定原 source/runtime/producer/
run/occurrence/target/destination/UUID；不能以公开 kind/role 开分支。Adoption 的可选
`nativeToolSideProjection` 参数仅把该 token 交给 NativeProjection 内部读取；原 generic
路径不接受 caller fresh 布尔。私有 variant 在 capture 固定 baseline必须缺失，在每边
保 full source callback及最后完整 data/context/row纯尾；已有 baseline明确拒。没有
Human presentation/metadata权限，也不接 Input 的 fresh/null字段合同。

每条 side 为新的 Keeper occurrence/canonical UUID，不采用陌生已有 raw 行。实际
baseline、相关 alias/provider 或角色碰撞拒绝，无法用已存在消息的 flags/ordinal
自证 fresh 行。23 列来源固定如下：

- thread_id/UUID：原 captured physical destination 与 ToolReturn uuid。
- role：私有 source nativeType 映射 assistant/system；function_row_json：真实 canonical
  row 的完整 stamp；created_at：同实际 Keeper row.createdAt。
- provider_source_id/occurrence：上述实际 per-role occurrence；无原 ID时 uuid/1 起步。
- content_json/reasoning：安全 full native 经原 stream payload formatter；System 没有
  assistant reasoning。是否 bounded/lossless 由原一次 formatter 得到真实结果。
- tool_calls_json：AI 的完整最终 execution receipt 固定，不能由旧 partial/public
  rendering猜；System 为 null。原 Tool side无新的 tool_call_id/status/is_error。
- name：原安全 native 的真实可选 name；不从 request.name 补造。
- content_priority：原合法 formatter 结果，未提供则 null；stream_authority 保原
  formatter实际 applicable snapshot bits：AI 的原完整三快照为7，System无reasoning/
  tool_calls时为content snapshot的1，不为凑常数造空call/reasoning字段。
  recovery_integrity 保原真实投影损失判定，不因
  full Keeper/native 已完整而假升级 UI 截短行。
- prompt_origin/Goal/active window/start/end：无对应实际 producer事实，均 null。
- ordinal：原同 Keeper AppDB transaction 的实际 bucket allocation；不接受 caller 数字。

同事务写真实 full projection receipt；immutable fences/whole snapshot echo/delta/reorder
按现 canonical规则保护。noBubble ledger 双无仍是已验证 visible，不能由 public metadata
省略。Worker/Main CP 展示与 export 仍读取真实 sealed snapshot，原 public native 正文
不成为 UI 权限。System 显示为普通 literal 通知，原 provider System 对模型保持。

## 系统分类与所有真实消费口

新增共享纯数据分类 `isFunctionConversationToolSystemSide(message)`，仅合法 stamp、
messageType system、door tool-message、origin.kind tool 且无 isMeta 返回 true。
此函数只选择验证/显示路径，不授 source/模型/存储权限。

`isFunctionConversationNotice` 对其返回 false；SDK system note与真正 engine notice
保旧 true。没有有效 marker 的普通旧 System 路径保持。System-side 的 public class/
door/origin 可复制，但没有原 canonical/membership/23receipt 的复制品依然明确拒。

必须同批接齐：

1. persisted-runtime-message 与 checkpoint-message-recovery 不将真正 side提前 null或
   排除 count；仍必须原 exact checkpoint/target/cut/guard 的 canonical resolver。
2. checkpoint membership 保 type system、原 System class、full native payload、完整
   stamp/ordinal/count/receipt/23seal。错误 Human替代、改 door/origin、错 branch/cut拒。
3. shared checkpoint transcript/runtime projection/forkability 的 count与边界分类将该
   System视为真实原 provider state；UI可见原 rawIndex 不替代原 membership。
4. Renderer transport 的 System转换须接新的 display分类，不能仍仅notice才 push；
   MessageBubble 将所有合法 canonical System显示为 literal 通知，并在 Goal/Workflow
   文本解析前返回。模型是否使用它与 UI是否普通通知是两个不同决策。
5. notice IPC/event资格继续仅真正 isFunctionConversationNotice；ToolSystem不冒充
   engine即时通知，不获得命令/Goal审批/任务控制副作用。
6. 当前 public messages as:api只允许 user/assistant；System-side仍不伪造 user角色。
   默认 rows中完整返回 system/tool-message数据；HTTP provider恢复则保持 System类。
7. fork/cold restore/restart 只用原 CP membership和完整 raw-copy/新目标receipt，不能
   从 type/door/origin公共分类补一条缺失的未来 System。
   当前 fork.ts 的 system 时间例外必须限真正 UI-only notice；ToolSystem 即使时间
   早于 checkpoint timestamp，也只能通过该 exact CP 的 source.members 资格。
   该分类只收窄时间例外，不能替代原 membership 或 source receipt。

采用 system+tool-message保原完整角色。attachment替代会碰当前 raw23完整 seal的
attachment→user规则，还需新权限外形，因此本稿不走那个更大变体。

## 必须实际验证

- 真 createAgent + AppDB + Manager + Saver：一个真实工具 Command配对 Tool+AI+
  System，效果1、每行 Hook once，下一真实模型请求的 safe AI与 safe System原类/
  优先级/顺序正确；原 goto/state/tuple update不变。
- side AI含真正 tool_calls/metadata/name；public改 text有效，改调用参数拒且原效果
  不重跑；usage/name/signature事实保留。无模型 callback receipt不得被 model branch接。
- 两并行实际请求复用/缺省原 provider ID与不同来源，稳定 canonical UUID/occurrence
  各自独立；相同地址跨请求拒，历史地址/Remove/control-only不新保留。
- System公共schema一text可改写；多block/media和 >1MiB full System/AI Hook0、完整
  protected core保存/下一模型原全内容、UI integrity真实，不靠截短缩 fixture。
- forced policy secrets：原旁行 raw toJSON/getter/Proxy0、未保护 stream/DB pending0，
  safe messages/values/updates只有原 exact已保护地址，CP/native完整。
- 真 restart/exact old CP recovery/fork：ToolSystem恢复为System，SDKsystem notice仍
  null且不计 provider；frontier后未来side/pending SDK note不回补旧CP，未成为成员
  但 createdAt 在时间界限内的 ToolSystem 也不复制。
- copied/public stamp无私有来源/错误native类/fullstamp/23seal/ledger/receipt均0ACK；
  system内容长得像 Goal/Workflow只literal显示且无控制副作用，旧无marker邻例不改。
- 最后 source guard改 raw/policy/map/Command容器、取消、ignored drain、unknown
  COMMIT：0 late writer/ACK，真 finally前quota保留，writer/effect各一次。

实现分工须在两审后明确：新 source及Tools narrow class/returns；Root Host/Adoption
System projector/真正main接线；shared分类与Main/renderer恢复显示；新真实framework
与HTTP/Electron门。设计票不代上述实际产品验收。
