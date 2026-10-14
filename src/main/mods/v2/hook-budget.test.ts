import { describe, expect, it } from "vitest"
import { FunctionHookBudget, isFreeFunctionWait } from "./hook-budget"

describe("native hook own-time accounting", () => {
  it("counts overlapping SDK waits once and resumes without replenishing spent time", () => {
    let now = 0
    const budget = new FunctionHookBudget(100, () => now)
    budget.start()
    now = 10
    const first = budget.beginFreeWait()
    now = 60
    const second = budget.beginFreeWait()
    now = 200
    first()
    first()
    now = 300
    expect(budget.snapshot()).toEqual({ ms: 100, remainingMs: 90 })
    second()
    now = 320
    expect(budget.snapshot().remainingMs).toBe(70)
    second()
    now = 390
    expect(() => budget.beginFreeWait()).toThrow("MODS_HOOK_BUDGET_EXCEEDED")
    expect(budget.snapshot().remainingMs).toBe(0)
  })

  it("rejects a free request exactly at exhaustion before any watchdog tick", () => {
    let now = 0
    const budget = new FunctionHookBudget(10, () => now)
    budget.start()
    now = 10
    expect(() => budget.beginFreeWait()).toThrow("MODS_HOOK_BUDGET_EXCEEDED")
    now = 11
    expect(budget.snapshot().remainingMs).toBe(0)
  })

  it("keeps frame meters independent and ignores old receipts after closure", () => {
    let now = 0
    const old = new FunctionHookBudget(100, () => now)
    const recovery = new FunctionHookBudget(1000, () => now)
    old.start()
    const receipt = old.beginFreeWait()
    recovery.start()
    now = 100
    expect(recovery.snapshot().remainingMs).toBe(900)
    expect(old.snapshot().remainingMs).toBe(100)
    old.close()
    receipt()
    now = 200
    expect(recovery.snapshot().remainingMs).toBe(800)
    expect(() => old.snapshot()).toThrow("MODS_STALE_INVOCATION")
  })

  it("does not charge admission and preserves unmetered Infinity", () => {
    let now = 0
    const budget = new FunctionHookBudget(0, () => now)
    now = 9000
    budget.start()
    now = 99999
    expect(budget.snapshot()).toEqual({ ms: 0, remainingMs: Infinity })
    expect(isFreeFunctionWait("next")).toBe(true)
    expect(isFreeFunctionWait("model.complete")).toBe(true)
    expect(isFreeFunctionWait("clock.now")).toBe(true)
    for (const method of ["clock.sleep", "clock.after", "clock.every", "invoke.admitted"])
      expect(isFreeFunctionWait(method)).toBe(false)
  })
})
