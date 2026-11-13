import { beforeEach, expect, it, vi } from "vitest"
import type { AutobizCommitInput } from "./autobiz-state-commit"

const native = vi.hoisted(() => ({ validate: vi.fn(), inspect: vi.fn(), transition: vi.fn() }))
vi.mock("./autobiz-validation", () => ({
  runAutobizValidator: native.validate,
  advanceAutobizCheckpoint: native.transition
}))
vi.mock("./autobiz-recovery", () => ({ inspectAutobizRecovery: native.inspect }))
import {
  inspectAutobizCompletionRecovery,
  transitionAutobizCompletion,
  validateAutobizCompletion
} from "./autobiz-completion-adapter"

beforeEach(() => {
  vi.resetAllMocks()
})

it("keeps named validator arguments, the original signal and guards around actual completion", async () => {
  const signal = new AbortController().signal,
    order: string[] = []
  const result = { passed: true }
  const assertCurrent = () => {
    order.push("guard")
  }
  native.validate.mockImplementation(async () => {
    order.push("validate")
    return result
  })
  expect(
    await validateAutobizCompletion({
      workspace: "/workspace",
      feature: "feature",
      stageStart: "start",
      timeoutMs: 1234,
      signal,
      assertCurrent
    })
  ).toBe(result)
  expect(native.validate).toHaveBeenCalledExactlyOnceWith(
    "/workspace",
    "feature",
    signal,
    1234,
    "start"
  )
  expect(order).toEqual(["guard", "validate", "guard"])
})

it("waits for a real ignored-abort validator before rejecting cancellation", async () => {
  const controller = new AbortController(),
    reason = Error("original run cancelled")
  let finish!: (value: object) => void
  native.validate.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve
    })
  )
  const task = validateAutobizCompletion({
    workspace: "/workspace",
    timeoutMs: 1234,
    signal: controller.signal,
    assertCurrent: () => {}
  })
  let settled = false
  void task.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    }
  )
  controller.abort(reason)
  await Promise.resolve()
  expect(settled).toBe(false)
  finish({ passed: true })
  await expect(task).rejects.toBe(reason)
  expect(native.validate).toHaveBeenCalledTimes(1)
})

it("does not publish a validator result after the original authority changes", async () => {
  const changed = Error("original authority retired")
  let live = true
  native.validate.mockImplementation(async () => {
    live = false
    return { passed: true }
  })
  await expect(
    validateAutobizCompletion({
      workspace: "/workspace",
      timeoutMs: 1234,
      signal: new AbortController().signal,
      assertCurrent: () => {
        if (!live) throw changed
      }
    })
  ).rejects.toBe(changed)
  expect(native.validate).toHaveBeenCalledTimes(1)
})

it("passes the original recovery guard and rejects a late revoked inspection", async () => {
  const changed = Error("original inspection retired")
  let live = true
  const assertCurrent = () => {
    if (!live) throw changed
  }
  native.inspect.mockImplementation(async () => {
    live = false
    return { state: "after" }
  })
  await expect(
    inspectAutobizCompletionRecovery({
      workspace: "/workspace",
      operationId: "native-operation",
      assertCurrent
    })
  ).rejects.toBe(changed)
  expect(native.inspect).toHaveBeenCalledExactlyOnceWith(
    "/workspace",
    "native-operation",
    assertCurrent
  )
})

it("returns the exact transition promise and evidence closure, including unknown outcomes", async () => {
  const verifyEvidence = vi.fn(async () => {})
  const input: AutobizCommitInput = {
    workspace: "/workspace",
    feature: "feature",
    from: "start",
    to: "end",
    expectedStateFingerprint: "fingerprint",
    idempotencyKey: "original-id",
    requireCommittedReceipt: true,
    signal: new AbortController().signal,
    verifyEvidence
  }
  const outcome = { applied: false, duplicate: false, status: "unknown" }
  const actual = Promise.resolve(outcome)
  native.transition.mockReturnValue(actual)
  const received = transitionAutobizCompletion(input)
  expect(received).toBe(actual)
  expect(native.transition).toHaveBeenCalledExactlyOnceWith(input)
  expect(native.transition.mock.calls[0][0]).toBe(input)
  expect(native.transition.mock.calls[0][0].verifyEvidence).toBe(verifyEvidence)
  expect(verifyEvidence).not.toHaveBeenCalled()
  expect(await received).toBe(outcome)
  expect(native.transition).toHaveBeenCalledTimes(1)
})

it("propagates original errors without retrying or reconstructing committed work", async () => {
  const original = Error("original native failure")
  native.validate.mockRejectedValue(original)
  native.inspect.mockRejectedValue(original)
  native.transition.mockRejectedValue(original)
  await expect(
    validateAutobizCompletion({
      workspace: "/workspace",
      timeoutMs: 1234,
      signal: new AbortController().signal,
      assertCurrent: () => {}
    })
  ).rejects.toBe(original)
  await expect(
    inspectAutobizCompletionRecovery({
      workspace: "/workspace",
      operationId: "operation",
      assertCurrent: () => {}
    })
  ).rejects.toBe(original)
  await expect(
    transitionAutobizCompletion({
      workspace: "/workspace",
      feature: "feature",
      from: "start",
      to: "end",
      expectedStateFingerprint: "fingerprint",
      idempotencyKey: "id"
    })
  ).rejects.toBe(original)
  expect(native.validate).toHaveBeenCalledTimes(1)
  expect(native.inspect).toHaveBeenCalledTimes(1)
  expect(native.transition).toHaveBeenCalledTimes(1)
})
