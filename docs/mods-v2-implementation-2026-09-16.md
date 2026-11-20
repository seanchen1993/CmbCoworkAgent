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
本批之后的“模型工具入口”补齐了正常模型调用的 v2 hook。`tool.register` 和 MCP SDK 仍待实现。
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
定向 ESLint 0 错误，ChatContainer 保留 29 条已有告警，E2E 测试有 1 条导入格式告警；斜杠命令、goal 路由与提交锁
三个 standalone 套件通过。全量 Vitest 3263 项：3226 通过、32 失败、5 跳过。
26 个失败与项目读取批基线同名同因；额外的 Git/迁移 5 项在单 worker 复跑中通过。
浏览器录制用例第一次复跑仍失败，进一步单独运行该用例通过（726 ms）。
这些结果不能改写为全量全绿。报告 `vitest-tool-full.json`、`tool-failure-comparison.json`、
`tool-flake-rerun.json`、`tool-browser-detail.txt`、`tool-e2e-final.txt` 均保留。

## 文本模型 SDK（2026-09-17）

`$.model.complete({model,prompt,system?,maxTokens?})` 通过现有模型注册表和客户端发起
一次无历史、无工具的文本请求，返回字符串；`model.complete` 进入同一操作 hook 链。
插件可以本地返回、拒绝或多次 next；每个实际请求单独记账。示例 `/claw-ask` 使用已配置
默认模型，明确模型名找不到时不会回退到其他模型。主会话流和 `model.fork/classify` 未包含在本批。

批准能力增加模型调用，宿主版本摘要升级到 v8，旧授权不能自动取得新能力。
模型密钥和端点只在宿主；插件参数限制、最终模型解析、项目/授权复核、策略准入、
完整回复保护、取消、60 秒时限和并发限制均在宿主执行。每插件每项目一分钟的调用次数
与预留输出预算写入执行记录；重载与重启不能重置预算。不确定的请求不自动重试。
控制数据库增量升到 schema 6，仅新增模型用量字段；备份、原状态、授权和执行事实保留。
服务未提供 Token 用量时保持未知，UI 不显示成零用量。日志/记录不保存提示词原文或密钥。

检视发现原客户端的首字节重试控制器在收到响应头后解绑取消信号；上层停止等待时，
HTTP 流可能仍存在。模型 SDK 的响应体现在通过带取消信号的流连接到客户端，取消会传到
底层连接。真实本地 HTTP 测试检查服务端关闭事件，不能只依据 SDK Promise 拒绝判定成功。
保持主代理与压缩原有调用路径；压缩协议回归 8 项通过。

同一模型操作夹具在官方 2.1.273 `plugin test` 通过，累计 31 个对照场景。
实际 Electron E2E 26 组通过：新增的两组使用本地 HTTP 服务，经过生产模型设置、
IPC、QuickJS、模型客户端、输出保护、执行记录和 UI；取消后服务端连接关闭，调用未重试。
截图 `output/mods-validation/e2e/function-model.png` 已检视。它不证明真实远端模型可用。
Node/Web 类型检查通过。专项首轮 275 项中出现 3 个失败：模型客户端首次被 Vitest
转换的耗时进入请求用例时限，随后影响取消用例；并发负载下另一个 Pane VM 触及原有预算。
把测试模块转换移到准备阶段后改用单 worker 复核，生产执行预算没有放宽。
最终 Mods 专项 275/275，跨进程 32 项通过，卸载后所有运行时和待处理计数归零。
两层 hook P50 6.40 ms、P95 7.93 ms；Client P95 5.69 ms，含 SQLite 的 Pane P95 11.54 ms。
运行时 ABBA 对照每侧 900 次，P50 增幅 1.80%、P95 增幅 4.94%；两侧运行时产物摘要
相同，因此这只是运行时噪声对照，不能证明新增模型请求或完整应用性能已通过门禁。
最终 Node/Web 类型检查通过；除既有 `runtime.ts` 外的本批 TypeScript 文件定向 lint
为 0 错误、0 告警。`runtime.ts` 原有 `subagent: any` 仍被 ESLint 报错，未隐瞒或全文件禁用规则。
报告 `model-first-failure.txt`、`model-mods-first-failure.txt`、`model-narrow.txt`、
`model-e2e.txt`、`model-types-final.txt`、`model-mods.txt`、`model-process.txt`、
`model-performance.txt`、`model-lint-final.txt`、`claude-model-sdk.txt` 保留原始证据。

本批全量 Vitest 3279 项：3247 通过、27 失败、5 跳过。26 个失败与项目读取批基线
同名同因（socket 路径仅临时 UUID 不同）；额外的浏览器录制超时用例单独复跑通过，713 ms。
完整回归仍非全绿，报告为 `vitest-model-full.json`、`model-failure-comparison.json` 和
`model-browser-rerun.json`，未删改原始失败结果。
独立脚本回归共 81 个套件，73 通过、8 失败：7 个断言失败与既有基线同名同因，
工作流 worktree 套件仍在 180 秒截止时间后被终止；原先失败的本地沙箱隔离套件本轮通过。
逐项证据保存在 `model-standalone-results.json`、`model-standalone-comparison.json` 及
`model-standalone/` 日志目录。原有 lint 错误也通过 HEAD 源码复核，见
`model-runtime-baseline-lint.txt`。

## 模型工具入口（2026-09-17）

正常模型发起的工具调用已接入 v2 `tool.call`，并保留原生及 MCP 适配器的实际执行路径。
SDK 调用不重复进入外层模型 hook。输入改写、拒绝、本地结果、显式多次 next、结果 ref 和
隐藏 context 已落实。每次实际执行有独立审计身份；重写结果保留真实错误与 LangGraph
调度信息，后置异常不重放副作用。模型 hook 内嵌套 SDK 读取不等待自身租约，不能获得用户写权限。

`context` 随工具消息的内部 metadata 保留到下一次模型请求，只作为模型上下文附加，
不出现在工具正文；下一轮用户消息或模型回复后停止附加。多个工具的上下文有总量上限。
新增 `/claw-tool-hooks on|off` 示例演示真实读取路径改写与拒绝。宿主摘要升至 v9，必须重新批准。

检视修复了原生参数与 `tool/agentId/tool_use_id` 重名时被误删的问题；主代理没有子代理 ID 时，
也不能把同名原生参数误当宿主身份。回归分别覆盖主代理与子代理，固定身份字段的改写被拒绝。
同一模型工具夹具在官方 2.1.273 `plugin test` 通过，累计 32 个对照场景。
官方夹具证明来源、结果封装、多个 next、拒绝和异常恢复；真正的宿主 ref 映射与消息保护另有本地回归。

Electron E2E 28 组通过，新增两组通过本地 HTTP 服务驱动真实代理循环、原生工具、
QuickJS、持久执行记录与 React：实际文件读取被改写，隐藏上下文进入第二次 HTTP 请求，
拒绝场景没有原生执行记录。首轮失败是断言错误地把结构化 system 消息当纯字符串；
第二轮失败是测试服务复用回复 ID，导致检查点消息被覆盖。修正夹具后两组通过；
原始日志、截图、结构化协议摘要及诊断检查点保留，不把这两次失败解释为功能已成功。
最终代码复跑还发现已有的启动覆盖竞态：测试过早注册 `open-login-page`，生产随后重复注册，
主窗口未创建。测试现等待主窗口后再替换离线登录行为；生产启动逻辑未修改。
对应失败报告与主进程日志为 `model-tools-e2e-restart-race.*` 和
`model-tools-e2e-restart-main.log`。
证据位于 `output/mods-v2-validation/model-tools-*` 和
`output/mods-validation/e2e/function-model-tool.png`。

最终 Mods 专项 289/289 通过，跨进程 33 项通过，Node/Web 类型检查通过。
跨进程新增工具入口测量：20 次预热后 100 次，每次两个显式 next，P50 2.90 ms、P95 3.68 ms。
该测量的工具核心是桩，不含原生 I/O、模型网络与内容保护，不能代替完整应用性能。
两层普通 hook P95 5.67 ms；Pane P95 9.80 ms；Client P95 3.62 ms；卸载后各待处理计数归零。
首轮通过的 E2E 中关闭 Mods 的真实读取 p95 从 2.523 ms 到 2.660 ms，增加 5.43%，超过设计的
5% 目标；本批不据此宣布完整性能门禁通过。原始报告保留，最终复跑另行列出。

最终 E2E 再次 28 组通过，正常构建已经恢复；测试入口不留在普通构建输出中。
该轮关闭 Mods 的真实读取 p95：基线 2.664 ms，关闭后 2.661 ms（-0.12%）。
启动竞态失败那轮的有效前段测量为 +1.48%；首轮 +5.43% 同样保留，不能只选最好的一轮。
这些测量尚不覆盖设计要求的全部轮次、完整模型路径与两小时压力测试。
报告 `model-tools-e2e-final.txt`、`model-tools-e2e-first-success.json`、
`model-tools-e2e-restart-race.json` 与 `output/mods-validation/e2e/result.json`。

全量 Vitest 3292 项：3260 通过、27 失败、5 跳过。26 个失败与既有基线同名同因，
另一个是上述主代理同名参数回归在修复前加载的适配器上失败；最终专项已经覆盖并通过。
全量记录不回写成全绿。证据：`vitest-model-tools-full.json`、
`model-tools-failure-comparison.json`、`model-tools-mods-final.txt`、
`model-tools-types-final.txt`、`model-tools-process-final.txt`、`claude-model-tools.txt`。

最终代码的完整 Vitest 复跑共 3293 项：3262 通过、26 失败、5 跳过。
26 个失败全部与既有基线同名同因；本批新增失败已消除。报告
`vitest-model-tools-full-final.json` 与 `model-tools-failure-comparison-final.json`。
仍不能把完整项目回归描述为全绿。

独立脚本回归 81 个套件：73 通过、8 失败；7 个断言失败与上一批基线同名同因，
工作流 worktree 套件再次在 180 秒截止后终止。完整失败对照与日志保存在
`model-tools-standalone-comparison.json`、`model-tools-standalone-results.json` 和
`model-tools-standalone/`。最终定向 ESLint 0 错误、0 告警，未扩大规则豁免。

## 自定义工具注册与发现（2026-09-17）

本批继续在 `C:\ai\CmbCoworkAgent-mods-v2` 的 `codex/mods-v2` 开发，父提交
`1ff9a16e`。原 UAT 工作目录未用于本批修改。实现 `$.tool.register/list`、会话内注册表、
同名替换、首个模型请求加载、SDK/模型调用共用处理器和撤权失效。函数工具名称为
`mcp__插件名__工具名`；模型请求携带协议 schema，调用仍进入实际 FunctionSession。
新示例 `/claw-brief`、`/claw-tools` 和 `project_brief` 提供可直接体验的使用方式。
宿主摘要升级到 v10，增加能力必须重新批准，不沿用旧授权。

与 2.1.273 公开类型和本地解包产物对照的范围是名称规则、默认 schema、注册返回值、
同名替换、`tool.register/list` 的 `{ value }` 操作封装及 `tool.call` 来源和结果语义。
同一注册样例通过官方 `plugin test`，累计 33 个对照场景；官方样例使用操作 mock，
不能据此声称上游真实会话的全部注册生命周期已经得到验证。本地另用真实 VM、
实际 AgentNode、utilityProcess 和 Electron 验证注册表及模型循环。

执行前的 schema 校验不做强转或填充，有限 JSON Schema 配置明确拒绝未知关键字。
对象枚举比较与 uniqueItems 比较也计入工作量预算，避免嵌套对象比较绕过限制。
注册表数量和元数据大小受限，失败替换保留原条目。每次自定义调用具有独立执行记录，
组织策略在处理器执行前准入，结果经过保护后发布；撤权、取消与失败不重放。
已执行但无法确认完成的处理器记为 unknown，已完成但撤权的结果记为发布被阻止。
记录不保存参数或输出原文。
最终检视补齐模型调用的真实 turnId，使自定义工具计入本轮持久执行汇总；独立命令
保留自己的函数工具轮次。专门回归检查模型轮次的 succeeded 计数，防止仅线程归属正确。

检视与首轮 E2E 找到两处接入问题并修正：动态工具输入异常发生在原生错误处理层外，
需要转换成模型可见的工具错误；AgentNode 拒绝在 wrapModelCall 中新建 Runnable 工具，
改为广告 JSON 协议定义并由已有 wrapToolCall 处理。新增真实 AgentNode 回归覆盖首轮
发现、参数错误、再次注册、子代理不广告及禁用移除。首轮 Electron 失败日志、截图和
完整应用日志保留在 `tool-registry-e2e-first-*`；它不是夹具误报。

当前差异仍明确保留：主助手开放自定义工具，受限子代理暂拒绝；SDK 的工具目录取自
最近一次模型请求，冷会话目录不可用；模型调用不能获得原生写权限；只支持文档列出的
JSON Schema 子集。`tool.check`、MCP SDK、Claude 原生参数映射及其他全量兼容项未在
本批冒充完成。详细限制见作者指南和兼容矩阵，`fullParity` 仍为 false。

专项最终 309/309 通过，Node/Web 类型检查、定向 ESLint 通过；Electron E2E 32 组通过，
普通构建恢复，测试入口不存在于输出。新增工具的成功调用截图
`output/mods-validation/e2e/function-registered-tool.png` 已检视。跨进程 34 项通过，
卸载后的 runtimes/frames/replies/pending/calls 均为 0。注册回声工具预热 20 次、
测量 100 次：P50 0.956 ms，P95 1.386 ms，不包含数据库、I/O 和内容保护。

完整性能门禁仍未通过。两轮 Electron 测得关闭 Mods 的实际读取 P95 增幅分别为
11.09% 和 12.37%，高于 5% 目标；最终轮从 2.545 ms 到 2.860 ms，读取中位数
从 1.279 ms 到 1.273 ms。关闭 Mods 的无 I/O 入口 P95 为 0.0062 ms；提前返回、
backend 包装及配置/项目键查询代码与父提交逐段摘要相同。它们不能解释或抹去真实读取
尾延迟的结果，不据此宣布没有回归。完整路径的尾延迟定位、更多对照轮次和两小时压力
测试仍是待验收项。证据：`tool-registry-disabled-source.json`、
`tool-registry-e2e-first-failure.json`、`output/mods-validation/e2e/result.json`。

全量 Vitest 3313 项：3282 通过、26 失败、5 跳过，26 个失败均与既有基线同名同因。
该全量运行开始后，最终检视又补了 turnId 归属，因此另跑包含该修正的 21 项定向回归，
全部通过；不把前一份全量报告改写为覆盖最后新增的测试。原始报告
`vitest-tool-registry-full-final.json`、`tool-registry-failure-comparison-final.json` 和
`tool-registry-turn-final.txt` 均保留。

独立脚本回归 81 个套件：73 通过、8 未通过；7 个断言失败与既有基线同名同因，
工作流 worktree 套件仍在 180 秒截止后终止。证据为
`tool-registry-standalone-results.json`、`tool-registry-standalone-comparison.json`
及 `tool-registry-standalone/` 日志目录。

最后一轮检视后复验：Node/Web 类型检查、定向 ESLint 0 错误/0 告警，Mods 专项
310/310、跨进程 34 项、Electron E2E 32 组全部通过。E2E 额外检查模型工具记录不是
独立命令的合成 turnId；构建后普通输出恢复，`out/main/mods-e2e.js` 不存在。
相应证据均为 `tool-registry-*-post-review.txt`。该轮实际读取 P95 从 2.648 ms 到
2.695 ms，增加 1.77%；前两轮的 11.09% 和 12.37% 仍保留，不能用最后一轮覆盖
多轮波动。第一次成功的完整测量另存 `tool-registry-e2e-first-success.json`。

## 宿主调用基础与嵌套模型输出隔离（2026-09-17）

基线 `aa97b145`，继续在 `C:\ai\CmbCoworkAgent-mods-v2` / `codex/mods-v2` 实施。
先复核实际权限入口，再补底层；本批没有开放一个仅凭静态工具名称返回 allow 的
`tool.check`。文件、命令和 MCP 的实际审批路径继续由宿主拥有。
详细约束及后续接入顺序见 [宿主调用基础复核](mods-v2-host-foundation-2026-09-17.md)。

`host-call.ts` 统一模型 SDK 和自定义工具的准入、预约、执行、结算和发布流程。
保留真实轮次、代理及父子调用编号，调用仍绑定自己的插件授权；作用域结束后不能
默认为 main 或重新获得写权限。队列通过宿主异步上下文绑定保留原始来源，并在启动时
复核调用方是否仍有效。原生 SDK 复用既有引擎，修正原先没有账本记录的父编号，让实际
执行与最终发布引用同一条记录；子代理不能借用 main 后端，审批返回后仍需复核作用域。

实际执行先结算，再处理用量、结果校验和发布。模型已返回但用量写入失败时保留执行
成功事实并阻断发布；失去回复保持 unknown，不自动重放。没有新增数据库迁移。
宿主修订提升到 `desktop-host-call-v11`，旧快照授权需重新批准。

截图检视发现并修复了一个实际输出通道问题：自定义工具内部的 `model.complete`
继承 LangChain 外层流回调，使原始 token 进入主聊天，尽管 SDK 返回值已经过滤。
现在整个内部流读取在独立 LangChain 上下文中执行，清除外层回调、graph 配置和 trace
继承，同时保留本工程的授权、取消及调用账本上下文。新增真实 HTTP / utilityProcess /
SQLite / React 场景，核对内部原文没有出现在父流事件、界面、持久消息和下次模型请求中。

最终验证（代码冻结后完成）：

| 检查 | 结果与证据 |
| --- | --- |
| 全仓 Vitest | 3337 项：3306 通过、26 失败、5 跳过；26 项均与既有基线同名、同原因，无新增失败。`vitest-host-foundation-full-final.json`、`host-foundation-failure-comparison-final.json` |
| Mods 相关测试 | 从上述完整报告核对 45 个文件、333/333 通过；覆盖队列身份、跨作用域拒绝、撤权、审批等待、用量写入失败及嵌套流观察者 |
| 独立回归脚本 | 81 项：73 通过、8 个既有问题；7 项失败原因相同，另 1 项仍为 workflow-worktree 的 180 秒超时。`host-foundation-standalone-comparison.json` |
| 跨进程 | 34/34 通过，runtimes/frames/replies/pending/calls 均归零。`host-foundation-process.txt` |
| Electron E2E | 33 组通过；新增自定义工具 → 原生读取 → 模型总结的完整父子调用与输出检查。`host-foundation-e2e-stream-final.txt`；普通构建已恢复，测试入口不存在 |
| 类型与规范 | Node/Web 类型检查通过，全部改动代码的 ESLint 为 0 错误/0 告警；`host-foundation-types-final.txt`、`host-foundation-lint.txt` |

验证日志默认位于 `output/mods-v2-validation/`，E2E JSON 和截图位于
`output/mods-validation/e2e/`。本批保留首轮夹具初始化顺序失败，以及截图发现问题前的
输出证据；最终报告对应的 17 个 TS/mjs 文件在冻结后没有变化。
中途校验曾遇到模块缓存与新断言不同步，已在冻结代码后完整重跑，最终结果以上表为准。

性能对照新增 `node tests/run-function-host-performance.mjs aa97b145`，从 Git 读取基线
供 bundler 使用，不切换工作树；采用四轮 ABBA/BAAB、每组预热，各版本累计 800 次。
真实注册工具宿主边界加 SQLite 的最终 P50 为 9.135 → 9.097 ms，P95 为
9.784 → 9.761 ms（-0.23%）；前一轮 P95 为 9.867 → 9.752 ms（-1.16%）。
基线与当前 bundle 哈希不同，两轮当前 bundle 哈希相同。该测量不包含 VM、策略进程、
工具 I/O 或模型服务。最终跨进程注册工具测量 P50 0.917 / P95 1.471 ms，同样不包含
SQLite 和输出过滤，不能与上述宿主测量相加当作完整应用数据。

实际读取的禁用路径三轮 P95 差异为 +2.69%、+5.39%、+0.05%，每轮每组预热 100 次、
采样 500 次并交替顺序。保留超过 5% 门槛的结果；整体验收尚未通过，仍需解释波动并完成
长时压力检查。局部性能对照通过不代表整套 Mods 的性能已经验收。

`tool.check`、MCP SDK、子代理工具绑定和跨插件权限委托仍未完成；本批交付的是已接入真实
执行链的基础修复，完整 Claude Mods 对齐状态仍为 false。

## MCP SDK 与真实连接生命周期（2026-09-17）

基线 `dde4af7c`，继续在 `codex/mods-v2` 实施。已加入 `$.mcp.call(server, tool, args?)`
及 `/claw-mcp` 示例，支持 operation Hook 改参、合成结果、拒绝和原始 MCP 结果封装。
冷启动普通项目命令直接使用生产 MCP 适配器，不需要先调用模型；保留真实提供者、连接代次、
最终参数审批、强制策略、输出过滤和单次执行记录。连接配置在审批期间删除或替换后不能
继续执行，断线不自动重试。自定义工具里的并发 MCP 调用保留真实父轮次，并串行持有绑定。

宿主修订升为 `desktop-mcp-call-v12`，旧摘要授权需重新批准，无数据库迁移或新增依赖。
上游 MCP operation fixture 在真实 Claude Code 2.1.273 中 3/3 通过，累计契约证据 36 项。
全仓 Vitest 为 3354 项：3323 通过、26 个同名同原因的既有失败、5 跳过；独立回归 81 项中
73 通过、8 个既有问题。跨进程 35 项、Electron E2E 37 组以及 Node/Web 类型检查通过；
改动代码 ESLint 无新增问题，保留已核对基线的 1 个显式 any 问题。详细验收与性能证据见
[MCP SDK 实施复核](mods-v2-mcp-sdk-2026-09-17.md)。

本工程仍保留 MCP 的强制审批差异 D01；`tool.check`、子代理绑定和跨插件授权委托没有开放。
最终等价落账对照 P95 增加 6.42%（0.675 ms），禁用路径多轮也出现超过 5% 的波动，
整体性能验收和长时压力仍未完成。完整对齐状态保持 false。

## 纯权限查询与真实执行准入（2026-09-17）

从 `2002fe64` 继续实现 `$.tool.check`、实际 native/MCP/registered 权限 Hook、保护后的
审批与拒绝理由，以及原生绑定的轮次/实例失效。查询不执行工具，不弹审批，不创建执行记录；
实际调用仍执行宿主最终约束。审批前失败的账本改为有宿主证据的 not_started，丢失回复仍为
unknown。宿主修订为 `desktop-tool-permission-v13`，旧摘要需要重新批准。

完整 Vitest 3381 项，3350 通过、26 个同名同因的基线失败、5 跳过。最后检视增加注册工具
拒绝到模型工具错误的映射，其后 51 项专项和 41 组真实 Electron E2E 全部通过；跨进程
37 项通过。81 个独立套件中 73 通过，修正旧源码截取标记后，剩余 8 个问题与基线一致。
类型检查和改动代码规范检查完成。详细证据、源码截取与发送时机的失败留存，见
[权限批复核](mods-v2-tool-permission-2026-09-17.md)。

相同 MCP SDK 的宿主性能对照 P95 为 11.051 → 10.976 ms（−0.67%），最终实际读取的
禁用路径 P95 变化 −2.93%。两小时压力、完整安装包和生产服务验收仍未完成。
整体对齐仍为 false，继续按 [代理权限基础设计](mods-v2-agent-authority-design-2026-09-17.md)
补真实范围与生命周期，不能靠取消 main-only 检查开放子代理。

## MCP 工具入口与运行作用域（2026-09-17）

从 `721f51af` 补齐命名 `mcp.call` 到 `tool.call` Hook 的真实路径，开放直接使用实际
scoped/canonical 名称的 MCP 工具调用，权限查询共用运行时作用域。解析与执行分开持有
临时绑定，避免 Hook 内调用原生工具时形成等待循环；执行仍复核提供者/schema/连接代次。
固定 Claude Code 2.1.273 的 Ecr → JZ 反编译调用链作为静态证据，不增加上游真实测试计数。

宿主修订 v14。专项 353 项、Electron E2E 42 组、跨进程 37 项通过；81 个独立套件
73 通过、8 个基线问题。单 worker 全仓 3392 项中 3359 通过、28 失败、5 跳过；其中
26 项同名同因，另外两项独立复跑通过，原始全仓失败报告保留。没有声明全仓全绿。
Node/Web 类型检查及新增代码规范检查完成。宿主 MCP 转发性能 P95 增加 2.58%，
本轮实际读取禁用路径 P95 增加 2.14%；整体压力验收未完成。
详细证据与限制见 [MCP 工具入口对齐](mods-v2-mcp-tool-routing-2026-09-17.md)。

## 执行目录与宿主权限基础（2026-09-17）

从 `ba02fc60` 修复原项目授权域与实际工作树目录的混用。文件 SDK、session.cwd 和
LocalSandbox 现在使用实际执行目录，授权与审计继续归属原项目；文件 SDK 复用后端
路径查询，在读取和发布边界复核绑定。原生/MCP/注册工具执行以及模型目录接入 runtime
禁用清单，构造时传入只读属性。旧 Mod dispatch 移除未知子代理到 main 的后端回退。

宿主修订 v15。完整 Vitest 3409 项中 3378 通过、26 个同名同因的基线失败、5 跳过；
全部 370 个 Mods 专项、43 组 Electron E2E、37 项跨进程检查、Node/Web 类型检查通过。
新增代码规范检查无新增问题。宿主 MCP 转发链 P95 增加 2.28%，实际读取禁用路径
P95 增加 4.10%；整体性能验收未完成。详细记录见
[运行目录与宿主权限基础](mods-v2-runtime-authority-2026-09-17.md)。

真实共享子代理绑定尚未开放；下一阶段先处理私有实例身份、同 ID 替换和任务生命期，
不能通过删除 main-only 判断来宣称对齐。

## 私有代理实例与共享任务（2026-09-17）

从 `31de982c` 补齐真实 runtime 对象身份、同 ID 替换失效、父子级联取消、容量上限以及
排队时的实例校验。已知 deepagents 角色共享实际后端，并继承宿主禁用清单、执行目录和
只读约束；未知/自定义 opaque 代理不推测权限。子任务可调用注册工具、原生读取与文件 SDK，
账本保留真实 task → registered → native 关系。宿主修订为 v16。

检视和真实 E2E 发现并修复 task 被原生工具探针误拒，以及 Client 后台帧继承过期点击权限。
另补同线程换项目的旧入口检查、子目录释放、活跃绑定容量保护、自定义 general-purpose
不冒用内建权限及无 ToolCall ID 时的独立实例归因。

最后一轮 44 组 Electron E2E、37 项跨进程、Node/Web 类型检查通过。全仓 3426 项中
3394 通过、27 失败、5 跳过：26 个同名同因基线问题，另一个未改动的浏览器用例超时后
独立复跑通过；不声明全仓全绿。Mods 路径下 382 项全部通过。独立套件 81 项中
73 通过、8 个同原因基线问题，新增代码规范无新增问题。

实际实例权限的 MCP 宿主对照 P95 为 11.546 → 11.309 ms；最后一次真实读取禁用路径
P95 增加 11.80%，保留超标结果，整体性能门禁尚未完成。详细证据见
[代理实例实施复核](mods-v2-agent-instances-2026-09-17.md)。继续完成注册工具的 MCP
命名入口、完整冷工具目录及后续 B3–B8，不将共享 task 接入等同于完整代理 API。

## 命名 MCP 与注册工具调用（2026-09-17）

从 `236f4aef` 补齐 `$.mcp.call(server, tool)` 到真实注册工具的入口，沿用冻结 Claude
2.1.273 的候选名称、归一化和结果投影语义。注册检查同时保留已配置 MCP 服务的命名空间；
等待准入期间更换定义会拒绝旧调用，相同定义重复注册保持在途身份。共享子代理与跨插件
调用保留真实 caller/owner/parent，结果继续由生产发布边界保护。宿主修订为 v17。

最终全仓 Vitest 3440 项：3409 通过、26 个同名同原因的基线失败、5 跳过，无新增失败。
401 项专项、37 项跨进程、46 组 Electron E2E、Node/Web 类型检查通过。新增规范问题
已经修复，保留 runtime.ts 一个已核对的显式 any 基线问题。81 个独立套件中 73 通过，
8 个失败与基线同原因，未新增失败。
普通 Electron 构建已恢复，冷命令和运行中配置命名冲突均经过真实 UI 入口验证。

相同注册处理器的 direct tool.call 与 named mcp.call 交错性能对照已运行；最终实际读取
禁用路径 P95 增加 6.38%，超出 5% 目标，整体性能门禁仍未完成。详细数据、测量范围及
保留失败见 [注册工具 MCP 实施复核](mods-v2-registered-mcp-2026-09-17.md)。完整冷工具
目录、通用引擎工具 SDK 及后续 B3–B8 继续推进，完整对齐状态仍为 false。

## 真实工具目录与首次消息前查询（2026-09-17）

从 `51dbec50` 将目录来源提升为真实图装配：显式 tools 和 middleware.tools 在构造时即绑定
私有实例，已知共享子代理拥有自己的初始目录。普通桌面冷会话复用生产工厂与前台开关，
不创建模型、图、执行后端或调用许可。查询在关闭、实例替换和配置变化时失效，容量满时
不淘汰活跃目录。宿主修订为 v18。

示例 `/claw-tools` 在第一条普通消息前可用，默认显示工具摘要，带名称查看完整说明。
最终 47 组 Electron E2E 通过并恢复普通构建，核对了冷目录与首个真实模型请求的全量名称；
416 项专项、37 项跨进程及 Node/Web 类型检查通过。全仓 Vitest 3455 项：3424 通过、
26 个同名同原因基线失败、5 跳过；没有新增失败。81 个独立套件中 74 通过、7 个同原因
基线失败；此前 im-desktop-completion 失败本轮未重现，未归因于本批修复。最终规范复核无新增
问题，保留 1 个原有显式 any 与 4135 个原有格式告警。

最终真实读取禁用路径 P95 2.7439 → 2.4310 ms，首次 +3.80% 样本一并保留；no-op 1000
次 P95 8.6863 ms、pending 0。此前禁用路径超标与长时资源门禁仍未结清。详细数据与边界
见 [工具目录实施复核](mods-v2-tool-catalog-2026-09-17.md)。继续 B3–B8 的完整实现与验收。

## 后续集成与验收

### 主会话读取（2026-09-18）

从 `052f11c5` 接通 `session.model/messages/turns/repo/authorize` 与 `/claw-session`。
主图状态观察与冷检查点 Worker 使用同一公开消息投影，查询不构造模型或写入检查点；
Git 主工作树、URL userinfo、历史边界、并发预算、取消与实例替换均有回归。宿主修订 v19。

473 项 Mods、37 项跨进程、49 组 Electron E2E 通过；全仓 3487 项中 3456 通过、
26 个同名同原因基线失败、5 跳过，独立套件 74/81 通过且 7 个失败同基线。
最后只读路径/协作扫描/并发容量加固另经 38 项定向回归和 Node/Web 检查，未新增规范问题。
冻结 Claude 同源夹具新增 6 项通过，累计 45 项；不将夹具扩张为全产品对齐声明。

禁用读取首轮 P95 +22.15% 保留；隔离五轮每组 1000 次复测变化 −4.81% 至 +4.66%，
均在目标内，整体性能门禁仍待后续完成。详细结果与准确验证范围见
[真实会话读取](mods-v2-session-read-2026-09-18.md)。

### 桌面主轮次生命周期（2026-09-18）

从 `16029109` 接通 `turn.start/turn.complete/turn.abort` 与 `/claw-turn [abort]`。
主轮次观察实际图响应和已发布的部分回答，完成事件等待线程租约释放；取消连接到真实
控制器、前台结束通知与旧工具绑定清理。补齐图内 OpenAI 流的真实服务端模型名及响应体
取消传播，停止后可立即使用命令并继续聊天。宿主修订为 v20。

492 项 Mods、37 项跨进程、51 组 Electron E2E、Node/Web 检查通过。全仓 3509 项中
3478 通过、26 个同名同因基线失败、5 跳过；独立套件 74/81 通过，7 项与基线同因。
前三次 E2E 的元数据缺失、取消传播、前台与绑定清理失败均保留记录，第四次通过并恢复
普通构建。禁用读取 P95 −0.70%，no-op 1000 次 P95 8.8443 ms、pending 0。
34 个改动源码文件最终规范复核无新增问题；最后缩进修复的 TypeScript AST 完全一致。

冻结 Claude 同源夹具增加 4 项，累计 49 项；仅证明 mock 下层下的事件契约。
后续静态复核另发现同响应 ID 用量更新及缺失用量聚合的差异，已列入下一批修复。
后台入口、子代理完成、提供商拒绝、附加说明定位及 B3–B8 其他事项继续推进。
详细记录见 [真实轮次事件与停止链路](mods-v2-turn-lifecycle-2026-09-18.md)，不宣称完整对齐。

基础批 standalone 回归 81 项中 72 通过、9 失败；9 个失败与 v1 对照基线一致。
实际应用 UI E2E 的命令场景已接通；v2 真实远端模型与远端 MCP 服务联调、长时资源压力、最终安装包
及逐项兼容复核尚待后续集成完成后执行。不能把这些项记为通过。
