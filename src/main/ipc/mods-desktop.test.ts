import { EventEmitter } from "node:events"
import type { IpcMain, IpcMainInvokeEvent } from "electron"
import { expect, it, vi } from "vitest"
import { FunctionDesktopBroker } from "../mods/v2/desktop-broker"
import { registerDesktopHandlers } from "./mods-desktop"

vi.mock("electron", () => ({ BrowserWindow: { fromWebContents: () => null } }))

it("the production renderer destruction callback detaches its exact client without removing a successor", () => {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, input: unknown) => void>()
  const ipc = {
    handle: (name: string, handler: typeof handlers extends Map<string, infer T> ? T : never) =>
      handlers.set(name, handler)
  } as unknown as IpcMain
  const broker = new FunctionDesktopBroker(() => {})
  const seen: Array<[string, string]> = []
  broker.subscribe((change) => seen.push([change.event, change.binding.clientId]))
  registerDesktopHandlers(ipc, broker, () => "/workspace")
  const sender = (id: number) =>
    Object.assign(new EventEmitter(), {
      id,
      isDestroyed: () => false,
      send: vi.fn()
    })
  const first = sender(1),
    second = sender(2)
  const event = (value: typeof first) => ({ sender: value }) as unknown as IpcMainInvokeEvent
  const attach = handlers.get("mods:desktop-attach")!
  attach(event(first), { threadId: "thread", owner: "A" })
  const a = broker.bindings("thread")[0].clientId
  attach(event(first), { threadId: "thread", owner: "A" })
  expect(first.listenerCount("destroyed")).toBe(1)
  attach(event(second), { threadId: "thread", owner: "B" })
  const b = broker.bindings("thread")[0].clientId
  first.emit("destroyed")
  expect(broker.bindings("thread")[0].clientId).toBe(b)
  handlers.get("mods:desktop-detach")!(event(first), { threadId: "thread", owner: "A" })
  second.emit("destroyed")
  expect(broker.bindings("thread")).toEqual([])
  expect(seen).toEqual([
    ["session.attach", a],
    ["session.detach", a],
    ["session.attach", b],
    ["session.detach", b]
  ])
})
