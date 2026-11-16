import { BotError } from "../../shared/bots/contracts"
import { assertBotNonTeamConversation } from "../../shared/bots/team-policy"
import type {
  BotConversationToolReceipt,
  BotConversationToolsPort,
  BotOrdinaryThreadRef
} from "../../shared/bots/thread-history"
import type { BotWorkItem } from "../../shared/bots/work"
import { getThreadCore } from "../db"
import type { ThreadDeletionService } from "../ipc/threads"
import { captureThreadIncarnation, matchesThreadIncarnation, type ThreadIncarnationRow } from "../services/thread-incarnation"
import { verifyUnexposedWorkUnlinkThread, verifyWorkConversationThread, withBotThreadDeletionCheck } from "./conversation-link-authority"
import { conversationToolOperationId } from "./conversation-link-store"
import { localWorkConversationRef } from "./conversation-link-validation"
import { requestBotConversationTransition } from "./conversation-transition"
import type { LocalBotHost } from "./host"
import { isOrdinaryBotConversation } from "./ordinary-thread-policy"
import { captureBotWorkDeletionTarget, removeBotWork } from "./work-deletion"
import { botHistoryHidesTitle } from "./history-input-projection"

let deleteConversation: ThreadDeletionService | undefined
/** Installed with the original desktop IPC services, never supplied by a tool or renderer. */
export function setBotConversationDeletionService(service: ThreadDeletionService | undefined) {
  deleteConversation = service
}

function originalThread(ref: BotOrdinaryThreadRef) {
  const row = getThreadCore(ref.threadId)
  if (!row || !matchesThreadIncarnation(row, ref.incarnation))
    throw new BotError("CONFLICT", "原会话已变化，请重新确认。")
  let metadata: Record<string, unknown>
  try {
    metadata = JSON.parse(row.metadata || "{}")
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new Error()
  } catch {
    throw new BotError("CONFLICT", "原会话设置不可读，请先修复。")
  }
  return { row, metadata }
}

function receipt(
  work: BotWorkItem,
  state: BotConversationToolReceipt["state"]
): BotConversationToolReceipt {
  if (work.conversation?.state !== state || work.conversation.ref.kind !== "local_thread")
    throw new BotError("CONFLICT", "原操作尚未结算，请核对原工作和会话状态。")
  return { workId: work.id, version: work.version, conversation: work.conversation.ref, state }
}

/** Desktop draft handoff around the existing mutation and journal. No task is queued here. */
export function createBotConversationTools(getHost: () => LocalBotHost): BotConversationToolsPort {
  return {
    async link(botId, input, source, signal, assertLive) {
      const host = getHost()
      const conversation = localWorkConversationRef(input.conversation)
      const linkInput = {
        ...input,
        botId,
        conversation,
        operationId: conversationToolOperationId(source)
      }
      assertLive()
      const previous = host.conversationLinks.linkReceipt(linkInput, source)
      const { row, metadata } = originalThread(conversation)
      assertBotNonTeamConversation(metadata)
      const current = host.conversationLinks.forThread(conversation.threadId)
      if (previous?.conversation?.state === "bound") {
        host.assertWorkNotDeleting(previous)
        if (current?.id !== previous.id)
          throw new BotError("CONFLICT", "原任务关联已变化，请核对原会话。")
        verifyWorkConversationThread(previous, row, metadata)
        return receipt(previous, "bound")
      }
      if (previous ? current?.id !== previous.id : current || !isOrdinaryBotConversation(metadata))
        throw new BotError("CONFLICT", "只能关联尚未由其他工作管理的普通本机会话。")
      const { linkExistingConversation, preflightExistingConversationLink } = await import("./conversation-link-service")
      await preflightExistingConversationLink(host, row, metadata, !previous)
      assertLive()
      const work = await requestBotConversationTransition(
        { action: "link", threadId: conversation.threadId, incarnation: conversation.incarnation },
        signal,
        async () => {
          assertLive()
          return linkExistingConversation(host, linkInput, assertLive, source)
        }
      )
      return receipt(work, "bound")
    },
    async deleteThread(botId, input, source, signal, assertLive) {
      const host = getHost(), service = deleteConversation
      assertLive()
      if (!service) throw new BotError("CONFLICT", "原会话清理服务尚未就绪。")
      const ref = localWorkConversationRef(input.conversation)
      if (typeof input.expectedTitle !== "string" || !input.expectedTitle || input.expectedTitle.length > 4096)
        throw new BotError("INVALID_INPUT", "待删除会话名称无效。")
      const previous = host.conversationLinks.ordinaryDeletion(botId, input, source)
      const check = (threadId: string, row: ThreadIncarnationRow, metadata: Record<string, unknown>) => {
        assertLive()
        if (threadId !== ref.threadId || !matchesThreadIncarnation(row, ref.incarnation) ||
            host.conversationLinks.forThread(threadId) || !isOrdinaryBotConversation(metadata))
          throw new BotError("CONFLICT", "待删除会话已变化，请重新查询并确认。")
        if ((getThreadCore(threadId)?.title || "未命名会话") !== input.expectedTitle)
          throw new BotError("CONFLICT", botHistoryHidesTitle(threadId, row)
            ? "无法用隐藏的历史标题确认会话，请在原工作台打开会话并删除。"
            : "待删除会话已变化，请重新查询并确认。")
      }
      // Only a recorded, explicitly confirmed operation can settle an already removed row.
      if (previous && !getThreadCore(ref.threadId)) {
        host.conversationLinks.ordinaryDeletion(botId, input, source, "deleted")
        return { state: "deleted", deletedThreadId: ref.threadId }
      }
      const original = originalThread(ref)
      check(ref.threadId, original.row, original.metadata)
      if (previous?.phase === "deleted") throw new BotError("CONFLICT", "原删除已完成，不能再次删除后来恢复的会话。")
      return requestBotConversationTransition(
        { action: "delete", title: input.expectedTitle, threadId: ref.threadId }, signal,
        async event => {
          if (!event) throw new BotError("CONFLICT", "缺少实际桌面确认。")
          const current = originalThread(ref)
          check(ref.threadId, current.row, current.metadata)
          host.conversationLinks.ordinaryDeletion(botId, input, source, "confirmed")
          try {
            await withBotThreadDeletionCheck(check, () => service(event, ref.threadId))
          } catch (error) {
            if (getThreadCore(ref.threadId)) throw error
          }
          if (getThreadCore(ref.threadId)) throw new BotError("CONFLICT", "原会话删除结果尚未确认。")
          try {
            host.conversationLinks.ordinaryDeletion(botId, input, source, "deleted")
            return { state: "deleted" as const, deletedThreadId: ref.threadId }
          } catch {
            return { state: "cleanup_pending" as const, deletedThreadId: ref.threadId, error: "原会话已删除，删除回执尚未写入，请核对后重试。" }
          }
        }, result => ({ deletedThreadId: result.deletedThreadId, ...(result.error ? { error: result.error } : {}) })
      )
    },
    async deleteWork(botId, input, source, signal, assertLive) {
      const host = getHost(), service = deleteConversation
      assertLive()
      if (!service) throw new BotError("CONFLICT", "原会话清理服务尚未就绪。")
      const target = captureBotWorkDeletionTarget(host, botId, input.workId, input.expectedVersion)
      if (host.workDeletionRecord(botId, input.workId)?.phase === "deleted")
        return removeBotWork(host, target, async () => { throw new BotError("CONFLICT", "已删除工作不可重复清理。") }, assertLive, source)
      return requestBotConversationTransition(
        { action: "delete", title: target.title, ...(target.incarnation ? { threadId: target.threadId } : {}),
          work: { botId, workId: target.workId } }, signal,
        async event => {
          if (!event) throw new BotError("CONFLICT", "缺少实际桌面确认。")
          return removeBotWork(host, target, threadId => service(event, threadId, { requireIdle: true }), assertLive, source)
        }, result => ({
          ...(result.deletedThreadId ? { deletedThreadId: result.deletedThreadId } : {}),
          ...(result.state === "deleted" ? { deletedWork: { botId, workId: target.workId } } : { error: result.error })
        })
      )
    },
    async unlink(botId, input, source, signal, assertLive) {
      const host = getHost()
      assertLive()
      const { workId, expectedVersion } = input
      const work = host.getWork(botId, workId)
      host.assertWorkNotDeleting(work)
      const link = work.conversation
      if (work.source || work.audienceKey !== "desktop" || (link && link.ref.kind !== "local_thread"))
        throw new BotError("CONFLICT", "只能解除此 Bot 的桌面本机会话关联。")
      const nativeRow = !link && work.threadInitialized ? getThreadCore(work.threadId) : null
      const unexposedRef: BotOrdinaryThreadRef | undefined = nativeRow ? {
        kind: "local_thread", threadId: work.threadId, incarnation: captureThreadIncarnation(nativeRow)
      } : undefined
      const ref = link?.ref ?? unexposedRef
      if (ref?.kind !== "local_thread") throw new BotError("CONFLICT", "原任务尚无可解除的本机会话关联。")
      const replay = host.conversationLinks.unlinkReceipt(work, expectedVersion, source, ref)
      const { row, metadata } = originalThread(ref)
      if (link?.state === "detached" && replay) return receipt(work, "detached")
      if (
        !(unexposedRef || link?.state === "bound" || (replay && link?.state === "detaching")) ||
        host.conversationLinks.forThread(ref.threadId)?.id !== work.id
      )
        throw new BotError("CONFLICT", "原任务关联已变化，请核对原操作回执。")
      if (unexposedRef || link?.state === "bound") {
        if (unexposedRef) verifyUnexposedWorkUnlinkThread(work, row, metadata)
        else verifyWorkConversationThread(work, row, metadata)
        if (work.version !== expectedVersion)
          throw new BotError("CONFLICT", "任务已变化，请刷新后重新确认。")
      }
      const workspacePath = metadata.workspacePath
      if (typeof workspacePath !== "string" || !workspacePath.trim())
        throw new BotError("CONFLICT", "原会话目录无效，请核对原会话。")
      const detached = await requestBotConversationTransition(
        {
          action: "unlink",
          threadId: ref.threadId,
          link: { bot: host.getBot(botId), work, workspacePath },
          ...(unexposedRef ? { unexposedRef } : {})
        },
        signal,
        async () => {
          const { unlinkWorkConversation } = await import("./conversation-link-service")
          assertLive()
          return unlinkWorkConversation(host, botId, workId, expectedVersion, assertLive, source, unexposedRef)
        }
      )
      return receipt(detached, "detached")
    }
  }
}
