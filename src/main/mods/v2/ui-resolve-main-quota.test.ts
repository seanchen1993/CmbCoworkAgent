import { expect, it, vi } from "vitest"
import {
  FunctionUiResolveMainQuota,
  type FunctionUiResolveQuota,
  type FunctionUiResolveQuotaCredit,
  type FunctionUiResolveQuotaLease
} from "./ui-resolve-main-quota"

function deferred() {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((accept, refuse) => {
    resolve = accept
    reject = refuse
  })
  return { promise, resolve, reject }
}

function physical(pool: FunctionUiResolveMainQuota) {
  const disposed = deferred()
  const hostDrained = deferred()
  const owner = Object.freeze({})
  const assertCurrent = vi.fn(() => undefined)
  const lease = pool.register({
    owner,
    disposed: disposed.promise,
    hostDrained: hostDrained.promise,
    assertCurrent
  })
  return { lease, owner, assertCurrent, disposed, hostDrained }
}

const small: FunctionUiResolveQuota = { handles: 8, roots: 2, branches: 4, reactions: 4 }
const grant: FunctionUiResolveQuota = { handles: 4, roots: 1, branches: 2, reactions: 2 }

it("reserves across live, candidate and retiring utilities before any credit ACK arrives", async () => {
  const pool = new FunctionUiResolveMainQuota(small)
  const live = physical(pool)
  const candidate = physical(pool)
  const first = pool.reserve(live.lease, grant)
  pool.retire(live.lease)
  const next = pool.reserve(candidate.lease, grant)
  expect(pool.stats).toMatchObject(small)
  expect(() => pool.reserve(physical(pool).lease, grant)).toThrow("QUOTA_CAPACITY")
  expect(() => pool.acknowledge(live.lease, first, live.owner)).toThrow("QUOTA_RETIRED")
  pool.acknowledge(candidate.lease, next, candidate.owner)
  // VM exit alone cannot release the still-running main-process host operation.
  live.disposed.resolve()
  await Promise.resolve()
  expect(pool.stats).toMatchObject(small)
  live.hostDrained.resolve()
  await pool.whenReleased(live.lease)
  expect(pool.stats).toMatchObject(grant)
  expect(() => pool.reserve(candidate.lease, small)).not.toThrow()
})

it.each(["disposed", "hostDrained"] as const)(
  "never refunds credit when only the real %s receipt has completed",
  async (first) => {
    const pool = new FunctionUiResolveMainQuota(grant)
    const runtime = physical(pool)
    pool.reserve(runtime.lease, grant)
    pool.retire(runtime.lease)
    runtime[first].resolve()
    await Promise.resolve()
    expect(pool.stats).toMatchObject(grant)
    const second = first === "disposed" ? "hostDrained" : "disposed"
    runtime[second].resolve()
    await pool.whenReleased(runtime.lease)
    expect(pool.stats).toMatchObject({ handles: 0, roots: 0, branches: 0, reactions: 0 })
  }
)

it("lost ACKs, cancellation and closing the pool retain capacity until real disposal and drain", async () => {
  const pool = new FunctionUiResolveMainQuota(small)
  const runtime = physical(pool)
  pool.reserve(runtime.lease, grant)
  expect(() => pool.reserve(runtime.lease, small)).toThrow("QUOTA_PENDING")
  pool.close()
  expect(pool.stats).toMatchObject(grant)
  expect(() => pool.reserve(runtime.lease, small)).toThrow("QUOTA_RETIRED")
  runtime.hostDrained.resolve()
  runtime.disposed.resolve()
  await pool.whenReleased(runtime.lease)
  expect(pool.stats.leases).toBe(0)
})

it("quarantines uncertain completion without giving a replacement its reserved credits", async () => {
  const pool = new FunctionUiResolveMainQuota(grant)
  const runtime = physical(pool)
  pool.reserve(runtime.lease, grant)
  const failure = Error("native disposal could not be confirmed")
  runtime.disposed.reject(failure)
  runtime.hostDrained.resolve()
  await expect(pool.whenReleased(runtime.lease)).rejects.toBe(failure)
  expect(pool.stats).toMatchObject({ ...grant, quarantined: 1 })
  expect(() => pool.reserve(physical(pool).lease, grant)).toThrow("QUOTA_CAPACITY")
})

it("correlates ACKs to actual physical owners, opaque receipts and monotonically issued credit", () => {
  const pool = new FunctionUiResolveMainQuota(small)
  const runtime = physical(pool)
  const first = pool.reserve(runtime.lease, grant)
  expect(pool.wireCredit(runtime.lease, first)).toEqual({ revision: 1, limits: grant })
  expect(() => pool.acknowledge(runtime.lease, first, {})).toThrow("QUOTA_IDENTITY")
  expect(() => pool.wireCredit({} as FunctionUiResolveQuotaLease, first)).toThrow("QUOTA_IDENTITY")
  expect(() =>
    pool.acknowledge(runtime.lease, {} as FunctionUiResolveQuotaCredit, runtime.owner)
  ).toThrow("QUOTA_IDENTITY")
  pool.acknowledge(runtime.lease, first, runtime.owner)
  pool.acknowledge(runtime.lease, first, runtime.owner)
  const second = pool.reserve(runtime.lease, small)
  expect(pool.wireCredit(runtime.lease, second).revision).toBe(2)
  expect(() => pool.acknowledge(runtime.lease, first, runtime.owner)).toThrow("QUOTA_IDENTITY")
  pool.acknowledge(runtime.lease, second, runtime.owner)
  expect(pool.stats).toMatchObject(small)
})

it.each(["handles", "roots", "branches", "reactions"] as const)(
  "enforces the common %s boundary without partially debiting other dimensions",
  (dimension) => {
    const pool = new FunctionUiResolveMainQuota(grant)
    const runtime = physical(pool)
    expect(() =>
      pool.reserve(runtime.lease, { ...grant, [dimension]: grant[dimension] + 1 })
    ).toThrow("QUOTA_CAPACITY")
    expect(pool.stats).toMatchObject({ handles: 0, roots: 0, branches: 0, reactions: 0 })
    const credit = pool.reserve(runtime.lease, grant)
    pool.acknowledge(runtime.lease, credit, runtime.owner)
    expect(() => pool.reserve(runtime.lease, { ...grant, [dimension]: 0 })).toThrow("QUOTA_SHRINK")
    expect(pool.stats).toMatchObject(grant)
  }
)

it("rejects fractional, extra and stale credit instead of widening the actual allowance", () => {
  const pool = new FunctionUiResolveMainQuota(small)
  const runtime = physical(pool)
  expect(() => pool.reserve(runtime.lease, { ...grant, handles: 0.5 })).toThrow("QUOTA_INVALID")
  const extra = { ...grant, unlimited: true }
  expect(() => pool.reserve(runtime.lease, extra)).toThrow("QUOTA_INVALID")
  runtime.assertCurrent.mockImplementation(() => {
    throw Error("actual owner was replaced")
  })
  expect(() => pool.reserve(runtime.lease, grant)).toThrow("actual owner was replaced")
  expect(pool.stats).toMatchObject({ handles: 0, roots: 0, branches: 0, reactions: 0 })
})

it("does not register a new physical lease after the native source guard closes its pool", () => {
  const pool = new FunctionUiResolveMainQuota(small)
  expect(() =>
    pool.register({
      owner: {},
      disposed: deferred().promise,
      hostDrained: deferred().promise,
      assertCurrent: () => pool.close()
    })
  ).toThrow("QUOTA_STALE")
  expect(pool.stats.leases).toBe(0)
})
