import { beforeEach, expect, it, vi } from "vitest"
import type { IpcMain, IpcMainInvokeEvent, BrowserWindow } from "electron"
const mock = vi.hoisted(() => ({
  getStatus: vi.fn(),
  sendMessage: vi.fn(),
  createMemory: vi.fn(),
  updateMemory: vi.fn(),
  disableMemory: vi.fn(),
  dialog: vi.fn()
}))
vi.mock("electron", () => ({
  app: { getPath: () => "/unread-test-user-data" },
  BrowserWindow: class {},
  safeStorage: {},
  dialog: { showOpenDialog: mock.dialog }
}))
vi.mock("../db", () => ({
  getDb: () => {
    throw Error("DB must not be opened")
  }
}))
vi.mock("../agent/managed-transport-delivery", () => ({
  createManagedTransportAgentRunDelivery: () => {
    throw Error("must not execute")
  }
}))
vi.mock("../services/bot/requirement-executor", () => ({ PartnerRequirementExecutor: class {} }))
vi.mock("../services/bot/partner-dev-controller", () => ({
  PartnerDevController: class {
    getStatus = mock.getStatus
    sendMessage = mock.sendMessage
    createMemory = mock.createMemory
    updateMemory = mock.updateMemory
    disableMemory = mock.disableMemory
  }
}))
import { registerPartnerDevHandlers } from "./partner-dev"

let handlers: Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>>,
  event: IpcMainInvokeEvent,
  window: BrowserWindow
beforeEach(() => {
  vi.clearAllMocks()
  mock.getStatus.mockResolvedValue({ configured: false })
  mock.dialog.mockResolvedValue({ canceled: true, filePaths: [] })
  const frame = { parent: null, url: "http://localhost:5173/" },
    contents = { mainFrame: frame, getURL: () => "http://localhost:5173/" },
    fakeWindow = { isDestroyed: () => false, webContents: contents }
  window = fakeWindow as unknown as BrowserWindow
  event = { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent
  handlers = new Map()
  registerPartnerDevHandlers(
    {
      handle: (
        name: string,
        fn: (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>
      ) => handlers.set(name, fn)
    } as unknown as IpcMain,
    () => window,
    "http://localhost:5173/"
  )
})
const call = (name: string, ...args: unknown[]) =>
  handlers.get("partnerDev:" + name)!(event, ...args)
it("registration alone does not read config, connect, or execute; 20 fixed handlers only", async () => {
  expect(handlers.size).toBe(20)
  expect(mock.getStatus).not.toHaveBeenCalled()
  expect(await call("getStatus")).toEqual({ configured: false })
  expect(mock.getStatus).toHaveBeenCalledTimes(1)
})
it("memory IPC has no arbitrary identities, paths, policies or actor-supplied author fields", async () => {
  for (const extra of [
    { groupId: "other" },
    { spaceId: "B" },
    { ownerId: "expert" },
    { author: "owner" },
    { url: "https://example.com" },
    { memoryPolicy: "auto" }
  ])
    await expect(
      call("createMemory", { text: "团队约定", source: { kind: "manual" }, ...extra })
    ).rejects.toThrow("INVALID_PAYLOAD")
  await expect(call("listMemories", { groupId: "other" })).rejects.toThrow("INVALID_PAYLOAD")
  await expect(call("enableTeamMemory", { botId: "expert" })).rejects.toThrow("INVALID_PAYLOAD")
  expect(mock.createMemory).not.toHaveBeenCalled()
  mock.createMemory.mockResolvedValue({ revision: 1 })
  expect(await call("createMemory", { text: "团队约定", source: { kind: "manual" } })).toEqual({
    revision: 1
  })
})
it.each(["other-window", "subframe", "missing-frame", "remote-frame", "remote-main-window"])(
  "rejects %s before privileged controller work",
  async (kind) => {
    const original = event
    if (kind === "other-window") event = { ...original, sender: {} } as IpcMainInvokeEvent
    if (kind === "subframe")
      event = {
        ...original,
        senderFrame: { url: "http://localhost:5173/", parent: original.senderFrame }
      } as unknown as IpcMainInvokeEvent
    if (kind === "missing-frame") event = { ...original, senderFrame: null } as IpcMainInvokeEvent
    if (kind === "remote-frame") Object.assign(event.senderFrame!, { url: "https://example.com/" })
    if (kind === "remote-main-window")
      Object.assign(event.sender, { getURL: () => "https://example.com/" })
    await expect(call("getStatus")).rejects.toThrow("FORBIDDEN")
    expect(mock.getStatus).not.toHaveBeenCalled()
  }
)
it("no arbitrary URL, credentials, workspace path, identity or prompt can cross fixed IPC", async () => {
  for (const extra of [
    { url: "http://example.com" },
    { ownerToken: "secret" },
    { workspacePath: "/personal" },
    { principalId: "owner" },
    { systemPrompt: "root prompt" }
  ])
    await expect(
      call("sendMessage", { mentioned: true, text: "新任务：正常文本", ...extra })
    ).rejects.toThrow("INVALID_PAYLOAD")
  await expect(call("importConnection", "/renderer-chosen-file")).rejects.toThrow("INVALID_PAYLOAD")
  await expect(call("getStatus", {})).rejects.toThrow("INVALID_PAYLOAD")
  expect(mock.sendMessage).not.toHaveBeenCalled()
  expect(mock.dialog).not.toHaveBeenCalled()
})
it("main asks through a native dialog; cancel does not import renderer data", async () => {
  expect(await call("importConnection")).toEqual({ configured: false })
  expect(mock.dialog).toHaveBeenCalledTimes(1)
  expect(mock.dialog.mock.calls[0][0]).toBe(window)
})
it("unexpected dependency errors never expose raw exception details", async () => {
  mock.getStatus.mockRejectedValue(new Error("SECRET_SQL_STACK"))
  await expect(call("getStatus")).rejects.toThrow(/^DEPENDENCY_UNAVAILABLE$/)
})
