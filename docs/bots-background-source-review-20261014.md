# Bot 忙时交互与后台执行：源码复核

日期：2026-10-14。用于修正一期实现，不能作为整体验收通过记录。

## 证据边界

- Grok 参考目录是 `/Users/chenqiang/Desktop/AI/grok-bot-0.18-reconstructed-main`，属于 0.18 重建源码，不能当作当前官方服务端的完整实现。
- Hermes 参考目录是 `/Users/chenqiang/Desktop/AI/hermes-agent`。以下结论针对本地文件；没有据此声称所有运行后端都支持相同能力。
- 官方 Grok 0.70.2 的 1014V5/V6 实屏记录已验证：后台命令尚未结束时能回复新问题，之后交付文件。CMB 1014W 只验证了单任务交付；1014X/Y 暴露了编排脚本错误，不能计为忙时对齐。

## 已读到的真实机制

| 环节 | Grok 重建源码 | Hermes | CmbCowork 原有能力与缺口 |
|---|---|---|---|
| 长命令 | `source/box-exec-daemon/server.ts:363` 的 `spawnBackground` 直接启动并登记进程，返回 shellId/PID，stdout/stderr 写终端文件，close 写退出信息。没有要求先创建工作流或子 Agent。生产本地执行的资源接线见 `source/local-exec-daemon/production-executor.ts:295`，不可将简化 box 实现等同于官方所有后端。 | `tools/terminal_tool_background.py` 的 `spawn_background_process` 通过进程注册表启动，返回 session_id/PID；按会话能力启用完成通知。 | `src/main/agent/local-sandbox.ts:6905` 已有 `executeBackground`、独立 AbortController、输出上限、审批和进程树清理，应优先复用。当前 Bot 的主会话拦截后转 workflow 是实现选择，并不是 Grok 的必需流程。 |
| 新消息 | `source/host/extensions/transcript/send-turn-dispatch.ts:111` 保存恢复消息，129 行中断旧模型轮次并在后续独占执行中接收新用户消息。中断模型轮次不等于关闭整个进程执行服务。 | `agent/interrupt_control.py` 区分 interrupt/hard_interrupt/steer/redirect；`tools/terminal_tool_background.py:235` 的本地 yield handler 接管仍在运行的前台进程，立即返回已有输出并保留进程。远端后端不支持时不伪装成功。 | 原 `agent:queueCurrentRunMessage` 有轮次、Hook 和队列所有权检查。经跟踪 `startAgentRun` 和真实 AC 验收，托管 Bot 也进入同一 activeRuns；缺口是缺少宿主入口和收件消费回执，不能把 activeRuns 的存在当成桌面身份。本轮提取共用处理函数，按精确 owner/runId 校验，Bot 从主进程服务调用。 |
| 完成回传 | `source/host/extensions/transcript/completion-revivals.ts` 将 shell 与 subagent 完成分别收集；`buildShellRevivalPrompt` 要求检查输出、继续工作或交付，并抑制无意义重复通知。 | `tools/process_registry_notifications.py` 保留会话及 completion 身份，过滤已消费结果、合并连续完成通知；本地 yield 后也沿原完成路由通知。 | 原 LocalSandbox 完成结果供 `task_output` 读取，10 分钟后清理；尚未直接连到 Bot 的持久通知队列。现有 Bot 通知接线只覆盖 workflow/coordinator，不能冒充进程通知。 |
| 停止 | 对模型轮次的 supersede 与执行服务 stop 的职责不同；不能照搬 Linux 的进程组实现到 Windows。 | 显式 hard stop 与新消息触发的 yield 分开；进程归属和完成通知都保留会话标识。 | 原 `cancelBackgroundTasksAndWait` 等已处理进程树结束与数据清理屏障。Bot“停止”需要覆盖归属该会话的原生后台命令、worker 和 workflow；新消息不应被一律解释为停止任务。 |

## 实现决定

1. 普通长命令走原 CmbCowork 进程管理能力，不为每条命令新增子 Agent。刚尝试的 `background_task -> workflow agent()` 薄适配层已撤回，未作为已交付能力。
2. 下一项是把原 `executeBackground` 的接受、结束、取消状态接入 Bot 持久收件及通知：启动前记归属，结束后保存结果并去重唤醒；重启后对未知结果明确对账，不重新执行外部动作。
3. 补充消息与“停止”分别设计。复用原 Runtime 轮次/租约/消息约束；需要命令 yield 时沿原进程实例移交，不能重新启动同一命令。Mac/Windows 的支持范围分别验收。
4. 原 workflow 保留用于真实编排需要，原工作台模式保持原语义；它不是 Bot 用户需要配置的产品模式。
5. Bot 默认聊天展示任务进度、审批、结果和成果文件；开发者运行明细放到已有执行详情入口。不得仅隐藏失败提示来制造对齐效果。

## 当前未完成，必须实测

- [x] 原生后台命令接受记录、结果持久化与通知接线；90 项针对性测试通过，真实模型待验收。
- [x] 1014Z：原命令仍执行时第二问回复 25，随后主动交付，未重新启动原命令。一般前台命令的 yield 仍未完成。
- [ ] 停止后确认进程树结束，不自动唤醒重跑；其他 Bot/群任务不受影响。1014AB 已实测 Mac 单一 Node 进程停止；作用域隔离通过定向测试，复杂子进程及 Windows 实机仍待验收。
- [ ] 重启、通知重复、接收与停止竞态、文件交付以及 Mac/Windows 验收。
- [x] 移除 Bot 后台命令强制转 workflow 的临时路径；原执行工具与通知接线已替换，提示词和命令语法契约通过，整条真实链路仍待验收。

## 本次接线进展

原生后台执行已由真实 MiniMax 的 1014Z/AA/AB 验证：忙时答复、自动附件交付、显式停止；范围为 Mac 单进程。私聊补充消息现在复用 Cmb 原队列的 Hook/租约/持久化机制，宿主在模型消费前记录任务归属。1014AC 已验证前台命令执行期间收到的补充要求在下一模型步骤生效，原命令只运行一次；1014AD 已验证升级后停止实际进程且超过原截止时间仍无目标文件。未引入 Workflow/Team 产品模式。普通前台进程的即时 yield 仍是缺口，AC 并未证明这一点。

## 2026-10-14 补充：Grok 是否也移交正在执行的前台命令

结论：本地 Grok 重建源码明确提供这条路径，不仅 Hermes 有；但不能把它扩大为当前官方版本对所有工具调用的保证。

- `source/packages/local-exec/shell-stream.ts:22–34`：`BackgroundableIterator` 在等待输出时响应后台请求；`handoff()` 把尚未消费的输出 Promise 和同一个迭代器移交。`forceBackgroundByToolCallId()` 针对原 toolCallId 请求后台化；随后 `background.adopt()` 传入原 PID、stdin、AbortController、已有输出及原事件迭代器。
- `source/packages/local-exec/background-shell.ts:114`：`CoreShellFactory.adopt()` 继续消费传入的迭代器，不再次调用启动进程的 `core.execute()`。后台完成状态和通知沿原管理器处理。
- `source/packages/agent/actions/user-message-action/interrupted-tool-reconstruction.ts:92–110`：被用户打断的工具若已有 shell 移交回执，恢复为有效工具结果；交给模型的结果明确标注 `autoBackgroundedForInterruption`。未成功移交时仍输出中断错误，不伪装后台成功。
- `source/packages/agent/tools/core/shell/formatters.ts:184–193`：明确描述命令因用户打断聊天而自动转后台，并提醒模型判断新要求是否意味着应取消旧命令。
- 适用条件：本地 shell 路径须支持后台化（该实现使用 `TimeoutBehavior.BACKGROUND`），且原调用仍可找到。普通取消、硬超时及不支持移交的工具走各自中止逻辑。

官方 0.70.2 的既有实测只证明“已在后台的命令继续运行，同时回答新问题并在完成后交付”；AC 对照的补充消息实际到达较晚，不能证明官方“前台转后台”链路。本项需要单独验证，不能仅凭源码勾选核心验收。

本地实现继续优先复用 Cmb 的实际进程、审批、Hook、输出上限及终止屏障。需要先确认移交后这些所有权仍然有效；不能仅用 Promise.race 提前返回，让原执行失去取消、完成通知或权限检查，也不能重新执行原命令来伪装移交。

## 1014AE／AF 实测更新

Grok 官方 0.70.2 的 AE 先回复 25 并声称原命令保留，随后主动更正为原进程约 58 秒时被中断、无结果文件；这是官方界面中的模型报告，未直接检查云端进程。源码的条件式移交不能视为当前官方每次调用的保证。

CMB 的 AE2 到达较晚，不能证明移交；其错误声称进程仍在的问题已记录并补充提示词约束。AF 则在 180 秒命令仍执行时成功答复：现场检查同一 PID 89042 存活、启动记录仅一行、结果尚未生成；后续无需新消息便通知并交付 AF_FINISHED。数据库确认一条命令完成通知，原任务和注入消息完成；实屏已打开成果预览。前台移交在 Mac 主执行链已得到真实 MiniMax 证据，Windows、只读子 Agent／工作树边界及完整停止恢复场景不在此结论内。

实现复用原 LocalSandbox 的同一执行 Promise、进程、审批与 Hook；独立取消控制器只在持久移交成功后脱离原模型轮次，命令执行原有超时及显式停止继续有效。完成后沿原 Bot 通知队列交付，不建立第二套执行服务。

## 首次对话复用（1014AI／AJ／AK）

另核对 Grok `source/host/extensions/transcript/agent-lifecycle.ts` 的 `mintAgentSession`／`kickstartAgent`：持久 introduction_pending，新用户消息存在时跳过欢迎，使用隐藏 cue 调起同一个 runner；`shared/agents/onboarding.ts` 要求简短自然开场、有具体职责时直接工作。本地实现复用 BotStore 事务和 LocalBotHost 队列、原 Runtime 隐藏消息标记；旧 Bot 升级不补发，已触发状态不随历史清理丢失。用户插话仍使用原注入机制，身份／例行修改仅在真实用户消息已注入后授权。

AJ 实测暴露隐藏 cue 不存在于可见 transcript，却被用作插话排序锚点；已复用共享 `isInternalNotificationMessage` 在队列中跳过该类不可见前驱，未伪造可见用户历史。AI 欢迎及重开去重、AK 欢迎期间真实 MiniMax 改名和计算通过；复杂职责自动执行仍待验证。

## 官方 0.70.2 动画与外观补充核对

只读检查本机 `/Applications/Grok Bot.app/Contents/Resources/app.asar` 的当前前端 bundle，未把闭源 bundle 复制进项目：

- `dist/renderer/assets/index.eager-platform-DUN5VkaE.js`：当前头像引擎按状态选择 Idle、Working、Streaming、Done 等动作片段，并分别维护表情、身体变形、播放暂停、指针跟随和减少动态效果。writing／searching／waiting 使用不同变形；不能把旧 0.18 重建版或当前 Hermes 眨眼／摆动近似当作完整复刻。
- `dist/renderer/assets/index.eager-app-fbmFpqqH.js`：头像由活动、等待输入、运行与正在发言的状态共同驱动。颜色设置同时区分头像与用户聊天气泡，不是所有会话固定彩色。
- 官方设置实屏确认：外观的“强调色”有“黑色”和“Bot 颜色”两项，当前选择 Bot 颜色；本轮只查看，未修改官方设置。CMB 当前固定灰色气泡缺少对应选择入口，作为 UI 缺口继续处理。
- 1014AM 官方执行合成等待任务时观察到活动头像与“正在记下来”，最后 AM_DONE；CMB 1014AN 已使用原 Runtime 的活动／审批状态呈现头像和文案，但身体变形及完整状态动作仍未对齐。

## 真实进程恢复补充（1014AO／AO2）

实际 MiniMax 后台启动一次 Node 脚本，主进程 SIGKILL 后重启；原 PID 98296 继续运行，启动记录只有一行。恢复仅创建一次 outcome_unknown 通知，MiniMax 检查已有输出后说明结果未知，不重跑。原子进程随后独立生成 AO_FINISHED；第二次重启不重复通知。AO2 读取原文件并交付，界面打开结果已确认。此结果证明不盲目重放和通知去重，不能证明崩溃后重新获得旧进程的停止／输出控制权。证据位于隔离测试目录 `quality-review/1014AO-real-restart/`。
