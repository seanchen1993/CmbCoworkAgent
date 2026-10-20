import { createHash } from "node:crypto"
import { expect, it, vi } from "vitest"
import {
  CREATOR_REQUEST_LIMITS,
  CreatorRequestBudgets,
  creatorModelSummary,
  creatorRequestBudgetCacheDiagnosticsForTests,
  type CreatorRequestObservation
} from "./creator-request-budget"
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

it("persists provider attempts and usage in the same original CAS row across turns and rebuilds", () => {
  const f = fixture()
  const bound = f.make().bindModel("scope", "main", "goal:one", { modelAttemptLimit: 2 })
  const first = f.make().claimModel("scope", bound.runId, "original-trace")
  f.make().settleModel("scope", bound.runId, first)
  const resumed = f.make().bindModel("scope", "second", "goal:one")
  expect(resumed.runId).toBe(bound.runId)
  const second = f.make().claimModel("scope", resumed.runId, "child-trace")
  f.make().settleModel("scope", resumed.runId, second, { inputTokens: 0, outputTokens: 2 })
  f.make().settleModel("scope", resumed.runId, second, { inputTokens: 0, outputTokens: 2 })
  expect(() => f.make().claimModel("scope", resumed.runId)).toThrow(
    "DEVELOPMENT_MODEL_ATTEMPT_BUDGET"
  )
  expect(creatorModelSummary(f.make().latest("scope")?.model)).toMatchObject({
    attempts: 2,
    usageReportedAttempts: 1,
    usageUnknownAttempts: 1,
    coverage: "partial",
    inputTokens: 0,
    outputTokens: 2,
    traceIds: ["original-trace", "child-trace"]
  })
  expect(f.values.size).toBe(1)
  expect(f.make().bindModel("scope", "second", "goal:new").runId).toBe(bound.runId)
  expect(f.make().bindModel("scope", "explicit-new", "goal:new").runId).toBe("explicit-new")
})

it("migrates historical rows without claiming old token counts are zero and rejects hard currency promises", () => {
  const f = fixture()
  f.make().claim("scope", "old", "operation")
  const bound = f.make().bindModel("scope", "old")
  expect(creatorModelSummary(f.make().latest("scope")?.model)).toMatchObject({
    historicalUsageUnknown: true,
    coverage: "partial"
  })
  expect(creatorModelSummary(f.make().latest("scope")?.model)).not.toHaveProperty("inputTokens")
  expect(creatorModelSummary(f.make().latest("scope")?.model).cost).not.toHaveProperty("amount")
  expect(bound.runId).toBe("old")
  expect(() => f.make().claimModel("scope", bound.runId)).toThrow(
    "DEVELOPMENT_MODEL_HISTORY_UNCONFIRMED"
  )
  expect(f.make().latest("scope")?.operations).toBe(1)
  f.make().bindModel("scope", "genuine-new-human")
  expect(() => f.make().claimModel("scope", "genuine-new-human")).not.toThrow()
  f.make().bindModel("money", "run", undefined, { hardMoneyLimit: { amount: 10, currency: "CNY" } })
  expect(() => f.make().claimModel("money", "run")).toThrow("DEVELOPMENT_MODEL_COST_UNSUPPORTED")
  expect(f.make().latest("money")?.model?.attempts).toHaveLength(0)
})

it("rejects conflicting provider receipts and invalid persisted usage rather than silently resetting", () => {
  const f = fixture()
  f.make().bindModel("scope", "run")
  const id = f.make().claimModel("scope", "run")
  f.make().settleModel("scope", "run", id, { inputTokens: 1, outputTokens: 2 })
  expect(() =>
    f.make().settleModel("scope", "run", id, { inputTokens: 3, outputTokens: 4 })
  ).toThrow("DEVELOPMENT_BUDGET_UNCONFIRMED")
  f.make().settleModel("scope", "run", id)
  expect(f.make().latest("scope")?.model?.attempts[0]).toEqual({ id, state: "unknown" })
  expect(() =>
    f.make().settleModel("scope", "run", id, { inputTokens: 1, outputTokens: 2 })
  ).toThrow("DEVELOPMENT_BUDGET_UNCONFIRMED")
  const [key, raw] = [...f.values][0]
  const rows = JSON.parse(raw)
  rows[0].model.attempts[0].inputTokens = -1
  f.values.set(key, JSON.stringify(rows))
  expect(() => f.make().latest("scope")).toThrow("DEVELOPMENT_BUDGET_UNCONFIRMED")
})

it("keeps a frozen policy explicit and fits the full bounded history without losing cumulative attempts", () => {
  const f = fixture()
  f.make().bindModel("scope", "policy", undefined, { modelAttemptLimit: 4 })
  expect(() => f.make().bindModel("scope", "policy", undefined, { modelAttemptLimit: 2 })).toThrow(
    "DEVELOPMENT_BUDGET_UNCONFIRMED"
  )
  expect(() =>
    f
      .make()
      .bindModel("scope", "policy", undefined, { hardMoneyLimit: { amount: 1, currency: "CNY" } })
  ).toThrow("DEVELOPMENT_BUDGET_UNCONFIRMED")
  for (let request = 0; request < 16; request++) {
    const id = `run-${request}`
    f.make().bindModel("scope", id)
    for (let attempt = 0; attempt < 64; attempt++) {
      const key = f.make().claimModel("scope", id, `${request}:${attempt}:`.padEnd(256, "x"))
      f.make().settleModel("scope", id, key, { inputTokens: 1, outputTokens: 1 })
      f.make().recordModelTrace("scope", id, {
        traceId: `${request}:${attempt}:`.padEnd(256, "x"),
        modelCalls: 1,
        toolCalls: 1,
        inputTokens: 1,
        outputTokens: 1,
        usageReportedCalls: 1
      })
    }
  }
  expect(JSON.parse([...f.values.values()][0])).toHaveLength(16)
  expect(f.make().latest("scope")?.model?.attempts).toHaveLength(64)
  expect(Buffer.byteLength([...f.values.values()][0])).toBeLessThan(1024 * 1024)
  expect(() => f.make().claimModel("scope", "run-15")).toThrow("DEVELOPMENT_MODEL_ATTEMPT_BUDGET")
})

it("reuses validated raw history across service rebuilds while reading storage on every call", () => {
  const f = fixture()
  f.make().bindModel("scope", "run")
  const raw = [...f.values.values()][0]
  // A fresh native settings owner proves the initial read, then shares that proof only with
  // service instances using the same owner and the same exact persisted text.
  const reads = vi.fn(f.settings.getSetting)
  const writes = vi.fn(f.settings.compareAndSetSetting)
  const settings = { getSetting: reads, compareAndSetSetting: writes }
  const parse = vi.spyOn(JSON, "parse")
  try {
    expect(new CreatorRequestBudgets(settings, () => 1000).latest("scope")?.runId).toBe("run")
    expect(new CreatorRequestBudgets(settings, () => 1000).latest("scope")?.model?.limit).toBe(64)
    new CreatorRequestBudgets(settings, () => 1000).claimModel("scope", "run")
    expect(parse.mock.calls.filter(([text]) => text === raw)).toHaveLength(1)
    expect(reads).toHaveBeenCalledTimes(3)
    expect(writes).toHaveBeenCalledTimes(1)
    expect(new CreatorRequestBudgets(settings, () => 1000).latest("scope")?.model?.attempts)
      .toHaveLength(1)
    expect(reads).toHaveBeenCalledTimes(4)
  } finally {
    parse.mockRestore()
  }
})

it("keeps public observations and native policy input detached from cached rows", () => {
  const f = fixture()
  f.make().bindModel("scope", "run", "goal", { modelAttemptLimit: 2 })
  const claimed = f.make().claim("scope", "run", "operation", "goal")
  if (!claimed.model || !claimed.nativeRuns) throw Error("Expected native accounting")
  claimed.operations = 32
  claimed.model.limit = 64
  claimed.model.attempts.push({ id: "injected", state: "unknown" })
  claimed.nativeRuns.push("unbound-run")
  const observation = f.make().latest("scope")!
  observation.model!.attempts.push({ id: "also-injected", state: "unknown" })
  expect(f.make().latest("scope")).toMatchObject({ operations: 1, nativeRuns: ["run"],
    model: { limit: 2, attempts: [] } })
  expect(f.make().modelReference("scope", "unbound-run")).toBeUndefined()
  f.make().claimModel("scope", "run")
  f.make().claimModel("scope", "run")
  expect(() => f.make().claimModel("scope", "run")).toThrow("DEVELOPMENT_MODEL_ATTEMPT_BUDGET")
  const policy = { amount: 10, currency: "CNY" }
  f.make().bindModel("money", "money-run", undefined, { hardMoneyLimit: policy })
  expect(Object.isFrozen(policy)).toBe(false)
  policy.amount = 1
  expect(f.make().latest("money")?.model?.hardMoneyLimit).toEqual({ amount: 10, currency: "CNY" })
})

it("invalidates exact-raw cache hits for external changes, corruption and oversize replacement", () => {
  const f = fixture()
  f.make().claim("scope", "run", "operation")
  const [key, raw] = [...f.values][0]
  const rows: CreatorRequestObservation[] = JSON.parse(raw)
  rows[0].operations = 32
  f.values.set(key, JSON.stringify(rows))
  expect(() => f.make().claim("scope", "run", "operation")).toThrow("DEVELOPMENT_TURN_BUDGET")
  rows[0].operations = -1
  f.values.set(key, JSON.stringify(rows))
  expect(() => f.make().latest("scope")).toThrow("DEVELOPMENT_BUDGET_UNCONFIRMED")
  f.values.set(key, "not-json")
  expect(() => f.make().latest("scope")).toThrow("DEVELOPMENT_BUDGET_UNCONFIRMED")
  f.values.set(key, `[${" ".repeat(1024 * 1024)}]`)
  expect(() => f.make().latest("scope")).toThrow("DEVELOPMENT_BUDGET_UNCONFIRMED")
  f.values.set(key, raw)
  expect(f.make().latest("scope")?.operations).toBe(1)
})

it("does not publish copy-on-write attempts after a failed or concurrently replaced CAS", () => {
  const f = fixture()
  const compare = f.settings.compareAndSetSetting
  let reject = false, replace = false
  f.settings.compareAndSetSetting = (key, expected, value) => {
    if (replace) {
      const rows: CreatorRequestObservation[] = JSON.parse(expected!)
      rows[0].operations = 31
      f.values.set(key, JSON.stringify(rows))
      return false
    }
    return reject ? false : compare(key, expected, value)
  }
  f.make().bindModel("scope", "run")
  reject = true
  expect(() => f.make().claimModel("scope", "run")).toThrow("DEVELOPMENT_BUDGET_UNCONFIRMED")
  expect(f.make().latest("scope")?.model?.attempts).toEqual([])
  reject = false
  replace = true
  expect(() => f.make().claimModel("scope", "run")).toThrow("DEVELOPMENT_BUDGET_UNCONFIRMED")
  expect(f.make().latest("scope")).toMatchObject({ operations: 31, model: { attempts: [] } })
  replace = false
  const id = f.make().claimModel("scope", "run", "native-trace")
  expect(f.make().latest("scope")?.model?.attempts).toHaveLength(1)
  reject = true
  expect(() => f.make().settleModel("scope", "run", id, { inputTokens: 1, outputTokens: 2 }))
    .toThrow("DEVELOPMENT_BUDGET_UNCONFIRMED")
  expect(() => f.make().recordModelTrace("scope", "run", {
    traceId: "native-trace", modelCalls: 1, toolCalls: 1, inputTokens: 1, outputTokens: 2,
    usageReportedCalls: 1
  })).toThrow("DEVELOPMENT_BUDGET_UNCONFIRMED")
  expect(f.make().latest("scope")?.model?.attempts[0])
    .toEqual({ id, traceId: "native-trace", state: "pending" })
})

it("separates native settings identities and bounds cached keys without dropping persisted budgets", () => {
  const f = fixture(), other = fixture()
  for (let index = 0; index < 40; index++) f.make().claim(`scope-${index}`, "run", "operation")
  const stats = creatorRequestBudgetCacheDiagnosticsForTests(f.settings)
  expect(stats.entries).toBe(stats.maxEntries)
  expect(stats.bytes).toBeLessThanOrEqual(stats.maxBytes)
  expect(f.values.size).toBe(40)
  other.make().claim("scope-0", "another-run", "operation")
  expect(other.make().latest("scope-0")?.runId).toBe("another-run")
  expect(f.make().latest("scope-0")?.runId).toBe("run")
  f.make().claim("scope-0", "run", "operation")
  expect(f.make().latest("scope-0")?.operations).toBe(2)
  expect(other.make().latest("scope-0")?.operations).toBe(1)
})

it("bounds retained raw bytes and revalidates evicted full histories without resetting usage", () => {
  const f = fixture()
  const history: CreatorRequestObservation[] = Array.from({ length: 16 }, (_, run) => ({
    runId: `run-${run}`, startedAt: 1000, operations: 0, candidates: 0,
    model: { limit: 64, historicalUsageUnknown: false,
      cost: { state: "unavailable", reason: "pricing-unavailable" },
      attempts: Array.from({ length: 64 }, (_, attempt) => ({
        id: `${run}:${attempt}:`.padEnd(160, "i"),
        traceId: `${run}:${attempt}:`.padEnd(256, "t"), state: "unknown",
        traceUsage: { modelCalls: 1, toolCalls: 1, inputTokens: 1, outputTokens: 1,
          usageReportedCalls: 1 }
      })) }
  }))
  const raw = JSON.stringify(history)
  expect(Buffer.byteLength(raw)).toBeLessThan(1024 * 1024)
  const key = (scope: string) =>
    `creator-request-budget:${createHash("sha256").update(scope).digest("hex")}`
  for (let index = 0; index < 12; index++) {
    f.values.set(key(`large-${index}`), raw)
    expect(f.make().latest(`large-${index}`)?.model?.attempts).toHaveLength(64)
  }
  const stats = creatorRequestBudgetCacheDiagnosticsForTests(f.settings)
  expect(Buffer.byteLength(raw) * 12).toBeGreaterThan(stats.maxBytes)
  expect(stats.entries).toBeLessThan(12)
  expect(stats.bytes).toBeLessThanOrEqual(stats.maxBytes)
  expect(f.values.size).toBe(12)
  expect(() => f.make().claimModel("large-0", "run-15"))
    .toThrow("DEVELOPMENT_MODEL_ATTEMPT_BUDGET")
  const corrupt = JSON.parse(raw)
  corrupt[15].model.attempts[0].state = "invented-state"
  f.values.set(key("large-0"), JSON.stringify(corrupt))
  expect(() => f.make().latest("large-0")).toThrow("DEVELOPMENT_BUDGET_UNCONFIRMED")
})
