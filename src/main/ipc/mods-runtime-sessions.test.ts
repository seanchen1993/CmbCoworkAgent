import { EventEmitter } from "node:events"
import type { IpcMain, IpcMainInvokeEvent } from "electron"
import { expect, it, vi } from "vitest"
import { registerRuntimeSessionHandlers } from "./mods-runtime-sessions"
import type { FunctionModsManager } from "../mods/v2/manager"

function fixture() {
  const sender = new EventEmitter()
  const handlers = new Map<string, (event: IpcMainInvokeEvent, input: unknown) => unknown>()
  const state = {
    writable: true,
    workspace: "project",
    incarnation: "native-incarnation",
    title: "我的项目检视聊天",
    frame: {}
  }
  const session = {
    threadId: "one",
    workspace: "project",
    generation: 7,
    state: "resident" as const,
    canRelease: true,
    canResume: false
  }
  const manager = {
    runtimeSessions: vi.fn(() => ({
      limit: 6,
      resident: 1,
      retiring: 0,
      reserved: 0,
      stoppedTotal: 0,
      omitted: 0,
      sessions: [session]
    })),
    releaseRuntimeSession: vi.fn<FunctionModsManager["releaseRuntimeSession"]>(
      async (_workspace, _thread, _generation, _signal, guard) => {
        guard()
        return manager.runtimeSessions()
      }
    ),
    resumeRuntimeSession: vi.fn<FunctionModsManager["resumeRuntimeSession"]>(
      async (_workspace, _thread, _generation, _signal, guard) => {
        guard()
        return manager.runtimeSessions()
      }
    )
  }
  const trusted = (event: IpcMainInvokeEvent) => {
    if (event.sender !== sender) throw Error("UNTRUSTED_SENDER")
  }
  registerRuntimeSessionHandlers(
    {
      handle: (name: string, handler: (event: IpcMainInvokeEvent, input: unknown) => unknown) =>
        handlers.set(name, handler)
    } as unknown as IpcMain,
    manager as unknown as FunctionModsManager,
    trusted,
    (event, _thread, writable) => {
      trusted(event)
      if (writable && !state.writable) throw Error("READ_ONLY")
      const { workspace, incarnation, frame } = state
      return {
        workspace,
        incarnationKey: incarnation,
        title: state.title,
        assertCurrent: () => {
          trusted(event)
          if (
            (writable && !state.writable) ||
            state.workspace !== workspace ||
            state.incarnation !== incarnation ||
            state.frame !== frame
          )
            throw Error("STALE_SCOPE")
        }
      }
    }
  )
  const identity = {
    threadId: "one",
    workspace: "project",
    generation: 7,
    incarnationKey: "native-incarnation"
  }
  const call = (action: string, input?: unknown, from: unknown = sender) =>
    Promise.resolve().then(() =>
      handlers.get("mods:" + action)!({ sender: from } as IpcMainInvokeEvent, input)
    )
  return { state, manager, sender, identity, call }
}

it("diagnoses without loading and only trusted writable controls can act", async () => {
  const f = fixture()
  expect(await f.call("runtime-sessions")).toMatchObject({
    sessions: [
      { incarnationKey: "native-incarnation", canRelease: true, title: "我的项目检视聊天" }
    ]
  })
  await expect(f.call("runtime-sessions", undefined, {})).rejects.toThrow("UNTRUSTED_SENDER")
  await expect(f.call("runtime-session-release", f.identity, {})).rejects.toThrow(
    "UNTRUSTED_SENDER"
  )
  f.state.writable = false
  expect(await f.call("runtime-sessions")).toMatchObject({
    sessions: [{ canRelease: false, canResume: false }]
  })
  await expect(f.call("runtime-session-release", f.identity)).rejects.toThrow("READ_ONLY")
  expect(f.manager.releaseRuntimeSession).not.toHaveBeenCalled()
})

it("rejects wrong workspace, old incarnation and unexpected fields before mutation", async () => {
  const f = fixture()
  for (const patch of [
    { workspace: "other" },
    { incarnationKey: "old" },
    { generation: 0 },
    { generation: 1.5 },
    { threadId: "x".repeat(201) },
    { workspace: "x".repeat(4097) },
    { incarnationKey: "x".repeat(4097) },
    { threadId: "" },
    { extra: true }
  ]) {
    await expect(f.call("runtime-session-release", { ...f.identity, ...patch })).rejects.toThrow()
  }
  expect(f.manager.releaseRuntimeSession).not.toHaveBeenCalled()
})

it("keeps original scope guard over asynchronous control and aborts on sender loss", async () => {
  const f = fixture()
  f.manager.resumeRuntimeSession.mockImplementationOnce(
    async (_workspace, _thread, _generation, signal, guard) => {
      guard()
      f.sender.emit("destroyed")
      expect(signal.aborted).toBe(true)
      f.state.incarnation = "recreated-thread"
      guard()
      return f.manager.runtimeSessions()
    }
  )
  await expect(f.call("runtime-session-resume", f.identity)).rejects.toThrow("STALE_SCOPE")
  expect(f.sender.listenerCount("destroyed")).toBe(0)
})

it("rejects frame replacement while a trusted release is draining", async () => {
  const f = fixture()
  f.manager.releaseRuntimeSession.mockImplementationOnce(
    async (_workspace, _thread, _generation, _signal, guard) => {
      guard()
      f.state.frame = {}
      return f.manager.runtimeSessions()
    }
  )
  await expect(f.call("runtime-session-release", f.identity)).rejects.toThrow("STALE_SCOPE")
  expect(f.sender.listenerCount("destroyed")).toBe(0)
})
