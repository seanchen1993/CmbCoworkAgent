import { EventEmitter } from "node:events"
import type { IpcMain, IpcMainInvokeEvent } from "electron"
import { expect, it, vi } from "vitest"
import { registerPlatformHandlers } from "./mods-platform"

function fixture() {
  const sender = new EventEmitter(),
    frame = {}
  const state = { workspace: "native-workspace", incarnation: "a", writable: true, frame }
  const surface = { revision: 3, entries: [], errors: [] }
  const behaviors = { revision: 3, bindings: [], active: [], errors: [] }
  const controller = {
    platformSurfaceList: vi.fn(() => surface),
    platformSurfaceRead: vi.fn(),
    platformSurfaceOpen: vi.fn(
      async (
        _workspace: string,
        _thread: string,
        _address: unknown,
        _intent: string,
        _signal: AbortSignal,
        guard: () => void
      ) => {
        guard()
        return {}
      }
    ),
    platformSurfaceAct: vi.fn(async () => undefined),
    platformSurfaceClose: vi.fn(),
    platformSurfaceEnable: vi.fn(),
    platformSurfaceDisable: vi.fn(),
    platformBehaviorList: vi.fn(() => behaviors),
    platformBehaviorPreview: vi.fn(),
    platformBehaviorApply: vi.fn(),
    platformBehaviorDisable: vi.fn()
  }
  const handlers = new Map<string, (event: IpcMainInvokeEvent, input: unknown) => unknown>()
  const userAction = vi.fn<(workspace: string, threadId: string) => void>()
  const view = vi.fn<(workspace: string, threadId: string) => void>()
  registerPlatformHandlers(
    { handle: (name, handler) => handlers.set(name, handler) } as unknown as IpcMain,
    controller as unknown as Parameters<typeof registerPlatformHandlers>[1],
    {
      capture: (event, threadId, writable) => {
        if (event.sender !== sender || event.senderFrame !== state.frame) throw Error("UNTRUSTED")
        if (threadId !== "thread") throw Error("FOREIGN_TARGET")
        const { workspace, incarnation, frame: capturedFrame } = state
        const assertCurrent = () => {
          if (
            event.sender !== sender ||
            event.senderFrame !== state.frame ||
            state.frame !== capturedFrame ||
            state.incarnation !== incarnation ||
            state.workspace !== workspace ||
            (writable && !state.writable)
          )
            throw Error("STALE_SCOPE")
        }
        assertCurrent()
        return { workspace, assertCurrent }
      },
      view: (workspace, threadId, work) => {
        view(workspace, threadId)
        return work()
      },
      userAction: (workspace, threadId, signal, guard, work) => {
        userAction(workspace, threadId)
        guard()
        return work(signal)
      }
    }
  )
  const call = (name: string, input: unknown = { threadId: "thread" }, patch = {}) =>
    Promise.resolve().then(() =>
      handlers.get(`mods:platform-${name}`)!(
        { sender, senderFrame: frame, ...patch } as IpcMainInvokeEvent,
        input
      )
    )
  return { controller, userAction, view, sender, state, call }
}
const target = { threadId: "thread", address: { key: "native-key", revision: 3 } }

it("does not publish a delayed read or control receipt into a changed native target", async () => {
  const f = fixture()
  f.controller.platformSurfaceRead.mockImplementationOnce(async () => {
    await Promise.resolve()
    f.state.incarnation = "replacement"
    return { revision: 3 }
  })
  await expect(f.call("surface-read", target)).rejects.toThrow("STALE_SCOPE")
  expect(f.userAction).not.toHaveBeenCalled()
  f.controller.platformSurfaceClose.mockImplementationOnce(async () => {
    f.state.workspace = "other"
  })
  await expect(f.call("surface-close", target)).rejects.toThrow("STALE_SCOPE")
  expect(f.controller.platformSurfaceClose).toHaveBeenCalledOnce()
})

it("keeps discovery read-only and binds actions to native workspace and trusted writable target", async () => {
  const f = fixture()
  expect(await f.call("surface-list")).toEqual({ revision: 3, entries: [], errors: [] })
  expect(await f.call("behavior-list")).toMatchObject({ revision: 3 })
  expect(f.userAction).not.toHaveBeenCalled()
  await f.call("surface-open", { ...target, intentId: "intent" })
  expect(f.controller.platformSurfaceOpen.mock.calls[0].slice(0, 4)).toEqual([
    "native-workspace",
    "thread",
    target.address,
    "intent"
  ])
  expect(f.view).toHaveBeenCalledOnce()
  expect(f.userAction).not.toHaveBeenCalled()
  await f.call("surface-act", { ...target, action: { kind: "press" } })
  expect(f.userAction).toHaveBeenCalledOnce()
  f.state.writable = false
  await expect(f.call("surface-disable", target)).rejects.toThrow("STALE_SCOPE")
  await expect(f.call("surface-list", { threadId: "foreign" })).rejects.toThrow("FOREIGN_TARGET")
  await expect(f.call("surface-list", undefined, { sender: {} })).rejects.toThrow("UNTRUSTED")
})

it("rejects path injection, unbounded addresses and stale selection before native mutation", async () => {
  const f = fixture()
  for (const input of [
    { ...target, workspace: "untrusted" },
    { ...target, address: { key: "native-key", revision: -1 } },
    { ...target, address: { key: "x".repeat(2049), revision: 3 } },
    { ...target, address: { ...target.address, source: "forged" } },
    { ...target, address: { ...target.address, openId: "x".repeat(101) } },
    { ...target, threadId: "x".repeat(201) }
  ])
    await expect(f.call("surface-disable", input)).rejects.toThrow("MODS_PLATFORM_ARGUMENTS")
  await expect(
    f.call("behavior-preview", { threadId: "thread", selected: Array(33).fill("key") })
  ).rejects.toThrow("MODS_PLATFORM_ARGUMENTS")
  await expect(
    f.call("behavior-preview", { threadId: "thread", selected: ["key", "key"] })
  ).rejects.toThrow("MODS_PLATFORM_ARGUMENTS")
  expect(f.controller.platformSurfaceDisable).not.toHaveBeenCalled()
  expect(f.controller.platformBehaviorPreview).not.toHaveBeenCalled()
})

it.each(["incarnation", "workspace", "frame", "sender-loss"])(
  "refuses asynchronous surface results after %s changes and removes native listeners",
  async (change) => {
    const f = fixture()
    f.controller.platformSurfaceOpen.mockImplementationOnce(
      async (_w, _t, _a, _i, signal, guard) => {
        guard()
        if (change === "incarnation") f.state.incarnation = "b"
        if (change === "workspace") f.state.workspace = "other"
        if (change === "frame") f.state.frame = {}
        if (change === "sender-loss") {
          f.sender.emit("destroyed")
          expect(signal.aborted).toBe(true)
        }
        guard()
        return {}
      }
    )
    await expect(f.call("surface-open", { ...target, intentId: "intent" })).rejects.toThrow()
    expect(f.sender.listenerCount("destroyed")).toBe(0)
  }
)
