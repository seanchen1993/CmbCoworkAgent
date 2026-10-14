# Autobiz · 我的 Claw 实操图册

2026-09-28 在开发工作区 `C:\ai\CmbCoworkAgent-mods-v2` 实际操作，21 张截图均为本次真实应用窗口截图。

[打开可翻阅与放大的图册](C:/ai/CmbCoworkAgent-mods-v2/output/claw-walkthrough-20260928/演示图册.html) · [完整安装包](C:/ai/CmbCoworkAgent-mods-v2/output/claw-walkthrough-20260928/package/AutobizDevOps_Plugin_Kanban_Mods.zip)

本次用独立本地配置与订单导出演示工程；未改用户正式项目配置，未调用在线模型。演示业务代码故意带有错误，以验证流程不会在真实检查失败后继续。

## 1. 打开业务项目会话

打开普通本地会话，工作目录选择你的业务工程。本次用独立的“Autobiz订单导出演示”，含 order-export 功能及真实测试脚本。不要把插件源码目录当成业务目录。

后面所有授权、组合和流程都作用于这里选中的项目。

![步骤 1](C:/ai/CmbCoworkAgent-mods-v2/output/claw-walkthrough-20260928/screenshots/01-project.png)

## 2. 找到上传入口

点击左侧“自定义”，进入“Function Mods”，点击“上传 Mods（ZIP）”。准备好完整插件包：plugin.json、hooks/hooks.json 和模块源码都必须包含。

我的 Claw 负责组合；上传和授权在 Function Mods。

![步骤 2](C:/ai/CmbCoworkAgent-mods-v2/output/claw-walkthrough-20260928/screenshots/02-mods-upload-entry.png)

## 3. 上传完整 Autobiz ZIP

选择 package/AutobizDevOps_Plugin_Kanban_Mods.zip 并打开。等待页面显示已安装，以及列表中出现该插件。本次通过真实文件选择框完成上传。

examples/autobiz-kanban-mods 只有模块源码，不能直接安装；本次提供的是已打包 ZIP。

![步骤 3](C:/ai/CmbCoworkAgent-mods-v2/output/claw-walkthrough-20260928/screenshots/03-installed.png)

## 4. 开启应用与项目 Mods

勾选“启用 Mods 功能（应用级）”和“启用项目 Mods”。向下滚动到 Function Mods 卡片，确认作用目录是业务工程。

安装成功不等于启用；启用也不等于已经授权。

![步骤 4](C:/ai/CmbCoworkAgent-mods-v2/output/claw-walkthrough-20260928/screenshots/04-enable-and-review.png)

## 5. 核对能力并授权当前版本

展开“查看完整能力与版本”，确认后点击“授权以上能力”。本次本地示例授权后显示“已授权”；写文件、执行命令仍需核对具体操作。

授权绑定本项目及当前源码摘要。更新插件后需重新核对。

![步骤 5](C:/ai/CmbCoworkAgent-mods-v2/output/claw-walkthrough-20260928/screenshots/05-authorized.png)

## 6. 命名自己的 Claw 并勾选能力

进入“我的 Claw”，名称填“Autobiz 研发助手”，勾选 AutobizDevOps_Plugin_Kanban_Mods。若有其他已授权组件，可以一并勾选。

组合选择参与聊天的组件，不会把每个组件强制变成每轮必跑的步骤。

![步骤 6](C:/ai/CmbCoworkAgent-mods-v2/output/claw-walkthrough-20260928/screenshots/06-select-capability.png)

## 7. 保存能力组合

点击“保存能力组合”。左侧出现命名后的组合，页面提示保存成功。此时顶部仍显示此前实际生效的组合。

保存只是记住搭配，还没有切换聊天行为。

![步骤 7](C:/ai/CmbCoworkAgent-mods-v2/output/claw-walkthrough-20260928/screenshots/07-saved.png)

## 8. 应用组合

点击左侧该组合的“应用组合”。核对顶部变成“当前组合：Autobiz 研发助手”，然后点击“回到聊天使用”。

从这里开始，本项目后续普通聊天使用这套 Function Mods；切换前需结束正在运行的任务。

![步骤 8](C:/ai/CmbCoworkAgent-mods-v2/output/claw-walkthrough-20260928/screenshots/08-applied.png)

## 9. 在聊天输入 /kanban

在普通聊天输入 /kanban。弹出的功能列表中包含 kanban、kanban-check、kanban-review 等真实注册命令。选中 kanban，再点击发送。

这就是聊天里使用插件的入口；无需先运行一条固定流程。

![步骤 9](C:/ai/CmbCoworkAgent-mods-v2/output/claw-walkthrough-20260928/screenshots/09-command-picker.png)

## 10. 查看真实项目结果

命令运行完成，打开 Autobiz 看板并读取本地 state.json 和阶段产物。本例识别 order-export，显示需求实现评审阶段，必需产物找到 4/5，缺少 REQUIREMENTS_EVAL.md。

结果来自组件和磁盘读取，不是预写的模型回答。这里只检查产物存在且非空，不代表测试、评审或阶段推进已经通过。

![步骤 10](C:/ai/CmbCoworkAgent-mods-v2/output/claw-walkthrough-20260928/screenshots/10-real-kanban-result.png)

## 11. 创建并应用另一套组合

回到“我的 Claw”，新建“基础助手（不启用 Autobiz）”，不勾选任何 Function Mods，保存并应用。当前组合显示新名称，能力数为 0。

空组合关闭本项目普通聊天所选的 Function Mods；传统 Plugin、Skill、Harness 不因这一步被卸载或关闭。

![步骤 11](C:/ai/CmbCoworkAgent-mods-v2/output/claw-walkthrough-20260928/screenshots/11-switch-profile.png)

## 12. 观察切换后的实际差异

回到同一个聊天，再输入 /kanban。页面显示“没有匹配的命令或技能”。这里仅查看提示，没有把未识别的文本发给模型。

历史命令记录仍保留，但组件的当前命令入口和交互面板已退出。与第 9 步对照，可看到组合确实生效。

![步骤 12](C:/ai/CmbCoworkAgent-mods-v2/output/claw-walkthrough-20260928/screenshots/12-command-absent.png)

## 13. 切回 Autobiz 研发助手

回到“我的 Claw”，点击 Autobiz 研发助手的“应用组合”；再点击组合名称查看其已保存内容。顶部确认恢复该组合。

“点击名称”是编辑，“应用组合”是启用。以顶部当前组合为准；编辑草稿不会自动改变已应用版本。

![步骤 13](C:/ai/CmbCoworkAgent-mods-v2/output/claw-walkthrough-20260928/screenshots/13-restore-autobiz.png)

## 14. 可选：定义固定步骤流程

需要每次按指定顺序执行时，进入“DIY 流程”，点击“新建代码检视流程”。把名称改为“Autobiz · 单测后人工确认”，目标写成运行真实测试、通过后确认。本次随后把模板首步改为真实检查。

这一段是显式流程演示。使用 Mods 命令不要求配置流程。

![步骤 14](C:/ai/CmbCoworkAgent-mods-v2/output/claw-walkthrough-20260928/screenshots/14-flow-goal.png)

## 15. 选择并配置两个步骤

点击第一步卡片，把“步骤类型”由 Agent 任务改为“真实检查”，检查内容选“单元测试”，命名“运行订单单元测试”。第二步保留“人工确认”，改名“确认单测结果”。

执行预览为“运行订单单元测试 → 确认单测结果”。还可增加步骤、调整顺序、选择 Agent/模型、配置失败回退；本次未加入模型任务和自动修复。

![步骤 15](C:/ai/CmbCoworkAgent-mods-v2/output/claw-walkthrough-20260928/screenshots/15-flow-steps.png)

## 16. 保存流程版本

点击“保存流程”，得到 v1。点击“到聊天启动此流程”，回到聊天输入本次目标。

“运行已保存版本”会直接执行模板目标；“到聊天启动此流程”只带入选择，等待你输入本次任务并明确启动。

![步骤 16](C:/ai/CmbCoworkAgent-mods-v2/output/claw-walkthrough-20260928/screenshots/16-flow-saved.png)

## 17. 在聊天填写本次流程任务

在专用“流程本次任务”框输入：验证 order-export 的订单 CSV 导出，执行真实单元测试，失败就停止。点击“启动流程任务”。

下面的普通聊天输入框仍独立存在。只有明确启动，才执行这些固定步骤。

![步骤 17](C:/ai/CmbCoworkAgent-mods-v2/output/claw-walkthrough-20260928/screenshots/17-chat-flow-task.png)

## 18. 核对实际执行命令

应用弹出本次操作审批。核对命令 npm run test 和 cwd 为独立演示项目，再点“允许本次操作”。本次执行的是项目 package.json 的 test 脚本。

组件授权没有跳过具体执行审批；核对目录，避免在错误工程运行。

![步骤 18](C:/ai/CmbCoworkAgent-mods-v2/output/claw-walkthrough-20260928/screenshots/18-execution-approval.png)

## 19. 真实测试失败，流程停止

示例故意保留了错误实现。实际测试抛出 filter and numeric ordering 断言错误，页面记录 PROJECT_UNIT-TEST_FAILED，完成证据显示“阻止完成”，只执行了第一步。

这是预期的演示结果：不能因点击运行就显示成功；人工确认未执行，Autobiz 阶段未推进。

![步骤 19](C:/ai/CmbCoworkAgent-mods-v2/output/claw-walkthrough-20260928/screenshots/19-flow-blocked.png)

## 20. 找到带证据追问入口

展开本次流程任务，滚动到结果底部，点击“带运行摘要追问”。需要时可先收起详细堆栈。

长失败日志目前较占空间，按钮在记录底部；这是本次实际操作中仍不够顺手的地方。

![步骤 20](C:/ai/CmbCoworkAgent-mods-v2/output/claw-walkthrough-20260928/screenshots/20-followup-entry.png)

## 21. 摘要进入可编辑聊天草稿

草稿包含实际 runId、流程名、v1、本次任务、failed 状态和错误摘要。你可以补充“请解释原因”再发送。此次演示停在草稿，未调用在线模型。

点击此按钮不会自动发送，也不会重跑流程。本次展示到证据入草稿；不把它冒充为模型已完成分析或修复。

![步骤 21](C:/ai/CmbCoworkAgent-mods-v2/output/claw-walkthrough-20260928/screenshots/21-followup-draft.png)

## 演示边界和后续体验

- 应用窗口保留在独立演示环境；聊天中的摘要仍是未发送草稿。
- 本次展示上传、授权、组合切换、真实组件命令、固定流程的真实测试阻断、摘要入草稿。
- 本次没有执行在线模型评审、自动修复、成功后人工确认或阶段推进，不以本图册证明这些步骤已经发生。
- 组合编辑草稿与当前生效组合分离；以顶部“当前组合”为准。失败日志和看板设置仍偏长，实操需要滚动。
- 页面和图片的路径指向本机；单文件 HTML 内嵌全部图片，更适合转发汇报。
