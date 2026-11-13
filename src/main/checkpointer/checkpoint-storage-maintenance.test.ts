import { EventEmitter } from "node:events"
import type { Worker } from "node:worker_threads"
import { expect, it } from "vitest"
import { waitForCheckpointStorageWorker } from "./checkpoint-storage-maintenance"
const turn = () => new Promise<void>(done => setImmediate(done))

it("keeps physical ownership after ACK until actual worker exit", async () => {
  const events = new EventEmitter(), worker = events as unknown as Worker
  let settled = false
  const done = waitForCheckpointStorageWorker(worker).then(() => { settled = true })
  events.emit("message", { ok: true })
  await turn()
  expect(settled).toBe(false)
  events.emit("exit", 0)
  await done
  expect(settled).toBe(true)
})

it("keeps an error pending until actual worker exit and preserves its first failure", async () => {
  const events = new EventEmitter(), failure = Error("actual worker failure")
  let settled = false
  const done = waitForCheckpointStorageWorker(events as unknown as Worker).then(() => undefined,
    error => { settled = true; return error })
  events.emit("error", failure)
  await turn()
  expect(settled).toBe(false)
  events.emit("exit", 1)
  expect(await done).toBe(failure)
})

it("refuses an exit without a successful original acknowledgement", async () => {
  const events = new EventEmitter()
  const done = waitForCheckpointStorageWorker(events as unknown as Worker)
  events.emit("exit", 0)
  await expect(done).rejects.toThrow("MAINTENANCE_INCOMPLETE")
})
