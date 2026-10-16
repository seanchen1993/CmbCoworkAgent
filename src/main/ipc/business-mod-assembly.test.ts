import { afterEach, expect, it, vi } from "vitest"
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron"
const state = vi.hoisted(() => ({
  workspace: "C:/fixture",
  incarnation: "first",
  open: vi.fn(),
  save: vi.fn(),
  inspect: vi.fn(),
  preview: vi.fn(),
  create: vi.fn(),
  check: vi.fn(),
  install: vi.fn(),
  export: vi.fn()
}))
vi.mock("electron", () => ({ dialog: { showOpenDialog: state.open, showSaveDialog: state.save } }))
vi.mock("../storage", () => ({
  getOpenworkDir: () => "C:/not-written",
  getPlugins: () => [
    { id: "source", name: "Source", path: "C:/source", businessModCount: 2 },
    { id: "observer", name: "Observer", path: "C:/observer", businessExtensionCount: 1 },
    { id: "plain", name: "Ordinary plugin", path: "C:/plain" }
  ],
  invalidateEnabledSkillsCache: vi.fn(),
  invalidatePluginHooksCache: vi.fn()
}))
vi.mock("../db", () => ({
  getThreadCore: () => ({
    created_at: 1,
    metadata: JSON.stringify({
      workspacePath: state.workspace,
      cmb_thread_incarnation: state.incarnation
    })
  })
}))
vi.mock("./plugins", () => ({
  installDerivedPluginDirectory: vi.fn(),
  inspectCompletePluginDirectory: vi.fn()
}))
vi.mock("../plugins/business-mod-assembly-service", () => ({
  BusinessModAssemblyService: class {
    inspect = state.inspect
    preview = state.preview
    create = state.create
    check = state.check
    install = state.install
    export = state.export
    list() {
      return []
    }
  }
}))
import { registerBusinessModAssemblyHandlers } from "./business-mod-assembly"
afterEach(() => {
  state.workspace = "C:/fixture"
  state.incarnation = "first"
  vi.resetAllMocks()
  vi.unstubAllEnvs()
})
function fixture() {
  vi.stubEnv("ELECTRON_RENDERER_URL", "http://localhost:5173")
  const frame = { url: "http://localhost:5173/" }
  const sender = { mainFrame: frame, isDestroyed: () => false }
  const owner = { webContents: sender, isDestroyed: () => false } as unknown as BrowserWindow
  const handlers = new Map<string, (event: IpcMainInvokeEvent, input: unknown) => unknown>()
  registerBusinessModAssemblyHandlers(
    {
      handle: (name: string, handler: Parameters<IpcMain["handle"]>[1]) =>
        handlers.set(name, handler)
    } as unknown as IpcMain,
    () => owner
  )
  const event = { sender, senderFrame: frame } as unknown as IpcMainInvokeEvent
  const scope = { threadId: "thread", expectedWorkspace: "C:/fixture" }
  return {
    frame,
    scope,
    call: (method: string, input = {}) =>
      handlers.get(`plugins:business-mods:${method}`)!(event, { ...scope, ...input })
  }
}
it("rejects foreign frames and stale workspace before assembly access", () => {
  const f = fixture()
  f.frame.url = "http://foreign.invalid"
  expect(() => f.call("preview")).toThrow("来源窗口")
  f.frame.url = "http://localhost:5173/"
  state.workspace = "C:/other"
  expect(() => f.call("install")).toThrow("工作区")
  expect(state.preview).not.toHaveBeenCalled()
  expect(state.install).not.toHaveBeenCalled()
})
it("chooses installed source paths on the host and ignores renderer paths", async () => {
  const f = fixture()
  await f.call("inspect", { pluginId: "source", directory: "C:/untrusted" })
  expect(state.inspect).toHaveBeenCalledWith("C:/source", expect.any(String), expect.any(Function))
})
it("lists only installed plugins declaring composable business Mods", () => {
  const f = fixture()
  expect(f.call("sources")).toEqual([
    { pluginId: "source", name: "Source", description: undefined },
    { pluginId: "observer", name: "Observer", description: undefined }
  ])
})
it("revalidates thread incarnation after directory selection", async () => {
  const f = fixture()
  state.open.mockImplementation(async () => {
    state.incarnation = "replacement"
    return { canceled: false, filePaths: ["C:/source"] }
  })
  await expect(f.call("inspect")).rejects.toThrow("会话已变化")
  expect(state.inspect).not.toHaveBeenCalled()
})
it("does not export on cancelled or stale native save dialogs", async () => {
  const f = fixture()
  state.save.mockResolvedValueOnce({ canceled: true })
  expect(await f.call("export", { copyId: "copy", expectedDigest: "digest" })).toBeNull()
  state.save.mockImplementationOnce(async () => {
    state.workspace = "C:/other"
    return { canceled: false, filePath: "C:/chosen.zip" }
  })
  await expect(f.call("export")).rejects.toThrow("工作区")
  expect(state.export).not.toHaveBeenCalled()
})
it("passes copy identity and digest with a live guard to installation and export", async () => {
  const f = fixture()
  f.call("install", { copyId: "copy", expectedDigest: "digest", directory: "C:/ignored" })
  expect(state.install).toHaveBeenCalledWith(
    expect.any(String),
    "copy",
    "digest",
    expect.any(Function)
  )
  state.save.mockResolvedValue({ canceled: false, filePath: "C:/chosen.zip" })
  await f.call("export", { copyId: "copy", expectedDigest: "digest", outputFile: "C:/ignored.zip" })
  expect(state.export).toHaveBeenCalledWith(
    expect.any(String),
    "copy",
    "digest",
    "C:/chosen.zip",
    expect.any(Function)
  )
})
