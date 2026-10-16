import { expect, it } from "vitest"
import { CREATOR_REQUEST_LIMITS, CreatorRequestBudgets } from "./creator-request-budget"
import type { AuthoringAtomicSettings } from "./authoring-config-snapshot"

function fixture() {
  let now = 1000
  const values = new Map<string, string>()
  const settings: AuthoringAtomicSettings = {
    getSetting: (key, fallback) => values.get(key) ?? fallback ?? "",
    compareAndSetSetting: (key, expected, value) => {
      if (values.get(key) !== expected) return false
      values.set(key, value)
      return true
    }
  }
  return {
    values,
    settings,
    make: () => new CreatorRequestBudgets(settings, () => now),
    advance: (ms: number) => {
      now += ms
    }
  }
}

it("keeps the same native request budget across tool/service rebuilds and separates new human requests", () => {
  const f = fixture()
  for (let i = 0; i < 3; i++) f.make().claim("scope", "native-run", "candidate")
  expect(() => f.make().claim("scope", "native-run", "candidate")).toThrow(
    "DEVELOPMENT_REPAIR_BUDGET"
  )
  expect(f.make().claim("scope", "explicit-new-request", "candidate").candidates).toBe(1)
  expect(f.make().claim("another-scope", "native-run", "candidate").candidates).toBe(1)
  expect(f.make().latest("scope")?.runId).toBe("explicit-new-request")
})

it("bounds discovery operations and elapsed time without resetting them on reconstruction", () => {
  const f = fixture()
  for (let i = 0; i < 32; i++) f.make().claim("scope", "run", "operation")
  expect(() => f.make().claim("scope", "run", "operation")).toThrow("DEVELOPMENT_TURN_BUDGET")
  f.make().claim("scope", "timed", "operation")
  f.advance(CREATOR_REQUEST_LIMITS.durationMs)
  expect(() => f.make().claim("scope", "timed", "candidate")).toThrow("DEVELOPMENT_TURN_BUDGET")
})

it("shares a host goal's cumulative budget across native turns, failover and goal completion", () => {
  const f = fixture()
  for (let i = 0; i < 3; i++)
    f.make().claim("scope", `native-${i}`, "candidate", "goal:trusted-host-id")
  expect(() => f.make().claim("scope", "native-3", "candidate", "goal:trusted-host-id")).toThrow(
    "DEVELOPMENT_REPAIR_BUDGET"
  )
  // Finishing/changing a goal during the same physical turn cannot detach its old accounting.
  expect(() => f.make().claim("scope", "native-2", "candidate")).toThrow(
    "DEVELOPMENT_REPAIR_BUDGET"
  )
  expect(() => f.make().claim("scope", "native-2", "candidate", "goal:new")).toThrow(
    "DEVELOPMENT_REPAIR_BUDGET"
  )
  expect(f.make().claim("scope", "explicit-new-native", "candidate", "goal:new").candidates).toBe(1)
  const elapsed = fixture()
  elapsed.make().claim("scope", "first", "operation", "goal:host")
  elapsed.advance(CREATOR_REQUEST_LIMITS.durationMs)
  expect(() => elapsed.make().claim("scope", "continued", "operation", "goal:host")).toThrow(
    "DEVELOPMENT_TURN_BUDGET"
  )
})

it("fails closed for corrupt or concurrently replaced accounting and retains a bounded history", () => {
  const f = fixture()
  for (let i = 0; i < 40; i++) f.make().claim("scope", `run-${i}`, "operation")
  const [key, value] = [...f.values.entries()][0]
  expect(JSON.parse(value)).toHaveLength(16)
  f.values.set(key, "not JSON")
  expect(() => f.make().claim("scope", "run", "operation")).toThrow(
    "DEVELOPMENT_BUDGET_UNCONFIRMED"
  )
  const conflict = new CreatorRequestBudgets({
    getSetting: (_key, fallback) => fallback!,
    compareAndSetSetting: () => false
  })
  expect(() => conflict.claim("scope", "run", "operation")).toThrow(
    "DEVELOPMENT_BUDGET_UNCONFIRMED"
  )
})
