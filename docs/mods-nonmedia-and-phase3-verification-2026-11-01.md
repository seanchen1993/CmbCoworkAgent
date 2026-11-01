# 非媒体补齐、第三阶段与性能验收

状态：主要实现及追加的模块准入、本机生命周期已完成双审、定向回归和全新 medium 独立复审。最终 Node/Web 类型、改动文件 lint 及原流程/第二阶段浏览器检查通过。真实模型续验与正式性能尚未完成，本文尚不是整轮完成声明。

## 交付范围

按 [双审方案](mods-nonmedia-completion-and-phase3-plan-2026-11-01.md) 实施。应用保持 2.0.0，宿主权限摘要升到 v95，防止 v94 及更早的旧确认自动取得新增能力。本轮没有新增业务名分支，也没有替换项目创建、配置、需求管理或执行运行器。

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

追加实现冻结到 `53a3dcd84824141716ee5b2ae212220df0278006` 后，新 native source smoke 退出0：`output/phase3-source-smoke-62742779`。完整源码/资源和选定 driver 启动前后围栏通过，实际 appPath 为新候选、版本2.0.0，当前 main/preload/renderer/公开 IPC 健康，父 textarea 实例和未发送草稿保留，正常关闭。其后受控原 Feature 到 completed、商业续验和正式性能另行记录。

广域回归648文件：632通过、9跳过、7失败，7225项通过、10失败、10跳过。失败包括旧导入入口/未开放接口断言，以及开发并行期间载入了旧作者声明或通知实现的模块。修复和同步断言后，**全部7个失败文件按冻结源码联合重跑94/94通过**，退出0，记录 `output/mods-nonmedia-final-failed-files-2026-11-01.log`。导入采用真实 parent 入口和服务，没有恢复旧 UI 或放宽断言。不能据此把最初整套命令写成全绿。

提交后 `npm run test:mods:continuity` 与 `npm run test:mods:phase2:browser` 均退出0：原项目创建、Feature 开始/批准/重试/取消以及 Placed、MCP、子会话、paint、UI 原语、真实 ChatContainer 组件检查通过。`npm run test:chat:performance` 的9个浏览器套件也全通过：400条混合高度消息拖动/前插不空屏，流式追加不增加导航几何读取，长消息无需 scrollHeight 读取，侧栏拖动期间 App 重渲染为0且释放时1次，解析缓存复用仍保留当前文件链接与复制回调。首次性能脚本因独立 esbuild 夹具未接真实 Worker loader 中断，接入现有 browserWorkerPlugin 后完整重跑通过；没有修改生产 Worker。记录 `output/mods-nonmedia-continuity-2026-11-01.log`、`output/mods-nonmedia-phase2-browser-2026-11-01.log`、`output/mods-nonmedia-chat-performance-browser-final-2026-11-01.log`。这些是实际组件/受控适配器回归，不等于商业模型或正式长稳。

受控原流程全链已通过：`output/phase3-source-original-feature-completion-9e71f921/journey/run-SUEGV1`，运行绑定53a3dcd源码及当次完整测试 driver 哈希，启动/结束围栏通过。原 ProjectForm→配置→Feature→真实 `nativeFeatureCommand`，随后 implementation→delivery→audit→completed；3个真实执行线程、3次 transitioned、3个原生 schema check 均通过。14个本地200请求驱动真实工具，实际读取 Skill、前序输出和写回文件；3次公开 one-shot 审批均核对原 pending 身份及私有声明路径，最终3个文件 SHA 与发送 payload 一致。0商业请求、0环境阻塞、正常关闭，不把受控 provider 当成商业模型。

该工具最初几次停在原 combobox 选择器、两种摘要混淆、multipart 文本展开及审批 DTO 字段假设；只修测试适配，未修改产品、放宽原生校验或审批。安装 identity 的 derivation digest 与 Host retained 完整包树 digest 分开核验，不用主目录 hash 代替依赖/投影后的 Host 快照。失败尝试记录保留，未到节点不算通过。

待填写：真实作者从零/派生/调整续验、ZIP 导出再导入、各商业场景普通项目衔接及未验证节点。Git/审批环境单列，不算平台失败，也不把未到达节点写成通过。

## 性能

基线固定15492cc9f，完整 Git 树解析 main/shared 及相关 JSON，不回退到当前源码。固定同一依赖与负载，比较源/driver/fixture/bundle 哈希，ABBA/BAAB。开发中并发测试期间的初次 baseline 仅作诊断，不能据此判新版本回归。

正式门槛保持原值：单插件 p95≤15ms；关闭 Mods 的入口 p95≤基线105%；idle CPU增量≤0.5个百分点；桌面TTFT p95增量≤40ms、吞吐比≥0.95。正式长稳需300秒idle、2小时及至少10000事件；自然heap每30秒采样，首尾各10分钟，同一暖缓存和renderer进程，增长≤max(10MiB,初始中位数10%)。强制GC仅诊断，采样缺失或身份变化不能写通过。

待填写：安静窗口的正式基线/当前样本、桌面固定流量、两小时自然heap与CPU结果，以及任何未过门槛项及其原因。

## 原流程和文件保护

下列四个原项目关键文件 SHA256 与本轮前一致：HarnessBoardView `ab0c6bdd…`、NativeFeatureReview `6993c2eb…`、native-harness `6336b953…`、service `a1ed67cb…`。只读核对确认 `origin/uat-without-mods` 已包含，无需合并，未修改或推送上线分支。

D盘现有模板/ZIP保持，验收完成后同步新说明。原105项 output 删除与无关报告保留原样，不进入本轮提交。当前日志、临时候选和模型材料不提交。
