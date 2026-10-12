import { EventEmitter } from "node:events"
import { randomUUID } from "node:crypto"
import type { IpcMain, IpcMainInvokeEvent } from "electron"
import { expect, it, vi } from "vitest"
const state = vi.hoisted(() => ({ window: true, calls: 0 }))
vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: () => (state.window ? {} : null) }
}))
vi.mock("../skills/import-source", () => ({
  readSkillImportSource: (_input: unknown, signal: AbortSignal) => {
    state.calls++
    return new Promise((resolve) =>
      signal.addEventListener("abort", () => resolve({ success: false, error: "cancelled" }), {
        once: true
      })
    )
  }
}))
import { registerSkillImportHandlers } from "./skill-import"

it("accepts only an app main frame, limits concurrency and scopes cancellation to its exact request", async () => {
  const handlers = new Map<
    string,
    (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>
  >()
  registerSkillImportHandlers({
    handle: (key, handler) => handlers.set(key, handler)
  } as unknown as IpcMain)
  const contents = Object.assign(new EventEmitter(), { id: 1, mainFrame: {} })
  const event = {
    sender: contents,
    senderFrame: contents.mainFrame
  } as unknown as IpcMainInvokeEvent
  const preview = handlers.get("skills:previewImport")!
  const cancel = handlers.get("skills:cancelImport")!
  const id = randomUUID()
  await expect(
    preview({ ...event, senderFrame: {} } as IpcMainInvokeEvent, id, {})
  ).rejects.toThrow("主界面")
  state.window = false
  await expect(preview(event, id, {})).rejects.toThrow("主界面")
  state.window = true
  await expect(preview(event, "invalid", {})).rejects.toThrow()
  expect(state.calls).toBe(0)
  const pending = preview(event, id, {})
  await expect(preview(event, randomUUID(), {})).resolves.toMatchObject({ success: false })
  expect(state.calls).toBe(1)
  await cancel(event, randomUUID())
  expect(contents.listenerCount("destroyed")).toBe(1)
  await cancel(event, id)
  await expect(pending).resolves.toMatchObject({ error: "cancelled" })
  expect(contents.listenerCount("destroyed")).toBe(0)
  const again = preview(event, randomUUID(), {})
  contents.emit("destroyed")
  await expect(again).resolves.toMatchObject({ error: "cancelled" })
  expect(contents.listenerCount("did-start-navigation")).toBe(0)
})
