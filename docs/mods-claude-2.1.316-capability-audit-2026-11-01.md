# Claude Code Mods 能力核对与本轮界面扩展

核对日期：2026-11-01。平台分支 codex/mods-v2，版本保持 2.0.0。本报告依据实际官方分发包和本平台代码，不以方法同名或声明存在作为全兼容结论。

本文保留首批审计时的差距及证据，后续非媒体补齐已到宿主 v95。当前可用范围以 [自定义说明](mods-user-customization-2026-11-01.md) 为准，修复与验收见 [第三阶段记录](mods-nonmedia-and-phase3-verification-2026-11-01.md)，不要把下面的历史待办当作当前缺项。

## 固定原版与验证证据

- 官方 npm registry 两次核对 latest 为 **2.1.316**；发布时间为 2026-10-31T00:42:05.743Z。搜索缓存仍有 2.1.314/312，未用于判断最新版本。
- 本机全局安装保持 2.1.295，没有原地更新、修改登录或读取凭证。官方主包和 win32-x64 包放在独立临时目录，两者 SHA-512 SRI 均与 registry 的固定元数据一致。
- win32-x64 tgz：155,916,373 字节，SHA-256 `5d55abc86c3b195baee646f2fddccfd8c05926c9bd329d1793206a408e8cd8a3`。
- 官方 exe：335,469,216 字节，SHA-256 `e896a9d8da519353a49bf69ca4a695ba7e09067752687c675b3969041e632d52`；隔离执行 `--version` 返回 2.1.316。
- 只读解析 PE 的 .bun 段模块表，提取 2,877 个模块；只解压声明资源，不执行提取模块，不声称还原全部原始 TypeScript。
- 该版本内嵌 Mods 声明 671,678 字节，SHA-256 `88e84a587572f4fe97df0f378d29d441ef267142b1ea8394aa95eb80ef08a14d`。公开 GitHub 声明当时仅 517,451 字节，不能代替本构建的声明。
- 在私有配置目录运行官方 `plugin validate` 通过，带目录提交政策提示；官方 `plugin test` 的实际 desktop `$.ui.mount` 接受本轮布局、字体和命名间距，**1 pass / 0 fail**。无模型调用、联网业务或文件处理任务。
- 初轮探针误用 `typeof $.ui.place` 做反射，被原版静态规则拒绝；保留 0 pass / 2 fail 的初轮日志。改成公开 ui.mount 绘图契约后通过，没有改动官方程序或放宽验证。

原始固定元数据、SRI、只读提取清单、实际声明、原版探针及初轮日志位于：
`C:/Users/87624/AppData/Local/Temp/claude-mods-capability-audit-20261101-9445d1a8`。

官方资料：[固定版本元数据](https://registry.npmjs.org/@anthropic-ai/claude-code/2.1.316)、[Mods 概览](https://code.claude.com/docs/en/plugins/mods)、[参考](https://code.claude.com/docs/en/plugins/mods/reference)、[界面扩展说明](https://code.claude.com/docs/en/plugins/mods/interface)、[插件组件](https://code.claude.com/docs/en/plugins/components)。参考网站部分表格晚于旧声明、早于实际新构建，差异以固定包为准。

## “开放 UI”与“组合插件”的区别

Mods 是事件中间件及宿主 SDK：可以改写或接管事件、注册工具/指令、调用模型、管理状态、绘制交互界面。插件承载和分发 Mods，也可装 Skills、传统 Hooks、MCP 等组件。组合已有插件仅是使用这些能力的一种方式，不能把创造者的目标缩成“组合几个插件”。

本平台已经开放 83 个可调用 SDK 方法名，覆盖会话、模型、工具、指令、提示词、进程、文件、HTTP、MCP 调用、状态/存储、计时器与界面；另有版本化 platform 能力与页面扩展。实际权限和调用场景仍逐项受控。官方 2.1.316 CoreEngineInterface 有 85 个可调用方法，另有 plugin.name/root 两个只读元信息。两个数字包含不同扩展和协议，不能据此计算“兼容百分比”。

UI 同样有实质能力：现有 13 个原生渲染点，加独立 Pane；公共表面支持 page、navigation、sidebar、toolbar、settings。声明树支持基础控件、Markdown、Svg、Client 以及本平台的 List/Table/Tree/Chart/Log/Form。它不是任意 DOM、CSS、Electron 或全窗口替换接口。权限确认和原生控制仍由受信宿主管理。官方也有界面边界，不能把“全面开放”理解为任意替换权限确认框。

## 对照结果

| 能力 | 本平台实际情况 | 后续边界 |
| --- | --- | --- |
| JS/TS Hooks、中间件、指令与工具登记 | 有通用引擎及原生宿主适配 | 逐个检查真实输入输出、取消、来源、重入和时间预算，不凭事件名称推断全部等价 |
| 模型/会话/提示词/文件/HTTP/进程/状态/计时器 | 已提供广泛 SDK；创造者可按需读取精确声明 | 文件、网络、进程和模型仍需真实权限与配额；复杂业务由插件实现 |
| Pane、消息/工具行重绘、问题展示 | 已有真实渲染点及原生内容保留机制 | 不能重写授权事实、伪造结果或吞掉必需的原生控件 |
| 公共 page/sidebar/toolbar/settings 与能力协议 | 本平台特有的通用扩展 | 与官方的 Pane/Placed 分别说明，不当作同名原版契约 |
| Box 布局与 Text 层级 | 本轮补齐受控布局、字体和命名间距，见下表 | 仍没有任意 CSS/DOM；hover/绝对定位/隐藏原生界面等未在本轮开放 |
| `ui.place` / `Placed` | **尚无等价 SDK**。官方将一条可交互绘图追加到聊天显示流，同来源+id 复用；不进入模型/转录文件，resume 不恢复 | `ui.log` 是日志，Pane/page 是独立视图，不能伪装成 Placed。需要新的聊天行归属、失效、压缩/重启及重绘生命周期 |
| `ui.view` | **尚无等价 SDK**。官方在用户动作中切换主会话/子 agent 转录，并影响下一次输入目标 | 需显式用户意图、真实 agent 身份及焦点/输入目标守卫，不能开放任意跨会话切换 |
| `ui.notify` | **尚无等价 SDK**。现有系统通知服务不是其 isSent 结果协议 | 需新 SDK 权限、原生通知成功/失败/受设置阻止的真实回执、撤权取消；不能别名为 ui.toast |
| `mcp.connect` | 已有受控实验宿主和测试，**生产 SDK 未开放**；mcp.call 可用 | 需只允许插件清单声明且已配置批准的服务，保持认证和管理策略，不接受任意新 server 配置 |
| `prompt.media` / `prompt.paint` | **尚无同协议 SDK**。前者仅在提交中读取附件媒体，后者只装饰匹配版本的输入草稿 | 原有附件事件/输入修改不能当作等价；需附件 id/来源/4MiB 上限与草稿版本、光标/撤销保护 |
| `session.identity` | **尚无同协议 SDK**；官方主要面向受组织管理安装的 Mod 返回登录类别及受限账号信息 | 需企业策略和最小披露，不向普通插件公开账号或凭证 |
| `env.set` | 有受控实验基础，**未列入生产 SDK** | 不能默认开放进程环境写入；需明确作用域、敏感键和子进程继承策略 |
| `audio.play` / `audio.speak` | **尚未提供**，不是浏览器播放控件的别名 | 需真实系统音频/语音适配、文件/网络来源、停止及平台差异处理 |
| `telemetry.log` / `telemetry.mark` | **未提供同协议**；平台有自己的诊断 | 官方第一方/组织 collector 语义不能复制成向未知端点上传；若扩展应定义本平台的明确目标和隐私边界 |
| ToolProgress、Raster、Image、`ui.blit` | 官方参考中的主要语义是 **终端** 的工具进度行、字符栅格/图像及局部重绘；本平台为 Electron 桌面 | 可后续提供桌面原生进度/媒体/高效绘图能力；Svg/Client 是已有途径，但不能据此声称这四项原版契约全部支持 |

实际声明的方法名差异还包括 plugin.name/root，但它们是元信息，不是缺失的可调用方法。本平台的 platform.*、prompt.attachment/context 扩展不计为官方新增功能。当前固定兼容配置仍为历史子集，不改成“2.1.316 全兼容”。

## 本轮已评审实施的通用扩展

两位 agent 分别确认具体白名单后实施；没有新增执行权限或业务分支。

| 元素 | 本轮支持 |
| --- | --- |
| Box | minWidth/minHeight、flexGrow/flexShrink、flexWrap、rowGap/columnGap、四边 padding、补齐三边 margin、alignSelf、反向排列、space-evenly、backgroundColor、overflow visible/hidden |
| 尺寸与间距 | 数字尺寸沿现有 ch/lh、间距沿数字×8px；尺寸字符串仅 0..100%；命名间距 xs/sm/md/lg/xl 为 2/4/8/12/16px；新增间距数值 0..128，flex 数值 0..100 |
| Text | size caption/footnote/body/heading/title 为 10/12/14/16/20px；weight regular/medium/semibold/bold；mono、tabular；truncate 等价现有 truncate-end，保留完整正文 |
| 兼容与边界 | 显式 weight 优先；没有 weight 时旧 bold 行为保留。拒绝 NaN/Infinity、未知枚举、calc/var/url 尺寸、任意 style/DOM/定位覆盖。新背景在普通绘图及原生行内标签中继续传递，避免黑底黑字 |
| 可发现性 | 创造者按需 SDK 目录提供精确 UiBoxProps/UiTextProps、固定单位和短布局示例；不再只给任意 key:string 导致编译通过但运行不画的错觉 |

原版实际声明的 alignSelf 未列 stretch，本平台把 stretch 作为明确的桌面布局适配值，不宣称该值是原版同协议。本轮未补 position/offset、hover、display:none、Text.dir/中段截断、Placed 等契约；后续应分别评审，不能放宽校验器后让宿主静默忽略。

## 迭代优先级

按用户后续补充，以 [最新迭代路线](mods-next-iteration-roadmap-2026-11-01.md) 为准：

1. 先贯通现有页面和能力，解决创作、导入、配置、试用、保存及正式使用之间的断层。
2. 再补齐页面、MCP、子会话等重要通用能力；Placed、通知按闭环需要安排，每项都要真实宿主实现及权限/生命周期保护。附件媒体及其他多模态暂不纳入。
3. 最后集中真实流程验收、多 agent 回检，再整理开发者能力目录、契约、脚手架与示例。开发期间保留必要窄回归。复杂业务和专用策略继续由插件开发者实现。

本轮对齐结论是“现有通用底座较广，补齐实用界面基础，并核清新版本缺口”，不是“全部底层能力已开放”。

## 验证

- 七个定向文件 87 项通过，覆盖真实 QuickJS 绘图、严格数据校验、布局映射、原生行内展示、按需声明分页和作者编译。后续整体回归由主任务记录。
- 新 `tests/mods-ui-layout-browser.spec.ts` 挂生产 Element 渲染器，1100/360px、面板/页面/侧栏/工具栏宽度容器中检查排版、颜色、完整文本、交互按钮及外层宿主关闭控件；不是四种表面的完整导航 E2E。
- 截图与报告在 `output/mods-ui-layout-browser`。未使用模型生成业务结果，未构建安装包。
