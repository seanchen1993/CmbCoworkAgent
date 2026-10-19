import { BrowserWindow, powerMonitor, type IpcMain } from "electron"
import { BotError, LOCAL_BOT_HOST_ID } from "../../shared/bots/contracts"
import {
  botIdentifier,
  parseCreateBot,
  parseSendBotMessage,
  parseUpdateBot,
  parseWriteBotMemory,
  memoryVersion,
  parseSchedule,
  parseExistingVersion,
  parseGroup,
  parseGroupMessage,
  parseGroupHistoryCursor,
  parseBotRequestChecks
} from "../../shared/bots/validation"
import { prepareBotThread } from "../bots/runtime-adapter"
import {
  initializeBotNotificationDispatch,
  getLocalBotHost,
  getBotMemoryService,
  getBotBrowserService
} from "../bots/local-service"
import { getThreadCore } from "../db"
import type { ThreadDeletionService } from "./threads"
import { registerBotFileHandlers } from "./bot-files"

function localHost(id: unknown) {
  if (id !== LOCAL_BOT_HOST_ID) throw new BotError("UNSUPPORTED_HOST", "此版本仅支持本机 Bot")
  return getLocalBotHost()
}

export function registerBotHandlers(ipcMain: IpcMain, deleteThread?: ThreadDeletionService): void {
  initializeBotNotificationDispatch()
  let subscribedHost: ReturnType<typeof getLocalBotHost> | undefined
  const hostFor = (id: unknown) => {
    const host = localHost(id)
    if (!subscribedHost) {
      host.subscribe((event) => {
        for (const window of BrowserWindow.getAllWindows()) {
          if (!window.isDestroyed() && !window.webContents.isDestroyed())
            window.webContents.send("bots:changed", event)
        }
      })
      subscribedHost = host
    }
    return host
  }
  // Optional workspace initialization must not prevent the existing workbench from opening.
  try {
    hostFor(LOCAL_BOT_HOST_ID)
  } catch (error) {
    console.error("[Bots] Local host unavailable", error)
  }

  registerBotFileHandlers(ipcMain, hostFor)
  ipcMain.handle(
    "bots:browser:preview",
    (_event, hostId: unknown, id: unknown, pageId: unknown) => {
      const scope = hostFor(hostId).browserScope(botIdentifier(id))
      return getBotBrowserService().preview(
        scope,
        pageId == null ? undefined : botIdentifier(pageId)
      )
    }
  )
  ipcMain.handle(
    "bots:browser:takeover",
    (_event, hostId: unknown, id: unknown, pageId: unknown) => {
      const scope = hostFor(hostId).browserScope(botIdentifier(id))
      return getBotBrowserService().takeOver(
        scope,
        pageId == null ? undefined : botIdentifier(pageId)
      )
    }
  )
  ipcMain.handle(
    "bots:browser:give-back",
    (_event, hostId: unknown, id: unknown, generation: unknown) => {
      const scope = hostFor(hostId).browserScope(botIdentifier(id))
      if (
        generation !== undefined &&
        (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 0)
      )
        throw new BotError("INVALID_INPUT", "浏览器控制版本无效")
      return getBotBrowserService().giveBack(scope, generation as number | undefined)
    }
  )
  ipcMain.handle(
    "bots:browser:navigate",
    (_event, hostId: unknown, id: unknown, pageId: unknown, url: unknown) => {
      const scope = hostFor(hostId).browserScope(botIdentifier(id))
      if (typeof url !== "string" || url.length > 4096 || url.includes("\0"))
        throw new BotError("INVALID_INPUT", "网页地址无效")
      return getBotBrowserService().navigateAsHuman(scope, botIdentifier(pageId), url)
    }
  )
  ipcMain.handle("bots:group:remove", (event, hostId: unknown, id: unknown, version: unknown) => {
    const host = hostFor(hostId),
      target = parseExistingVersion({ id, version })!
    if (!deleteThread) throw new BotError("CONFLICT", "会话清理服务尚未就绪")
    return host.removeGroup(target.id, target.version, async (threadIds) => {
      for (const threadId of threadIds) {
        const thread = getThreadCore(threadId)
        if (!thread) continue
        const metadata = JSON.parse(thread.metadata || "{}") as Record<string, unknown>
        if (metadata?.botGroupId !== target.id || metadata.botHostId !== LOCAL_BOT_HOST_ID)
          throw new BotError("CONFLICT", "群成员会话归属已改变，已停止删除")
        await deleteThread(event, threadId, { requireIdle: true })
      }
      await getBotBrowserService().removeGroup(target.id)
    })
  })
  ipcMain.handle("bots:group:save", (_event, hostId: unknown, input: unknown, existing: unknown) =>
    hostFor(hostId).saveGroup(parseGroup(input), parseExistingVersion(existing))
  )
  ipcMain.handle("bots:group:messages", (_event, hostId: unknown, id: unknown, cursor: unknown) =>
    hostFor(hostId).groupMessages(botIdentifier(id), parseGroupHistoryCursor(cursor))
  )
  ipcMain.handle("bots:group:send", (_event, hostId: unknown, input: unknown) =>
    hostFor(hostId).sendGroup(parseGroupMessage(input))
  )
  powerMonitor.on("resume", () => subscribedHost?.resume())
  ipcMain.handle("bots:open", (_event, hostId: unknown, id: unknown) => {
    const host = hostFor(hostId)
    const bot = host.getBot(botIdentifier(id))
    prepareBotThread(bot)
    host.introduce(bot.id)
    return { threadId: bot.threadId }
  })
  ipcMain.handle("bots:snapshot", (_event, hostId: unknown) => hostFor(hostId).snapshot())
  ipcMain.handle(
    "bots:exchange",
    (_event, hostId: unknown, botId: unknown, taskId: unknown, groupId: unknown) =>
      hostFor(hostId).exchange(
        botIdentifier(botId),
        botIdentifier(taskId),
        groupId == null ? undefined : botIdentifier(groupId)
      )
  )
  ipcMain.handle(
    "bots:exchange-history",
    (_event, hostId: unknown, botId: unknown, taskId: unknown, groupId: unknown, before: unknown) =>
      hostFor(hostId).exchangeHistory(
        botIdentifier(botId),
        botIdentifier(taskId),
        groupId == null ? undefined : botIdentifier(groupId),
        before == null ? undefined : botIdentifier(before)
      )
  )
  ipcMain.handle(
    "bots:message-origins",
    (_event, hostId: unknown, botId: unknown, ids: unknown, groupId: unknown) => {
      if (!Array.isArray(ids) || ids.length > 100)
        throw new BotError("INVALID_INPUT", "消息来源查询无效")
      return hostFor(hostId).messageOrigins(
        botIdentifier(botId),
        ids.map((id) => {
          // Transcript IDs also include host notification namespaces. They are SQL values,
          // never filesystem owners; keep Bot/group validation strict and separate.
          if (typeof id !== "string" || !/^[A-Za-z0-9_-][A-Za-z0-9_.:-]{0,511}$/.test(id))
            throw new BotError("INVALID_INPUT", "消息标识格式无效")
          return id
        }),
        groupId == null ? undefined : botIdentifier(groupId)
      )
    }
  )
  ipcMain.handle("bots:mark-unread", (_event, hostId: unknown, kind: unknown, id: unknown) => {
    if (kind !== "bot" && kind !== "group") throw new BotError("INVALID_INPUT", "会话类型无效")
    return hostFor(hostId).markUnread(kind, botIdentifier(id))
  })
  ipcMain.handle(
    "bots:request-receipts",
    (_event, hostId: unknown, botId: unknown, checks: unknown) =>
      hostFor(hostId).requestReceipts(botIdentifier(botId), parseBotRequestChecks(checks))
  )
  ipcMain.handle(
    "bots:stop-conversation",
    (_event, hostId: unknown, botId: unknown, groupId: unknown) =>
      hostFor(hostId).stopConversation(
        botIdentifier(botId),
        groupId === undefined ? undefined : botIdentifier(groupId)
      )
  )
  ipcMain.handle(
    "bots:mark-read",
    (_event, hostId: unknown, kind: unknown, id: unknown, version: unknown) => {
      if (
        (kind !== "bot" && kind !== "group") ||
        !Number.isSafeInteger(version) ||
        Number(version) < 1
      )
        throw new BotError("INVALID_INPUT", "已读位置无效")
      return hostFor(hostId).markRead(kind, botIdentifier(id), Number(version))
    }
  )
  ipcMain.handle("bots:memory:list", (_event, hostId: unknown, id: unknown) => {
    const bot = hostFor(hostId).getBot(botIdentifier(id))
    return getBotMemoryService().list(bot.id)
  })
  ipcMain.handle("bots:memory:write", (_event, hostId: unknown, id: unknown, input: unknown) => {
    const bot = hostFor(hostId).getBot(botIdentifier(id))
    return getBotMemoryService().write(bot.id, parseWriteBotMemory(input))
  })
  ipcMain.handle(
    "bots:memory:remove",
    (_event, hostId: unknown, botId: unknown, id: unknown, version: unknown) => {
      const bot = hostFor(hostId).getBot(botIdentifier(botId))
      return getBotMemoryService().remove(bot.id, botIdentifier(id), memoryVersion(version))
    }
  )
  ipcMain.handle("bots:create", (_event, hostId: unknown, input: unknown) =>
    hostFor(hostId).create(parseCreateBot(input))
  )
  ipcMain.handle(
    "bots:memory:share",
    (_event, hostId: unknown, botId: unknown, id: unknown, version: unknown, targetId: unknown) => {
      const host = hostFor(hostId)
      const source = host.getBot(botIdentifier(botId)),
        target = host.getBot(botIdentifier(targetId))
      if (target.archived) throw new BotError("CONFLICT", "请先恢复接收记忆的 Bot")
      return getBotMemoryService().share(
        source.id,
        botIdentifier(id),
        memoryVersion(version),
        target.id
      )
    }
  )
  ipcMain.handle("bots:remove", (event, hostId: unknown, id: unknown, version: unknown) => {
    const host = hostFor(hostId)
    const target = parseExistingVersion({ id, version })!
    if (!deleteThread) throw new BotError("CONFLICT", "会话清理服务尚未就绪")
    return host.remove(target.id, target.version, async (threadIds) => {
      for (const threadId of threadIds) {
        const thread = getThreadCore(threadId)
        if (!thread) continue // Retry after an earlier thread was already removed.
        const metadata = JSON.parse(thread.metadata || "{}") as Record<string, unknown>
        if (metadata?.botId !== target.id || metadata.botHostId !== LOCAL_BOT_HOST_ID)
          throw new BotError("CONFLICT", "会话归属已改变，已停止删除")
        await deleteThread(event, threadId, { requireIdle: true })
      }
      await getBotBrowserService().removeBot(target.id)
      await getBotMemoryService().removeBot(target.id)
      // Workspace deliverables are user files: retain them, as stated in the confirmation UI.
    })
  })
  ipcMain.handle("bots:update", (_event, hostId: unknown, input: unknown) =>
    hostFor(hostId).update(parseUpdateBot(input))
  )
  ipcMain.handle("bots:send", (_event, hostId: unknown, input: unknown) =>
    hostFor(hostId).send(parseSendBotMessage(input))
  )
  ipcMain.handle(
    "bots:message-reply",
    (_event, hostId: unknown, botId: unknown, messageId: unknown) =>
      hostFor(hostId).messageReply(botIdentifier(botId), botIdentifier(messageId))
  )
  ipcMain.handle("bots:cancel", (_event, hostId: unknown, taskId: unknown) =>
    hostFor(hostId).cancel(botIdentifier(taskId))
  )
  ipcMain.handle(
    "bots:schedule:save",
    (_event, hostId: unknown, botId: unknown, input: unknown, existing: unknown) =>
      hostFor(hostId).saveSchedule(
        botIdentifier(botId),
        parseSchedule(input),
        parseExistingVersion(existing)
      )
  )
  ipcMain.handle(
    "bots:schedule:remove",
    (_event, hostId: unknown, id: unknown, version: unknown) => {
      const existing = parseExistingVersion({ id, version })!
      hostFor(hostId).removeSchedule(existing.id, existing.version)
    }
  )
}
