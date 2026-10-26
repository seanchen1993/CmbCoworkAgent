import { BrowserWindow, type IpcMain } from "electron"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { getOpenworkDir, getPlugins } from "../storage"
import { getThreadCore } from "../db"
import { isHostUserInputRecoverable } from "../services/host-user-input-recovery"
import { HostUserInputStore } from "../services/host-user-input-store"
import type { UserInputResponse } from "../types"
import {
  acknowledgeUserInputRequest,
  configureHostUserInputPersistence,
  getPendingUserInputForThread,
  submitUserInputResponse,
  getHostInputContinuation
} from "../services/user-input"

let resumeHostInput:
  | ((requestId: string, threadId: string, owner: BrowserWindow) => Promise<void>)
  | undefined
const resumingRequests = new Set<string>()

export function configureHostInputResumeHandler(handler: typeof resumeHostInput): void {
  resumeHostInput = handler
}

function isUserInputResponse(value: unknown): value is UserInputResponse {
  if (!value || typeof value !== "object") return false
  const candidate = value as Partial<UserInputResponse>
  return (
    typeof candidate.requestId === "string" &&
    !!candidate.answers &&
    typeof candidate.answers === "object"
  )
}

function isUserInputAck(value: unknown): value is { requestId: string; threadId: string } {
  if (!value || typeof value !== "object") return false
  const candidate = value as { requestId?: unknown; threadId?: unknown }
  return typeof candidate.requestId === "string" && typeof candidate.threadId === "string"
}

export function registerUserInputHandlers(ipcMain: IpcMain): void {
  let durable: HostUserInputStore | undefined
  configureHostUserInputPersistence({
    store: (create) => {
      const path = join(getOpenworkDir(), "local-projects", "user-input.sqlite")
      if (!durable && (create || existsSync(path))) durable = new HostUserInputStore(path)
      return durable
    },
    isCurrent: (record) =>
      isHostUserInputRecoverable(
        record,
        join(getOpenworkDir(), "local-projects", "state.sqlite"),
        getThreadCore(record.request.threadId),
        (id) => getPlugins().some((plugin) => plugin.id === id && plugin.enabled)
      )
  })
  ipcMain.handle("userInput:getPending", (_event, threadId: unknown) => {
    if (typeof threadId !== "string" || !threadId.trim()) return null
    return getPendingUserInputForThread(threadId)
  })

  ipcMain.on("userInput:ack", (event, ack: unknown) => {
    const senderWindow = BrowserWindow.getAllWindows().find(
      (win) => win.webContents.id === event.sender.id
    )
    if (!senderWindow || event.senderFrame !== senderWindow.webContents.mainFrame) {
      console.warn("[UserInput] Rejected ack from unknown sender:", event.sender.id)
      return
    }

    if (!isUserInputAck(ack)) {
      console.warn("[UserInput] Rejected malformed ack")
      return
    }

    if (!acknowledgeUserInputRequest(ack.requestId, ack.threadId)) {
      console.warn("[UserInput] Received ack for unknown request:", ack.requestId)
    }
  })

  ipcMain.on("userInput:response", (event, response: unknown) => {
    const senderWindow = BrowserWindow.getAllWindows().find(
      (win) => win.webContents.id === event.sender.id
    )
    if (!senderWindow || event.senderFrame !== senderWindow.webContents.mainFrame) {
      console.warn("[UserInput] Rejected response from unknown sender:", event.sender.id)
      return
    }

    if (!isUserInputResponse(response)) {
      console.warn("[UserInput] Rejected malformed response")
      return
    }

    if (!submitUserInputResponse(response)) {
      console.warn("[UserInput] Received response for unknown request:", response.requestId)
      return
    }
    const record = getHostInputContinuation(response.requestId)
    if (
      record?.continuation?.priorToolsSettled &&
      record.status === "answered" &&
      !record.continuation.claimed &&
      resumeHostInput &&
      !resumingRequests.has(response.requestId)
    ) {
      resumingRequests.add(response.requestId)
      void resumeHostInput(response.requestId, record.request.threadId, senderWindow)
        .catch((error) => {
          console.warn("[UserInput] Host checkpoint remains awaiting recovery:", error)
          if (!senderWindow.isDestroyed() && !senderWindow.webContents.isDestroyed())
            senderWindow.webContents.send(`userInput:cancel:${record.request.threadId}`, {
              requestId: response.requestId,
              reason: "答案已保存；原执行暂不能安全继续，请到任务页查看阻断原因。"
            })
        })
        .finally(() => resumingRequests.delete(response.requestId))
    }
  })
}
