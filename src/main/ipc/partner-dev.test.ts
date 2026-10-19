import { beforeEach, expect, it, vi } from "vitest"
import type { IpcMain, IpcMainInvokeEvent, BrowserWindow } from "electron"
const mock = vi.hoisted(() => ({
  getStatus: vi.fn(),
  connect: vi.fn(),
  sendMessage: vi.fn(),
  createExpertMemory: vi.fn(),
  updateExpertMemory: vi.fn(),
  disableExpertMemory: vi.fn(),
  revokeTeam: vi.fn(),
  packaged: false,
  options: null as Record<string, unknown> | null,
  dialog: vi.fn()
}))
vi.mock("electron", () => ({
  app: {
    getPath: () => "/unread-test-user-data",
    get isPackaged() {
      return mock.packaged
    }
  },
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
    constructor(options: Record<string, unknown>) {
      mock.options = options
    }
    getStatus = mock.getStatus
    connect = mock.connect
    sendMessage = mock.sendMessage
    createExpertMemory = mock.createExpertMemory
    updateExpertMemory = mock.updateExpertMemory
    disableExpertMemory = mock.disableExpertMemory
    revokeTeam = mock.revokeTeam
  }
}))
import { registerPartnerDevHandlers } from "./partner-dev"

let handlers: Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>>,
  event: IpcMainInvokeEvent,
  window: BrowserWindow
beforeEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  vi.stubEnv("CMB_PARTNER_LOCAL_CONNECTION_FILE", "")
  mock.packaged = false
  mock.getStatus.mockResolvedValue({ configured: false })
  mock.dialog.mockResolvedValue({ canceled: true, filePaths: [] })
  const frame = { parent: null, url: "http://localhost:5173/" },
    contents = { mainFrame: frame, getURL: () => "http://localhost:5173/", send: vi.fn() },
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
it("registration alone does not read config, connect, or execute; 17 expert and 7 fixed service conversation handlers", async () => {
  expect(handlers.size).toBe(29)
  expect(mock.getStatus).not.toHaveBeenCalled()
  expect(await call("getStatus")).toEqual({ configured: false })
  expect(mock.getStatus).toHaveBeenCalledTimes(1)
})
it("expert maintenance accepts no source promotion, path, scope or caller-selected expert", async () => {
  for (const extra of [
    { botId: "other" },
    { groupId: "g" },
    { source: { kind: "task", taskId: "private" } },
    { path: "/outside" }
  ])
    await expect(call("createExpertMemory", { text: "manual", ...extra })).rejects.toThrow(
      "INVALID_PAYLOAD"
    )
  for (const name of ["startExpert", "listExpertMemories"])
    await expect(call(name, { botId: "other" })).rejects.toThrow("INVALID_PAYLOAD")
})
it("expert memory IPC has no arbitrary identities, paths, policies or actor-supplied author fields", async () => {
  for (const extra of [
    { groupId: "other" },
    { spaceId: "B" },
    { ownerId: "expert" },
    { author: "owner" },
    { url: "https://example.com" },
    { memoryPolicy: "auto" }
  ])
    await expect(call("createExpertMemory", { text: "业务约定", ...extra })).rejects.toThrow(
      "INVALID_PAYLOAD"
    )
  await expect(call("listExpertMemories", { groupId: "other" })).rejects.toThrow("INVALID_PAYLOAD")
  expect(mock.createExpertMemory).not.toHaveBeenCalled()
  mock.createExpertMemory.mockResolvedValue({ revision: 1 })
  expect(await call("createExpertMemory", { text: "业务约定" })).toEqual({
    revision: 1
  })
})
it("does not register legacy team, group binding, adoption or raw node-enable operations", () => {
  for (const name of [
    "createTeam",
    "bindTeam",
    "authorizeTeam",
    "revokeTeam",
    "enableNode",
    "listMemories",
    "createMemory",
    "updateMemory",
    "disableMemory",
    "enableTeamMemory",
    "adoptExpertMemory"
  ])
    expect(handlers.has("partnerDev:" + name)).toBe(false)
})
it("local authorization revocation remains explicit and cannot choose another context", async () => {
  mock.revokeTeam.mockResolvedValue({ nodeEnabled: false })
  await expect(call("revokeLocalAuthorization", { groupId: "other" })).rejects.toThrow(
    "INVALID_PAYLOAD"
  )
  expect(mock.revokeTeam).not.toHaveBeenCalled()
  expect(await call("revokeLocalAuthorization")).toEqual({ nodeEnabled: false })
  expect(mock.revokeTeam).toHaveBeenCalledTimes(1)
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
it("only an unpackaged preview can supply main-owned default connection configuration", async () => {
  const register = () =>
    registerPartnerDevHandlers(
      { handle: vi.fn() } as unknown as IpcMain,
      () => window,
      "http://localhost:5173/"
    )
  expect(mock.options?.defaultDescriptor).toBeUndefined()
  vi.stubEnv("CMB_PARTNER_LOCAL_CONNECTION_FILE", "/private/local/connection.json")
  register()
  expect(mock.options?.defaultDescriptor).toBeTypeOf("function")
  expect(mock.dialog).not.toHaveBeenCalled()
  mock.packaged = true
  register()
  expect(mock.options?.defaultDescriptor).toBeUndefined()
  mock.packaged = false
  vi.stubEnv("CMB_PARTNER_LOCAL_CONNECTION_FILE", "relative/connection.json")
  register()
  await expect((mock.options?.defaultDescriptor as () => Promise<unknown>)()).rejects.toThrow(
    "STORAGE_FAILURE"
  )
})

it("service conversation rejects shape, identities, paths and oversized text before journal/model access", async () => {
  const submit = handlers.get("serviceConversation:send")!
  const value = {
    conversationId: "conversation",
    taskRef: null,
    requestId: "request",
    text: "analysis"
  }
  for (const patch of [
    { spaceId: "other" },
    { credentials: "secret" },
    { workspacePath: "/outside" },
    { runId: "run" },
    { modelRef: "custom:injected" }
  ])
    await expect(submit(event, { ...value, ...patch })).rejects.toThrow("INVALID_PAYLOAD")
  for (const patch of [
    { text: "" },
    { text: "x".repeat(16385) },
    { text: "\0" },
    { conversationId: "../outside" },
    { taskRef: 42 },
    { requestId: null }
  ])
    await expect(submit(event, { ...value, ...patch })).rejects.toThrow("INVALID_PAYLOAD")
  await expect(handlers.get("serviceConversation:open")!(event, {})).rejects.toThrow(
    "INVALID_PAYLOAD"
  )
  await expect(
    handlers.get("serviceConversation:selectModel")!(event, {
      conversationId: "c",
      modelRef: "default"
    })
  ).rejects.toThrow("INVALID_PAYLOAD")
})
it("service conversation rejects untrusted/subframe access before persistence", async () => {
  const submit = handlers.get("serviceConversation:send")!,
    value = {
      conversationId: "conversation",
      taskRef: null,
      requestId: "request",
      text: "analysis"
    }
  await expect(
    submit(
      { ...event, senderFrame: { ...event.senderFrame, parent: {} } } as IpcMainInvokeEvent,
      value
    )
  ).rejects.toThrow("FORBIDDEN")
  await expect(
    submit({ ...event, senderFrame: null } as IpcMainInvokeEvent, value)
  ).rejects.toThrow("FORBIDDEN")
})

it("context mutation invalidates before work and after failure so terminal cached UI cannot survive a failed switch", async () => {
  mock.connect.mockRejectedValue(new Error("private dependency failure"))
  await expect(call("connect")).rejects.toThrow("DEPENDENCY_UNAVAILABLE")
  expect((window.webContents.send as ReturnType<typeof vi.fn>).mock.calls).toEqual([
    ["serviceConversation:invalidated", true],
    ["serviceConversation:invalidated", false]
  ])
})

it("text delivery inputs reject authority/content injection, invalid decisions and subframes before journal", async () => {
  const base = {
    conversationId: "c",
    taskRef: "task",
    operationId: "operation",
    versionId: "v1",
    decision: "reject",
    comment: "修改意见"
  }
  for (const [operation, value] of [
    ["review", base],
    ["publish", { conversationId: "c", requestId: "request" }],
    [
      "retryRevision",
      { conversationId: "c", taskRef: "task", actionId: "action", operationId: "operation" }
    ]
  ] as const) {
    const handler = handlers.get("serviceConversation:" + operation)!
    for (const extra of [
      { actor: "owner" },
      { text: "forged result" },
      { runId: "run" },
      { credentials: "secret" },
      { digest: "sha256:forged" }
    ])
      await expect(handler(event, { ...value, ...extra })).rejects.toThrow("INVALID_PAYLOAD")
    await expect(
      handler(
        { ...event, senderFrame: { ...event.senderFrame, parent: {} } } as IpcMainInvokeEvent,
        value
      )
    ).rejects.toThrow("FORBIDDEN")
  }
  const handler = handlers.get("serviceConversation:review")!
  for (const patch of [
    { comment: "" },
    { decision: "approve", comment: "不能夹带意见" },
    { decision: "approve", comment: undefined },
    { decision: "publish" }
  ])
    await expect(handler(event, { ...base, ...patch })).rejects.toThrow("INVALID_PAYLOAD")
})
