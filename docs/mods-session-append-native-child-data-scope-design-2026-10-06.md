# 子任务完整数据尾的同步联合读取

这是只读源码分析后的下一项窄提案，尚未授权实现。真实 native=true 并行旧例仍在原
5 秒门下失败：329834 次 fresh get，查询约 4509ms，整例约 6409ms，记录在
`output/stage23-native-child-query-count-fourth-true-only.log`。不延长测试，不缓存行或
权限有效性，不减少任何原 Source、runtime、policy、Store 或最终消息回验。

## 实际重复边界

`conversation-shared-restore.ts` 的 Producer.assertDataCurrent 先调用真实 registration 的
assertDataCurrent。后者调用 Families.assertSharedDataCurrent，鲜读 checkpoint/destination
两个线程 incarnation，再鲜读 owner.context.threadId 的 incarnation。随后 Producer 又调用
NativeDestinationDataCurrent。这个调用的原完整 JOIN 已鲜读 target、parent、checkpoint、
destination 四个线程、两个原 ref 以及完整 mapping。上述三次线程读的事实已在这个 JOIN
内，但它们仍分别执行。这个数据尾内部没有原 Source 回调、await 或业务写入。

只合并该明确数据尾。Producer.assertCurrent、Active/nativeRead 原 full guard、registration
full、family/owner/backend/destination full、policy full、原 Store 检查和所有末尾数据检查的
次数与位置保持。每次独立 assertDataCurrent 都重新执行一次完整 JOIN，不能复用上一次
调用、前一回调之前、另一 policy tail 或另一次 runtime guard 的读成功。

## 精确接口与私有关系

数据库 destination 模块新增 opaque `FunctionConversationNativeDestinationDataScope`。
模块只在真实 destinationData WeakMap 命中原 destination/原 DB 后建立同步 scope：

```ts
withFunctionConversationNativeDestinationDataScope(
  destination: FunctionConversationNativeDestination,
  database: NativeSqliteAdapter,
  inspect: (scope: FunctionConversationNativeDestinationDataScope) => void
): void

assertFunctionConversationNativeDestinationScopeThread(
  scope: FunctionConversationNativeDestinationDataScope,
  destination: FunctionConversationNativeDestination,
  database: NativeSqliteAdapter,
  threadId: string,
  incarnation: ThreadIncarnation
): void
```

这是数据比较接口，不授 authority、目标、运行域或 checkpoint 权限。scope 首先运行原
完整 destination JOIN/data 验证，再为本次 fresh 结果建立私有记录；只有原四个实际 thread
ID 可以在该 scope 内检查。读出的数据由原 Adapter 返回的 SQL primitive 构造，不触
public getter、toJSON 或 iterator。检查 incarnation 使用原 token/legacyCreatedAt 语义，
不能把有效 token 的备用时间当新限制，也不能把 null-token 放宽。原 mapping m.* 全列、
别名冲突门、ref 的所有字段及原 destination metadata/hash 检查保留。

inspect 只由下述模块内已固定的纯数据组合调用，不包含原 Source/runtime/policy callback、
异步操作、业务写入或 caller formatter。只接受 undefined 返回，拒绝其它返回值，不调用
then/getter。首 fresh query 前占用本次原 destination 的 reading/failed latch；caught 同地址
重入毒化外层，这次失败不能被 inspector 捕获后继续成功。不同真实 destination 可以独立读。
finally 使 scope 失活并删除该 fresh row；泄漏 token、clone、foreign DB/destination 和
inspect 结束后的再用均拒绝。没有 ambient ALS 或全局成功状态。

Coordinator 的原 registration 私表新增一个只给实际 Producer 构造时使用的 checker：

```ts
captureFunctionConversationSharedRegistrationDataChecker(
  registration: FunctionConversationSharedNativeRegistration,
  authority: ModRuntimeAuthority,
  destination: FunctionConversationNativeDestination
): FunctionConversationSharedRegistrationDataChecker | undefined

// checker 自造且固定，调用者不能注册覆盖 callback。
checker.assertInDestinationScope(scope): void
```

checker 在实际 registration/authority 私表命中后，从原 family/owner 捕获真实关系。必须
逐项证明 family 的 checkpoint ID/incarnation 与 destination 原 checkpoint 相同，family 的
destination ID/incarnation 与 destination 原 destination 相同，owner.context.threadId 及其
原 incarnation 被该 destination 的实际 parent/target thread 覆盖。还须固定原 registration、
family proof、owner、target、destination、authority 与这些私表记录的地址。字符串相等
或 caller 提供的 covered=true 不取得资格。无法证明覆盖时返回 undefined，保留原数据链。
未知 registration、clone 或 foreign authority 按原门拒绝；不能以 fallback 造新资格。

checker 仅把上述三次线程事实比较改用该 fresh scope；原 family、owner、Coordinator、
Registry 的 live/maps/authority-ancestor/physical-lease/signals 检查全部执行，前后私表关系
再核。family 仍检查 child/parent 各原 signal、原 leaseCurrent 和 genuine authority data；
Registry 仍核 original target/backend/resident/children/authority 索引及 controller。

Producer.complete 在原完整准入通过后捕获这个 checker。其 assertDataCurrent 保原最早
failed/authority/DB/active/reservation/scope.closed/signal 检查，再：

```ts
if (genuineChecker) {
  withFunctionConversationNativeDestinationDataScope(destination, database, scope => {
    genuineChecker.assertInDestinationScope(scope)
  })
} else {
  registration.assertDataCurrent()
  assertFunctionConversationNativeDestinationDataCurrent(destination, database)
}
// 原 Producer 私表、reservation、completed、DB 纯尾继续执行。
```

普通 data/full API 的语义不变。此提案不把 data scope 传入任何原 full callback，也不让
Store.assertCurrent、Keeper、Adoption、最终 finalized tail 或 generic callback 借该 scope
删除自己的独立读。首次 destination 准入、创建事务、冷恢复 membership、cleanup 均不改。

## 实现窗口与验证

拟改 destination 模块的私有 snapshot 读取与新增 scope、Coordinator registration 数据
checker、Families 的纯数据检查分离、Producer 的上述单一数据尾及对应测试。Manager、
Host、Tools、Node、Generic Store 和普通插件链不改。Root 需先明确这些原区域的所有权，
两次独立设计通过后才实施。

需要真实 AppDB/Manager/lease/shared admission/Saver 回归：每次独立 data 尾确实 fresh
JOIN；最后原 full callback 修改 checkpoint/destination/owner incarnation、mapping/ref/
metadata、lease、genuine child/parent authority、registration/target/index/signal 都拒绝。
两次读之间直接 SQL 变更必须被第二次读拒绝。clone/foreign/expired scope、caught reentry、
callback/thenable inspect 和不被覆盖的合法 generic 分支均不能省检查。完整 extra mapping
列、late alias 冲突、任一 JOIN 行缺失与旧 32 destination 门保留。实际 native=false/true、
resident Hook/HTTP、held cleanup、原完整 CP/UI/工具只执行一次以及原默认 5 秒另外串行跑。

若实际分类统计表明热点主要在 full 链的其它读，这一小合并不能称已解决性能。后续可
另审 family 同一最后 full callback 之后的三次纯线程读取合成一次 fresh SELECT，但不在
本窗口扩入，也不通过缓存或省 Source 来取得性能通过。

## 获两票后的实施接点

Root 第一票与 Official 独立第二票通过后，本窗口只编辑 Destination、Families、Coordinator、
Producer 四源及新 `conversation-shared-data-scope.test.ts`。Destination 私表的纯 coverage
读取为 `matchesFunctionConversationNativeDestinationData(destination, db, target, parent)` 和
`coversFunctionConversationNativeDestinationThread(destination, db, threadId, incarnation)`：
仅真实 reader 的 original DB/ref/thread 事实可以命中，两个函数不读 SQL、不回调、不 mint
授权。Coordinator 的真实 registration 工厂私表保存 capture closure，不能由 override 的
Coordinator 方法注册 checker。Family 的 checker 固定 original proof/authority/lease 与
模块自己的数据事实检查；Registry 仍用 original data 方法。它们只把原三次线程比较转入
scope，并保留所有前后内存、authority、lease 和 signal 核验。

新真实 Manager/AppDB/SharedScope/Saver suite 定义独立 fresh JOIN 计数、0 Source callback、
scope clone/foreign/过期、genuine 未覆盖 mapping、caught 重入和非同步 inspector，以及
两次调用之间和最后原 Source 回调的 SQL/lease/owner/authority 变化阴性。此处只记录定义，
不代 Root 的实际运行或原默认 5 秒性能门。

## 私有纯 checker 的固定函数补充

Root 独立 SOURCE 复审发现：晚取 Family/Registry 的 prototype 方法再 bind/call，仍可能
把原 Source 回调后来设置的 getter 或替换函数带入 inspect。因此此前 99 实际绿色只证明
数据功能，不能计为这个纯函数关系已封口。Root 第一与 Official 独立第二设计批准增加
Registry 的窄固定 reader：Family 在 class evaluation static block 捕获原 facts/capture，
Registry 同样捕获原 data 函数；模块私表只登记其真实构造实例。导出的 module-free reader
先核原实例地址，再 Reflect.apply 固定函数，不接受外部认证 callback，也不晚取
this.method、prototype.method、call/bind 或 getter。Coordinator 组合只用这些固定 reader。
Coordinator 的 constructor 私表另外固定原 registry/families 地址；组合前后只比较其 own
data descriptor，不执行后来替换的字段 getter。

这些数据 facts 的 signal 检查使用 module-load 时捕获的 AbortSignal 原生
throwIfAborted 函数，保留原 signal 对象，不执行后来安装的 own method。Producer 的
纯数据入口同样使用该 intrinsic；full source guard 的原调用链保持。Family 的 physical
lease checker 仍来自原 thread-run-lease 模块的 actual lease 闭包，不接受 caller checker。
Root 另独占 runtime-instance 的原 aborted getter 固定接点，authority 与 ancestor 关系不变。

新增真实 own/prototype getter、函数替换、signal method、clone/Proxy/foreign actual instance
以及 Coordinator 字段 getter 回归，结合原最后 Source 撤销测试。第一修订 suite 共 26 个展开
定义；它的 109 实际绿色仍不能计为下面新增完整纯叶子封口。需要修后独立 SOURCE 与实际新门禁，不沿用修前
99 或默认 5 秒结果。

## 原集合字段与纯叶子封口

Official 独立 SOURCE 找到下一 P1：TypeScript private 字段仍是可改 own property，固定
method 内晚读 this.sharedChildren 等字段会执行 getter；即使 getter 返回原集合，也可以在
fresh JOIN 后改数据库。此前 5-source 完整纯性票暂停。Root 第一与 Official 第二设计批准
第六源 `conversation-shared-checkpointer.ts` 及如下准确数据依赖，原 full/public 链不删：

- Family：constructor 私表固定 sharedChildren/sharedAuthorities/liveShared，fields 的原
  own data descriptor/value/prototype/flags 每次先核，随后仅私表持有的集合做原生读取。
- Registry：固定 residents/targets/records/authorities；closed 必须 own data boolean 与原
  flags，close 首行还设置模块私表不可逆关闭位。真正数据核验使用原集合与原 entry/resident。
- Coordinator：固定 sharedNativeRegistrations/sharedTargets/destinations/owners/current
  和前述 registry/families，组合只读 constructor 私表中的原引用。
- 这些原集合的 get/has 使用 module-load 捕获的 WeakMap.get/Map.get/Set.has，通过
  Reflect.apply 读同一原集合，不能执行后来安装在集合上的 own 方法或 getter。

实际 shared child、Registry entry/resident、Coordinator owner 在各自原工厂中保存纯事实
私表。inspect 用到的 readonly 来源指针（parent/input/proof/lease/controller/backend/context、
owner incarnation 等）只核 own data descriptor 与原 prototype/value/flags；live/active 仅
own boolean。返回值使用捕获的原指针和纯 scalar 副本；不能核完后再读可变原 record。
controller 的 signal 用固定原 AbortController.signal getter 捕获地址；其后 AbortSignal
检查仍用固定原 intrinsic。原 actual lease checker 只比较 thread-run-lease 模块私有
activeLeases.get(threadId) 与当初 lease 地址，没有 caller 方法、字段、或业务回调。

Scope 仅成功原 constructor 在模块私表注册真实实例与原 closed 描述符。新增 free reader
`isFunctionConversationSharedCheckpointScopeDataClosed(scope)` 先核 exact 私表，clone/Proxy
未知对象拒绝且 0 trap；再核 own closed 的 boolean/value/flags 与模块不可逆关闭位。
原 close/quarantine 首行标记关闭，原 public/full 流程保持。Producer 只用该 reader，不再
调用 public isClosed，也不只靠固定方法读取可变 this.closed。

新 suite 共 51 个展开定义。增量覆盖全部 14 个原集合/关闭字段的真实 getter 数据库副作用
阴性，3 个含原 entries 的替代集合、6 个原 record 叶子 getter、原集合 own get/has 的 0
callback 正向，以及 Scope 不可复活/clone/Proxy。getter 若执行会修改实际 mapping；断言
get0/实际数据不变/model0，原完整 fresh JOIN、独立 read、reentry、Source 最后撤销全保。
定义没有由本代理执行；修后源码与实际 gate 单独记录，不借 99/109 或原 resident 红门。
