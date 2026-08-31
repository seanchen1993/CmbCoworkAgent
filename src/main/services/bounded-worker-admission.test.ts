import { describe, expect, it } from "vitest"
import { BoundedWorkerAdmission } from "./bounded-worker-admission"

describe("BoundedWorkerAdmission", () => {
  it("hard-bounds active work and queued input promises", async () => {
    const admission = new BoundedWorkerAdmission(2, 2, "test worker")
    const releaseFirst = await admission.acquire()
    const releaseSecond = await admission.acquire()
    const third = admission.acquire()
    const fourth = admission.acquire()

    expect(admission.activeCount).toBe(2)
    expect(admission.waiterCount).toBe(2)
    await expect(admission.acquire()).rejects.toMatchObject({
      name: "WORKER_ADMISSION_CAPACITY_EXCEEDED"
    })

    releaseFirst()
    const releaseThird = await third
    expect(admission.activeCount).toBe(2)
    expect(admission.waiterCount).toBe(1)
    releaseSecond()
    const releaseFourth = await fourth
    releaseThird()
    releaseFourth()
    expect(admission.admittedCount).toBe(0)
  })

  it("removes an aborted waiter synchronously and preserves the active slot", async () => {
    const admission = new BoundedWorkerAdmission(1, 1, "test worker")
    const release = await admission.acquire()
    const controller = new AbortController()
    const waiting = admission.acquire(controller.signal)
    controller.abort(new Error("obsolete intent"))

    expect(admission.waiterCount).toBe(0)
    await expect(waiting).rejects.toThrow("obsolete intent")
    release()
    expect(admission.admittedCount).toBe(0)
  })
})
