# Shared Manager 邻接 Producer 数据复核的窄分工

本稿只读设计，尚未获得本窗口的两方 DESIGN 票，不授权生产修改，也不声称默认 5 秒性能通过。Parent 第三窗口的五个生产文件及 26 定义仍冻结，两个独立源码票已齐；首实际 25 PASS / 1 RED 的关闭状态测试只作精确期望修正，Root 后续已确认 Parent 实际 green，首失败记录保留。

## 实际重复位置

`src/main/mods/manager.ts` 的 `captureFunctionSharedNativeConversationRuntime()` 从原 `readFunctionConversationSharedProducer(captured.proof, authority)` 取得实际 Producer 私表发布的 frozen view。其当前自产 runtime guard 为：

```text
assertCaptured()               // Manager 原 private maps / descriptors / authority，纯数据
actual.assertCurrent()         // Producer FULL，原所有来源门和末完整 fresh DATA
assertCaptured()               // 同一个 Manager 自产纯数据函数
actual.assertDataCurrent()     // 再完整 fresh DATA
```

`src/main/mods/v2/conversation-shared-restore.ts` 的 Producer FULL 每次仍是：

```text
Active FULL
same source data 或 generic 原 NativeRead FULL
Registration FULL（Family / Owner / Target / Destination 四项保留）
standalone Destination FULL
Producer assertDataCurrent()   // 完整末数据，qualified 一 fresh JOIN；miss 原完整链
reading/failed finally
```

因此 Manager 的最后一项重复的是刚由同一个 actual view FULL 最后执行过的 Producer 数据核验。中间仅有 Manager 自产 `assertCaptured()`：固定原字段描述符、固定 private collection intrinsic、真正同 registry 的 authority 数据读取，无 Source / SQL / stat / protect / callback / await。该函数没有 caller inspector、业务写入或返回的执行对象。它若发现换代、getter、关闭或 foreign authority 会直接拒绝，不会返回成功后执行其他回调。

## 最小候选改动

审稿发现必须收窄：Producer 的 `dataChecker` miss 分支仍调用 Coordinator 的动态 Family / Registry data 方法，不能把这条旧路径宣称没有可观察 callback。因此只实际 qualified dataChecker 的 Producer 准入此次去重；miss 保 Manager 原四步，末第二 DATA 的次数和原动态方法行为不减。

实施增加一个真正 Producer 私工厂发布事实的只读 reader，而不是 public coverage boolean。精确接口为：

```ts
export interface FunctionConversationSharedProducerCurrentExecution {
  readonly current: () => void
  readonly data: () => void
}
export function readFunctionConversationSharedProducerCurrentExecution(
  proof: FunctionConversationSharedProducer,
  authority: ModRuntimeAuthority,
  view: FunctionConversationSharedProducerView
): FunctionConversationSharedProducerCurrentExecution | undefined
```

Producer 原 `completeFunctionConversationSharedActive` 成功取得真正 registration / mapping / `dataChecker` 之后，在发布 `producerRecords` 的同一个私 factory 点保存 own `execution`。所有原 private record 初态始终 own `execution: undefined`，仅 `dataChecker` 真存在且其原 frozen `assertInDestinationScope` 为 own data 函数时，保存自产 frozen execution 事实。记录固定同 proof、authority、原 view、原 FULL / DATA 两个箭头地址、原 dataChecker 及其原函数；caller 不提供 checker、函数、flag 或 inspector，没有注册接口。reader 先 Proxy/type 前门，再模块捕获 WeakMap.get 核 exact 三个原地址和该真实发布记录；clone、foreign、wrapper 或未 qualified 的记录返回 undefined。只检查原字段/函数地址和本厂 lexical reading/failed 状态，不调用 Source、FULL、SQL、Scope reader 或 caller callback。若已 genuine qualified 的 reading/failed 状态无效，抛原 sticky 失败，不装 miss 复活旧路线。

Manager 只在原实际 proof / authority / view capture 后固定这个 reader 的结果。qualified 执行 `assertCaptured(); execution.current(); assertCaptured()`；miss 仍执行 `assertCaptured(); actual.assertCurrent(); assertCaptured(); actual.assertDataCurrent()`。两项函数地址由同 Producer 真实 factory 生成而非调用者声明，reader 也不凭先前 FULL 成功授资格。原 Producer FULL、DATA 和其末检查正文完全不改；固定这个 code-execution 事实不是存 SQL 或成功权限。每次 current 仍执行真实原 FULL，known 的异常不可切回 generic。实际 view 的 coordinator、binding、scope、physical binding、database / invocation / owner / target / signal join 全部保留。

这删除 Manager 在同一个同步 guard 内追加的 **一次 Producer DATA**，其对应 qualified 情况的 **一次 fresh complete JOIN**。Producer FULL 本身和其最后完整 DATA 原样真实执行，每个独立 runtime guard 都重新执行，不借上一 guard、callback 前的 SQL、跨 await 或成功缓存。FULL 结束后的 Producer `finally` 只退本次 reading，Manager 的后核只读真实原 maps / fields / cancellation 事实，原关闭与换代仍由此后核拒绝。若某后继改动在两项之间加入任何 Source、SQL、业务回调或 await，本分工不再成立，必须恢复最后 DATA 或重新评审该精确 seam。

原 policy guard `assertCurrent → assertTail → protects → assertTail` 不改。原 PolicySource tail 的 `Manager-only assertPolicyData → actualProducer.DATA` 不改；此前 A 词法分解只修 policy tail 的重复，本稿修的是 runtime FULL 后的另一次邻接 DATA。每个 Model 两次 FULL / raw、Keeper M/A/T/D、Registration 四个 FULL、Family 独立 parent、standalone Destination H、Store 原完整 SQL、23/ledger/CP、provider/tool/Hook、drain 均不删。不从此案推断 target FULL 已覆盖 standalone H。

本案只触真正 Manager 自造 Shared runtime 私闭包，以及 Restore 原 Producer 发布事实与紧邻其实际 reader 的 additive 区域。Main runtime、caller/generic runtime、没有 genuine captured Producer 的入口和 Producer dataChecker miss 的旧四步都保持原行为。不会借函数名字、地址相似或前次 FULL 成功让外部 current 声明 DATA 覆盖。PolicySource、Scope、Family、Registration、Destination 不改；Restore 历史证据、historical target、NativeRead / Active FULL 和其他 guard 区域不并写。

## 精确可审事实与回归

需要独立 reviewer 再核当前 `assertCaptured` 的完整实际 callee：原 `nativePolicyManagers` 记录的 frozen methods、`captureNativePolicyFields` 已批准 index/descriptor 尾、固定 Map/WeakMap、`isModRuntimeAuthorityDataCurrentForRegistry` 已批准 lineage index/data/signal intrinsic。任何实际晚 callback leaf 都是实施先决，不能以“纯”命名代替检查。

测试优先复用 `src/main/mods/v2/conversation-shared-data-scope.test.ts` 的真 Manager / authority / desktop lease / parent task / Saver / NativeRead / Coordinator registration / Producer fixture；不造 Host callback 或 fake Producer。若需新独占测试文件，先由 Root 分配，避免复制整套大 fixture。

1. 同实际 authority 和 Producer，比两个独立 Producer FULL 与两个 Manager runtime FULL 的 Source G/P 次数及完整 fresh JOIN 类别：改后每次 Manager FULL 与 Producer FULL 相同，原末 JOIN 每次存在，无多出的 Manager JOIN。观测 wrapper 委托实际 get 一次，只计固定类别，不打印正文、SQL 参数、身份或密钥。
2. 保原 policy FULL / protects 的次数和 tail 的每次一个 fresh JOIN；main/generic 路径计数不减。
3. 两次独立 runtime FULL 之间真实改 mapping / parent thread incarnation / destination metadata，第二次仍拒绝；第一次成功不构成资格或数据缓存。
4. 原最后 full Source 修改 Manager maps / policy epoch / 原 field descriptor 或释放 authority / close / lease，必须在本次 FULL 或其 Manager 后核拒绝，原 getter 0。恢复字段或 caught error不能复活 Producer 原 sticky 失败。
5. first full Source caught 同 Producer 再入仍 sticky，provider / model / writer 不放行，实际 Store / CP 原断言保留。
6. qualified 和原 fallback Producer 两条 full 均要读实际字段和完整 SQL；不能把 fallback 变成只有 data 或无最后数据库复核。
7. 真 proof / authority / view reader 的 clone、foreign、wrapper、Proxy 0 trap 与 dataChecker miss 明确返回 undefined；实际已 qualified 的失败 / caught 再入不得用下一次 reader 返回 undefined 降级。reader 原 FULL / Source / SQL 计数为 0，实际 runtime 每次仍执行原 current，原有模型 / Tool / CP / Store 断言保留。

Root 单独运行类型、真实 Worker build、旧窄门和 unchanged native/resident/HTTP 默认 5 秒性能。此候选不减少 physical G/P 次数，预计影响主要为 fresh SQL 类别；physical checks 仍高，不能预报预算已达标，也不能把本案微收益当整个性能任务完成。

## 未闭合的 SQL 执行来源先决（当前整体 BLOCK）

Root 独立读发现 Destination snapshot 的 read 在首 factory 通过动态 `db.prepareReadOne(sql)` 获得。Destination 私记录保存这个地址，不证明该地址来自真正 Native Adapter；Source 可以提前换成 wrapper，每个 DATA 内仍执行外部 JS。仅 `dataChecker` 非空不充分，本稿上述 Producer reader 尚不具有整体 DESIGN2，也不能实施 Manager DATA 删除。

下一 SQL 小窗的候选须由真实 `openNativeSqliteDatabase` adapter/native pair 的原 `NativeSqliteCurrentExecution` 生成固定完整 JOIN reader，并由 Destination 自产点记录具体 SQL/read/native-get 原执行事实。当前 Adapter、native prepare、Statement get 的原 data 函数/receiver 来源和完整三个 closed/open 检查须真实固定。初 factory 的 wrapper/getter/foreign/custom 来源继续旧 read 和双 DATA，可观察的外部回调次数不改变；不能观察原 read 成功后回填 coverage bool，也不能允许 caller 登记 SQL reader。精确 Adapter / Destination reader API 与构造顺序仍待两方评审，没有生产授权。

固定 `Statement.get` 还不能单独证明 SQL 本身没有 JS callee。当前 JOIN 的 alias 检查是 `SELECT count(*) FROM pragma_table_info(...) WHERE name GLOB ...`；本仓 `node:sqlite` 类型声明允许注册 `native.function()`，真实 Saver 回归也已使用该能力。SQLite [原函数文档](https://sqlite.org/lang_corefunc.html) 明确说明覆盖 `glob()` 会改变 GLOB operator 的执行函数。因此同实际 native 资源可以在来源回调中注册 JS glob，让 DATA 的原 JOIN 再执行 JS。此实际 callee 不会被 adapter/native 品牌或原 get 地址封闭。

需要 Root 的实际 native counter / mutation 反例验证，并对等价的 schema collision 读取算法另作两审。候选只可保持全部 m.*、原线程/ref 完整事实、同一 fresh JOIN 与 alias 冲突拒绝规则；不得通过假定 builtin 未替换、跳过 schema 检查或存旧行证明纯性。SQL 及 reader 两个依赖未闭合之前，本稿仅保留 Manager 邻接关系的条件结构结论，整体优化维持 BLOCK，不把它称为框架限制或性能完成。

交 Root 的最小 Node 22 内存 counter / UPDATE 脚本、BINARY 前缀半开范围 + EXISTS 候选、原 name TEXT 域、0/1 collision 拒绝同义、TEMP 表值解析与异常 name 类型待验门，已单独写入 `output/stage23-native-destination-glob-probe-plan.md`。Legacy 未执行此脚本；该候选不是 SQL 生产票，也不证明整个 SQL 执行已经无未知 callee。
