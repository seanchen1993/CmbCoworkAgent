# Tool-side 原生 guard 的一次完整来源复核

2026-10-05。具体下一步提案，等待 Root 与独立评审两票；尚未修改性能源码、运行测试或
调整时限。`stage23-native-tool-side-first.log` 保留 181/185 的首轮结果：两个夹具错误已按
实际契约修订；旧 ToolHuman 与新的 held System 各有一个默认 5 秒超时，不能记为完成。

## 已定位的重复范围

`function-conversation-native-host.ts` 的 side guard 当前执行：

1. `baseGuard` 调用同一个 genuine Side source 的 `assertCurrent`。
2. callback-free 的 `captureNativeMessageForOccurrence` 再比较原 raw digest。
3. 第二次 `baseGuard` 再调用同一个 source 的 `assertCurrent`。

Side source 的 `assertCurrent` 本身已经执行完整 raw/policy/cut 数据前检查、原冻结
ToolReturn view 的完整 Work/slot/request/runtime/policy guard、完整数据后检查及私有 latch。
中间 Host typed capture 仅调用它自己的 signal/单调 cut 检查，不调用原 Source、Guest、
formatter、toJSON、getter 或其它 host callback。它的 raw 是同 source.message 地址，UUID
是同 source.uuid；原 source baseline 已认证这两项和完整 native type/body/metadata。

NativeProjection 的 variant、alias 和 source callbacks 是独立边界，本次不合并它们。
仅 Host 的这一个重复 scope，在 genuine Side 路径把两次同 source.full 缩为一次。
Input、ToolHuman、model、ordinary Tool 及 generic Host guard 全保持原行为。本提案不宣称
已解决旧 ToolHuman 的边缘超时；该用例继续使用原完整正文和默认 5 秒实际验收。

## 工厂自造的 current，而非 caller 声称证书

在原 `function-conversation-native-tool-side.ts` 增加工厂：

```ts
captureFunctionConversationNativeToolSideCurrent(
  token: FunctionNativeToolSideReceipt,
  originalHostLatch: object
): () => void
```

它只能读原 Side WeakMap 里的 genuine source。`originalHostLatch` 是实际 Host 首次创建的
单一 own-data `{failed:boolean}` 对象；Host.close 在任何 callback 前把它置为失败。
Proxy、accessor、额外字段、不同 prototype 或原属性描述符变化均拒。这个对象仅能撤销
当前工作，不能选择 target、runtime、来源或政策，更不能宣称其它 callback 已完整复核。
函数由 Side 模块自己构造，不接受 caller 提供的 current/full callback。私有表固定 token、
source、原 Host latch 和所产生的函数地址；同 token 重入或重复 construction sticky 拒绝。

每个独立调用在首 callback 前占 reading latch，然后：

1. 完整 originalHostLatch/源 token、原 source 数据与私有地址检查。
2. 调用原 source.assertCurrent，完整保留原 frozen view/Work/slot/runtime/policy callback。
3. callback-free 完整 source.assertDataCurrent、原 Host latch/函数地址/reading/failed 检查。

捕获异常后即使 caller catch，外层也失败。每次新的调用仍运行原 source.full，不保存成功
SQL 行、authority、policy、文件系统或目标检查，不跨 await、调用或其它 callback 共享结果。
原 30 秒 absolute cut 与三类 signal 保留，不在 helper 里续期。

## Host 的精确接线

Host 在 source 已捕获、且原完整 typed snapshot 与 source.message/source.uuid 一致后，
为该 actual Side token 捕获此原函数。genuine Side guard 使用这个函数；其它 guard 仍走
旧 `baseGuard → typed full digest → baseGuard`。原 Source current 自身仍对完整 raw native
前后校验，新的 helper 最后又检查完整 raw/policy/private address 与原 Host fail latch。

这不会删除任何 independent Source callback：NativeProjection 的 variant/source/alias
各自 fresh scope、Keeper 两轮政策保护、execution facts、actual Store commit/receipt/23列/
ledger A/B、真实 drain、Node finalized data tail全部保留。对同 Source 的已验证完整 raw
typed copy不再做第三份 Host digest，并不允许只比较 content、公开 stamp 或 provider ID。

Host.close 的纯失败 latch 与当前 closed 门同时设置；它不 close 稳定 shared graph 或
其它 domain。创建在一个 domain 的函数不能换入别的 runtime/source；读取闭合关系来自
Side private token，公开 object 的布尔值无法制造这个关系。

## 需要独立源码及真实验收

- 真正最后 original Work/request guard 改 raw body、完整 metadata、policy epoch、binding、
  slot/work 地址或原 Host latch：0 Keeper ACK、0 side canonical/CP/UI，effect只发生一次。
- 同 source current caught 重入和 construction 重入均 sticky；Proxy/getter/toJSON 0。
- 原完整工具与 ToolHuman 门不变；held System 原 raw serializer 0、full safe/provider
  continuation、真实 Worker/drain与所有原 default timeout 保留。
- Root 记录这一个 sync scope 的 source.full 调用数变化；不以源码票、独立 helper 测试
  或缩减 fixture 当成 default 5 秒门通过。若收益不足，继续定位其它独立 scope，不扩此
  方案去删除 generic guard、alias callback 或原完整事实检查。

本次只批准上述一次 current 的私有同源关系，不预批 NativeProjection variant 进一步
消重；任何后续合并必须另有精确 original callback 关系和最终纯尾证明。

## 下一项单独评审：Adoption 的同 runtime 前置检查

上述 current 的实际源码已有两份独立 scoped SOURCE 票。根节点最新门禁为 Side source
48 项和 Node 23 项通过，Host 两个原 ToolHuman 正向仍在默认 5 秒内；held System 实际
5267ms，默认 5 秒仍失败。HTTP 的 UI tool_calls 三字段协议夹具另行修订，不能据此
宣布新 Side 全链已验收。原日志为 `stage23-native-host-side-current-second.log`。

本轮仅提案，不修改生产源码：`function-conversation-native-adoption.ts` 的 guard 当前
逐次执行 original runtime.full、nativeGuard.full、Store.assertCurrent。真正 Side current
来自上方工厂，其完整 source.full 经冻结 ToolReturn view 调用实际 Work/slot full 与
request owner current；owner 保留原 Work full 和同 original runtime 的 genuine policy
certificate full。因此第一个 runtime.full 与紧接的 genuine current 复核同一实际来源。

拟由 Side 模块新增只读私有关系 reader，参数为原 current 函数和 expected actual runtime。
模块内 WeakMap 只登记自身工厂产生的函数地址及原 token/source/runtime/Host latch；无
caller 回调、公开布尔或 metadata 可登记。reader 不执行 source callback，不调用动态
current 属性；clone、bound 函数、wrapper 或另一个 runtime 均不能命中。Adoption 必须
在其自身 `.bind` 前读原函数地址，保存该私有关系，不能以复制出来的函数自证。

仅真命中时，Adoption 的每次新 guard 执行原 nativeGuard FULL、原 Store.assertCurrent，
然后调用关系提供的 callback-free 完整 source raw/policy/cut/private identity/Host latch
尾。原 nativeGuard 内 original Work、slot、request、physical runtime、policy callbacks
全部保持；只省掉其前面同 actual runtime 的重复 full。末尾仍核关系函数/token/source/
runtime exact 地址，不缓存数据库行或权限成功，不跨 await、独立 read 或其它 callback
复用。Source 或 Host 已失败时必须拒绝，不能由 reader 重新捕获新的成功基线。

Input、ToolHuman、model、ordinary Tool、generic 和未知 current 完全保留原三段。Keeper、
NativeProjection、variant、alias、final-execution 以及所有独立 Source callback 均不改；
相同名字、type、runtime public shape 或同政策 digest 不算同源证明。此优化需要新的两
份独立 DESIGN 票后才实施，后续仍需独立 SOURCE 票及原默认 5 秒门。

回归须覆盖：genuine current 能命中且每个独立 guard 仍运行实际 full Source；foreign
runtime、克隆/wrapper callback 不进入精简；最后原 guard 改 body/完整 metadata、policy
epoch、binding、Host close、caught current 重入均拒绝 ACK；所有原 native/23/receipt/
ledger/full CP、保护两轮、effect once 与 true drain 断言不减。查询/guard 数仅作统计，
不当作最新身份事实的证明；没有结果前不承诺 held System 的实际性能已解决。
