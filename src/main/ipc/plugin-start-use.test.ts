import { describe, expect, it, vi } from "vitest"
import type { IpcMain, IpcMainInvokeEvent } from "electron"
import type { PluginStartUseService } from "../plugins/plugin-start-use"
import { registerPluginStartUseHandlers } from "./plugin-start-use"

function fixture() {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, input: unknown) => unknown>()
  let workspace = "c:/project"
  const ipc = {
    handle: vi.fn((name, run) => {
      handlers.set(name, run)
    })
  } as unknown as IpcMain
  const trusted = vi.fn()
  const service = {
    prepare: vi.fn(async (input, guard) => {
      guard()
      return input
    }),
    enable: vi.fn(async (input, guard) => {
      guard()
      return input
    })
  }
  registerPluginStartUseHandlers(ipc, service as unknown as PluginStartUseService, {
    trusted,
    normalizeWorkspace: (value) => value.replaceAll("\\", "/").toLowerCase(),
    context: () => ({
      workspace,
      assertCurrent: () => {
        if (workspace !== "c:/project") throw Error("PLUGIN_START_USE_SCOPE_CHANGED")
      }
    })
  })
  const input = {
    threadId: "chat",
    expectedWorkspace: "C:\\Project",
    pluginId: "plugin",
    expected: { name: "sample", version: "1.0.0", digest: "a".repeat(64) }
  }
  return {
    call: (value: unknown = input) =>
      handlers.get("plugins:prepareStartUse")!({} as IpcMainInvokeEvent, value),
    enable: (value: unknown = input) =>
      handlers.get("plugins:enableStartUse")!({} as IpcMainInvokeEvent, value),
    service,
    trusted,
    input,
    change: () => {
      workspace = "elsewhere"
    }
  }
}

describe("native start-use discovery IPC", () => {
  it("uses the separately named enable endpoint with the same trusted exact scope boundary", async () => {
    const f = fixture()
    await expect(f.enable()).resolves.toMatchObject({ expectedWorkspace: "c:/project" })
    expect(f.service.enable).toHaveBeenCalledOnce()
    expect(f.service.prepare).not.toHaveBeenCalled()
    f.trusted.mockImplementation(() => {
      throw Error("UNTRUSTED")
    })
    expect(() => f.enable()).toThrow("UNTRUSTED")
    expect(f.service.enable).toHaveBeenCalledOnce()
  })
  it("accepts the actual normalized workspace without granting execution", async () => {
    const f = fixture()
    await expect(f.call()).resolves.toEqual({ ...f.input, expectedWorkspace: "c:/project" })
    expect(f.service.prepare).toHaveBeenCalledTimes(1)
  })
  it("rejects untrusted callers before reading any plugin", () => {
    const f = fixture()
    f.trusted.mockImplementation(() => {
      throw Error("UNTRUSTED")
    })
    expect(() => f.call()).toThrow("UNTRUSTED")
    expect(f.service.prepare).not.toHaveBeenCalled()
  })
  it("rejects cross-workspace and extra command/configuration fields", () => {
    const f = fixture()
    expect(() => f.call({ ...f.input, expectedWorkspace: "c:/other" })).toThrow("SCOPE_CHANGED")
    expect(() => f.call({ ...f.input, execute: true })).toThrow("INPUT_INVALID")
    expect(() =>
      f.call({ ...f.input, expected: { ...f.input.expected, secret: "private" } })
    ).toThrow("INPUT_INVALID")
    expect(f.service.prepare).not.toHaveBeenCalled()
  })
  it("rechecks the captured native thread while asynchronous discovery is settling", async () => {
    const f = fixture()
    f.service.prepare.mockImplementation(async (_input, guard) => {
      await Promise.resolve()
      f.change()
      guard()
    })
    await expect(f.call()).rejects.toThrow("SCOPE_CHANGED")
  })
})
