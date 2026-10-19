import { ipcRenderer } from "electron"
import type { ServiceConversationApi } from "../shared/bot/service-conversation"
/** Named calls only; the main process resolves all identity and execution scope. */
export const serviceConversationApi: ServiceConversationApi = {
  openChats: () => ipcRenderer.invoke("serviceConversation:openChats"),
  chatTasks: (input) => ipcRenderer.invoke("serviceConversation:chatTasks", input),
  chat: (input) => ipcRenderer.invoke("serviceConversation:chat", input),
  taskLifecycle: (input) => ipcRenderer.invoke("serviceConversation:taskLifecycle", input),
  retryChat: (input) => ipcRenderer.invoke("serviceConversation:retryChat", input),
  subscribeInvalidation(listener) {
    const handler = (_event: unknown, busy: unknown) => {
      if (typeof busy === "boolean") listener(busy)
    }
    ipcRenderer.on("serviceConversation:invalidated", handler)
    return () => ipcRenderer.removeListener("serviceConversation:invalidated", handler)
  },
  open: () => ipcRenderer.invoke("serviceConversation:open"),
  selectModel: (input) => ipcRenderer.invoke("serviceConversation:selectModel", input),
  tasks: (input) => ipcRenderer.invoke("serviceConversation:tasks", input),
  read: (input) => ipcRenderer.invoke("serviceConversation:read", input),
  updates: (input) => ipcRenderer.invoke("serviceConversation:updates", input),
  send: (input) => ipcRenderer.invoke("serviceConversation:send", input),
  delivery: (input) => ipcRenderer.invoke("serviceConversation:delivery", input),
  deliveryVersion: (input) => ipcRenderer.invoke("serviceConversation:deliveryVersion", input),
  publish: (input) => ipcRenderer.invoke("serviceConversation:publish", input),
  review: (input) => ipcRenderer.invoke("serviceConversation:review", input),
  retryRevision: (input) => ipcRenderer.invoke("serviceConversation:retryRevision", input),
  cancel: (input) => ipcRenderer.invoke("serviceConversation:cancel", input)
}
