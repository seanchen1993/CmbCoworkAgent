# Desktop Runtime / Checkpoint 入口清单

> 状态：PR-C 本地 Thread 运行租约已接入
>
> 对应规格：`docs/chatx-unified-bot-v1-implementation-spec.md` §11、§19、§21
>
> 可执行校验：`tests/desktop-agent-runtime-entrypoints.spec.ts`

这份清单回答两个问题：当前哪些路径能够创建 Agent Runtime、它们用哪个 `threadId` 写 Checkpoint。后续 PR-B/PR-C 移动入口或增加本地运行租约时，必须同步修改清单和可执行校验；不能只在新的 IM Runner 上加锁。

## 直接 Runtime 入口

| 所有者               | 源文件 / 入口                                     | 直接调用数 | Runtime / Checkpoint `threadId`        | 当前所有权与清理                                                                                       | PR-B / PR-C 处理                                                                  |
| -------------------- | ------------------------------------------------- | ---------: | -------------------------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| Desktop              | `agent:invoke`                                    |          0 | 当前桌面 Thread                        | `activeRuns`、replacement lock、run token、settled promise；3 个模型/failover 执行点均调用共享 factory | `owner: desktop` 早期拒绝 + mutation-lock 内二次 CAS；同来源只按精确旧 runId 交接 |
| Desktop              | `agent:resume`                                    |          0 | 当前桌面 Thread                        | 复用 TurnState；新的物理 run token；2 个恢复/failover 执行点均调用共享 factory                         | 同一 foreign-owner 守卫；保留 `Command({ resume })` 与旧同来源交接语义            |
| Desktop              | `agent:interrupt`                                 |          0 | 当前桌面 Thread                        | 复用 TurnState；新的物理 run token；2 个继续/failover 执行点均调用共享 factory                         | 同一 foreign-owner 守卫；保留旧 HITL 兼容语义                                     |
| Shared standard turn | `prepareStandardThreadRuntimeFactory`             |          1 | 调用方准备的目标 Thread                | 合并 Harness Context、受限 `remotePolicy` 与 Runtime options；统一调用现有 Runtime                     | 创建 Runtime 前校验调用方提供的 owner/runId 仍精确持有租约                        |
| Scheduler            | `executeTask`                                     |          1 | 每次任务新建的 UUID Thread             | `runningTasks` + AbortController；显式 pin/release Checkpointer                                        | `owner: scheduler`；先 claim、再 pin/Runtime，close 后才 identity-fenced release  |
| Heartbeat            | `runHeartbeat`                                    |          1 | 固定 `heartbeat` Thread                | 单实例 `running` + AbortController；显式 pin/release/close                                             | 归入 `owner: scheduler`；冲突时跳过本次 beat，不抢占；close 后释放                |
| Legacy ChatX         | `processMessage`                                  |          1 | `chatId + fromId` 复用或新建 Thread    | `runningChats` + 队列 + AbortController；显式 pin/release                                              | 临时归入 `owner: im` 以防 clean cut 前双写；V1 仍删除，不复用为统一机器人入口     |
| Workflow leaf        | `createWorkflowTool().subagentDeps.createRuntime` |          1 | `subagentOptions.threadId` 子 Thread   | Workflow manager 拥有 abort；子 Thread 独立 Checkpoint                                                 | 保持父 run 内部子 owner；不作为可被 Desktop/IM 直接争抢的根 Thread                |
| Coordinator worker   | worker 首次 / 流中 failover                       |          2 | `workerInput.workerThreadId` 子 Thread | Worker manager 拥有 abort；finally 关闭子 Checkpointer                                                 | 保持 worker 子 owner；父 Thread 租约必须覆盖其启动生命周期                        |
| Coordinator handoff  | 缺少最终交接时补跑                                |          1 | 同一 `workerInput.workerThreadId`      | 只读 continuation；复用 worker Checkpoint，随后统一清理                                                | 与 coordinator worker 同一内部 owner，不新增根 Thread owner                       |

PR-B 后直接调用点基线为 8：共享 standard-turn factory 1、Scheduler 1、Heartbeat 1、Legacy ChatX 1、Runtime 内部子执行 4。Desktop 的 7 个模型/failover 执行点全部汇入同一个受控 factory。`createAgentRuntime()` 内部通过 `getCheckpointer(threadId)` 取得同名 Checkpointer，因此任何新增的裸 Runtime 入口也是潜在的并发 Checkpoint 写入口。

## 非 Runtime、但会直接访问 Checkpoint 的入口

下列路径不创建 Agent Runtime，但同样会读取、写入、关闭或删除 Checkpoint；PR-C 不能把它们误当成新的执行 owner：

- `markLatestForkBoundary()`：运行结束或中断后，通过 `withCheckpointer()` 写稳定 fork boundary；属于当前 run 的收尾。
- Thread fork / checkpoint fork handlers：用户显式创建分叉，必须继续等待正在终止的桌面 run settle。
- Thread delete / cleanup：retire 根 Thread 及 `__` 子 Thread Checkpoint；属于生命周期销毁，不取得执行租约。
- Checkpointer LRU：跳过 `activeRuns` 中的桌面 Thread、显式 pin 的 service Thread 和所有 `__` 子 Thread。
- Transcript durable-tail / reconcile：协调 DB transcript 与 Checkpoint，不创建 Runtime。

## PR-C foreign-owner 守卫边界

已经过统一守卫的根 Thread 执行入口：

1. `agent:invoke`
2. `agent:resume`
3. `agent:interrupt`
4. Scheduler、Heartbeat 与 clean cut 前的 Legacy ChatX
5. 新 IM Standard Turn Runner（后续 PR-E 只能调用同一 claim/factory）

守卫只拒绝不同来源 owner。租约存于主进程内存，因为 Runtime 不能跨进程存活；它没有 TTL、超时抢占或强制释放接口。同来源物理 run 交接必须携带精确 `handoffFromRunId`，旧 run 的迟到 finally 不能释放新 run 的租约。Desktop 自身现有 Abort → await settle → install controller、Stop/Replace/Steer、Goal、Coordinator、Workflow 顺序保留；终态清理会等待 ACL 清理完成后再释放租约。Workflow leaf 与 Coordinator worker 是已获父 run 所有权后创建的内部子 Thread，不单独参加根 Thread 的 Desktop/IM 争抢；它们的父 run 生命周期仍受根 Thread 租约约束。

## PR-A 回归门槛

`tests/desktop-agent-invoke-characterization.spec.ts` 冻结以下桌面语义：

- Invoke/Resume/Interrupt/Cancel 的 owner 交接和 identity-fenced cleanup；
- 新 Invoke 重置 TurnState，Resume/Interrupt 复用逻辑 Turn；
- 普通输入抢占 active Goal 的既有行为；
- Feature Harness、显式 Skill、UserPromptSubmit、Hook scope、路由、Trace、Checkpoint message id 和自动提交参数；
- 模型初始化失败与流中失败的 checkpoint/failover 语义；
- 桌面审批无限等待、`request_user_input`、Coordinator 和 Workflow 仍留在既有处理链。

这是一份 characterization 基线，不代表上述结构是最终理想结构。PR-B 可以抽取无状态模块，但必须让这些断言表达的桌面可见行为和副作用顺序继续成立。
