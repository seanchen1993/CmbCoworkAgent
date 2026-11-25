import type { BrowserWindow, IpcMainInvokeEvent, WebContents } from "electron"
import { isTrustedRendererUrl } from "../main-log-forwarding"

type ChatSender = Pick<IpcMainInvokeEvent, "sender" | "senderFrame">
const documentVersions = new WeakMap<WebContents, number>()
const requestVersions = new WeakMap<ChatSender, number>()

export function trackChatDocumentNavigation(contents: WebContents): void {
  const invalidate = () => { documentVersions.set(contents, (documentVersions.get(contents) ?? 0) + 1) }
  contents.on("did-start-navigation", details => {
    if (details.isMainFrame && !details.isSameDocument) invalidate()
  })
  contents.on("did-navigate", invalidate)
  contents.on("render-process-gone", invalidate)
}

export function trustedChatDocumentWindow(window: BrowserWindow | null, expectedUrl: string | undefined) {
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return null
  try {
    return isTrustedRendererUrl(window.webContents.getURL(), expectedUrl) &&
      isTrustedRendererUrl(window.webContents.mainFrame?.url, expectedUrl) ? window : null
  } catch { return null }
}

export function chatWindowForSender(
  event: ChatSender,
  getMainWindow: () => BrowserWindow | null
) {
  const window = getMainWindow()
  if (!window || window.isDestroyed() || window.webContents !== event.sender ||
      event.sender.isDestroyed() || !event.senderFrame || event.senderFrame !== event.sender.mainFrame) return null
  const version = documentVersions.get(event.sender) ?? 0
  const original = requestVersions.get(event)
  if (original !== undefined && original !== version) return null
  requestVersions.set(event, version)
  return window
}

export function assertChatAttachmentWindow(event: ChatSender, getMainWindow: () => BrowserWindow | null) {
  const window = chatWindowForSender(event, getMainWindow)
  if (!window) throw new Error("附件仅支持当前应用主窗口")
  return window
}
