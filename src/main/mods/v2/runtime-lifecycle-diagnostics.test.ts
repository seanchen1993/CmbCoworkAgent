import { expect, it } from "vitest"
import { RuntimeLifecycleDiagnostics } from "./runtime-lifecycle-diagnostics"
import { FunctionUiResolveHostLifetime } from "./ui-resolve-host-lifetime"

it("retains only 32 numeric/allowlisted observations and deeply immutable copies", () => {
  const diagnostics = new RuntimeLifecycleDiagnostics()
  for (let generation = 0; generation < 40; generation++)
    diagnostics.record({
      generation,
      pid: 123,
      phase: "child-exit",
      code: "PRIVATE_PROMPT_SECRET",
      exitCode: 7,
      pending: 0,
      hostCalls: 0,
      draining: 0,
      ...{ prompt: "PRIVATE_PROMPT_SECRET", stdout: "PRIVATE_STDOUT_SECRET" }
    })
  const snapshot = diagnostics.snapshot()
  expect(snapshot).toHaveLength(32)
  expect(snapshot[0].generation).toBe(8)
  expect(snapshot.at(-1)).toMatchObject({ generation: 39, exitCode: 7, code: "OTHER" })
  expect(JSON.stringify(snapshot)).not.toContain("PRIVATE_")
  expect(Object.isFrozen(snapshot)).toBe(true)
  expect(snapshot.every(Object.isFrozen)).toBe(true)
  expect(diagnostics.snapshot()).not.toBe(snapshot)
  expect(diagnostics.snapshot()[0]).not.toBe(snapshot[0])
})

it("does not let a diagnostic getter failure interfere with subsequent observations", () => {
  const diagnostics = new RuntimeLifecycleDiagnostics()
  diagnostics.record({
    generation: 0,
    phase: "child-error",
    pending: 0,
    hostCalls: 0,
    draining: 0,
    get code() {
      throw Error("PRIVATE_ERROR_MESSAGE")
    }
  })
  diagnostics.record({ generation: 1, phase: "dispatched", pending: 1, hostCalls: 0, draining: 0 })
  expect(diagnostics.snapshot()).toHaveLength(1)
  expect(diagnostics.snapshot()[0].generation).toBe(1)
})

it("keeps ignored-abort native work occupied through actual finally even if observers throw", async () => {
  let finish!: () => void
  const held = new Promise<void>((resolve) => {
    finish = resolve
  })
  const life = new FunctionUiResolveHostLifetime({}, 1, () => {
    throw Error("observer failed")
  })
  const actual = life.run(() => held)
  life.seal()
  expect(life.activity).toEqual({ hostCalls: 1, draining: 1 })
  let drained = false
  void life.hostDrained.then(() => {
    drained = true
  })
  life.confirmExit()
  await life.disposed
  expect(drained).toBe(false)
  finish()
  await actual
  await life.hostDrained
  expect(life.activity).toEqual({ hostCalls: 0, draining: 0 })
})
