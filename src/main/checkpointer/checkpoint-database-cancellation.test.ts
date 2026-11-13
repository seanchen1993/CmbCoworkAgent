import { describe, expect, it } from "vitest"
import { runCheckpointDatabaseMaintenance, runCheckpointDatabaseOperation,
  waitForCheckpointDatabaseOperations } from "./checkpoint-database-admission"

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

describe("physical checkpoint admission cancellation", () => {
  it("removes cancelled queued calls and their owner holds before another exclusive operation", async () => {
    const key = "cancel-pending-checkpoint", started = deferred(), held = deferred()
    const active = runCheckpointDatabaseMaintenance(key, async () => {
      started.resolve(); await held.promise
    })
    await started.promise
    const controllers = Array.from({ length: 128 }, () => new AbortController())
    const owners = controllers.map(() => ({}))
    let entered = 0
    const results = controllers.map((controller, index) =>
      runCheckpointDatabaseOperation(key, async () => { entered++ }, owners[index], controller.signal)
        .then(() => undefined, error => error as unknown))
    for (const controller of controllers)
      controller.abort(new DOMException("Obsolete queued read", "AbortError"))
    for (const result of await Promise.all(results)) expect(result).toMatchObject({ name: "AbortError" })
    await Promise.all(owners.map(owner => waitForCheckpointDatabaseOperations(owner)))
    expect(entered).toBe(0)
    const successor = runCheckpointDatabaseMaintenance(key, async () => { entered++ })
    held.resolve()
    await active
    await successor
    expect(entered).toBe(1)
  })

  it("does not release an admitted physical reader when its logical signal aborts", async () => {
    const key = "cancel-granted-checkpoint", controller = new AbortController()
    const started = deferred(), held = deferred(), owner = {}
    const physical = runCheckpointDatabaseOperation(key, async () => {
      started.resolve(); await held.promise
    }, owner, controller.signal)
    await started.promise
    controller.abort()
    let writerEntered = false, ownerDrained = false
    const writer = runCheckpointDatabaseMaintenance(key, async () => { writerEntered = true })
    const drain = waitForCheckpointDatabaseOperations(owner).then(() => { ownerDrained = true })
    try {
      await Promise.resolve()
      expect(writerEntered).toBe(false)
      expect(ownerDrained).toBe(false)
    } finally { held.resolve() }
    await physical
    await writer
    await drain
    expect(writerEntered).toBe(true)
    expect(ownerDrained).toBe(true)
  })

  it("does not queue an already-aborted call and leaves the same key usable", async () => {
    const controller = new AbortController(), owner = {}, failure = Error("Cancelled before enqueue")
    controller.abort(failure)
    await expect(runCheckpointDatabaseOperation("already-cancelled-checkpoint", async () => {
      throw Error("No physical work may start")
    }, owner, controller.signal)).rejects.toBe(failure)
    await waitForCheckpointDatabaseOperations(owner)
    expect(await runCheckpointDatabaseMaintenance("already-cancelled-checkpoint", async () => 42)).toBe(42)
  })
})
