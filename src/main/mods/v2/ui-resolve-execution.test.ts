import { afterEach, expect, it } from "vitest"
import { ModRuntimeAuthorities } from "../runtime-instance"
import {
  currentFunctionExecution,
  withFunctionExecution,
  withFunctionWriteLease
} from "./execution-context"
import { withFunctionTransportExecution } from "./host-call"
import {
  captureFunctionUiResolveExecution,
  type FunctionUiResolveExecution
} from "./ui-resolve-execution"

const registries: ModRuntimeAuthorities[] = []
afterEach(() => {
  for (const registry of registries.splice(0)) registry.close()
})
const facts = {
  workspace: "/actual-project",
  threadId: "thread",
  agentId: "actual-child",
  turnId: "actual-turn",
  userInitiated: true,
  leased: false,
  immediate: false
}

it("requires an actual current workspace/thread entry instead of a default main actor", async () => {
  expect(() => captureFunctionUiResolveExecution(facts.workspace, facts.threadId)).toThrow(
    "MODS_UI_RESOLVE_EXECUTION_REQUIRED"
  )
  await withFunctionExecution(facts, async () => {
    expect(() => captureFunctionUiResolveExecution("/other", facts.threadId)).toThrow(
      "MODS_UI_RESOLVE_EXECUTION_REQUIRED"
    )
    expect(() => captureFunctionUiResolveExecution(facts.workspace, "other")).toThrow(
      "MODS_UI_RESOLVE_EXECUTION_REQUIRED"
    )
  })
})

it("retains the actual child and turn after a normal entry ends, until real authority retirement", async () => {
  const registry = new ModRuntimeAuthorities()
  registries.push(registry)
  const runtime = registry.create(facts)
  let captured!: FunctionUiResolveExecution
  await withFunctionExecution({ ...facts, runtimeAuthority: runtime.authority }, async () => {
    captured = captureFunctionUiResolveExecution(facts.workspace, facts.threadId)
    expect(Object.isFrozen(captured)).toBe(true)
  })
  expect(captured).toMatchObject({
    agentId: facts.agentId,
    turnId: facts.turnId,
    runtimeAuthority: runtime.authority
  })
  expect(() => captured.assertCurrent()).not.toThrow()
  runtime.release()
  registry.create({ ...facts, turnId: "replacement-turn" })
  expect(() => captured.assertCurrent()).toThrow("MODS_RUNTIME_INSTANCE_EXPIRED")
})

it("keeps original actor facts but never borrows a user's write authority for constructor work", async () => {
  let captured!: FunctionUiResolveExecution
  await withFunctionExecution(facts, async () => {
    captured = captureFunctionUiResolveExecution(facts.workspace, facts.threadId)
  })
  await withFunctionTransportExecution(
    { ...captured, userInitiated: false, leased: false, immediate: true },
    async () => {
      expect(currentFunctionExecution()).toMatchObject({
        agentId: facts.agentId,
        turnId: facts.turnId,
        userInitiated: false,
        leased: false,
        immediate: true
      })
      await expect(
        withFunctionWriteLease(facts.workspace, facts.threadId, async () => {})
      ).rejects.toMatchObject({ code: "MODS_WRITE_REQUIRES_USER_ACTION" })
    }
  )
})

it("refuses a late capture from a finished entry even when its actor was previously valid", async () => {
  let resume!: () => void
  let late!: Promise<void>
  await withFunctionExecution(facts, async () => {
    late = new Promise<void>((resolve) => {
      resume = resolve
    }).then(() => {
      expect(() => captureFunctionUiResolveExecution(facts.workspace, facts.threadId)).toThrow(
        "MODS_CALL_SCOPE_EXPIRED"
      )
    })
  })
  resume()
  await late
})
