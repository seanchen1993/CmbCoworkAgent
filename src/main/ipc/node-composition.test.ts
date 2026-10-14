import { afterEach, expect, it, vi } from "vitest"
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron"
const state = vi.hoisted(() => ({ workspace: "C:/fixture", incarnation: "one", projects: vi.fn(), context: vi.fn(), run: vi.fn(), create: vi.fn() }))
vi.mock("../db", () => ({ getThreadCore: (id: string) => id === "thread" ? { created_at: 1, metadata: JSON.stringify({ workspacePath: state.workspace, cmb_thread_incarnation: state.incarnation }) } : undefined }))
vi.mock("../harness-board/service", () => ({
  listNativeNodeProjects: (...args: unknown[]) => state.projects(...args),
  readNativeNodeContext: (...args: unknown[]) => state.context(...args),
  runNativeNodeClosure: (...args: unknown[]) => state.run(...args),
  createHarnessFeature: (...args: unknown[]) => state.create(...args),
  verifyNativeNodeIdentity: vi.fn()
}))
import { registerNodeCompositionHandlers } from "./node-composition"
afterEach(() => { state.workspace = "C:/fixture"; state.incarnation = "one"; vi.resetAllMocks(); vi.unstubAllEnvs() })
function fixture() {
  vi.stubEnv("ELECTRON_RENDERER_URL", "http://localhost:5173")
  const frame = { url: "http://localhost:5173/", processId: 1, routingId: 2 }
  const sender = { id: 5, mainFrame: frame, isDestroyed: () => false }
  const owner = { webContents: sender, isDestroyed: () => false } as unknown as BrowserWindow
  const handlers = new Map<string, (event: IpcMainInvokeEvent, input: unknown) => unknown>()
  registerNodeCompositionHandlers({ handle: (key: string, handler: Parameters<IpcMain["handle"]>[1]) => handlers.set(key, handler) } as unknown as IpcMain, () => owner)
  const event = { sender, senderFrame: frame } as unknown as IpcMainInvokeEvent
  const scope = { threadId: "thread", expectedWorkspace: "C:/fixture" }
  return { frame, event, scope, call: (method: string, input: unknown = scope) => handlers.get(`node-composition:${method}`)!(event, input) }
}
it("rejects foreign frames and workspaces without discovering projects", async () => {
  const f = fixture()
  f.frame.url = "http://untrusted.invalid/"
  await expect(f.call("projects")).rejects.toThrow("来源")
  f.frame.url = "http://localhost:5173/"
  state.workspace = "C:/other"
  await expect(f.call("projects")).rejects.toThrow("目录已变化")
  expect(state.projects).not.toHaveBeenCalled()
})
it("drops project discovery and catalog when the original thread is recreated", async () => {
  const f = fixture()
  state.projects.mockImplementation(async () => { state.incarnation = "two"; return [] })
  await expect(f.call("projects")).rejects.toThrow("会话")
  state.context.mockImplementation(async () => { state.incarnation = "three"; return { project: {}, config: {}, nodes: [] } })
  await expect(f.call("catalog", { ...f.scope, projectId: "project" })).rejects.toThrow("会话")
  expect(state.run).not.toHaveBeenCalled()
  expect(state.create).not.toHaveBeenCalled()
})
