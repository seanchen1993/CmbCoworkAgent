import { describe, expect, it } from "vitest"
import type { BrowserWindow, IpcMainInvokeEvent } from "electron"
import { assertChatAttachmentWindow } from "./chat-attachment-window"

describe("ordinary attachment window ownership", () => {
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
