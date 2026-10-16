import { getThreadCore, getThreadMessagesByIds } from "../db"
import { pendingNotificationScheduler } from "../agent/pending-notification-scheduler"
import { createBotNotificationDispatcher } from "./notification-dispatch"
import { BotError } from "../../shared/bots/contracts"
import { join } from "node:path"
import { getCmbCoworkAgentDataRoot } from "../app-data-root"
import { openNativeSqliteDatabase, type NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { BotStore } from "./store"
import { LocalBotHost } from "./host"
import { createLocalBotRunPort } from "./runtime-adapter"
import { BotMemoryService } from "./memory"
import { computeNextRunAt } from "../storage"
import { BotBrowserService } from "./browser"
import { startElectronBotBrowser } from "./electron-browser-engine"
import { botDirectory } from "./paths"
import { createBotMemoryMaintainer } from "./memory-summary-adapter"
import type { BotMemoryMaintainer } from "./memory-maintainer"
import { splitBotInlineReasoning } from "../../shared/bots/inline-reasoning"

let host: LocalBotHost | undefined
let database: NativeSqliteAdapter | undefined
let memory: BotMemoryService | undefined
let browser: BotBrowserService | undefined
let summaries: BotMemoryMaintainer | undefined
let shutdown: Promise<void> | undefined

export function getBotBrowserService(): BotBrowserService {
  return (browser ??= new BotBrowserService(
    () => startElectronBotBrowser(join(getCmbCoworkAgentDataRoot(), "bots", "browser-profile")),
    (scope) =>
      botDirectory(
        join(getCmbCoworkAgentDataRoot(), "bots"),
        "workspaces",
        scope.startsWith("group-") ? scope.split("--")[0] : scope
      )
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
    summaries ??= createBotMemoryMaintainer(getBotMemoryService(), (id) => {
      if (shutdown || !host) return false
      try {
        // Eligibility needs one Bot, not a snapshot of every queue, group and schedule.
        return !host.getBot(id).archived
      } catch {
        return false
      }
    })
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
          return {
            id: message.id,
            ordinal: message.ordinal!,
            role: message.role,
            text: message.role === "assistant" ? splitBotInlineReasoning(text).body : text
          }
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
    return host
  } catch (error) {
    database.close()
    database = undefined
    throw error
  }
}

export function hasActiveBotRuns(): boolean {
  return host?.hasActiveRuns() ?? false
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
    }
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []
    )
    if (errors.length) throw new AggregateError(errors, "Bot 退出清理未全部完成")
  })
  return shutdown
}
