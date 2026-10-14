import { EventEmitter } from "node:events"
import { afterEach, expect, it, vi } from "vitest"
import { dialog, type IpcMain, type IpcMainInvokeEvent } from "electron"
import type { FlowManager } from "../mods/flows/manager"
import { registerFlowFilePublicationHandlers } from "./mods-flow-files"

vi.mock("electron", () => ({ dialog: { showSaveDialog: vi.fn() } }))
afterEach(() => vi.restoreAllMocks())
function setup() {
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>()
  const sender = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false })
  const event = { sender, senderFrame: sender.mainFrame } as unknown as IpcMainInvokeEvent
  let scope = "workspace",
    incarnation = 1
  const action = vi.fn<FlowManager["filePublication"]>(
    async (_workspace, _thread, _run, _request, _digest, _signal, guard) => {
      guard?.()
      return { state: "published", operationId: "host-op", reviewDigest: "a".repeat(64) }
    }
  )
  registerFlowFilePublicationHandlers(
    {
      handle: (name: string, callback: (...args: unknown[]) => Promise<unknown>) =>
        handlers.set(name, callback)
    } as unknown as IpcMain,
    { filePublication: action } as unknown as FlowManager,
    {
      trusted: (candidate) => {
        if (candidate.senderFrame !== candidate.sender.mainFrame) throw Error("untrusted")
      },
      threadScope: () => scope,
      captureThreadFence: () => {
        const original = incarnation
        return () => {
          if (original !== incarnation) throw Error("FLOW_FILE_SCOPE_CHANGED")
        }
      }
    }
  )
  const invoke = (channel: string, ...args: unknown[]) =>
    handlers.get("mods:flow-file-" + channel)!(event, ...args)
  const input = {
    threadId: "thread",
    runId: "run",
    requestId: "request",
    kind: "publish",
    runDigest: "b".repeat(64),
    reviewDigest: "a".repeat(64)
  }
  return {
    invoke,
    input,
    action,
    sender,
    event,
    handlers,
    changeScope: () => {
      scope = "other"
    },
    replaceThread: () => {
      incarnation++
    }
  }
}

it("passes only exact captured intent and fresh scope to the host manager", async () => {
  const f = setup()
  await f.invoke("publish", f.input)
  expect(f.action).toHaveBeenCalledTimes(1)
  expect(f.action.mock.calls[0].slice(0, 5)).toEqual([
    "workspace",
    "thread",
    "run",
    { kind: "publish", reviewDigest: "a".repeat(64) },
    "b".repeat(64)
  ])
})

it("rejects proxy/accessor input without invoking caller code or opening an export dialog", async () => {
  const f = setup(),
    getter = vi.fn(() => "thread")
  const accessor = Object.defineProperty({ ...f.input }, "threadId", {
    get: getter,
    enumerable: true
  })
  await expect(f.invoke("publish", accessor)).rejects.toThrow("INPUT_INVALID")
  await expect(f.invoke("publish", new Proxy(f.input, {}))).rejects.toThrow("INPUT_INVALID")
  expect(getter).not.toHaveBeenCalled()
  expect(f.action).not.toHaveBeenCalled()
  expect(dialog.showSaveDialog).not.toHaveBeenCalled()
})

it("rejects a late export choice after scope or thread incarnation changes", async () => {
  for (const mode of ["scope", "incarnation"]) {
    const f = setup()
    vi.mocked(dialog.showSaveDialog).mockImplementationOnce(async () => {
      if (mode === "scope") f.changeScope()
      else f.replaceThread()
      return { canceled: false, filePath: "C:/chosen.json" }
    })
    await expect(f.invoke("publish", { ...f.input, kind: "export" })).rejects.toThrow(
      "SCOPE_CHANGED"
    )
    expect(f.action).not.toHaveBeenCalled()
  }
})

it("cancel waits for its actual owned operation drain even after scope is revoked", async () => {
  const f = setup()
  let release!: () => void
  const blocked = new Promise<void>((done) => {
    release = done
  })
  let entered!: () => void
  const started = new Promise<void>((done) => {
    entered = done
  })
  f.action.mockImplementationOnce(async (...args) => {
    entered()
    await blocked
    args[6]?.()
    return { state: "published", operationId: "host-op", reviewDigest: "a".repeat(64) }
  })
  const running = f.invoke("publish", f.input).catch((error) => error)
  await started
  f.changeScope()
  let drained = false
  const cancel = f.invoke("cancel", "thread", "request").then(() => {
    drained = true
  })
  await Promise.resolve()
  expect(drained).toBe(false)
  release()
  await cancel
  expect(await running).toBeInstanceOf(Error)
  expect(drained).toBe(true)
})

it("normalizes backend diagnostics so raw paths or source fragments cannot leak", async () => {
  const f = setup()
  f.action.mockRejectedValueOnce(Error("raw private diagnostic"))
  await expect(f.invoke("publish", f.input)).rejects.toThrow(/^FLOW_FILE_PUBLICATION_FAILED$/)
})
