import { describe, expect, it } from "vitest"
import { EventEmitter } from "node:events"
import type { BrowserWindow, IpcMainInvokeEvent } from "electron"
import { assertChatAttachmentWindow, chatWindowForSender, trackChatDocumentNavigation, trustedChatDocumentWindow } from "./chat-attachment-window"

describe("ordinary attachment window ownership", () => {
  it.each(["file:///app/renderer/index.html", "http://localhost:5173/"])(
    "allows the configured app document and revokes the same window on navigation from %s", expected => {
      const frame = { url: expected + "#chat" }
      let url = frame.url
      const sender = Object.assign(new EventEmitter(), { mainFrame: frame, getURL: () => url, isDestroyed: () => false })
      const window = { webContents: sender, isDestroyed: () => false } as unknown as BrowserWindow
      trackChatDocumentNavigation(window.webContents)
      const event = { sender, senderFrame: frame } as unknown as IpcMainInvokeEvent
      const getWindow = () => trustedChatDocumentWindow(window, expected)
      expect(chatWindowForSender(event, getWindow)).toBe(window)
      const revalidate = () => assertChatAttachmentWindow(event, getWindow)
      expect(revalidate()).toBe(window)
      sender.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true })
      expect(revalidate()).toBe(window)
      sender.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false })
      frame.url = "about:blank"
      expect(chatWindowForSender(event, getWindow)).toBeNull()
      expect(revalidate).toThrow()
      url = "about:blank"
      frame.url = expected
      expect(revalidate).toThrow()
      url = expected + "?v=2"
      expect(revalidate).toThrow()
      expect(chatWindowForSender({ ...event }, getWindow)).toBe(window)
      expect(trustedChatDocumentWindow(window, undefined)).toBeNull()
    }
  )
  it("requires the application main frame on every check", () => {
    const frame = {}
    const sender = { mainFrame: frame, isDestroyed: () => false }
    const window = { webContents: sender, isDestroyed: () => false } as unknown as BrowserWindow
    const event = { sender, senderFrame: frame } as unknown as IpcMainInvokeEvent
    expect(assertChatAttachmentWindow(event, () => window)).toBe(window)
    expect(() => assertChatAttachmentWindow(event, () => null)).toThrow()
    expect(() => assertChatAttachmentWindow({ ...event, senderFrame: {} } as IpcMainInvokeEvent, () => window)).toThrow()
    expect(() => assertChatAttachmentWindow({ ...event, sender: { ...sender } } as IpcMainInvokeEvent, () => window)).toThrow()
  })
})
