import { expect, it } from "vitest"
import { HookProcessCleanupError } from "../hooks/owned-process-error"
import { classifyManagedAgentFailure } from "./managed-agent-failure"

it("preserves trusted physical cleanup uncertainty through the original native cause chain", () => {
  const error = new HookProcessCleanupError()
  expect(classifyManagedAgentFailure(error)).toBe("unknown")
  expect(classifyManagedAgentFailure(new Error("Middleware failed", { cause: error }))).toBe(
    "unknown"
  )
  expect(
    classifyManagedAgentFailure(
      new Error("Outer failure", {
        cause: new Error("Inner failure", { cause: error })
      })
    )
  ).toBe("unknown")
})

it("Hook JSON, remote messages and forged name/code do not assert physical ownership", () => {
  expect(classifyManagedAgentFailure("HOOK_PROCESS_CLEANUP_UNCONFIRMED")).toBe("provider_error")
  expect(classifyManagedAgentFailure(new Error("HOOK_PROCESS_CLEANUP_UNCONFIRMED"))).toBe(
    "provider_error"
  )
  expect(
    classifyManagedAgentFailure(
      Object.assign(new Error("remote body"), {
        name: "HookProcessCleanupError",
        code: "HOOK_PROCESS_CLEANUP_UNCONFIRMED",
        status: 500
      })
    )
  ).toBe("provider_error")
  expect(
    classifyManagedAgentFailure({
      name: "HookProcessCleanupError",
      code: "HOOK_PROCESS_CLEANUP_UNCONFIRMED"
    })
  ).toBe("provider_error")
})

it("retains the original bounded native-cause traversal", () => {
  const error = new Error("cycle")
  Object.defineProperty(error, "cause", { value: error })
  expect(classifyManagedAgentFailure(error)).toBe("provider_error")
  let wrapped: Error = new HookProcessCleanupError()
  for (let index = 0; index < 9; index++) wrapped = new Error("wrapper", { cause: wrapped })
  expect(classifyManagedAgentFailure(wrapped)).toBe("provider_error")
})
