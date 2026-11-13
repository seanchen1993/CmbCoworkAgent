import { expect, it } from "vitest"
import { runCheckpointDatabaseOperation as ordinary, runCheckpointDatabaseMaintenance as maintenance,
  checkpointDatabaseOperationIsCurrent, waitForCheckpointDatabaseOperations } from "./checkpoint-database-admission"

function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
const turn = () => new Promise<void>(done => setImmediate(done))

it("waits asynchronously for all earlier operations and prevents later work overtaking maintenance", async () => {
  const one = gate(), two = gate(), held = gate(), entered = gate(), order: string[] = []
  const first = ordinary("ordered", async () => { order.push("one"); await one.promise })
  const second = ordinary("ordered", async () => { order.push("two"); await two.promise })
  await turn()
  const exclusive = maintenance("ordered", async () => { order.push("maintenance"); entered.resolve(); await held.promise })
  const later = ordinary("ordered", async () => { order.push("later") })
  one.resolve(); await first; await turn()
  expect(order).toEqual(["one", "two"])
  two.resolve(); await second; await entered.promise
  expect(order).toEqual(["one", "two", "maintenance"])
  held.resolve(); await Promise.all([exclusive, later])
  expect(order.at(-1)).toBe("later")
})

it("rejects both directions of maintenance/public-operation reentry", async () => {
  await ordinary("reentry", async () => {
    await expect(maintenance("reentry", async () => {})).rejects.toThrow("MAINTENANCE_INSIDE_OPERATION")
  })
  await maintenance("reentry", async () => {
    await expect(ordinary("reentry", async () => {})).rejects.toThrow("OPERATION_DURING_MAINTENANCE")
    await expect(maintenance("reentry", async () => {})).rejects.toThrow("MAINTENANCE_INSIDE_OPERATION")
  })
})

it("keeps unawaited nested physical work held after its parent resolves", async () => {
  const child = gate(), childEntered = gate(), owner = {}, other = {}
  let pending!: Promise<void>
  await ordinary("physical", async () => {
    expect(checkpointDatabaseOperationIsCurrent(owner)).toBe(true)
    expect(checkpointDatabaseOperationIsCurrent(other)).toBe(false)
    pending = ordinary("physical", async () => { childEntered.resolve(); await child.promise }, owner)
    await childEntered.promise
  }, owner)
  let drained = false, maintained = false
  const drain = waitForCheckpointDatabaseOperations(owner).then(() => { drained = true })
  const exclusive = maintenance("physical", async () => { maintained = true })
  await turn()
  expect(drained).toBe(false); expect(maintained).toBe(false)
  child.resolve(); await Promise.all([pending, drain, exclusive])
  expect(drained).toBe(true); expect(maintained).toBe(true)
})

it("does not revive a captured expired ALS call while another maintenance owns the database", async () => {
  const trigger = gate(), held = gate(), entered = gate(), owner = {}
  let late!: Promise<void>, ran = false
  await ordinary("expired", async () => {
    late = trigger.promise.then(() => ordinary("expired", async () => { ran = true }, owner))
  }, owner)
  const exclusive = maintenance("expired", async () => { entered.resolve(); await held.promise })
  await entered.promise
  trigger.resolve(); await turn()
  expect(ran).toBe(false)
  held.resolve(); await Promise.all([exclusive, late])
  expect(ran).toBe(true)
})

it("counts a queued ordinary call as an owner lifetime before it enters the gate", async () => {
  const entered = gate(), release = gate(), workEntered = gate(), workRelease = gate(), owner = {}
  const exclusive = maintenance("queued-owner", async () => { entered.resolve(); await release.promise })
  await entered.promise
  const queued = ordinary("queued-owner", async () => { workEntered.resolve(); await workRelease.promise }, owner)
  let drained = false
  const drain = waitForCheckpointDatabaseOperations(owner).then(() => { drained = true })
  await turn()
  expect(drained).toBe(false)
  release.resolve()
  await exclusive
  await workEntered.promise
  expect(drained).toBe(false)
  workRelease.resolve()
  await Promise.all([queued, drain])
  expect(drained).toBe(true)
})
