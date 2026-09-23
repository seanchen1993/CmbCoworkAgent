# Spinner、TurnDuration、SessionMode 桌面适配

本轮按本地固定版本 `C:/ai/claude-code-v2.1.278/mods/types/claude-code.d.ts`
中 RenderPropsOf 的 Spinner（7990）、TurnDuration（8019）、SessionMode（8074）
核对字段。三者都是桌面适配，不能把同名接口视为终端完全兼容。

## 真实挂载与默认内容

- Spinner 包裹 ChatContainer 的真实运行文案。原彩色动画和处理时长仍由宿主绘制。
  `word` 是当前桌面文案，`message` 为 null；文案已有标点，默认 `suffix` 为
  空字符串。`mode` 来自当前 live message 与 running tool 的桌面投影：没有输出时
  requesting、推理时 thinking、文本输出时 responding、工具参数时 tool-input、
  工具运行时 tool-use。这不声称复现终端内部每个流边界。
- TurnDuration 包裹 MessageBubble 中实际计算的耗时，传 `word` 与 `durationMs`。
  插件可改写这两个展示字段。虚拟消息列表没有终端行坐标，`onScreen` 不提供，
  也不接受插件伪造该字段。
- SessionMode 展示当前 AgentModeSwitcher 的执行模式标签。改写 `modes` 只改变
  文字；原按钮、ARIA 名称、锁定原因和权限控制保持宿主所有。自定义内容在按钮旁
  独立绘制，原文字变为仅屏幕阅读器可见，避免重复标签及嵌套交互控件。无定制或
  Mods off 时使用原按钮文字。此处没有虚构 focus/memory paused 等其他模式状态。

模块不匹配或调用 `next(e)` 保持默认树时，FunctionUiSites 在最终 publication 后
与宿主默认树精确比较，生成 `nativeFallback`。渲染器据此保留原来的丰富控件。
标记由宿主最终覆盖；插件 publication 填写该字段不能控制其值。

## 生命周期与边界

TurnDuration 支持每个 FunctionSession 最多 32 个同时挂载的 owner；超出容量时
不驱逐已有可见消息，新增位置恢复原生内容。其他位置仍是每种组件一个 owner，
因此本轮六个位置总上限为 37。每个 owner 使用独立 FunctionPanes 意图账本、随机
generation、回调和取消生命周期，沿用 FunctionSession 与 ModsManager 入口。

卸载会取消该 owner 的进行中操作；其他可见消息不受影响。跨 owner 的回调、旧
generation、虚拟列表已回收行的返回结果均不能作用于当前行。配置关闭或运行时
撤销仍走原会话清理。此处不支持 Client；命令式 focus/scroll 仍仅 AbovePrompt
适配，不把新增展示位置视为新的执行或授权入口。

## 验证层级

`sites.test.ts` 运行真实 QuickJS guest / FunctionSession，并编译实际安装探针。
覆盖多 owner、32 个容量、跨位置/过期操作、卸载取消、字段规范、默认保留及
publication 伪造拒绝。渲染器窄测验证安全树、原控件与晚到结果生命周期。

`tests/support/mods-status-sites-e2e.ts` 使用公开 preload、实际 composer、主 runtime
和现有本地 HTTP 模型。它建立独立项目和线程、安装并授权探针，产生两轮真实
对话后检查多个耗时位置，再记录默认/自定义/off 的真实 Spinner 和模式截图。
helper 的就绪不等于 Electron 已通过；最终运行结果见对应 Electron 报告。

本轮未运行安装包、正式性能矩阵或长时间应用 soak，不将此前不同快照的性能
结果用于宣称这三个位置已经通过性能门禁。
