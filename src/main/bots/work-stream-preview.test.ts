import { EventEmitter } from "node:events"
import type { IpcRenderer } from "electron"
import { expect, it } from "vitest"
import { createBotWorkStreamPreview } from "../../preload/bot-work-stream-preview"

it("replays only the current unseen Bot reply, respecting provider occurrences and settlements", () => {
  const bus = new EventEmitter()
  const take = createBotWorkStreamPreview(bus as IpcRenderer)
  const start = (id: string, botWork = true) => bus.emit("scheduler:thread-activity", {}, { threadId: id, type: "started", botWork })
  const send = (id: string, payload: object) => bus.emit("scheduler:stream:" + id, {}, payload)
  start("ordinary", false)
  expect(bus.listenerCount("scheduler:stream:ordinary")).toBe(0)
  start("work")
  for (const [content, provider_occurrence] of [["first", 1], ["new", 2], [" reply", 2]] as const)
    send("work", { type: "message-delta", id: "reused", content, provider_occurrence })
  send("work", { type: "message-delta", subagentId: "child", id: "other", content: "unrelated" })
  expect(take("work")).toMatchObject({ id: "reused", content: "new reply", contentMode: "snapshot" })
  expect(take("work")).toBeUndefined()
  for (const state of ["done", "error"]) {
    start("work")
    send("work", { type: "message-delta", id: "partial", content: "draft" })
    bus.emit("scheduler:thread-activity", {}, { threadId: "work", type: state })
    expect(take("work")).toBeUndefined()
    expect(bus.listenerCount("scheduler:stream:work")).toBe(0)
  }
})
