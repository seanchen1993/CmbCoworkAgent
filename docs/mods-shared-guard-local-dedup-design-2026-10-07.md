# Shared Manager 相邻 fresh DATA 的局部去重

状态：已放弃，未实施。Root 没有接受此方案；现有证据不足以证明收益，额外复杂度也不
符合当前“具备对应能力”的交付范围。本文仅保留为历史调研，不能作为下一阶段实施清单。
未按本方案修改生产或测试。共享路径的原性能失败继续保留，不因为放弃方案而算通过。

## 目标与当前证据

用户要求对应能力，不要求复刻其他产品的内部调用形状。真实 Shared tool 完整功能诊断
通过，但最新耗时 20.559 秒；原五秒测试仍是失败记录。最终 profile 的 self-time 聚合有
adapter wrapper 2.528 秒、空 URL 的 `get` 4.514 秒。后者可能同时包含 SQLite、Map 与
WeakMap，未经祖先调用点分类不能全部称为 SQL，也不能据本方案预报节省秒数。

本窗只删一个同步业务检查链中相邻的重复 fresh DATA。外部回调前后的检查、真实权限、
lease、取消、数据库外 writer、完整消息、CP、member、23 列和真实 finally/drain 保留。
不缓存 row、SQL 结果、权限决定或成功状态，不跨 await、保护回调或写入复用观察。

## 两条当前执行链

当前 Manager `captureFunctionSharedNativeConversationRuntime` 内约 1212 行：

```ts
assertCaptured()
actual.assertCurrent()
assertCaptured()
actual.assertDataCurrent()
```

`actual` 来自 `readFunctionConversationSharedProducer(captured.proof, authority)` 的真实私表
记录，view 在 `conversation-shared-restore.ts` 原完成处自产并固定。不是 caller 提供的
producer、guard 或“已检查”标志。该原 `assertCurrent` 约 421–434 行按原顺序执行 active、
Source、registration、destination 全检查，最后调用完整 `assertDataCurrent`；成功之后
只有私有 `reading = false` 的 finally，没有另一个业务回调。此最后 DATA 是 fresh A。

当前 Shared policy `assertPolicy` 约 1270 行：

```ts
assertCurrent()
assertTail() // assertPolicyData()，再 actual.assertDataCurrent()
if (this.protects(authority.workspace) !== protectedOutput) changed()
assertTail()
```

`assertCurrent` 已有同次 fresh A。首 Tail 与 A 之间原本只是本地 policy 数据比较；末 Tail
位于真正的 `protects` 可调用接点之后，是 fresh B，必须保留完整执行。

## 不能直接删 DATA 的原因

`assertCaptured` 当前调用 `original.assertFields`、`assertRecord`、`assertCoordinator`，
再检查 closed、真实 private producer/binding/scope、physical binding 与 registry authority。
这些对象、字段和私集合是本次原工厂捕获的真实地址，但其中的调用表达式不是全部固定：

| 接点 | 当前成功路径依赖 |
| --- | --- |
| `captureNativePolicyFields` 返回的三个 reader | `types.isProxy`、`Object.getPrototypeOf`、`Object.getOwnPropertyDescriptor` |
| 原 manager 私集合 reader | 已固定的 Map.get/WeakMap.get，经动态 `Reflect.apply` 调用 |
| registry authority data reader | 原私 lineage、Map/WeakMap、已固定 signal.aborted getter；descriptor 比较仍用动态 Object 方法，调用仍经动态 Reflect.apply |

晚替换 Object/Reflect 方法可以委托原方法、同步写 SQL，然后恢复原地址。只在调用结束后
检查地址，会漏掉已经发生的写入。因此“函数名叫 data”不能成为删除末 DATA 的理由。

`assertPolicyData` 还调用 epoch reader 与 `captureFunctionConversationNativePolicyData`。
后者检查 own declarative fields并重建 deployment，但目前还依赖动态 `Reflect.ownKeys`、
`Object.freeze`、`Array.isArray`、`Number.isInteger`、`String`、RegExp.test/exec。捕获的
JSON.stringify 本身也可能调用重建对象或数组从原型继承的 `toJSON`。首 Tail 同样不能
无条件改成 Data。

## 精确候选：当次原 callee 命中才去重

唯一生产候选仍是 Manager。新增一个 module-local、只读的 eligibility；没有 export、
私 proof、caller 注册、receipt、Source 资格或持久“纯”状态。它不能用于其他 guard 或
公共/custom producer。原真实 Producer reader、原 FULL/DATA 方法和 policy reader 不改。

1. Manager module evaluation、未知业务回调之前，捕获原 global 对象、相关成员完整
   own data descriptor，以及原 `Object.getOwnPropertyDescriptor`/`Reflect.apply` 等函数。
   eligibility 本身只用这些固定函数读原普通对象的 descriptor，不执行当前 getter。
   任一 accessor、地址或 descriptor flags 变化，返回 false，不能调用它探测纯度。
2. 每次在原 FULL 成功后、待去重本地检查开始之前重新计算 eligibility；不在本地检查
   结束后重新观察并把之前的 false 升级为 true。结果只存本次栈内 boolean。
3. runtime 叶的闭合清单是 global Object/Reflect 的原 own data 地址，以及 Object 的
   getPrototypeOf/getOwnPropertyDescriptor、Reflect.apply、types.isProxy 的原函数/flags。
   原 Map/WeakMap 方法与 signal getter已经由原模块捕获，仍使用原 reader；不读它们的
   public late 方法。导入的 authority data reader 使用本模块初始捕获的同一函数关系，
   不能把 caller 替换的 reader 加入 eligibility。此规则只保护原 private-reader 执行链。
4. policy 叶在上述条件上还检查原 Array/Number/String 对象或 callable 地址、相关原型
   地址，以及 Array.isArray、Number.isInteger、Object.freeze、Reflect.ownKeys、真实
   RegExp 原型 test/exec 的完整 own data descriptor。JSON.stringify 仍是 policy 模块
   已捕获的原函数；普通重建对象/数组的原型链必须仍为原 Object/Array 原型，且两原型
   都没有 own `toJSON`（Object 原型父链仍为 null）。不得调用 toJSON 来决定 eligibility。
   policy reader 的同一模块原函数关系也固定；不观察任意外部自称 declarative 的函数。
5. false 分支完整保原 FULL→本地检查→fresh DATA，包括原动态 callee 的求值与效果。
   即使替换函数调用后立即恢复，也使用调用前的 false 保留 DATA。eligibility 是性能
   分支；失败不授新权限，不给 producer 换身份，也不以异常码决定成功。

runtime 原位置候选：

```ts
assertCaptured()
actual.assertCurrent()
const capturedTailIsPure = sharedCapturedTailCalleesCurrent()
assertCaptured()
if (!capturedTailIsPure) actual.assertDataCurrent()
```

policy 原位置候选：

```ts
assertCurrent()
if (sharedPolicyTailCalleesCurrent()) assertPolicyData()
else assertTail()
if (this.protects(authority.workspace) !== protectedOutput) changed()
assertTail()
```

这不是把所有函数改成固定调用。原本的动态检查保持；仅当其当次完整调用链仍为原
只读 callee 时，末邻接 DATA 被判定为重复。未命中保原路径。禁止只检查 Object 的一个
方法、只做 post-check，或只按“全局函数刚恢复”省 DATA。资格 helper 必须通过源码审
逐项对照这份闭合清单；若实际实现无法在 Manager 内闭合某个接点，本窗保留该叶原链，
不能临时新增跨模块 producer 注册或删除 fresh 检查来达成两叶数字。

可以先独立落 runtime 一叶并实测；policy 叶依赖较多，若新增 descriptor 检查成本抵消
收益，则保原 policy 链。两叶分别可审、可撤，不把有条件优化当全局 guard 合并器。

## fresh A/B 的保留位置与业务限制

真正 Source、active、registration、destination FULL 内的原回调与其末 DATA 全部不删。
本地纯尾未跨 await，A 仍是同次 FULL 末尾的真实 fresh SQL；不存在旧 row 复用。外部
writer 与删除重建仍由这个 A 以及后续所有原回调/写入边界 fresh B 拒绝。此设计不声称
一次 SELECT 能保证之后持续不变，也不制造事务锁；原链本来也不是整个调用的事务。

`protects` 调用前 A 和调用后的完整 Tail/B 都保留。policy epoch、完整 deployment、
digest/signature、当前 runtime/owner/binding/authority 与关闭/abort 检查不删。
Host 各字段的 `assertBoundedWork` 保原次数和顺序；保护、writer、ACK、完整23列 CAS 与
Node/Host/Scope finally 也不在本窗内。不得将 Destination 的多个 alias 按相同 threadId
合并，或将 Coordinator/Child/Source 的独立 SQL 都装进一个跨回调的旧 snapshot。

普通 native runtime、未命中 Shared private Producer、custom/generic Host、普通工具
和旧 Plugin 分支不采用本 eligibility。用户可用能力与权限边界不变；内部相邻 JOIN
次数的下降是本次明确行为差异，不能要求原重复 SQL 次数仍相同而另造假 observer。
真正 FULL/Source/保护回调次数仍按原精确断言保持。

## 必要回归与验收路径

本窗目前不写 tests。实施后只在已有真实 Manager/Saver/authority/CP fixture 中补有限的
相关回归，不为所有反射 API 新开专题，也不加入公开诊断 reader。

- `src/main/mods/v2/conversation-shared-data-scope.test.ts`：原 Source 次数、pure Scope
  不调用 Source、两次独立 DATA各执行一次真实 JOIN继续保持；针对本次 runtime/policy
  完整检查，原 prepareReadOne reader须同 receiver/args 委托实际 SQL，观察仅预定相邻
  JOIN 下降，完整 metadata/mapping 外 writer、same-ms token、lease/owner/authority拒绝。
- `src/main/mods/native-policy-tail-shared.integration.test.ts`：真实 Shared runtime 与
  policy admission仍走原链；一项替换 Object reflection 后委托原 callee并同步改真实
  mapping、再恢复函数的反例必须走 fallback 并拒。另一项由真正 protects 回调委托原
  方法后修改 DB 或释放 owner，末 fresh B 必须拒，不允许省保护次数或预先 fake policy。
  若 policy 叶实施，再用一个 inherited toJSON 的实际可调用反例验证 fallback，而非
  删除此风险或给普通/custom policy 数据授资格。所有临时函数/原型修改在 finally恢复。
- `src/main/mods/native-conversation-policy-source.test.ts` 与
  `src/main/mods/runtime-instance.test.ts`：原普通/Main/generic、撤权、epoch、parent abort、
  reader 地址与实际 authority 生命周期回归保留，不扩大本窗生产范围。
- `src/main/agent/native-shared-derived-config.integration.test.ts`、
  `src/main/agent/native-shared-stream.integration.test.ts`、
  `src/main/mods/v2/conversation-shared-restore.test.ts`：原真正 Shared invoke/stream/events、
  tool 完整消息与 CP/member/23、history、并发/retirement、early return/abort 与 drain保。

Root 独占 CPU。先两设计审，再生产与有限测试源码两审，Root 跑窄功能/权限套件与原
五秒失败门。五秒仍失败就保失败与真实耗时，再根据实际 caller 聚合决定下一窗；不改
预算、不删消息、不以诊断30秒功能通过冒称优化验收。

当前请求的只有两条条件去重链及其动态反射 fallback 设计票。没有实施或性能通过声明。
