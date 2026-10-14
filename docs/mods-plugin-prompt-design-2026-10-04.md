# 插件主动发起聊天：阶段19设计

目标持续进行中。工作目录为 C:\ai\CmbCoworkAgent-mods-v2，分支 codex/mods-v2；UAT 只读。两位独立评审已正式通过修订方案（official_mods_review、latest_mods_binary_review）；实现进行中，不是完成声明。SDK 子提交直接进入已注册 Session 的内部 dispatch，不能等待自己的 Session.start；自动配置候选的原禁副作用仍保留。

## 用户会得到什么

自己的组件检查到新情况，或者用户点击组件按钮后，可以把一条任务交给当前对话继续处理。当前任务正在运行时先等待；空闲后开启新的完整聊天轮次。用户沿用当前对话的模型、项目设置和原有批准方式，不需要把文字手动复制进输入框。

它与独立模型分析不同：独立分析只给组件返回结果，主动提交则让当前聊天接着处理，并留下可见记录。它与“引导当前任务”也不同：不会把任务塞进正在运行的回答，更不会打断桌面、IM、Flow 或 Goal 的工作。

## 官方依据与尚需实证的边界

固定 2.1.289 包内声明 SHA256 和原版测试目录见 mods-latest-289-audit-2026-10-04.md。PromptSubmitArgs 8510 行附近、PromptSubmitInput 和 turn.start 的顺序声明是本次依据。[官方 API 说明](https://code.claude.com/docs/en/plugins/mods/api)明确：等待会话空闲后开启新轮次，返回时点为轮次开始，运行中的 Hook 不应等待这次提交。

SDK 只收 text 和可选 asUser:true；非空附件尚无实际传输来源，必须拒绝，不能伪造文件内容。origin、turnId、wait、context 不由 SDK 作者提供。来源固定为实际插件，asUser 只去掉模型读到的插件来源句；Hook、记录和权限仍保持插件来源，不能变成人的点击、批准或工具写入授权。文件引用和图片不按用户输入展开。

原版 testkit 可核对来源、精确跳过调用 registration、返回与参数形状；其底层需要测试替身，不证明真实空闲调度或轮次开始。真实启动、HTTP 和记录必须由本工程的实际 Electron 验证。

已完成固定原版探针：`output/mods-289-prompt-submit-held-core.log` 的8项检查确认调用时立即进入提交链、精确跳过调用规则、同插件其它规则继续执行、asUser 和最终答复省略 origin，以及来源规则正常返回或抛错后子提交仍在运行。`output/mods-289-prompt-source-ui-fifth.log` 的14项实际断言确认 ui.render、真实 onPress、ui.press、真实 Client 消息允许调用；command.run、prompt.submit 的 void 和 await 均被宿主直接拒绝，捕获旧界面 SDK 再在命令中调用也不能绕过。第五轮给这两个捕获 SDK 用例补齐零 child core 与实际 host check 断言；第四轮最后两个只有诊断计数，不能当成完整断言。前两次夹具未通过原版静态编译，第三次仅诊断，失败日志保留。

独立来源矩阵 `output/claude-code-2.1.289-alignment-analysis-2026-10-04/prompt-submit-source-matrix-review.log` 的12项检查还确认 session.start、turn.start、实际拉取的 turn.step 和 clock.after 真实回调允许调用，tool.call、prompt.compose 被宿主拒绝。允许调用不表示运行中的规则可以等待自己的下一轮：真实开始仍依赖原轮退出，官方对此提醒仍成立。

真正 Stop/卸载的原版取消对照尚未得到。独立上层先返回探针额外等待30毫秒仍未观察到源 signal 或子 signal 被取消，不能把它说成已验证真实取消。故本工程以实际生命周期和权限清理未开始意图，不把正常 frame 收尾、可选规则抛错或错误文字当作取消证据。这一边界作为适配限制明确记录，不声称原版取消完全一致。

## 基础设计

1. **专用队列与三个时点。** 实际 Session 根据当前真实 plugin 对象、registration、Session 实例、配置代际、批准与线程 incarnation 接纳子调用，先给私有 child-dispatch ACK；这不是 core 入队。第二时点为当下提交规则真正 next 到 core，才形成私有不可变队列记录；FIFO 按这一接纳顺序排列。第三时点为真正启动，SDK 公共 Promise 等待 started 或最终未接纳答复，不能把 AgentRunHandle、child-dispatch ACK、core 入队或数据库写入冒充轮次开始。全局最多64项、每个对话16项、每个插件每个对话8项；同一项目与插件每60秒最多20次接纳，代际重载不能清零这一频率预算。未到 core 的 pending child dispatch 也受64个既有资源/插件以及提交总量预算约束。禁止自动重试或重复发送；频率清理在访问时执行，不添加常驻定时器。排队记录在内存中保存，重启清理且不自动重放。
2. **支持不等待的提交。** 当前普通 SDK 调用会在原 VM frame 结束时取消，直接调用现有桥会丢失官方 void 用法。新增专用 guest 桥：原 frame 未等待工作只等待第一时点 child-dispatch ACK，不等待完整规则链或 core enqueue。已接纳 child dispatch 的规则链当下独立推进，即使规则链还等待受控下层、来源 frame 正常返回或抛错，也继续归 resident Session 所有。公共 Promise 通过私有资源通道等链最终未接纳答复，或已接纳意图的真实 started；不能重新使用旧 frame、旧点击或旧 main authority。来源判定使用当前实际调用入口，command.run、prompt.submit、tool.call、prompt.compose 以及嵌套仍持有这些入口的调用直接拒绝，不因 void 或捕获旧 SDK 放宽。未实证来源先拒绝并记录待支持项。真正撤销、退出、配置变化与线程失效清理未开始项；已启动项保留真实事实并沿用原运行取消处理。资源等待本身记为可关闭资源，不能占用配置重启所需的前台空闲名额。运行中的允许规则自己 await 导致自等待，保留官方用法边界和原有总期限，不偷偷改为 steer。
3. **真正空闲后执行。** 同时核对物理运行占用、真实运行收尾与逻辑 turn/Goal。订阅唤醒后再检查，原子申请自己的 mods 物理占用；不接管或中断任何旧 owner。每个意图开始前再核验原批准、代码摘要、线程对象、工作区、配置代际和实际 Session 身份；等待期间更改配置、重载、撤权、删除或退出会清理未开始项。活动 Goal 持续等待，不在其两次调用之间抢跑。确无对应普通聊天入口的特殊会话先明确拒绝，不能默默换一个会话执行。
4. **复用真实聊天运行。** 增加仅主进程可提供的 plugin prompt 运行上下文，使用 AgentRunService 的原标准聊天路径，自己的物理占用、取消与权限；固定 userInitiated=false。不能复用 submitComposerPrompt，它明确建立 userInitiated:true 的用户准备入口；也不能仅增加一个 source 字符串就视为权限闭合。新入口由私有宿主回执建立，原字段不可由 SDK、renderer 或正文给出。正文在原入口的 Goal 命令、模式前缀、Skill 标记、协调器内部通知解释之前被识别为插件文字，不从正文升级权限或更改会话模式；规则重写后的 accepted 正文也不重新解释为这些特殊操作。正常项目、原 Plugin/Harness 配置继续由原路径读取。SDK 不接受 renderer 给出的来源或运行票据。
5. **一次真正接纳。** SDK 调用当下进入同一 prompt.submit 规则链，不延迟至空闲后检查。由私有插件准备入口提供文件只读准备能力，固定 userInitiated=false，不借用运行中主 Agent 的写权限；结束即释放该准备入口。精确跳过调用的 registration，同插件其它规则仍执行。core 多次 next 只登记一次不可变内存意图，文字、隐藏 context 与宿主 origin 一起保存；规则链结束后确定模型来源句的展示，再开放该意图给队列。等待阶段不写当前线程消息、不接入旧 run 的队列，避免与父轮 assistant/checkpoint 持久化交错。空闲真正执行时，实际文字与插件来源在同一主数据库事务持久化；context 单独进入模型，不泄漏到可见聊天。没有 core 接纳的 drop/没有 next 不写消息、不调用模型；next 后最终改写/drop 不撤销已接纳事实，也不替换实际文字/context。公共返回保留合法最终规则答复，实际副作用另由已接纳事实决定。原经典 UserPromptSubmit 拒绝仍按原运行行为反馈，不能用回滚猜测隐藏事实。
6. **独立开始回执。** core 接纳立即返回，不等待后续 turn.start。提交链与原经典策略完成后，在真实 logical turn/物理 owner 建立的入口报告开始，公共 SDK Promise 此时返回；不等待首 HTTP、审批或完整回答。所有提前拒绝路径要终结等待者，不让无回执永远挂起。运行结束仍使用真实 completion/terminal 收尾，释放物理占用。固定包内声明同时允许 Hook 的最终合法答复省略 origin，使模型省略来源句；因此持久 hostOrigin 与模型展示决定分开保存。模型按 asUser 或合法的最终 origin 省略决定是否加来源句，但实际提交正文和 context 仍采用 core 已接纳的版本，next 后修改不能替换它们。省略来源句不能去掉持久插件来源，也不能提升权限。此语义需原版探针和真实 HTTP 正向验证。
7. **可见、可恢复的来源。** 主数据库保存宿主来源，UserMessage 从真实来源读取，不能再统一 unclassified，也不靠正文前缀猜。页面重开仍能看到是谁提交的；asUser 不去掉这份来源。模型收到明确的插件来源句，asUser 或合法最终答复省略 origin 时只省略该句。沿用现有真实 HumanMessage 的模型/可见正文分离，使后续轮次、checkpoint 恢复也保留隐藏正文与可见正文差异；LC 显示标记不是权限来源。既有无来源消息继续保留 unclassified，不补造历史作者。来源与消息删改/别名/分页/恢复生命周期一致，不能产生孤立身份或把 renderer 自报字段当可信来源。

## 必须验证

- 固定原版实际参数、来源、asUser、Hook 最终答复省略 origin、调用 Hook 跳过及正常 frame 返回后的 void 行为；明确 testkit 与真实启动证据区别。
- 实际 QuickJS：void 不丢；已接纳 ACK 不是 started；等待中的公共 Promise、早期拒绝、重复 next、容量和限流；原规则与同插件其它规则生效。
- 真实普通聊天：忙时零新 HTTP、不打断原回答；空闲后恰好一次新轮次；started 早于回答结束；原模型、项目、Plugin/Harness、输入和队列可继续使用。
- rewrite/context/drop/no-next；模型中的来源句与 asUser；可见与重开后的插件来源，隐藏 context 不显示；@file、模式/Goal/Skill/内部通知文字不取得特殊执行权。
- 撤权后重授、代码替换、线程 ABA、Session 重载/退出、取消、错误 ACK、迟到结果、旧物理 owner 的反例。实际取消前未启动的项不执行，已启动项保留准确的接纳事实和原运行取消行为。
- 受控广域、Node/Web 类型、本阶段 lint；真实 Electron 截图和 HTTP 记录；隔离性能验证排队不进行模型/文件查询、不忙轮询、不增加普通聊天的常驻定时器。

方案和实现分别取得两位独立正式检视。完成后继续完整原生 engine 节点与构造器替换、消息追加及其它仍可适配能力；本项和那些项目均未确认存在框架限制，不在阶段边界停止持续目标。
