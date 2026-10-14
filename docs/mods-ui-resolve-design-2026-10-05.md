# Stage21：真实界面构造器替换方案

状态：正式方案与最终实现均通过两位独立评审，v88 的广域回归、真实桌面、传统 Plugin／项目、类型与独占性能验收已完成，详见 [阶段报告](mods-ui-resolve-stage-2026-10-05.md)。退休补充方案见 `mods-ui-resolve-retirement-design-2026-10-05.md`。开发目录为 `C:/ai/CmbCoworkAgent-mods-v2`，分支 `codex/mods-v2`，UAT 不写入；Stage20 历史验收独立保留。当前继续 v89 Markdown 开发，不把后续代码算入本阶段验收。

## 用户和作者会得到什么

作者可以在 `ui.resolve` 中取得真正的下游函数表，返回替换函数或函数包装器。另一个插件的 JSX 会同步调用这些真实函数，文本、按钮等仍沿现有的界面树、保护和原子提交链显示。`$.ui.resolve(e)` 同步读取本插件已经解析好的冻结表，不在每次读取时重新派发，也不缓存构造器输出。

基础用法继续是 `const lower = await next(e)`，然后返回 `{ ...lower, Text: props => lower.Text({ ...props, dimColor: true }) }`。缺席的已支持元素画透明 fragment，保留孩子而不偷偷保留动作。函数或包装器不能被换成 JSON 描述、执行字符串或 renderer 模拟。

本阶段覆盖本工程实际桌面 `Pane` 与 13 个现有站位，以及当前支持的九种构造器。没有 terminal/mobile 等原生 surface，不能冒充它们已绘制。官方 `Markdown` 等尚无本工程完整元素接线的名字，不因本轮被默认为空 fragment，也不称框架限制；后续仍须实现相应真实元素。`Client.surface.elements` 的独立绘制 API 保持现状，不由本轮普通插件 `$.ui.resolve` 证据推定它也应经过同一规则链。

## 固定依据和证据边界

- [官方 reference](https://code.claude.com/docs/en/plugins/mods/reference) 把 `ui.resolve` 定义为加载时按 app、site、mod 产生表的事件。
- 固定 2.1.289 声明 `readable/claude-code.d.ts:2299–2313` 是同步读表；`:3674–3681` 是同步 props 到冻结元素的函数；`:3871–3879` 是加载时解析、没有父 props、跳过自己的规则；`:9887` 的事件输入只有 `surface/component`。
- [13 项原版研究](mods-ui-resolve-original-review-2026-10-04.md) 的正式日志为 `output/claude-code-2.1.289-alignment-analysis-2026-10-04/ui-resolve-review/qualified-single.log`，1 文件 13 PASS。包括真实函数组合、全自身插件组排除、同表缓存、fragment、实际按钮原 callback、非法表回退与同步结果拒绝。
- [构造器 SDK 研究](../output/claude-code-2.1.289-alignment-analysis-2026-10-04/ui-resolve-sdk-review/review.md) 的 `qualified-first.log` 为 1 文件 11 PASS。真实构造器内 `store.get/set/then` 是定义插件来源；同步 mount 不等 held SDK；正常函数返回后回复仍可结算；same-key 新/包装 callback 不取代原 callback。只有 store 的测试 core 被替换，真实函数、SDK dispatch、VM、mount/press/redraw 均由原版执行。

EXE SHA256 为 `bcc6d9117aec30ad9414490302a25414359c871f5647e32e49b055c92bf84e0b`，声明 SHA256 为 `791464683ba02b5905d477fdb2fe9a81a5110c937bc28bae21414657d53a9894`，kit SHA256 为 `20de9e6abf0e04968db029d9a4880edc4ab45d173d315a212bd0e89dcdbff119`。两套 runner 已核 EXE/version、归档 SRI 与 manifest 对应提取资产；诊断失败、重复发现测试文件、未进入的早期夹具分支均在原报告单列，不抹掉。

官方 npm registry 于 `2026-10-04T16:06:16.8313644Z` 查询 `https://registry.npmjs.org/@anthropic-ai/claude-code/latest`，实际 latest 仍 `2.1.289`，main 包 SRI 为 `sha512-RQWjAlalf9aomgI3JaXDCdFPvmNVnRdjwMtYk5L+Lw1NWxCxbhY5T9F+w1xukqvJh/I2rR2+3hICZxhk0al1nA==`。本轮只查询版本/SRI，没有更新全局 CLI、下载或改变固定验收基线。

补充[callback原版研究](../output/claude-code-2.1.289-alignment-analysis-2026-10-04/ui-resolve-callback-review/review.md)已实际完成：`qualified-first.log`为1文件6 PASS/0 FAIL（0.60s），真实mount/find及逐字段严格断言均通过。foreign replacement的`props.onPress`是undefined；同步无参/伪造参、microtask、held SDK回复后及另一个command保存后调用均TypeError，实际Q callback/store/prompt/ui.press为0。只有真实ui.press才执行Q callback一次，实际event/requestId与store/prompt来源均为Q。前轮diagnostic日志与不同hash快照完整保留，不用打印代替qualified断言。证据限Button/onPress/desktop/AbovePrompt；固定可读模块Kh/rootOf/revive的剥离/输出重接支持实施策略，其它动作仍需本工程回归。因此不实现通用函数参数桥，不向P交付可调用的Q callback，不制造人类点击来源。

## 当前接线约束，不是不可实现的框架限制

`guest-ui.ts` 当前在 `ui.render` 中生成本地固定表；`guest-bootstrap.ts:408` 直接读它。`guest-runtime.ts` 的普通 invoke 返回 JSON，`host-entry.ts` 的结果也经 `encodeModJson`，所以不能让普通 `FunctionDispatcher` 装载函数表。`runtime-client.ts` 为一个实际 Session 的 guest 建一个 utility process，`host-entry.ts` 持有该进程内所有持久 guest；每个 guest 目前有独立 QuickJS runtime/context。

安装的 `quickjs-emscripten` 同步实现提供 `newFunction/callFunction` 与需要手动释放的 handles。`QuickJSRuntime.assertOwned` 明确拒绝另一个 runtime 的 handle，因此不能把 A 的 QuickJSHandle 直接作为 B 的参数。正确桥接是在同一 utility process 内调用目标 runtime 的真实函数，并在两个 context 之间进行受限复制和私有能力转运。无需主进程同步 RPC、Asyncify、`Atomics.wait`、源码复制或泵其它 guest 的 jobs。

实际基础实验已完成并在qualified轮重跑：`ui-resolve-callback-review/qualified-first-foundation.log`三个assertions通过。两个独立runtime实际A→B→A函数返回26；assertOwned拒绝foreign handle；同一8ms monotonic root cut使peer忙循环约10.05ms中断，未执行pending jobs。此项只证明所用API同步重入/共享cut可行，不计入6个原版测试，也不证明生产聚合CPU/Hook计量或SDK权限正确。不能以实现规模或IPC普通JSON限制宣布ui.resolve不可实现。

## 三种 owner 必须独立固定

| 事实 | 由谁提供 | 用途 |
| --- | --- | --- |
| 定义构造器的插件 P | 真实注册对象、runtime、Session assembly、grant/epoch | P 捕获的 SDK 仍调用 P 的 capability 和存储空间，不借消费插件 Q 的权限 |
| 当前绘制的消费插件 Q | 真正 `ui.render` 的调用、Pane/site object、generation、thread incarnation、signal | 固定当前树的生命周期、保护和 publication，不能借另一个调用或最新页面 |
| 原动作 callback 的持有者 | Q VM 的原闭包与私有 callback 记录，或已有合法孩子树地址 | 实际点击仍是原插件/原 element/原 request；不是谁返回替换树就获得权限 |

这三者不从公开 `e.plugin`、guest 输入、props、renderer metadata 或公开函数数字 ID 决定。构造器是在绘制中执行，不能因此获得 `person`、`userInitiated`、文件写租约、模型/工具审批或可主动提交的来源。原callback在传入P前被剥离；直接/保存后调用均不受支持，也不模拟一次用户点击或提升源上下文。

## 私有底层基础

新增 utility 内 `FunctionUiResolverRegistry`，以实际 assembly/Session 对象、消费 runtime 对象、surface/component 为键。主进程负责注册已批准的实际插件对象、执行次序、原 grant/config/source 版本及 capabilities；utility 不接受 guest 自选更多 runtime 或更高 tier。

registry 保留以下对象，均不进入公开 ModJson 或 renderer：

1. `TableLease`：冻结表的实际记录及定义函数引用；可以有专用 host wire token，只有真实 resolver 请求的私有 pending record 可以消费。
2. `ConstructorLease`：目标 QuickJS function handle 的实际所属 guest、定义 registration、assembly、引用计数及失效状态；不含可执行源码。
3. `DrawReceipt`：当前实际调用、原 slot/Pane object、generation、thread incarnation、signal 与 guard；不使用可重新 capture 的“最新地址”。
4. `CallbackLease`：原 caller 闭包/实际 callback handle、类型/key/request/generation 证明；独立于 constructor actor。
5. `ConstructorScope`：一次真实调用或其已接纳 continuation 的 P actor、Q receipt、原 source facts、SDK signal/guard/活动记录。没有 ambient-main fallback。

增加专用 host-side request/result 类型来准备/释放表；不能宽松化普通 `FunctionInvocation` 的 `value` 或 `isModJson`，也不能给所有 SDK 返回任意函数的通道。wire token 是查找实际函数对象的私有能力，不是界面里的假函数。普通 JSON、树 props、public metadata 即使填写相同字符串/数字也没有函数入口。

所有 handles 必须 `dup/dispose` 对应，包含非法结果、fallback、候选失败、源退休、utility 崩溃与停用。缓存只在实际 Session assembly 内，不跨 configuration swap、批准/source/config epoch 或 thread incarnation 复用。

本工程具体容量：现有utility实际上限16个guest runtimes，桌面支持Pane+13 sites，共14 components，所以每actual assembly至多16×14=224个consumer/component缓存槽。实际live与candidate的slot分别有各自224上限；thread宿主私有ledger对两者及仍在真实finally中的retired assembly共同计数，最多4096个实际保留function/graph handles、32个活跃root同步调用scope、1024个已接纳异步branch receipts。nested peer不另占一个root也不重置root预算，但其实际handle/branch计数仍计入ledger；每branch reaction计数也有1024共享上限，不能用一个receipt无限挂reaction。容量是本工程bounded适配，不冒称官方数值。

释放必须与真实dispose/finally一致；candidate失败不能先把未释放handles从ledger减掉再给新candidate额度。超限拒绝新admission并清其已分配候选，不覆盖旧table/旧安全frame。没有resolver时的native本地cached table只受原guest内存及224槽限制，不导出foreign handle、不建constructor scope或SDK RPC，不能因另一candidate的foreign ledger满而拒绝原noHook native path。现有frame/RPC/Client/node/JSON上限继续有效，以上上限不替代或抬高它们。

## 加载时解析真实函数表

在所有插件实际注册完成、`engine.create` 已形成各插件有效 SDK 之后，且首次 `session.start/ui.render` 前，为每个实际消费插件和本工程支持的 desktop component 解析。候选 session 也走同样过程，但继续受既有 sticky 初始化 effect 禁令；不能凭新的表解析通道绕过候选只读规则。

使用现有 `Session.start()` 在nouns.build前建立的一次120000ms startup截止（`session.ts:1047–1065`）；`FunctionSessionInitializer`本身不另给时间预算。engine.create、所有tables/matchers/SDK/recovery、session.start及候选分支drain共用这一绝对截止和原initialization/prepared/source取消，不为每consumer/component重新创建120s。专用ui.resolve单次链新增本工程bounded短wall适配上限 `min(5000, startupRemaining)`；这不是原版5s承诺，也不是当前dispatcher默认值（现默认120000ms，普通注册Hook ownBudget10000ms，旧private undefined ownBudget才默认5000ms）。普通既有Hook预算不变；新resolver的注册Hook自身budget、SDK/next停钟及CPU/内存仍用原规则，但额外受上述明确短wall限制。resolver表解析放入现有start deadline之内，不能放在start之前另送一段时间；quiet registration-only入口仍不隐式start/解析。到期封闭新admission，host忽略abort的真实work保留活动至finally且不允许迟到采用表。

同步constructor单call深度最多24，所有peer共享当前UI单段50ms cut，并给各P原500ms/5s CPU窗口记其真实执行时间；不得每peer新给50ms或重复计算另一个VM运行等待时间。整体120s startup不放宽这两项CPU限制，也不移除本工程给新resolver规定的5s短wall；交付文档必须明示这个bounded适配，不能宣称resolver的等待预算全面等价原版。

输入严格是 `{ surface: "desktop", component }`，无父 props/requestId/可选 owner。链快照来自原真实加载顺序与 tier，matcher 在原定义 guest 执行。对消费插件 Q 排除 **Q 的全部 `ui.resolve` registrations**，包含 `*`/`ui.*` 及 matcher；不是只 skip 一个 registration。

这是一条专用函数结果 dispatcher，复用原 dispatcher 的调用/取消/own budget/next/catch/fallback 原则而不 JSON 序列化表。每次 `next(e)` 返回目标 guest 内可同步调用的真实 lower 表；结果逐 entry 检查函数并冻结。非函数 entry、普通 resolver throw/超自身预算按原 optional recovery 使用真实已产生的下游表，未调用下游时才调用一次，不重放 SDK 副作用。撤权、assembly/owner 失效、dispose 和宿主 publication 失败不能伪装成功回退。

表一次安装到消费 VM。读取同一 surface/component 得到同一冻结表对象；正常 redraw/第二 mount 不再执行解析规则，构造器本身仍每次执行，不能去重 `store.set` 等真实效果。`$.ui.invalidate("ui.render")` 只按原路径重绘，不凭它重跑 resolver；新实际 Session 或明确重载才建立新表。

未安装完成时不能从未来表读取或使用其它消费者表；解析过程自己的表读取只使用当前已明确可用的原 native 基线，不能递归自等待。没有 `ui.resolve` handlers 时保持低成本原表路径；没有插件/Mods关闭的 Stage20 host-only 安全展示不建立 guest 或新 resolver 会话。

noHook仍按每consumer/component缓存一个冻结的真实native函数表，连续read/redraw得到同一个表对象；native函数每次执行检查本次actual UI scope，不捕获首次requestId/generation。不能每read重新new表，不能因没有foreign chain而丢缓存语义，也不为此做跨VM导出/host RPC。

strict自动candidate的table-load SDK及所有已admitted delayed continuation固定候选初始化事实，持续经过只读allowlist、effect sticky、实际source/owner/signal/活动栅栏；表函数定义本身可缓存，尚未真正绘制的candidate不能冒造Q draw/person。load-time SDK沿真实registration/P原capability与实际assembly初始化proof执行；constructors被真正绘制调用时才有新的Q draw receipt。这两种proof不能互相降级。

自动candidate全部已admitted初始化branch必须在上述共同120s内drain至实际guest jobs/hostfinally完成，initializer.assertReady和最终source/config/grant/CAS复核后才activate/swap。不能先swap后让held `get.then(set/model)`变active逃出sticky；即使实现误提前读到active，私有candidate-admission事实也不得给其写权限。deadline/cancel失败保留旧guest/pending，无重放，无转成moduleHost。正常cold及显式整组restart仍按其原允许startup-effects语义执行，不被误改成只读；本轮只改变自动candidate的真实完成判定。

## 同步构造器桥

消费 VM 的每个 table entry 是真正冻结的函数，native closure 固定 registry 的实际 entry。调用时先验证 P definition 和 Q draw receipt，再把受限 props/children 复制到目标 context，调用该 context 的实际 `callFunction`，把真实同步结果复制回来。上层和下层 wrappers 都是实际 VM 闭包，不能改写成 AST 模板或 renderer 配置。

缓存函数闭包只固定 definition/table identity，不绑定首次调用的 Q generation。每次同步调用都由当前实际 render/action admission 注入新的 Q receipt；没有该次私有 receipt 就拒绝调用。已接纳的 held continuation 则固定其接纳时的旧 receipt，绝不重新读取最新地址或缓存函数的下一次 receipt。两个并行调用有独立 scope/route，不能用全局 mutable current 指针覆盖对方。

函数输入中的原 callback先由Q私有记录保留并从foreign props剥离；P不能读取可调用Q函数。已有children的动作身份走独立私有graph manifest以便输出重接，普通数据仍须经过大小/深度/有效数字和防accessor执行边界。不要对任意guest对象在主进程dump/访问getter；准备、检查与冻结在guest CPU限制内完成。实际函数代理只用于专用table及lower constructor组合，不支持任意props函数参数，不能从guest JSON解出“函数地址”。

同步调用不等待主进程 Promise，不执行 pending jobs 来强行获得结果。返回 Promise/thenable 不是 RenderElement，立即作为非法同步结果拒绝；其已发生的外部效果不回滚，也不重放构造器。正常返回仍是被冻结的 plain-data tree，保持原深度/节点/字符/JSON预算；省略构造器返回透明 fragment并真实 flatten children，不能额外加 Box 布局或保留动作。

真实嵌套允许 A→B→A，因为 native lower 可能回到原消费 VM；禁止无界 registry 重入。所有参与 runtime 共用一次 root 同步 cut，进入 peer 不能再给完整 50ms。interrupt、当前 Hook own 计量与各 VM 5 秒 CPU 窗口均实际计量，nested finally 恢复原 interrupt deadline。不能只扣最外层、重复使用新的 deadline，或给返回 Promise 的代码无限执行机会。可调用表/引用/暂存 graph 的数量受实际 guest 内存及明确 bounded registry 约束，容量耗尽可恢复但不提供额外权限。

### 透明 fragment 的实际表示与验证

当前 `guest-ui.ts` 的 `uiFragment` 生成 `Box(flexDirection:column)`，`FunctionUiElement` 只有 node/engine；不能复用它冒充原版省略构造器的透明结果。本阶段新增严格的 `FunctionUiFragment = { type: "fragment", children: (FunctionUiElement|string)[] }` 内部wire联合，只有这两个own fields，没有props/key/press/client/ref或DOM属性。普通未知类型、任意顶层数组/标量、带多余字段的fragment仍拒绝；只在专用桥中将真实Fragment/children内部数组转成该表示，不顺便放行作者constructor裸数组返回。公开输入即使构造同形inert fragment，也不能生成函数、动作或engine证明；它的所有孩子仍走原provenance/预算/批准验证。

构造器 props 的嵌套 children 使用受限 flatten；透明结果保留无布局的 fragment 表示，顶层也能承载多个孩子或空列表，不换成 Box/Text、不分配 Button 动作。renderer 用真正的 React Fragment递归渲染，DOM 中不多一层容器，嵌套 fragment 的布局效果是展开孩子。树中保留结构顺序及空 fragment，直到原生 Ask 验证完成；绝不能先把 engine 后面的空 fragment/空 children 删除再称满足“下方无内容”。预算先计算原结构节点/深度，再规范化，不能用 flatten绕过1000/24限制。

所有 walker 必须显式覆盖此严格联合：shared tree validator与Link纯复制归一化；guest callback/provenance/release遍历；Panes actions/focus/scroll；Clients preflight/reconcile、accepted props及native-only engine拒绝；native engine refs/fallback/order；renderer主树及Client子树。fragment自身不参加key/action索引，也不向Client callback收集器冒充FunctionUiNode。未知node不能因通用 `children` 遍历而放行。保护后返回仍再次验证 fragment精确shape及所有孩子。

Ask ancestor验证允许 fragment作为无样式结构祖先，但所有实际 Box祖先继续原allowlist，Text/隐藏/尺寸等不能借fragment绕过；完整遍历仍恰好一个真实ref，看到该engine后任何后续节点（包括空Text/空Box/空fragment）都拒绝。native fallback 判定按严格验证后的透明逻辑root辨认单engine，并保留实际host ref/data身份；原控件授权仍不从fragment输入推导。SessionMode的inline展示也只能透传已允许的纯显示孩子/engine span，不能借fragment引入交互树。

实施gate增加真实跨VM与真实DOM两组：顶层省略Text返回两个孩子/空fragment，嵌套省略Button保留孩子且无任何press句柄/额外Box；原横向父布局的相邻节点DOM没有新增列容器。Ask用根及嵌套fragment包真实engine保留唯一控件、原requestId/回调；engine后空fragment/空Text/空Box都拒绝且旧安全画面健康。Client在fragment中仍检查批准/容量/模块/owner，Client独立树内engine仍拒绝，非法fragment props/ref/press与保护后注入均为零效果。未完成这些 walker/DOM gates不能签本阶段完整实现PASS。

## constructor SDK：实际 P 路由，而非 Q 的 host 借用

现 `runtime-client.pending.host` 与 `host-entry.forwardCall` 按 runtimeId 精确匹配，直接把 P 的 SDK call 填成 Q requestId 会被拒绝，反过来借 Q capability 则违反原版来源。必须增加 **仅 host/utility 能用的 constructor-call 路由**。

主进程为该次真实 draw 注册私有 proof，固定 Session assembly 和 Q 实际调用、各定义 P 的 actual runtime/registration/capabilities 与 SDK handler。utility 的 registry 函数闭包为 P 调用携带 proof，不接受 guest 选择 actor。主进程先检查 proof、P/Q 注册对象、原 signal、binding/config/grant/epoch 和 draw guard，再以 **P 的真实 capability handler** 执行；SDK calling-registration 仍为原定义 registration，不能借 Q 的 skip/capabilities，也不能把全插件组 skip 扩张到普通 SDK。

SDK 对外仍是原 Promise；调用实际 provider 时使用现有模型 resolver 和本次接纳的实际 modelRef、预算与 Claw guard。表缓存不缓存模型事实、不读取未来 main/child 绑定；没有该 SDK 本来所需的实际 model/lease/backend 就按原策略拒绝。tools/fs/UI/网络/agent/process 也沿原权限、审批、取消和保护，不建立新租约或临时冒充 main。

每个 constructor/continuation scope 明确保存定义 P actor 与这次 Q proof。它既不复活加载时已结束的 `ui.resolve` frame，也不由全局 latest scope 指针转发。普通 constructor 或 render frame 正常返回不撤销已经接纳的 SDK，这是 11 项原版证据的必要条件。真正 signal/owner/generation/source/config/revoke/VM 失效关闭 scope：迟到回复可以清资源，但不能产生新的 store/model/fs/UI 等效果或回填旧树。

生命周期需两层记录：同步构造调用本身前景占用；每个已接纳的异步分支在实际 guest reply jobs/continuation 与 host finally 全部结算前保持连续 activity。不能只数单个 RPC：`store.get().then(value => store.set(...))` 的 get reply 到 then 进入之间，整分支 token 仍活着；若这时下降为零，safe apply 会提前退休定义 VM，必须拒绝这种实现。utility 私有 tracked branch 将属于该 scope 的 Promise reaction/jobs 与真实 host work 一起登记；运行 reply jobs 只按原正常调度，不同步泵 unrelated guest jobs，不把任意后来来源登记成既有分支。追踪不可完成时必须收紧这项接口，而非提前释放或永久持有所有缓存函数。

具体基础复用 `async-scope.ts` 的实际 Promise lowering 和私有 `NativePromise.prototype.then`：在 constructor scope 的 SDK 接纳前先 retain 整分支；为此 scope 实际登记的 reaction 在入队前计数、真实 handler/其 adopted Promise settle 后减数，host reply-job completion 也持有独立计数。最末减数只在 guest/host 同一私有记录都确认没有已登记 work 时关闭，不靠 `runtime-client.calls.size`、通用 jobqueue 暂时为空或单个 RPC ACK。下游 SDK 在 reaction 执行中同步接纳/retain 完成后才可释放父 reaction。这仍需 actual QuickJS/config apply 回归证明，不以 bootstrap 文本存在替代连续性测试。

同步树返回、caller timeout 或 IPC pending 删除不能把真实分支算作完成。最后一个已接纳 branch 在其 final settlement 后同步关闭并释放 scope，已结束而还想发新 SDK 的旧 scope明确拒绝，不能转成普通 moduleHost/background。真正 revoke/dispose/原 receipt 失效会立即封闭新效果，但 activity仍保留至实际 host finally及已进入 guest jobs收口；配置自动应用必须等待这段连续占用。静态表/无活动 closure 不永久持有前景 token；取消与配置重载继续按已有真实 activity/resource 规则执行。

## callback 与树的接回

调用 foreign constructor 前保留原 props callback、root key/类型以及已有孩子树的原私有地址。返回树以这些事实接回原动作。same-key 的替换/包装 onPress 不改变原 callback；新 foreign key 或凭空新增 foreign callback 没有这项继承证明，按已实证 Button 范围拒绝，不能悄悄授予 resolver 的点击权限。

native lower 的无 callback 中间节点必须是内部可重接状态，不以一个公开空函数获得健康 action handle。最后只有成功重接到原闭包的节点才取得既有 guest 私有 callback handle；非法结果不覆盖原代 callbacks。callback 入队、执行、SDK/publication 和返回仍用当前真实 action proof，Ask 还必须验证原实际 request object，R1 永远不能控制 R2。

原版直接/保存后调用探针中实际foreign props缺callback，桥采取同样剥离策略，只在输出树里按Q原key/地址私有重接。严禁把直接调用造为一次ui.press，严禁给P注入一支可调用Q闭包。实施回归必须真实断言P看到undefined、保存后仍undefined、原callback/sdk为0；真实用户点击才按Q原private action进行。不能因新桥实现方便恢复已被剥离的callback。

## 保护、原子提交与兼容

函数结果最终沿 Stage20 原生 drawing refs、`validateFunctionTree`、Link 归一化、Client approved module/容量 preflight、实际 host publication和身份核验。Ask 单 engine/祖先 allowlist/expectedRequestId、Tool actual IDs/status/order、CommandOutput/来源与原生 preview/审批均保持。constructor 只修改展示不改变执行对象。

新函数表和实际树要分开提交。prepared tables 不能提前替换 live cache；全部查明原对象/epoch 后同步 adopt。绘制候选未通过保护/树/Client preflight 时保留旧安全 frame和旧动作，不回 raw；构造器此前已发出的外部效果不承诺回滚。只在实际提交后采用新 generation；Client 后续真实 VM 的 draw/run 故障仍走原 `ui.fault`，不把原生 refuse/guard失败误报 Client fault。

传统 Plugin/Harness、无 resolver 的普通聊天、Claw参数/批准、Flow/main/child模型边界与 Stage19 主动提交链不增加新的授权或等待。新增 capability 需 bump host revision；旧 code grant 不能静默获得函数桥的额外能力。更新 author 示例和 matrix 时将真实 resolver event、同步 helper、元素范围、SDK origin 与未覆盖来源分清。

## 最小实施顺序和验收

1. 原callback qualified6项与本地QuickJS A→B→A/ownership/sharedcut3个assertions已真通过；产品聚合预算/continuation占用仍为实际回归gate。独占output保留诊断、qualified与不同输入hash，不能把普通元素JSON当UI证明。
2. utility registry + 专用 table export/import，两个实际 guest闭包组合、冻结缓存、own-plugin整组排除与 fragment；不先开放任意 JSON函数输入。
3. host assembly/proof + P capability route + current Q guard，接真 store/continuation/held reply、实际 model HTTP固定端点/预算和 source cancel。
4. 原callback剥离、children私有graph manifest/输出重接、严格transparent fragment全部walker、candidate释放、IPC/runtime/client崩溃与config reload清理；再接全部现有桌面site和author例子。
5. 双静态终审及真实 Guest/React/Electron/隔离性能/受控广域后更新交付账本；不会以 foundation pass冒称已完整上线。

必须保留的反例：

- 普通 ModJson/public metadata猜函数/table ID、旧 assembly同名插件、错误 P runtime/另一 Q request，SDK实际调用0；consumer不能借resolver更高cap，resolver不能借consumer写租约或person。
- 两个 wrappers真实调用；全自身组含wildcard/matcher跳过；读表same object但构造副作用每draw重做；无hook/noMods不开隐式guest；source/config reload释放旧闭包。
- 非函数表/throw下游 fallback一次；异步constructor、循环/超深/大量handles拒绝且旧frame健康；nestedpeer不能每次重置50ms，不能泵unrelated job。
- 定义P SDK真实store origin=P；原callback实际press origin=Q。same-key替换callback不执行，foreign callback不授予。foreign props.onPress===undefined，直接/迟到调用都不能执行Q callback或任何Q SDK。
- held SDK在UI正常返回后实际完成一次；迟到reply后的continuation仍P。group/draw/Ask R1→R2/绑定替换/revoke→regrant后晚store/model/fs/UI为0，绝不借最新owner。
- deferred `store.get().then(store.set)` 与配置 apply同时发生：首 reply/then/第二 SDK/实际 finally 全程没有零占用窗口，正常完整写一次后才 swap；revoke 在首 reply 前或 then admission 前，晚第二 SDK 为0，真实活动保留到finally。新 draw使用新receipt，旧held branch不能借它恢复。
- actualHost Promise忽略cancel后活动仍到finally；旧UI无回填、无重放。source/保护拒绝不触发constructor retry或Client fault；model默认和explicit同名不同端点取实际ref。
- protection后树/refs/Client模块变造、scope不足、Ask遮蔽、非法schema输入与首帧失败，无raw出口。正常text/tool formatting/批准/preview/键盘和唯一原生问答控件真实保留。

结论：现有进程模型和实际同步QuickJS API提供可适配路线，尚无不可实现的框架限制证据。直接callback剥离已由实际原版qualified6项确认，跨runtime foundation三个assertions已通过。两位独立方案评审已通过；本阶段仍在实现与实际运行验证中，方案通过不代表Stage21已最终验收。
