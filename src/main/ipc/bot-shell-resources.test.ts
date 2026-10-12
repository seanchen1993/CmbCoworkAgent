import { beforeEach, expect, it, vi } from "vitest"

const fixture = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, input?: unknown) => Promise<unknown>>(),
  from: vi.fn(),
  inspect: vi.fn(),
  record: vi.fn(),
  diagnostics: vi.fn(),
  show: vi.fn(),
  open: vi.fn()
}))
vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: fixture.from },
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, input?: unknown) => Promise<unknown>) =>
      fixture.handlers.set(channel, handler)
  },
  shell: { showItemInFolder: fixture.show, openPath: fixture.open }
}))
vi.mock("../app-data-root", () => ({
  getCmbCoworkAgentDataRoot: () => "/private/application-data"
}))
vi.mock("../bots/desktop-owned-shell-maintenance", () => ({
  inspectDesktopBotShellResources: fixture.inspect,
  revealDesktopBotShellResource: fixture.record,
  revealDesktopBotShellResourceDiagnostics: fixture.diagnostics
}))

import { registerBotShellResourceHandlers } from "./bot-shell-resources"
const nonce = "023ec054-fd96-4a28-b00c-aa89b9d8d67d"
const mainFrame = {}
const event = { sender: { mainFrame }, senderFrame: mainFrame }
const ready = {
  mode: "exclusive",
  review: {
    state: "ready",
    reason: "none",
    entries: [],
    title: "命令现场已核对",
    hint: "没有未确认关闭的命令现场。"
  }
}
function call(method: string, input?: unknown, sender: unknown = event) {
  return fixture.handlers.get(`bots:shell-resources:${method}`)!(sender, input)
}
beforeEach(() => {
  fixture.handlers.clear()
  for (const mock of [
    fixture.from,
    fixture.inspect,
    fixture.record,
    fixture.diagnostics,
    fixture.show,
    fixture.open
  ])
    mock.mockReset()
  fixture.from.mockReturnValue({})
  fixture.inspect.mockResolvedValue(ready)
  fixture.record.mockResolvedValue(
    "/private/application-data/bot-host/shell-resources/operation-1/owner.json"
  )
  fixture.diagnostics.mockResolvedValue("/private/application-data/bot-host/shell-resources")
  fixture.open.mockResolvedValue("")
  registerBotShellResourceHandlers()
})

it.each(["inspect", "reveal", "reveal-diagnostics"])(
  "refuses foreign frames before %s effects",
  async (method) => {
    await expect(
      call(method, { nonce }, { sender: event.sender, senderFrame: {} })
    ).rejects.toThrow("主界面")
    fixture.from.mockReturnValue(null)
    await expect(call(method, undefined)).rejects.toThrow("主界面")
    expect(fixture.inspect).not.toHaveBeenCalled()
    expect(fixture.record).not.toHaveBeenCalled()
    expect(fixture.diagnostics).not.toHaveBeenCalled()
    expect(fixture.show).not.toHaveBeenCalled()
    expect(fixture.open).not.toHaveBeenCalled()
  }
)

it.each([
  ["inspect", { directory: "/renderer-selected" }],
  ["reveal-diagnostics", { directory: "/renderer-selected" }],
  ["reveal", { nonce: "invalid" }],
  ["reveal", { nonce, path: "/renderer-selected" }],
  ["reveal", undefined]
])("rejects malformed %s input without accessing resource state", async (method, input) => {
  expect(await call(method as string, input)).toHaveProperty("botFailure")
  expect(fixture.inspect).not.toHaveBeenCalled()
  expect(fixture.record).not.toHaveBeenCalled()
  expect(fixture.diagnostics).not.toHaveBeenCalled()
  expect(fixture.show).not.toHaveBeenCalled()
  expect(fixture.open).not.toHaveBeenCalled()
})

it("returns a strict review independently of a Host connection, using only the Main-owned data root", async () => {
  expect(await call("inspect")).toEqual(ready)
  expect(fixture.inspect).toHaveBeenCalledExactlyOnceWith("/private/application-data/bot-host")
})

it("does not label an active lifetime owner abandoned", async () => {
  const active = { ...ready, mode: "active-owner" }
  fixture.inspect.mockResolvedValue(active)
  expect(await call("inspect")).toEqual(active)
})

it("refuses malformed or oversize output rather than exposing raw evidence", async () => {
  fixture.inspect.mockResolvedValue({ ...ready, token: "must-not-reach-renderer" })
  const result = await call("inspect")
  expect(result).toHaveProperty("botFailure")
  expect(JSON.stringify(result)).not.toContain("must-not-reach-renderer")
  fixture.inspect.mockResolvedValue({
    ...ready,
    review: { ...ready.review, hint: "x".repeat(513) }
  })
  expect(await call("inspect")).toHaveProperty("botFailure")
})

it("reveals only the validated existing record selected by nonce", async () => {
  expect(await call("reveal", { nonce })).toBeUndefined()
  expect(fixture.record).toHaveBeenCalledExactlyOnceWith(
    "/private/application-data/bot-host",
    nonce
  )
  expect(fixture.show).toHaveBeenCalledExactlyOnceWith(
    "/private/application-data/bot-host/shell-resources/operation-1/owner.json"
  )
  fixture.record.mockRejectedValue(new Error("record replaced"))
  expect(await call("reveal", { nonce })).toHaveProperty("botFailure")
  expect(fixture.show).toHaveBeenCalledTimes(1)
})

it("reports a failed native folder reveal without returning untrusted native text", async () => {
  fixture.open.mockResolvedValue("sensitive internal error")
  const result = await call("reveal-diagnostics")
  expect(result).toHaveProperty("botFailure")
  expect(JSON.stringify(result)).not.toContain("sensitive internal error")
  expect(fixture.diagnostics).toHaveBeenCalledExactlyOnceWith("/private/application-data/bot-host")
})
