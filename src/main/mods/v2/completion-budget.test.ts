import { expect, it, vi } from "vitest"
import {
  CompletionBudget,
  reserveCompletionModelUsage,
  withCompletionBudget
} from "./completion-budget"

it("cumulatively reserves model output across checks and refuses a swallowed over-budget pass", async () => {
  const budget = new CompletionBudget(300, 1000)
  await withCompletionBudget(budget, async () => {
    reserveCompletionModelUsage(40, 200)!.settle(30, 170)
  })
  await expect(
    withCompletionBudget(budget, async () => {
      try {
        reserveCompletionModelUsage(40, 200)
      } catch {
        /* an untrusted caller cannot clear the failure */
      }
    })
  ).rejects.toThrow("MODS_COMPLETION_MODEL_BUDGET")
  expect(budget.outputReserved).toBe(200)
  expect(budget.inputTokens).toBe(30)
  expect(budget.outputTokens).toBe(170)
})

it("refuses unknown provider usage even if the caller catches the accounting failure", async () => {
  const budget = new CompletionBudget(300, 1000)
  await expect(
    withCompletionBudget(budget, async () => {
      const reservation = reserveCompletionModelUsage(20, 100)!
      try {
        reservation.settle(undefined, 8)
      } catch {
        /* cannot invent input usage */
      }
    })
  ).rejects.toThrow("MODS_COMPLETION_USAGE_UNAVAILABLE")
})

it("cannot finish while a detached provider reservation remains unsettled", async () => {
  const budget = new CompletionBudget(300, 1000)
  await expect(
    withCompletionBudget(budget, async () => {
      reserveCompletionModelUsage(20, 100)
    })
  ).rejects.toThrow("MODS_COMPLETION_USAGE_PENDING")
})

it("shares an absolute deadline across later revisions", async () => {
  let now = 50
  const budget = new CompletionBudget(300, 1000, () => now)
  expect(budget.remainingMs()).toBe(1000)
  now = 1050
  await expect(withCompletionBudget(budget, async () => {})).rejects.toThrow(
    "MODS_COMPLETION_TIMEOUT"
  )
})

it.each([86400000, -86400000])(
  "does not change a completion deadline when wall time jumps by %s",
  (jump) => {
    let wall = 100000
    let monotonic = 50
    const wallClock = vi.spyOn(Date, "now").mockImplementation(() => wall)
    const elapsedClock = vi.spyOn(performance, "now").mockImplementation(() => monotonic)
    try {
      const budget = new CompletionBudget(300, 1000)
      wall += jump
      monotonic += 250.25
      expect(budget.remainingMs()).toBe(750)
      // AbortSignal.timeout requires an integer, although the monotonic clock has fractions.
      expect(() => AbortSignal.timeout(budget.remainingMs())).not.toThrow()
      monotonic += 800
      expect(() => budget.assert()).toThrow("MODS_COMPLETION_TIMEOUT")
      wall -= jump
      expect(() => budget.assert()).toThrow("MODS_COMPLETION_TIMEOUT")
    } finally {
      wallClock.mockRestore()
      elapsedClock.mockRestore()
    }
  }
)
