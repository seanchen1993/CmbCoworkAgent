# Windows 原生电脑层：源码复核与可行性边界

日期：2026-09-30。范围：补充 [当前实施基线](12-windows-local-first.md) 的 G2，并检查 Windows / Linux 适配边界。只阅读源码与官方资料，未安装或执行候选软件，未运行 Windows 原型，未修改产品代码。

## 1. 必须分别证明的能力

1. 每个 Bot 有稳定、可观看和接管的工作画面。
2. 同一用户的 Bots 共享工作文件与受支持的浏览器登录。
3. 多个 Bot 可并行操作各自的浏览器及桌面工具，不把输入送到另一个 Bot 或用户正在使用的窗口。
4. 原版“每 Bot 一个屏幕”不是“每 Bot 一台隔离 VM”，也不是“多个标签页”或“排队轮流使用同一桌面”。

原版官方文档明确说明用户共用电脑、每 Bot 分屏及浏览器/桌面工具并行；本轮原版观察只证明显示面不同，尚未完成并发输入测试。[原版电脑说明](https://docs.x.ai/grok-bot/computer-and-apps)

上述能力继续属于当前核心；没有把 Windows 难实现的部分移到可选范围。

## 2. 候选路径的证据与结论

| 路径 | 已有证据 | 当前结论 |
| --- | --- | --- |
| 原生 Chromium/Electron Broker | Cmb 已有 WebContentsView、持久 Session、CDP 接入和截图 | 可作为 G2A 起点；仍须验证后台输入、渲染、弹窗、接管与共享登录 |
| Windows UI Automation | 支持控件提供的 Invoke、Value、Scroll 等模式 | 可做控件级操作；不等于全部操作都能后台执行，也不提供完整独立桌面 |
| CreateDesktop / 系统虚拟桌面 | 同一交互窗口站同时只有一个活动输入桌面 | 创建多个桌面对象本身不能证明多 Bot 同时键鼠输入 |
| Windows 原生 Child Session / PiP | 独立于父会话的回环 RDP 桌面；系统最多一个活动且已连接的子会话 | 可研究人和自动化分离；无法据此交付任意数量 Bot 的独立输入桌面 |
| Microsoft UFO | UIA、Win32、截图和输入代码可读；PiP 文档相互矛盾，FAQ/README 仍标计划中 | 取用有证据的工具子模块；不作为已完成的多屏底座 |
| Microsoft WinApp CLI | 有 UIA、窗口捕获、输入校验和跨进程桌面仲裁实现 | 是 Windows 工具适配候选；仲裁是串行保护，不是多套并行输入设备 |
| Windows/Linux 虚拟机或远端电脑 | 可以增加真正独立的交互环境 | 不属于当前纯原生本机基线，不隐含安装或依赖 |

微软 [Desktops](https://learn.microsoft.com/en-us/windows/win32/winstation/desktops) 与 [Child Sessions](https://learn.microsoft.com/en-us/windows/win32/termserv/child-sessions) 分别描述桌面与会话边界，不能把“一个输入桌面”错误推广为“Windows 的所有会话共用一个鼠标流”。另一方面，子会话数限制也不能因开启 RDP 就忽略。

Power Automate 的官方 PiP 说明展示了两类实现的实际限制：子会话与主会话不能并发打开同一个浏览器数据目录；同会话虚拟桌面模式不支持物理键鼠及截图/图像操作。它们证明需要区分不同模式，不意味着 Cmb 要依赖 Power Automate。[官方 PiP 说明](https://learn.microsoft.com/en-us/power-automate/desktop-flows/run-desktop-flows-pip)

**结论：G2A 有明确代码起点；目前核查的 G2B 候选均不足以证明完整目标。** 这不是已证明所有 Windows 原生方案都不可能，而是不能把这些具体候选签为已成立。Linux K8s 的显示/输入实现另行验证，不受本机“禁止 Linux 容器”的限制。

## 3. 新增参考代码：仅用于 Windows 工具适配

原 Cmb 内核、Grok 产品行为、Rakazo 持久执行、OpenBot 动作控制的取用方向不变。新增两份 Microsoft 代码是针对 Windows 缺口的专项材料，不引入第二套 Agent 主循环。

### 3.1 UFO：可用工具与不能照搬的行为

固定 commit：`a795552d976c4c019d7c2f778a0effb5cef7de6b`，仓库许可证为 MIT。

- [controller.py](https://github.com/microsoft/UFO/blob/a795552d976c4c019d7c2f778a0effb5cef7de6b/ufo/automator/ui_control/controller.py#L50)：接收器构造时会 set_focus；坐标点击和部分输入回退使用全局 pyautogui。多实例并不等于各自独立操作。
- 同文件 `atomic_execution` 将异常转为字符串，`click_input` 随后仍返回动作已执行的文本。移植时必须保留结构化失败与结果核验，不能沿用固定成功文案作为执行证据。
- [screenshot.py](https://github.com/microsoft/UFO/blob/a795552d976c4c019d7c2f778a0effb5cef7de6b/ufo/automator/ui_control/screenshot.py#L81)：窗口截图失败可回退到桌面截图。不能让 Bot 目标截图静默扩大为用户桌面，必须返回捕获来源或在越界时失败。
- [FAQ](https://github.com/microsoft/UFO/blob/a795552d976c4c019d7c2f778a0effb5cef7de6b/documents/docs/faq.md#L303) 标 PiP 尚在计划中；源码检索未找到 `ConnectToChildSession`、`WTSEnableChildSessions` 等实现。该检索结果不证明所有外部组件不存在，但足以拒绝“仓库内已有完整 PiP 可直接搬用”的假设。

### 3.2 WinApp CLI：更直接的工具组件候选

固定 commit：`3fd590017806562f088e6b275302610b9937674b`，仓库许可证为 MIT。

- [UiTurnMode.cs](https://github.com/microsoft/WinAppCli/blob/3fd590017806562f088e6b275302610b9937674b/src/winapp-CLI/WinApp.Cli/Services/InteractiveDesktop/UiTurnMode.cs#L16)：区分只读观察、共享工作流修改、独占桌面操作；锁路径按 Windows 用户/会话划分，并以进程及启动时间辨别参与者。
- [UiScreenshotCommand.cs](https://github.com/microsoft/WinAppCli/blob/3fd590017806562f088e6b275302610b9937674b/src/winapp-CLI/WinApp.Cli/Commands/UiScreenshotCommand.cs#L47)：截图按独占处理，因为底层可能恢复最小化窗口或切换前台。其 UIAutomation 库本身不包含 CLI 的全部仲裁，单取库必须补齐调度适配。
- 截图服务实际包含 WGC、PrintWindow 和前台重试分支；取用时保留目标校验，并禁止未授权的前台/全屏回退。
- 工程使用 .NET 10 Windows target，CLI 配置 NativeAOT/self-contained；可以评估单独原生 Worker 打包。源码配置不是已构建证明，需验证目标架构、签名、升级、原生依赖与取消回收。

微软说明明确区分 UIA 控件操作与需要前台/交互桌面的输入注入，并对多个工作流实施仲裁。这个机制可减少错点，但不能写成 Grok 式独立多屏并行已经实现。[WinApp UI Automation](https://learn.microsoft.com/en-us/windows/apps/dev-tools/winapp-cli/ui-automation)

## 4. Cmb 接入必须修改的具体位置

### 4.1 页面身份：不能通过 URL 或标题决定归属

当前 [findBrowserPanelPage](/Users/chenqiang/Desktop/projects/CmbCoworkAgent/src/main/browser/record/common/browser-script-execution-service.ts:240) 遍历页面，以 URL、标题及 about:blank 的最后匹配项选择页面；同网址/同标题的两个 Bot 会出现歧义。

Bot Browser Broker 必须以 `botId + surfaceId + generation` 查找自己创建的 webContents/CDP target 句柄；URL 与标题只用于显示和一致性检查。目标关闭/重建后更新代次，旧请求失败；不回退到“另一个同 URL 页面”。弹窗绑定 opener 的目标和授权，未知来源不自动归给当前 Bot。

### 4.2 看屏与输入必须使用同一目标

当前 [captureScreenshot](/Users/chenqiang/Desktop/projects/CmbCoworkAgent/src/main/browser/core/browser-service.ts:513) 取全局 activeSession；[ensureActiveSession](/Users/chenqiang/Desktop/projects/CmbCoworkAgent/src/main/browser/core/browser-service.ts:624) 复用同一视图。两处均须改成显式目标参数。

截图返回 `surfaceId/generation/frameSeq/captureKind/viewport`；坐标动作同时核验对应目标与画面版本。Windows HWND 还需绑定进程、进程启动身份和会话，不能认为句柄数字永不重用。录屏、DOM、UIA 与截图保持同一捕获范围，取不到目标时报告失败，不偷偷采集别的桌面。

### 4.3 租约按真实输入资源分配

仅有 `screenLease(botId)` 不足以保护 Windows 全局键鼠。Provider 返回输入资源域：Windows 前台输入使用实际交互会话/桌面资源，目标级 CDP 使用对应 target，Linux 显示通路使用实际 display/input 域。锁域由可信 Worker 确定，不能由模型指定一个新名字绕开。

同一全局输入域的两个 Bot 即使显示不同窗口也必须互斥。人工接管、截图前台回退、窗口恢复、Shell 启动的 UI 操作和工具库的隐式 set_focus 都受同一控制契约约束。串行互斥解决正确性，不能作为独立多屏的通过证据。

### 4.4 共享 Session 的权限与文件归属

[configureSessionGuards](/Users/chenqiang/Desktop/projects/CmbCoworkAgent/src/main/browser/core/browser-service.ts:785) 当前把 session 级 handler 绑定到单个 workspace。Broker 应只注册统一 handler，再按真实 webContents/target/主体查授权，未知目标拒绝。下载、上传、本地文件选择、外部协议和浏览器原生对话框也要回到原 Bot 的任务/接管入口，不能按最近活动 Bot 归属。

共享 cookies 不代表共享页面句柄、任务审批或执行控制权。一个 Bot 退出登录可能影响其他 Bot，需呈现真实状态，不承诺每个 Bot 都有独立登录副本。

### 4.5 本机控制面不能只靠同用户管道 ACL

[LocalSandbox 配置](/Users/chenqiang/Desktop/projects/CmbCoworkAgent/src/main/agent/local-sandbox.ts:371) 支持 none、受限 token 和独立 sandbox 用户等模式；[执行入口](/Users/chenqiang/Desktop/projects/CmbCoworkAgent/src/main/agent/local-sandbox.ts:7805) 还包含模式回退。复用模块不等于新 Host 数据、命名管道和凭据已经被隔离。

Bot 自主 Shell 必须有可验证的执行身份与访问边界，不能默认继承 Host 全部环境、读取控制 token/数据库/密钥或绕开 Worker 直接输入。共享工作目录与控制数据目录分开授权；现有 [profileReadRoots](/Users/chenqiang/Desktop/projects/CmbCoworkAgent/src/main/ipc/sandbox.ts:507) 不能自动把 Host/AppData 私有状态加入可读范围。

采用现有沙箱时增加 Bot 路径的最低权限约束，禁止因包安装失败而静默降到突破该边界的模式。Host 与 UI 的握手校验连接角色和进程身份；同 Windows 用户 ACL 仅是第一层。微软说明 DPAPI 通常按登录凭据和机器保护数据，因此不能仅凭用户范围加密证明同用户执行进程无法解密。[CryptProtectData](https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata)当前未实际验证任何 Windows 隔离配置，不把模块名称当成安全性证明。

## 5. G2 验证清单（全部尚未执行）

| 编号 | 必须证明 | 失败判据 |
| --- | --- | --- |
| WIN-01 | 两 Bot 打开相同 URL/标题/about:blank，分别输入标识并截图；销毁重建一个目标 | 选中另一个页面、旧句柄继续有效、截图与输入目标不同 |
| WIN-02 | 一次浏览器登录供两个 Bot 使用；不同目标同时导航、弹窗、上传和下载 | profile 锁冲突、下载归错、权限 handler 相互覆盖 |
| WIN-03 | 原生应用的 UIA 与物理输入分别验证；多个 Bot 与用户桌面并行 | 仅靠轮流抢前台，或用 UIA 成功推断所有物理输入可后台执行 |
| WIN-04 | 遮挡、最小化、缩放、坏捕获和锁屏后的截图/录屏来源可核对 | 隐式采集用户桌面、错误前台、旧帧冒充实时画面 |
| WIN-05 | 人工接管阻止同输入域的全部工具及迟到动作；归还后重新观察 | 换工具、换进程或换逻辑 screenId 绕过接管 |
| WIN-06 | 沙箱 Shell 不能读控制状态/密钥、连高权限管道或绕过输入裁决 | 依赖提示词限制；失败后静默升级；同用户 ACL 被误认为完整隔离 |
| WIN-07 | Worker 崩溃、Host 失联、锁屏/休眠、目标退出；恢复后无重复效果 | 以 TTL 过期证明旧动作没执行，或用新目标承接旧坐标 |
| WIN-08 | 公共内核 Linux 构建边界、平台能力声明和跨 OS 迁移检查 | Windows 路径/二进制进入 Linux 主内核；Windows checkpoint 无检查续跑 |

WIN-01/02 主要支持 G2A，WIN-03/04/05 直接影响 G2B，其余同时约束 G1/G3 和后续 Linux 接入。记录实际 OS/架构、模型、Provider 版本、逐步动作、画面身份和最终产物；不能用 mock 或 Mac 结果填写 Windows 通过。

当前可完成的是设计与源码证据收敛。完整 G2B 路线及 Windows 验证环境尚未具备，不能将“方案完美”标为已证实；也不据此删除原目标。

## 6. 2026-10-09 勘误：共享电脑边界与当前输入实现

当前 [Grok Bot 官方 FAQ](https://x.ai/bot) 明确：同一用户的所有 Bot 共享一台持久云电脑、文件、浏览器和登录，隔离按用户。前文将“每 Bot 独立电脑”或“多套同时物理输入”直接作为原版要求的表述过强；这些不能由官网或多个 Bot 的界面预览推出。现有用户共享工作目录和持久浏览器、每 Bot 绑定目标与授权的主体方向与此一致。

当前 Windows Worker 已有受限 Control／Shift／Alt 窗口消息组合键，不再是完全没有修饰键支持。UIA、窗口消息和字面 Unicode 已编码；物理输入能力仍明确为 false，回执不证明任意原生应用已完成效果。真正保留的缺口是任意原生应用／画布的有效操作，以及不干扰用户主桌面的输入。IME、RawInput 与每 Bot 一台 VM 本身不是官网独立功能指标；不能用这些名词替代实际任务效果验收。

[Windows Child Sessions](https://learn.microsoft.com/en-us/windows/win32/termserv/child-sessions) 的“系统同时只有一个活动且已连接子会话”不足以否定每用户共享 Bot 电脑的候选路线。微软 [PiP 说明](https://learn.microsoft.com/en-us/power-automate/desktop-flows/run-desktop-flows-pip) 确认其 child-session 模式支持次级会话中的物理键鼠与截图；同会话 virtual-desktop 模式不能据此视为相同能力。现有项目尚未实现 child-session 启动、可信会话绑定及完整输入生命周期。候选仍须核对受限执行账号、文件权限、浏览器 profile、输入仲裁、接管、关闭和恢复；不能直接把父用户自动登录会话交给模型执行任意程序。

Windows 完整目标继续保留。此勘误只修正参考产品边界与已编码事实，没有新增 Windows 实机通过结论，也不隐含缩减功能或允许抢用户鼠标。当前源码 SHA、参考原件身份、官方依据和待实现项见 [只读核对记录](evidence/2026-10-08-integration69/current-windows-computer-provider-gap.safe.json)。

接口应使用 [IMsRdpExtendedSettings.Property](https://learn.microsoft.com/en-us/windows/win32/termserv/imsrdpextendedsettings-property) 的 `ConnectToChildSession` 布尔值；它不是 `IMsRdpClientNonScriptable5` 的成员。剪贴板重定向默认开启，必须明确关闭并核对磁盘与设备重定向。父用户自动登录只用于可信控制面：模型应用仍须经既有 prepared Bot 账号和受限权限链启动，并以真实 Token／SID／Session／Job／文件策略证明关联。即便一个 Worker 受限，向完整父用户子会话的 Explorer／Run／其他应用开放输入，仍会引入间接越权。当前没有这些关系的实机证明，下一实现目标须先验证该契约，不能靠迁移进程、删掉私有桌面校验或开启 capability 代替。
