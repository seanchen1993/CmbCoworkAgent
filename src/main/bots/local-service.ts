import { getThreadCore, getThreadMessagesByIds, getThreadMessagesAfterAnyId } from "../db"
import { pendingNotificationScheduler } from "../agent/pending-notification-scheduler"
import { createBotNotificationDispatcher } from "./notification-dispatch"
import { BotError } from "../../shared/bots/contracts"
import { join } from "node:path"
import { existsSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { getCmbCoworkAgentDataRoot } from "../app-data-root"
import { openNativeSqliteDatabase, NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { BotStore } from "./store"
import { LocalBotHost } from "./host"
import { verifyWorkConversationThread } from "./conversation-link-authority"
import { createLocalBotRunPort } from "./runtime-adapter"
import { BotMemoryService } from "./memory"
import { computeNextRunAt } from "../storage"
import { BotBrowserService } from "./browser"
import { startElectronBotBrowser } from "./electron-browser-engine"
import { botDirectory } from "./paths"
import { createBotMemoryMaintainer } from "./memory-summary-adapter"
import { isBotMemoryEnabled } from "./memory-policy"
import type { BotMemoryMaintainer } from "./memory-maintainer"
import { splitBotInlineReasoning } from "../../shared/bots/inline-reasoning"
import { setWorkConversationLookup } from "./conversation-link-authority"
import { parseBotFileDelivery } from "../../shared/bots/file-delivery"

let host: LocalBotHost | undefined
let database: NativeSqliteAdapter | undefined
let memory: BotMemoryService | undefined
let browser: BotBrowserService | undefined
let summaries: BotMemoryMaintainer | undefined
let shutdown: Promise<void> | undefined

/** Read-only group file access does not depend on a member's execution thread. */
export function getBotGroupFileWorkspace(groupId: string): string {
  getLocalBotHost().getGroup(groupId)
  return botDirectory(join(getCmbCoworkAgentDataRoot(), "bots"), "workspaces", `group-${groupId}`)
}

export function getBotBrowserService(): BotBrowserService {
  return (browser ??= new BotBrowserService(
    () => startElectronBotBrowser(join(getCmbCoworkAgentDataRoot(), "bots", "browser-profile")),
    (scope) => {
      if (scope.startsWith("work-")) {
        const [workId, botId] = scope.slice(5).split("--")
        const work = getLocalBotHost().getWork(botId, workId),
          row = getThreadCore(work.threadId)
        if (work.conversation) {
          if (!row || work.conversation.state !== "bound")
            throw new BotError("CONFLICT", "原任务会话关联不可用")
          const metadata = JSON.parse(row.metadata || "{}")
          verifyWorkConversationThread(work, row, metadata)
          return metadata.workspacePath
        }
        if (work.workspace) return work.workspace.path
      }
      return botDirectory(
        join(getCmbCoworkAgentDataRoot(), "bots"),
        "workspaces",
        scope.startsWith("group-")
          ? scope.split("--")[0]
          : scope.startsWith("work-")
            ? scope.split("--")[1]
            : scope
      )
    }
  ))
}

export function getBotMemoryService(): BotMemoryService {
  return (memory ??= new BotMemoryService(join(getCmbCoworkAgentDataRoot(), "bots"), (botId) => {
    if (!shutdown) host?.memoryChanged(botId)
  }))
}

export function initializeBotNotificationDispatch(): void {
  const dispatch = createBotNotificationDispatcher(getThreadCore, getLocalBotHost)
  pendingNotificationScheduler.setManagedDispatcher((notice) =>
    shutdown ? Promise.resolve(true) : dispatch(notice)
  )
}

export function getLocalBotHost(): LocalBotHost {
  if (shutdown) throw new BotError("STOPPING", "应用正在退出，请稍后重试")
  if (host) return host
  database = openNativeSqliteDatabase(
    join(getCmbCoworkAgentDataRoot(), "bots", "control.sqlite"),
    "Bots"
  ).database
  try {
    summaries ??= createBotMemoryMaintainer(
      getBotMemoryService(),
      (id, version) => {
        if (shutdown || !host) return false
        try {
          // A settings change also invalidates an already queued/in-flight summary.
          const bot = host.getBot(id)
          return !bot.archived && (version === undefined || bot.version === version)
        } catch {
          return false
        }
      },
      (id) => isBotMemoryEnabled(host!.getBot(id))
    )
    host = new LocalBotHost(
      new BotStore(
        database,
        Date.now,
        (threadId, ids) => {
          const messages = new Map<string, string>()
          for (const message of getThreadMessagesByIds(threadId, ids))
            if (message.role === "user" && typeof message.content === "string")
              messages.set(message.id, message.content)
          return messages
        },
        (threadId, messageId) => {
          const message = getThreadMessagesByIds(threadId, [messageId])[0]
          if (
            !message ||
            (message.role !== "user" && message.role !== "assistant") ||
            !Number.isSafeInteger(message.ordinal)
          )
            return null
          const text =
            typeof message.content === "string"
              ? message.content
              : message.content
                  .filter((block) => block.type === "text")
                  .map((block) => block.text ?? "")
                  .join("\n")
          let body = message.role === "assistant" ? splitBotInlineReasoning(text).body : text
          let preview: string | undefined
          // Quote published bytes, not the mutable working path or model-supplied arguments.
          // Receipts belong to this exact assistant batch; never follow reused ids into a later turn.
          if (message.role === "assistant" && message.tool_calls?.some(call => call.name === "bot_deliver_files")) {
            const calls = new Set(message.tool_calls.filter(call => call.name === "bot_deliver_files").map(call => call.id))
            const references: string[] = []
            const names: string[] = []
            let remaining = 7_000
            let omitted = 0
            for (const result of getThreadMessagesAfterAnyId(threadId, [messageId], message.tool_calls.length)) {
              if (result.role !== "tool") break
              if (result.is_error || result.name !== "bot_deliver_files" || !calls.delete(result.tool_call_id ?? "")) continue
              for (const file of parseBotFileDelivery(result.content) ?? []) {
                const reference = JSON.stringify({ name: file.name.slice(0, 200), path: file.attachmentPath ?? file.filePath, size: file.size })
                if (reference.length + 1 > remaining) { omitted++; continue }
                references.push(reference)
                names.push(file.name.slice(0, 200))
                remaining -= reference.length + 1
              }
            }
            if (references.length) {
              preview = ("📎 " + names.join("、") + (omitted ? `（另${omitted}份）` : "")).slice(0, 2_000)
              const files = "已发送附件（引用资料）：\n" + references.join("\n") +
                (omitted ? `\n另有${omitted}份附件超出引用预览，请从原消息查看。` : "")
              body = files + (body ? "\n\n" + body.slice(0, 8_000 - files.length - 2) : "")
            }
          }
          return {
            id: message.id,
            ordinal: message.ordinal!,
            role: message.role,
            text: body,
            ...(preview ? { preview } : {})
          }
        },
        (request, messageId) => {
          const message = getThreadMessagesByIds(request.threadId, [messageId])[0]
          if (
            message?.role !== "tool" ||
            message.name !== "request_user_input" ||
            typeof message.content !== "string"
          )
            return undefined
          try {
            if (JSON.parse(message.content).requestId === request.requestId)
              return { content: message.content, is_error: message.is_error }
          } catch {
            /* A malformed receipt cannot supply an answer. */
          }
          return undefined
        },
        (threadId, ids) =>
          getThreadMessagesByIds(threadId, ids).flatMap((message) => {
            if (
              (message.role !== "user" && message.role !== "assistant") ||
              !Number.isSafeInteger(message.ordinal)
            )
              return []
            const text =
              typeof message.content === "string"
                ? message.content
                : message.content
                    .filter((b) => b.type === "text")
                    .map((b) => b.text ?? "")
                    .join("\n")
            return [
              {
                id: message.id,
                ordinal: message.ordinal!,
                role: message.role,
                text: message.role === "assistant" ? splitBotInlineReasoning(text).body : text
              }
            ]
          }),
        (botId, threadId, ids, work) => {
          const row = getThreadCore(threadId)
          if (!row) return []
          let metadata: Record<string, unknown>
          try {
            const value: unknown = JSON.parse(row.metadata || "{}")
            if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error()
            metadata = value as Record<string, unknown>
          } catch {
            throw new BotError("CONFLICT", "原消息会话元数据无效")
          }
          if (work?.conversation) verifyWorkConversationThread(work, row, metadata)
          else if (
            metadata.botHostId !== "local" ||
            metadata.botId !== botId ||
            metadata.botGroupId != null ||
            (metadata.botWorkId ?? undefined) !== work?.id
          )
            throw new BotError("CONFLICT", "原消息会话归属已改变")
          // Identity only: file-only messages are eligible; no transcript text is
          // copied into the control database or returned by the reaction protocol.
          return getThreadMessagesByIds(threadId, ids).flatMap((message) =>
            (message.role === "user" || message.role === "assistant") &&
            Number.isSafeInteger(message.ordinal) &&
            message.ordinal! >= 0
              ? [{ id: message.id, ordinal: message.ordinal!, role: message.role }]
              : []
          )
        }
      ),
      createLocalBotRunPort(
        getBotMemoryService(),
        getLocalBotHost,
        getBotBrowserService(),
        summaries
      ),
      2,
      console.error,
      (input, from) =>
        computeNextRunAt(
          input.frequency,
          from,
          input.runAtTime,
          input.weekday,
          input.runAt,
          input.intervalMinutes
        )
    )
    setWorkConversationLookup((threadId) => host?.conversationLinks.forThread(threadId) ?? null)
    return host
  } catch (error) {
    database.close()
    database = undefined
    throw error
  }
}

export function hasActiveBotRuns(): boolean {
  // Native window/quit callbacks can run again after Bot cleanup closed the store.
  return database ? (host?.hasActiveRuns() ?? false) : false
}

/** Post-commit native thread cleanup must never recover storage or start Bot execution. */
export function removeLocalBotMessageReactionsForThreads(threadIds: readonly string[]): void {
  const ids = [...new Set(threadIds)]
  if (!ids.length) return
  if (shutdown) throw new BotError("STOPPING", "Bot 存储正在退出，未清理消息反应")
  if (host && database) {
    host.removeMessageReactionsForThreads(ids)
    return
  }
  const path = join(getCmbCoworkAgentDataRoot(), "bots", "control.sqlite")
  if (!existsSync(path)) return
  // The normal opener performs recovery/migrations. Orphan cleanup only opens this existing DB.
  const cleanup = new NativeSqliteAdapter(new DatabaseSync(path, { timeout: 0 }))
  try {
    if (
      !cleanup.exec(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='bot_message_reactions'"
      )[0]?.values.length
    )
      return
    cleanup.run("BEGIN IMMEDIATE")
    try {
      for (let offset = 0; offset < ids.length; offset += 100) {
        const batch = ids.slice(offset, offset + 100)
        cleanup.run(
          `DELETE FROM bot_message_reactions WHERE scope_kind='thread' AND scope_id IN (${batch.map(() => "?").join(",")})`,
          batch
        )
      }
      cleanup.run("COMMIT")
    } catch (error) {
      try {
        cleanup.run("ROLLBACK")
      } catch {
        /* Preserve the cleanup failure. */
      }
      throw error
    }
    // No live host/observer exists; already-deleted thread rows cannot be queried as reactions.
    // Keep the control schema and its revision protocol owned by BotStore.
  } finally {
    cleanup.close({ checkpoint: false })
  }
}

export function stopLocalBotHost(): Promise<void> {
  if (shutdown) return shutdown
  shutdown = Promise.resolve().then(async () => {
    const results: PromiseSettledResult<unknown>[] = []
    results.push(...(await Promise.allSettled([host?.stop()])))
    results.push(...(await Promise.allSettled([browser?.close(), summaries?.close()])))
    results.push(...(await Promise.allSettled([memory?.close()])))
    try {
      database?.close()
    } finally {
      database = undefined
      setWorkConversationLookup(undefined)
    }
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []
    )
    if (errors.length) throw new AggregateError(errors, "Bot 退出清理未全部完成")
  })
  return shutdown
}
