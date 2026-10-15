import { ipcRenderer, type IpcRendererEvent } from "electron"
import { LOCAL_BOT_HOST_ID, type BotChangeEvent, type BotClient } from "../shared/bots/contracts"

/** Narrow named operations only; no generic IPC invocation is exposed to renderer code. */
export const localBotsApi: BotClient = {
  hostId: LOCAL_BOT_HOST_ID,
  filePreview: {
    readFilePreview: (request) => ipcRenderer.invoke("workspace:filePreviewRead", request),
    openMediaPreview: (request) => ipcRenderer.invoke("workspace:filePreviewOpenMedia", request),
    cancelFilePreview: (request) => ipcRenderer.invoke("workspace:filePreviewCancel", request),
    releaseFilePreview: (request) => ipcRenderer.invoke("workspace:filePreviewRelease", request)
  },
  listFiles: (botId, cursor, groupId) =>
    ipcRenderer.invoke("bots:files:list", LOCAL_BOT_HOST_ID, botId, cursor, groupId),
  cancelFileList: (cursor) => ipcRenderer.invoke("bots:files:cancel", LOCAL_BOT_HOST_ID, cursor),
  importFiles: (botId, groupId, maxFiles) =>
    ipcRenderer.invoke("bots:files:import", LOCAL_BOT_HOST_ID, botId, groupId, maxFiles),
  attachFiles: (botId, maxFiles, maxChars, groupId) =>
    ipcRenderer.invoke("bots:files:attach", LOCAL_BOT_HOST_ID, botId, maxFiles, maxChars, groupId),
  attachFileBytes: (botId, files, maxChars, groupId) =>
    ipcRenderer.invoke(
      "bots:files:attach-bytes",
      LOCAL_BOT_HOST_ID,
      botId,
      files,
      maxChars,
      groupId
    ),
  exportFile: (botId, fileId, groupId) =>
    ipcRenderer.invoke("bots:files:export", LOCAL_BOT_HOST_ID, botId, fileId, groupId),
  shareFile: (botId, fileId, targetBotId, groupId) =>
    ipcRenderer.invoke("bots:files:share", LOCAL_BOT_HOST_ID, botId, fileId, targetBotId, groupId),
  browserPreview: (botId, pageId) =>
    ipcRenderer.invoke("bots:browser:preview", LOCAL_BOT_HOST_ID, botId, pageId),
  takeOverBrowser: (botId, pageId) =>
    ipcRenderer.invoke("bots:browser:takeover", LOCAL_BOT_HOST_ID, botId, pageId),
  giveBackBrowser: (botId, expectedGeneration) =>
    ipcRenderer.invoke("bots:browser:give-back", LOCAL_BOT_HOST_ID, botId, expectedGeneration),
  navigateBrowser: (botId, pageId, url) =>
    ipcRenderer.invoke("bots:browser:navigate", LOCAL_BOT_HOST_ID, botId, pageId, url),
  saveGroup: (input, existing) =>
    ipcRenderer.invoke("bots:group:save", LOCAL_BOT_HOST_ID, input, existing),
  removeGroup: (id, version) =>
    ipcRenderer.invoke("bots:group:remove", LOCAL_BOT_HOST_ID, id, version),
  groupMessages: (id, before) =>
    ipcRenderer.invoke("bots:group:messages", LOCAL_BOT_HOST_ID, id, before),
  sendGroup: (input) => ipcRenderer.invoke("bots:group:send", LOCAL_BOT_HOST_ID, input),
  open: (id) => ipcRenderer.invoke("bots:open", LOCAL_BOT_HOST_ID, id),
  listMemory: (id) => ipcRenderer.invoke("bots:memory:list", LOCAL_BOT_HOST_ID, id),
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
  exchange: (botId, taskId, groupId) =>
    ipcRenderer.invoke("bots:exchange", LOCAL_BOT_HOST_ID, botId, taskId, groupId),
  messageOrigins: (botId, ids, groupId) =>
    ipcRenderer.invoke("bots:message-origins", LOCAL_BOT_HOST_ID, botId, ids, groupId),
  requestReceipts: (botId, checks) =>
    ipcRenderer.invoke("bots:request-receipts", LOCAL_BOT_HOST_ID, botId, checks),
  exchangeHistory: (botId, taskId, groupId, before) =>
    ipcRenderer.invoke("bots:exchange-history", LOCAL_BOT_HOST_ID, botId, taskId, groupId, before),
  markUnread: (kind, id) => ipcRenderer.invoke("bots:mark-unread", LOCAL_BOT_HOST_ID, kind, id),
  markRead: (kind, id, version) =>
    ipcRenderer.invoke("bots:mark-read", LOCAL_BOT_HOST_ID, kind, id, version),
  create: (input) => ipcRenderer.invoke("bots:create", LOCAL_BOT_HOST_ID, input),
  update: (input) => ipcRenderer.invoke("bots:update", LOCAL_BOT_HOST_ID, input),
  remove: (id, version) => ipcRenderer.invoke("bots:remove", LOCAL_BOT_HOST_ID, id, version),
  send: (input) => ipcRenderer.invoke("bots:send", LOCAL_BOT_HOST_ID, input),
  stopConversation: (botId, groupId) =>
    ipcRenderer.invoke("bots:stop-conversation", LOCAL_BOT_HOST_ID, botId, groupId),
  cancel: (taskId) => ipcRenderer.invoke("bots:cancel", LOCAL_BOT_HOST_ID, taskId),
  subscribe(listener) {
    const receive = (_event: IpcRendererEvent, payload: BotChangeEvent) => listener(payload)
    ipcRenderer.on("bots:changed", receive)
    return () => ipcRenderer.removeListener("bots:changed", receive)
  }
}
