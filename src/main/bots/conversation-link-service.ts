import { pendingNotificationScheduler } from "../agent/pending-notification-scheduler"
import { goalManager } from "../agent/goals/runtime"
import { withCheckpointer, hasPendingApprovalForRuntimeThread } from "../agent/runtime"
import { describeCheckpointForkability } from "../../shared/checkpoint-forkability"
import { randomUUID } from "node:crypto"
import { isAbsolute } from "node:path"
import { BotError } from "../../shared/bots/contracts"
import type { LinkBotWorkConversationInput } from "../../shared/bots/conversation"
import type { LocalBotHost } from "./host"
import { localWorkConversationRef } from "./conversation-link-validation"
import { getThreadCore, updateThread } from "../db"
import { captureThreadIncarnation, matchesThreadIncarnation } from "../services/thread-incarnation"
import {
  requireThreadMutationLease,
  withThreadMutationLeaseLock
} from "../ipc/thread-run-mutation-lock"
import { workflowRunManager } from "../agent/workflow/run-manager"
import { claimLocalThreadRunLease, releaseLocalThreadRunLease } from "../agent/thread-run-lease"
import { isExternallyManagedThreadRunBusy } from "../services/thread-external-run-busy"
import { verifyWorkConversationThread, verifyWorkThreadMetadata } from "./conversation-link-authority"
import { isLocalBotWork, type BotWorkItem } from "../../shared/bots/work"
import { assertBotNonTeamConversation } from "../../shared/bots/team-policy"

function metadataOf(raw: string | null): Record<string, unknown> {
  const value = JSON.parse(raw || "{}")
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new BotError("CONFLICT", "原会话设置不可读，请先修复。")
  return value
}
function assertOrdinary(metadata: Record<string, unknown>) {
  if (metadata.threadType || metadata.heartbeat || metadata.heartbeatSession)
    throw new BotError("CONFLICT", "专用运行会话不能关联普通任务。")
  const reserved = [
    "botId",
    "botHostId",
    "botWorkId",
    "botGroupId",
    "botMockBindingId",
    "botLocalConversation",
    "harnessFeature",
    "harnessProjectSession",
    "imDeliveryContext",
    "remoteImContext",
    "targetKind",
    "remoteState",
    "remoteReadOnly",
    "remoteThread",
    "isHeartbeat",
    "scheduledTaskId",
    "partnerInputOnly"
  ]
  if (reserved.some((key) => metadata[key] != null))
    throw new BotError("CONFLICT", "只能关联普通本机对话；项目、远程、群和渠道会话不受支持。")
  if (
    typeof metadata.workspacePath !== "string" ||
    !isAbsolute(metadata.workspacePath) ||
    !metadata.workspacePath.trim()
  )
    throw new BotError("INVALID_INPUT", "请先使用会话原有的目录入口选择工作目录，再关联任务。")
}
async function mutate<T>(
  host: LocalBotHost,
  threadId: string,
  operation: (
    row: NonNullable<ReturnType<typeof getThreadCore>>,
    metadata: Record<string, unknown>
  ) => Promise<T>,
  deletingWork?: { botId: string; workId: string }
): Promise<T> {
  const lease = requireThreadMutationLease(threadId, "原会话不存在。")
  return workflowRunManager.withThreadTransitionLease(threadId, () =>
    withThreadMutationLeaseLock(lease, async (row) => {
      const metadata = metadataOf(row.metadata)
      if (threadId === "heartbeat" || threadId.startsWith("heartbeat-"))
        throw new BotError("CONFLICT", "心跳专用会话不能关联普通任务。")
      if (goalManager.getActive(threadId))
        throw new BotError("CONFLICT", "请先暂停或完成当前 Goal，再关联任务。")
      if (isExternallyManagedThreadRunBusy(threadId, metadata))
        throw new BotError("CONFLICT", "请先停止或完成会话执行、审批和后台任务。")
      const runId = `conversation-link:${randomUUID()}`
      const claim = claimLocalThreadRunLease({ threadId, owner: "bot", runId })
      if (!claim.acquired) throw new BotError("CONFLICT", "此会话正在执行，请稍后关联。")
      try {
        if (hasPendingApprovalForRuntimeThread(threadId))
          throw new BotError("CONFLICT", "请先处理原会话的审批或待用户输入。")
        await withCheckpointer(threadId, async (saver) => {
          const tuple = await saver.getTuple({
            configurable: { thread_id: threadId, checkpoint_ns: "" }
          })
          if (
            tuple &&
            !describeCheckpointForkability(tuple, { allowLegacyLatestFallback: true })
              .isStableTurnBoundary
          )
            throw new BotError(
              "CONFLICT",
              "原会话还有未结算的执行或审批，请先在原会话处理后再关联。"
            )
        })
        await host.assertConversationLinkIdle(threadId, deletingWork)
        const latest = getThreadCore(threadId)
        if (!latest || !matchesThreadIncarnation(latest, lease.incarnation))
          throw new BotError("CONFLICT", "原会话在检查期间已变化，关联已停止。")
        return await operation(latest, metadataOf(latest.metadata))
      } finally {
        releaseLocalThreadRunLease(threadId, "bot", runId)
      }
    })
  )
}
function bindMetadata(work: BotWorkItem, metadata: Record<string, unknown>) {
  const next: Record<string, unknown> = {
    ...metadata,
    botId: work.botId,
    botHostId: "local",
    botWorkId: work.id,
    botAudienceKey: work.audienceKey,
    ...(work.source?.transport === "im" ? { botMockTransport: "im" } : {}),
    botLocalConversation: true,
    botWorkOrigin: work.conversation!.origin
  }
  if (work.source?.transport === "im" && metadata.botMockTransport !== "im") {
    // Same verified legacy upgrade as prepareBotThread; ordinary-list entry skips that adapter.
    delete next.disableAgentsPrompt
    delete next.allowedSkills
    delete next.allowedExperts
  }
  return next
}
export async function linkExistingConversation(
  host: LocalBotHost,
  input: LinkBotWorkConversationInput
) {
  const ref = localWorkConversationRef(input.conversation)
  return mutate(host, ref.threadId, async (row, metadata) => {
    if (!matchesThreadIncarnation(row, ref.incarnation))
      throw new BotError("CONFLICT", "原会话已变化，请重新确认。")
    assertBotNonTeamConversation(metadata)
    const previous = host.conversationLinks.forThread(ref.threadId)
    if (previous?.conversation) {
      const replay = host.conversationLinks.prepare(input)
      return finishBinding(host, replay, row, metadata)
    }
    assertOrdinary(metadata)
    const work = host.conversationLinks.prepare(input)
    return finishBinding(host, work, row, metadata)
  })
}
function finishBinding(
  host: LocalBotHost,
  work: BotWorkItem,
  row: NonNullable<ReturnType<typeof getThreadCore>>,
  metadata: Record<string, unknown>
) {
  const link = work.conversation!
  // A completed old binding may still be opened/unlinked to retain its history.
  // Preparing (including crash recovery) must not admit a new Team binding.
  if (link.state !== "bound") assertBotNonTeamConversation(metadata)
  if (
    link.ref.kind !== "local_thread" ||
    !matchesThreadIncarnation(row, link.ref.incarnation) ||
    !["preparing", "bound"].includes(link.state)
  )
    throw new BotError("CONFLICT", "任务关联已变化，旧操作不会重新接管会话。")
  if (metadata.botLocalConversation === true) verifyWorkConversationThread(work, row, metadata)
  else if (link.origin === "existing") assertOrdinary(metadata)
  else verifyWorkThreadMetadata(work, metadata)
  const boundMetadata = bindMetadata(work, metadata)
  verifyWorkConversationThread(work, row, boundMetadata)
  updateThread(row.thread_id, { metadata: JSON.stringify(boundMetadata) })
  const result = host.conversationLinks.bound(work.botId, work.id, link.ref)
  if (link.state !== "bound") host.conversationLinkChanged()
  return result
}
/** Opening either entrance completes only the durable identity handshake, never a model turn. */
export async function exposeWorkConversation(host: LocalBotHost, botId: string, workId: string) {
  const work = host.getWork(botId, workId)
  if (!isLocalBotWork(work))
    throw new BotError("CONFLICT", "模拟渠道任务不能在对话模式打开。")
  const row = getThreadCore(work.threadId)
  if (!row) throw new BotError("NOT_FOUND", "请先打开原任务会话；原消息不存在时不会创建替代历史。")
  if (work.conversation?.state === "detached") {
    // A historical result still points to this ordinary conversation. Navigation
    // must not bind it back to the old work, or accept a reused thread identity.
    if (
      work.conversation.ref.kind !== "local_thread" ||
      !matchesThreadIncarnation(row, work.conversation.ref.incarnation)
    )
      throw new BotError("CONFLICT", "原会话身份已变化，不能打开替代历史。")
    return work
  }
  if (work.conversation?.state === "bound") {
    verifyWorkConversationThread(work, row, metadataOf(row.metadata))
    return work
  }
  if (work.conversation?.origin === "existing")
    return mutate(host, work.threadId, async (latest, metadata) =>
      finishBinding(host, host.getWork(botId, workId), latest, metadata)
    )
  const lease = requireThreadMutationLease(work.threadId)
  return workflowRunManager.withThreadTransitionLease(work.threadId, () =>
    withThreadMutationLeaseLock(lease, (latest) => {
      const metadata = metadataOf(latest.metadata)
      verifyWorkThreadMetadata(work, metadata)
      const prepared = host.conversationLinks.prepareCreated(botId, workId, {
        kind: "local_thread",
        threadId: latest.thread_id,
        incarnation: captureThreadIncarnation(latest)
      })
      return finishBinding(host, prepared, latest, metadata)
    })
  )
}
export async function unlinkWorkConversation(
  host: LocalBotHost,
  botId: string,
  workId: string,
  version: number
) {
  return unlinkConversation(host, botId, workId, version, () => host.getWork(botId, workId))
}
/** Only remove() can supply this reader. General IPC never bypasses the deleting fence. */
export async function unlinkDeletingWorkConversation(
  host: LocalBotHost,
  botId: string,
  workId: string,
  version: number
) {
  const work = await unlinkConversation(host, botId, workId, version, () =>
    host.getWorkForDeletion(botId, workId), true
  )
  // Metadata and the mutation/run leases have been released. Preserve pending
  // Team results and let the original scheduler consume them as ordinary work.
  pendingNotificationScheduler.requestCheck(work.threadId)
  return work
}
async function unlinkConversation(
  host: LocalBotHost,
  botId: string,
  workId: string,
  version: number,
  readWork: () => BotWorkItem,
  forDeletion = false
) {
  const work = readWork()
  if (work.source) throw new BotError("CONFLICT", "招乎任务保留原会话归属，不能解除为私人会话。")
  if (work.conversation?.state === "detached") return work
  return mutate(host, work.threadId, async (row, metadata) => {
    const current = readWork()
    if (
      current.conversation?.ref.kind !== "local_thread" ||
      !matchesThreadIncarnation(row, current.conversation.ref.incarnation)
    )
      throw new BotError("CONFLICT", "原会话身份已变化，解除操作不会修改新会话。")
    if (metadata.botLocalConversation === true) verifyWorkConversationThread(current, row, metadata)
    else if (current.conversation?.state !== "detaching")
      throw new BotError("CONFLICT", "原关联身份已变化。")
    host.conversationLinks.beginDetach(botId, workId, version)
    const next = { ...metadata }
    for (const key of [
      "botId",
      "botHostId",
      "botWorkId",
      "botAudienceKey",
      "botLocalConversation",
      "botWorkOrigin"
    ])
      delete next[key]
    updateThread(row.thread_id, { metadata: JSON.stringify(next) })
    const result = host.conversationLinks.detached(botId, workId)
    host.conversationLinkChanged()
    return result
  }, forDeletion ? { botId, workId } : undefined)
}
export async function resolveWorkConversation(host: LocalBotHost, threadId: string) {
  let work = host.conversationLinks.forThread(threadId)
  if (!work) return null
  if (!isLocalBotWork(work)) throw new BotError("CONFLICT", "此任务不能在对话模式打开。")
  if (!work.conversation) work = await exposeWorkConversation(host, work.botId, work.id)
  if (work.conversation?.state === "detaching") {
    await unlinkWorkConversation(host, work.botId, work.id, work.version)
    return null
  }
  work = await exposeWorkConversation(host, work.botId, work.id)
  const row = getThreadCore(threadId)!
  const route = work.source ? host.imGateway.binding(work.source.bindingId) : null
  const imConversation = route?.binding.botId === work.botId && route.binding.kind === "group"
    ? {
        id: route.id,
        title: route.binding.peerLabel || "招乎群聊",
        state: route.binding.state === "active" ? "active" as const : "revoked" as const
      }
    : undefined
  return {
    bot: host.getBot(work.botId),
    work,
    workspacePath: String(metadataOf(row.metadata).workspacePath),
    ...(imConversation ? { imConversation } : {})
  }
}
