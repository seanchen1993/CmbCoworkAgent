import { expect, it, vi, afterEach } from "vitest"
import type { IpcMain, IpcMainInvokeEvent, BrowserWindow } from "electron"
import { randomUUID } from "node:crypto"
const state = vi.hoisted(() => ({
  workspace: "C:/fixture",
  incarnation: "first",
  modelRef: "selected-model",
  dialog: vi.fn(),
  inspect: vi.fn(),
  revise: vi.fn(),
  upstream: vi.fn(),
  files: vi.fn(),
  opened: vi.fn(),
  snapshot: vi.fn(),
  apply: vi.fn(),
  model: vi.fn()
}))
vi.mock("electron", () => ({
  dialog: { showOpenDialog: (...args: unknown[]) => state.dialog(...args) },
  shell: { openPath: (...args: unknown[]) => state.opened(...args) }
}))
vi.mock("../storage", () => ({
  getOpenworkDir: () => "C:/never-written",
  getPlugins: () => [{ id: "p", name: "package", path: "C:/package", description: "test" }],
  invalidateEnabledSkillsCache: () => {},
  invalidatePluginHooksCache: () => {}
}))
vi.mock("../db", () => ({
  getThreadCore: (id: string) =>
    id === "thread"
      ? {
          id,
          created_at: 1,
          metadata: JSON.stringify({
            workspacePath: state.workspace,
            cmb_thread_incarnation: state.incarnation,
            model: state.modelRef
          })
        }
      : undefined
}))
vi.mock("./plugins", () => ({
  installDerivedPluginDirectory: vi.fn(),
  inspectCompletePluginDirectory: vi.fn()
}))
vi.mock("../plugins/derivation-service", () => ({
  PluginDerivationService: class {
    revise(...args: unknown[]) {
      return state.revise(...args)
    }
    inspectUpstream(...args: unknown[]) {
      return state.upstream(...args)
    }
    inspect(...args: unknown[]) {
      return state.inspect(...args)
    }
    readFile(...args: unknown[]) {
      return state.files(...args)
    }
    proposalSnapshot(...args: unknown[]) {
      return state.snapshot(...args)
    }
    applyProposal(...args: unknown[]) {
      return state.apply(...args)
    }
  }
}))
vi.mock("../plugins/derivation-model", () => ({
  generateDerivationProposal: (...args: unknown[]) => state.model(...args)
}))
import { registerPluginDerivationHandlers } from "./plugin-derivation"
afterEach(() => {
  state.workspace = "C:/fixture"
  state.incarnation = "first"
  vi.clearAllMocks()
  vi.unstubAllEnvs()
})
function fixture() {
  vi.stubEnv("ELECTRON_RENDERER_URL", "http://localhost:5173")
  const frame = { url: "http://localhost:5173/", processId: 1, routingId: 2 }
  const sender = { mainFrame: frame, isDestroyed: () => false }
  const owner = { webContents: sender, isDestroyed: () => false } as unknown as BrowserWindow
  const handlers = new Map<string, (event: IpcMainInvokeEvent, input: unknown) => unknown>()
  registerPluginDerivationHandlers(
    {
      handle: (key: string, handler: Parameters<IpcMain["handle"]>[1]) => handlers.set(key, handler)
    } as unknown as IpcMain,
    () => owner
  )
  const event = { sender, senderFrame: frame } as unknown as IpcMainInvokeEvent
  const scope = { threadId: "thread", expectedWorkspace: "C:/fixture" }
  return {
    frame,
    event,
    scope,
    call: (method: string, input: unknown = scope) =>
      handlers.get(`plugins:derivation:${method}`)!(event, input)
  }
}
it("rejects foreign frames and stale workspace before source or file reads", () => {
  const f = fixture()
  f.frame.url = "http://untrusted.invalid"
  expect(() => f.call("sources")).toThrow("来源窗口")
  f.frame.url = "http://localhost:5173/"
  state.workspace = "C:/other"
  expect(() => f.call("read-file", { ...f.scope, copyId: "id", path: "anything" })).toThrow(
    "工作区"
  )
  expect(state.files).not.toHaveBeenCalled()
})
it("scopes revision and upstream checks before accessing persisted source paths", () => {
  const f = fixture()
  f.call("revise", { ...f.scope, copyId: "copy", requestId: "request", path: "untrusted" })
  expect(state.revise).toHaveBeenCalledWith(
    expect.any(String),
    "copy",
    "request",
    expect.any(Function)
  )
  f.call("inspect-upstream", { ...f.scope, copyId: "copy", path: "untrusted" })
  expect(state.upstream).toHaveBeenCalledWith(
    expect.any(String),
    "copy",
    expect.any(Function),
    false
  )
  state.workspace = "C:/other"
  expect(() => f.call("revise", { ...f.scope, copyId: "copy" })).toThrow("工作区")
  expect(() => f.call("inspect-upstream", { ...f.scope, copyId: "copy" })).toThrow("工作区")
  expect(state.revise).toHaveBeenCalledTimes(1)
  expect(state.upstream).toHaveBeenCalledTimes(1)
})
it("rechecks window and workspace after native directory selection", async () => {
  const f = fixture()
  state.dialog.mockImplementation(async () => {
    state.workspace = "C:/other"
    return { canceled: false, filePaths: ["C:/selected"] }
  })
  await expect(f.call("inspect")).rejects.toThrow("工作区")
  expect(state.inspect).not.toHaveBeenCalled()
})
it("cancellation grants no source and installed selection uses the host catalog path", async () => {
  const f = fixture()
  state.dialog.mockResolvedValue({ canceled: true, filePaths: [] })
  expect(await f.call("inspect")).toBeNull()
  await f.call("inspect", { ...f.scope, pluginId: "p", path: "C:/untrusted" })
  expect(state.inspect.mock.calls[0][0]).toBe("C:/package")
})

function modelFixture() {
  const f = fixture()
  const digest = "a".repeat(64)
  state.snapshot.mockResolvedValue({
    digest,
    files: [
      {
        path: "skills/build/SKILL.md",
        bytes: Buffer.from("Original protocol"),
        mode: 0o600,
        digest
      }
    ]
  })
  state.model.mockResolvedValue(
    JSON.stringify({
      summary: "业务补充",
      files: [{ path: "skills/build/SKILL.md", addition: "产出审核报告，保留原验收要求。" }]
    })
  )
  const input = {
    ...f.scope,
    copyId: randomUUID(),
    expectedDigest: digest,
    instruction: "审核报告",
    requestId: randomUUID()
  }
  return { ...f, input }
}

it("binds model selection and retains host-reviewed files despite forged apply payload", async () => {
  const f = modelFixture()
  const proposal = (await f.call("propose", f.input)) as { proposalId: string }
  expect(state.model.mock.calls[0][2].modelRef).toBe("selected-model")
  state.apply.mockResolvedValue({ copyId: f.input.copyId })
  await f.call("apply-proposal", {
    ...f.scope,
    proposalId: proposal.proposalId,
    files: [{ path: "hooks/hooks.json", after: "forged" }]
  })
  expect(state.apply.mock.calls[0][1].files[0].path).toBe("skills/build/SKILL.md")
  expect(state.apply.mock.calls[0][1].files[0].after).toContain("Original protocol")
})

it("rejects reincarnated chat during generation and after preview", async () => {
  const f = modelFixture()
  const proposal = (await f.call("propose", f.input)) as { proposalId: string }
  state.incarnation = "replacement"
  await expect(
    f.call("apply-proposal", { ...f.scope, proposalId: proposal.proposalId })
  ).rejects.toThrow("失效")
  state.model.mockImplementation(async () => {
    state.incarnation = "another-replacement"
    return "{}"
  })
  await expect(f.call("propose", { ...f.input, requestId: randomUUID() })).rejects.toThrow(
    "会话已变化"
  )
  expect(state.apply).not.toHaveBeenCalled()
})
