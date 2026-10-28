import { ipcRenderer, type IpcRendererEvent } from "electron"
import { LOCAL_BOT_HOST_ID, type BotChangeEvent, type BotClient } from "../shared/bots/contracts"

/** Narrow named operations only; no generic IPC invocation is exposed to renderer code. */
export const localBotsApi: BotClient = {
  hostId: LOCAL_BOT_HOST_ID,
  conversations: {
    resolve: (threadId) =>
      ipcRenderer.invoke("bots:conversation:resolve", LOCAL_BOT_HOST_ID, threadId),
    link: (input) => ipcRenderer.invoke("bots:conversation:link", LOCAL_BOT_HOST_ID, input),
    expose: (botId, workId) =>
      ipcRenderer.invoke("bots:conversation:expose", LOCAL_BOT_HOST_ID, botId, workId),
    unlink: (botId, workId, version) =>
      ipcRenderer.invoke("bots:conversation:unlink", LOCAL_BOT_HOST_ID, botId, workId, version)
  },
  im: {
    conversationWorks: (botId, id, cursor, query) =>
      ipcRenderer.invoke("bots:im:conversation-works", LOCAL_BOT_HOST_ID, botId, id, cursor, query),
    conversationHistory: (botId, id, before) =>
      ipcRenderer.invoke("bots:im:conversation-history", LOCAL_BOT_HOST_ID, botId, id, before),
    history: (botId, id, before) =>
      ipcRenderer.invoke("bots:im:history", LOCAL_BOT_HOST_ID, botId, id, before),
    status: () => ipcRenderer.invoke("bots:im:status", LOCAL_BOT_HOST_ID),
    list: (botId, before) => ipcRenderer.invoke("bots:im:list", LOCAL_BOT_HOST_ID, botId, before),
    create: (botId, kind, operationId) =>
      ipcRenderer.invoke("bots:im:create", LOCAL_BOT_HOST_ID, botId, kind, operationId),
    remove: (botId, bindingId) =>
      ipcRenderer.invoke("bots:im:remove", LOCAL_BOT_HOST_ID, botId, bindingId),
    revoke: (botId, bindingId, version) =>
      ipcRenderer.invoke("bots:im:revoke", LOCAL_BOT_HOST_ID, botId, bindingId, version)
  },
  works: {
    associations: (botId) => ipcRenderer.invoke("bots:work:associations", LOCAL_BOT_HOST_ID, botId),
    resolveSource: (botId, source) =>
      ipcRenderer.invoke("bots:work:source", LOCAL_BOT_HOST_ID, botId, source),
    markAllRead: (botId, version) =>
      ipcRenderer.invoke("bots:work:mark-all-read", LOCAL_BOT_HOST_ID, botId, version),
    summaries: (botId, workIds) =>
      ipcRenderer.invoke("bots:work:summaries", LOCAL_BOT_HOST_ID, botId, workIds),
    list: (botId, cursor, query) =>
      ipcRenderer.invoke("bots:work:list", LOCAL_BOT_HOST_ID, botId, cursor, query),
    get: (botId, workId) => ipcRenderer.invoke("bots:work:get", LOCAL_BOT_HOST_ID, botId, workId),
    create: (input) => ipcRenderer.invoke("bots:work:create", LOCAL_BOT_HOST_ID, input),
    lifecycle: (input) => ipcRenderer.invoke("bots:work:lifecycle", LOCAL_BOT_HOST_ID, input)
  },
  filePreview: {
    readFilePreview: (request) => ipcRenderer.invoke("workspace:filePreviewRead", request),
    openMediaPreview: (request) => ipcRenderer.invoke("workspace:filePreviewOpenMedia", request),
    cancelFilePreview: (request) => ipcRenderer.invoke("workspace:filePreviewCancel", request),
    releaseFilePreview: (request) => ipcRenderer.invoke("workspace:filePreviewRelease", request)
  },
  listFiles: (botId, cursor, groupId, workId) =>
    ipcRenderer.invoke("bots:files:list", LOCAL_BOT_HOST_ID, botId, cursor, groupId, workId),
  listGroupFiles: (groupId, cursor) =>
    ipcRenderer.invoke("bots:files:list-group", LOCAL_BOT_HOST_ID, groupId, cursor),
  cancelFileList: (cursor) => ipcRenderer.invoke("bots:files:cancel", LOCAL_BOT_HOST_ID, cursor),
  importFiles: (botId, groupId, maxFiles, workId) =>
    ipcRenderer.invoke("bots:files:import", LOCAL_BOT_HOST_ID, botId, groupId, maxFiles, workId),
  attachFiles: (botId, maxFiles, maxChars, groupId, workId) =>
    ipcRenderer.invoke(
      "bots:files:attach",
      LOCAL_BOT_HOST_ID,
      botId,
      maxFiles,
      maxChars,
      groupId,
      workId
    ),
  attachFileBytes: (botId, files, maxChars, groupId, workId) =>
    ipcRenderer.invoke(
      "bots:files:attach-bytes",
      LOCAL_BOT_HOST_ID,
      botId,
      files,
      maxChars,
      groupId,
      workId
    ),
  exportFile: (botId, fileId, groupId, workId) =>
    ipcRenderer.invoke("bots:files:export", LOCAL_BOT_HOST_ID, botId, fileId, groupId, workId),
  exportGroupFile: (groupId, fileId) =>
    ipcRenderer.invoke("bots:files:export-group", LOCAL_BOT_HOST_ID, groupId, fileId),
  groupFileWorkspace: (groupId) =>
    ipcRenderer.invoke("bots:files:group-workspace", LOCAL_BOT_HOST_ID, groupId),
  shareFile: (botId, fileId, targetBotId, groupId, workId) =>
    ipcRenderer.invoke(
      "bots:files:share",
      LOCAL_BOT_HOST_ID,
      botId,
      fileId,
      targetBotId,
      groupId,
      workId
    ),
  browserPreview: (botId, pageId) =>
    ipcRenderer.invoke("bots:browser:preview", LOCAL_BOT_HOST_ID, botId, pageId),
  takeOverBrowser: (botId, pageId) =>
    ipcRenderer.invoke("bots:browser:takeover", LOCAL_BOT_HOST_ID, botId, pageId),
  giveBackBrowser: (botId, expectedGeneration, outcome) =>
    outcome === undefined
      ? ipcRenderer.invoke("bots:browser:give-back", LOCAL_BOT_HOST_ID, botId, expectedGeneration)
      : ipcRenderer.invoke(
          "bots:browser:give-back",
          LOCAL_BOT_HOST_ID,
          botId,
          expectedGeneration,
          outcome
        ),
  navigateBrowser: (botId, pageId, url) =>
    ipcRenderer.invoke("bots:browser:navigate", LOCAL_BOT_HOST_ID, botId, pageId, url),
  operateBrowser: (botId, action, expectedGeneration) =>
    ipcRenderer.invoke(
      "bots:browser:operate",
      LOCAL_BOT_HOST_ID,
      botId,
      action,
      expectedGeneration
    ),
  saveGroup: (input, existing) =>
    ipcRenderer.invoke("bots:group:save", LOCAL_BOT_HOST_ID, input, existing),
  removeGroup: (id, version) =>
    ipcRenderer.invoke("bots:group:remove", LOCAL_BOT_HOST_ID, id, version),
  groupMessages: (id, cursor) =>
    ipcRenderer.invoke("bots:group:messages", LOCAL_BOT_HOST_ID, id, cursor),
  sendGroup: (input) => ipcRenderer.invoke("bots:group:send", LOCAL_BOT_HOST_ID, input),
  open: (id, workId) => ipcRenderer.invoke("bots:open", LOCAL_BOT_HOST_ID, id, workId),
  listMemory: (id, groupId) =>
    ipcRenderer.invoke("bots:memory:list", LOCAL_BOT_HOST_ID, id, groupId),
  writeMemory: (id, input) => ipcRenderer.invoke("bots:memory:write", LOCAL_BOT_HOST_ID, id, input),
  removeMemory: (botId, id, version) =>
    ipcRenderer.invoke("bots:memory:remove", LOCAL_BOT_HOST_ID, botId, id, version),
  shareMemory: (botId, id, version, targetBotId) =>
    ipcRenderer.invoke("bots:memory:share", LOCAL_BOT_HOST_ID, botId, id, version, targetBotId),
  saveSchedule: (botId, input, existing) =>
    ipcRenderer.invoke("bots:schedule:save", LOCAL_BOT_HOST_ID, botId, input, existing),
  removeSchedule: (id, version) =>
    ipcRenderer.invoke("bots:schedule:remove", LOCAL_BOT_HOST_ID, id, version),
  snapshot: () => ipcRenderer.invoke("bots:snapshot", LOCAL_BOT_HOST_ID),
  exchange: (botId, taskId, groupId, workId) =>
    ipcRenderer.invoke("bots:exchange", LOCAL_BOT_HOST_ID, botId, taskId, groupId, workId),
  messageOrigins: (botId, ids, groupId, workId) =>
    ipcRenderer.invoke("bots:message-origins", LOCAL_BOT_HOST_ID, botId, ids, groupId, workId),
  messageReply: (botId, messageId, workId) =>
    ipcRenderer.invoke("bots:message-reply", LOCAL_BOT_HOST_ID, botId, messageId, workId),
  messageReactions: (target, messageIds) =>
    ipcRenderer.invoke("bots:message-reactions", LOCAL_BOT_HOST_ID, target, messageIds),
  setMessageReaction: (target, messageId, emoji, present) =>
    ipcRenderer.invoke(
      "bots:set-message-reaction",
      LOCAL_BOT_HOST_ID,
      target,
      messageId,
      emoji,
      present
    ),
  requestReceipts: (botId, checks, workId) =>
    ipcRenderer.invoke("bots:request-receipts", LOCAL_BOT_HOST_ID, botId, checks, workId),
  exchangeHistory: (botId, taskId, groupId, before, workId) =>
    ipcRenderer.invoke(
      "bots:exchange-history",
      LOCAL_BOT_HOST_ID,
      botId,
      taskId,
      groupId,
      before,
      workId
    ),
  markUnread: (kind, id) => ipcRenderer.invoke("bots:mark-unread", LOCAL_BOT_HOST_ID, kind, id),
  markRead: (kind, id, version) =>
    ipcRenderer.invoke("bots:mark-read", LOCAL_BOT_HOST_ID, kind, id, version),
  create: (input) => ipcRenderer.invoke("bots:create", LOCAL_BOT_HOST_ID, input),
  update: (input) => ipcRenderer.invoke("bots:update", LOCAL_BOT_HOST_ID, input),
  remove: (id, version) => ipcRenderer.invoke("bots:remove", LOCAL_BOT_HOST_ID, id, version),
  send: (input) => ipcRenderer.invoke("bots:send", LOCAL_BOT_HOST_ID, input),
  stopConversation: (botId, groupId, workId) =>
    ipcRenderer.invoke("bots:stop-conversation", LOCAL_BOT_HOST_ID, botId, groupId, workId),
  cancel: (taskId) => ipcRenderer.invoke("bots:cancel", LOCAL_BOT_HOST_ID, taskId),
  subscribe(listener) {
    const receive = (_event: IpcRendererEvent, payload: BotChangeEvent) => listener(payload)
    ipcRenderer.on("bots:changed", receive)
    return () => ipcRenderer.removeListener("bots:changed", receive)
  }
}
