import { BotError } from "../../shared/bots/contracts"
import type { BotConversationToolSource } from "../../shared/bots/thread-history"
import { getThreadCore } from "../db"
import {
  captureThreadIncarnation,
  matchesThreadIncarnation,
  type ThreadIncarnation,
  type ThreadIncarnationRow
} from "../services/thread-incarnation"
import { verifyWorkDeletionThread, withBotThreadDeletionCheck } from "./conversation-link-authority"
import { removeUninitializedWorkInputPins } from "./attachment-storage"
import { withThreadRunMutationLock } from "../ipc/thread-run-mutation-lock"
import type { LocalBotHost } from "./host"

export interface BotWorkDeletionIdentity {
  botId: string
  workId: string
  threadId: string
  version: number
  incarnation: ThreadIncarnation | null
}

export interface BotWorkDeletionTarget extends BotWorkDeletionIdentity {
  title: string
}

export interface BotWorkDeletionRecord extends BotWorkDeletionIdentity {
  phase: "stopping" | "ready" | "deleted"
}

export interface BotWorkDeletionReceipt {
  botId: string
  workId: string
  state: "deleted" | "cleanup_pending"
  deletedThreadId?: string
  error?: string
}

export function captureBotWorkDeletionTarget(
  host: LocalBotHost,
  botId: string,
  workId: string,
  expectedVersion: number
): BotWorkDeletionTarget {
  const saved = host.workDeletionRecord(botId, workId)
  if (saved?.phase === "deleted") {
    if (saved.version !== expectedVersion)
      throw new BotError("CONFLICT", "任务版本已变化，请核对原删除结果。")
    return { ...saved, title: "已删除的工作" }
  }
  const work = host.getWork(botId, workId)
  if (work.version !== expectedVersion && saved?.version !== expectedVersion)
    throw new BotError("CONFLICT", "任务已变化，请刷新后重新确认。")
  if (
    work.source ||
    work.audienceKey !== "desktop" ||
    (work.conversation?.state === "detached" && !saved)
  )
    throw new BotError("CONFLICT", "只能删除本 Bot 仍管理的桌面工作。")
  const row = getThreadCore(work.threadId)
  const target = saved ?? {
    botId,
    workId,
    threadId: work.threadId,
    version: expectedVersion,
    incarnation: row ? captureThreadIncarnation(row) : null
  }
  if (row) {
    if (!target.incarnation || !matchesThreadIncarnation(row, target.incarnation))
      throw new BotError("CONFLICT", "原会话已变化，请重新确认。")
    verifyWorkDeletionThread(work, row, threadMetadata(row))
  } else if (
    (target.incarnation || work.threadInitialized || work.conversation) &&
    saved?.phase !== "ready"
  ) {
    throw new BotError("CONFLICT", "原任务会话缺失，请先核对删除状态。")
  }
  return { ...target, title: work.title }
}

function threadMetadata(row: ThreadIncarnationRow): Record<string, unknown> {
  try {
    const metadata = JSON.parse(row.metadata || "{}")
    if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) return metadata
  } catch {
    /* report the same error for malformed JSON and non-object metadata */
  }
  throw new BotError("CONFLICT", "原会话设置不可读，无法安全删除。")
}

export function removeBotWork(
  host: LocalBotHost,
  target: BotWorkDeletionTarget,
  deleteThread: (threadId: string) => Promise<void>,
  assertLive: () => void = () => {},
  source?: BotConversationToolSource
) {
  assertLive()
  // Recheck the exact row shown by the confirmation before establishing the durable fence.
  const latest = captureBotWorkDeletionTarget(host, target.botId, target.workId, target.version)
  if (
    latest.threadId !== target.threadId ||
    JSON.stringify(latest.incarnation) !== JSON.stringify(target.incarnation)
  )
    throw new BotError("CONFLICT", "待删除的原会话已变化，请重新确认。")
  return host.removeWork(
    target,
    async (readWork, ready) => {
      const { threadId, incarnation } = target
      const authorize = (
        id: string,
        row: ThreadIncarnationRow,
        metadata: Record<string, unknown>
      ) => {
        assertLive()
        const work = readWork()
        if (
          id !== threadId ||
          work.threadId !== threadId ||
          !incarnation ||
          !matchesThreadIncarnation(row, incarnation)
        )
          throw new BotError("CONFLICT", "原会话身份已变化，已停止删除。")
        verifyWorkDeletionThread(work, row, metadata)
      }
      const row = getThreadCore(threadId)
      if (!row) {
        const work = readWork()
        if (
          (incarnation || work.threadInitialized || work.conversation) &&
          host.workDeletionRecord(target.botId, target.workId)?.phase !== "ready"
        )
          throw new BotError("CONFLICT", "原会话在删除前已变化，请先核对状态。")
        ready()
        if (!incarnation) await withThreadRunMutationLock(threadId, async () => {
          if (getThreadCore(threadId)) throw new BotError("CONFLICT", "原会话在删除前已变化，请先核对状态。")
          await removeUninitializedWorkInputPins(readWork())
        })
        return incarnation ? threadId : undefined
      }
      const metadata = threadMetadata(row)
      authorize(threadId, row, metadata)
      const work = readWork()
      if (
        work.conversation?.origin === "existing" &&
        (metadata.botLocalConversation === true || work.conversation.state === "detaching")
      ) {
        const { unlinkWorkForSingleDeletion } = await import("./conversation-link-service")
        await unlinkWorkForSingleDeletion(host, work, readWork, assertLive)
      }
      assertLive()
      ready()
      try {
        await withBotThreadDeletionCheck(authorize, () => deleteThread(threadId))
      } catch (error) {
        if (getThreadCore(threadId)) throw error
      }
      if (getThreadCore(threadId))
        throw new BotError("CONFLICT", "原会话删除结果未确认，请核对后重试。")
      return threadId
    },
    assertLive,
    source
  )
}
