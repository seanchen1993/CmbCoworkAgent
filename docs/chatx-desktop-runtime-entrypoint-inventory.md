# Desktop Runtime / Checkpoint 入口清单

> 状态：PR-A 桌面零回归基线
>
> 对应规格：`docs/chatx-unified-bot-v1-implementation-spec.md` §11、§19、§21
>
> 可执行校验：`tests/desktop-agent-runtime-entrypoints.spec.ts`

这份清单回答两个问题：当前哪些路径能够创建 Agent Runtime、它们用哪个 `threadId` 写 Checkpoint。后续 PR-B/PR-C 移动入口或增加本地运行租约时，必须同步修改清单和可执行校验；不能只在新的 IM Runner 上加锁。

## 直接 Runtime 入口

| 所有者              | 源文件 / 入口                                     | 直接调用数 | Runtime / Checkpoint `threadId`        | 当前所有权与清理                                                                                                     | PR-B / PR-C 处理                                                                                      |
| ------------------- | ------------------------------------------------- | ---------: | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Desktop             | `agent:invoke`                                    |          3 | 当前桌面 Thread                        | `activeRuns`、replacement lock、run token、settled promise；三处分别是首次创建、流中换模型、Goal continuation 换模型 | PR-B 改走共享 factory；PR-C 在进入现有 replacement 逻辑前做 foreign-owner guard，不重写同来源 Replace |
| Desktop             | `agent:resume`                                    |          2 | 当前桌面 Thread                        | 复用 TurnState；新的物理 run token；两处为首次恢复与流中换模型                                                       | PR-B 改走共享 factory；PR-C 做同一 foreign-owner guard，保留 `Command({ resume })`                    |
| Desktop             | `agent:interrupt`                                 |          2 | 当前桌面 Thread                        | 复用 TurnState；新的物理 run token；两处为首次继续与流中换模型                                                       | PR-B 改走共享 factory；PR-C 做同一 foreign-owner guard，保留旧 HITL 兼容语义                          |
| Scheduler           | `executeTask`                                     |          1 | 每次任务新建的 UUID Thread             | `runningTasks` + AbortController；显式 pin/release Checkpointer                                                      | PR-B 评估共享 factory；PR-C 获取 `owner: scheduler` 租约后才能创建 Runtime/pin                        |
| Heartbeat           | `runHeartbeat`                                    |          1 | 固定 `heartbeat` Thread                | 单实例 `running` + AbortController；显式 pin/release/close                                                           | 作为 service owner 单独分类；不得与普通 Thread 租约混淆                                               |
| Legacy ChatX        | `processMessage`                                  |          1 | `chatId + fromId` 复用或新建 Thread    | `runningChats` + 队列 + AbortController；显式 pin/release                                                            | V1 clean cut 删除；不得包装成新统一机器人入口                                                         |
| Workflow leaf       | `createWorkflowTool().subagentDeps.createRuntime` |          1 | `subagentOptions.threadId` 子 Thread   | Workflow manager 拥有 abort；子 Thread 独立 Checkpoint                                                               | 保持父 run 内部子 owner；不作为可被 Desktop/IM 直接争抢的根 Thread                                    |
| Coordinator worker  | worker 首次 / 流中 failover                       |          2 | `workerInput.workerThreadId` 子 Thread | Worker manager 拥有 abort；finally 关闭子 Checkpointer                                                               | 保持 worker 子 owner；父 Thread 租约必须覆盖其启动生命周期                                            |
| Coordinator handoff | 缺少最终交接时补跑                                |          1 | 同一 `workerInput.workerThreadId`      | 只读 continuation；复用 worker Checkpoint，随后统一清理                                                              | 与 coordinator worker 同一内部 owner，不新增根 Thread owner                                           |

直接调用总数基线为 14：Desktop 7、Scheduler 1、Heartbeat 1、Legacy ChatX 1、Runtime 内部子执行 4。`createAgentRuntime()` 内部通过 `getCheckpointer(threadId)` 取得同名 Checkpointer，因此任何漏掉的 Runtime 入口也是潜在的并发 Checkpoint 写入口。

## 非 Runtime、但会直接访问 Checkpoint 的入口

下列路径不创建 Agent Runtime，但同样会读取、写入、关闭或删除 Checkpoint；PR-C 不能把它们误当成新的执行 owner：

- `markLatestForkBoundary()`：运行结束或中断后，通过 `withCheckpointer()` 写稳定 fork boundary；属于当前 run 的收尾。
- Thread fork / checkpoint fork handlers：用户显式创建分叉，必须继续等待正在终止的桌面 run settle。
- Thread delete / cleanup：retire 根 Thread 及 `__` 子 Thread Checkpoint；属于生命周期销毁，不取得执行租约。
- Checkpointer LRU：跳过 `activeRuns` 中的桌面 Thread、显式 pin 的 service Thread 和所有 `__` 子 Thread。
- Transcript durable-tail / reconcile：协调 DB transcript 与 Checkpoint，不创建 Runtime。

## PR-C foreign-owner 守卫边界

必须经过统一守卫的根 Thread 执行入口：

1. `agent:invoke`
2. `agent:resume`
3. `agent:interrupt`
4. Scheduler 在目标 Thread 上执行的未来路径
5. 新 IM Standard Turn Runner

守卫只拒绝不同来源 owner。Desktop 自身现有 Abort → await settle → install controller、Stop/Replace/Steer、Goal、Coordinator、Workflow 和 finally 清理顺序全部保留。Workflow leaf 与 Coordinator worker 是已获父 run 所有权后创建的内部子 Thread，不单独参加根 Thread 的 Desktop/IM 争抢；它们的父 run 生命周期仍受根 Thread 租约约束。

## PR-A 回归门槛

`tests/desktop-agent-invoke-characterization.spec.ts` 冻结以下桌面语义：

- Invoke/Resume/Interrupt/Cancel 的 owner 交接和 identity-fenced cleanup；
- 新 Invoke 重置 TurnState，Resume/Interrupt 复用逻辑 Turn；
- 普通输入抢占 active Goal 的既有行为；
- Feature Harness、显式 Skill、UserPromptSubmit、Hook scope、路由、Trace、Checkpoint message id 和自动提交参数；
- 模型初始化失败与流中失败的 checkpoint/failover 语义；
- 桌面审批无限等待、`request_user_input`、Coordinator 和 Workflow 仍留在既有处理链。

这是一份 characterization 基线，不代表上述结构是最终理想结构。PR-B 可以抽取无状态模块，但必须让这些断言表达的桌面可见行为和副作用顺序继续成立。
