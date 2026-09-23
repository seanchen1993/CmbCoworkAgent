import { expect, it } from "vitest"
import { IngressCostProfile } from "../support/mods-ingress-cost-profile"

it("records exact synchronous call cost and leaves return values and errors intact", () => {
  let now = 10
  const profile = new IngressCostProfile(() => now)
  const value = {}
  expect(
    profile.measure("claim", () => {
      now += 3
      return value
    })
  ).toBe(value)
  const error = new Error("durability failure")
  expect(() =>
    profile.measure("claim", () => {
      now += 5
      throw error
    })
  ).toThrow(error)
  expect(profile.snapshot()).toEqual({
    claim: { calls: 2, totalMs: 8, meanMs: 4, p95Ms: 5, maxMs: 5 }
  })
  profile.reset()
  expect(profile.snapshot()).toEqual({})
})

it("does not collect configuration and warmup calls while paused", () => {
  let now = 0
  const profile = new IngressCostProfile(() => now)
  profile.pause()
  profile.measure("claim", () => {
    now += 99
  })
  expect(profile.snapshot()).toEqual({})
  profile.reset()
  profile.measure("claim", () => {
    now += 2
  })
  expect(profile.snapshot().claim.totalMs).toBe(2)
})

it("times asynchronous boundaries through settlement and preserves rejection", async () => {
  let now = 1
  const profile = new IngressCostProfile(() => now)
  let finish!: (value: string) => void
  const pending = profile.measureAsync(
    "guest.invoke",
    () =>
      new Promise<string>((resolve) => {
        finish = resolve
      })
  )
  expect(profile.snapshot()).toEqual({})
  now = 8
  finish("actual")
  await expect(pending).resolves.toBe("actual")
  const error = new Error("original")
  await expect(
    profile.measureAsync("guest.invoke", async () => {
      now += 3
      throw error
    })
  ).rejects.toBe(error)
  expect(profile.snapshot()["guest.invoke"]).toMatchObject({
    calls: 2,
    totalMs: 10,
    meanMs: 5,
    maxMs: 7
  })
})
