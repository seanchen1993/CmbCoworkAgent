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
import { verifyWorkConversationThread } from "./conversation-link-authority"
import type { BotWorkItem } from "../../shared/bots/work"

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
  ) => Promise<T>
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
        await host.assertConversationLinkIdle(threadId)
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
  return {
    ...metadata,
    botId: work.botId,
    botHostId: "local",
    botWorkId: work.id,
    botAudienceKey: "desktop",
    botLocalConversation: true,
    botWorkOrigin: work.conversation!.origin
  }
}
export async function linkExistingConversation(
  host: LocalBotHost,
  input: LinkBotWorkConversationInput
) {
  const ref = localWorkConversationRef(input.conversation)
  return mutate(host, ref.threadId, async (row, metadata) => {
    if (!matchesThreadIncarnation(row, ref.incarnation))
      throw new BotError("CONFLICT", "原会话已变化，请重新确认。")
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
  if (
    link.ref.kind !== "local_thread" ||
    !matchesThreadIncarnation(row, link.ref.incarnation) ||
    !["preparing", "bound"].includes(link.state)
  )
    throw new BotError("CONFLICT", "任务关联已变化，旧操作不会重新接管会话。")
  if (metadata.botLocalConversation === true) verifyWorkConversationThread(work, row, metadata)
  else if (link.origin === "existing") assertOrdinary(metadata)
  else if (
    metadata.botId !== work.botId ||
    metadata.botWorkId !== work.id ||
    metadata.botHostId !== "local" ||
    metadata.botMockBindingId != null ||
    metadata.botGroupId != null
  )
    throw new BotError("CONFLICT", "任务原会话身份已变化。")
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
  if (work.source || work.audienceKey !== "desktop")
    throw new BotError("CONFLICT", "模拟渠道任务不能转为本机私有会话。")
  const row = getThreadCore(work.threadId)
  if (!row) throw new BotError("NOT_FOUND", "请先打开原任务会话；原消息不存在时不会创建替代历史。")
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
  return unlinkConversation(host, botId, workId, version, () =>
    host.getWorkForDeletion(botId, workId)
  )
}
async function unlinkConversation(
  host: LocalBotHost,
  botId: string,
  workId: string,
  version: number,
  readWork: () => BotWorkItem
) {
  const work = readWork()
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
  })
}
export async function resolveWorkConversation(host: LocalBotHost, threadId: string) {
  let work = host.conversationLinks.forThread(threadId)
  if (!work || work.source || work.audienceKey !== "desktop") return null
  if (!work.conversation) work = await exposeWorkConversation(host, work.botId, work.id)
  if (work.conversation?.state === "detaching") {
    await unlinkWorkConversation(host, work.botId, work.id, work.version)
    return null
  }
  work = await exposeWorkConversation(host, work.botId, work.id)
  const row = getThreadCore(threadId)!
  return {
    bot: host.getBot(work.botId),
    work,
    workspacePath: String(metadataOf(row.metadata).workspacePath)
  }
}
