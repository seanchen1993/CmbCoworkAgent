import { createHash, randomUUID } from "node:crypto"
import type { ScheduledTask } from "../../types"
import { claimLocalThreadRunLease, releaseLocalThreadRunLease } from "../../agent/thread-run-lease"
import { imRemoteCapabilityGuard } from "./capability-guard"
import { imConversationStateStore, type ImConversationStateStore } from "./conversation-state"
import { imEventStore, type ImEventRecord } from "./event-store"
import { unavailableImGatewayClient, type ImGatewayClientPort } from "./gateway-client"
import { createImInboxRemotePolicy, executePreparedRemoteStandardTurn } from "./remote-runner"
import { buildImProactiveReplies } from "./reply-segmentation"
import { ImReplyClient } from "./reply-client"

export type ImInboxScheduledRunResult =
  | { status: "completed"; text: string; deliveryId: string }
  | { status: "deferred"; reasonCode: string }

let configuredGateway: ImGatewayClientPort = unavailableImGatewayClient
let configuredReplyClient: ImReplyClient | null = null

export function registerImInboxSchedulerGateway(
  gateway: ImGatewayClientPort,
  replyClient: ImReplyClient
): () => void {
  configuredGateway = gateway
  configuredReplyClient = replyClient
  return () => {
    if (configuredGateway !== gateway) return
    configuredGateway = unavailableImGatewayClient
    configuredReplyClient = null
  }
}

function occurrenceKey(task: ScheduledTask): string {
  if (task.nextRunAt) return task.nextRunAt
  return `manual:${randomUUID()}`
}

function stableDeliveryId(task: ScheduledTask, occurrence: string): string {
  const digest = createHash("sha256")
    .update(`${task.id}\0${occurrence}`, "utf8")
    .digest("hex")
    .slice(0, 24)
  return `scheduler:${task.id}:${digest}`
}

function reminderPrompt(prompt: string): string {
  return `你是一个暖心的提醒助手。请用温暖、有趣的方式提醒用户：${prompt}\n要求：\n(1) 不要解释你是谁\n(2) 直接输出一条暖心的提醒消息\n(3) 可以加一句简短的鸡汤或关怀的话\n(4) 控制在2-3句话以内\n(5) 用emoji点缀`
}

function syntheticEvent(input: {
  task: ScheduledTask
  eventId: string
  principalId: string
  target: NonNullable<ImEventRecord["targetSnapshot"]>
  now: number
}): ImEventRecord {
  const delivery = input.task.imDeliveryContext!
  const now = input.now
  return {
    eventId: input.eventId,
    platformMessageId: input.eventId,
    conversationKey: delivery.conversationKey,
    conversationSeq: 0,
    principalId: input.principalId,
    leaseId: input.eventId,
    leaseExpiresAt: now + 60_000,
    permitState: "unacquired",
    permitExpiresAt: null,
    messageText: input.task.prompt,
    occurredAt: now,
    targetSnapshot: input.target,
    state: "queued",
    runId: null,
    retryOfEventId: null,
    resultText: null,
    reasonCode: null,
    retryable: null,
    createdAt: now,
    updatedAt: now,
    acceptedAt: now,
    executionStartedAt: null,
    finishedAt: null
  }
}

export async function executeImInboxScheduledTask(
  task: ScheduledTask,
  signal: AbortSignal,
  options: {
    occurrence?: string
    gateway?: ImGatewayClientPort
    conversationState?: ImConversationStateStore
    eventStore?: typeof imEventStore
    capabilityGuard?: typeof imRemoteCapabilityGuard
    replyClient?: ImReplyClient
    executeTurn?: typeof executePreparedRemoteStandardTurn
    createRunId?: () => string
    now?: () => number
  } = {}
): Promise<ImInboxScheduledRunResult> {
  const delivery = task.imDeliveryContext
  if (!delivery || task.taskType !== "reminder") {
    throw new Error("Scheduled task is not a managed inbox reminder")
  }
  const gateway = options.gateway ?? configuredGateway
  const conversationState = options.conversationState ?? imConversationStateStore
  const eventStore = options.eventStore ?? imEventStore
  const capabilityGuard = options.capabilityGuard ?? imRemoteCapabilityGuard
  const replyClient =
    options.replyClient ??
    (gateway === configuredGateway && configuredReplyClient
      ? configuredReplyClient
      : new ImReplyClient(gateway, eventStore))
  const executeTurn = options.executeTurn ?? executePreparedRemoteStandardTurn
  const now = options.now ?? Date.now
  if (!gateway.isAuthenticated()) {
    return { status: "deferred", reasonCode: "DESKTOP_OFFLINE" }
  }

  const occurrence = options.occurrence ?? occurrenceKey(task)
  const deliveryId = stableDeliveryId(task, occurrence)
  const existingOutbox = eventStore
    .listOutbox()
    .filter((record) => record.deliveryId === deliveryId)
  if (existingOutbox.length > 0) {
    await replyClient.sendPending()
    return {
      status: "completed",
      text: existingOutbox.map((record) => record.content).join("\n"),
      deliveryId
    }
  }

  const conversation = conversationState.getConversation(delivery.conversationKey)
  if (
    !conversation ||
    conversation.state !== "active" ||
    conversation.principalId !== delivery.principalId
  ) {
    return { status: "deferred", reasonCode: "CONVERSATION_OWNER_MISMATCH" }
  }
  const target = conversationState
    .listTargets(delivery.conversationKey)
    .find(
      (candidate) =>
        candidate.state === "active" &&
        candidate.snapshot.kind === "inbox" &&
        candidate.snapshot.threadId === delivery.inboxThreadId
    )?.snapshot
  if (!target || target.kind !== "inbox") {
    return { status: "deferred", reasonCode: "INBOX_TARGET_UNAVAILABLE" }
  }

  const eventId = `${deliveryId}:event`
  const event = syntheticEvent({
    task,
    eventId,
    principalId: conversation.principalId,
    target,
    now: now()
  })
  const capability = await capabilityGuard.evaluate(event)
  if (!capability.allowed) {
    return { status: "deferred", reasonCode: capability.reasonCode }
  }

  const runId = options.createRunId?.() ?? randomUUID()
  const claim = claimLocalThreadRunLease({
    threadId: delivery.inboxThreadId,
    owner: "scheduler",
    runId
  })
  if (!claim.acquired) {
    return { status: "deferred", reasonCode: "THREAD_BUSY" }
  }

  try {
    const text = await executeTurn({
      rawMessage: reminderPrompt(task.prompt),
      userMessageId: `im-scheduler:${deliveryId}:user`,
      threadId: delivery.inboxThreadId,
      targetKind: "inbox",
      metadata: capability.metadata,
      workspacePath: capability.workspacePath,
      runId,
      runOwner: "scheduler",
      source: "scheduler",
      routingTaskSource: "scheduler_reminder",
      signal,
      remotePolicy: { ...createImInboxRemotePolicy(), disableScheduler: true }
    })
    await eventStore.enqueueProactiveReplies(
      buildImProactiveReplies({
        deliveryId,
        conversationKey: delivery.conversationKey,
        text
      })
    )
    await replyClient.sendPending()
    return { status: "completed", text, deliveryId }
  } finally {
    releaseLocalThreadRunLease(delivery.inboxThreadId, "scheduler", runId)
  }
}
