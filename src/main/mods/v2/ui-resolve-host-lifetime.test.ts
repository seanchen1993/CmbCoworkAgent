import { describe, expect, it } from "vitest"
import { FunctionUiResolveHostLifetime } from "./ui-resolve-host-lifetime"
import { FunctionUiResolveMainQuota } from "./ui-resolve-main-quota"

const deferred = () => {
  let resolve!: () => void
  let reject!: (reason: Error) => void
  const promise = new Promise<void>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const tick = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

describe("native UI resolve physical lifetime", () => {
  it("does not turn initial or later idle into terminal host drain", async () => {
    const life = new FunctionUiResolveHostLifetime({})
    const drained = { value: false }
    void life.hostDrained.then(() => {
      drained.value = true
    })
    await tick()
    expect(drained.value).toBe(false)
    await life.run(async () => undefined)
    await tick()
    expect(drained.value).toBe(false)
    life.seal()
    await life.hostDrained
    expect(drained.value).toBe(true)
    await expect(life.run(async () => undefined)).rejects.toMatchObject({
      code: "MODS_UI_RESOLVE_RETIRED"
    })
  })

  it("keeps credit occupied after actual exit while ignored-cancel host work is running", async () => {
    const life = new FunctionUiResolveHostLifetime({})
    const pool = new FunctionUiResolveMainQuota({ handles: 8, roots: 2, branches: 2, reactions: 2 })
    const lease = pool.register(life)
    const credit = pool.reserve(lease, { handles: 8, roots: 2, branches: 2, reactions: 2 })
    pool.acknowledge(lease, credit, life.owner)
    const hold = deferred()
    const actual = life.run(() => hold.promise)
    life.confirmExit()
    await life.disposed
    await tick()
    expect(pool.stats.handles).toBe(8)
    hold.resolve()
    await actual
    await pool.whenReleased(lease)
    expect(pool.stats.handles).toBe(0)
  })

  it("does not claim sending kill or sealing proves real process exit", async () => {
    const life = new FunctionUiResolveHostLifetime({})
    const disposed = { value: false }
    void life.disposed.then(() => {
      disposed.value = true
    })
    life.seal()
    await life.hostDrained
    await tick()
    expect(disposed.value).toBe(false)
    life.confirmExit()
    await life.disposed
    expect(disposed.value).toBe(true)
  })

  it("counts nested host work before a parent settles and seals admission synchronously", async () => {
    const life = new FunctionUiResolveHostLifetime({})
    const hold = deferred()
    let child!: Promise<void>
    await life.run(async () => {
      child = life.run(() => hold.promise)
    })
    life.seal()
    const drained = { value: false }
    void life.hostDrained.then(() => {
      drained.value = true
    })
    await tick()
    expect(drained.value).toBe(false)
    hold.resolve()
    await child
    await life.hostDrained
    expect(drained.value).toBe(true)
  })

  it("records genuine synchronous and asynchronous failure as actual finally", async () => {
    const life = new FunctionUiResolveHostLifetime({})
    await expect(
      life.run(() => {
        throw new Error("sync")
      })
    ).rejects.toThrow("sync")
    const hold = deferred()
    const actual = life.run(() => hold.promise)
    life.seal()
    hold.reject(new Error("async"))
    await expect(actual).rejects.toThrow("async")
    await life.hostDrained
    life.confirmExit()
    await life.disposed
  })

  it("an old incarnation exiting cannot close a different new incarnation", async () => {
    const oldLife = new FunctionUiResolveHostLifetime({})
    const newLife = new FunctionUiResolveHostLifetime({})
    oldLife.seal()
    oldLife.confirmExit()
    await oldLife.disposed
    await newLife.run(async () => undefined)
    expect(() => newLife.assertCurrent()).not.toThrow()
  })

  it("shares actual native host capacity across routes until genuine finally", async () => {
    const life = new FunctionUiResolveHostLifetime({}, 2)
    const first = deferred()
    const second = deferred()
    const one = life.run(() => first.promise)
    const two = life.run(() => second.promise)
    await expect(life.run(async () => undefined)).rejects.toMatchObject({
      code: "MODS_HOST_CAPACITY"
    })
    first.resolve()
    await one
    await life.run(async () => undefined)
    life.confirmExit()
    second.resolve()
    await two
    await life.hostDrained
  })
})
