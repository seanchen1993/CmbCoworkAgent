import type { AgentRunExecutionContext } from "./agent-run-service"

interface ModelCheckpoint {
  config?: { configurable?: Record<string, unknown> }
  next: readonly string[]
  tasks?: readonly { interrupts?: readonly unknown[] }[]
}

function isLocalBotContinuation(
  context: Pick<AgentRunExecutionContext, "source" | "localRunLease">,
  metadata: Record<string, unknown>
): boolean {
  return (
    context.source === "bot" &&
    context.localRunLease?.owner === "bot" &&
    context.localRunLease.managedExternally === true &&
    metadata.botHostId === "local" &&
    typeof metadata.botId === "string" &&
    Boolean(metadata.botId.trim())
  )
}

/** Keep a durable Bot result turn bound to its original workflow instance. */
export function botWorkflowNotificationClaim(
  context: Pick<
    AgentRunExecutionContext,
    "source" | "localRunLease" | "workflowInternalNotification" | "botWorkflowNotification"
  >,
  metadata: Record<string, unknown>
): { runId: string; startedAt: string } | undefined {
  const claim = context.botWorkflowNotification
  if (claim === undefined) return
  if (
    !isLocalBotContinuation(context, metadata) ||
    context.workflowInternalNotification !== true ||
    typeof claim.runId !== "string" ||
    !claim.runId.trim() ||
    claim.runId.length > 128 ||
    typeof claim.startedAt !== "string" ||
    !claim.startedAt.trim() ||
    claim.startedAt.length > 100
  )
    throw new Error("该执行入口无权领取 Bot 后台任务结果。")
  return { runId: claim.runId, startedAt: claim.startedAt }
}

/** Renderer input never selects resume semantics; this is a local, identity-bound Host option. */
export function botGroupResumeCheckpoint(
  context: Pick<AgentRunExecutionContext, "source" | "localRunLease" | "resumeCheckpointId">,
  metadata: Record<string, unknown>
): string | undefined {
  const id = context.resumeCheckpointId
  if (id === undefined) return
  if (
    !isLocalBotContinuation(context, metadata) ||
    typeof metadata.botGroupId !== "string" ||
    !metadata.botGroupId.trim() ||
    !id.trim() ||
    id.length > 200
  )
    throw new Error("该执行入口无权恢复 Bot 群任务检查点。")
  return id
}

/** A private background task shares the user's conversation and cannot restore an old branch. */
export function botPrivateContinuationCheckpoint(
  context: Pick<
    AgentRunExecutionContext,
    "source" | "localRunLease" | "resumeCheckpointId" | "continueBotTaskCheckpointId"
  >,
  metadata: Record<string, unknown>
): string | undefined {
  const id = context.continueBotTaskCheckpointId
  if (id === undefined) return
  if (
    !isLocalBotContinuation(context, metadata) ||
    context.resumeCheckpointId !== undefined ||
    metadata.botGroupId != null ||
    !id.trim() ||
    id.length > 200
  )
    throw new Error("该执行入口无权续办 Bot 私聊任务。")
  return id
}

/** A Bot may resume a yielded model step, never an unconfirmed external action or HITL gate. */
export function assertBotModelCheckpoint(id: string, snapshot: ModelCheckpoint): void {
  if (
    !id.trim() ||
    id.length > 200 ||
    snapshot.config?.configurable?.checkpoint_id !== id ||
    snapshot.next.length !== 1 ||
    snapshot.next[0] !== "model_request" ||
    snapshot.tasks?.some((task) => task.interrupts?.length)
  )
    throw new Error("Bot 续跑检查点已改变或不是模型边界，请检查原任务后继续。")
}

/** Keep newer completed private history. A pending model may only be the exact yielded step. */
export function assertBotPrivateContinuationCheckpoint(
  id: string,
  snapshot: ModelCheckpoint
): void {
  const latest = snapshot.config?.configurable?.checkpoint_id
  if (
    id.trim() &&
    id.length <= 200 &&
    typeof latest === "string" &&
    latest.trim() &&
    snapshot.next.length === 0 &&
    !snapshot.tasks?.some((task) => task.interrupts?.length)
  )
    return
  assertBotModelCheckpoint(id, snapshot)
}
