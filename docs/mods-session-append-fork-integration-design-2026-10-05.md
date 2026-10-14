# Stage23 会话复制接入与已有消息保护方案

状态：待实际 IPC 接入的两位独立评审。存储基础 63 项、共享任务与入口限制 13 项、
Node/Web 类型检查通过；这些结果不能代表完整复制流程已经验收。

## 用户应得到的效果

用户仍从原来的回复菜单复制会话，不需要学习一个新入口。已保留的 Mods 内容在新
会话中完整显示，并成为新会话自己的记录；原会话之后添加的内容不会跟过去。已经
进入模型的备注不会在复制后再次当作新备注发送。复制正在进行时不能向目标会话发
消息，失败不留下一个可以聊天的半成品。旧的普通会话继续使用原流程。

## 固定原会话与检查点

原 `forkThread` 在工作流 transition lease 和同会话 mutation lock 内执行。首次读取
真实源行时固定数据库实例、incarnation、metadata、workspace、取消/退休状态；每个
await 两侧复核。将 `withCheckpointer(sourceThreadId, ...)` 的真实借用范围扩到复制结束，
而非读取 tuple 后关闭源 Saver，再用历史 JSON 继续写。

原 forkability、历史边界、工具大文件、Goal、子任务记录、标题覆盖和过滤规则保留。
原 `materializeLatestForkTuple` 或指定消息产生的截断对象若不等于原完整 CM checkpoint，
不能借它原本更晚的备注进度。精确 checkpoint ID、完整 native message 摘要、CM 状态、
原已经持久化 membership snapshot 的完整摘要必须与真实 Saver 新读 proof 全部一致。
空成员、同 ID 修改、删成员、修改 metadata、改变 frontier 都不能以当前 high water
补证。真正普通的无 CM 历史走原路径。

## 新会话创建和 preparing 状态

先完成所有只读校验。Mods 复制由实际源 Store 私有 plan 管理，新会话 fresh incarnation
和 journal preparing 在同一实际 AppDB 同步事务内创建。journal 不对外提供写权限。
COMMIT 抛错后只接受完整新 incarnation、plan ID 和原固定目标的精确持久读回；不重放
INSERT。若事务仍未退出，则无法作已提交证明；保留原失败并精确 rollback。

公开普通消息写入、事务普通写入、原聊天开始以及普通 Saver 工厂全部读取真实目标
incarnation 的状态。不存在 journal 表的老数据库只读放行；不初始化新的 Store/schema。
preparing、aborted 和未知状态拒绝；只 ready 放行。UI 仍使用原 error/terminal 管道，
显示“会话正在复制，请稍后再试。”，不把普通数据库故障误称为准备中。

## 完整复制原始记录

canonical copy 每页至多64行或4MiB，一条更大记录整条保留，页间使用原 cold-path yield。
原 source receipt、真实源 incarnation、原23列完整 projection receipt、stamp、native
payload 全部关联验证。缺少新回执的旧行明确要求迁移；不能从当前屏幕文字补造证明。
目标保留完整正文、工具配对、stream flags、时间、原相对 ordinal；只映射真实目标
thread/branch/conversation/stamp，新目标回执与 raw INSERT 在同一实际事务提交。
UI 没有重新 clamp、hydrate、merge 或 normalize。源 physical inbox 不变化，目标也不
创建待投递副本；payload 中原 inbox 历史事实仍保留给历史恢复使用。

普通 visible 消息按原 selector 的 exact UUID/role/provider tuple 读取真实原始记录，
完整复制 fragments 和 state，同一事务维护目标 bucket。已复制 canonical UUID 不得再
通过原普通 upsert 写一次。Root 主进程 closure 固定原 checkpoint及 source guard，
确认实际 canonical ID 未变化。CM 复制在创建目标之前预检所有 visible 源行；缺少实际
原始记录时明确 MIGRATION_REQUIRED，不用 checkpoint fallback 猜位置。普通无 CM 复制
保持原 fallback。

评审发现 MAX ordinal+1 不可作通用补缺方案：缺失旧 user、已持久 assistant 时会排成
assistant 在 user 前。因此本轮收紧为必须有完整 raw 源行。后续专门利用完整 checkpoint
消息（含 meta）与所有原 raw/canonical 相对顺序建立新的目标排序坐标，再补缺失历史行；
不能为了通过测试临时移到末尾，不把待迭代说成框架限制。没有公开 preparing 绕过开关。

## 目标检查点与最终可用

历史按原顺序复制，标记消息从真实 canonical nativePayload 恢复原类并映射新 stamp，
其余真实原生消息完整保留。每个 CM checkpoint 写到私有目标 Saver 后，读取真实目标
checkpoint membership；不能只看同 ID 已存在就跳过。完整 identity/metadata 不同即失败。
目标 membership receipt 写入 journal；所有 source eligible 行与 target canonical/raw
回执双向完整核验。必须同时完成普通可见消息、子任务记录、Goal、原大工具文件处理、
严格持久化和选中检查点验证，才 CAS journal ready。目标 Saver 退出前保持实际生命周期，
响应只在所有步骤完成后返回原 ThreadForkResponse。

异常先停止新接纳并保留原错误。只能清理本次 fresh incarnation 和本次 plan 的目标，
清理与原线程删除同 lock；若目标已删除重建，拒绝删除替代行及其 checkpoint/artifacts。
unknown COMMIT、close 失败和清理失败不重做模型/工具，也不借最新会话权限继续。

## 普通持久化对已保留内容的保护

真实 projection seal 是数据完整性检查，不授予 Mods、写入或模型权限。普通 whole
snapshot 在 alias、role collision、provider merge、delta 或 ordinal 修改前识别真实
sealed 行；已保留行必须关联真实 canonical receipt 和完整 raw23列。原 native producer
的合法后续 echo 消费为 no-op；同批普通新消息继续保存。错误的 role/provider 身份、
缺回执、raw 被修改、stamp 被替换均拒绝，不能生成另一个 collision ID 规避 seal。

delta 命中完整 seal 时消费为已处理，不写 fragments；ID 替换命中 sealed 源或目标拒绝。
重排只在普通行已有 ordinal slots 中进行，canonical ordinal 固定；不向其更新任何列。
Renderer 的晚到快照也保持真实已保留行，防止重新显示保护前正文。删除/清空仍是原
已授权操作，使用当前真实 incarnation 精确删除相关回执和 journal，不能套用旧 token。

## 验证要求

- 实际 AppDB、SqlJsSaver 和原 writer：完整 note/notice/tool/model 行，长文本、stream
  flags、fragments、同 ID 篡改、原进度截断、缺回执、ABA、取消与 unknown COMMIT。
- 实际 `forkThread` 原 IPC：正常完成、历史边界、准备中拒绝、失败清理、复制后下一次
  HTTP 模型输入备注恰好一次/不重投原已消费备注，源后续备注仍留在源会话。
- whole snapshot、delta、role collision、provider alias、replace ID、reorder 混合普通行
  正向和篡改反例；旧无 CM 写入、流式聊天、普通 fork 正向。
- 原 Plugin、项目模式、Harness、附件、工具审批、取消/撤权/重载回归，以及类型、构建、
  代码检视和真实 Electron E2E。性能量测页耗时/主线程等待/完整大行，不用微基准代替。

同工作区的实际主会话先接完整链路；跨工作区策略和子会话冷恢复另列下一项验证，
不声明它们是框架做不到，不以本小方案结束持续迭代。
