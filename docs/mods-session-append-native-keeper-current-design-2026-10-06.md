# Keeper 内同源完整检查的窄合并方案

状态：Root 第一 DESIGN 与 Official 第二 DESIGN 已通过，包括 binding execution proof
及 Registry relation 不独自认证 runtime 的精度增量。Keeper/Registry 窄源码与新真实
integration 定义正在冻结供独立 SOURCE 评审；没有运行测试或性能采样。
实际 native true 6326ms、resident 44840ms 与 physical 451288 的红门由 Root 保存；本文
不宣称这个窄改能使它们通过。原默认 5 秒、完整消息、Worker 与真正 finally 保持。

## 当前调用关系与真实移除数量

`FunctionConversationNativeKeeper.guard` 当前依次执行五项完整检查：

| 次序 | 调用 | 实际行为 |
| --- | --- | --- |
| R | cloned runtime.assertCurrent | 原 Manager runtime 的完整 physical/source 检查 |
| M | mutationGuard | 原 Registry source.assertCurrent，再原 assertEntry |
| A | admission.assertCurrent | 原 producer guard；Model/Side 可有 genuine current 证据 |
| T | runtime.target.assertCurrent | 原 Registry entry/backend/Store/authority 检查 |
| D | runtime.destination.assertCurrent | 原 Manager 工厂中与 runtime.assertCurrent 同一个函数 |

Main 的原 runtime.assertCurrent 进入 target.assertCurrent，后者调用被原 Registry 固定的
backend guard。backend guard 执行原 binding/assert NativeRun 的 before facts、原 binding
callback、after facts，再由 Registry 读取 Store 和 authority。Shared 的 runtime full
执行 genuine Producer 的 active/nativeRead/registration/destination 原完整 callbacks，
随后真实完整数据检查；不是 Main 单一 thread check 的别名。

M 不是一个可随便删除的容量布尔。它先执行创建原 mutation 时捕获的 source full，随后
调用独立的原 Registry assertEntry。T 同样包含原 backend callback，不能因为 A 的
policy/runtime 同地址就当作纯数据门删除。

当前 ModelCurrent 的 full 执行 genuine policySource.full 两次并核原 raw；SideCurrent
执行原真实 ToolReturn/Work/request/runtime/policy full。它们的 readonly reader 只认
模块自造函数地址与同一个 original runtime，并不接受 caller 注册的 coverage callback。

推荐第一阶段 **只移除 R 一次调用**。保 M 的 source full 和 assertEntry、A、T、D 原调用
及次序，每项仍用原 synchronous 检查。不是“原 callback 次数不变”：R 包含的原 binding
callback 在这一同步 guard 链中少执行一次。该变化只在 M 的私有实际捕获关系证明下一项
会执行完全相同 original runtime callback 时采用。原 generic 路径五项一项不减。

这是检查同一权属事实的合并，不保留第一个 R 的任何成功结果。M 每次仍 fresh 执行相同
原函数，再执行原独立 Registry 检查；后续所有原 callbacks 仍有 fresh 数据尾。原 Source
若以第几次 guard 调用决定副作用，观察次数会变化。这类 callback 不能作为业务工作或
once 工作的入口；本优化不承诺保这种调用次数。测试会明确计数差，而不会写“所有 guards
不减”。业务 handler、Hook、模型、工具、flush、writer 的实际次数不改变。

## 先决条件与不能使用的关系

Keeper 当前 constructor 会 clone runtime 并 bind 方法，丢失原对象地址。新增一个模块
私有 `originalRuntime` 引用，仅用于 readonly exact 认证；原 cloned runtime、dispatch、
runMutation 与 generic API 保持。不能拿 clone 的字段相似性当资格。

一次 retain 的 actual admission.assertCurrent 必须是 own data function，Proxy 首拒，
并由现有 `readFunctionConversationNativeModelCurrent` 或
`readFunctionConversationNativeToolSideCurrent` 对 originalRuntime exact 命中。只在 retain
的原 once Work 登记以后固定这个地址，不能在任何 source callback 之后临时换一个函数。
已有 ModelCurrent/SideCurrent 的 same-runtime full 与纯尾合同不改变；未完成 partial、
Input、ToolHuman、普通 Tool、wrapper/bound/clone current 和缺 certificate 都走原五项。

即使 A 命中，也不能由此声称 M 执行的是同 runtime。必须有下一节真正 Registry 工厂
为实际 mutationGuard mint 的私有关系。public source 字段、kind字符串、target.ref、
消息 role/stamp、manager-shaped runtime 和 caller 布尔都不能替代这项关系。

原 policySource.assertTail 必须先完成 Root 当前 native-policy-data-tail 安全修订。
Main 原 runtimeAuthorities.get 会转入 authority.assertLive 与原 physical signal 的晚方法，
不能作为 callback-free 尾；采用已认证同 registry/authority 的纯 reader 与固定字段/
集合 intrinsic 后才可用。该修订由当前原 Owner 实施，不混入 Keeper 窗口。

## Registry 私有 mutationGuard 关系

只在 `FunctionConversationRegistry.runMutation` 原 `kind === native` 分支、实际 mutation
已加入原 pending Set 且即将调用 run 时登记。保存 immutable 小记录，不保存 SQL 成功行：

- 原 Registry 实例与原 resident/entry/target 地址；原 captured source 对象。
- source 的原 owner/plugin/registration/signal 地址与原 assertCurrent 函数。
- 原实际 mutationGuard 函数；本次 actual mutation 地址；不可逆 active/failed 状态。

source.assertCurrent 的原函数从 own data descriptor 捕获，必须与 actual frozen Manager
runtime 的原 assertCurrent 函数严格相同。仅保存这个地址不能证明 M 的实际执行关系：
晚 own `bind` 方法或 getter 可以改变 `source.assertCurrent.bind(source)` 的返回函数。
因此，仅 native 五字段都通过 own data/Proxy 前门时，captured source 使用模块加载时固定
的原 `Function.prototype.bind` 经 `Reflect.apply` 绑定该原函数和原 source；private record
同时固定这个实际 bound 函数。M 的原 callback/this/次数都不改变，也不执行晚 own bind。
safe native captured Source 只由这五个已核 own-data 值构造，不再 spread 原 source。
额外字段、符号、accessor、Proxy 或未知形状不 mint 关系，仍按原 generic 路径处理。
其余 getter/Proxy/unknown source 不 mint 关系，保持原 generic 捕获和检查路径。reader 不
接受 caller callback，也不改变 runMutation 的原 assertCurrent/最后检查/finally。

Keeper 的 R 同样先固定 nonProxy runtime 的 own-data 原 assertCurrent 函数与原 this，
通过模块捕获的原 bind 构造实际 R。此 binding 安全本身不授优化：缺 genuine A 或 M
关系时仍执行原五项。新 integration 同时在该原函数上添加 own bind getter/replacement，
要求 R/M 都不执行它们，并真正执行原 physical/source callbacks。

建议 readonly API 放在 Registry 模块，符号与表不导出：

```ts
readFunctionConversationNativeMutationGuard(
  guard: unknown,
  originalRuntime: object,
  producer: object,
  occurrence: object
): { assertTail(): void } | undefined
```

它首先只查私有 WeakMap，unknown/wrapped/bound/Proxy/foreign guard 返回 undefined 且
0 trap。随后 descriptor-only 验证 supplied runtime 的 owner/target/signal/assertCurrent
和 immutable destination 关系，exact match 原 captured source.owner/plugin/registration/
signal/assertCurrent。这个 reader 只证明原 mutation/source 关系，并不独立认证 runtime。
共享这些原函数字段的 runtime clone 不能仅靠此关系获得优化；Keeper 必须先用 genuine
ModelCurrent/SideCurrent reader 对 originalRuntime exact 命中，然后才能组合该关系。
整个分支对 clone 的拒绝来自这项前证，不扩大 Manager/runMutation 接口，也不授
target/mutation 权限。

`assertTail` 只能读原 actual mutation active 状态、original Registry constructor WM 的
原 maps/entry/resident、原 record own descriptors/active flags 与 native signal intrinsic。
所有集合操作固定 native intrinsic；不调用动态 this/prototype methods，不执行 backend、
Store、authority full 或 source callback。Main resident.main 与 Shared child 的原关系分开
核，不能复用只支持 children map 的现有 targetData checker去猜 Main 身份。

原 mutation finally 首行将本记录 active 置 false，再原 pending 清理。旧 guard 在实际
finally 后不能认证；capacity/true drain/未知 physical release 保留原逻辑。reader/纯尾
失败令本记录不可再认证，不能 catch 后改回 generic 路径继续已失败的 Work。

## Keeper 每次 guard 的显式分支

retain 固定原 A 地址及其真正 current proof；run 的原实际 mutationGuard 参数只在进入
guard 时经上述 exact reader 选择。reader没有 full callback。只有两项私有证据同时成立
才用认证分支；任何 miss 都执行完全原链，不设置 public 优化标记。

```text
cheap Keeper closed/reentered + original combined signal
  generic miss: R -> M -> A -> T -> D -> 原 sameDestination
  exact branch: M -> A -> T -> D
                -> original sameDestination 的 fixed data comparison
                -> mutation relation pure tail
                -> ModelCurrent/SideCurrent complete pure raw/policy/slot/Host tail
                -> Keeper/Work/original A/combined signal pure tail
```

认证分支的 signal 使用 module-load 捕获的 AbortSignal intrinsic，原 signal 地址不变。
所有原 full callback 返回仍要求 undefined；不把 Promise/未知结果当成功。末纯尾不得
再次读取可改 admission.assertCurrent 或 method/bind/call。返回只使用 retain 固定值。

T/D 后增加完整 native current 纯尾，用来检测这些最后的原 callbacks 改 raw、policy、
slot、cut、Host latch 或 actual runtime/source 关系。原 adoption/alias/Store/transcript/
Keeper/projection A/B 各自所有检查都保持；不能跨 await 或独立下一次 guard 借成功结果。
失败沿原 Keeper catch/controller/true finally 处理，已提交事实不重跑 writer/Hook。

## 暂不批准的更大合并

不能凭 A 的 policySource纯maps尾直接删除 T 或 D。尤其 Main maps尾不是完整 thread/
workspace directory/physical lease 的 fresh snapshot。Shared runtime 的 Producer full
同时有多组独立原 callbacks，不能按相同 method 名折叠。

若后续要移除 D，只能另设计 actual Manager runtime private capsule 加真正 callback-free
完整 physical B：Main 为每次新 thread/DB/inc/workspace-directory/lease/authority 数据，
Shared 为原 Producer 完整 fresh JOIN 与原 registration/family/lease/authority/scope 状态。
最后独立 target callback 之后必须再取得这些事实，不能把早 A 的 row缓存拿到末尾用。
同时需明确 D 所含原 callback 少执行一次的行为差异。本文不授权该较大窗口，也不改变
NativeRun/SharedProducer 原 full source 或 Registry mutation guard内的任何 callback。

## 真正回归与实施窗口

独立 Keeper integration 新 suite 可复用实际 Manager/AppDB/lease/Node/Saver/Host fixture：

- genuine Main ModelCurrent 和实际 Shared ModelCurrent，以及 genuine ToolSideCurrent。
  检查认证分支少一个 R，但 M 的原 source full和 Registry backend callback 仍执行，
  A/T/D 全部仍执行；实际 Hook/工具/模型/flush/writer 次数及完整 canonical/CP 保持。
- original runtime clone、foreign genuine runtime、A wrapper/bound/Proxy、fake current、
  generic runtime、M wrapper/bound/foreign/已 finally guard 都命中原五项或明确拒。
- 最后 T/D 的真 source callback 改 raw正文/calls/metadata、epoch、source maps、Node slot、
  ledger、目录/lease/target 或 signal，0 ACK/0新模型请求，提交事实不重放。
- 首 callback caught same occurrence reentry、mutation finally retire、原 actual callback
  throw undefined/null、异步 guard、unknown release、hold/drain 回归不削减。
- private collection/recordfield/method/accessor/Proxy 阴性 getter0；tail full sourcecallback0，
  每次独立 guard 原 M/T/D fresh，不能凭前一次成功得到结果。

预计 Owner 为 Keeper constructor/guard 小段、Registry mutationGuard private reader 小段及
新 integration test；Policy安全先决由原 Owner 完成。实现前需要 Root/另一 agent 两票、
精确冻结窗口。既有 Keeper/Model/Side/Host 默认门与 native true/resident 实际性能由 Root
单独运行；只报告实际改善，不能更改默认5秒、缩正文、删 row/CP/HTTP 或以测例代来源证明。

## 当前冻结定义的实际范围

新 `function-conversation-native-keeper-current.integration.test.ts` 定义 19 项，使用真实
AppDB、physical lease、Manager/Registry、createAgent completed Model Slot、SqlJsSaver、
actual Adoption、Keeper 和 Protector。它覆盖 certified/main Model、current wrapper、
runtime clone 的精确 full-callback 数量差，完整 canonical payload/实际 CP，一次绑定执行
证明、mutation relation finally 退役，以及最后 D 改正文/metadata/policy/binding/close/
caught reentry 拒写。纯 relation accessor 阴性保留真实 ordinary message 并要求 getter0。
资源收口先 abort，逐个等待 Keeper/Node 真 drain，再关 Saver/DB；错误 status 不以 reason
真值判断。该新 suite 没有新增 resident/HTTP/Shared/Side 实际正向，需结合 Root 原真实
门分别验收，不把 Main foundation 的测试定义或 SOURCE 票称为全部 producer 性能通过。

Root/Official 在首 SOURCE 中确认 Work 晚字段 P1；原 13 定义快照只保 R/M 绑定及完整
M/A/T/D 局部结论，不作为最终 Work 纯尾完成票。两 DESIGN 窄补以后，Work.certified
只保空 frozen token，原 current/source/admission descriptor 副本及 reading/failed 都在
模块私有 Work WM。资格完成后、首 external Source 前固定 Work 的 admission/controller/
result/drain/physical/certified 引用及 reentered 原 data flags；guard 先 descriptor 门再用
私表局部值，最后再核。retain prior 也先 descriptor 门，换 admission 时只用原数据
descriptor 标记 reentered，不执行晚 setter。失败状态在私表不可被 callback 重置。
新增 6 个真最后 D 阴性覆盖 certified/reentered getter、证据/来源引用替换、caught nested
guard 后还原和 prior retain getter；getter0、0writer、CP 无 AI、原结果不重试均保留。

## 第二实际门的窄修

`stage23-native-keeper-current-second.log` 保留 32 定义的 27 PASS / 5 RED。
原 19 新定义中，所有最后 D 和 Work 阴性已通过；四项正向拒绝发生在
NativeProjection 对 name 的严格事实比较。真正 AgentNode 给 completed AI 设置原 name，
夹具现从该 Slot 的完整 typed capture.data.name 取值、校验 string 后固定到 facts，
并严格断言 saved.message.name 等于原 Slot name。没有补假 State、incarnation 或 stamp。

第五项真实 RED 是 Transcript 捕获 destination.assertCurrent 时读取晚 own bind getter。
Root DESIGN1 与 Latest/Official DESIGN2 后，仅这一绑定改为模块捕获的原
Function.prototype.bind，经 Reflect.apply 绑定同一原函数与原 destination receiver。
原所有 current 执行次数、位置和资格保持。既有 getter/replacement 两项真实 Keeper
回归继续要求 getter0、完整实际 canonical/CP；不把该单点修复称为 Transcript 全部纯尾。
