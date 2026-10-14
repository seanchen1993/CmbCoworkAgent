# 保留 Goal 记录时，普通聊天仍应用输入规则

工作目录与分支：`C:/ai/CmbCoworkAgent-mods-v2`、`codex/mods-v2`。

## 实际问题

当前 `src/main/ipc/agent.ts` 的普通文字入口要求当前对话没有任何 Goal 记录。
因此用户暂停或完成一个目标以后，即使是在普通聊天中发送文字，组件的
`prompt.submit` 规则仍不会处理；同一入口的文件发送已经按“没有活动目标”判断。
这是真实使用缺口，不是 Claude 内部行为差异。

## 最小实现

仅调整原提交入口这一段：两种发送都要求当前 Goal 不处于 active。
复用原 `readGoalMutationSignature`、`isGoalMutationSignatureCurrent`，
在进入处理前记住当次目标记录，在原 `assertSubmissionOwner` 中同时复核其当前状态与签名。
不增加资格表、公开回执或替换原模型、文件及消息保存流程。

普通用户消息原先会暂停活动目标，这一操作和先后顺序保留。
`/goal` 控制、目标自动续跑、内部通知、协调模式及没有真实输入框来源的请求
不借此变成普通文字发送。原物理运行、线程身份、项目、取消和文件检查全部保留。

组件等候时若当前目标新建、恢复、结束或清除，原提交守卫按已有签名规则拒绝，
不提交旧结果。签名是原入口已有的数据核对，不把它宣称为新的全 Goal 事务隔离。

## 评审与验收

实现前两位独立评审，生产代码只改一个入口段；回归和桌面测试补在实际现有链路。
证明：暂停和完成目标后普通输入能改写，附加背景仍隐藏，用户消息只保存一次；
规则拒绝不发模型、不保存新用户行；处理等待期间目标变动拒绝旧结果；
活动目标遇到新用户消息仍先暂停，`/goal` 控制与自动续跑不重复经过普通输入规则。
保留原等待上限及普通聊天、原 Goal 和文件引用回归。

这一步不替代其他输入来源、协调子任务或声音等完整能力目标，后续继续逐项接通。

## 10 月 7 日实际验收

两位独立方案和源码评审均通过。四个完整邻近测试文件共 20 项通过，
原 `goals.spec.ts` 和 `submit-in-flight-lock.spec.ts` 通过，主进程和界面类型检查通过。
四个本轮文件 lint 为零错误；历史格式警告未做无关批量修改。

真实 Electron continuity 全部 11 项通过，原八项保留，新增三项分别证明：
真实暂停目标后的普通改写和拒绝、真实完成目标后的普通改写和拒绝、
处理规则等待中清除目标后旧结果不能发送或保存。背景文本保持隐藏，用户消息只保存一次。
桌面运行结束后已恢复普通构建，普通产物没有测试专用入口。

证据：`output/stage25-goal-ordinary-submit-desktop-20261007/continuity/result.json`、
`output/stage25-goal-ordinary-submit-desktop-current.log`、
`output/stage25-goal-ordinary-submit-narrow-current.log`、
`output/stage25-goal-audio-lint-fixed-current.log`。
测试记录中的时间是累计场景耗时，不作为单次发送的性能结论。
