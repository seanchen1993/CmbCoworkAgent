import { beforeEach, expect, it, vi } from "vitest"
type TestEvent = { sender: { mainFrame: object }; senderFrame: object }
type Handler = (event: TestEvent, input: unknown) => Promise<unknown>
const fixtures = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  from: vi.fn(),
  client: vi.fn(),
  restart: vi.fn(),
  invoke: vi.fn()
}))
const backups = vi.hoisted(() => ({
  list: vi.fn(),
  execute: vi.fn(),
  reveal: vi.fn()
}))
const downloads = vi.hoisted(() => ({
  start: vi.fn(),
  page: vi.fn(),
  resume: vi.fn(),
  pause: vi.fn(),
  cancel: vi.fn(),
  reveal: vi.fn(),
  forget: vi.fn()
}))
// This suite owns domain forwarding. The Main-only preview service has its
// own session, lifecycle and frame-boundary tests; it is not a Host RPC method.
vi.mock("../bots/desktop-link-preview", () => ({
  registerDesktopBotLinkPreviews: vi.fn()
}))
vi.mock("../bots/desktop-artifact-download-service", () => ({
  startDesktopBotArtifactDownload: downloads.start,
  pageDesktopBotArtifactDownloads: downloads.page,
  resumeDesktopBotArtifactDownload: downloads.resume,
  pauseDesktopBotArtifactDownload: downloads.pause,
  cancelDesktopBotArtifactDownload: downloads.cancel,
  revealDesktopBotArtifactDownload: downloads.reveal,
  forgetDesktopBotArtifactDownload: downloads.forget
}))
vi.mock("../bots/desktop-backups", () => ({
  listDesktopBotBackups: backups.list,
  executeDesktopBotBackup: backups.execute,
  revealDesktopBotBackups: backups.reveal
}))
vi.mock("../bots/desktop-workspace-maintenance", () => ({
  listDesktopBotWorkspaceCheckpoints: backups.list,
  executeDesktopBotWorkspaceMaintenance: backups.execute,
  revealDesktopBotWorkspaceRecovery: backups.reveal
}))
vi.mock("../bots/desktop-browser-maintenance", () => ({
  listDesktopBotBrowserCheckpoints: backups.list,
  executeDesktopBotBrowserMaintenance: backups.execute
}))
const computer = vi.hoisted(() => ({
  list: vi.fn(),
  recovery: vi.fn(),
  progress: vi.fn(),
  execute: vi.fn(),
  deleteRecovery: vi.fn(),
  reveal: vi.fn(),
  deliverables: vi.fn(),
  listDeliverables: vi.fn()
}))
vi.mock("../bots/desktop-computer-checkpoints", () => ({
  listDesktopBotComputerCheckpoints: computer.list,
  listDesktopBotComputerRecoveryCopies: computer.recovery,
  desktopBotComputerProgress: computer.progress,
  executeDesktopBotComputerCheckpoint: computer.execute,
  deleteDesktopBotComputerRecoveryCopy: computer.deleteRecovery,
  revealDesktopBotComputerRecoveryCopy: computer.reveal,
  revealDesktopBotComputerDeliverables: computer.deliverables,
  listDesktopBotComputerDeliverables: computer.listDeliverables
}))
vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: fixtures.from },
  ipcRenderer: { invoke: fixtures.invoke },
  ipcMain: {
    handle: (name: string, fn: Handler) => fixtures.handlers.set(name, fn)
  }
}))
vi.mock("../bots/desktop-client", () => ({
  getDesktopBotClient: fixtures.client,
  restartDesktopBotHost: fixtures.restart
}))
import { registerBotHandlers } from "./bots"
beforeEach(() => {
  fixtures.handlers.clear()
  fixtures.client.mockReset()
  fixtures.restart.mockReset()
  fixtures.invoke.mockReset()
  fixtures.from.mockReset()
  Object.values(backups).forEach((mock) => mock.mockReset())
  Object.values(computer).forEach((mock) => mock.mockReset())
  Object.values(downloads).forEach((mock) => mock.mockReset())
  registerBotHandlers()
})

it.each([
  "getErrorTrays",
  "dismissErrorTray",
  "clearErrorTrays",
  "artifact-download:start",
  "artifact-download:page",
  "artifact-download:resume",
  "artifact-download:pause",
  "artifact-download:cancel",
  "artifact-download:reveal",
  "artifact-download:forget",
  "computer-checkpoint:list",
  "computer-checkpoint:recovery-copies",
  "computer-checkpoint:deliverables",
  "computer-checkpoint:progress",
  "computer-checkpoint:execute",
  "computer-checkpoint:delete-recovery",
  "computer-checkpoint:reveal-recovery",
  "computer-checkpoint:reveal-deliverables",
  "host:restart",
  "checkModel",
  "cancelModelCheck",
  "sharedMemories",
  "saveSharedMemory",
  "skillLibrary",
  "installedSkills",
  "availableSkills",
  "asyncTasks",
  "shellJob",
  "stopShellJob",
  "webhook",
  "changeWebhook",
  "restartWebhook",
  "avatar",
  "changeAvatar",
  "changeNotifications",
  "usageBudget",
  "changeUsageBudget",
  "backupSchedule",
  "changeBackupSchedule",
  "trialSkill",
  "reviewSkillTrial",
  "inspectInstalledSkill",
  "publishSkill",
  "withdrawSkill",
  "deleteSharedMemory",
  "memoryPolicy",
  "setMemoryPolicy",
  "retryMemory",
  "thread",
  "threadSummaries",
  "skillCandidates",
  "referenceCandidates",
  "message",
  "search",
  "deleteRoutine",
  "deleteSkill",
  "runRoutine",
  "computerTake",
  "computerInput",
  "react",
  "reactions",
  "create",
  "updateGroup",
  "clone",
  "importThreadContext",
  "setReadState",
  "reorderPinned",
  "routineHistory",
  "runHistory",
  "runOutput",
  "worktreeDetail",
  "worktreeMerge",
  "worktreeCleanup",
  "workflowControl",
  "effectDetail",
  "interactionDetail",
  "approvalRules",
  "autoReviewSettings",
  "changeAutoReview",
  "changeApprovalRule",
  "filePreview",
  "deleteFile",
  "backup:list",
  "backup:execute",
  "backup:reveal",
  "workspace-maintenance:list",
  "workspace-maintenance:execute",
  "workspace-maintenance:reveal-recovery",
  "browser-maintenance:list",
  "browser-maintenance:execute",
  "cancelFilePreview",
  "provideSecret",
  "secrets",
  "saveSecret",
  "deleteSecret"
])(
  "rejects embedded frames and detached web contents for %s before opening the Host",
  async (method) => {
    const call = fixtures.handlers.get(`bots:${method}`)!
    fixtures.from.mockReturnValue({})
    await expect(call({ sender: { mainFrame: {} }, senderFrame: {} }, {})).rejects.toThrow("主界面")
    const frame = {}
    fixtures.from.mockReturnValue(null)
    await expect(call({ sender: { mainFrame: frame }, senderFrame: frame }, {})).rejects.toThrow(
      "主界面"
    )
    expect(fixtures.client).not.toHaveBeenCalled()
    expect(fixtures.restart).not.toHaveBeenCalled()
    expect(backups.execute).not.toHaveBeenCalled()
    expect(backups.list).not.toHaveBeenCalled()
    expect(backups.reveal).not.toHaveBeenCalled()
    Object.values(computer).forEach((mock) => expect(mock).not.toHaveBeenCalled())
    expect(fixtures.handlers.has("bots:claim")).toBe(false)
  }
)

it("validates the restart target and preserves a busy rejection from the Host", async () => {
  const { BotDomainError } = await import("../../shared/bot-types")
  const frame = {},
    event = { sender: { mainFrame: frame }, senderFrame: frame },
    restart = fixtures.handlers.get("bots:host:restart")!
  fixtures.from.mockReturnValue({})
  for (const input of [undefined, {}, { hostId: "" }, { hostId: "current", force: true }])
    await expect(restart(event, input)).rejects.toThrow()
  expect(fixtures.restart).not.toHaveBeenCalled()
  fixtures.restart.mockRejectedValue(new BotDomainError("host_busy", "仍有任务执行或等待回复"))
  expect(await restart(event, { hostId: "current" })).toEqual({
    botFailure: {
      code: "host_busy",
      message: "仍有任务执行或等待回复",
      diagnostic: { code: "host_busy" }
    }
  })
  expect(fixtures.restart).toHaveBeenCalledWith("current")
})

it("forwards only the named domain method for a trusted main frame", async () => {
  const frame = {},
    call = vi.fn().mockResolvedValue({ cursor: 3 })
  fixtures.from.mockReturnValue({})
  fixtures.client.mockResolvedValue({ call })
  expect(
    await fixtures.handlers.get("bots:snapshot")!(
      { sender: { mainFrame: frame }, senderFrame: frame },
      undefined
    )
  ).toEqual({ cursor: 3 })
  expect(call).toHaveBeenCalledWith("snapshot", undefined)
})

it("keeps routine failures as data until the renderer facade decodes them", async () => {
  const { createCoworkBotAPI } = await import("../../preload/bot-api")
  const { createBotIpcClient } = await import("../../shared/bot-ipc-result")
  const { BotDomainError } = await import("../../shared/bot-types")
  const frame = {},
    event = { sender: { mainFrame: frame }, senderFrame: frame }
  const input = { id: "routine", nonce: "run-once", revision: 1 }
  fixtures.from.mockReturnValue({})
  const call = vi.fn().mockRejectedValue(new BotDomainError("version_conflict", "请确认新内容"))
  fixtures.client.mockResolvedValue({ call })
  fixtures.invoke.mockImplementation(async (channel: string, args: unknown) =>
    // Electron transports plain values; Error's custom fields are not retained.
    structuredClone(await fixtures.handlers.get(channel)!(event, args))
  )
  const transport = createCoworkBotAPI()
  await expect(transport.runRoutine(input)).resolves.toEqual({
    botFailure: {
      code: "version_conflict",
      message: "请确认新内容",
      diagnostic: { code: "version_conflict" }
    }
  })
  const api = createBotIpcClient<import("../../shared/bot-api").CoworkBotAPI>(() => transport)
  await expect(api.runRoutine(input)).rejects.toMatchObject({
    code: "version_conflict",
    message: "请确认新内容"
  })
  expect(call).toHaveBeenCalledWith("runRoutine", input)
  call.mockResolvedValue({ id: "accepted", status: "queued" })
  await expect(api.runRoutine(input)).resolves.toEqual({
    id: "accepted",
    status: "queued"
  })
})

it("retains validated request diagnostics across both Electron value boundaries", async () => {
  const { createCoworkBotAPI } = await import("../../preload/bot-api")
  const { createBotIpcClient } = await import("../../shared/bot-ipc-result")
  const { BotDomainError } = await import("../../shared/bot-types")
  const frame = {},
    event = { sender: { mainFrame: frame }, senderFrame: frame }
  const diagnostic = {
    code: "rate_limit",
    status: 429,
    requestId: "req-provider-47",
    correlationId: "rpc-48",
    callId: "call-49"
  }
  fixtures.from.mockReturnValue({})
  fixtures.client.mockResolvedValue({
    call: vi.fn().mockRejectedValue(new BotDomainError("rate_limit", "稍后重试", diagnostic))
  })
  fixtures.invoke.mockImplementation(async (channel: string, input: unknown) =>
    structuredClone(await fixtures.handlers.get(channel)!(event, input))
  )
  const transport = createCoworkBotAPI()
  const api = createBotIpcClient<import("../../shared/bot-api").CoworkBotAPI>(() => transport)
  await expect(api.getErrorTrays()).rejects.toMatchObject({
    code: "rate_limit",
    message: "稍后重试",
    diagnostic
  })
})

it("redacts Host connection failures and does not invent provider identifiers", async () => {
  const { unwrapBotIpcResult } = await import("../../shared/bot-ipc-result")
  const frame = {},
    event = { sender: { mainFrame: frame }, senderFrame: frame }
  fixtures.from.mockReturnValue({})
  fixtures.client.mockRejectedValue(
    new Error("socket closed; Authorization: Bearer sk-private-key")
  )
  const value = await fixtures.handlers.get("bots:getErrorTrays")!(event, undefined)
  expect(JSON.stringify(value)).not.toContain("sk-private-key")
  expect(value).toMatchObject({
    botFailure: { diagnostic: { code: "runtime_failed" } }
  })
  expect(() => unwrapBotIpcResult(value)).toThrow("socket closed")
  expect((value as { botFailure: { diagnostic: object } }).botFailure.diagnostic).toEqual({
    code: "runtime_failed"
  })
})

it("routes computer recovery only through its named owner and preserves an unknown receipt", async () => {
  const { BotDomainError } = await import("../../shared/bot-types")
  const frame = {},
    event = { sender: { mainFrame: frame }, senderFrame: frame }
  fixtures.from.mockReturnValue({})
  const input = {
    action: "restore",
    nonce: "a",
    checkpoint: { id: "b", sha256: "c" }
  }
  computer.execute.mockRejectedValue(
    new BotDomainError("computer_checkpoint_incomplete", "结果尚未确认")
  )
  expect(await fixtures.handlers.get("bots:computer-checkpoint:execute")!(event, input)).toEqual({
    botFailure: {
      code: "computer_checkpoint_incomplete",
      message: "结果尚未确认",
      diagnostic: { code: "computer_checkpoint_incomplete" }
    }
  })
  expect(computer.execute).toHaveBeenCalledExactlyOnceWith(input)
  expect(fixtures.client).not.toHaveBeenCalled()
  expect(fixtures.restart).not.toHaveBeenCalled()
})

it.each([
  "snapshot",
  "update",
  "createGroup",
  "updateGroup",
  "send",
  "workflowControl",
  "saveRoutine",
  "runRoutine",
  "importThreadContext",
  "trialSkill",
  "changeWebhook",
  "changeAvatar",
  "changeBackupSchedule",
  "changeNotifications",
  "changeUsageBudget"
])(
  "preserves definite rejection and keeps unknown operation failure distinct for %s",
  async (method) => {
    const { BotDomainError } = await import("../../shared/bot-types")
    const { unwrapBotIpcResult } = await import("../../shared/bot-ipc-result")
    const frame = {},
      event = { sender: { mainFrame: frame }, senderFrame: frame }
    fixtures.from.mockReturnValue({})
    const call = vi
      .fn()
      .mockRejectedValueOnce(new BotDomainError("skill_changed", "请确认新版本"))
      .mockRejectedValueOnce(new Error("socket closed"))
    fixtures.client.mockResolvedValue({ call })
    const rejected = await fixtures.handlers.get(`bots:${method}`)!(event, {})
    expect(rejected).toEqual({
      botFailure: {
        code: "skill_changed",
        message: "请确认新版本",
        diagnostic: { code: "skill_changed" }
      }
    })
    expect(() => unwrapBotIpcResult(rejected)).toThrow("请确认新版本")
    const unknown = await fixtures.handlers.get(`bots:${method}`)!(event, {})
    expect(unknown).toEqual({
      botFailure: {
        code: "runtime_failed",
        message: "socket closed",
        diagnostic: { code: "runtime_failed" }
      }
    })
    expect(() => unwrapBotIpcResult(unknown)).toThrow("socket closed")
  }
)

it.each(["list", "execute"] as const)(
  "keeps browser maintenance %s failures readable without treating them as success",
  async (method) => {
    const { createBotIpcClient } = await import("../../shared/bot-ipc-result")
    const frame = {},
      event = { sender: { mainFrame: frame }, senderFrame: frame }
    const input = {
      action: "reset" as const,
      nonce: "fd6b7976-c2b9-4659-96d8-75eb0a06560a"
    }
    const message = "有命令尚未确认停止，请核对任务和现场记录。"
    const owner = method === "list" ? backups.list : backups.execute
    fixtures.from.mockReturnValue({})
    owner.mockRejectedValue(new Error(message))
    fixtures.invoke.mockImplementation(async (channel: string, request: unknown) =>
      structuredClone(await fixtures.handlers.get(channel)!(event, request))
    )
    const transport: import("../../shared/bot-ipc-result").BotIpcTransport<
      import("../../shared/bot-browser-maintenance").BotBrowserMaintenanceAPI
    > = {
      list: () => fixtures.invoke("bots:browser-maintenance:list", undefined),
      execute: (request) => fixtures.invoke("bots:browser-maintenance:execute", request)
    }
    const api = createBotIpcClient<
      import("../../shared/bot-browser-maintenance").BotBrowserMaintenanceAPI
    >(() => transport)
    const invoke = () => (method === "list" ? api.list() : api.execute(input))
    await expect(invoke()).rejects.toMatchObject({
      code: "runtime_failed",
      message
    })
    if (method === "list") expect(owner).toHaveBeenCalledExactlyOnceWith()
    else expect(owner).toHaveBeenCalledExactlyOnceWith(input)
    expect(fixtures.client).not.toHaveBeenCalled()
    expect(fixtures.restart).not.toHaveBeenCalled()
    owner.mockResolvedValue(method === "list" ? [] : { action: "reset" })
    await expect(invoke()).resolves.toEqual(method === "list" ? [] : { action: "reset" })
  }
)
