# 非媒体补齐、第三阶段与性能验收

状态（2026-11-02更新）：v96开发者工作台补齐和实际缺陷经双审修复，中等强度非作者回检通过；正式原生工作台、通用功能精确修改与组合恢复补验通过。第二代真实ZIP派生完成四阶段隔离试用、重打包及原入口导入，普通项目首阶段衔接受系统写入审批阻塞，整组退出1，未验证节点不写通过。整体Node/Web退出0，改动代码ESLint quiet错误0；首次全量失败文件已定向复验，原始全量失败及worker RPC异常保留，不称全量重跑全绿。最终性能仍在进行，本文不是整轮完成声明。

## 交付范围

前一轮按 [双审方案](mods-nonmedia-completion-and-phase3-plan-2026-11-01.md) 实施，宿主权限摘要升到 v95；本文下方的开发者工作台追加升到 v96。应用保持 2.0.0，旧确认不能自动取得后续新增能力。没有新增业务名分支，也没有替换项目创建、配置、需求管理或执行运行器。

固定官方 2.1.316 的 Core 清单含 85 个可调用方法及 2 个 plugin 只读字段。本机方法目录包含其中 82 个方法名称；缺少 audio.play/audio.speak/prompt.media 属于本轮排除项。**方法存在不代表底层完全等价**：终端 blit、托管身份、通知通道和遥测有明确条件；无生产者的生命周期和 classic metadata 仍未开放，不混入“全部已完成”统计。

用户范围见 [自定义说明](mods-user-customization-2026-11-01.md)，作者入口见 [开发者底座](mods-desktop-developer-foundation-2026-11-01.md)。

## 已验证的实际实现

| 能力 | 当前证据及边界 |
| --- | --- |
| 远程 MCP | 原生 SDK 的真实 HTTP/SSE 协议及本地 stdio；selected+digest、宿管认证、同源和重定向拒绝、无自动重放，真实 fetch/reader 取消回收；不确认时 unknown 占位阻止重连。独立 medium 8 文件92项组合回检含远程、stdio、UI/Pane。30秒整体握手及每响应/持续流8MiB明确有界 |
| 输入框 paint | 实际 renderer 授权回执、预 Hook text/revision CAS、来源分组、IME/编辑失效；virtualText 不进入真实草稿。实际 Guest 验证无 prompt.read 不泄漏正文 |
| 交互子任务 | exact intent/父运行实例/source/owned child；真实 peer inbox 入队。受控 provider 两次实际请求证明反馈进入下次模型上下文，不冒称商业模型验收 |
| 父子输入切换 | 生产 ChatContainer 组件验证三处异步准备窗口、原附件/技能完整 handoff、取消等待及旧菜单回调。父准备 lease 与可取消目标预占避免丢草稿和误发；组件夹具替换 backend/store/装饰组件，不等于完整 App/main 验收 |
| Placed 滚动 | 实际 Guest→同来源有效 requestId→离屏 Virtuoso 挂载→lease/generation 可见回执；未伪造 Placed scroll Hook |
| UI/Pane | 多行与 IME、字素安全中间截断、方向、样式 Button 和真实闭包、局部 hover/absolute、实际列测量及宽度/背景；Ask 全树拒绝 absolute，外层原控件保留 |
| 复制与原生输入 | 真实可信 Ctrl+C 分别选择 visible/整个截断 host，只复制全原文；ariaSnapshot 保留原文。实际 Client textarea 点击不再误发画布 pointerdown。medium 独立浏览器复跑通过 |
| 环境变量 | 实际 Node run/spawn 子进程读到设置，其他来源读不到，不改 host process.env；literal 声明、危险变量拒绝、删除/显式 env 优先。凭据词前缀及解释器注入键回归通过 |
| 通知/身份/诊断 | OS show/failed 适配器回执，短路不能伪造成功，设置关闭/撤权/失败/幂等清理；未人工确认 Windows 横幅。普通身份 deny；遥测为真实 Hook 与受保护有界本地 ring，无上游上传 |
| 作者底座 | 全部本机 SDK 方法及5个真实 VM helper 可以定向查询；UI 构造器、engine/ui 函数表重载进入同一隔离编译器。正常工具结果仍小于8K，不通过提高预算或每轮灌入全量类型解决 |
| 模块准入 | 按真实 entry/import 扫描、同包共享 VM 与授权、此前准入前缀的模块门禁；拒绝不加入运行链、engine/start/工具/页面。同步顶层/register 仍求值，不冒充恶意源码执行前扫描或同包内存隔离；独立复审通过 |
| 本机生命周期 | 真实 desktop owner 绑定/解绑与 roster，晚启动不新建 VM，结束共用原1.5秒短期限；普通 idle runtime 在无保留资源和未知调用时才做 owned workflow 回收前只读观察。原 dirty/ownership/删除恢复不变；独立复审通过 |

## 独立回检及修复

产品编辑前 core/UI 两审通过。修复后新增三组 medium 回检：

1. runtime：发现危险环境键拒绝表达式的前缀漏洞，补凭据词和解释器注入键后通过；最终通知/作者补充27项通过。
2. UX：发现父提交准备竞态 P1 与陈旧菜单 P2，补准备 lease、原子预占和回调硬挡。独立真实 ChatContainer 五场景与 lease 5项通过，证据 `output/mods-chatcontainer-input-target-browser/1793515650311`。
3. remote/UI：发现截断原文可访问性与复制、Client textarea pointer 排除问题；全部修复。独立原语浏览器最新证据 `C:\Users\87624\AppData\Local\Temp\mods-nonmedia-primitives-dFHOa3`，无剩余产品阻断。

最终范围回检随后确认三个 P2：模块准入、真实桌面绑定和 owned 工作树回收有现成生产者而尚未接入，完整补充方案经两审通过后实施。实现与新 medium 回检进一步关闭可变 handler/recovery handle 隐藏 SDK 使用，以及旧 process 资源关闭通道绕过只读限制的问题。工作树观察使用主进程 lease，只在无资源/未知调用时派发；等待超时不解除保护，实际 host/dispatch 结算后才恢复。最终两组独立复审均通过。WorktreeCreate 路径接管与审批权限闭环等仍需专门契约，不能只用同名通知宣称等价。

复审曾推断 eval 可绕静态扫描并写文件；后核实 `FUNCTION_CODEGEN_GUARD` 在插件前已禁用 eval/Function，真实对照 RPC 为0，故撤回该“运行时绕过”推断。新增静态 unknown 只补声明准确性，保留普通数组循环、纯数据 descriptor、局部变量重名、稳定注册句柄与 Promise.catch；没有扩成全语言限制。

新增契约/作者查询39项组合通过，覆盖宿主固定 facts、输入限额、互斥准入结果、精准只读 SDK、真实 state helper 兼容及每个定向结果的预算；记录 `output/mods-v95-authoring-discovery-2026-11-01.log`。编译与声明通过不等于生产执行已验收。

最终中心联合回归33文件628/628通过，记录 `output/mods-v95-final-central-regression.log`；此后仅对 recovery handle 静态来源做增量收口，另行49/49通过，记录 `output/module-admission-recovery-handle-final.log`，不能把628写作该增量后的全量重跑。生命周期最终8文件86/86及跨进程专项5/5通过；真实 carrier 为生产 client/host-entry/QuickJS 加 Nodefork，后端保留流受控，未声称实际 OS SIGTERM 或完整 Electron 通过。

冻结后 Node/Web 类型检查退出0，56个改动 TS/JS 文件 ESLint quiet 退出0（未全量格式化既有文件）。`test:mods:continuity` 和六套 `test:mods:phase2:browser` 退出0，记录 `output/mods-v95-continuity-final.log`、`output/mods-v95-phase2-browser-final.log`。原 ProjectForm、Feature 开始/批准/重试/取消、Placed、MCP、子会话、paint、原语及实际 ChatContainer 均按既有流程回归。

## 当前源码与真实模型

旧 out 不作为本轮源码证明。测试专用候选保留 main/preload/utility/真实 nodeWorker 布局及资源，版本2.0.0。编译前固定完整输入清单与哈希；每次源读取、编译后以及启动/结束均核对，变化即拒绝。不会执行生产构建、打包或 Actions。

真实模型场景采用本机配置的真实服务，具体模型身份按实际配置记录，不把名为 claude 的配置当作 Anthropic。应用会话输入窗128K，输出上限8192另列；数字预算观察不存 prompt、端点或凭据。main-model/judge-model 的示例端点不能用于商业验收。

新源码 native smoke 通过：`output/phase3-source-smoke-a8d79b68`。main/preload/React/实际使用的 Worker、Mods/插件/作者 IPC 正常，23个真实 Worker 均编译到受核对候选，appPath 为隔离候选且版本2.0.0；不宣称逐一启动了所有 Worker。创造者/普通模式和创作面板往返后，父 textarea 实例和草稿保留。首次测试候选缺少 out/resources 策略镜像导致恢复态；按生产资源布局补齐后健康启动与关闭，不修改产品逻辑。

受控 desktop smoke 通过：`output/phase3-source-desktop-smoke-e9cd3185`。真实 Electron/native IPC/SQLite/QuickJS，8个实际导入授权 Mod、4个真实 Client Pane、24次顺序回执、3轮关闭/重载恢复，结束后无所属 utility/pane 残留。自然 heap 采样链实际执行，短测不符合两小时正式门槛。以上两份记录绑定当时15492cc9f工作区内容哈希，明确包含未提交改动，不冒充已提交版本。

追加实现冻结到 `53a3dcd84824141716ee5b2ae212220df0278006` 后，新 native source smoke 退出0：`output/phase3-source-smoke-62742779`。完整源码/资源和选定 driver 启动前后围栏通过，实际 appPath 为新候选、版本2.0.0，当前 main/preload/renderer/公开 IPC 健康，父 textarea 实例和未发送草稿保留，正常关闭。

同一产品源码的新 desktop smoke 退出0：`output/phase3-source-desktop-smoke-0396e9c9`。实际8个组件、4个 Client Pane、24次回执和3轮关闭/重载，结束时资源清理完成。短测明确 `qualified:false`，自然 heap 窗口不足，不能代替正式两小时长稳。受控原 Feature 到 completed、商业续验和正式性能分别记录。

广域回归648文件：632通过、9跳过、7失败，7225项通过、10失败、10跳过。失败包括旧导入入口/未开放接口断言，以及开发并行期间载入了旧作者声明或通知实现的模块。修复和同步断言后，**全部7个失败文件按冻结源码联合重跑94/94通过**，退出0，记录 `output/mods-nonmedia-final-failed-files-2026-11-01.log`。导入采用真实 parent 入口和服务，没有恢复旧 UI 或放宽断言。不能据此把最初整套命令写成全绿。

提交后 `npm run test:mods:continuity` 与 `npm run test:mods:phase2:browser` 均退出0：原项目创建、Feature 开始/批准/重试/取消以及 Placed、MCP、子会话、paint、UI 原语、真实 ChatContainer 组件检查通过。`npm run test:chat:performance` 的9个浏览器套件也全通过：400条混合高度消息拖动/前插不空屏，流式追加不增加导航几何读取，长消息无需 scrollHeight 读取，侧栏拖动期间 App 重渲染为0且释放时1次，解析缓存复用仍保留当前文件链接与复制回调。首次性能脚本因独立 esbuild 夹具未接真实 Worker loader 中断，接入现有 browserWorkerPlugin 后完整重跑通过；没有修改生产 Worker。记录 `output/mods-nonmedia-continuity-2026-11-01.log`、`output/mods-nonmedia-phase2-browser-2026-11-01.log`、`output/mods-nonmedia-chat-performance-browser-final-2026-11-01.log`。这些是实际组件/受控适配器回归，不等于商业模型或正式长稳。

受控原流程全链已通过：`output/phase3-source-original-feature-completion-9e71f921/journey/run-SUEGV1`，运行绑定53a3dcd源码及当次完整测试 driver 哈希，启动/结束围栏通过。原 ProjectForm→配置→Feature→真实 `nativeFeatureCommand`，随后 implementation→delivery→audit→completed；3个真实执行线程、3次 transitioned、3个原生 schema check 均通过。14个本地200请求驱动真实工具，实际读取 Skill、前序输出和写回文件；3次公开 one-shot 审批均核对原 pending 身份及私有声明路径，最终3个文件 SHA 与发送 payload 一致。0商业请求、0环境阻塞、正常关闭，不把受控 provider 当成商业模型。

该工具最初几次停在原 combobox 选择器、两种摘要混淆、multipart 文本展开及审批 DTO 字段假设；只修测试适配，未修改产品、放宽原生校验或审批。安装 identity 的 derivation digest 与 Host retained 完整包树 digest 分开核验，不用主目录 hash 代替依赖/投影后的 Host 快照。失败尝试记录保留，未到节点不算通过。

真实非 AutoBiz 项目续验 `output/phase3-source-project-82f854c6/journey/run-hL8qLO` 已用原真实模型生成的12个作者文件建立新试用、重新确认并执行，未复制配置或授权，也未重复生成源码。15个真实 HTTP 200 请求执行 collect→trace-review→deliver，3阶段原生校验通过，私有试用到 completed；普通项目入口仍需另行续验，不以私有试用替代。

ZIP 导出/原插件面板上传已经实际执行，后续身份核验发现测试混淆了两种合法包树：导出器会添加 `devclaw.package-report.json`，因此原安装 digest 与完整 ZIP/fresh 安装 digest 可以不同。新验证器逐文件保持原源码，严格核对唯一报告增量及其声明，再核对完整 ZIP 树与 fresh identity；18项回归及实际目录/ZIP只读核验通过。未删除报告或放宽源码一致性。首次 continuation `output/phase3-installed-continuation-e68c81fe` 的身份断言失败保留，后续使用已导入的新安装，不重复导出、删除或上传。

测试适配另修两个实际问题：当前 Playwright 的异步 `waitForFunction` 谓词不能用作 Node 异步状态轮询，改为显式逐次 await，保持按钮/上传仅执行一次；测试 relay 不再逐 Buffer 转 UTF-8，而在有界完整字节拼接后严格解码一次，逐字节中文/emoji、非法 UTF-8 和大小边界5项通过。没有修改生产流解码。旧尝试未保留逐块边界，不能把一次历史乱码确定归因给模型或产品。

这些续验适配及独立中等强度复核固定在 `e31d8ad1943b3c9981f0827f6e8cb7687c84b454`，产品源码仍与53a3dcd一致。14个测试文件的选定 TypeScript 检查退出0，27项窄回归通过，lint退出0。修复续验图片同名覆盖风险后，全部新证据写入独立 UUID 目录并核对旧材料哈希；这只能证明该保护开始后未改，不能回推历史同名截图一直未被覆盖。授权记录按实际候选版本及平台返回的确认边界描述，不宣称同范围的每次重启都发生新批准。

e31快照的普通项目续验 `output/phase3-installed-continuation-40326f37` 已完成：使用此前真实导入的新安装，沿原 ProjectForm 创建、配置、Feature、新来源确认与原生执行，6个真实 HTTP 请求均200；collect 原生 schema passed、实际 transitioned 到 trace-review。候选/driver/旧证据及产物完整性核对通过。下一阶段自动启动后按验收边界提交公开取消，返回 `cancel_requested`，停止终态仍未验证；额外末态截图20秒超时使脚本退出1，不能宣称该脚本全绿，也不为补图重跑已完成的模型节点。

AutoBiz 派生与装配候选验收 `output/phase3-source-autobiz-derived-9cdadcb0/journey/run-e4Fs7M` 退出0，绑定e31快照及完整 driver 哈希；33次真实请求均200。公开工具从原生插件派生，随后通过对话追加 audit 阶段及知识 stageTags 映射，最终 r6 候选与装配断言通过。此场景严格 runtime0，仅验证作者、编译和候选，不执行业务运行或交付。一次 `DEVELOPMENT_PLUGIN_MISSING`、两次反馈修复和一次命令审批拒绝均保留，不能称一轮生成即成功。

组合验收 `output/phase3-source-composition-dbd7f64f` 完成20个商业 HTTP 200 请求：真实作者生成 provider/consumer、安装组合，v1合法/非法输入各产生实际任务，同安装身份更新provider到v2后再次执行成功。最后主动撤权时，命令目录按真实权限先拒绝；旧测试却预期进入失败任务，导致脚本退出1。正向结果、撤权拒绝与测试断言错误分开记录；恢复只补原profile中的拒绝、保留输入、真实重新授权及执行，不重新生成组合。

非 AutoBiz 报告插件首代派生 `output/phase3-source-report-derived-eaf7e545/journey/run-Dggxy8` 已实际完成13次作者请求与13次三阶段试用请求（均200）、completed、ZIP导出及原面板fresh安装；普通项目创建前，测试编号 `LIVE` 加12位十六进制共16字，超过原界面15字限制，脚本退出1。首handoff和第二次派生因此尚未到达；保留首代结果，只对合法短编号、原表单衔接及以实际交付ZIP继续派生做续验。平台没有放宽原项目限制。

短编号及完整原表单参数前置校验冻结到 `ea44d360c53850e223eb900ddf8dd161a7c00e66` 后，首代报告插件续验 `output/phase3-installed-report-continuation-52c12dd6` 退出0：6个真实请求均200，原项目创建、配置、Feature、当前来源确认和首阶段原生执行/校验/衔接通过，created/handoff截图及完整性检查通过。没有重做首代作者、三阶段试用或ZIP；随后自动阶段只取得公开取消请求回执，停止终态不纳入通过范围。

待填写：真实作者从零/派生/调整其余场景、各商业场景普通项目衔接及未验证节点。Git/审批环境单列，不算平台失败，也不把未到达节点写成通过。

## 开发者工作台追加：v96

依据 [最终双审方案](mods-developer-workbench-foundation-plan-2026-11-01.md)，补齐软件开发真实宿主桥。两路medium先做producer审计，再评审具体方案，3项P1和2项P2写入方案后，二人确认无阻断才开发。复杂业务留在插件；原项目四个关键文件未修改，版本保持2.0.0。新增能力实际进入host revision及loader摘要，v95旧grant不能冷启动v96，新确认后仍沿原权限运行。

| 追加项 | 实际验证与边界 |
| --- | --- |
| 自家ZIP再次派生协议 | 共享严格v1非执行报告协议，producer/consumer两域摘要、完整refs、报告原字节SHA+身份pin及双读保持；未知资源/Hook/MCP仍拒。4套76/76通过，两位medium非作者通过，其中一位独立40/40及真实旧安装包只读验证通过。不把AdmZip单测当成真实原UI全链 |
| 原生代码观察 | 10项现有Java服务只读查询，异步有界快照、原文件策略、client/document/source围栏及未结算限额；诊断cached/versionUnknown。31项通过、非作者回检通过；无默认启动、下载或关闭服务，不宣称新增多语言后端 |
| 原生安全文件导航 | sender/来源/物理会话/TTL与原文件策略绑定；64KiB源文本、真实行列ACK、外IDE仅原生按钮且display未知；Windows空白/元字符路径保留内置预览。36项通过、1项Windows symlink环境跳过，真实浏览器8checks通过；非作者回检通过。App/preload已接，整体native链另验 |
| 工作区变化观察 | 既有watcher实际安装canonical根及dev/ino身份、6/16上限与失效通知；不start/scan，caller过滤、有界队列与cached poll重新授权。最终7套54/54通过；独立52项及最后两项只读增量回检通过，不将重复计数相加 |
| 原生能力状态与缓存 | main-only callerScopedState隔离授权过滤状态；poll核实际待返快照，历史代码结果重核每个文件位置；post-await重核caller/provider和原owner。core/旧授权4套59项通过，之后core/IPC/定向发现4套39项通过，存在重叠，不能相加作总数 |
| 通用示例与发现 | 新developer-workbench用公开协议组合任务、代码、导航、文件观察、Git/workflow和持久设置；5placement及命令有真实入口。5个服务状态逐行显示，开发信息默认不生成，主动展开才显示同批有界事实，不新增读取或授权。最终Guest/摘要/目录32项通过，作者审计、实际非作者回检及6文件SHA核对通过 |

整体类型初轮发现两处`const fail`未触发TypeScript控制流收窄和新增catalog返回union缺旧空数组字段，均保留实际运行时校验修正；最终Node/Web退出0。记录 `output/mods-workbench-v96-typecheck-node-final.log`、`output/mods-workbench-v96-typecheck-web.log`、`output/mods-workbench-v96-changed-lint.log`。全套 `npm test` 的实际结果另填，不能以窄回归代称全绿。

追加全量回归首次结果：1904个文件，1863通过、22失败、19跳过；19460项测试中19290通过、77失败、93跳过，并有一次Vitest worker `onTaskUpdate` RPC超时。`npm test` 因此退出1，后续 `&&` standalone链未执行，不能称全套通过。日志 `output/mods-workbench-v96-npm-test.log` 保留。

其中23项属于两处真实实现问题：编译包装新增模块元数据与静态显示证明器脱节17项；独立Surface的只读模块导出与严格模式入口清空冲突6项。前者补精确AST/module及缓存身份绑定，后者只给模块导出增加writable，不放宽共享JSX或注册权限，均先双审再改。另修普通RPC结束后的预览只读lease、旧preload接口缺失降级、5个真实服务状态的有界可见摘要，以及流式游标不读取完整文件历史的热点。

其余54项为测试夹具未跟上实际依赖、示例目录、原有导航、显示样式或Host项目分类；另3个suite初始化缺少原生事实模块读取的DB导出。夹具使用真实helper或明确拒绝越界的DB sentinel，保留原权限和失败清理断言。Host状态应为 `host-runtime` 且可用，不宣传旧看板命令；未知/不安全声明仍不可用。源码导入测试走现有“保存插件”与折叠开发者入口，不为测试改变产品导航。

集中复验首轮26文件572通过、4失败，继续修复瞬时游标提前执行getter、idle回收未先核外层authority两处实际断点，并保留已知busy的“尚未开始”提示及空assistant原可见语义。三项措施先双审再改，实际非作者回检通过。最终相关5文件191/191通过，真实native partial8/8通过（同文件其余79项本次过滤跳过，已在前次集中复验执行），原先失败项均已覆盖；几轮重叠数量不能相加。日志 `output/mods-workbench-v96-failed-files-recheck.log`、`output/mods-workbench-v96-last-boundaries.log`、`output/mods-workbench-native-partial-final.log`。

最终 `npm run typecheck` 退出0，见 `output/mods-workbench-v96-typecheck-release.log`。改动代码ESLint quiet错误0；严格warning0尝试报告原有CRLF/排版警告，未整文件重排旧代码。已改代码行尾统一LF，新增游标与小型测试正常格式化，不声称全仓库格式警告清零。

独立功能链补验：项目入口、创造者完整界面、使用体验及第二阶段浏览器四组退出0；插件ZIP/版本、作者预览/安装、虚拟文件/恢复、评估和Skill真实受控桥通过。ANSI有2464项浏览器对比通过；旧hotkey夹具缺生产Tailwind且仍假定RTL裁剪，改为编译实际index.css与组件候选，核真正visible尾部Range和完整aria后，剩余五个UI脚本全部退出0。保留真实几何/快捷键/焦点/配色断言，未改产品CSS。见 `output/mods-workbench-standalone-core-final.log`（首次UI夹具失败保留）、`output/mods-workbench-standalone-browser-final.log`、`output/mods-workbench-standalone-ui-production-css.log`。

市场推广另有 [双审产品规划](mods-workbench-market-product-plan-2026-11-01.md)，尚未开发或发布市场新功能。当前原生/真实模型四个最小续验和正式性能随后进行。

提交0c23446da后，当前源码的无模型原生补验发现测试导航仍走旧分类，首次记录 `output/phase3-source-developer-workbench-52cdc3d7/journey/run-hCwtYs` 退出1；未触达节点不算通过。仅测试导航调整提交为202637f69、64ce9aea4，并用真实CustomizeView与同名父聊天模式按钮反例回归，未改产品导航。

第二次原生补验 `output/phase3-source-developer-workbench-0dc15373/journey/run-xZKNqr` 仍退出1，0模型请求。真实ZIP上传、当前来源确认、五项简明状态、主动展开开发信息、Java未启动状态与设置保存通过；源码定位20秒未出现预览，后续工作区变更和Node检查尚未执行。只读数据库与生产序列化代码确认真实产品断点：main用数据库数字毫秒构造scopeKey，公开Thread经IPC成为Date，App直接JSON序列化为ISO字符串，严格scope比较因此不一致。修复方案经两位非作者评审：共享严格时间规范化、保留token与全部来源/会话/权限门禁，并补Date、数字、ISO及实际Host定位ACK回归；修复后需重新验收，不能用静态测试代替真实补验。

同次清理的 `MODS_SCOPE_CHANGED` 单独定位为测试传入原大小写目录，而原生返回的是canonical目录；严格expectedWorkspace校验在撤权前拒绝。只调整测试使用公开返回值，不放宽平台目录门禁。正常关闭与源码/driver结束围栏完成，清理拒绝不冒称撤权成功。

上述身份修复已实现并经中等强度非作者源码回检：main与App共用纯身份函数，Date、数据库数字和规范ISO缓存表示统一成有效毫秒；非法值停止预览，token逐字保留。App只增加独立editorBirth，不改变原PlatformWorkspace的scope。相关22项单测、真实Host浏览器14项检查通过，原DOM行列ACK、安全文本、旧preload降级、31秒已加载快照与草稿保留断言继续通过。记录 `output/native-editor-browser-4bedb543-8b5f-4f92-9dc8-0846007bcdfc`。这是修复回归证据，新的真实桌面补验仍待执行。

修复后的官方 `npm run typecheck`（Node和Web）退出0，记录 `output/mods-workbench-editor-birth-typecheck.log`；原生editor IPC两项回归、driver选定TypeScript检查及改动代码ESLint quiet均退出0。测试新增的canonical目录、失败现场快照和限时截图经非作者复核，未削弱原定位、模型零请求、进程结果及资源回收断言。

后续无模型原生记录 `output/phase3-source-developer-workbench-2b1ccf01/journey/run-jicjn5` 已真实显示安全源文件并取得行列回执，但测试将canonical大小写不同的同一Windows物理路径直接作字符串比较而退出1。第三次续验 `output/phase3-source-developer-workbench-99acda8e/journey/run-wuQ8iB` 同样通过定位、HTML纯文本及preview-loaded回执，随后测试普通命令传入`{}`，被原公开接口要求`{text:string}`拒绝。两次cleanup无失败，后续watch/Node仍未到达。仅测试修正物理路径平台比较、原审批cwd同类边界和空文本DTO；命令参数、二进制SHA、请求摘要与单次批准规则不放宽。后半公开API逐项核对原bridge/handler，未发现另一确定DTO差异，审计表为 `output/mods-workbench-native-public-api-audit-2026-11-01.md`。

现行使用指引另经双审纠正：11份当前指南统一真实设置分类、原ZIP安装入口、高级手动创作入口和“输出与面板”标签；普通聊天不因设置分类名而切为创造者模式。实际说明阅读器首次揭示三份指南和两条导览使用已不存在的试用按钮文案，改为生产按钮“确认并开始聊天试用”，保留原浏览器断言。相关5项单测、说明浏览器15项检查和三项真实任务预览均通过，记录 `output/mods-workbench-current-guide-unit.log`、`output/mods-workbench-current-guide-browser-final.log`、`output/mods-workbench-current-tour-browser.log`。首次指引检查失败保留在 `output/mods-workbench-current-guide-browser.log`；没有把聊天确认写成项目插件必经的额外按钮。

示例关闭竞争曾被误判为core漏取消。实际gate未释放时原生read signal已aborted；Guest取消先返回，原生await尚未结算。最终测试先等待实际取消信号，再释放gate，并限时硬核订阅0、stop计数、资源0且无批准；9项通过。没有为该误判修改Session信号传播。另行保留并验证真实owner和post-await撤权保护。

历史来源适配只引用旧artifact，不返回可启动entry，也不放宽当前candidate。8个测试文件的20项、selected语义类型和medium非作者回检通过；dirty工作区的recorded HEAD仅作元信息，来源依当时manifest/compiled artifacts/wrapper首尾围栏及旧材料哈希。当前v96执行必须另编译并核完整当前源与driver。

用户扩大范围后，最终性能明确延后到上述能力、可见入口和真实补验完成并冻结之后。没有把开发中并发样本或旧短测替代最终回归。

## 本轮最小续验收口

以下四组实际执行绑定 `27d5e527ec3be399829f9f0133dc17fe4a2a74eb` 及各自driver、完整候选源码摘要。当前产品改动截止d458162fb，随后提交仅为测试适配。真实服务别名虽为claude，实际为deepseek-v4-flash；本轮新增39次HTTP请求均200，不把历史messages中的工具清单或错误计为本次新动作。

| 场景 | 实际结果 | 边界 |
| --- | --- | --- |
| 正式开发工作台 | `phase3-source-developer-workbench-847ff7d0/journey/run-QSC0wo`，退出0，0模型请求 | 原ZIP导入和来源确认、默认五项简明状态、按需开发信息、真实行5列7定位ACK、安全HTML纯文本、后续命令后预览保留、真实文件patch和16订阅者LRU失效、一次精确Node命令批准及自然退出、关闭资源三0、撤权和runtime退役均通过 |
| 通用功能最后一次修改 | `phase3-source-generic-mod-d805dc25`，退出0，5次新请求 | 仅一次精确反馈至rev6，真实读取计数0→1、最近工具read_file；虚拟输入标记可见且原文字和光标不变。首轮仅历史引用，未重新执行 |
| 原组合撤权后恢复 | `phase3-source-composition-e139ad51`，退出0，1次新请求 | 原UI重新核对两来源、检查版本、保存、预览确认；原profile仅两摘要更新，ID、顺序、参数与其他选择保留。v2实际任务及普通聊天通过，未重做20次作者请求或复制grant |
| 交付ZIP第二次派生 | `phase3-source-report-derived-deb4aa27/journey/run-fQXTkT`，退出1，12次作者及21次运行请求 | 派生、编译、追加audit-again、四阶段试用completed、新ZIP和fresh原入口安装、原ProjectForm/配置/Feature准入及执行通过；普通项目首handoff因document.json的write_file系统审批未到达 |

全部路径相对于开发仓库output，不随D盘模板复制完整模型记录。三组退出0与第四组的范围成功分别核对，中等强度非作者已实际审查证据。报告派生的原 `LIVE_CLEANUP_EXECUTION_UNSETTLED` 保留；操作者随后对原operation公开cancel，先得到cancel_requested，最终为unknown、pending0，不称cancelled。正常关闭后精确owned进程树为0，无强杀、无迟到批准和任务重放。该组源码复核字段是独立operator-post-exit中的 `sourceCandidateReadVerified=true`，run.json字段为 `driverIntegrityVerified=true`。其来源列表为空，无需Function Mod授权，不宣传发生了不存在的新grant。

第二代作者曾在原request_user_input中询问试用目标。操作者从原UI提供既定371字matrixReportRuntimeGoal，原pending清除后继续同一任务；没有重开作者或改模型源码。目标只整理两条时间资料、限制200字摘要并禁止命令和扩写实现。此项是正常需求澄清，不是多一次权限批准。

正式原生验收以一次真实键盘操作在原草稿建立选区[5,8]，之后不补写选区；diagnosticOnly=false、control=null，未启CDP或额外pointer诊断，全部原文本、同DOM与选区断言通过。此前未聚焦时由脚本设置选区的路径在首次准备按钮后移至末尾，原因尚未解释，负例与独立对照全部保留；不能扩大为任意未聚焦脚本选区均保持的保证。旧聊天恢复期间的16条迁移、8条runtime过期日志未阻塞通用修改成功，原因未定，不能仅凭计数归为授权失败或平台故障。

ZIP身份另由root独立读CRC、逐文件字节及手写摘要重算，不调用原验收helper：旧ZIP为13文件/12作者文件，新ZIP为15文件/14作者文件；两者均与fresh安装逐字节一致，报告仅作为唯一合法增量。新候选摘要475f9999…、报告sourceDigest 66f67464…、完整ZIP文件树29eebe75…属于不同域；新ZIP SHA为7b1bcd3a…。证据为 `output/mods-report-second-lineage-root-independent-27d5e5.json`，不再混用这三种身份。

## 性能

基线固定15492cc9f，完整 Git 树解析 main/shared 及相关 JSON，不回退到当前源码。固定同一依赖与负载，比较源/driver/fixture/bundle 哈希，ABBA/BAAB。开发中并发测试期间的初次 baseline 仅作诊断，不能据此判新版本回归。

正式门槛保持原值：单插件 p95≤15ms；关闭 Mods 的入口 p95≤基线105%；idle CPU增量≤0.5个百分点；桌面TTFT p95增量≤40ms、吞吐比≥0.95。正式长稳需300秒idle、2小时及至少10000事件；自然heap每30秒采样，首尾各10分钟，同一暖缓存和renderer进程，增长≤max(10MiB,初始中位数10%)。强制GC仅诊断，采样缺失或身份变化不能写通过。

首次安静窗口的runtime基线 `phase3-performance-runtime-3d22a416` 在单插件突发负载中退出1，未测current，不能据此作回归比较。首轮dispose诊断262e2397未装入worker，明确无效；后续724a7b45先核实际executionHostPID安装回执，捕获原 `MODS_BUDGET_EXCEEDED`、guestFailure=true、CPU500.1005ms及窗口2196.4347ms，确认突发测试触发生产500ms/5秒保护。诊断与旧片段不计正式成绩，历史基线源码及产品预算均未修改。

两位medium随后通过统一正式测试调度方案：runtime与ingress的0/1/8链冷起、100warm及每轮1000sample使用相同25ms最小实际启动间隔，5轮完整保留；等待在计时之外，慢调用不追赶，异常不吞、不自适应降速，8链实际hops/mask/存活校验保留。新结果只描述≤40Hz声明负载下的单调用延迟，不称饱和吞吐。禁用直接调用的成对交错、无VM的MCP resolver、桌面流量、idle和两小时自然heap负载保持原样。实际调度与完整耗时随新样本记录；正式结果仍待完成。

待填写：安静窗口的正式基线/当前样本、桌面固定流量、两小时自然heap与CPU结果，以及任何未过门槛项及其原因。

## 原流程和文件保护

下列四个原项目关键文件 SHA256 与本轮前一致：HarnessBoardView `ab0c6bdd…`、NativeFeatureReview `6993c2eb…`、native-harness `6336b953…`、service `a1ed67cb…`。只读核对确认 `origin/uat-without-mods` 已包含，无需合并，未修改或推送上线分支。

D盘现有模板/ZIP保持，验收完成后同步新说明。原105项 output 删除与无关报告保留原样，不进入本轮提交。当前日志、临时候选和模型材料不提交。
