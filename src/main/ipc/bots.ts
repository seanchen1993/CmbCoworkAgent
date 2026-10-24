import type { BuiltinRobotManager } from "../services/im/manager"
import { BrowserWindow, powerMonitor, type IpcMain, type IpcMainInvokeEvent } from "electron"
import { parseBotMockBinding, parseBotMockEvent } from "../bots/mock-channel-validation"
import {
  BotError,
  LOCAL_BOT_HOST_ID,
  type BotBrowserHumanAction
} from "../../shared/bots/contracts"
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
  parseBotRequestChecks,
  parseCreateBotWork,
  parseBotWorkLifecycle
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
import {
  exposeWorkConversation,
  linkExistingConversation,
  resolveWorkConversation,
  unlinkWorkConversation,
  unlinkDeletingWorkConversation
} from "../bots/conversation-link-service"
import { localWorkConversationRef } from "../bots/conversation-link-validation"
import { isBotThreadMessageId } from "../../shared/bots/message-reply"
import {
  parseBotReactionTarget,
  parseBotReactionMessageIds,
  parseBotReactionMessageId,
  parseBotReactionEmoji,
  parseBotReactionPresent
} from "../../shared/bots/message-reactions"

function localHost(id: unknown) {
  if (id !== LOCAL_BOT_HOST_ID) throw new BotError("UNSUPPORTED_HOST", "此版本仅支持本机 Bot")
  return getLocalBotHost()
}

export function registerBotHandlers(
  ipcMain: IpcMain,
  deleteThread?: ThreadDeletionService,
  im?: Pick<BuiltinRobotManager, "setBotHostResolver" | "botChannelStatus" | "requireBotChannel">
): void {
  initializeBotNotificationDispatch()
  im?.setBotHostResolver(getLocalBotHost)
  const imChannel = () => {
    if (!im) throw new BotError("CONFLICT", "IM 接入尚未初始化")
    return im.requireBotChannel()
  }
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
  const mockDesktop = (event: IpcMainInvokeEvent, hostId: unknown) => {
    if (
      !event.senderFrame ||
      event.senderFrame !== event.sender.mainFrame ||
      !BrowserWindow.fromWebContents(event.sender)
    )
      throw new BotError("CONFLICT", "模拟绑定只能从本机桌面窗口操作")
    return hostFor(hostId)
  }
  const mockCursor = (value: unknown): string | undefined => {
    if (value === undefined) return undefined
    if (typeof value !== "string" || value.length > 1024)
      throw new BotError("INVALID_INPUT", "模拟游标无效")
    return value
  }
  ipcMain.handle("bots:conversation:resolve", (event, hostId, threadId) =>
    resolveWorkConversation(mockDesktop(event, hostId), botIdentifier(threadId))
  )
  ipcMain.handle("bots:conversation:expose", async (event, hostId, botId, workId) => {
    const host = mockDesktop(event, hostId),
      bot = host.getBot(botIdentifier(botId)),
      work = host.getWork(bot.id, botIdentifier(workId))
    if (work.source) throw new BotError("CONFLICT", "模拟渠道任务不能转为本机私有对话。")
    if (!work.conversation) {
      prepareBotThread(bot, { threadId: work.threadId, origin: { kind: "user" } }, work)
      host.initializeWorkThread(bot.id, work.id)
    }
    return exposeWorkConversation(host, bot.id, work.id)
  })
  ipcMain.handle("bots:conversation:link", (event, hostId, input) => {
    const host = mockDesktop(event, hostId)
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).some(
        (key) => !["botId", "operationId", "title", "goal", "conversation"].includes(key)
      ) ||
      typeof input.title !== "string" ||
      typeof input.goal !== "string"
    )
      throw new BotError("INVALID_INPUT", "关联参数无效")
    return linkExistingConversation(host, {
      botId: botIdentifier(input.botId),
      operationId: botIdentifier(input.operationId),
      title: input.title,
      goal: input.goal,
      conversation: localWorkConversationRef(input.conversation)
    })
  })
  ipcMain.handle("bots:conversation:unlink", (event, hostId, botId, workId, version) => {
    if (!Number.isSafeInteger(version) || version < 1)
      throw new BotError("INVALID_INPUT", "任务版本无效")
    return unlinkWorkConversation(
      mockDesktop(event, hostId),
      botIdentifier(botId),
      botIdentifier(workId),
      version
    )
  })
  ipcMain.handle("bots:im:status", (event, hostId) => {
    mockDesktop(event, hostId)
    return im?.botChannelStatus() ?? { connected: false, available: false }
  })
  ipcMain.handle("bots:im:list", (event, hostId, botId, before) => {
    mockDesktop(event, hostId).getBot(botIdentifier(botId))
    if (before !== undefined && (typeof before !== "string" || !/^[1-9]\d{0,18}$/.test(before)))
      throw new BotError("INVALID_INPUT", "IM 绑定游标无效")
    return imChannel().list(botId, before)
  })
  ipcMain.handle("bots:im:history", (event, hostId, botId, id, before) => {
    mockDesktop(event, hostId).getBot(botIdentifier(botId))
    return imChannel().history(botId, botIdentifier(id), mockCursor(before))
  })
  ipcMain.handle("bots:im:create", (event, hostId, botId, kind, operationId) => {
    mockDesktop(event, hostId).getBot(botIdentifier(botId))
    if (kind !== "dm" && kind !== "group") throw new BotError("INVALID_INPUT", "IM 受众无效")
    return imChannel().create(botId, kind, botIdentifier(operationId))
  })
  ipcMain.handle("bots:im:revoke", (event, hostId, botId, id, version) => {
    mockDesktop(event, hostId).getBot(botIdentifier(botId))
    if (!Number.isSafeInteger(version) || version < 1)
      throw new BotError("INVALID_INPUT", "IM 绑定版本无效")
    return imChannel().revoke(botId, botIdentifier(id), version)
  })
  ipcMain.handle("bots:mock:bindings", (event, hostId, botId, before) =>
    mockDesktop(event, hostId).mockBindings(botIdentifier(botId), mockCursor(before))
  )
  ipcMain.handle("bots:mock:binding", (event, hostId, botId, id) =>
    mockDesktop(event, hostId).mockBinding(botIdentifier(botId), botIdentifier(id))
  )
  ipcMain.handle("bots:mock:create", (event, hostId, input) =>
    mockDesktop(event, hostId).createMockBinding(parseBotMockBinding(input))
  )
  ipcMain.handle("bots:mock:inject", (event, hostId, input) =>
    mockDesktop(event, hostId).injectMockEvent(parseBotMockEvent(input))
  )
  ipcMain.handle("bots:mock:revoke", (event, hostId, botId, id, version) => {
    const host = mockDesktop(event, hostId)
    if (!Number.isSafeInteger(version) || version < 1)
      throw new BotError("INVALID_INPUT", "模拟授权版本无效")
    return host.revokeMockBinding(botIdentifier(botId), botIdentifier(id), version)
  })
  ipcMain.handle("bots:mock:online", (event, hostId, botId, id, online) => {
    const host = mockDesktop(event, hostId)
    if (typeof online !== "boolean") throw new BotError("INVALID_INPUT", "模拟在线状态无效")
    return host.setMockOnline(botIdentifier(botId), botIdentifier(id), online)
  })
  ipcMain.handle("bots:mock:history", (event, hostId, botId, id, before) =>
    mockDesktop(event, hostId).mockHistory(
      botIdentifier(botId),
      botIdentifier(id),
      mockCursor(before)
    )
  )
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
    (_event, hostId: unknown, id: unknown, generation: unknown, outcome: unknown) => {
      const scope = hostFor(hostId).browserScope(botIdentifier(id))
      if (
        generation !== undefined &&
        (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 0)
      )
        throw new BotError("INVALID_INPUT", "浏览器控制版本无效")
      if (outcome !== undefined && outcome !== "skipped")
        throw new BotError("INVALID_INPUT", "浏览器归还方式无效")
      if (outcome === "skipped" && generation === undefined)
        throw new BotError("INVALID_INPUT", "跳过协助须提供当前浏览器控制版本")
      return outcome === undefined
        ? getBotBrowserService().giveBack(scope, generation as number | undefined)
        : getBotBrowserService().giveBack(scope, generation as number | undefined, outcome)
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
  ipcMain.handle(
    "bots:browser:operate",
    (_event, hostId: unknown, id: unknown, input: unknown, generation: unknown) => {
      const scope = hostFor(hostId).browserScope(botIdentifier(id))
      if (
        typeof generation !== "number" ||
        !Number.isSafeInteger(generation) ||
        generation < 0
      )
        throw new BotError("INVALID_INPUT", "浏览器控制版本无效")
      if (
        !input ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        Object.keys(input).some((key) => key !== "action" && key !== "pageId")
      )
        throw new BotError("INVALID_INPUT", "浏览器操作无效")
      const value = input as Record<string, unknown>
      if (
        typeof value.action !== "string" ||
        !["back", "forward", "reload", "new", "close"].includes(value.action) ||
        (value.action === "new" && value.pageId !== undefined)
      )
        throw new BotError("INVALID_INPUT", "浏览器操作无效")
      const action: BotBrowserHumanAction = {
        action: value.action as BotBrowserHumanAction["action"],
        ...(value.action === "new" ? {} : { pageId: botIdentifier(value.pageId) })
      }
      return getBotBrowserService().operateAsHuman(scope, action, generation)
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
  ipcMain.handle(
    "bots:work:list",
    (_event, hostId: unknown, botId: unknown, cursor: unknown, query: unknown) => {
      if (cursor !== undefined && (typeof cursor !== "string" || cursor.length > 1024))
        throw new BotError("INVALID_INPUT", "工作游标无效")
      if (query !== undefined && typeof query !== "string")
        throw new BotError("INVALID_INPUT", "工作搜索无效")
      return hostFor(hostId).listWorks(
        botIdentifier(botId),
        cursor as string | undefined,
        query as string | undefined
      )
    }
  )
  ipcMain.handle("bots:work:summaries", (_event, hostId: unknown, botId: unknown, ids: unknown) => {
    if (!Array.isArray(ids) || ids.length > 40 || new Set(ids).size !== ids.length)
      throw new BotError("INVALID_INPUT", "工作摘要批次无效")
    return hostFor(hostId).workSummaries(botIdentifier(botId), ids.map(botIdentifier))
  })
  ipcMain.handle(
    "bots:work:mark-all-read",
    (_event, hostId: unknown, botId: unknown, version: unknown) => {
      if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1)
        throw new BotError("INVALID_INPUT", "工作已读位置无效")
      return hostFor(hostId).markWorksRead(botIdentifier(botId), version)
    }
  )
  ipcMain.handle("bots:work:get", (_event, hostId: unknown, botId: unknown, workId: unknown) =>
    hostFor(hostId).getWork(botIdentifier(botId), botIdentifier(workId))
  )
  ipcMain.handle("bots:work:create", (_event, hostId: unknown, input: unknown) =>
    hostFor(hostId).createWork(parseCreateBotWork(input))
  )
  ipcMain.handle("bots:work:lifecycle", (_event, hostId: unknown, input: unknown) => {
    const v = parseBotWorkLifecycle(input)
    return hostFor(hostId).changeWork(v.botId, v.workId, v.expectedVersion, v.operationId, v.action)
  })
  ipcMain.handle("bots:open", (_event, hostId: unknown, id: unknown, workId: unknown) => {
    const host = hostFor(hostId),
      bot = host.getBot(botIdentifier(id)),
      work = workId == null ? undefined : host.getWork(bot.id, botIdentifier(workId))
    prepareBotThread(
      bot,
      work ? { threadId: work.threadId, origin: { kind: "user" } } : undefined,
      work
    )
    if (work) host.initializeWorkThread(bot.id, work.id)
    else host.introduce(bot.id)
    return { threadId: work?.threadId ?? bot.threadId }
  })
  ipcMain.handle("bots:snapshot", (_event, hostId: unknown) => hostFor(hostId).snapshot())
  ipcMain.handle(
    "bots:exchange",
    (_event, hostId: unknown, botId: unknown, taskId: unknown, groupId: unknown, workId: unknown) =>
      hostFor(hostId).exchange(
        botIdentifier(botId),
        botIdentifier(taskId),
        groupId == null ? undefined : botIdentifier(groupId),
        workId == null ? undefined : botIdentifier(workId)
      )
  )
  ipcMain.handle(
    "bots:exchange-history",
    (
      _event,
      hostId: unknown,
      botId: unknown,
      taskId: unknown,
      groupId: unknown,
      before: unknown,
      workId: unknown
    ) =>
      hostFor(hostId).exchangeHistory(
        botIdentifier(botId),
        botIdentifier(taskId),
        groupId == null ? undefined : botIdentifier(groupId),
        before == null ? undefined : botIdentifier(before),
        workId == null ? undefined : botIdentifier(workId)
      )
  )
  ipcMain.handle(
    "bots:message-origins",
    (_event, hostId: unknown, botId: unknown, ids: unknown, groupId: unknown, workId: unknown) => {
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
        groupId == null ? undefined : botIdentifier(groupId),
        workId == null ? undefined : botIdentifier(workId)
      )
    }
  )
  ipcMain.handle("bots:mark-unread", (_event, hostId: unknown, kind: unknown, id: unknown) => {
    if (kind !== "bot" && kind !== "group") throw new BotError("INVALID_INPUT", "会话类型无效")
    return hostFor(hostId).markUnread(kind, botIdentifier(id))
  })
  ipcMain.handle(
    "bots:request-receipts",
    (_event, hostId: unknown, botId: unknown, checks: unknown, workId: unknown) =>
      hostFor(hostId).requestReceipts(
        botIdentifier(botId),
        parseBotRequestChecks(checks),
        workId == null ? undefined : botIdentifier(workId)
      )
  )
  ipcMain.handle(
    "bots:stop-conversation",
    (_event, hostId: unknown, botId: unknown, groupId: unknown, workId: unknown) =>
      hostFor(hostId).stopConversation(
        botIdentifier(botId),
        groupId === undefined ? undefined : botIdentifier(groupId),
        workId == null ? undefined : botIdentifier(workId)
      )
  )
  ipcMain.handle(
    "bots:mark-read",
    (_event, hostId: unknown, kind: unknown, id: unknown, version: unknown) => {
      if (
        (kind !== "bot" && kind !== "group" && kind !== "work") ||
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
      for (const work of host.conversationLinks.forBot(target.id)) {
        if (work.conversation?.origin === "existing" && work.conversation.state !== "detached")
          await unlinkDeletingWorkConversation(host, target.id, work.id, work.version)
      }
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
    (_event, hostId: unknown, botId: unknown, messageId: unknown, workId: unknown) => {
      if (!isBotThreadMessageId(messageId)) throw new BotError("INVALID_INPUT", "消息标识无效")
      return hostFor(hostId).messageReply(
        botIdentifier(botId),
        messageId,
        workId == null ? undefined : botIdentifier(workId)
      )
    }
  )
  ipcMain.handle("bots:cancel", (_event, hostId: unknown, taskId: unknown) =>
    hostFor(hostId).cancel(botIdentifier(taskId))
  )
  ipcMain.handle(
    "bots:message-reactions",
    (_event, hostId: unknown, target: unknown, messageIds: unknown) =>
      hostFor(hostId).messageReactions(parseBotReactionTarget(target), parseBotReactionMessageIds(messageIds))
  )
  ipcMain.handle(
    "bots:set-message-reaction",
    (_event, hostId: unknown, target: unknown, messageId: unknown, emoji: unknown, present: unknown) =>
      hostFor(hostId).setMessageReaction(
        parseBotReactionTarget(target), parseBotReactionMessageId(messageId),
        parseBotReactionEmoji(emoji), parseBotReactionPresent(present)
      )
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
