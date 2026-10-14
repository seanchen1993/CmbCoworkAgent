# 原生流片段的 typed-only 复制接缝

2026-10-05。Root 正式第一设计票 PASS、Official 正式第二设计票 PASS。
Calls、Host partial 分支、typed capture internal partial 路径及新 helper/tests 已完成源码，
等待 Root 串行真实门禁；本契约不开放 events/SSE 或其他流模式。

## 已确认的原始调用

`function-conversation-native-calls.ts` 的 `handleLLMNewToken` 在真实模型调用 ALS 中，
按原 callback runId 查此前接纳的 attempt，并把 `fields.chunk.message` 的确切地址记入
私有 chunks WeakMap。模型 task、原 read 函数、checkpoint namespace 与当前物理运行
分别核验；公开 message ID、event runId 或相等 JSON 都不能创建这条关系。

`function-conversation-native-host.ts` 的 `message` 当前先调用 `calls.chunk(raw)`，
但 inactive policy 分支随后执行 `JSON.parse(JSON.stringify(raw))`。这次原 toJSON
发生在最终 Node/完整 Keeper typed capture 之前。forced policy 的原片段虽不输出，
并不能证明 inactive policy 下 own getter/toJSON 未执行。

本机 `@langchain/core/dist/messages/ai.js` 的 AIMessageChunk constructor 可能根据
tool_call_chunks 重新 collapse/parse 执行字段；Serializable.toJSON 又会读取
lc_kwargs 对应属性与原型 aliases。因此不能把原 raw 直接交 constructor/toJSON，
也不能把重新解析出的 tool calls 当成已认证的原执行事实。

## 私有来源与精确 API

Calls 新增 `capturePartial(raw: object): FunctionNativeModelPartial | undefined`。
这个 opaque token 只能从原 chunks WeakMap 中唯一的未 sealed attempt 创建；clone、
普通 AIMessageChunk、同 ID 不同地址、历史对象或 completed-result 表都不能 mint。
记录固定 actual Calls owner、actual Call/Attempt、raw 地址及原 signal。它只授读取这次
partial，不授 target、原图输出、completed slot、Keeper、写入或原 authority。

Calls 模块的 host-only `readFunctionNativeModelPartial(token)` 用独立 WeakMap 校验，
返回固定 raw/UUID/provider tuple/policy/signal 与完整 `assertCurrent`。每次读取都核
原 chunks 关系和 attempt 身份、原 Call/task/read/ns/runtime/policy；回调返回后纯核
owner closed、attempt sealed/failed、WeakMap 关系与 signal，不能使用旧 view.sealed
布尔值。回调导致 seal/close 后不得晚输出片段。

新增 internal `capturePartialNativeModelData(token, assertBoundedWork?)`，以及
host-only `projectFunctionConversationNativePartial(token, metadata)`。
typed core 只增加专用 internal partial 模式，不扩大普通四种完整 message prototype
表；completed-only helper 仍只认 NativeNode slot。新 helper 在任何方法/构造/JSON 前
核 exact AIMessageChunk.prototype、native own brand/type、own data descriptors、Proxy、
所有 raw own method/getter、lc_kwargs 和实际 tool_call_chunks 字段。

完整来源 guard 在复制前后执行，纯同步遍历内仅原 signal/monotonic deadline 与当前
1,000,000 expanded-node 上限。保留完整数据、UTF16 digest、二进制压制及结构化执行
字段规则；执行结构被压制则拒绝，不把 placeholder 当合法 tool args。不得引入更高
公开预算、跨调用 digest 缓存或对 original raw 的冻结。

返回 `{message: AIMessageChunk, originalDigest, snapshot}`，其中 message 为只由安全
副本产生的同类对象，UUID 仅替换为原 attempt 的稳定 UUID。已知 constructor仅接
固定空 seed `{content:"",tool_call_chunks:[]}`，不让它重新parse未完成args或改动
baseline copied arrays。构造后显式恢复已复制的
原 content/calls/invalid/chunks/usage/metadata/lc_kwargs，不重 parse/concat，不用 full
AI constructor 改变 v1 content；再次 descriptor typed capture 确认全部字段一致。
safe message 的存在仍不提供 completed-source 证明，Calls.returned 与 Node slot 必须
继续按确切原完成对象独立 join。

Host 仅把这个 safe 同类副本交原 serializer，并在副本 additional_kwargs 加上原
已接纳 provider tuple。拒绝原 partial 中 function_row/function_row_invalid 标记；
不会因片段公开元数据生成 canonical receipt。required protection 继续零原片段输出。

## 最后一次回调与显示元数据

partial metadata 也须在原 getter/JSON 前 descriptor-safe copy。使用原 source 的
实际 metadata 地址和固定副本，不从公开 task namespace 猜来源。来源完整 guard
返回后必须再次纯核 raw digest、metadata digest、policy 固定事实、private token
关系、sealed/closed/signal，再从固定副本返回。尾检查后不再调用原 source/prototype
formatter/user callback。unsafe metadata 明确拒绝，不能以消息已认证旁授整个对象。

safe 副本自身序列化只执行已知 native prototype 代码；copy 前不能读取 contentBlocks
getter。若安全副本序列化需要额外 provider translator 或未经确认的 getter分支，必须
改为固定纯 DTO adapter 并补其真实 byte golden，不能回退 raw.toJSON。

## 真实回归清单与实施范围

使用真实 BaseChatModel streaming callback、createAgent、Native Host/Calls、SqlJsSaver
和 AppDB/Manager。普通 capture(raw chunk) 与 completed helper(raw/clone token) 仍拒绝。
覆盖缺失/重复 provider ID、同 raw 多 attempt 歧义、原 retry、两并行 actual source，
chunk calls/v1/invalid/usage/metadata完整保留；getter/toJSON/Proxy计数零、binary执行
结构拒绝、sparse/大行仍受原界限约束。

forced 模式 partial0；inactive 原序/稳定 UUID/provider occurrence，与原安全实例序列化
逐字一致。guard 同步改 raw、metadata、policy、seal/close 均拒；取消后晚片段0。
full Keeper/真实 CP仍只有原 completed slot准入，partial token不能保存/重放图输出。

本轮新增 partial helper/tests，Calls增加私有token，typed core窄复用descriptor遍历，
Host仅替换 partial 区域原 raw stringify。实际 AppDB/Manager/createAgent/Saver 新 helper
18项、Calls新增1项、typed capture新增1项；原32项UTF16/capture测试保持。源码冻结不
代表这些门禁已经通过，任何单 helper基础PASS不能代替产品serializer与实际 stream门禁。
