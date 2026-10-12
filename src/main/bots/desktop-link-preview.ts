import { BrowserWindow, ipcMain, session } from "electron"
import { join } from "node:path"
import { BotLinkPreviewImageReader } from "./link-preview-image"
import {
  createMainBotLinkPreviewService,
  registerBotLinkPreviewIpc
} from "./link-preview-main-adapter"
import type { BotLinkPreviewService } from "./link-preview-service"

let service: BotLinkPreviewService | undefined
let dispose: (() => Promise<void>) | undefined
let closing: Promise<void> | undefined
let stopped = false

/** Registered after app.ready; the anonymous preview capability belongs to Electron Main only. */
export function registerDesktopBotLinkPreviews(): void {
  if (stopped || service) return
  const image = new BotLinkPreviewImageReader({
    entry: join(__dirname, "bot-document.js")
  })
  const candidate = createMainBotLinkPreviewService(session.defaultSession, (bytes, mime, signal) =>
    image.render(bytes, mime, signal)
  )
  try {
    const unregister = registerBotLinkPreviewIpc(ipcMain, candidate, (event) => {
      if (
        !BrowserWindow.fromWebContents(event.sender) ||
        event.senderFrame !== event.sender.mainFrame
      )
        throw new Error("Bot 请求必须来自应用主界面")
    })
    service = candidate
    dispose = unregister
  } catch (error) {
    void candidate.close()
    throw error
  }
}
export function hasDesktopBotLinkPreviews(): boolean {
  const metrics = service?.metrics()
  return !!metrics && (metrics.active > 0 || metrics.work > 0 || metrics.requests > 0)
}
/** Joins cancellable transport/image work. Electron's bounded native PAC calls cannot be aborted. */
export function closeDesktopBotLinkPreviews(): Promise<void> {
  if (closing) return closing
  stopped = true
  closing = (dispose?.() ?? Promise.resolve()).finally(() => {
    service = undefined
    dispose = undefined
  })
  return closing
}
