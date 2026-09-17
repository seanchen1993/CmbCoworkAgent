# Mods v2 实施与验证记录

分支 `codex/mods-v2`，从最新拉取的 UAT `18e2ea88` 新开，纳入 v1 的 `82bceb0c`。
目标是完成 v2 设计中的八批补齐，并以同一插件在 Claude Code 与 CMB 中的结果作对照。
本记录不把底层通过等同于产品全部可用；尚未完成项继续保留在兼容矩阵中。

## 2026-09-17：面板命令与删除会话清理

面板回调的 `$.command.run` 已接生产 `ModCommandQueue`，保留插件来源与发起注册跳过语义。
普通命令等待物理会话租约，immediate 查询可并行；原始 SDK 结果与任务文本投影分开。
命令与 UI 动作最多等待 120 秒，JS CPU/内存上限不变；取消、撤权、删除会话均向排队任务传播。
已开始任务仍保留原有 unknown 规则；SDK 不能在 command.run 内递归等待其他 command.run。

绘制和动作分开排队，进度可以在动作未结束时刷新。已接受动作的旧绘制句柄保留到调用结束，
新到达的旧绘制动作仍拒绝。用户关闭会取消未完成动作；插件主动关闭自身不误杀本次回调。
会话删除接入生产线程删除路径，释放函数运行时池；新实例使用独立代次，旧描述符不能复用。

随包 `/claw-board` 新增“查看项目文件”。首轮 E2E 捕获示例误传 `.` 导致读取目录的问题，
修正为无参数的列目录调用，并增加真实文件系统回归；失败报告保留，不覆盖为成功。
专项回归 239 项通过；之后新增的示例回归与相关定向用例 20/20 通过。
Node/Web 类型检查通过；Electron E2E 重跑 **21/21 通过**，截图已目视确认。
跨进程 **29 项通过**，真实 SQLite 面板 20 次预热、100 次测量 P50 **8.25 ms**、P95 **9.12 ms**；
普通双层 hook P95 **5.43 ms**，文件命令 P95 **17.69 ms**。卸载后资源计数全部为零。
这些是本路径回检，不代表全应用 5% 门禁或完整上游兼容已完成。
报告：`output/mods-v2-validation/command-pane-{mods,final-narrow,types,e2e,process}.txt`。

## 已接入的交互 Pane 子集

`/claw-board` 通过标准 `hooks.modules` + TSX 打开“我的 Claw”：可以重复点击计数、
输入并保存项目备注、选择面板视图，关闭后重新打开。状态使用已有真实控制库，跨应用重启保存；
面板实例与模块闭包仍归属会话，应用重启后需重新打开。React 只解释校验后的数据树。

- `ui.open/close` 走操作事件链；`ui.render/press/input/select` 接入桌面 Pane。
  `ui.resolve` 同步返回七种内置元素的冻结构造器表；`ui.invalidate("ui.render")` 为 void，
  宿主合并重绘通知。按钮回调留在隔离 VM，点击通过所属插件、绘制代次、元素与 intent 核验。
- 重复点击可反复执行，重复 IPC intent 只执行一次；旧绘制、关闭、撤权及进程替换后拒绝旧句柄。
  新绘制释放旧回调；260 次重绘的回归验证不耗尽句柄池。树、面板、调用、intent 均有上限。
- SDK 按异步延续传递调用身份；next 仍绑定原分发。旧异步延续不会在后续点击时重新获权。
  async/await 与异步生成器在加载时下降为 Promise 延续；16 项与 Node AsyncLocalStorage 对照，
  包括并发、thenable、异地 resolve、finally、生成器、取消后延续及重复 resolve。
- 检视修复：整个 Pane 快照（包括标题）必须经过输出保护；构造器回调只能属于当前插件，
  或来自本次 next 下游树，不能猜测其他插件的 handle；属性、URL、控制字符与选择值均校验。
- 官方隔离 2.1.273 新增 3 项通过：open/close 的 void 操作、桌面元素树与回调句柄、跨次 hook
  使用捕获 SDK 的闭包。连同前批为 28 项上游对照。官方静态扫描禁止给 `$` 本身赋别名，
  所以对照使用 `saved = () => $.session.id()`；这不是直接保存 `$` 对象的兼容承诺。

本批专项回归 230/230；实际 Electron UI E2E 为 20 组通过，包括保存、重复点击、关闭重开、
旧绘制拒绝、页面重载、真实应用重启后的状态与撤权。截图
`output/mods-validation/e2e/function-pane.png` 已目视检视。测试完成后恢复普通构建入口。
首次跨进程 29 项通过；普通双层 hook 的 100 次测量 P50 4.91 ms、P95 6.85 ms，
文件命令 P50 16.60 ms、P95 19.26 ms。新增面板压力路径为 20 次预热 + 100 次绘制/点击，
不把初版内存 store 的 5.98 ms P95 外推为数据库存储性能。随后改用真实 SQLite，
绘制加点击 P50 8.94 ms、P95 11.07 ms；29 项跨进程验证通过，卸载后 VM、frame、reply、
pending 与 call 均为零。报告 `panes-process-reviewed.txt`。

另外以 `76023d64` 的运行时源文件和当前工作树作 ABBA 交替对照，每版 900 个测量样本，
每个进程先预热 30 次。检视移除了无待处理通知时的一次多余 Promise await：
基线 P50/P95 5.152/7.542 ms，修改后 5.432/7.858 ms，分别增加 0.280/0.316 ms
（5.44%/4.19%）。中位数仍有额外上下文成本，不能宣称零退化或整应用 5% 门禁已通过。
可复现：`node tests/run-function-mods-performance.mjs 76023d64`；
对照按 git 读取基线源文件，不切换工作树，保存两个宿主 bundle 的 SHA-256。

**本批不等于 B5 或完整兼容完成。** 已开放的 4 项 UI SDK 为部分支持：仅 inline Pane、七种
元素及有限属性；其余 13 个位置、Client/Svg、diff Code、自定义构造器 hook、尺寸/焦点/快捷键/
滚动/hover/holdToasts 尚待接入。面板回调发起 command.run 仍拒绝，等待统一执行队列；
上游静态 SDK 用法扫描也尚未接入。本轮新增宿主能力使授权摘要版本提升，旧摘要需重新批准。
详见 [开发说明](mods-v2-authoring.md) 和兼容矩阵；不能把同名方法视作完整行为一致。

## 已落地的运行时基础

- 标准 `.claude-plugin/plugin.json`、`hooks/hooks.json` 的同步 `register(on, options)`
  加载与稳定文件快照；摘要包含源文件、清单、编译器和兼容版本。支持 TS/TSX 编译，
  拒绝越界路径、运行时动态导入和未提供的包依赖。
- QuickJS 常驻实例、多调用帧、独立取消、宿主能力回调、输入冻结、预算与迟到结果失效。
  生产 CLI 已走 Electron utilityProcess；主进程不执行插件源码。
- 普通事件链、多次 next、catch 恢复、next.to 层级与 trace；一条调用链固定插件快照。
- 拉取式流桥，区分可见 chunk 与生成器终值；慢消费者受背压限制，失败续传不重新请求模型。
- `openwork plugin check|inspect <directory>` 检查包、摘要及注册结果。
  当前明确返回 `scope: package-and-registration-check` 和 `authorized: false`；
  尚不是完整宿主 API 兼容检查，不授予插件权限。

边界：完整字段 schema、engine.create 能力提供、模型/工具接入、完整桌面面板协议与
完整开发工具链还未交付。117 个事件名称与 65 个成员的清单仅用于覆盖盘点。

## 已接入的桌面命令与会话

- 标准 `hooks.modules` 插件通过现有本地安装、ZIP 检查、示例安装和项目授权入口使用。
  安装只编译检查，不执行插件；授权后由隔离进程加载。也支持声明的自定义 hooks 路径和原生 v2 清单。
- `session.start`、命令注册/描述/执行和 9 个基础 SDK 方法接入生产会话。
  `/claw-info 备注` 等命令直接接收文本；模块闭包保留到会话运行时销毁。
- `immediate: true` 查询不等待模型执行租约；普通命令仍进入原有 FIFO 写通道。
  当前基础 SDK 不包含外部写操作，后续能力必须继续在宿主执行路径校验权限与调度。
  授权摘要包含宿主接口修订号，新增能力必须更新该修订号，使旧授权不能静默获得新权限。
- 输出经过现有策略；撤销、禁用、重授权和进程崩溃均使旧描述符失效，禁止重放中断的命令。
- 隐藏命令不显示在补全菜单，但保留按完整名称执行；页面重载不会重建主进程中的会话实例。

用法和准确边界见 [函数插件开发说明](mods-v2-authoring.md)。此批并未完成 B3/B4 的全部范围。

## 宿主 SDK：持久状态

继续补入 `store.get/set/delete/keys`，基础 SDK 从 9 项增加到 13 项。状态按项目及插件名
保存，跨源码重载和应用重启保留；宿主修订号更新使旧授权必须重新批准，防止静默增加能力。
控制库从 schema 4 增量升级到 5，v1 状态和原有执行事实保留，备份同时包含函数插件状态。

同一 `persistent-state` 夹具在官方 2.1.273 和 CMB 的真实存储后端通过，累计官方对照场景
为 23 个。覆盖未设置值、null、JSON 转换、插入顺序、hook 改写及非法数据拒绝。
额外单测验证配额回滚、跨项目隔离、授权源码更新后的状态保留、读取前保护和撤销时取消写入。
应用 E2E 增加真实主进程退出后重启：授权与备注仍在，闭包计数重置，旧运行时描述符拒绝，
累计 17 组场景通过，截图 `output/mods-validation/e2e/function-restart.png` 已检查。

这一批专项回归 `npm run test:mods` 为 186/186；Node/Web 类型检查和定向 lint 通过。
状态总量 4 MiB，但仍受单次 1 MiB 的传输限制；键名和键数量也有明确资源上限。
这类限制与项目隔离已写入使用文档，不能把它们隐去并宣称任意上游插件完全兼容。

存储性能回检使用实际磁盘 SQLite WAL/FULL 事务，已有约 3 MiB 状态，50 次预热后测 1000 次
小键更新并立即读取。配额检查从“把所有值读入 JS 后计数”改为 SQLite 内聚合，P50 从
22.93 ms 降为 6.98 ms，P95 从 41.91 ms 降为 7.61 ms；两组保留相同事务、配额与工作量。
这是本机存储路径测量，不代表包含 VM、策略和 UI 的完整命令延迟。
可复现：`npx tsx tests/mods-function-state.perf.ts current`；前后报告位于忽略目录
`output/mods-v2-validation/state-perf-*.json`。

## 宿主 SDK：项目文件读取与命令调度语义

增加 `fs.read/list/exists/stat`，生产 SDK 为 17 项。所有真实读取按授权项目检查路径，
复用宿主稳定文件句柄；磁盘结果在交给可选 hook 之前执行内容保护。授权修订号再次更新，
旧授权不会自动取得读文件权限。示例 `/claw-files [文件路径]` 可列目录或读取文本。
与 Claude 的宿主可达路径、4 MiB 上限相比，这一授权限定项目内只读、512 KiB 单文件、
1024 目录条目；具体差异已写入作者文档。

新增 `readonly-files` 与 `command-held` 两个原文件对照夹具，官方 2.1.273 `plugin test`
均通过，累计 25 个场景。前者验证路径在 hook 前绝对化、改写后再次解析和返回格式；后者
验证 `command.run` 内直接或通过另一 SDK hook 间接调用命令均拒绝。检视发现此前 CMB
允许嵌套命令，已经修正，并在生产会话和真实 utilityProcess 重跑同一模块。

真实隔离进程累计 28 项通过，销毁后 runtime/frame/reply/pending/call 计数全为零。
两层普通 hook 100 次热调用 P95 7.35 ms；含两项文件 hook 和五次真实磁盘操作的完整命令，
20 次预热后 100 次测量 P50 20.00 ms、P95 22.55 ms。这是小文件、本机无内容过滤配置
的路径测量，不是长期压力或所有保护策略的性能结论。

此批专项回归 195/195，Node/Web 类型检查与定向 lint 通过；真实应用 E2E 18 组通过，
包含输入框文件命令、过滤内容、拒绝越界及应用重启。截图检视发现失败原因被包装成通用码，
随后保留宿主错误类别，并为文件不存在、越界、超限和读取期间变化增加中文提示；
对应跨进程与 UI 断言纳入回归。

## 已验证的契约与原型

同一夹具位于 `tests/fixtures/mods-v2/conformance`。隔离安装官方
`@anthropic-ai/claude-code@2.1.273`，通过其 `cli-wrapper.cjs plugin test` 运行，
不替换用户日常 Claude 安装，也不调用实际模型或外部业务工具。

| 验证 | 结果 | 证明范围 |
| --- | --- | --- |
| Claude 2.1.273 原生 plugin test | 21/21 | 15 普通事件语义及 6 流式语义 |
| CMB 的同一插件源文件 | 21/21 | 同样的组合、短路、异常、重放、保留字段与流变换结果 |
| CMB v2 定向单测 | 46/46 | 包、VM、流、Client 隔离与模型边界原型 |
| 原有 Mods + v2 + 工具回归 | 153/153 | v1、v2 及有关工具路径的定向回归 |
| 真实 Electron utilityProcess | 24/24 | 上述 21 项，加并发取消、卸载清理、真实进程故障恢复 |
| 两层 hook 热调用，100 次 | P50 5.42 ms，P95 8.04 ms | 本机跨进程开销，非完整应用性能结论 |

跨进程测试卸载后：runtime/frame/reply/主进程待处理调用均为零，重载子进程 RSS 约 64 MiB。
可复现命令：`node tests/run-function-mods-process.mjs`；详细报告写入忽略目录
`output/mods-v2-validation/process/process-report.json`。

真实 LangChain `createAgent` + MemorySaver 原型证明：在 provider callback 之前接入流变换，
回调、消息流和 checkpoint 能同时得到改写文本。此测试用模拟模型，不证明真实多供应商、
工具参数片段、签名 thinking 或所有流出口已经接通。

最初 Client 原型只验证独立 VM；2026-09-17 已接入真实 React Pane，具体范围见下节。
这仍不能证明官方 diff 插件原文件可用。

第二批增加 `tests/fixtures/mods-v2/basic-session`：同一模块在官方 `plugin test` 和
CMB 生产 FunctionSession 上验证 SDK 操作返回、事件嵌套、注册结果及 void 值。
官方累计 22 个对照场景通过；隔离进程累计 26 项通过。新增协议检查后 v2 定向单测 68/68。
实际应用 E2E 已通过 16 组，包括标准插件授权、直接命令、运行中查询、页面重载保留状态与撤销；
并延续 v1 的真实文件、审批、受管策略和 stdio MCP 检查。这不证明 v2 已接通模型或 MCP SDK。

检视中发现并修复：函数插件被安装器漏认、设置页返回导航缺失可访问名称、SDK 操作误用普通
返回值、`command.register` 缺少返回对象、隐藏命令被移出执行表、自定义包路径及 v1/v2 路由错误。
SDK 操作必须返回 `{ value }` / `{ deny }`；调用 SDK 得到拆出的值。该规则已与恢复出的协议
检查器和真实 2.1.273 `plugin test` 双重核对，void 值跨进程传输也有单独回归。
另补上单个 VM 预算耗尽时的销毁通知：该实例的旧句柄失效，同进程其他实例继续可用。

## 与原设计相比已校正的规则

用户要求效果一致后，取消原设计 D02 中 v2 工具 next 一律最多一次的限制。
普通 hook 的前置异常跳过，后置异常保留最近下游结果；显式多次 next 是不同调用，
catch 的重复 next 重取结果。这与宿主最终权限校验及 v1 的单次执行规则分开实现。

Claude 2.1.273 的测试 SDK 外层流在实测中不暴露可用的 `.result`，夹具从 iterator 终值
检查答案；插件内部 `next(e).result` 正常可用，transform 夹具同时覆盖这一点。

## 本轮构建与全量回归

- `npm run build` 通过；实际构建产物执行 `node bin/cli.js plugin check` 通过。
- Node TypeScript 检查通过；新增源文件、测试和 CLI 的定向 ESLint 通过。
- `npm test` 的首次全量 Vitest 与构建并行，出现 69 项失败及超时；未忽略这些结果。
  改为四 worker 且不并行构建后复跑，3153 项中 3121 通过、27 失败、5 跳过。
  26 项失败名称与 v1 最终基线完全相同；新增的浏览器脚本超时单独复跑通过，
  该文件仅余已知 Windows 路径断言问题。完整测试仍非全绿。
- 全量记录写入 `output/mods-v2-validation/vitest-full.json`；最新 46 项 v2 定向测试
  在后续补入命令保留字段契约后独立通过。全量报告计数对应当时收集的测试快照。
- 命令接入批的 `npm run test:mods` 为 178/178；完整 Node/Web 类型检查通过。
  新增与修改的 Mods 文件定向 lint 通过；`ipc/plugins.ts` 保留原有格式告警。
  `plugin-inspect-zip.spec.ts` 通过，包含仅有函数 hooks 的 ZIP 与路径穿越拒绝。
- 本批全量 Vitest 为 3180 项：3148 通过、27 失败、5 跳过。26 个失败与 v1 基线同名同因；
  唯一额外的浏览器录制脚本用例单独复跑通过，该文件剩下原有的 Windows 路径断言失败。
  全量仍非全绿。报告：`output/mods-v2-validation/vitest-session-full.json`，逐项对照为
  `session-failure-comparison.json`，复跑为 `browser-session-rerun.json`。
- 持久状态批全量 Vitest 为 3188 项：3157 通过、26 失败、5 跳过。26 个失败均与 v1
  基线同名同因，前一批偶发的浏览器脚本用例本次通过；全量仍非全绿。
  报告为 `vitest-state-full.json`，逐项原因对照为 `state-failure-comparison.json`。
- 项目读取批全量 Vitest 为 3197 项：3166 通过、26 失败、5 跳过。失败与上一批同名同因，
  三个 Windows socket 错误只更换临时文件名；全量仍非全绿。报告为 `vitest-files-full.json`，
  原因对照为 `files-failure-comparison.json`。后续错误类别与提示修正另跑受影响的专项和 E2E。
- 面板批全量 Vitest 为 3232 项：3200 通过、27 失败、5 跳过。26 个失败与上一批同名同因，
  三个 socket 错误仍只更换临时文件名；额外一项是 Windows 后台控制器测试删除临时 exe
  时的 `EBUSY`。该文件随后单独复跑 9/9 通过。全量报告仍保留为失败，未改写成全绿；
  `vitest-panes-full.json`、`panes-failure-comparison.json`、`panes-background-rerun.json`。
  后续移除多余 await 的性能修正由专项与真实应用 E2E 回检。

## Client 组件集成（2026-09-17）

`<Client key module props>` 现在从批准快照加载独立 QuickJS VM，接入实际 Pane。
同一 key/module 在父面板重绘时保留状态；移除、关闭、撤权及会话删除均清理组件。
状态、尺寸、输入、选择、键盘、指针、计时器、消息端口已接通；`ui.message` 只进入所属
插件。示例 `/claw-client` 能本地计数、保存消息、显示宿主确认并保持父面板重绘后的状态。

检视补上三个生命周期边界：面板关闭时取消正在等待的宿主 hook；发布等待期间关闭面板
不再创建组件；外层 props 更新不会被延迟消息帧覆盖。组件生成的内容、消息和最终快照
经过适用输出策略。旧控件、卸载组件及伪造实例动作均拒绝。计时器积压合并，失败组件单独停止。

同一 Client 描述符夹具在官方 2.1.273 `plugin test` 通过，累计 29 个对照场景；官方测试
界面不提供完整 Client 交互驱动，未把自己的生命周期测试当作全部上游行为一致的证据。
同步组件绘制/回调、静态模块、资源限额和网格尺寸估算等边界见作者文档和兼容矩阵。

验证：Client 单测 10/10；完整 Node/Web 类型检查通过；定向 lint 0 错误、19 个已有
preload 格式告警。实际 Electron E2E 22 组通过，覆盖组件点击、宿主回传、父重绘保留
计数、输入/选择/键盘/时钟、尺寸、Escape 焦点返回以及关闭后旧动作拒绝。截图已人工检视。
其后补入的取消与默认 props 边界由专项和全量回归验证，未重新计为新的 E2E 场景。

最终跨进程 30 项通过；20 次预热后 100 次测量，Client 快照/点击/消息回传 P50 1.96 ms、
P95 3.31 ms；普通两层 hook P95 6.09 ms，含 SQLite 的 Pane 操作 P95 9.52 ms。
Client 消息存储使用内存夹具，这些数字不代表真实模型或完整应用开销。卸载后所有计数归零。
报告：`client-process-final.txt`、`client-e2e.txt`、`client-narrow.txt`、`client-types.txt`。

本批全量 Vitest 3253 项：3221 通过、27 失败、5 跳过。26 个失败与项目读取批基线同名；
额外的浏览器录制脚本用例随后单独复跑通过，剩下原有 Windows 上传路径断言失败。
完整回归仍非全绿；报告 `vitest-client-full.json`、`client-failure-comparison.json`、
`client-browser-rerun.json` 保留原始结果。

## 原生工具 SDK 与冷启动路由（2026-09-17）

`$.tool.call` 已接入宿主原生工具、最终参数审批、共享会话租约和持久执行记录。
插件可以拦截 SDK 发起的 `tool.call`、改写普通参数、拒绝或显式多次 next；宿主身份字段
不能由插件指定。用户命令或真实控件交互可请求写入，即时命令和后台回调不能获取写权限。
跨 utilityProcess 的回调保留宿主调用作用域，作用域结束后异步延续不能继续持有写权限。
普通项目冷会话按需创建原生工具上下文；过期上下文刷新，继承项目沙箱配置。

当前支持 CMB 原生工具名和参数，尚未把 Claude 的 Read/Bash 等名称与结果全部映射；
也尚未把正常模型发起的工具调用接入 v2 hook。`tool.register` 和 MCP SDK 仍待实现。
示例 `/claw-tool-write` 创建记录，`/claw-tool-read` 读取；原生 write_file 不覆盖已有文件。

检视与 E2E 发现并修复：冷启动命令表未加载时，直接命令可能误送给模型。
提交路径现在先从宿主核对命令表；查询失败明确报错。菜单缓存仅供展示，不能决定执行路由。
失败报告 `tool-e2e-cold-first-failure.txt` 和截图保留；另一次用例错误地复用创建目标，
宿主正确拒绝覆盖，测试现保留原文件并为冷启动创建提供独立目标。

同一工具 SDK 夹具在官方 2.1.273 `plugin test` 通过，累计 30 个对照场景。
官方 testing facade 实测保留测试传入的身份字段，与生产声明中“丢弃调用者指定身份”
有差异；因此该夹具只证明结果包装、来源和拒绝规则。身份保护由本工程回归覆盖，
不能把 testing facade 结果当作上游真实工具身份链的完整证明。

已通过的专项包括 Mods 257 项、工具与调度 11 项、冷启动路由/契约 33 项、跨进程 31 项。
完整 Node/Web 类型检查通过。跨进程工具夹具验证 AsyncLocalStorage 作用域；卸载后计数归零。
两层 hook P95 5.92 ms、Client P95 3.62 ms、含 SQLite 的 Pane P95 9.68 ms。
相对 Client 批的运行时 ABBA 对照，每侧 900 次：复跑 P50 增幅 2.61%、P95 增幅 3.61%；
首轮 P50 增幅 11.14%、P95 下降 17.20%，两轮原始报告均保留，不能据此宣称完整应用
性能已满足 5% 门禁。报告 `tool-process.txt`、`tool-performance.txt` 及
`tool-performance-first-comparison.txt`。

最终 Electron E2E 24 组通过；普通构建已恢复，测试入口未留在输出包中。
定向 ESLint 0 错误，ChatContainer 保留 30 条已有告警；斜杠命令、goal 路由与提交锁
三个 standalone 套件通过。全量 Vitest 3263 项：3226 通过、32 失败、5 跳过。
26 个失败与项目读取批基线同名同因；额外的 Git/迁移 5 项在单 worker 复跑中通过。
浏览器录制用例第一次复跑仍失败，进一步单独运行该用例通过（726 ms）。
这些结果不能改写为全量全绿。报告 `vitest-tool-full.json`、`tool-failure-comparison.json`、
`tool-flake-rerun.json`、`tool-browser-detail.txt`、`tool-e2e-final.txt` 均保留。

## 后续集成与验收

基础批 standalone 回归 81 项中 72 通过、9 失败；9 个失败与 v1 对照基线一致。
实际应用 UI E2E 的命令场景已接通；v2 真实模型与 MCP SDK、长时资源压力、最终安装包
及逐项兼容复核尚待后续集成完成后执行。不能把这些项记为通过。
