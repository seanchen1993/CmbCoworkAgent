import { BotError, type BotClient } from "../../../shared/bots/contracts"
import { botWorkBrowserScope, type BotWorkItem } from "../../../shared/bots/work"
import type { BotReactionTarget } from "../../../shared/bots/message-reactions"

/** The original beta client and ChatContainer retain their behavior, bound to one real target. */
export function botWorkClient(client: BotClient, work: BotWorkItem): BotClient {
  const owner = (botId: string, groupId?: string) => {
    if (botId !== work.botId || groupId) throw new BotError("INVALID_INPUT", "工作会话目标不一致")
  }
  const browser = (botId: string) => {
    owner(botId)
    return botWorkBrowserScope(work.id, work.botId)
  }
  const reactionTarget = (target: BotReactionTarget): BotReactionTarget => {
    if (target.kind !== "bot" || target.botId !== work.botId ||
      (target.workId !== undefined && target.workId !== work.id))
      throw new BotError("INVALID_INPUT", "工作会话目标不一致")
    return { kind: "bot", botId: work.botId, workId: work.id }
  }
  return {
    ...client,
    open: async (botId) => {
      owner(botId)
      const receipt = await client.open(botId, work.id)
      if (receipt.threadId !== work.threadId) throw new BotError("CONFLICT", "工作会话回执不一致")
      return receipt
    },
    send: async (input) => {
      owner(input.botId)
      if (input.workId && input.workId !== work.id)
        throw new BotError("INVALID_INPUT", "工作会话目标不一致")
      const receipt = await client.send({ ...input, workId: work.id })
      if (receipt.workId !== work.id || receipt.threadId !== work.threadId)
        throw new BotError("CONFLICT", "工作发送回执不一致")
      return receipt
    },
    requestReceipts: (botId, checks) => {
      owner(botId)
      return client.requestReceipts(botId, checks, work.id)
    },
    messageReply: (botId, messageId) => {
      owner(botId)
      return client.messageReply(botId, messageId, work.id)
    },
    messageReactions: (target, messageIds) =>
      client.messageReactions(reactionTarget(target), messageIds),
    setMessageReaction: (target, messageId, emoji, present) =>
      client.setMessageReaction(reactionTarget(target), messageId, emoji, present),
    stopConversation: (botId, groupId) => {
      owner(botId, groupId)
      return client.stopConversation(botId, undefined, work.id)
    },
    messageOrigins: (botId, ids, groupId) => {
      owner(botId, groupId)
      return client.messageOrigins(botId, ids, undefined, work.id)
    },
    exchange: (botId, taskId, groupId) => {
      owner(botId, groupId)
      return client.exchange(botId, taskId, undefined, work.id)
    },
    exchangeHistory: (botId, taskId, groupId, before) => {
      owner(botId, groupId)
      return client.exchangeHistory(botId, taskId, undefined, before, work.id)
    },
    listFiles: (botId, cursor, groupId) => {
      owner(botId, groupId)
      return client.listFiles(botId, cursor, undefined, work.id)
    },
    importFiles: (botId, groupId, maxFiles) => {
      owner(botId, groupId)
      return client.importFiles(botId, undefined, maxFiles, work.id)
    },
    attachFiles: (botId, maxFiles, maxChars, groupId) => {
      owner(botId, groupId)
      return client.attachFiles(botId, maxFiles, maxChars, undefined, work.id)
    },
    attachFileBytes: (botId, files, maxChars, groupId) => {
      owner(botId, groupId)
      return client.attachFileBytes(botId, files, maxChars, undefined, work.id)
    },
    exportFile: (botId, fileId, groupId) => {
      owner(botId, groupId)
      return client.exportFile(botId, fileId, undefined, work.id)
    },
    shareFile: (botId, fileId, targetId, groupId) => {
      owner(botId, groupId)
      return client.shareFile(botId, fileId, targetId, undefined, work.id)
    },
    browserPreview: (botId, pageId) => client.browserPreview(browser(botId), pageId),
    takeOverBrowser: (botId, pageId) => client.takeOverBrowser(browser(botId), pageId),
    giveBackBrowser: (botId, generation, outcome) =>
      outcome === undefined
        ? client.giveBackBrowser(browser(botId), generation)
        : client.giveBackBrowser(browser(botId), generation, outcome),
    navigateBrowser: (botId, pageId, url) => client.navigateBrowser(browser(botId), pageId, url),
    operateBrowser: (botId, action, generation) =>
      client.operateBrowser(browser(botId), action, generation)
  }
}
