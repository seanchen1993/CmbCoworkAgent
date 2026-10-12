import { beforeEach, expect, it, vi } from "vitest"
const fixture = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, input?: unknown) => Promise<unknown>>(),
  from: vi.fn(),
  status: vi.fn(),
  initialize: vi.fn()
}))
vi.mock("electron", () => ({ BrowserWindow: { fromWebContents: fixture.from } }))
vi.mock("../bots/desktop-windows-native-setup", () => ({
  getDesktopWindowsNativeSetupStatus: fixture.status,
  initializeDesktopWindowsNativeSandbox: fixture.initialize
}))
import { registerBotWindowsNativeSetupHandlers } from "./bot-windows-native-setup"
const nonce = "023ec054-fd96-4a28-b00c-aa89b9d8d67d",
  scope = "a".repeat(64),
  mainFrame = {},
  event = { sender: { mainFrame }, senderFrame: mainFrame },
  ready = { state: "setup_available", scope, message: "需要管理员初始化" }
beforeEach(() => {
  fixture.handlers.clear()
  fixture.from.mockReset().mockReturnValue({})
  fixture.status.mockReset().mockResolvedValue(ready)
  fixture.initialize.mockReset()
  registerBotWindowsNativeSetupHandlers({
    handle: (name: string, handler: unknown) =>
      fixture.handlers.set(name, handler as (event: unknown, input?: unknown) => Promise<unknown>)
  } as unknown as Parameters<typeof registerBotWindowsNativeSetupHandlers>[0])
})
const call = (method: string, input?: unknown, sender: unknown = event) =>
  fixture.handlers.get(`bots:windows-sandbox:${method}`)!(sender, input)
it.each(["status", "initialize"])(
  "refuses foreign window/frame before %s filesystem or privilege work",
  async (method) => {
    await expect(
      call(method, { nonce, scope }, { sender: event.sender, senderFrame: {} })
    ).rejects.toThrow("主界面")
    fixture.from.mockReturnValue(null)
    await expect(call(method, { nonce, scope })).rejects.toThrow("主界面")
    expect(fixture.status).not.toHaveBeenCalled()
    expect(fixture.initialize).not.toHaveBeenCalled()
  }
)
it.each([
  ["status", { directory: "chosen" }],
  ["initialize", { nonce, scope, packageDirectory: "chosen" }],
  ["initialize", { nonce, scope, verified: true }],
  ["initialize", { nonce: "invalid", scope }]
])("strict %s input cannot select runtime paths or native capability", async (method, input) => {
  expect(await call(method as string, input)).toHaveProperty("botFailure")
  expect(fixture.status).not.toHaveBeenCalled()
  expect(fixture.initialize).not.toHaveBeenCalled()
})
it("preserves one exact nonce and a definitive result through the narrow setup method", async () => {
  fixture.initialize.mockResolvedValue({
    nonce,
    success: true,
    definitive: true,
    status: { state: "initialized", scope, message: "完成" }
  })
  expect(await call("initialize", { nonce, scope })).toEqual({
    nonce,
    success: true,
    definitive: true,
    status: { state: "initialized", scope, message: "完成" }
  })
  expect(fixture.initialize).toHaveBeenCalledExactlyOnceWith({ nonce, scope })
  expect(await call("status")).toEqual(ready)
})
it("unknown and rejected outcomes remain structured; malformed privilege-success claims never reach UI", async () => {
  fixture.initialize.mockResolvedValue({
    nonce,
    success: false,
    definitive: false,
    status: { state: "requires_review", scope, message: "状态待确认" }
  })
  expect(await call("initialize", { nonce, scope })).toMatchObject({ definitive: false })
  fixture.initialize.mockResolvedValue({
    nonce,
    success: true,
    definitive: false,
    status: { state: "initialized", scope, message: "虚假完成" }
  })
  expect(await call("initialize", { nonce, scope })).toHaveProperty("botFailure")
})
