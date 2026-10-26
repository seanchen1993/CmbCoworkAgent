import { afterEach, expect, it, vi } from "vitest"
const control = vi.hoisted(() => ({ invoke: vi.fn(), stop: vi.fn(), load: vi.fn() }))
vi.mock("./runtime-client", () => ({
  ModRuntimeClient: class {
    version = 0
    load(...args: unknown[]) {
      return control.load(...args)
    }
    invoke(...args: unknown[]) {
      return control.invoke(...args)
    }
    stop() {
      control.stop()
    }
  }
}))
import { ManagedModPolicy } from "./policy"
const identity = {
  workspace: "workspace",
  threadId: "thread",
  turnId: "turn",
  agentId: "main",
  callId: "policy",
  origin: "mod" as const,
  grantEpoch: 1
}
afterEach(() => vi.resetAllMocks())

it("cancels queued policy promptly without releasing an active predecessor or invoking the worker", async () => {
  const policy = new ManagedModPolicy()
  let release!: (value: { allow: boolean }) => void
  let entered!: () => void
  const active = new Promise<void>((resolve) => {
    entered = resolve
  })
  control.load.mockResolvedValue([])
  control.invoke
    .mockImplementationOnce(() => {
      entered()
      return new Promise((resolve) => {
        release = resolve
      })
    })
    .mockResolvedValue({ allow: true })
  const first = policy.admit(identity, "first", {})
  await active
  const controller = new AbortController()
  const phases: string[] = []
  const cancelled = policy.admit(identity, "cancelled", {}, controller.signal, (phase) =>
    phases.push(phase)
  )
  const rejected = expect(cancelled).rejects.toThrow("MODS_CANCELLED")
  const finalPhases: string[] = []
  const last = policy.admit(identity, "last", {}, undefined, (phase) => finalPhases.push(phase))
  controller.abort()
  await rejected
  expect(phases).toEqual(["queued"])
  expect(finalPhases).toEqual(["queued"])
  expect(control.invoke).toHaveBeenCalledOnce()
  expect(control.stop).not.toHaveBeenCalled()
  release({ allow: true })
  await Promise.all([first, last])
  expect(control.invoke.mock.calls.map((call) => call[2].toolId)).toEqual(["first", "last"])
  expect(finalPhases).toEqual(["queued", "entered", "allowed"])
  policy.stop()
})

it("does not poison worker generation when an already-aborted admission arrives", async () => {
  const policy = new ManagedModPolicy()
  control.load.mockResolvedValue([])
  control.invoke.mockResolvedValue({ allow: true })
  await expect(policy.admit(identity, "cancelled", {}, AbortSignal.abort())).rejects.toThrow(
    "MODS_CANCELLED"
  )
  expect(control.load).not.toHaveBeenCalled()
  expect(control.stop).not.toHaveBeenCalled()
  await policy.admit(identity, "after", {})
  expect(control.invoke).toHaveBeenCalledOnce()
  policy.stop()
})
