# ChatX IM 远程控制高级模式 RFC

> 状态：首版不进入实现；作为 Phase 2 的入口规格。
> 前置：Phase 0、Phase 1A、Phase 1B、Phase 1C。
> 决策原则：桌面行为不变；不能通过删除 capability guard 来换取表面可用。

## 1. 结论

首版继续只允许 `agentMode === "normal"`。桌面创建的 coordinator/workflow 会话不能授权给
招乎，已变更为高级模式的授权会话也会在每轮 capability 校验时被拒绝。

这不是 Runtime 本身不支持高级模式，而是 Runtime 外围的恢复、通知、完成和失败回滚仍由
桌面 `agent:invoke` 处理器持有。现阶段直接让 IM 创建高级模式 Runtime，会跳过桌面已有语义，
违反“桌面行为不变”和“IM 不建立第二套执行语义”两个首版约束。

## 2. 代码证据

当前边界如下：

| 语义                            | 桌面路径                                                              | IM 路径              |
| ------------------------------- | --------------------------------------------------------------------- | -------------------- |
| 模式判定与切换保护              | `src/main/ipc/agent.ts`                                               | 固定 `normal`        |
| Coordinator worker 恢复         | `coordinatorWorkerManager.restoreWorkersForThread`                    | 无                   |
| Coordinator 通知 drain/restore  | `prepareQueuedCoordinatorNotificationsForPrompt`                      | 无                   |
| Workflow 待投递结果认领         | `workflowRunManager.findPendingNotification/markNotificationInFlight` | 无                   |
| Workflow 成功确认与失败重投     | `markNotified/renotify`                                               | 无                   |
| 高级模式完成 Hook 与 revision   | 桌面 handler 内                                                       | 只有普通 Turn 的实现 |
| Goal/background-result evidence | 桌面 handler 内                                                       | 无                   |

`createAgentRuntime({ agentMode })` 只是执行能力开关，不能替代上表中的编排。现有桌面
characterization 测试也明确锁定了这些行为仍在原 handler 内。

## 3. Phase 2 的目标结构

Phase 2 需要抽取一个主进程共享的高级 Turn 核心，桌面和 IM 都调用它：

```ts
interface AdvancedThreadTurnRequest {
  source: "desktop" | "im"
  threadId: string
  rawMessage: string
  userMessageId: string
  runOwner: "desktop" | "im"
  runId: string
  signal: AbortSignal
}

interface AdvancedThreadTurnResult {
  mode: "coordinator" | "workflow"
  finalAssistantMessageId: string
  finalText: string
  backgroundState: "settled" | "deferred"
}
```

共享核心负责：

1. 从 Thread metadata 读取模式；IM 只能使用桌面已经持久化的模式，不能从消息或参数切换模式；
2. 恢复 coordinator workers，并按现有上限 drain/restore 通知；
3. 原子认领 workflow 待投递结果，成功后确认，失败或中止时恢复可重投状态；
4. 构造与桌面一致的 coordinator/workflow prompt、Runtime options 和 background evidence；
5. 运行 completion Hook/revision，并返回最终持久消息身份；
6. 在 `finally` 中执行与桌面一致的通知回滚、worker 状态清理、checkpointer 与 trace 收尾。

共享核心不负责桌面窗口、IPC、toast、stop/replace/steer UI，也不负责 Gateway ACK。两侧 adapter
继续各自持有 transport 和 owner：

- 桌面 adapter 保留当前替换、steer、Goal 和 renderer stream 行为；
- IM adapter 保留 Gateway permit、Thread lease、设备 epoch、等待交互 TTL 和 outbox。

## 4. 所有权与后台通知

### 4.1 Runtime owner

仍沿用“一条 Thread 同时只有一个本地运行 owner”。Coordinator worker 使用父 Thread 的合成
runtime id，并继承父 run 的 `AbortSignal`，不新增 Thread lease。

Workflow 可以在前台 Turn 返回后继续运行，因此其后台生命周期由 `workflowRunManager` 持有，
不能把 Gateway permit 或前台 Thread lease 延长到整个后台运行期间。

### 4.2 通知唤醒

当前高级模式完成通知依赖 renderer 发起内部 Turn。Phase 2 必须先把“发现待投递通知并启动报告
Turn”的职责移动到主进程队列；renderer 只观察状态，不能再是正确性所必需的唤醒源。

主进程队列按 `threadId` 串行，并复用现有本地 Thread lease：

- 桌面 owner 活跃时通知等待租约释放回调；
- IM owner 活跃时通知同样排队；
- 应用重启时扫描 worker 持久状态与未投递 workflow 结果；
- 每个通知只允许一个 in-flight reservation，失败后恢复，不做静默丢弃。

## 5. IM 长任务与推送

IM 只负责启动桌面已经创建且授权的高级模式会话，不能在 Feature 下新建 coordinator/workflow。

- 前台高级 Turn 继续使用当前事件的 Gateway permit，并按现有间隔续租；
- 请求审批或结构化输入时复用 `interactionWaitHooks`，进入 `waiting_desktop`；
- 10 分钟 TTL 到期只取消本次 IM 事件，不撤销 grant/binding；审批短码随 Runtime 请求失效；
- detached worker/workflow 的最终报告是新的主进程通知 Turn，不复用已经结束的入站事件；
- 最终报告通过 Phase 1 proactive outbox 投递，不发送流式片段或工具中间过程。

建议的稳定 delivery identity：

```text
coordinator-notification:<threadId>:<notificationId>:<finalAssistantMessageId>
workflow-notification:<threadId>:<runId>:<startedAt>:<finalAssistantMessageId>
```

投递前重新读取 active grant、conversation route 和 `deviceEpoch`。设备接管或撤销后不外发；
已入 outbox 的旧 epoch 消息由 Gateway 拒绝。

## 6. 崩溃与幂等纪律

1. worker 通知 drain 后必须能在 Turn 失败、取消或进程退出后恢复；
2. workflow 继续保持“内存 in-flight、成功后才持久 delivered”的 at-least-once 语义；
3. 最终 assistant 消息先持久化，再创建稳定 proactive delivery；
4. outbox、通知确认和远程审批审计都在对外 ACK 或继续执行前跨过 `flushStrict()`；
5. 重启恢复不得重新执行结果未知的用户工具调用，只能重投已持久化的通知或回复。

## 7. Characterization 迁移门槛

只有以下测试先落地并通过，才允许修改 `REMOTE_AGENT_MODE_UNSUPPORTED` 闸门：

1. 同一 coordinator fixture 从桌面与共享核心进入时，worker 恢复、通知集合、prompt 和完成 Hook
   调用序列一致；
2. workflow 通知成功、失败、abort、应用重启四条路径与桌面当前行为一致；
3. 桌面 invoke/resume/interrupt 的 owner、replace、steer、Goal 和清理顺序保持原 characterization；
4. IM 无法改变 Thread 模式，无法创建高级模式 Thread；
5. IM permit 失效、设备接管和审批 TTL 均只终止对应事件，binding 保持；
6. 后台通知重复唤醒只产生一个逻辑 delivery；
7. 无 renderer 窗口时，后台完成仍能被主进程发现并可靠投递；
8. 完整 `typecheck`、桌面 baseline 和 IM 回归全部通过。

原 characterization 中“高级逻辑必须位于 `agent.ts`”的断言届时改为“高级逻辑由共享核心提供，
且桌面和 IM adapter 调用同一入口”。在共享核心和上述测试出现以前，不修改该断言。

## 8. 首版明确不做

- 不删除或放宽 `agentMode === "normal"` 的授权与每轮执行闸门；
- 不复制桌面高级模式代码到 `remote-runner`；
- 不让 renderer IPC 充当 IM 的隐藏执行入口；
- 不允许 IM 切换模式或新建高级模式 Thread；
- 不为追求远程可用而改变桌面审批、stop、replace、steer 或 Goal 行为。
