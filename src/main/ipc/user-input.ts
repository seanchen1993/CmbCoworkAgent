import { BrowserWindow, type IpcMain } from "electron"
import type { UserInputResponse } from "../types"
import { submitUserInputResponse } from "../services/user-input"

function isUserInputResponse(value: unknown): value is UserInputResponse {
  if (!value || typeof value !== "object") return false
  const candidate = value as Partial<UserInputResponse>
  return typeof candidate.requestId === "string" && !!candidate.answers && typeof candidate.answers === "object"
}

export function registerUserInputHandlers(ipcMain: IpcMain): void {
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
