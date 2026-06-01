import { BrowserWindow, type IpcMain } from "electron"
import type { UserInputResponse } from "../types"
import { acknowledgeUserInputRequest, submitUserInputResponse } from "../services/user-input"

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
  ipcMain.on("userInput:ack", (event, ack: unknown) => {
    const senderWindow = BrowserWindow.getAllWindows().find(
      (win) => win.webContents.id === event.sender.id
    )
    if (!senderWindow) {
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
    if (!senderWindow) {
      console.warn("[UserInput] Rejected response from unknown sender:", event.sender.id)
      return
    }

    if (!isUserInputResponse(response)) {
      console.warn("[UserInput] Rejected malformed response")
      return
    }

    if (!submitUserInputResponse(response)) {
      console.warn("[UserInput] Received response for unknown request:", response.requestId)
    }
  })
}
