# macOS / Windows 本机优先：当前实施基线

更新日期：2026-10-02。依据用户最新要求，首版同时支持 macOS 与纯 Windows 原生运行；用户已有 Windows 机器，待代码完成后配合实机测试。产品实现正在进行。本文件与最新 [core-scope.json](core-scope.json) 优先于旧文档的“首版远程部署”要求；通用执行、恢复和权限契约继续适用。文件名为原方案历史路径，保留以免破坏引用。

### 2026-10-07 补充：Mac 纯原生范围

用户已明确“Mac 必须纯原生，调整电脑能力范围”。Mac 首版提供专用工作浏览器、文件、浏览器示范和人工接管；不提供任意系统命令及独立通用原生桌面，不安装虚拟机。正式 Host 从模型工具、能力声明和实际执行入口关闭命令，以及依赖命令的后台进程、跨任务服务、项目检查和可执行技能依赖检查。已保存的绑定、配置和历史可读，不因旧配置恢复执行权限；HTTP、提示类 Hook 仍按原授权执行。

此调整只适用于 Mac Bot，现有 Cmb 常规任务不受影响；Windows 原生及后续 Linux 服务端实现目标保留。过去产生的 `closure-unproven` 等未确认收据继续阻止不安全恢复或维护，不得因关闭新命令入口而删除。Mac 的浏览器验收与命令关闭验收分别执行，不再以弱进程关闭实现冒充任意命令的可靠隔离。

### 2026-10-07 补充：Windows 输入已编码范围与实现缺口

Windows 当前已编码 15 个基础单键和 F1–F12，共 27 个无修饰键；字面 Unicode 文本通过目标窗口的 `WM_CHAR` 发送。UIA 已支持经核对的非密码控件赋值、完整 TextPattern 文档全选及公开控件调用。输入继续绑定原窗口、进程、画面与控制代次；`keyboardInput` 仍为 false，窗口消息回包只证明投递，不能证明任意应用已完成操作。

通用 Ctrl/Shift/Alt/Win 组合键、目标侧真实 IME 组合态和 Raw Input 尚未实现，CPU-04/CPU-17 的该部分仍是实现缺口，并非仅等待 Windows 实机测试。现有 UIA 全选与赋值只覆盖提供对应 pattern 的控件，Grok 的远端 VNC 和浏览器按键路径不能直接补成本机 HWND 通用输入；不得用抢系统键盘或前台的输入回退代替目标操作。用户只调整 Mac 范围，Windows 核心目标没有缩减授权，仍须补齐实现并另行验收。详见 [Windows 输入源码核对](evidence/2026-10-07-windows-input-scope/REPORT.md) 及 [18 份源码摘要](evidence/2026-10-07-windows-input-scope/source-contracts.json)。

## 1. 已确定的范围

| 项目 | 当前决定 |
| --- | --- |
| 当前开发与复核机器 | 用户本机是 macOS，同时已有 Windows 测试机；先完成代码，再进行 Windows 安装和实际操作验收 |
| 客户端 | macOS 与纯 Windows 原生运行；Windows 禁止依赖 WSL2/Linux 容器。Mac 测试不能替代 Windows 验收，两端分别验证安装、后台运行、浏览器与接管 |
| 执行位置 | 用户本机独立后台 Host；界面关闭后可继续，关机、休眠、注销后的连续执行不作承诺 |
| 后续部署 | Linux 节点上的 K8s，用户已明确；首版交付跨平台公共内核、可替换端口、独立运行包与迁移契约，集群部署及多租户运营延期 |
| 模型 | 用户配置，复用 Cmb 模型注册、默认模型和连接参数；不绑定 Grok 模型或另建必选模型平台 |
| 系统接入 | 不预设必须新增的内部系统；浏览器、现有工具和 MCP 是基础接入方式，指定供应商事件适配按需选择 |
| 核心功能 | Bot 身份、聊天、持久电脑、协作、记忆、Skills/Teach、计划与通用事件、授权及恢复仍保留 |
| 继续延期 | 手机、语音、公开市场、Team Bots 发布及高级企业管理 |

“内部系统”指代码仓库（如 GitLab）、流水线（如 Jenkins）、工单/需求平台、知识库、招乎及内部网页。它们是 Bot 操作的目标，并非平台成立的前提。只有选定某个系统后，才需要明确地址、网络、登录和操作范围。不能把“暂未选择专用连接器”写成核心平台整体无法开发。

## 2. 首版实际运行结构

macOS / Windows CmbCowork 桌面 → 本机 Bot Host → 用户共享工作环境、Bot 独立操作画面、模型和连接器。

- 桌面负责交互；Host 负责 Bot 注册、消息、持久调度、协作、例程、审批、记忆与学习任务。它们先同一后台部署包运行，按模块组织，避免为本机版启动多套基础设施。
- Host 使用独立进程和用户级数据目录，脱离窗口生命周期。桌面启动时发现或启动 Host；单实例锁、进程身份及协议握手防止双启动。关闭窗口保留后台，菜单提供明确的“停止 Bot 后台”；应用升级按安全边界交接。
- Windows 注销、关机、休眠和电脑 Worker 退出属于宿主不可用。重启后恢复已接收任务，按漏跑规则处理例程；外部效果不明不能重放。开机/登录自启由显式设置控制，不声称电脑断电仍执行。
- 桌面与 Host 的命令/事件在 Windows 使用当前用户可访问的命名管道，在 macOS 使用用户私有目录中的 Unix socket；保留 nonce、revision、cursor、snapshot 契约。画面与 Webhook 如需 HTTP/WS，仅绑定回环并独立认证；不默认暴露到局域网。
- 领域与 Agent Host 通过端口取得模型、存储、电脑、凭据和通知，不依赖 Electron 主进程。Windows Browser Worker 可以显式使用 Electron/Chromium，但必须是独立 ComputerProvider 适配器，不能污染未来 Linux 服务使用的公共执行内核。

### 2.1 已核实的 Host 抽离工作

对现有入口做了静态依赖构建：`agent-run-service.ts` 仅包含注册与转发，独立调用返回 `Agent run service is not initialized`；实际函数仍在 [registerAgentHandlers](/Users/chenqiang/Desktop/projects/CmbCoworkAgent/src/main/ipc/agent.ts:5259) 中注册。`runtime.ts` 与 `standard-thread-turn.ts` 的构建分析各解析 498 个本地文件，其中 31 个文件直接导入 Electron。这是依赖范围证据，不代表 498 个文件都要重写，也不代表运行验证通过。详细结果见 [Host 依赖记录](host-boundary-review.json)。

实施按下列位置切断依赖，保留原执行逻辑与约束：

| 位置 | 必须完成的适配 |
| --- | --- |
| agent-run-service / ipc/agent | 抽出实际执行体及注册过程；桌面 IPC 和 Host 共用，保留停止、目标控制与单次终态回调，不能只移植转发入口 |
| runtime / local-sandbox / ipc/sandbox | 沙箱配置、资源路径、审批接入纯服务端口；IPC 只做调用适配，不能为启动成功删去保护 |
| scheduler-tool / services/scheduler | Bot 工具接入新的持久调度端口；避免经旧调度器引回窗口、桌面宠物和 IPC，不能产生两套 Bot 权威队列 |
| storage / models/registry / mcp/capability-service | 拆开配置读写、凭据解析、MCP 配置构造和窗口广播；复用模型配置语义，Host 持有 Bot 状态，桌面接收事件 |
| Mods v1/v2 runtime-client 与 host-entry | 现有双方依赖 Electron utilityProcess 和 process.parentPort；迁移时同时适配启动器与消息通道，保留限额、心跳、代次、取消和权限回调，不能仅换成 child_process.fork |
| code-exec/runner | 注入 Helper 路径与明确的 Node 可执行文件；不假定 process.execPath 是 Electron，也不依赖 app.asar 或继承整份宿主环境 |
| checkpoint / runtime-projection-client | 原 saver 自行开启连接与事务；拆出序列化准备和事务提交，接入同一 Host 存储，避免外层事务嵌套 BEGIN。投影 Worker 的 nodeWorker 构建约定改为明确 WorkerFactory 和独立产物 |
| services/user-input / 通知 | 等待状态落盘，窗口重开可恢复；renderer ACK 和内存 Promise 不能代替持久 Interaction，缺界面不能转为默认批准 |

Host 的 Node 版本需要单独固定。现有 package.json 的 `>=18 <24` 不能直接当作运行兼容证明：当前原生数据库适配使用 `node:sqlite`、`StatementSync.columns()` 和 timeout，后两项在 Node 22.16.0 才提供。因此选用通过依赖验证的 Node 22 维护版本，最低不低于 22.16，并随 Host 打包或固定镜像版本；不依赖用户 PATH 中的 Node。本次分析工具运行于 Mac 的 Node 24.13.0，不能算 Node 22 或 Linux 验收。[Node 官方版本说明](https://nodejs.org/download/release/latest-jod/docs/api/sqlite.html)

G1 实施验收增加：完整 Host 的运行依赖图无 Electron/桌面 IPC 回流；Worker、Mods、code_exec 及必要资源均随包交付；在干净数据目录完成启动、模型调用、等待恢复和受控工具执行。静态打包成功或把 electron 标为 external 都不能单独判定 G1 通过。

## 3. 纯 Windows 电脑层：有代码基础，但完整同款仍待验证

用户已明确不允许 WSL2/Linux 容器，撤回本地 Linux 电脑候选。本机首版不得悄悄安装 Docker、WSL2 或依赖远端电脑来满足验收。

### 3.1 可复用的真实基础

- Grok [sand-browser-tools.ts](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/host/runner/tools/sand-browser-tools.ts:551) 已定义浏览器工具；[sand-browser-driver-source.ts](/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main/source/host/runner/tools/sand-browser-driver-source.ts:494) 包含实际的快照、元素定位、点击、输入、滚动、拖动、截图与标签操作，通过 Playwright/CDP 执行。以这些实现为主体直接移植，保留适用的结果与错误处理，动作审核接入 Cmb 单一审批链。原驱动的上传执行、box-chrome、DISPLAY、/tmp 与 /workspace 依赖改为 Windows 启动器、数据路径和连接适配，不能把平台差异扩大为整套浏览器逻辑重写。
- Cmb [browser-service.ts](/Users/chenqiang/Desktop/projects/CmbCoworkAgent/src/main/browser/core/browser-service.ts:46) 使用持久 partition；[创建视图逻辑](/Users/chenqiang/Desktop/projects/CmbCoworkAgent/src/main/browser/core/browser-service.ts:624) 使用 WebContentsView。可移植会话、导航、捕获与防护逻辑，但当前只有一个 activeSession，且依赖主窗口，不能直接当作多 Bot 独立浏览器。
- [脚本执行连接](/Users/chenqiang/Desktop/projects/CmbCoworkAgent/src/main/browser/record/common/browser-script-execution-service.ts:298) 已有 CDP target 发现及 Playwright 接入，但主动要求主窗口显示 BrowserPanel。需改为按 Bot/目标注册表取得执行目标，解除全局单例和前台显示依赖。
- Cmb [LocalSandbox](/Users/chenqiang/Desktop/projects/CmbCoworkAgent/src/main/agent/local-sandbox.ts:7) 和 Windows 沙箱策略可复用命令、工作目录、取消及授权约束；这不等于已有完整桌面隔离环境。

### 3.2 原生适配方案

| 能力 | 拟采用实现 | 验证边界 |
| --- | --- | --- |
| Bot 浏览器 | 移植 Grok 浏览器工具及动作驱动，接入独立 Browser Broker/Worker；复用 Cmb 浏览器承载与 Session 代码，每 Bot 拥有页面/窗口与 target，用户共用一个专用持久 Session | 后台渲染、输入路由、下载归属、共享登录、人工接管全部实测 |
| 文件与 Shell | 原生 Windows 工作目录、授权项目路径和受限进程；按任务隔离 worktree | 中文/长路径、PowerShell、编码、权限、子进程树及重启恢复 |
| 原生应用操作 | Windows Automation Worker，明确目标进程/窗口、UI Automation 或经验证的输入通道 | 通用后台多屏并行尚未证明；受前台约束的输入必须独占当前输入桌面 |
| Teach | 统一 TeachSession/队列/学习配方，录制源改为 Windows 的指定浏览器/窗口捕获与原生编码 | 不直接移植 x11grab、/proc、Linux flock 与信号命令；按目标画面验证 |
| 看屏与接管 | Frame/Control 协议保留真实 surfaceId、generation、viewport、frameSeq；捕获和输入由对应 Provider 执行 | 旧帧、错目标、缩放、遮挡、最小化、锁屏与断开不能导致误操作 |

浏览器使用 Bot 专用数据目录，不并发打开现有 Cmb 主进程或用户 Chrome 的同一 profile 文件。用户在 Bot 工作浏览器登录一次后，其他个人 Bot 使用同一受控 Session；不自动导入个人全部浏览历史和凭据。Electron 支持 [持久 Session/partition](https://www.electronjs.org/docs/latest/api/session)，但这仅说明可复用机制，不证明全部网站的登录共享行为相同。

共享 Session 的权限回调必须由 Broker 统一按 webContents/target/主体查授权；不能为每个 Bot 反复覆盖 session 级 handler。现有 [configureSessionGuards](/Users/chenqiang/Desktop/projects/CmbCoworkAgent/src/main/browser/core/browser-service.ts:785) 绑定单会话 workspace，直接复制成多实例会出现最后注册者影响其他 Bot 的风险。

Grok 驱动已有 viewId → targetId 映射，但其上下文按 display 组织，包含按 URL 找回页面、枚举整个 context 的标签和领取锁失败后继续执行的逻辑。移植到共享 Session 时，由 Broker 校验 Bot、目标归属与代次；标签列表和恢复候选限定到该 Bot 的目标，归属不明不能凭相同 URL 认领。接管状态也在实际动作执行前检查。保留页面操作主体，改造这些会影响多 Bot 正确性的边界；不能把复制驱动文件视为并行和接管已完成。

### 3.3 不能回避的实现门槛

Windows [交互桌面文档](https://learn.microsoft.com/en-us/windows/win32/winstation/desktops) 明确同一交互窗口站同时只有一个活动输入桌面。因此，CreateDesktop 或系统“虚拟桌面”本身不能证明拥有多套同时可输入的 Grok 式桌面。Electron 的 [sendInputEvent](https://www.electronjs.org/docs/latest/api/web-contents#contentssendinputeventinputevent) 也要求承载窗口有焦点；简单创建多个隐藏窗口不够。

候选 Browser Broker 可研究目标级语义/CDP 操作与 [离屏渲染](https://www.electronjs.org/docs/latest/tutorial/offscreen-rendering)，但必须在锁定的 Electron 版本与 Windows 上通过 G2A。任意原生桌面应用的独立画面、后台操作、共享登录与并行焦点另列 G2B，不能用浏览器样本替代。

**当前未解决：纯 Windows、无虚拟环境条件下，通用桌面应用达到原版独立多屏并行体验的实现证据。** 仍保留 CPU-02/03/04 的完整核心目标，不把桌面能力悄悄降为可选。若 G2B 无法成立，必须向用户说明具体差异并重新决定交付范围，不能把“浏览器多页 + 桌面串行”直接签成完整同款。

### 3.4 专项源码复核补充

详见 [Windows 原生电脑可行性复核](14-windows-computer-feasibility.md)。新增证据：Windows Child Session 同时仅有一个活动连接；UFO 未提供已核实的完整 PiP；WinApp CLI 的桌面仲裁是互斥执行。它们均不能直接填补 G2B。两个 Microsoft 仓库仅作为原生工具组件候选，不更换 Cmb Agent 内核。

Cmb 现有 CDP 页面选择按 URL/标题查找，不能用于多 Bot 归属；改为 Broker 持有的 target 身份与代次。截图、录屏及输入统一绑定目标，禁止隐式捕获用户桌面或抢前台。Windows 输入租约按实际交互会话/桌面资源划分，不能每 Bot 随意分一个锁就宣称互不干扰。

本机命名管道的同用户 ACL 不能单独阻止同用户 Shell 冒充控制客户端。Bot 路径须验证沙箱身份、控制状态/凭据不可读、工具回退不突破最低权限，并覆盖全部输入通道；现有沙箱模块需逐项接入验证。具体修改位置及 WIN-01～08 验收在第 14 文档，全部尚未执行。

## 4. 本机数据与恢复

| 数据 | 首版本机实现 | 后续 K8s 适配 |
| --- | --- | --- |
| Bot、会话、任务、审批、effect、事件及 checkpoint | Host 所有的 SQLite；Bot 路径采用可共享事务的连接/适配器 | PostgreSQL 适配器 |
| 附件、录屏、成果 | 本机对象目录，临时写入、完整性校验后发布 ready 引用 | S3 兼容对象存储 |
| 电脑文件与登录状态 | Windows 用户工作目录、Broker 持久 profile、版本化恢复 manifest | PVC 或电脑 Provider 的持久盘 |
| 模型与插件凭据 | 受限凭据端口；Windows 用户范围保护，模型调用时解析 | 集群 Secret/KMS 适配；重新绑定用户授权 |
| 桌面消息视图 | Host 事件投影 | 相同事件协议的远程投影 |

不让 renderer、旧会话执行器和新 Host 同时写 Bot 数据。旧桌面会话继续使用现有保存器；Bot 分支保留 SqlJsSaver 的序列化、pending writes、interrupt、消息快照及严格提交语义，通过适配器接入共享事务。不能同时承诺“完全不改原 saver”和“跨多个 SQLite 文件原子提交”。

接收消息/Run/outbox、checkpoint 头及相关事件必须有可验证的事务边界；文件系统与 SQLite 无跨介质原子事务，使用 staging、内容校验、ready 发布和孤儿回收。备份不能直接复制正在写的数据库及浏览器目录；须在一致恢复点生成 manifest，并实际还原验证。

本机仍需持久 lease/fence、最终执行端代次检查和未知效果核对。时间源采用 Host 的统一时钟；系统时钟跳变、休眠恢复后增加宿主 generation 并重新核验在途执行，不把 TTL 过期当作原动作绝未执行的证明。

## 5. 模型由用户配置，但能力必须可检查

Cmb 已有 [CustomModelConfig](/Users/chenqiang/Desktop/projects/CmbCoworkAgent/src/main/storage.ts:1601)、[默认模型解析](/Users/chenqiang/Desktop/projects/CmbCoworkAgent/src/main/storage.ts:2178) 与 [模型注册模块](/Users/chenqiang/Desktop/projects/CmbCoworkAgent/src/main/models/registry.ts:1)。复用配置和解析逻辑；其中 Electron 通知与存储依赖需要通过端口抽离。

- Bot 默认继承用户默认模型，可选择已有配置；不要求每次建 Bot 重新配置模型。
- 每次 Run 保存模型引用、配置 revision、必要能力及实际路由记录。中途改配置不暗换执行语义；失效、限流和备用路由有明确结果。
- 文字推理、工具调用、视觉理解、视频或多帧理解分别检查。Teach 可以使用用户另配的视觉模型；只支持文字的模型不能被标成具备屏幕理解能力。
- API Key 由受限 ModelProvider 使用，不放进 Bot 资料、技能、消息、配置导出或Shell/电脑 Worker 的非必要环境。现有配置读取可复用，不表示现有凭据保存方式天然满足所有新边界。
- 模型能力不足时给出缺项和配置入口；不得静默调用用户没有配置或授权的模型。

## 6. 事件、连接器与内网

首版实现定时、持久事件入口、认证、去重及重试。通用 Webhook 默认本机回环地址；外部系统不能直接访问该地址，不自动开启公网隧道。需要远程推送时，后续配置受控入口或接入 K8s；轮询型连接器按其实际游标协议运行，不能伪装成漏事件也可靠的推送通道。

已有 MCP/插件经同一授权网关供 Bot 使用；stdio 工具按明确执行位置运行。浏览器登录、插件 OAuth、Windows 系统账号和模型 API Key 是不同凭据，不因“都在本机”就互相代用。用户普通浏览器能打开某内网页，不证明 Bot 专用 Session 或受限 Windows 身份也已通过代理、客户端证书或 SSO，需要单独连通检查。

当前后台网络实现（2026-10-03）：Host 启动时读取 `HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY`，小写同名变量优先，使用固定版本 Undici 的 `EnvHttpProxyAgent`。代理作用于 Host 内 Node fetch 的模型和 HTTP MCP 请求；本机 `localhost`、`127.0.0.1` 和 `[::1]` 控制连接强制直连，另保留用户绕过列表。模型/API 认证与代理认证分别发送，不在界面或日志中展示代理地址。TLS 仍校验证书，可信附加 CA 由 Node 启动环境 `NODE_EXTRA_CA_CERTS` 提供。对应实测见实施记录。

此处尚无代理设置页面或自动 PAC/系统代理导入；必须由启动应用的环境配置。环境变量变化需要从新环境重新启动桌面，并通过“帮助 → 关于与反馈 → 重启后台”在空闲时更新独立 Host；仅关闭窗口不会重启 Host。Chromium 网站代理、stdio 子进程、客户端证书和企业 SSO 按各自网络栈配置，不承诺由此设置自动接通。

## 7. 首版就落实的 K8s 扩展边界

| 端口 | 首版交付 | 后续替换 |
| --- | --- | --- |
| BotTransport | 本机命名管道、版本化命令/事件 | HTTPS/SSE 或受控 WS；同一 nonce/cursor 语义 |
| StateStore / CheckpointPort | SQLite，共享事务及恢复合同 | PostgreSQL；禁止用共享 PVC 多进程写 SQLite 代替分布式适配 |
| ComputerProvider | Windows 原生 Provider；G2A/G2B 分别核验 | Linux Computer Provider，另接 K8s 生命周期与所需隔离设施；票据与 generation 契约相同 |
| ArtifactStore | 本机内容寻址目录 | 对象存储与受控下载 |
| SecretProvider / IdentityPort | 当前 Cmb 身份 + Windows 会话 + 本机凭据 | 服务端身份校验、scope token 和 Secret/KMS |
| RuntimeLauncher / Notification | 本机进程监管与桌面通知 | 集群工作负载、任务恢复与在线客户端通知 |

首版包括端口类型、完整本机适配、契约测试、独立 Host 构建入口、配置 schema、协议兼容策略与迁移清单。Linux 无 UI 构建/启动检查用于防止 Windows 路径或 Electron 依赖渗入公共内核。未实现的远端模式明确不可用，不提供空方法假装已经支持部署。

### 7.1 一个公共内核，两套操作系统适配

| 部分 | Windows 本机首版 | 后续 Linux / K8s |
| --- | --- | --- |
| Bot 身份、消息、调度、协作、记忆、技能、审批、模型配置 | 共用领域与执行内核，通过端口访问平台能力 | 复用同一内核，替换部署与基础设施适配 |
| 浏览器和电脑 | Windows Browser Broker、原生应用自动化及捕获 | Linux 浏览器、显示服务、桌面控制与捕获；复用经核实的 Grok/Linux 模块 |
| Shell、进程、录屏 | Windows 命令与进程树、捕获/编码适配 | Linux shell、进程/信号、显示及编码适配 |
| 身份、凭据、文件 | 当前 Windows 用户、受保护凭据、授权路径 | 服务端身份、Secret/KMS、工作盘与对象存储 |
| 构建产物 | Windows Host 与 Worker 安装包 | Linux Host 镜像、Computer 镜像及 K8s 部署配置 |

客户端仍可运行在 Windows，连接部署在 Linux K8s 中的 Bot 服务。后续服务端不依赖 Windows 节点、Windows 桌面会话或用户本机长期开机。也不把 Windows 可执行文件直接放进 Linux 镜像；原生依赖按目标 OS/架构分别构建。Linux 公共内核构建检查不等于 Linux 电脑已交付或已验证。

公共协议使用逻辑资源 ID、工作根目录和结构化操作；绝对路径、盘符、路径大小写与 shell 命令由对应适配器处理。工具、技能及 Run 声明 `requiredCapabilities`（包括 OS、shell、应用和视觉能力）；迁移后不满足时进入 `needs_setup` 或明确不支持，不能把 PowerShell/Windows 专用程序静默当成 Linux 可执行任务。Windows 专用桌面应用在 Linux 上不能承诺可用；若未来要远程访问 Windows 设备，属于额外 Device Provider，不是本次 Linux 部署的隐含前提。

### 7.2 集群运行与迁移

后续 Linux K8s：API/调度/Host 可拆分部署，电脑按用户或实际安全主体安排，多个 Bot 在同一电脑内分屏；不默认一个 Bot 一个 Pod/VM。Pod 重建与持久数据分开管理，采用 [工作负载控制器](https://kubernetes.io/docs/concepts/workloads/) 和 [持久卷](https://kubernetes.io/docs/concepts/storage/persistent-volumes/)。Pod 本身不等于完整 VM 安全边界，原版共享浏览器与隔离要求仍须验证。Linux 多屏、登录持久化、并发接管及 Teach 独立验收，不能沿用 Windows 通过记录。

迁移时停止新任务、排空或持久挂起旧运行，保存 DB/产物/工作盘一致 manifest，保留 ID 和版本，导入后验证再转移 placement generation。模型和 OAuth 凭据需在目标环境重新绑定，Windows 保护的密文不承诺直接搬到 Linux 即可使用；回滚不能同时恢复两套活跃调度器。

迁移对象包括 Bot 配置、消息、记忆、技能版本、例程及受支持文件；浏览器 profile、登录态、Windows 程序和执行现场不承诺原样跨 OS 迁移。checkpoint 先校验运行时/工具/平台能力兼容性，不兼容的 continuation 保留原状态与效果账本，重新规划或等待处理，不盲续跑旧命令。文件迁移检查路径映射、大小写冲突、链接与权限；浏览器登录按目标环境重新验证，必要时重新登录。

## 8. 当前验收调整

- G1：Windows 独立 Host、用户模型配置、关闭窗口后的工具/审批/子任务；公共内核 Linux 无 UI 构建和入口检查，不要求 Windows GUI Worker 可在 Linux 运行。
- G2：分为 G2A 浏览器与 G2B 原生桌面应用；均验证两 Bot 分屏、共享登录、并发输入/下载/接管、休眠后恢复。原版观察通过不代表 Cmb Provider 已通过。
- G3：本机双 Host 竞争、进程崩溃、DB 忙/磁盘满、休眠与时钟变化、旧动作迟到、结果未知；保留后续远端存储适配合同。
- G4：实际用户配置模型的录制、学习、不同输入执行；缺视觉能力、坏录制、重复领取和敏感采集失败用例。
- CJ05 改为关闭窗口后后台继续、重开处理等待；增加关机/休眠期间不执行、恢复后不重复。
- CJ08 改为本机数据身份与 OS 用户隔离、登出/撤权及伪造控制连接检查；集群多租户隔离延期。
- CJ10 使用本机授权项目映射或独立 checkout；CJ11 的双端竞争用同 Host 的两个受认证连接测试，跨机器同步延期。
- CJ12 增加 Windows 安装/卸载边界、Host 与 UI 升级兼容、Worker 不可用、锁屏、代理和模型配置变更。

原 260 项保留全量目标，当前实际验收逐项更新到 core-scope.json；全部实现状态仍为 planned。原“5 万～9 万行”基于远端核心和 2～3 个专用连接器，现归档为旧范围估算，不直接作为本机版报价，也不按删掉云服务就武断减半。

## 9. 尚需实证的内容

本轮已确定纯 Windows 本机优先、禁止本机依赖 WSL2/Linux 容器、后续 Linux K8s 和用户模型配置。当前关键缺口是 G2B 的原生桌面并行能力，不能宣称电脑层方案已经完备。还须在实施时完成 G1～G4；Windows 版本/架构、安装签名、资源默认值和恢复目标由预检、原型及发行验收收敛。当前执行环境是 macOS，尚未运行 Windows 原型。
