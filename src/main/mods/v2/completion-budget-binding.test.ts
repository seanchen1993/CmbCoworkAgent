import { expect, it, vi } from "vitest"
import { ModsManager } from "../manager"
import {
  CompletionBudget,
  bindCompletionGateBudget,
  completionGateBudget
} from "./completion-budget"

it("preserves the host budget on the real ModsManager authority wrapper before first check", async () => {
  const gate = async () => ({ decision: "pass" })
  const budget = new CompletionBudget(1000, 5000)
  bindCompletionGateBudget(gate, budget)
  const binding = { workspace: "project", turnId: "turn" }
  const wrapped = await ModsManager.prototype.createCompletionGate.call(
    {
      isEnabled: () => true,
      workspaceKey: () => "project",
      functionLifecycle: { completionGate: async () => gate },
      bindings: new Map([["thread:main", binding]]),
      assertFunctionBinding: vi.fn()
    } as unknown as ModsManager,
    "project",
    "thread",
    () => ({ turnId: "turn" })
  )
  expect(wrapped).toBeTypeOf("function")
  expect(completionGateBudget(wrapped!)).toBe(budget)
})
