# 原生 Human 的可见投影与采用合同

日期：2026-10-05。状态：作者、Root 第一评审与 Latest 独立第二设计评审 PASS。
已有 baseline 的 presentation/adopter 子链已写，尚待 Root 串行类型与真实回归；fresh-write
intent、no-bubble 和实际入口接线仍须其私有来源合同及产品门禁，不能据基础模块宣称完成。
本案不替代 `mods-session-append-native-input-design-2026-10-05.md` 的真实 ACK/drain
handoff；这里不生成 saved、ACK 或新权限。

## 已存在的源码边界

`ipc/agent.persistVisibleUserTranscriptMessage` 原样保存 visible string、Goal/window 和
时间，再由原 DB normalizer 有界保存。增强 Human 的完整模型正文与 visible metadata
确实不同。现 `native-adoption.project` 只接受 AI/Tool，固定三个 snapshot mode；现
`native-projection.prepare` 允许来源三列覆盖。直接扩 `HumanMessage.isInstance` 会把
隐藏上下文露进 UI 或将 user 来源位改为 7，因此不能这样接。

本轮入口只来自 actual NativeInput receipt。实际 ToolRequest 的新 Human 旁行是另一
producer，必须用独立私有 ToolReturn receipt；它们只共享已证明安全数据的 formatter。
历史 Human、SDK note、RemoveMessage、公开 metadata、克隆 binding 都不能 mint 此门。

## 私有 presentation 与最终保护地址

新增 `agent/function-conversation-native-human-presentation.ts` 和测试。示意 API：

```ts
captureFunctionConversationNativeInputPresentation({
  source: FunctionConversationNativeInputReceipt,
  runtime: FunctionNativeConversationRuntime,
  policy: ReturnType<FunctionNativeConversationRuntime["capturePolicy"]>,
  producer: object,
  occurrence: object,
  protector: FunctionNativeMessageProtector
}): FunctionNativeHumanPresentation

registerFunctionConversationNativeHumanProtection(
  presentation: FunctionNativeHumanPresentation,
  result: FunctionProtectedNativeMessage
): void

projectFunctionConversationNativeHuman(
  presentation: FunctionNativeHumanPresentation,
  exactSafeHuman: BaseMessage,
  actualRow: FunctionConversationRow
): ThreadMessageWrite

// Original IPC writer only, before its first DB operation; not a public column certificate.
captureFunctionConversationNativeHumanWriteIntent({
  actualWrite: ThreadMessageWrite,
  threadId: string,
  physicalRunId: string,
  signal: AbortSignal,
  disposition: "write" | "blank" | "plumbing",
  assertCurrent: () => void
}): FunctionNativeHumanWriteIntent
```

token 与数据只保在模块 WeakMap。capture 通过原 source receipt 的 read/bind 核实际
Manager policy/runtime，不接任意 caller 传入的结构 binding。原 occurrence 首 callback
前 latch；producer/occurrence/runtime/run/target/destination/signal/UUID 固定。原源 guard
不含旧 candidate authority，当前 presentation 的绑定仍核自己的新 runtime/policy。

register 仅接完整保护结束的 actual result：`protector.assertResult` 必须匹配 exact
receipt/message/producer，protected policy 还核 assertProtected。先 exact Human prototype
typed capture，再读 safe data；原 UUID/type 不变、不能带 stamp/invalid。前后核原 source、
policy/runtime、result receipt 与 typed digest。safe object 地址登记在 presentation 私有表，
clone/equal ID/同名 metadata 都无登记。仍拒 Proxy/accessor/toJSON，不先 raw codec。

需要 Root Keeper 一个 native-only 同步通知接点：每次 actual protect success 完成原
assertResult/assertProtected 后通知 `register...Protection`，通知前后保 full guard 与
result proof。最晚 final protected candidate 在调用 admission.prepare 前必须已登记。
这不是 JSON 接口、SDK proof 或新 Hook，也不能用 inheritPresentation 提前注册一个
尚无 actual result receipt 的新实例。旧无 presentation 的 Keeper 路径不变。

project 只接受这个已登记 exact safe Human，且 actualRow UUID/door/origin/nativePayload
与 candidate 和固定 source 相符。后续 graph 带 stamp 的反序列化对象不反向登记成
新输入；它的显示恢复仍走持久 full projection receipt。

## 可见正文选择

input source 捕获时若无 private visible 字段，限定普通无增强消息：原 typed metadata
不得带 augmented=true 或 visible 字段。final safe content 直接进入原 user formatter；
合法 content 数组保持原用户内容形态，不另跑 AI parser，不读文件。

input source 有 private visible 时，原 actual entry 必须同时具备 augmented=true 与
同值 visible metadata。它们由原真实工厂 receipt 证明，不能仅凭公开字段启用。记录
模式与字段地址，不缓存 raw visible 作为最终显示值。每个已证明 actual safe message
的最终 protected visible string 才用于 UI；完整 safe native.content 保存在 Keeper，
送同次模型。Hook 改完整正文不意味着 UI 跟随改字。Hook 不得修改 fixed metadata；
原 Retainer fixed-native facts 和两 pass 保护继续有效。first protection 可以按实际
policy rules redaction 修改原 visible metadata，不与未保护原文作同值强制比较；在
此后 public/final 阶段，对比的是已保护 original 的 fixed-native facts，不能 guest
改 metadata 或恢复原 raw visible。safe receipt 和 rule/policy 身份仍逐次核。

增强但无实际 presentation 映射：公开 Hook unavailable，完整保护 core；若也无原
factory 的可见 presentation，则拒本门。不能 substring 拆 hidden context 或把完整
增强正文放进气泡。公开媒体 occurrence 的移动/删除约束仍沿现严格 validator；新
formatter不增加媒体、不打开 attachment 文件、不重复原附件 Hook。

## 原来源位与完整 23 列

新增轻 `db/function-conversation-native-human-projection.ts` 私有 variant 表，只 type
imports，不 import index/Store/NativeInput 的值，避免 DB 循环依赖。main presentation
在完成私有 proof 核验后注册 opaque variant；variant 固定 actual producer/run/occurrence/
target/destination/UUID/user role，原 guard 和 safe candidate 地址。SDK/JSON 不接它。

NativeAdoption 可选这个 actual variant；没有它仍原 AI/Tool project。NativeProjection
在真实 capture/prepare/claim/verify 各阶段核原 variant 身份和 guard；它不是字符串
`human=true` 或 caller columns 权限。prepared once、alias CAS、baseline 双读、provider
collision、真实 sameDB txn、23列 durable receipt、0 fragments/state、unknown COMMIT
原 claim readback与 COMMIT 后才释放 held 全部保留。

既有 user baseline 采用只允许三类结果：

- content_json：由已登记 final safe Human 的可见正文，经原一次 user formatter。
- function_row_json：真实新 canonical stamp，与完整 row receipt 相符。
- recovery_integrity：`min(originalBaselineIntegrity, actualVisibleFormatterIntegrity)`；
  null/0 不升级，任一截短/不可完整显示为 0。完整 Keeper 不使 UI 获得完整标记。

所有其余原列固定，包括 priority/stream_authority、provider、prompt_origin、reasoning/
toolcalls/call/name/status/is_error、Goal/window/times/ordinal。Human 不提供 finalExecution
driver，不借 AI tool_calls_json 例外。即使 protectedColumns 按 generic formatter 给出
7 位，Human variant 也只能采用原 baseline 来源位；本案不改变普通 streaming 规则。

plugin prompt 原 prompt_origin 必须来自原真实 row 和 receipt；保 null 或原值。row 的
origin 仍独立原 NativeInput source，不能从 prompt_origin JSON 获得 execution 权限。

fresh input 无 baseline 时，Goal/window/times/来源位不能从最终 Human 回猜。需要原
入口在确定真实 first-write 参数时同步生成 native-only fresh-write intent，固定原
ThreadMessageWrite 地址/原 formatter 数据及独立 physical/source proof。clone、公开
数字、后来 thread 最新 Goal 都不能替它。实际 fresh ordinal 仍由原 Keeper 同事务
bucket 分配；intent 只决定非 ordinal 字段，不提供 caller ordinal。

若本轮 Root 尚未提供实际 fresh-write intent，则该 fresh input 分支明确 unavailable；
不能偷偷使用 generic fresh defaults。原正常已写 user baseline 不受这项影响。真实
skipped UI（blank/workflow plumbing）需原 producer 的明确 disposition，不能插入新
气泡改变旧使用方式。Root 已确认原函数加可选 actualonWrite，原 boolean 返回与其他
调用不变；本 run 局部保存私有 intent。构造 original actual Write 时、首 DB 操作前
同步 capture；它晚与同 run 的 actual NativeInput source/UUID/DB/inc/formatter 映射
绑定，不把 caller 的 scope 字符串或 protectedColumns 当 proof。真正非 skipped 的
fresh 写仍需原实际写后读回/unknownCOMMIT exactclaim 明确资格；无 ACK 不变成 saved。
`write` 只表示原写入计划，不在首 SQL 前错误宣称 persisted 或完整 Keeper ACK。

blank/plumbing 的 intent 记录原真实 formatter disposition，保持原 no-bubble 用户
行为；不能通过缺行推断 skipped，也不能让合法旧 skipped flow 默认报错。这一支
Root 需在实际 Host/显示合同中实现完整保护与原 no-bubble persistence 语义后才称
接通，不能借本 formatter 的普通 fresh insert 增加空气泡。已有 baseline 可以先
实施并实际验收，无须等待该罕见新接缝；缺事实则安全 unavailable，绝无 raw fallback。

Tool-message Human fresh 行没有用户 submission 的原 flags。后续实际 ToolReturn
adapter 的私有 writer intent 可使用纯 formatter 并固定其 own tool producer；它不
借 prompt origin/Goal/composer receipt，不把 side row 当用户发送。

## 范围与验证

作者可拥有新 presentation/轻 variant 模块与对应 tests、NativeAdoption 可选 variant
和 NativeProjection 的窄 source-column 分支。Root owns Keeper notification/actual input
producer/fresh-write intent/Host retain/handoff；Official index canonical UI hydrate另接。
第一阶段 helper不能代称实际用户发送已完成，也不能以缺接线称框架限制。

必须有真实 AppDB/Store/protector/actualInput+Manager：plain rewrite；enhanced final safe
visible与完整 HTTP Human 不相同但各正确；无 actual visible receipt拒；clone/metadata
forged/result foreign或changed拒；getter/Proxy/toJSON0；原23列/promptOrigin/Goal/times/
source bits保持；大 UI截短0而 full Keeper byte完整；baseline0不升级；raw/CAS/alias
失效全事务 rollback；fresh mandatory intent与真实 bucket；两个 candidate source活而
旧 presentation失效；actual tool side token不能借prompt。真正 ACK+drain handoff、
Electron/managed HTTP/媒体/下一turn分别由 Root 门禁，不复用 helper单测冒称通过。
