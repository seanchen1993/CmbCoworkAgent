import { afterEach, expect, it, vi } from "vitest"
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron"
const state = vi.hoisted(() => ({ read: vi.fn(), plugins: [], account: "one" }))
vi.mock("../storage", () => ({
  getPlugins: () => state.plugins,
  getUserInfo: () => ({ sapId: state.account })
}))
vi.mock("../plugins/plugin-flow-definition", () => ({
  readInstalledPluginFlowDefinition: (...args: unknown[]) => state.read(...args)
}))
import { registerPluginFlowDefinitionHandlers } from "./plugin-flow-definition"

afterEach(() => {
  state.account = "one"
  vi.resetAllMocks()
  vi.unstubAllEnvs()
})
function fixture() {
  vi.stubEnv("ELECTRON_RENDERER_URL", "http://localhost:5173")
  const frame = { url: "http://localhost:5173/" }
  const sender = { mainFrame: frame, isDestroyed: () => false }
  const owner = { webContents: sender, isDestroyed: () => false } as unknown as BrowserWindow
  let handler: Parameters<IpcMain["handle"]>[1]
  registerPluginFlowDefinitionHandlers(
    {
      handle: (_key, value) => {
        handler = value
      }
    } as IpcMain,
    () => owner
  )
  const event = { sender, senderFrame: frame } as unknown as IpcMainInvokeEvent
  const input = { pluginId: "installed", expected: { name: "installed", version: "1" } }
  return { frame, input, call: (value: unknown = input) => handler(event, value) }
}

it("allows a trusted readonly request without any chat, workspace or project binding", async () => {
  const f = fixture()
  state.read.mockImplementation(async (input, plugins, guard) => {
    guard()
    expect(input).toEqual(f.input)
    expect(plugins()).toEqual([])
    return { status: "undeclared" }
  })
  expect(await f.call()).toEqual({ status: "undeclared" })
  expect(state.read).toHaveBeenCalledTimes(1)
})

it("rejects foreign frames and renderer supplied paths before reading installed files", async () => {
  const f = fixture()
  await expect(f.call({ ...f.input, path: "C:/forged" })).rejects.toThrow("请求无效")
  await expect(
    f.call({ ...f.input, threadId: "thread", expectedWorkspace: "C:/project" })
  ).rejects.toThrow("请求无效")
  f.frame.url = "http://untrusted.invalid/"
  await expect(f.call()).rejects.toThrow("来源无效")
  expect(state.read).not.toHaveBeenCalled()
})

it("retains the trusted window guard across the asynchronous read", async () => {
  const f = fixture()
  state.read.mockImplementation(async (_input, _plugins, guard) => {
    f.frame.url = "http://untrusted.invalid/"
    guard()
  })
  await expect(f.call()).rejects.toThrow("来源无效")
})

it("rejects a result after the current account changes", async () => {
  const f = fixture()
  state.read.mockImplementation(async (_input, _plugins, guard) => {
    state.account = "two"
    guard()
  })
  await expect(f.call()).rejects.toThrow("账号已变化")
})
