import { expect, it } from "vitest"
import { parseCompletionPolicy, DEFAULT_COMPLETION_POLICY } from "../../../shared/mods/v2/completion-policy"

it("defaults off and accepts four modes, four scopes and bounded budgets", () => {
  expect(DEFAULT_COMPLETION_POLICY.mode).toBe("off")
  for (const mode of ["off", "report", "check", "repair"])
    for (const scope of ["file", "diff", "feature", "project"])
      expect(parseCompletionPolicy({ ...DEFAULT_COMPLETION_POLICY, mode, scope }).mode).toBe(mode)
})

it.each([
  { maxRepairs: -1 }, { maxRepairs: 11 }, { timeoutMs: 0 },
  { modelTokenBudget: Infinity }, { scope: "all-disk" },
  { target: "../outside" }, { feature: "../outside" }, { checks: ["fake-validator"] },
  { mode: "check", checks: [] }
])("rejects unsafe or unbounded completion policy %j", (change) => {
  expect(() => parseCompletionPolicy({ ...DEFAULT_COMPLETION_POLICY, ...change })).toThrow()
})
