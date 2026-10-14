# 原生 Keeper 工厂接线小方案

日期：2026-10-05。本文件是待独立双审的生产接线设计，尚未启用新的原生消息门。
已有 SDK/shared/fork、Retainer、完整保护和 projection 基础证据不能代替本文件要求的
实际 input/response/tool 入口验收。

## 1. 实际源码接点与首轮范围

首轮只接主图的实际输入、模型完整返回值与工具完整返回值。原消息的分类来自真实
调用地址，不从历史 role、public stamp、流式 JSON 或模型返回的自称来源推导：

- input：实际 IPC/StandardTurn 工厂捕获的原 `modTurnRunId`/租约、实际 HumanMessage、
  原用户记录 occurrence 和原输入来源；采用前仍保原 prompt_origin/Goal/window 事实。
  command/attachment/context/compaction/notice 是各自后续门，不能给每条 HumanMessage
  猜一个 prompt 门来冒称已全部接通。
- response：真实 graph `wrapModelCall` 的原 handler 已完成，取得同一次调用的完整
  AIMessage；在它进入图 reducer/后续工具选择之前保留。raw delta/chunk 只属原显示
  缓冲，不触发 Hook、保护、Keeper 或第二次模型调用。
- tool：真实 `wrapToolCall` 的原 handler 已完成，取得同一次调用的完整 ToolMessage；
  在图 reducer 之前保留。真实执行 status/call ID/name/artifact 原身份来自该原调用。
  在 middleware 中收到的普通 Command/自定义结果不根据字段外形假造 ToolMessage；
  没有精确 adapter 的结果保持原 native 语义，并明确该结果门未接。

当前 `ModsManager.captureFunctionConversationRuntime(actualAuthority)` 已捕获原 graph
binding、Store 和 original-bound loaded-only dispatch。该 dispatch 前后复核 binding、
runtime authority、原 lifecycle 和 ticket；未启用/方法缺失走同一 ticket.core，无冷加载，
不能对真正 dispatch 异常自动重试。`FunctionModsManager.appendConversation` 已是
loaded-only，不能用 hasEventHandler/ensureSession 作为新的 native 准入。

`conversation-coordinator.prepareNativeRuntime` 返回的是实际 durable ref/state/guard，
而 `FunctionConversationGraphBinding.target` 仍只是 ref。它们不是 Registry 的私有 Target。
现 SDK 的 `appendSession` 展示了真实 Store.commit + TranscriptAccess.write/verify 的
事务接点，但其 Guest owner、`kind:"sdk"`、note/inbox 行不能复用来冒充原生 producer。

## 2. 原生运行所有者与 Target

新增主图 native owner 只由实际 Manager 的 graph 工厂创建，固定 actual authority、原
graph binding 对象、run/租约、physical thread/incarnation、原 checkpoint namespace、
完整 logical ref/branch、原 signal 与 runtime guard。公开 thread/agent 字符串不产生 owner。

Coordinator 提供 host-only 注册接点（具体名字实现时可调整）：

```ts
interface FunctionNativeConversationRuntime {
  readonly owner: object
  readonly target: FunctionConversationTarget
  readonly destination: FunctionConversationTranscriptProjection
  readonly signal: AbortSignal
  assertCurrent(): void
  runMutation<T>(producer: object, occurrence: object,
    run: (signal: AbortSignal, guard: () => void) => Promise<T>): Promise<T>
  close(): void
}
```

这个对象必须由实际注册私有 WeakMap 验证，不能让 caller 以相同字段 clone mint Target。
主 Target 通过 Registry.registerMain 实际注册，backend 使用 original authority/binding，
checkpointThreadId 必须是实际 main thread。destination 固定该完整 ref 与真实物理
incarnation，TranscriptAccess 每次 write/verify 比完整目标，不借最新地址。

native owner 不依赖 Guest Session：已在运行的普通图不能因 Guest 配置重载/撤权而被
错误退休，也不能为保图而放宽 Guest guard。原图 Stop、租约/authority/线程/branch 换代
仍先退休该 owner/Target，原在途 work 保持到真实 finally。SDK owner 与 native owner
可分别驻留；Registry 原逻辑按 logicalSession/conversation 合计 native 32/8 占用，不因
新 owner 绕容量。无 adapter/无真实 graph binding 时不为普通无 Mods 会话隐式开户或冷
读 Saver；按当前原生路径继续，不能伪称已经提交 Keeper。

child 首轮不注册伪 main：只有 actual independent/shared family 工厂证明、现 Registry
actual Target、实际 physical checkpoint ID 与独立 UI destination 才能接。main 的 Target
绝不能由 child caller 默认复用；没有该精确工厂则该 child native 门仍未接。此处不撤销
已有 SDK/shared child 的实际隔离能力，也不将其当作本轮 native 门验收。

## 3. 一次 producer admission 的顺序

工厂的 source closure 固定真实 producer 与 occurrence 对象，原运行私有 map 以它们作
键。最多 256 个未终结 admission；重复同 occurrence 返回同一实际 Promise，保存前先
安装 once/in-progress latch，任何宿主 seal/guard 的同步重入不能领第二次信用。

在首次 await 前同步完成：

1. 复核原 native owner/Target、原运行 authority/租约、policy snapshot/epoch/source。
2. 调真实 transport occurrence 的 seal：封该原 UUID/provider occurrence 的进一步 raw
   delta/alias 修改；不是把 caller 指定的 role/UUID 当成当前流证明。
3. 直接 `protector.capture(actualAdmission)` 做 typed capture。此前不调用 raw
   toDict/toJSON/JSON.stringify；Proxy 首拒、binary 原类型和完整 mutation digest 保留。
4. 原严格 buffer flush 开始并固定其 actual Promise。实际错误不得吞掉或转换为无 row。

随后等待 first full protect 及严格 flush 的实际结果，前后复核同原证明。保护成功取得
真实 safe BaseMessage + 私有 receipt，调用 `assertResult(receipt,safe,producer)`。政策
开启时另调用 `assertProtected`；off 结果仅有原值 provenance，不声称 redacted。只有
这一步之后才调用 native codec 或 `new FunctionConversationNativeRetainer({message:safe})`。

原 raw capture 和真实 source 生命周期持续至最终 ACK/finally，不因 safe 已产出就丢掉
原 work。Retainer.host.captureProjection 返回此前已经封口、严格 flush 并捕获完成的
实际 projection receipt；不能在 Retainer 的更晚 capture 回调中才第一次 seal。

工厂 `protectNative` 始终处理真实 BaseMessage。保护采用新实例时，真实私有
public_is_error presentation sidecar 显式继承；它不覆盖原 Tool.status、artifact 执行
事实或 call ID。policy-off 也走同一真实 core 和同一次 Keeper/投影提交，不自造弱 receipt。

Retainer 目前还会 first protect 和 Hook 后再 protect。首个 safe 实例可凭 actual result
receipt 与原 guard 复用，不给原 safe 重新分配 source/延长截止；Hook 应用后的新实例
须再次 typed/full protect 并验证固定 execution facts。缓存仅 exact private instance，
绝不凭 same text、public protected:true 或 policy digest 单独跳保护。

完整 native 行即使超 public 1MiB 或公开内容无法表示，也绕过的是公开 Hook。它仍经过
完整保护、实际 native core/事务/读回，不截 native 正文、不提高 public budget，不重跑
工具/模型。native 1,000,000 expanded-node 工作集上限与原 30s/更短 source cut 独立；
超限明确失败，不以删除 Tool args 或 "redacted" 成功代替执行事实。这是本应用适配上限。

## 4. 最终 AI 执行事实与现有 partial 显示行

当前 NativeProjectionAccess.prepare 的既有行替换只允许正文/reasoning/is_error/
authority/integrity/stamp，`tool_calls_json` 沿原 baseline 保留。对原先只写了 partial call
的 assistant 行，这会保留不完整参数；不能把 preflush old partial 当成最终 AI 证明。

因此需要一个可选、host-only 的最终 execution driver，并以独立模块的实际私有 WeakMap
证明其结果。普通 adopter 未提供此 driver 时维持原固定列行为；只有真实 model-return
工厂可提供它。最窄接口为：

```ts
interface FunctionNativeFinalExecutionReceipt { readonly [privateBrand]: true }

interface FunctionNativeProjectionBinding {
  // 原 seal/flush/alias 方法保持；回调只选择已绑定该实际 candidate 的 private receipt。
  finalExecution?(row: FunctionConversationRow): FunctionNativeFinalExecutionReceipt
}

// 仅新私有模块内能 mint；validator 查实际 WeakMap，而非字段或 symbol。
readFunctionNativeFinalExecution(receipt, {
  producer, run, occurrence, target, uuid, nativePayload
}): Readonly<{ tool_calls_json: string | null }>
```

Binding 回调不能通过返回 public columns 或 `{validated:true}` 开启覆盖。NativeProjection
在 prepare/write/verify 各处调用独立 validator；任何 clone/跨 producer/跨 run/跨目标/
跨 occurrence token 都拒。只可采用 validator 返回的 frozen 一列结果，不能 merge 任意
callback 返回的列。即使有 callback，receipt 未实际 mint 也保持拒绝，而非降级为 allow。

独立 final-execution 模块先在 first-protect 完成后、Retainer 构造前登记一次 original
record：持 actual handler producer/run/occurrence/Target、first safe 实例与它的 actual
protector result receipt。`protector.assertResult` 此时还核原 raw typed snapshot 与原
source/policy；模块只在其后读取已验证 native 字段，不先 raw codec。冻结原实际
class/id/name/full calls/invalid calls/args/usage 与 call-content 关系，record 本身也是
WeakMap 私有对象，same fields 的 clone 不可再绑定 candidate。

Hook 可能改正文，所以不能将 original 整个 payload 当 final payload 不变。第二保护
完成后，工厂对每个实际 candidate 绑定新的 safe 实例和该 actual protector receipt，
核原固定 execution facts 完全相同，再保存该 candidate 的 full native codec 字节。
绑定前后均查原 record/source；candidate 的正文可不同，calls/原执行身份不能不同。
无 Hook 或 >1MiB 路径则绑定第一次 actual safe/result。final receipt 只处理该原实际 AI：

- 原 UUID、实际 provider occurrence/alias、原 class 与实际 calls/invalid calls/args
  都与真实 handler result/protection receipt 一致；AI args 需要 redaction而没有原输入
  决策的情形仍拒，不能新发一次工具调用或仅凭 paths 声称固定。
- 每次接纳/事务/write/unknown-COMMIT verify/最终 ACK 都重核原 guard 与该 private
  result；`row.nativePayload` 必须逐字节等于同一次最终 candidate 的实际 safe codec。
  Hook 只能改公开呈现正文，不能 mint native call/name/args/execution facts。
- tool_calls_json 仅由该真实 AI 的 actual tool_calls 通过固定原 ThreadMessageWrite
  adapter得出（id/name/args）；public rendering/tool preview 不选择其内容或执行权限。
- 新旧 baseline 的所有其他列/fragment/alias/provider/ordinal/time/prompt_origin/
  goal/window 原约束完全保留。只有这一列在 private driver 校验后采用最终值；不能
  顺手放开 Tool.status/tool_call_id/name 或任意 execution metadata 列。

工厂只有在实际 protected candidate 产生后才绑定 final receipt，绝不在 first seal 的
partial buffer 行上 mint。不能只检查“保护后 payload 相同”而忘记真实 handler 的来源。

实际 safe AI 内容中的 tool-use 结构与 native calls 必须一致；apply 不得把可编辑正文
中的新 tool_use 变成新的执行调用。若 provider 内容协议不能保持这个精确对应，拒该
改写并按原 optional Hook 同票 core 回退，不从任意 public 内容重建 tool_calls。

## 5. Store 与投影实际事务

factory.prepare(candidate) 前后校验 actual Target/destination、projection receipt、
protector result、原 typed/source/policy 与 final execution receipt。构造第4参数 native
capture 的实际 TranscriptAccess。Tool 还传真实受保护 ToolMessage，保持既有 storage
role/call/status/完整 payload 联验；不是把公开 user/tool_result 推成执行事实。

CommitPlan.commit 同步调用现 Store.commit(target.ref,completeNativeCommit,guard,
access.write,access.verify)。native row `inbox:false`，原 orderAnchor 来自实际 producer
occurrence/原列；不是 SDK note，不等待 idle、不发另一次 graph run。

index 原同 appDB transaction 比较/adopt 完整原列、fragments/state/alias，Keeper 与 UI
投影一次提交，已有 message_count/ordinal 不增长。prepared claim/receipt 原 once 门不动。
commit unknown 仅原连接离事务后核完整 Keeper+投影 canonical join，不重发 claim/core/
Hook/model/tool。计划 read 再核实际同 row 全字段和 private projection receipt；不能
从 UI-clamped row 或 canonical stamp clone 制造成功。

成功返回实际保留后的 BaseMessage，原 graph 用它进入 reducer。原 raw stream 旧 delta/
values/alias 在 DB 和 renderer 两端被 consumed/seal 阻止覆写；只是防覆写不能改变原
工具真实执行顺序。成功后 source 变更拒 ACK 但已提交事实不撤销、不重放。

### reducer stamp、membership 与 intake frontier

成功 readback 后工厂用实际 committed row+Target 调
`functionConversationCanonicalStamp(target.ref,row)`。从完整 committed nativePayload
恢复真实同类的新 BaseMessage，添加可信 `additional_kwargs.function_row` 后才返回图。
stamp 不在 Hook可改输入内，也不写进先前保护 receipt 的原 safe实例：后者 digest/identity
仍固定，不能为加 stamp 去修改后再伪称旧 receipt 严核已通过。Graph 输出是独立 native
实例，class/id/calls/content/metadata 与 committed 原内容一致，仅多这个原提交注记。

现 full codec 显式去除 function_row，因此添加可信 stamp 后必须再次断言
`serializeFunctionConversationNativeMessage(graphMessage) === row.nativePayload`。已有
stamp 冲突/invalid marker 拒绝；不能重新生成更高 sequence 的新 Keeper 行。no-hook/off
路径也做同一 readback 与注记，不因无 Guest 跳过 membership 所需信息。

native response/tool 的 row.sequence 可能大于当前 `cmbFunctionConversation.frontier`。
工厂不改该 frontier，它表示已摄取 SDK inbox 的切口。真实 beforeModel intake 继续
读取 `captureInbox` 的 inbox rows 并按其原 highWater更新 frontier；不能直接赋为本次
native.sequence，否则 interleaving SDK note 可能被跳过。

Saver 的实际 checkpoint receipt 则固定独立 canonical cut/highWater 和完整原 tuple
membership。`captureCommittedConversationMembership` 已按实际 stamped BaseMessage
逐条读 `cut.highWater` 下 row，不要求成员 sequence<=intake frontier。这让完整 AI/Tool
高 sequence 被保存为实际成员，同时尚未摄取的 SDK note 不因高 canonical cut 自动进入
旧图。proof、full row/native digest、真实 tuple/namespace/incarnation 比较仍保留，不能
从 stamp 本身重建 fork/recovery 权威。

## 6. 最小生产接口与验收

需要 Root 真实接点：

1. 实际 graph native owner/Registry Target 注册及生命周期，绑定原 graph authority/ref。
2. IPC/StandardTurn 原 transport run/occurrence 的同步 seal、严格 flush、完整 alias
   receipt 和晚 echo consumed 路由；full handler结果不能依赖 role 扫描来选 occurrence。
3. actual policy object/deployment digest/epoch 与 host work retain/truefinally。
4. NativeProjectionBinding 可选 final execution driver，仅更新实际最终 AI calls 列。
5. loaded-only dispatch 与现 Store/TranscriptAccess 同事务的真实 prepare/read adapter。

必须实际验证：真实 graph/model/tool handler 各一次；native输入被 Hook 改写后实际下次
HTTP正文改写且 prompt_origin/Goal 不变；完整 AI calls 在已有 partial/fragments 行采用
后准确、下一工具实际调用一次；Tool status 与 public is_error 双向分离、artifact 秘密
保护；同文本不同 occurrence 不合并；late delta/alias 两端不能回 raw；Guest off/撤权后
原 native 图可继续而旧 Guest effects 拒绝；main/child错目标/错 branch/新 incarnation
零写；重入/duplicate next/unknown COMMIT/held保护与取消保 truefinally；>1MiB full HTTP/
SQLite 与 Hook0/public honest-limit；ordinary Plugin/IM/Harness/Goal 原路径回归。

已有基础测试只证明 isolated codec/capture/Worker/Retainer/Store 接缝。生产 factory、
上述三个 main门、child native keeper、其他附件/context/compaction/notice门均不能在其
真实证据出现之前记为完成。
