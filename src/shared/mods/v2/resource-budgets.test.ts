import { expect, it } from "vitest"
import { FUNCTION_MOD_RESOURCE_BUDGETS as budgets } from "./resource-budgets"

it("preserves the original independent display, runtime and native credit limits", () => {
  expect(budgets.rendererDisplay).toEqual({
    physical: 4,
    pending: 256,
    interactive: 3,
    background: 1
  })
  expect(budgets.mainDisplay).toEqual({ physical: 32, perNativeFrame: 16, pendingMounts: 32 })
  expect(budgets.runtimeClient).toEqual({
    pending: 128,
    hostCalls: 512,
    moduleCallsPerRuntime: 128,
    childRssBytes: 384 * 1024 * 1024
  })
  expect(budgets.utilityHost).toEqual({ runtimes: 16, frames: 128 })
  expect(budgets.guest).toEqual({ frames: 32, rpc: 128 })
  expect(budgets.uiResolveThread).toEqual({
    handles: 4096,
    roots: 32,
    branches: 1024,
    reactions: 1024
  })
  expect(budgets.diagnostics.retainedEvents).toBe(32)
})

it("keeps cold maintenance Workers in their own globally bounded domain", () => {
  expect(budgets.checkpointMaintenance).toEqual({ active: 2, wait: 16 })
  expect(Object.isFrozen(budgets)).toBe(true)
  expect(Object.values(budgets).every(Object.isFrozen)).toBe(true)
  expect(Reflect.set(budgets.runtimeClient, "pending", 1024)).toBe(false)
  expect(budgets.runtimeClient.pending).toBe(128)
})
