# Bot 工作区交互覆盖复核

2026-11-18，Asia/Shanghai。本轮检查上次独立任务与例行任务修复覆盖了哪些入口，重点比较私聊、招乎群、普通对话和项目 Feature。除新增本记录，未改产品或仓库测试脚本。[上轮五项修复](2026-11-18-work-routine-ux-fixes/README.md) · [详情导航基线](2026-11-18-details-navigation/README.md)

## 已复现的交互差异

在本地 Electron 中，用已绑定的模拟招乎群同时提供一条名为“每周设计复盘”的日程和一条普通群消息“已创建例行任务「每周设计复盘」。”。群消息可见，消息内可操作的按钮和链接共 0 个。从同一群的右侧列表点击编辑，编辑器读到的名称为“每周设计复盘”。页面错误为 0。

这个差异发生在 App 的招乎群主消息流。私聊的工具回执会按日程 ID 打开编辑器。群消息流支持独立任务引用和附件，当前群历史条目却没有日程引用。复测使用合成消息，实际内网的消息格式和招乎客户端展示仍待验证。[私聊回执渲染](../../../src/renderer/src/components/bots/BotConversationTools.tsx) · [招乎群消息渲染](../../../src/renderer/src/components/bots/BotImConversation.tsx) · [群历史条目类型](../../../src/shared/bots/mock-channel.ts)

## 本轮测试

集成分支 `codex/merge-uat-into-bot-beta`，基线 `fd5176760` 加当前工作区改动。macOS 15.4 arm64，Node.js 22.23.5，Electron 39.8.10。真实桌面用例复用上轮 20:49:35 的隔离构建，渲染器 JS 和 CSS 的 SHA-256 前缀分别为 `7a76e604564922d4`、`7da9838bc32009d0`。组件用例从本轮源码构建，用模拟宿主和合成数据。模型与内网服务不在本轮测试范围内。

仓库已有 8 组用例中，6 组有完成记录，1 组超时，1 组提前结束。上面的群消息观察单列。使用 Node.js 22，以 `node --import tsx tests/<用例名>.spec.ts` 执行下表各组，桌面用例的 `BOT_TEST_APP_OUT` 指向同一隔离构建。界面用例最多 3 组并发，下表用时为脚本总耗时。

| 用例 | 实测 | 退出码 / 用时 |
| --- | --- | --- |
| `bots-feature-panel-browser` | 私聊与群的手动创建、群归属、解绑只读、跟进 Feature 并打开会话，完成 | 0 / 3.70 秒 |
| `bots-question-draft-browser` | 消息离开可见区再返回以及私聊与任务切换时的提问草稿、提交和取消，完成 | 0 / 4.06 秒 |
| `bots-skill-settings-browser` | 创建与编辑 Bot 的技能选择、失效技能、保存失败和读取目录失败，完成 | 0 / 2.28 秒 |
| `bots-im-dialog-browser` | 招乎绑定、选定群后的替换和重试、旧网关能力回退、回复状态，完成 | 0 / 2.93 秒 |
| `bots-group-file-history-browser` | 成员移出或删除后仍可查看历史文件，群资料列表、预览和导出路由均完成。使用模拟原生文件接口 | 0 / 7.73 秒 |
| `im-remote-approval` | 本地 IM 远程审批服务，输出套件完成标志 | 0 / 1.82 秒 |
| `bots-conversation-link-app` | 已关联原普通会话，随后第 445 行查找旧页头中的工作目录按钮，等待 30 秒超时。控制权、解除关联及完成后继续的后续操作未走完 | 1 / 35.17 秒 |
| `im-feature-binding-command` | 注册 22 项，只打印第 1 项通过，没有套件完成标志。不能将剩余 21 项计为通过 | 0 / 1.78 秒 |

`im-feature-binding-command` 的首条通过输出为 `PASS testSessionCodesSelectExactThreadsAndRecheckLiveGrants`。改用仓库的 `tsx` CLI 独立复跑，开放测试所需的本机 IPC 后，仍在同一条输出后以 0 退出。另加进程结束观察，事件循环排空时未出现预期的 `im-feature-binding-command.spec.ts passed`，再保留进程 10 秒也未等到，观察程序以 2 退出。当前证据能定位覆盖中断的位置，尚未确定第二项内部的原因。[IM Feature 命令用例](../../../tests/im-feature-binding-command.spec.ts)

## 仍欠缺的桌面验证

| 入口 | 已有证据 | 待补的操作 |
| --- | --- | --- |
| 普通会话关联独立任务 | 上轮按新菜单可以查看并复制原目录。本轮已关联同一条既有会话 | 从现有“更多任务操作”菜单继续，把获取与归还控制权、解除关联、已完成任务继续处理走完。[上轮定向复测](2026-11-18-work-routine-ux/README.md) · [桌面用例](../../../tests/bots-conversation-link-app.spec.ts) |
| 例行任务的特殊状态 | 创建、折叠项定位、编辑和删除有桌面证据，续期和撤回有逻辑测试 | 从编辑器给已过期的日程续期、撤回本次待执行项、更换观察任务并重新打开核对目标与通知条件。[编辑器](../../../src/renderer/src/components/bots/BotScheduleEditor.tsx) · [状态测试](../../../src/renderer/src/lib/bot-schedule-panel.test.ts) |
| 项目 Feature 与招乎 | Bot 侧的跟进、会话导航和本地远程审批分别测过 | 从项目创建页或详情页关联 Bot，启动托管，在招乎处理阶段确认，再回项目核对阶段与后续运行。另需让 IM 命令回归能证明整组完成。[项目端入口](../../../src/renderer/src/components/harness-board/HarnessBoardView.tsx) |
| Bot 设置、App 群成员、资料库 | 设置卡片、群成员列表、群资料预览及导出路由已有覆盖 | 尚缺本版打包后归档与恢复 Bot、实际增删群成员直到只剩一位、通过系统文件选择器导入并分享给另一个 Bot 后在接收方打开的完整证据 |

此前已测浅色、深色、窄栏和浏览器接管归属。本次本地结果不能验证 Windows 的真实窗口前置和内网招乎客户端的卡片点击与回执。
