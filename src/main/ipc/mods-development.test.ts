import { describe, expect, it, vi } from "vitest"
import type { IpcMain, IpcMainInvokeEvent } from "electron"
import type { ModDevelopmentService } from "../mods/devtools/development-service"
import { registerModsDevelopmentHandlers } from "./mods-development"

function fixture() {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, input: unknown) => unknown>()
  const service = {
    status: vi.fn(),
    setEnabled: vi.fn(),
    approve: vi.fn(),
    stop: vi.fn(),
    promote: vi.fn()
  }
  const trustedEvent = {} as IpcMainInvokeEvent
  registerModsDevelopmentHandlers(
    {
      handle: (name: string, handler: typeof handlers extends Map<string, infer T> ? T : never) =>
        handlers.set(name, handler)
    } as unknown as IpcMain,
    service as unknown as ModDevelopmentService,
    (event) => {
      if (event !== trustedEvent) throw Error("UNTRUSTED")
    }
  )
  return {
    service,
    run: (name: string, input: unknown, event = trustedEvent) =>
      handlers.get(`mods:development:${name}`)!(event, input)
  }
}

describe("development IPC authority", () => {
  it("rejects untrusted callers before reading or changing any state", () => {
    const f = fixture()
    for (const name of ["status", "set-enabled", "approve", "stop", "promote"])
      expect(() => f.run(name, {}, {} as IpcMainInvokeEvent)).toThrow("UNTRUSTED")
    for (const method of Object.values(f.service)) expect(method).not.toHaveBeenCalled()
  })
  it("rejects model-supplied capabilities and malformed revisions", () => {
    const f = fixture()
    const input = {
      threadId: "thread",
      expectedWorkspace: "workspace",
      id: "demo",
      revision: 1,
      digest: "a".repeat(64)
    }
    for (const change of [
      { capabilities: ["process.exec"] },
      { revision: 0 },
      { digest: "not-a-digest" },
      { id: "../other" }
    ])
      expect(() => f.run("approve", { ...input, ...change })).toThrow("DEVELOPMENT_INPUT")
    expect(f.service.approve).not.toHaveBeenCalled()
    f.run("approve", input)
    expect(f.service.approve).toHaveBeenCalledExactlyOnceWith(
      "thread",
      "workspace",
      "demo",
      1,
      "a".repeat(64)
    )
  })
  it("binds stop and promotion to the caller's visible workspace and revision", () => {
    const f = fixture()
    f.run("stop", { threadId: "thread", expectedWorkspace: "workspace", id: "demo" })
    f.run("promote", {
      threadId: "thread",
      expectedWorkspace: "workspace",
      id: "demo",
      revision: 3
    })
    expect(f.service.stop).toHaveBeenCalledWith("thread", "workspace", "demo")
    expect(f.service.promote).toHaveBeenCalledWith("thread", "workspace", "demo", 3)
  })
})
