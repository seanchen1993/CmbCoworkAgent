# Windows CPU-04 / CPU-17 输入缺口：只读源码核对

状态：READ_ONLY_SOURCE_REVIEW。没有生产写入、没有运行 Windows/Chrome/Electron，没有扩大其它功能重审。范围只包括当前 Windows Native Automation 输入、原 Grok 的对应 driver，以及现有可复用路径。现状是有明确代码限制，不能只写“待实机验证”就关闭缺口。

## 当前实际支持范围

| 操作 | 当前实现 | 精确来源 |
|---|---|---|
| 单键 | 27 个无修饰键：Enter、Tab、Escape、Backspace、Space、Insert、Delete、四箭头、Home、End、PageUp、PageDown、F1–F12 | `src/shared/bot-native-desktop.ts:309`；`worker/WindowMessages.cs:318` |
| 文字 | 最多 4096 UTF16 单元的字面 `WM_CHAR`，规范化换行为 CR；可发送中文字面值，不能当作目标侧 IME composition | `WindowMessages.cs:378–398`；`bot-native-desktop.ts:359` |
| 人的字符输入 | Ctrl/Alt/Meta 被拒；无修饰特殊键可发；Shift+导航/Tab/F键被拒；Shift+A 这类实际字符可以作为字面文本发送，未建立 Shift 状态 | `src/renderer/src/components/bots/native-message-input.ts:91–108` |
| 控件编辑 | 对已观察且仍相同的 UIA provider，可完整赋值、TextPattern 文档全选、Invoke/SelectionItem/Toggle/Expand/Scroll | `vendor/.../NativeDesktopAutomation.cs:425、561、648、668` |
| 目标与状态 | 操作绑定 Bot/task scope、控制 epoch、原帧 ticket、原 window/root/PID/startTicks/session/desktop、原 focused child/thread；密码/不完整敏感扫描会拒输入 | `WindowMessages.cs:63–79、282–313`；`worker/Program.cs:327–335、637–645` |
| 结果含义 | Keyboard PostMessage 仅 `accepted:true, processed:false, effectVerified:false`；可重截图核对，但不自动把投递当作快捷键效果 | `WindowMessages.cs:389–390`；`native-desktop-tool.ts:237` |

协议明确把 `keyboardInput` 和 `pointerInput` 固定为 false，只有 messageKeyboard/messagePointer 的有限能力。原键盘取消/出错释放只对原 child 身份执行；不能为添加 modifiers 改为释放新焦点或全局按键。`Ctrl+Alt+Escape` 是当前面板的本地退出导航，未转发给目标应用。

## 仍未编码的核心输入

| 缺口 | 典型例子 | 已有替代范围 |
|---|---|---|
| Ctrl 编辑与查找/保存 | Ctrl+A/C/V/X/Z/Y/S/F，Ctrl+Shift+Z | 全选可用现有 `select_all_text`；值替换可用 `set_value`；保存/查找/撤销仅当应用把相应按钮或菜单公开为可观察可调用 provider 时可用 `invoke`。剪贴板、Undo/Redo 不存在通用 UIA 替代。 |
| Ctrl 文本导航与删除 | Ctrl+Left/Right/Home/End/Backspace/Delete | 当前只发对应无修饰键；没有词级移动、修饰状态或精确局部选择操作。 |
| Shift 选择和反向导航 | Shift+Left/Right/Home/End/PageUp/PageDown、Shift+Tab、Shift+F键 | 当前 UIA 只有整段文档全选；不能冒充任意选择或 Shift+Tab。 |
| Alt 和系统组合 | Alt+菜单字符、Alt+F4、Alt+Tab；Win+D/Win切换；Ctrl+Alt+Delete | 当前不发 WM_SYSKEY 系列/Alt context，也不向系统输入流注入。窗口选择是 broker 自身的选择动作，不能伪称系统 Alt+Tab。安全注意序列不是普通 HWND 输入可生成。 |
| 物理扩展键 | F13–F24、numpad/左右修饰、PrintScreen、锁定键等 | 当前 schema/VK switch 不含这些键。可增加少数无修饰 VK，但这不会补齐通用组合键、IME/RawInput。 |
| 真实目标侧 IME/Raw Input | 输入法启闭/候选/组合态/换布局；应用消费 WM_INPUT/键盘钩子/异步物理状态 | 当前仅 UTF16 WM_CHAR；面板 isComposing 明确提示批量发送文字。未实现目标 IMM/TSF 会话和 raw device 管道。 |

`src/main/bots/native-desktop-message-review.test.ts:336–377` 明确固定 27 键并拒 Ctrl+A、Alt+F4、Shift+F1、F13、IME。这是产品契约的拒绝路径，不是已有实现的测试漏跑。旧库存写“15 基础键”需精确为“15 基础键 + F1–F12”；剩余通用组合键/IME缺口仍成立。

## 原 Grok driver 对照与复用结论

原 `source/host/runner/tools/sand-computer-tool.ts:26、111–132` 提供 screenshot/click/move/drag/type/key/scroll/wait；type/key映射到远端 ComputerProtocolAction，key字段是字符串。该实现没有本机 Windows HWND 注入或 target-thread keyboard-state 实现。

原 `source/electron-preload/preload-vnc.ts:355–396` 的 Mac快捷键映射只处理 Meta+A/C/V/X/Z，依次对当前 `ui.rfb` 连接发送 ControlLeft / 可选 ShiftLeft / 字符 down/up，并释放 modifier。目标是该远端 VNC 连接。实际源码 SHA 与旧 pin `c5cc9d3b17bdbb504d78c7e1526f62315b4f6af60b1cdeb99dada23f5aced2b9` 一致。不能把这个 sequence 替换成 PostMessage 后称本机 Windows accelerator/RawInput 已支持。

仓库 `src/main/bots/upstream/grok-browser-actions.js:9–64` 的 `pressGrokBrowserKey` 已安全复用 `page.keyboard.press`，失败时只释放原 page.keyboard 并对原 transport 清理。它仅适用于 existing browser target；没有 HWND/thread/desktop 输入能力，不能用它接管全局桌面。可复用它的有限失败处理思想，不能复用其执行器作为 native backend。

当前 Native worker 的 pinned WinApp 来源已经故意省去 SendInput、全局焦点、modifier state 和 fallback。`vendor/.../NativeMethods.txt` 与 csproj 仅引入当前 UIA/WGC桥；没有尚未启用的通用原生 chord 模块。

## 为什么不能用仅枚举或追加 modifier down/up 补齐

Microsoft 官方说明：PostMessage投递的键盘消息不经过真实输入队列/键盘钩子，因应用处理方式不同不能保证真实输入效果；建议是 UI Automation 或系统 SendInput。[Microsoft keyboard messages](https://devblogs.microsoft.com/oldnewthing/20250319-00/?p=110979/)

`SetKeyboardState` 改的是调用线程，不能直接设置任意目标线程；`AttachThreadInput` 会共享焦点/输入状态并重置 key state，而且不能跨 desktop。这些 API 不能构成现有 target-only 原窗口合同的无影响通用替换。[SetKeyboardState](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setkeyboardstate)、[AttachThreadInput](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-attachthreadinput)

`SendInput` 插入系统 keyboard/mouse stream，API没有目标 HWND；已有按住键会影响注入，并有 UIPI 限制。不能以 SendInput/SendKeys/SetForegroundWindow 抢输入来满足当前目标隔离要求。[SendInput](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput)

Raw Input 是由设备注册和 WM_INPUT/HRAWINPUT 管道提供，字面 WM_CHAR不构成 Raw Input。IME通过应用与IMM/IME通信产生组合态，也不是发送已完成Unicode字符串。[Raw Input](https://learn.microsoft.com/en-us/windows/win32/inputdev/about-raw-input)、[IMM](https://learn.microsoft.com/en-us/windows/win32/intl/input-method-manager)

结论是当前约束下的实现限制：**只靠不改变前台、不向系统输入流注入的 HWND 消息 + UIA provider，不能保证任意 Windows 应用的组合键、物理键状态、Raw Input 或目标侧 IME。** 有些标准控件/应用能处理特定消息，不足以宣布通用能力；目标未公开 UIA动作时必须明确返回不支持。要扩大到这些目标，需其原生自动化/应用对象模型配合或另立真正隔离的交互输入 provider，当前源码没有这一模块。

## 可实现的最小方案

1. **直接用已有语义操作完成限定目标。** 模型和人通过 observe 的 exact elementId 发 `invoke(select_all_text)` 或 `set_value`；对保存/查找/撤销公开按钮使用 `invoke`。既有 worker、broker审批/receipt、epoch/generation/observed-provider 校验全部复用，无新队列、全局键盘或能力扩张。路径：`NativeDesktopAutomation.cs:561、648、668` → `worker/Program.cs:337、367–405` → `native-desktop-broker.ts` 原 dispatch → `native-desktop-tool.ts:237` / `BotNativeComputer.tsx:1220–1274`。这部分已经编码，可以直接使用；不能再计算为新通用 chord完成。
2. **若需要一个最小新增体验，只接 Ctrl+A 的全选意图。** 在人已明确选择且最新 semantic ticket 有效的 UIA控件上，将面板 Ctrl+A 明确路由为原 `invoke(elementId, select_all_text)`；实际 operation 和UI提示标为“控件全选”，不能发 modifier消息或伪称 Ctrl+A已输入。只有该 exact provider实际公开 select_all_text、非密码且完整Value/retained range匹配时可用；无当前明确控件就提示不支持。模型现有invoke无需改。此方案只需面板本地快捷键入口及最小验收，不改worker协议/能力，也不补 Ctrl+C/V/Z/任意选择。父任务未授权实现，报告不写生产。
3. **保持公开能力准确。** `keyboardInput:false` 与既有 messageKeyboard有限列表保留，工具与UI都说明 scope。CPU-04/17 的通用输入部分仍 partial；字面中文、27无修饰键、控件全选/赋值分别记录已有事实。不能将仅基础键实机通过合并成任意目标输入通过。

若以后实施第2项，最小验证只需要同一实际控件的全选、changed-provider/epoch拒绝、另一目标文本不变、没有系统input调用；复用既有 Windows selection fixture。当前 `tests/run-bot-windows-native-selection.mjs` 只验一项真实生产UIA/WGC选择，且会拒绝非Windows和skip，不能拿其一项当通用keyboard门禁。本次未执行它。
