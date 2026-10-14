# 会话追加：实际宿主接线补充设计

日期：2026-10-05。开发树 `C:/ai/CmbCoworkAgent-mods-v2`，UAT 只读。
本方案已通过两位独立评审，实际接线正在实施；不是已经完成的产品验收。

## 中央后端与实例

中央服务使用实际 app DB 的 Store 和 Registry；V2 Manager 传入实际 SessionEntry owner、
插件对象、原 grant、原 signal 和原 guard。登记只捕获实例，不因候选初始化创建持久记录。
readOnly 候选不得写；普通实例第一次确需后端时建立 main，完成后才进入 Hook。每实例
只有一个准备 Promise，失败不伪造回执。退出先关新调用，再让已运行的工作在真实 finally
归还容量。idle 追加不创建模型、主任务 authority 或新模型轮次。

main 身份从实际 thread incarnation、工作区和实际 checkpoint 捕获。最新 checkpoint
仅用于一次新的当前会话接纳；恢复和历史分支仍用原 checkpoint ID 与原 cut。已有合法
conversation channel 必须核 Store 并选择其实际 branch；旧 checkpoint 首次迁移固定
frontier 0，原内容保留。缺失或损坏已有 channel 不回退猜造主分支。每次调用前后检查
原实例、配置、grant、thread incarnation 和原目标，不能在 await 后借用新实例。

SDK note 的 UUID、插件来源、note 门和隐藏标记由宿主固定。Ticket 经过实际内容保护，
实际 Store 提交与不可变 transcript 投影同事务。返回 ACK 前严格回读 canonical 行和
投影；保存后失败不能撤销或重试。读消息合并真实保留图消息与已保存待接纳 notes；默认
摘要沿用旧格式，API 保留真实内容块。系统通知只显示，不进模型。读取有公开分页上限，
恢复一条完整内容用原 cut 的精确读取，不能用 UI 截断文本或最新 4096 条补猜。

## 父会话与子任务

主实例登记为 logical family。实际子任务工厂在创建 runtime 前，以私有 receipt 关联
真实父 owner 与该次实际 invocation、物理 thread、实际 lease、incarnation、authority。
随后子 SessionEntry 保持自己的原权限与物理执行 scope；只有会话选择通过私有关联进入
父 logical family。省略 agentId 选择 family main，明确 agentId 选择已登记的本次子任务。
不从名称、metadata、ALS 字符串或 public SDK 参数单独生成关联，不把 child 注册到两个
Registry resident。原 factory 关闭关联先于 lease、checkpoint 和内部 thread 清理。

共享 task 的 checkpoint 可在父物理 thread 的真实 namespace；UI 记录需独立 internal
bucket，不能把子回复或通知写进父聊天。缺实际 bucket/namespace 绑定时明确不可用。
映射捕获完整 logical ref 和实际 physical incarnation，两个同时活着的子任务也不能
互用。改 branch 需新宿主映射，旧映射不自动转向新 branch。实际 archive 另需原生保存
证明；删除后的 child 不靠相同名称重新授权。

## 原生工具行的角色

公开 append 事件的 tool-result 是 user 类型的 tool_result 块，但 DevClaw 原生恢复用
ToolMessage。不能为了通过 writer 把 ToolMessage 伪装成 HumanMessage。不可变 DB writer
增加 host-only storageRole，默认保持原映射；只有经过实际 ToolMessage adapter 的
tool-result/tool-message 门可用 tool。必须核实际 tool_call_id、完整原生序列化、公开
tool_use_id 和原 UUID，并在 writer/verify 使用同一 captured storageRole。SDK note 不得
指定该参数；恢复严格核 canonical row 和真实 ToolMessage，不从 UI role 单独信任。

真实模型、输入、工具 producer 在原最终保留点调用同一 once Ticket；恢复、分页和
stream replay 不重复触发 Hook。部分 stream 保留原暂存，最终完整行才形成 canonical
事实；副作用工具执行不因保护/保存错误重跑。所有门逐项接线和验证，不宣称只有 SDK
notes 的完成就代表所有原生门完成。模型边界 intake 和 frontier 随同一次真实 checkpoint
保存，锁内回执再 ACK，原 tool batch 配对和原正常任务行为保留。

## 验证要求

两位方案评审后实施。实际 DB 证明 idle note 保存但模型请求数为零、即时读取、system
通知零 provider role；真实图/本地 HTTP 证明下一自然请求才读且重启不重复。两个同时
child、切 branch、旧 owner/grant/lease/配置与取消忽略、同 namespace 保存竞争、真实
恢复完整内容及原 Plugin/项目/Harness 均需回归；最终浏览器/Electron 验证真实入口。
任何未接线 producer 明列继续项，不把它归为框架无法实现。
