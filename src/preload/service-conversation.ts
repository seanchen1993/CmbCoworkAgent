import { ipcRenderer } from "electron"
import type { ServiceConversationApi } from "../shared/bot/service-conversation"
/** Named calls only; the main process resolves all identity and execution scope. */
export const serviceConversationApi: ServiceConversationApi = {
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
  cancel: (input) => ipcRenderer.invoke("serviceConversation:cancel", input)
}
