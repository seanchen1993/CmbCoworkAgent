# Completed AIMessageChunk 的 ModelCurrent 纯数据调查

状态：只读调查与待审方案，未授权改源码、未运行性能门。现有 ModelCurrent 只对完整
AIMessage 开启认证 current，Chunk 继续原 completed capture 链。Latest 的 SSE OMIT
Attempt 返回数据追加是独立来源，不能借它取得这里的真实 Node 输出权限。

## 源码事实

`native-model-current.ts` 先核真实 Slot 的原 runtime pin 与 Manager genuine policy source，
首 readSlot 回调前登记 preparing/reading/failed 私有记录。当前 exact prototype 必须为
AIMessage；Chunk 明确返回旧链。完整 current 保原 policy/runtime full 前后与 raw digest，
纯尾保 Slot、policy、cut、Host latch 和原完整数据。

`captureNativeMessageForCompletedOccurrence` 为初次 Chunk 转换读取真 Slot，前后多次
调用完整 readSlot，再通过 `captureCompletedNativeNodeData` descriptor-safe 捕获原 Chunk。
它随后只用安全副本构造完整 AI，恢复全部 calls/chunks/usage/metadata，处理已认证 v1
派生别名并完整重核。它不能直接作为纯尾，因为 readSlot 会执行原宿主 source guard，
且每次会重新构造 full AI。初次转换的所有合同仍有必要，不应删掉。

Node 的私有 slots 表已有 record.view、record.work、record.assertStructure；
`readFunctionConversationNativeNodeSlotRuntime` 与 structure reader 都从真 Slot 取原 Work，
不能由 public stamp/JSON/对象字段造出。actual Slot 只在原 installed bound 完成以后、
writers 之前登记，固定 exact completed output message 地址。

## 最小能力与来源

建议 Node 新增仅数据 reader：

```ts
readFunctionConversationNativeNodeSlotData(slot): FunctionConversationNativeNodeSlotView
```

它先 exact 私有 WeakMap，调用原 record.assertStructure，再返回同一 frozen view。
不得调用 view.assertCurrent、policy/runtime/Host 回调，不接受 caller inspector。
原 view 仍只是 Node 数据来源，不是 target、append 或 Keeper receipt。
同 slot 的 runtime 继续由原 Work 私有 pin 校验，纯 reader不能改 runtime/Source 关系。
clone/Proxy/unknown Slot 在任何 Reflect/brand 前因私表缺失拒绝。

纯 structure 的 actual signal 检查需先收口原 Node 的
`AbortSignal.prototype.throwIfAborted.call(config.signal)`：module-load 捕获原方法，
Reflect.apply 到原 signal 地址；不读晚 method/call/bind。ModelCurrent bounded 同理。
这仅保真实 signal/cut，原完整 source callback 次数不变。shared domain 的 pure data
依赖须继续使用已封口 genuine Producer；不得把 generic callback 当纯 reader。

typed capture 新增仅 Node digest 接点，建议：

```ts
captureCompletedNativeNodeRawData(slot, stableUuid, assertBoundedWork): {
  readonly originalDigest: string
}
```

它以新 pure reader 核 exact model_request、exact AIMessageChunk.prototype 与原 message
地址，descriptor 捕获前后都核 same frozen view/private Slot structure。内部共用原
`captureMessage(..., "completed")`，保全部 kwargs/calls/invalid/chunks/usage/thinking/
metadata、Proxy 首拒、accessor0、binary suppression、1M 展开与完整 UTF16 字节。
若 executionSuppressed，明确拒。返回值不含 raw snapshot、安全类、serializer 或权限。
此入口不得接受 raw chunk，也不得接受 Calls partial/completed-candidate token。
ordinary 四个 full prototype 的表和旧 completed conversion helper 均不扩大。

## ModelCurrent 合同

只在 genuine completed Node Slot + same original runtime pin + genuine Manager policy
certificate 齐备时扩入 exact Chunk。沿用当前 earliest preparing/reading/sticky failed latch；
same slot 的 foreign/missing certificate 重入继续毒化外层，不补第二份基线。

Host 初次 finalizer 仍实际 calls.returned 与 Slot.message 地址 join，先走原完整 completed
conversion、first full protection 和 Keeper。ModelCurrent 记录的是那次原 Chunk 的
originalDigest，不以 normalized full AI snapshot.digest 替换。v1 safe full alias只是初次
安全类转换，不回写 raw chunk；原完整 serializer 字节门保持。

认证 full current 仍执行原 policy/source full guard前后；中间 fresh descriptor raw capture
改用 genuine Slot digest。pure tail 只核 original runtime/Slot structure、genuine policy
data tail、Host latch、原 signal/cut 与 fresh full originalDigest。每次读都重遍历完整 raw，
不缓存成功、freeze raw、按 identity 跳过，也不复用上一读 SQL 结果。

generic/no certificate/no runtime pin、Human/Input/Tool、未完成 partial、ordinary Chunk
全部保旧链。SSE OMIT 的 actual Attempt return 只读 raw digest 继续其独立合同，不能
注册 ModelCurrent、mint Slot 或证明 writer/target。这两个新增 typed 接点只可共享最内层
descriptor 算法，不共享权限 reader或外层 token。

## 真正回归与限度

- 真 known Node bound 返回 complete aggregate Chunk，genuine Manager/lease/Store/Saver
  与 policy source，初次 safe full AI 全 calls/chunks/thinking/v1 字节仍 exact。
- pure tail 计 full source callback 为零，full current仍实际新检查；同 chunk 之后的 content、
  kwargs、calls、args、chunks、usage、reasoning/metadata 变更均拒，不以 safe ACK 盖住原变更。
- 最后 full callback 改 raw/Slot/task/ns/runtime/policy、真实 abort、Host/Node close、同 slot
  caught foreign-cert 重入都0新ACK/Provider，不删旧 metadata/执行事实阴性。
- ordinary rawpartial、Calls completed candidate、Slot clone、foreign genuine runtime、无 pin
  或 policy clone 都不能进入新 current；旧 fallback 保持。
- original signal own getter/replacement0、真实 abort拒；无默认 timeout 变更。Root 另跑原
  Model25、completed capture、Host 与真实 resident/default5性能门。

该方案只消除已认证 completed Chunk current 内重复的完整 Slot/source 回调与安全类构造，
不承诺解决 resident HTTP 34秒或所有 child fullguard乘法。需两设计票、精确 Owner 窗口、
两源码票和 Root 实际门后才可称这个优化通过。
