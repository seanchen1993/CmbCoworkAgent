# Shared native source 内部重复完整检查的精确方案

状态：第一窗口源码双审已通过，Root 实际 13 + Scope66 + Restore14 全过。原默认 5 秒性能仍红：native true 6688ms、resident 44850ms，physical guard 从 423676 降至 361824。这些真实失败保留，不能称达标。Family 第二窗口已按 Root DESIGN1 + Latest DESIGN2（含首 parent callback 前 outer latch）落盘并冻结，21 个真实夹具定义待独立源码审核和 Root 运行。本代理未运行 CPU。旧 A/B、Keeper、Model、SSE 的源码票不覆盖此稿。

## 实际证据与目标

Root 的真实 Worker 采样 `output/stage23-native-resident-worker-cpu-frames.json` 为 53.388 秒：SQLite native get 自耗 18.962 秒，Adapter read 自耗 11.029 秒、包含 31.040 秒，stat 自耗 7.307 秒，thread incarnation 解码自耗 2.542 秒。getThreadCore 包含 23.061 秒，NativeRun.assertFacts 包含 14.471 秒。真实物理 guard 计数为 423676。采样增加开销，不能用该时长当性能比较。

最新普通真实 native true 门为 6056ms、默认 5 秒超时；resident 旧真实门仍远高于 5 秒。此稿不调整超时、输入大小、消息数量、Hook、provider、工具执行、原 Keeper 检查或验收断言。

只提高复制速度无法保证达标。先针对实际模块自造完整 source 的重复展开；不建立全局有效性缓存，不让调用方注册“我的 callback 覆盖 runtime”的声明。

## 实际完整链与次数

以下均为当前实际源地址，不能从公开字段、namespace、ID、stamp 或配置相等推导关系：

- `src/main/mods/v2/conversation-shared-native-host.ts` 工厂自造 `guard`，记为 H。H 调用原 `input.assertCurrent`，记为 G；调用原 `input.parentBinding.assertCurrent`，记为 P；随后 fresh 读取实际物理线程 incarnation。G/P 可以执行宿主代码。
- `src/main/mods/v2/conversation-shared-checkpointer.ts` 原 Scope.guard，记为 S。S 核本 Scope 的 closed、原 signal/controller、原 authority，再调用同工厂 H。
- `src/main/mods/v2/conversation-shared-restore.ts` Active.guard 调用 H，随后原 NativeRead.assertCurrent，即 S，再核 fresh 物理线程 incarnation；Active.current 再核原 reservation。
- 同文件 Producer.full 先 Active.current，再次 NativeRead.assertCurrent S，随后原 registration.full、native destination.full，最后完整 data JOIN。
- `conversation-shared-native-host.ts` 传给 Family 的 input.current 是工厂自造 H + S；destination.current 是同工厂自造 H + fresh destination thread/metadata。
- `conversation-child-family.ts` Family.full 独立调用 parent.current、input.current、destination.current，后核原 authority、lease、checkpoint/destination incarnation 与完整原 metadata。
- `conversation-coordinator.ts` Registration.full 依次独立 Family.full、Owner.full、Target.full、Destination.full、末 data postflight。Target.backend 是自造 Family.full + Owner.full；其 Destination 又执行 Target.full + 原 destination.current。

仅计算 H，不把独立 Owner 或 parent.current 的额外 P 算入：

| 一个 Producer.full 内的展开 | 当前 H | 本稿 qualified 后 H |
| --- | ---: | ---: |
| Active.current + 紧接 NativeRead.current | 3 | 1 |
| registration 内 Family.full | 3 | 1 |
| registration 内 Target.backend 的 Family.full | 3 | 1 |
| registration 内 Destination 的 Target.backend Family.full + destination.current | 4 | 2 |
| 原 native destination.full 内 Active.current | 2 | 1 |
| 合计 | 15 | 6 |

该表是源码展开计数，不是采样分配，不包括注册、初始化、其他调用方或失败早退；实际测试必须分别钉这些地址的调用计数。Keeper M/A/T/D 仍按原次序独立执行，每个门重新执行自己的完整 Producer/source。Model 的两个 full/raw、Store、23 seal、ledger A/B、checkpoint、adoption、真实 drain 不变。

## 必须承认的行为变化

本稿将删掉同一个 genuine H 的嵌套重复调用，因此 H 内未知 G/P 的实际运行次数也会减少。不能把这叫做“原回调次数全部不变”，也不能用末 dataCurrent 代替 G/P。

只允许在真实工厂自造并私表认证的复合完整 guard 中执行原 G/P 一次。其原函数、原 receiver、原 physical guard 的 callback 前后完整事实检查、错误、同步要求全部保持。独立 parent.current 不省。未知 Scope、未知 current、unknown destination、外部包装、clone、Proxy、关系缺失全部保留旧调用链和旧次数。

若 guard 合同要求 genuine G/P 的重复次数本身属于可观察功能，本稿不能通过；阻碍就是原 `input.assertCurrent` 与 `input.parentBinding.assertCurrent` 的独立调用。下一步需要明确允许“每个完整复合检查执行该真实 source 一次”，不能以缓存、公开 coverage bool 或回调口头保证绕过。

## 私有实际关系与最小接口

实际第一窗口新增 core 模块 `src/main/mods/v2/conversation-shared-source-current.ts`。它自己构造固定完整 H，并只保存自己创建的 H 的执行事实私表；原 NativeHost 调用此构造器。它不接受现成 H、任意 inspector 或 callback coverage 注册。Scope 原模块自己构造固定 S 和私有 execution reader；Active 从真实 S 的 source H 地址与 core 私表精确 join。Restore 不 value-import Main NativeHost；core 仅使用 Restore 已有的 DB/Core/incarnation 依赖，不引入 Desktop/NativeHost/router。真实 Worker build 仍是必需运行门，尚未完成。

plan 不授 Message、append、Goal、intake、checkpoint 或新 authority。它只证明工厂自己生成的 H、input.current、destination.current 对哪个原 Scope/Active/read/source 进行检查。不得导出 accepting callback 的通用 register，也不得导出可由任意函数声称覆盖的 token factory。

固定 H 构造器在任何外部 callback 前占同一个原 input 的 construction latch；固定原输入 own data descriptors、实际 G/P 函数和 receiver、原 parentBinding、DB、authority、invocation、signal、checkpoint incarnation。原 H 执行时先核这些地址，执行原 G/P，再核 fixed facts；caught construction/read 重入使该 plan 永久失败。

Scope 构造保留 generic 路径。原 NativeRead mint 保存模块自产 S、原 source H 和实际绑定 receiver 的执行记录，连同真实 Scope/Saver/authority/read namespace 与原 signal/controller。core reader 还核原 H 的私表、DB/invocation、receiver own-data 中完整 Saver/authority/parentConfig/signal/parent namespace/H 引用；公开函数相等不能替代该私表。不存在 public bindScope 或外部注册 cap。Scope 的完整检查 S 与 callback-free scope data checker都由原模块构造。

Active 仍由实际 NativeRead 在原 admit 内产生。绑定 plan 必须 join 原 Scope/read/view/authority/Saver/physical invocation、真实 reservation、实际 DB、完整 original incarnation，且通过原 full admission；不能延长被删除 NativeRead token 的生命周期。Producer 使用 Active 内已经保存的实际 native view，并不重新 mint 原 read receipt。

Family 只在真实 Producer complete 之后绑定原 actual registration、authority、Scope、Active 与真实 native destination mapping。覆盖 checkpoint/target/parent/destination、原 metadata/invocation/lease 的完整关系；缺一项保持 generic。已 qualified 后的异常 sticky，不能 catch 后降级重跑旧链。

私有 source-plan facts 只由原模块 own-descriptor/ref/prototype/flags、固定 collection/signal/lease intrinsics读取。不得在最后 SQL/full source 后执行晚属性、iterator、getter、方法替换或调用者提供的 inspector。

## 两个可分开实施的小窗口

### 第一窗口：Active 与 Producer 内的重复 S/H

qualified Active.current 执行 S FULL 一次，因为该真实 S 内固定执行同一个 H；然后 fresh 核 Active 自有 incarnation、actual reservation、scope/authority/signal/DB/retiring/released 数据。删外层 H 的第二执行，不删 S 或其 H 内的 G/P。

qualified Producer.full 在 Active.current 后，仅核同原 NativeRead 的私有 scope/read 数据，不再立刻第二次 S FULL。随后 registration.full、native destination.full、Producer 最后完整 fresh data JOIN 保持。Active 与下一条 source callback之间不得跨 await；每个独立 Active/Producer 调用重新 full，不保 SQL 行或“成功”状态。

该窗口把每 Producer 的这两处 H 从 3+2 减到 1+1，即表中合计 15→12；其余 registration 展开仍旧。可以先单独验收，不依赖下一窗口。qualified Active 自身 current 在首回调前占 reading/failed latch，原 Active input 的 refs/prototype/data flags 前后核；reservation 尾使用捕获 Map.get intrinsic，不能晚调用原 Map 的可替换方法。

### 第二窗口：Family 的真实工厂 input/destination 复合检查

只有源模块私表证明原 input.current=H+S、原 destination.current=H+fresh destination SQL，并证明 H/S/Scope/authority 都为同一真实工厂，才替换二者内部展开为工厂自造复合函数：S FULL 一次，随后原 fresh destination thread/metadata、checkpoint/parent facts 与 Family 完整 private data tail。

Family 的独立 parent.current 仍执行。原 authority live/registry、actual lease、两个 incarnation、全部 metadata 字段仍核。现 Family 对 destination 读两次，qualified 段可用最后一次 fresh 完整 JOIN同时验证这些固定事实；此 JOIN必须在所有该复合段 G/P/parent callback之后，且不得从第一窗口或其他门传入旧 scope。

registration 的 Owner.full、Target.full、Destination.full 仍独立执行。该窗口没有跨这些独立 full 门共享 snapshot。

restore 路线有额外原 restore.assertCurrent callback，先维持旧链。若以后支持，必须先原 restore full、最后重新 fresh JOIN并核原 restore/proof/target/metadata；不得借 fresh 路线凭据。

## 不改变 unknown 回调次数的附加小优化

这些可另审，不是复合完整检查的替代证据：

1. Manager.shared runtime.current 当前 actualProducer.full 自有末 fresh data JOIN，然后纯 assertCaptured，随后邻接 actualProducer.data 第二 JOIN。若确认 assertCaptured 的全叶都是当前模块 fixed pure facts，删掉仅这一邻接第二 JOIN；原 Producer.full 与所有 callback不动。
2. Destination 每次 fresh JOIN 对多个 alias 验完整原 scalar仍保；相同实际 thread/incarnation 只解码一次。私 scope 的 thread checker核已验证原 thread/expected incarnation证据，不能再对同 raw metadata重复 parse。每独立 scope fresh，不能跨读缓存 row。
3. NativeRun 每个 assertFacts仍 fresh getThreadCore/stat/lease；同一事实阶段的 incarnation/workspace metadata只解析一次。可用完整 initial raw 字符串相等复用其 immutable parse结果，但每次 fresh SQL 与目录验证仍保，metadata改变走完整解析。该项不能减少 physical callback 数量，也不承诺 resident达标。

## 必需真实门与诊断

新 focused test 使用实际 AppDB/Manager/lease/真实 Scope/native read/Saver/Active/Registration/Family，不复制或手工构造 proof。至少：

- qualified 第一、第二窗口的 original H/G/P/S 调用数与执行顺序，M/A/T/D、Model2full/raw、provider/tool/Hook 次数不变；每独立门仍有 full。
- generic/clone/Proxy/wrapper/foreign source/runtime/Scope/read/destination 每项都不进入新资格，旧次数完整。
- 原 G、P、Scope full最后 callback 分别删/recreate thread、retarget directory、释放/替换 lease、release authority、换 Manager binding/map、关闭 Scope、abort invocation，拒 before writer/ACK。
- 相同 source 读或构造 caught reentry sticky；恢复字段/getter/plan地址不得复活；任何 pure checker late getter SQL副作用为0。
- 第一个独立门通过、第二门之间实际 DB/alias/lease变化，第二门必须 fresh 拒绝；await边界不得复用。
- 真 main/shared model、Tool side/fullbody、cancel held worker、unknown drain、lost COMMIT/full ledger尾都保留原门。
- 原 5 秒普通 true/false 和 resident HTTP真实工具/下一 HTTP/CP/UI隔离门；失败保日志，无 timeout改动。

诊断只记录固定类别的 guard/SQL/stat次数和耗时，不输出正文、参数、路径、ID、token、policy内容或错误对象。不从测试中伪造 Source 或 Policy资格。源码票与实际性能门分别报告。

## 第一窗口冻结范围和未完成门

- NEW `src/main/mods/v2/conversation-shared-source-current.ts`：自产固定 H、原 G/P 函数与 receiver、完整 input/task/binding/incarnation pin；只读 execution 资格与纯尾。
- `src/main/mods/v2/conversation-shared-checkpointer.ts`：固定原 Scope.guard S、NativeRead current 私表、原 source/receiver 全/数据 reader。初始真实查询/admit、过期 NativeRead finally 删除、put/putWrites/drain 未变。
- `src/main/mods/v2/conversation-shared-native-host.ts`：调用 core 构造 H，实际 Active 使用同一个原 NativeRead S；不公开 scope/proof 绑定注册。
- `src/main/mods/v2/conversation-shared-restore.ts`：qualified Active S FULL 一次＋原 fresh incarnation/reservation/data；Producer 紧接只同原私有 read 数据尾。registration.full、destination.full、末 fresh JOIN 全留。
- NEW `src/main/mods/v2/conversation-shared-source-plan.test.ts`：13 个定义，实际 Manager/lease/AppDB/StateGraph/createAgent/Scope/NativeRead/Saver/Active/Producer。两种资格钉 H=12/15、独立重复 full 和 destination Active=1/2；NativeRead 已过期但保存数据尾不续权；wrapper/Proxy/clone/真实 foreign authority miss；原 source reentry/construction reentry/close/abort/lease 撤销；Host/Task 与原 Active late getter 的真 SQL 副作用 0、model 0、无 AI checkpoint。

Root 已运行第一窗 13、Scope66、Restore14，全部通过；普通默认 5 秒 native/resident 性能仍失败，见 `output/stage23-native-shared-first-window-performance.log`。Worker build 及第二窗口新的 21 定义仍是独立运行门，不以第一窗绿覆盖新窗口。

Scope 数据尾显式固定原 frozen host 的 signal/authority/assertCurrent/saver 字段与 prototype，并用捕获原 signal intrinsic。原 frozen host.signal 不能被改 getter，该点不记录为可达 P1；新反例仅修改真实可变原 receiver.signal，core reader 的 descriptor gate 必须拒绝且 getter 0，不以伪造可变 host 代替真实夹具。

## 第二窗口的具体实现与冻结合同

第一窗口的 H 总数是 12。第二窗口只折叠三次独立 Family.full 各自内部的 3 H→1 H，总数再减 6，合计为 6。不能把一个 Family.full 的成功结果传给另一个 Family.full；Registration 的 Family/Owner/Target/Destination 四个独立 full 仍按原序执行。模型和 Keeper 的独立 full 也不变。

### 自造函数与真实完成后的激活

1. 在已有 core `conversation-shared-source-current.ts` 新增特定构造器 `createFunctionConversationSharedFamilySourceCurrents(...)`。它首先用已批准第一窗口 reader 核原 S/core H/Scope/Saver/authority/invocation/DB，再固定实际 destination thread/incarnation/完整原 metadata。构造器自己生成两个原行为函数：inputCurrent 为 H FULL→S FULL；destinationCurrent 为 H FULL→fresh destination thread/incarnation/metadata。私表只登记自己生成的这两个函数及同一个原 H/S/Scope record，不能接收已有 callback 注册 coverage。
2. NativeHost 用该构造器替代自己现有的这两个字面闭包，先仍执行全部原次数。restore 存在、原源资格缺失或 foreign 时沿原闭包路线；这一层本身不开始去重。
3. 新 plan 只能在原 `completeFunctionConversationSharedActive` 已核 active.completed、实际 native destination/target、真实 registration、Scope/Saver/authority/invocation/DB 全部一致之后激活。利用现 `bindFunctionConversationSharedRegistrationPostflight(registration,authority,destination)` 接点，传递同一个真实 opaque Active proof；Coordinator 只向相同实际 Family proof 的 private checker 传此 proof，不收 caller 提供的 callback/inspector。
4. Restore 新 data-only reader 只对其 private activeRecords 中真 proof 返回完成关系：原 completed object、actual destination、原 namespace、Scope/Saver/authority/invocation/DB、sourceCurrent execution facts、原 lease/reservation/closed/retiring/released/signal。未知、clone、foreign proof 不返回资格；每次读取仍核当前 private maps/data，不延长 NativeRead receipt 生命周期。Core reader 若需读取它，可以轻量 core-to-Restore function import；两者既有依赖相同，初始化时不得提前调用，不引入 NativeHost/desktop/Manager。真实 Worker build 是必须门。
5. Family reader 对 inputCurrent/destinationCurrent 两个原地址查上述自产私表，并 join 实际 opaque Active 完成关系、Family 真实 proof/authority、genuine destination mapping 的 parent/target/checkpoint/destination/incarnation/namespace。既有 coversFunctionConversationNativeDestinationThread 私表证据负责否决伪 destination。任意 scalar 标签、公开 stamp、function 相等、假的 completed 布尔或 callback 声称覆盖均不够。
6. 在 registerShared 捕获时，对这对自产函数使用 module-captured Function.prototype.bind＋Reflect.apply 固定原函数与 receiver，并保存实际绑定地址；generic 仍原 bind/原 full 链。没有该执行关系，后来不能只凭原地址给已执行 fakebound 的 child 激活优化。

### 每个 qualified Family.full 的实际顺序

- 原 child live/signal/private family/authority 事实入口。
- 在第一个外部 callback 之前占 private Family operation 的 reading/failed latch，包括仍保留的 parent.assertCurrent。整个 parent→compound→authority→fresh facts→pure tail 均在该 operation 的 try/catch/finally 内；parent 捕获重入后也不能复活 outer。compound 自身的 latch 不能代替此门。
- 原独立 parent.assertCurrent FULL 一次，不删、不借别的门的结果。
- plan 私 data refs/flags/active/source 检查；同一次操作内执行 compound。
- 原 S FULL 一次，其中 H 仍真正执行原 G/P full、原 receiver、callback 前后完整事实和 fresh physical thread SQL。
- 原 fresh destination SQL、两 incarnation 与完整 original metadata；不从第一窗口、parent callback 前或另一个门复用 row。
- plan 原 S/H/Active/source/data/closed/signal 纯尾。
- 原 authority.assertLive 一次与 Family 的 authority registry、lease、checkpoint/destination incarnation、workspace/parent/run/metadata 检查全部保持。本最小实施仍保这些原 getThreadCore 位置，暂不额外优化 SQL 数量；若 authority 或其他原检查能执行 unknown callback，其后原 fresh 完整 thread/metadata事实仍执行。
- 最后 Family private child/input/parent/plan/execution-binding、active reservation/authority/signal/lease/DB 纯尾；任何晚 ref/getter/retire/reentry/failed 一律 sticky throw，不能当 miss 降级重跑旧链。

此前 input H→S(H) + destination H 共 3 H，现在 compound S(H) 一次；这是 G/P 实际次数 3→1 的明确调整。original parent Full、authority Full、Registry Owner/Target/Destination Full不因名称相似或 callback 地址相等被删。

### 精确文件窗口

- core source-current：自产函数 pair/private record、只读真实完成关系 reader、full compound/data tail。
- native-host：构造 pair 并传同实际函数；fresh 分支、restore 原链不混。
- shared-restore：新增 private completed-Active data reader；原 complete 接点传真 proof；不覆写 Latest history interface/records/view 区和第一窗 full。
- coordinator：仅现完成后 postflight 绑定参数传递至真 family checker；原四 full 顺序不变。
- child-family：保存真实原函数/固定 binder、真实完成后启用 private plan；assertShared 只有真 plan 改两处内部展开，最后纯 data gate。独立/未注册/restore/generic 路不变。
- NEW/增量 source-plan tests：在同真实 fixture 钉完成前 12、完成后 6、generic/foreign 15、独立重复 fresh/full；G/P 实际减少而 parent/Registration gates不变。

### 实际失败门与性能门

必须真 original G/P 最后同步改 lease/目录/authority/binding/Scope/destination metadata 或映射，以及 parent/authority 后改 thread；before writer/model拒、getter0、旧行/CP不放入不安全新 AI。原函数 own.bind getter/replacement0；unknown/foreign/wrapped/helper clone不优化。第一次 full 通过后第二次 DB/lease变化拒；caught current/activation reentry 恢复字段不复活。source/target inc/namespace不同、新 scope/不同 read、restore 额外来源均拒或保旧链。实际主/Shared/Tool/fullbody/默认5、truecancel/drain/lostCOMMIT/full23/ledgerB门独立保留。

第二窗已收到 Root DESIGN1 与 Latest DESIGN2 并落盘。Restore 新 completed-Active reader 对实际 private record 的 refs/data flags、reservation、closed/signal/source 纯尾先核，再核 private completed 原对象；不可通过改 completed 字段或 clone 造完成资格。原 Producer data 尾同样先核这些原事实。注册 binder 只由原完成调用传真 Active proof，Family 资格命中后首次 parent callback 前占 outer reading/failed，任何 caught 失败保持失效。

新增末门从原 authority lookup 后的最后 `getThreadCore` 返回值检查 own-data created_at 和完整 metadata 原字符串；不增加 SQL，也不把 S 前的数据复用到 callback 后。未知/restore/wrapped pair 保旧链。实际 21 定义保原 13，加 Family wrapper（12）、完成前 registration 10 与完成后 Producer 6/15、exact Active/pair、两个 own.bind getter/replacement 0、parent caught reentry sticky、真实 S 后 raw Family getter 0、authority lookup 后完整 metadata 改变和下一独立 Family fresh read 拒绝。

源码窗口为 source-current、native-host、shared-restore、coordinator、child-family；Scope 仅原 let record 改 const 两行，未改 S/full/data 逻辑。另 Source 的 source record 及 Coordinator 的 ticket 改 const：Source/Scope closure 在纯 literal initializer 后才调用，Ticket 原构造只绑定 prepare、不执行它；prepare 在 core commit 的 await protect 之后运行，引用已初始化。没有删 constructor/source 检查。第二窗源码票、Worker build、21 定义与真正默认 5 秒性能仍由 Root 分别记录，不承诺达到预算。
