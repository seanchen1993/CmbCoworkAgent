import { dialog, type BrowserWindow, type IpcMain, type IpcMainInvokeEvent } from "electron"
import { isTrustedRendererUrl } from "../main-log-forwarding"

/** Select a path only; this does not grant file access or change a thread's workspace. */
export function registerDirectoryPickerHandler(
  ipc: IpcMain,
  mainWindow: () => BrowserWindow | null,
  rendererUrl: string | undefined
) {
  ipc.handle("file:selectDirectory", async (event: IpcMainInvokeEvent, options: unknown) => {
    const owner = mainWindow()
    const frame = event.senderFrame
    const assertCurrent = () => {
      if (
        !owner ||
        owner.isDestroyed() ||
        owner.webContents.isDestroyed() ||
        mainWindow() !== owner ||
        event.sender !== owner.webContents ||
        !frame ||
        frame !== owner.webContents.mainFrame ||
        !isTrustedRendererUrl(event.sender.getURL(), rendererUrl) ||
        !isTrustedRendererUrl(frame.url, rendererUrl)
      )
        throw Error("DIRECTORY_PICKER_UNTRUSTED_SENDER")
    }
    assertCurrent()
    const title =
      options && typeof options === "object" && "title" in options ? options.title : undefined
    if (title !== undefined && (typeof title !== "string" || title.length > 200)) {
      throw Error("DIRECTORY_PICKER_INVALID_INPUT")
    }
    const result = await dialog.showOpenDialog(owner!, {
      title: title || "选择目录",
      properties: ["openDirectory"]
    })
    assertCurrent()
    return result.canceled
      ? { canceled: true, filePaths: [] }
      : { canceled: false, filePaths: result.filePaths.slice(0, 1) }
  })
}
