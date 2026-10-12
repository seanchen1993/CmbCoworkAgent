import { expect, it, vi } from "vitest"
import type { BrowserWindow, IpcMainInvokeEvent } from "electron"
const handlers = vi.hoisted(() => new Map<string, (event: unknown) => unknown>())
vi.mock("electron", () => ({
  ipcMain: {
    handle: (name: string, callback: (event: unknown) => unknown) => handlers.set(name, callback)
  }
}))
import { registerBotNavigationHandlers } from "./bot-navigation"
import { BotDeepLinkController } from "../bots/upstream/grok-deep-link-controller"
import { botMessageLink } from "../../shared/bot-deep-link"

it("releases queued navigation only to the actual workspace main frame", () => {
  const dispatch = vi.fn(),
    controller = new BotDeepLinkController({ dispatch, focusWindow: vi.fn(), log: vi.fn() })
  controller.handleCandidate(
    botMessageLink({
      conversationId: "11111111-1111-1111-1111-111111111111",
      messageId: "22222222-2222-2222-2222-222222222222"
    }),
    "test"
  )
  const contents = { mainFrame: {} }
  const window = { isDestroyed: () => false, webContents: contents } as unknown as BrowserWindow
  registerBotNavigationHandlers(controller, () => window)
  const ready = handlers.get("bots:navigationReady")!
  expect(() => ready({ sender: contents, senderFrame: {} })).toThrow("主界面")
  expect(() =>
    ready({ sender: { mainFrame: contents.mainFrame }, senderFrame: contents.mainFrame })
  ).toThrow("主界面")
  expect(dispatch).not.toHaveBeenCalled()
  ready({ sender: contents, senderFrame: contents.mainFrame } as unknown as IpcMainInvokeEvent)
  expect(dispatch).toHaveBeenCalledTimes(1)
})
