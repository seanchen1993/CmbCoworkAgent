import { expect, it, vi } from "vitest"
import type { IpcMain, IpcMainInvokeEvent } from "electron"
import type { EditorNavigationBroker } from "../mods/v2/platform-editor-navigation"
import { registerEditorNavigationHandlers } from "./mods-editor-navigation"

function fixture() {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, input: unknown) => unknown>()
  const broker = {
    accept: vi.fn(),
    acknowledge: vi.fn(),
    close: vi.fn(),
    launchExternal: vi.fn()
  }
  const ipc = {
    handle: (name: string, callback: (event: IpcMainInvokeEvent, input: unknown) => unknown) => {
      handlers.set(name, callback)
    }
  } as Pick<IpcMain, "handle">
  registerEditorNavigationHandlers(ipc, broker as unknown as EditorNavigationBroker, (event) => {
    if (event.sender.id !== 7) throw Error("UNTRUSTED_RENDERER")
  })
  const call = (method: string, input: unknown, sender = 7) =>
    handlers.get(`mods:editor-navigation-${method}`)!(
      { sender: { id: sender } } as IpcMainInvokeEvent,
      input
    )
  return { broker, call }
}
const intentId = "06b3f7dc-28da-4870-a0c5-96707873e4a9"

it("takes sender authority only from the trusted IPC event", () => {
  const f = fixture()
  f.call("accept", { id: intentId })
  f.call("close", { id: intentId })
  f.call("launch-external", { id: intentId })
  expect(f.broker.accept).toHaveBeenCalledWith(7, intentId)
  expect(f.broker.close).toHaveBeenCalledWith(7, intentId)
  expect(f.broker.launchExternal).toHaveBeenCalledWith(7, intentId)
  expect(() => f.call("accept", { id: intentId }, 8)).toThrow("UNTRUSTED_RENDERER")
  expect(() => f.call("accept", { id: intentId, senderId: 7 })).toThrow(
    "EDITOR_NAVIGATION_ARGUMENTS"
  )
  expect(f.broker.accept).toHaveBeenCalledTimes(1)
})

it("validates the native receipt without accepting guest scope or preview policy", () => {
  const f = fixture()
  const valid = {
    id: intentId,
    fingerprint: "a".repeat(64),
    status: "preview-loaded",
    line: 2,
    column: 3
  }
  f.call("ack", valid)
  expect(f.broker.acknowledge).toHaveBeenCalledWith(7, valid)
  for (const input of [
    { ...valid, source: "forged" },
    { ...valid, policy: "workspace-scripted" },
    { ...valid, line: 0 },
    { ...valid, fingerprint: "wrong" },
    { ...valid, status: "opened-in-ide" },
    { ...valid, column: 100001 }
  ])
    expect(() => f.call("ack", input)).toThrow("EDITOR_NAVIGATION_ARGUMENTS")
  expect(f.broker.acknowledge).toHaveBeenCalledTimes(1)
})
