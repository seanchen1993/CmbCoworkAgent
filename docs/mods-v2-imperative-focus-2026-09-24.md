# 主动 Pane 焦点 SDK

固定参考 Claude Code v2.1.278，声明头 2.1.277。新增 `await $.ui.focus({ requestId, key })`，返回 `{}` 或 `{ deny: string }`。只接受这两个非空字符串字段。此次为 **partial / bounded**：只支持当前插件拥有的桌面 Pane 中原生 Button、Input、Select；AbovePrompt、Client 内目标及非桌面 surface 仍未开放。Client 和原有自动聚焦/焦点事件继续使用原适配器。

## 执行与权限

宿主从已发布的当前绘制解析所有者和目标，绑定 Pane/generation 与一次性随机请求。renderer 先证明该 Pane 内当前焦点属于调用插件；宿主通过原 FunctionSession/dispatcher 执行 ui.focus 链。`next` 只准备目标，整个 Hook 链结束后才能请求实际 DOM 移动，因此 `await next(e); return { deny }` 不会先移动再假称否决。Hook 可选择另一个已绘制的本插件目标，不能更改主体、站点或来源。

renderer 再次检查当前绘制、真实键盘归属、窗口可见性、对话框、目标连接状态，以及人输入/焦点变动 epoch，实际调用 DOM focus 并确认 `document.activeElement` 后才回执。宿主收到匹配当前随机请求及阶段的回执才返回成功；发送请求不算完成，guest 不能补造实际确认。ACK 使用原线程 IPC 的独立入口，不排在正在等待它的回调队列之后。

取消、撤权、关闭、同 id 重开、重绘、超时、线程变更、renderer 重载及用户竞争操作会中止或拒绝旧请求。总等待上限 5 秒，每个 Pane 同时最多一个请求；最多 8 个 Pane。缺少 renderer 回执及不返回的 Hook 均不会无限等待。旧授权摘要因 host revision v55 失效，新增 SDK 需要重新授权。

## 忙碌期间的控件

Pane 的交互回调仍串行。忙碌控件通过 aria-disabled、输入只读及事件守卫阻止重复操作，同时保留键盘焦点，供当前回调完成焦点移动。其他 UI site 的原 disabled 行为保持默认；不能用全局解除禁用来绕过串行行为。原生 composer 和其他插件的焦点不会被接管。

## 验证边界

真实 QuickJS/FunctionSession 覆盖请求阶段、原 dispatcher、否决、取消与回调等待。Electron 使用生产 IPC/React/utility process，检查实际 activeElement、按钮回调到输入框、重复激活阻止、改选目标、编辑器归属、人输入竞争、renderer 重载、撤权及关闭对照，不调用模型。详见 output/mods-v2-validation 下本次报告。测试回执不等同于业务验收。

主动 `$.ui.scroll()` 的独立流程见[主动滚动说明](mods-v2-imperative-scroll-2026-09-24.md)。原 wheel 观察事件与主动操作仍分开标记兼容边界。
