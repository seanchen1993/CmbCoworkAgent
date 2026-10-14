# Native shared parent current 的实际 Owner 重复展开

状态：本窗口已按 Root DES1/Latest DES2 落盘五个生产路径和新 focused test，待独立源码票与 Root 实际门。Family 第二窗口原 5 个生产路径与 21 定义的 Root/Latest 源票、Node53 和实际 101/101（21+66+Restore14）属于前一窗口，不代表本窗口通过；本代理不运行 CPU，不提高原 5 秒超时。

Root 无采样性能复跑仍未通过：native true 7250ms，resident 37661ms，physical G 由第一窗口 361824 降至 228784。证据为 `output/stage23-native-shared-second-window-performance.log`。功能通过不等于性能通过。本窗口只减少 Shared `captureChildParent` 的复合检查，不声称改善 Main original fullHook 的 5 秒门；Main 需要其自己的实际来源关系和单独方案。

## 实际路径和拟减少的次数

`src/main/mods/v2/conversation-coordinator.ts` 的 `captureChildParent` 自造 parent.current：

```
assertOwner(owner)
target.assertCurrent()
```

该 Coordinator 在 `prepare` 或 `captureChildParent` 创建其 resident main target 时，传给 Registry 的 backend.current 又是同 owner 的 `assertOwner(owner)`。因此该已知 parent 的一次独立完整 current 内部运行 Owner.full 两次。每个 Family.full 仍独立运行 parent.current；一个 Producer.full 中三个 Family 门对此贡献 Owner.full 六次。

拟只把这个自造 parent.current 内部改为真实 target FULL 一次，再 fresh Owner 数据事实。target FULL 内仍真正运行原 Owner.full 一次、原 Store 检查和 Registry 当前事实。三个 Family 独立 parent FULL 保留，只是它们各自内部 Owner 2→1，共六次变三次。Registration 独立的 Owner.full、Keeper M/A/T/D、Model 两个 full/raw、Family S/H、G/P、destination standalone H 均不删。

Owner.full 内 `context.assertCurrent` 和 `host.assertScope` 的实际次数会随 Owner 2→1 减少。这是明确的内部复合检查调整，不能声称所有回调次数不变。每个独立完整 parent 仍执行这两个原函数一次。未知 parent/target/backend、wrapped/clone/foreign 或缺执行关系保持原两次。

## 准入必须同时有的两个代码执行证据

第一份由 Coordinator 自己创建特定的 Owner guard，并在 module-private WeakMap 保存 guard→原 Coordinator/Owner/context/private fields/source pointers。它必须通过 class evaluation 时捕获的原 `assertOwner` 函数、固定 Reflect.apply 和原 receiver 执行原完整检查，不能晚读实例/原型的 assertOwner 或 fn.bind，也不能让外部 callback 注册 coverage。该 builder 不给 Owner、authority、append 或消息的新权限。

第二份是 Registry 实际 insert 的执行关系：实际 target/entry/resident/backend 中的 assertCurrent 确实使用 module-captured Function.bind 绑定了上述原 guard 与那个原 backend receiver。不能只记原 descriptor 后实际仍读 fn.bind；晚 getter/replacement 可能产生 fake bound。Registry 的只读 execution reader 只返回该实际关系和当前 entry/resident/closed/signal/map 数据尾，不证明 arbitrary runtime，也不单独授优化。

此执行证据必须封闭实际 callee。现公开 target 的箭头仍动态调用 `this.assertEntry`，后者动态调用 `this.assertResident` / `this.assertBackend`；仅记 backend bound 地址不能证明晚替换这些方法时仍真实执行 Owner.full。Root 已接受本窗口专用 FULL 固定 class-evaluation 时原 Entry/Resident/Backend dispatch 与原 receiver，generic public target 保持旧路径。专用 FULL 只供该双私表 join，不把函数地址作为外部覆盖声明。

Store 同样是实施前先决：原 Backend 内动态 `this.store.assertCurrent`，Store.current 又动态 `this.assertThread`，SQL 私有 reader 还有 `database.prepareReadOne`。Owner callback 可换成 fake 并恢复；末函数地址相同不足以证明实际 FULL。必须以真正 Store constructor 来源、原 receiver/DB 和固定完整 Current/Thread 实现封闭原两 SELECT，每次 fresh SQL，不能复制简化 SQL、用 data 检查替代 FULL，也不能仅靠 instanceof 升级 clone/custom Store/DB。实际布局正在独立评审；未闭合前不实施第三优化。

Coordinator 只有在两份私表精确 join 后，才能构造特定 parent.current。还须同 actual owner/owner.target、target.ref、resident owner、checkpointThreadId、原 DB/incarnation、Store、context/workspace/physical thread 和当前 Owner maps；不从公开字段、stamp、namespace 或函数名推断。

本窗口先限于 Coordinator 自己创建的 main backend，原 backend.authority 为 undefined，Owner 非 independent child、非 unbound internal child。其原 Registry FULL 在 Owner guard 之后只执行实际 Store 数据检查和 Registry 数据，没有独立 authority provider callback。若既有 target 来自其他 main/native backend、带 authority 或额外未知 callback，保持旧 parent Owner→target 两项，不在本窗假设它覆盖。

## qualified 每次调用的顺序

1. 在第一个 callback 前占模块私有 parent operation 的 reading/failed latch。纯核上述 fixed private refs、own data/prototype/flags、Owner live、original maps、signal、target execution 关系。
2. 原实际 target FULL 一次；其已认证 original backend binding 执行完整 Owner.full 一次，含原 context/source 和 host.scope callback、callback 后 fresh thread/incarnation，以及原 Store 检查。
3. 回调全部返回后，fresh 读取同实际 DB 的 parent thread，完整核 Owner incarnation；重核 lease/authority/closed 与固定原 context/controller signal，私有 owner/current/target/source map、execution binding、原 Owner/context 字段与 child/unbound flags。所有纯依赖用原 intrinsic/descriptor 读取，不晚读 this.field、集合方法或用户 inspector。
4. 最后再核私表/CAS/latch，无 callback 后才返回。任何已 qualified 错误或 caught reentry 永久 failed，不降级旧路径；下一独立调用仍 fresh target FULL/SQL，不保存成功或 SQL 行。

原 Owner 的真实 physical/source 完整 guard 不被 data tail 替代；它在实际 target 内执行。纯 tail 只是补足 target 内原 Owner.full 之后没有未知 callback 的末事实。若最后 phase 存在新的 callback，必须保原 Owner FULL，不能把这个 data checker当覆盖证明。

## 精确候选窗口及测试

- Coordinator：原 Owner guard 的自产 builder/私表、真正主 target 创建两处使用该原函数；captureChildParent 只 exact self-built target 命中时使用特定 compound。独立 assertOwner 与一般 API 不改。
- Registry：实际 insert 的 own-data safe fn/receiver +原 intrinsic binder关系和只读原 target execution reader；generic binder/unknown backend原行为保留。不接受注册者的 coverage bool 或原函数声明。
- 新真实 focused test：复用当前 Manager/AppDB/lease/Scope/Saver/Family fixture，钉 qualified parent 的 Owner/source 2→1、Family/Registration 原独立门次数不变；未知/带 authority target/wrapper/foreign旧两次；两 bind getter/replacement 0；first callback caught reentry sticky；最后原 Owner source 改 thread、lease、parent authority、Owner maps、Scope/target closed、DB或 directory 均拒 before model/writer/ACK；两个独立调用之间的真实变更不能缓存。
- Root 另运行原默认 5 秒 native/resident/HTTP/完整 Hook/tool/provider/CP/UI/取消和 drain 门。源码票不承诺预算通过。

## 再后面的具体阻碍

Registration 的 destination.current 仍为 target FULL→standalone destination H。不能仅因为 target 的 Family 里执行过 S(H) 就删后一个 H：Family 的 S/H 之后，target backend 还执行独立 Owner.full；该 Owner 的 context/assertScope 回调可能改变 H 的原 G、P、lease、binding或物理事实。此时最后 destination H 正是在这些未知回调后重新完整核来源。没有“这个 Owner.full 确执行 H 同原 G/P 并核全部来源”的实际自产代码关系，data tail 不足以删 H。本稿保留它。

较窄但收益有限的候选仍是 Manager.shared current 内 actualProducer.full→固定纯 assertCaptured→邻接 actualProducer.data 的第二 fresh JOIN。只有全部中间叶子实际 callback-free 时才能词法删这个重复 SQL，Producer.full、所有完整回调和末事实保持；它不能解决整个来源递归爆炸，也不当本稿已经授权。

## 固定实际执行依赖的精确四源补充（两审已通过）

原三源设想需要补 Adapter Origin，四个生产路径为 Coordinator、Registry、`src/main/db/function-conversation-store.ts`、`src/main/db/native-sqlite-adapter.ts`；之后第五源仅补 Family 的实际 binder。以下接口已落盘，源码与实际门仍独立验收。

### Adapter 的 constructor 来源与原 read-one 执行

`readFunctionConversationNativeSqliteCurrentExecution(database: unknown)` 拟返回 opaque 的只读 execution view 或 undefined。constructor 私表只收由本实际 constructor 生成的 adapter，固定 adapter prototype、`native` own data descriptor/原 DatabaseSync、`closed` 原 boolean flags；不接受外部注册，不靠 instanceof 或复制 field 造资格。

2026-10-06 Root 对实际 Node v22.23.2 的只读反射确认：isOpen/isTransaction 是 native 实例的 own getter（enumerable=true/configurable=false），prototype 没有此 descriptor；prepare/close 是 prototype own data 函数。不能从较新声明假设 prototype getter，模块 getter缺失必须安全资格 miss，不能导入崩溃。首次 WIP 错误和 `output/stage23-unused-test-parameters-regression-current.log` 保留，不当四个业务测试失败或最终通过。

本精度增量采用 actual `openNativeSqliteDatabase` 的私创建点：真正 `new DatabaseSync` 返回后、同原原生设置 SQL 之前，module private WeakMap记录该实际 native pointer、原 prototype、它的原 isOpen own getter函数/flags。无需在模块初始化额外开库，不接受 caller native/getter 注册；普通 NativeSqliteAdapter constructor 不安装 Origin。同原三次 PRAGMA→实际 new adapter→私 install(adapter,native)→return 顺序，仅该实际 factory adapter/native pair 建立资格；直接/custom constructor甚至借同一真实 native pointer的第二 adapter alias也 miss，不污染原 factory记录。getter的可信性来自这个实际创建代码事实，之后用其固定原函数+同 native receiver读实际 open/native brand，绝不调用 caller own getter。Native字段、原 getter descriptor和closed flags在每次前后核验；getter缺失/类型不符则不建资格，不能用常量替代。

view 的只读资格不创建 statement、不读取业务 SQL、不授 authority。专用 `prepareReadOne(sql)` 在真正 Store FULL 需要这个 SQL 的原时机才准备 statement；它使用 module-captured 原 DatabaseSync.prepare 与固定原 native receiver，Statement 是该实际原 prepare 的返回对象，get 使用 module-captured 原 StatementSync.get 与原 Statement receiver。不存在 caller statement/prepare/get 的注册口；原 native/database 替换、own getter 或 closed 状态在原检查点均 descriptor/intrinsic 核验。原 statement/fresh get 的地址关系与成功资格不跨 callback缓存。

原 `NativeSqliteAdapter.prepareReadOne` 的 normalization、完整 row copy 与三个 open 检查正文提取为同一 module lexical 实现；公开方法仍使用其原创建/绑定语义。只有 opaque execution view 选择上述固定 prepare/get dispatch。每次 get 仍原 statement.get 一次、原 normalization 和 row copy、原三个 closed/open 检查，不存 SQL 行。generic exec/cursor/close 与未知 database 路径不变。

### Store 的同一完整 SQL 正文

`readFunctionConversationStoreCurrentExecution(store: unknown, expectedDatabase: NativeSqliteAdapter)` 拟返回 `{ assertCurrent(ref): void, assertDataCurrent(): void }` 或 undefined；需要 Store constructor 私表 + exact expectedDatabase，并由 Coordinator/Registry核 expectedDatabase===当前 getDb()。Origin 只证明原实际对象，不能单独成为 conversation/session 权限。

原 `assertThread` 和 `assertCurrent` 的完整正文提取为 lexical Thread/Current 实现，SQL 常量仍唯一原 `CURRENT_THREAD_QUERY` / `CURRENT_TARGET_QUERY`，所有字段比较、原 incarnationKey、错误码及顺序保持。公开 `assertCurrent` 仍通过原 dynamic this.assertThread；专用 FULL 通过固定 Thread lexical 正文、固定原 Store receiver/database 和上述 genuine Adapter execution。这共享同一原 SQL 正文，不复制更小查询、不用 data 检查代 FULL。真实 Thread SELECT 和 Target SELECT 每次各 fresh get 一次。

readCurrent 的原私 statement cache 继续只存 statement/read closure，不存行；专用路径在同真实 DB + 原固定 SQL 下保存其 module-owned execution read closure。首次准备仍在实际 FULL 需要查询的位置，不从 constructor、资格读取或 target publish 提早准备；nested 同 SQL 仍临时 statement，busy 退役和错误 cache 清理保持。新用到的私 WeakMap/Map/Set 操作使用 module-captured intrinsic，不晚读可替换集合方法。

Store 的 `database` own descriptor/prototype/原对象、Adapter Origin、原 closed 状态和原 cache execution 关系在 FULL 前后均核。已返回资格的 later replacement/accessor/DB-close/fresh SQL失败是 sticky reject，不装成 miss 回退。custom Store/DB或 clone 缺真 ctor/Adapter 来源且 expectedDatabase 不是实际 AppDB 时仍 undefined，Coordinator保持旧 Owner→target 两项。

### Registry 固定 Entry/Resident/Backend FULL

Registry safe backend 前门复制原六个 own data 字段（authority 可缺），固定原 Function.bind 对 originalOwnerGuard + originalBackend receiver；不得任意 `{...backend}` 执行 accessor。generic backend 保旧 insert/binder/target公开调用行为且无 proof。

实际 `readFunctionConversationNativeParentTargetExecution(registry, target, originalOwnerGuard)` 只读 actual inserted entry 与自产 Owner 两个私表，原Backend receiver、expectedStore、expectedDatabase 从这些真实私记录取得，不让调用者提供。必须 no authority、main、原 Resident/Entry/target/backend/Owner guard/ref/Store/DB全部同一真实对象。view 的 FULL 用 module lexical 原完整 Entry/Resident/Backend dispatch，Backend在原 guard位置真正调用已执行绑定的 originalOwnerGuard，一次；Store位置调用 genuine Store FULL，两 SELECT完整保留。原 map/active/closed/ref/checkpoint scope/signals与 Store 原检查位置保持。公开 generic target 仍原 dynamic this.assertEntry 不变。

如果 Entry/Backend 完整正文抽取为 shared lexical 实现，generic方法传其原 dynamic callee，专用函数只传私有固定原实现；caller不能提供这些 callee。Entry 资格和 operation latch在任何 Owner callback前固定。每个回调后的原全部事实和 fresh SQL保留，最后 pure tail不得读取后来私方法、Store方法、集合方法或 caller accessor。

### Coordinator parent compound 与回归

Coordinator只认自产 originalOwnerGuard 与该 actual Registry proof。qualified parent占 operation latch→pure join→Registry专用 FULL（Owner一次＋Store完整两 SELECT）→fresh Owner parent thread/inc/lease/signals/maps/refs→Registry/Store/Adapter全pure尾→latch末核。未知或 constructor资格 miss保持旧两项；任何 qualified失败 sticky，不重新走 generic。

新增真实 fixture须包括：原 Owner.full 2→1与独立 Family/Reg4次数；unknown Store/clone/custom DB及直接constructor输入native（非原open工厂）不资格；Owner原 callback暂改Registry私方法/Store current/thread方法而恢复，专用固定完整执行仍真 Source/SQL而不fake；晚 own/proto fn.bind、assertCurrent/assertThread/prepare/get getter或replacement0；native/database/closed字段 getter0；Node22实际own isOpen函数与工厂原pointer关系、缺getter安全miss；真实 parent/thread/conversation/branch变更、DB关闭、lease退役、caught first callback再入与下一独立调用fresh拒；generic公开旧路径仍执行其原自定义方法。真实 Worker build和原 default5 main/shared/HTTP/CP/Hook/perf独立由Root运行。本窗口不预称解决 Main fullHook 或 Shared预算。

## Owner 原始执行关系的精确增量（两审已通过）

`assertOwner` 的原函数地址仍不单独证明原 G/P 执行：函数内动态 `this.key`、`this.current.get`、`this.host.assertScope`；context 的原 callback可以临时替换后面的方法并恢复。四个文件的已批准范围不自动批准这项新增语义。

拟增量只为 Coordinator 自产 guard，内部 `captureOwnerCurrentExecution(owner)` 不导出注册入口，外部不能提供 callee/inspector。其 first capture 在原 main backend guard创建处、任何 Registry insert/source callback之前；需要 original Coordinator/Owner ctor私表、no child/unbound、原 Store/actualDB，以及 Coordinator 的 host own-data原receiver。固定原 host.assertScope own-data function+receiver、原 captured context.assertCurrent function+context receiver，原 context/workspace/thread/inc/controller/signals、原 key字符串和原 owners/current collections。不能从 caller覆盖声明或名字取得资格。

Owner 完整正文提取为 module lexical实现：generic `assertOwner` 仍传原 dynamic key/集合/host/source路径，保持原 G/P 当前可观察性。qualified guard只传该私工厂固定的原 G/P/receiver、key和原集合intrinsics，按原顺序 live/current→signals→G.full→P.full→fresh原thread/inc；二者共享原完整正文，不复制更小 Owner检查。其每次第一 callback前 reading/failed，callback之后完整原 own flags/refs/maps/lease/authority/信号/DB及fresh thread核验，末pure CAS/latch，无callback后返回。临时 fake method/getter不能被qualified当成原 G/P执行；generic未qualified继续原动态行为。

该 guard的私WeakMap记录才可与 Registry actual executed original boundFn/原Backend receiver join；guard输出不提供Owner/Session/append新权限。初次 qualification miss保持原 Owner→publictarget两项；任何已qualified后失配、撤权或caught重入sticky失败，不能装miss复活generic。

拟真实回归增加：qualified原G/P同原receiver各1次、generic原动态方法照旧；原G callback临时换host.scope为fake并恢复时仍执行固定原P；固定key/Map与Scope/source descriptor后变更拒，getter0；首G caught nested同parentfull粘性拒；最后P改变thread/inc/lease/maps/rawcontext/信号或临时改private方法后完整fresh尾拒。独立Reg4/Familyparent/MATD/Model2/standaloneH保持，Main性能不作承诺。

## Family 最后绑定的执行精度（第五源单 hunk）

`captureParent` 仍通过 `input.assertCurrent.bind(input)` 生成真正储存的 Parent 函数。仅证明 Coordinator 自产原函数不足以证明这个最终函数确实执行它，先前 Source 可以更改原函数的 own bind 或 Function.prototype.bind。第五个生产路径只增 `conversation-child-family.ts` 的该绑定选择，不修改 Family full、共享第二窗口、Parent 的 assertFactory 或 unknown 路径。

Coordinator 新增 module-private `parentCurrentExecutions`，只由 `captureChildParent` 已成功双 join 的特定 compound 创建记录，固定 current/OwnerExecution/RegistryTargetExecution/actual target/Owner target descriptor、原 context、DB、完整 ref 及 operation reading/failed。没有接受 caller callback 或 coverage 声明的登记 API。`readFunctionConversationNativeParentCurrent(input: unknown)` 先 Proxy/own-data 前门取原 input.assertCurrent，再 exact 查这份私表；必须 input 为同一个实际 Coordinator 构造的 input 地址，且其 owner/target/physicalParentThreadId/signal/assertCurrent 全部 own-data 值和 flags 与记录固定 tuple 相等。返回 frozen `{ current: () => void, assertDataCurrent(): void }` 或 undefined；不调用 Source、SQL、业务、factory 或其他 full callback。unknown/Proxy/wrapper/clone/foreign tuple 返回 undefined，实际 input 已命中但失活必须 sticky throw。同函数地址不能给 foreign tuple 选择 known binder。

Family 构造 Parent 时，仅这个 reader 命中的 frozen view.current 使用模块加载时捕获的原 Function.prototype.bind，经 Reflect.apply 绑定同一 current 和同一 input；不在 reader 返回后重读 input.assertCurrent。generic current 继续原 `.bind(input)`；assertFactory 继续原行为。这不授 Parent、runtime、message 或 append 权限，只保证实际储存的 known current 确执行已认证原函数。qualified operation 的首 latch仍在第一个实际 Owner callback之前；Family 的原 factory/current/signals检查及真正 proof 发布顺序保持。

本批暂定新增真实回归路径为 `src/main/mods/v2/conversation-native-parent-current.test.ts`。四源 WIP的旧路线投影回归不计为此第五源或 Parent 优化验收；完整冻结后仍由 Root 运行类型、真实 Worker build 和原 5 秒门。

末 lease 精确叶亦已 Root/Latest 两审：自产 Owner guard 首 capture 在任何 G/P 之前调用既有 `captureLocalThreadRunLease(original.context.threadId)`，只保存该原模块自产的 fresh exact-pointer reader。无真实 lease 为初资格 miss，仍旧两项。每个 qualified 前后数据尾都调用同原闭包；真实 release/reacquire 或 handoff 不因 runId/字段相同复活，不能 caller 注册一个 lease callback。原 G/P、完整 SQL 和独立 full 门次数不变。

新 focused test 当前 26 个定义，包含真 Manager/authority/binding/lease、原 AppDB/Store/Registry/Parent proof；新 Adapter Origin 检查使用实际 `openNativeSqliteDatabase`、同 native 的另一个 adapter alias 及 direct native constructor 对照。覆盖 Owner 1/unknown 2、原 receiver、foreign tuple/Proxy、own bind、fixed Registry/Store/native prepare、last P incarnation/lease、Owner和Entry getter0、caught first G reentry、data tail Source0与真实 close。尚未由本代理或 Root 运行，不据定义数量声称通过。

## 私有记录初态与真实首次选择（两审已通过）

私有 WeakMap 中的普通 record 同样可能继承 `Object.prototype` 字段。Store 构造 record 始终 own `execution: undefined`，之后仅由原真实 Store/Adapter join 完成时赋真实 frozen execution。不能省略字段后用 `record.execution` 选到继承的 getter 或假 execution，跳过原 Thread/Target 两个 fresh SELECT。

Coordinator 的原 host.assertScope 必须是 own data 原函数；资格 miss 的 ctor record 也始终 own `scope: undefined` / `scopeFields: undefined`。只有原 descriptor 合格的分支覆盖这两个 own 值。unknown host 的继承 assertScope 仍由 generic 原完整路径执行，不把原型上的私字段升级为资格。

三项新增真实回归分别在实际 `captureChildParent` 首 G 返回、private Store reader 首次选择之前安装继承 execution getter/fake；以及由真实 host inherited assertScope 构造不合格来源，给原型的 scope/scopeFields 安装 getter。getter/fake 全部要求 0 次，qualified 原 G/P 各一次、generic 各两次，实际 checkpoint namespace SQL 改变后原完整 current 必须拒绝。setup 失败仍观察全部原资源 cleanup；全局原型描述符在 teardown 前恢复。此修补不改变 full 次数、SQL、回调 receiver 或未知旧路径，旧 23 定义源码票不能代替这份 26 定义快照的独立审核。

Root 首实际 26 门为 25 PASS / 1 RED（`output/stage23-native-parent-current-first.log`）。唯一失败为测试错误期待首次关闭失败之后的私 reader 仍报关闭：首次 `assertDataCurrent()` 报 `Database is closed` 并永久标记 failed，之后 reader 和同 execution 的独立 data 调用应严格报 `[NativeSqlite] Read-one adapter changed`。两审已批准只收口这两项精确期望，生产不变；该修后快照仍待 Root 重跑，不把首 25 PASS 当全门完成。
