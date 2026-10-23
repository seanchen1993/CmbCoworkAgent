import { beforeEach, expect, it, vi } from "vitest"
const request = vi.hoisted(() => vi.fn())
vi.mock("../../services/user-input", () => ({
  requestUserInput: request,
  UserInputRequestRejectedError: class extends Error {
    code = "NO_RENDERER"
  }
}))
import { functionUserInputInvoker } from "./native-user-input"
import { functionAskInput } from "./ui-ask"

beforeEach(() => request.mockReset())
it("reuses native validation, wait hooks and host thread while refusing deferred rendering", async () => {
  request.mockResolvedValue({
    requestId: "request",
    submittedAt: 1,
    answers: { mod_question: { type: "option", label: "Yes" } }
  })
  const hooks = { onWaitStart: vi.fn(), onWaitEnd: vi.fn() }
  const invoke = functionUserInputInvoker({
    threadId: "host-thread",
    allowDeferredRenderer: true,
    interactionWaitHooks: hooks
  })
  const signal = new AbortController().signal
  const { questions } = functionAskInput(["Continue?"])
  const result = JSON.parse(await invoke({ questions }, signal))
  expect(result.status).toBe("submitted")
  expect(request).toHaveBeenCalledWith(
    expect.objectContaining({
      threadId: "host-thread",
      questions,
      allowDeferredRenderer: false,
      abortSignal: signal
    })
  )
  expect(hooks.onWaitStart).toHaveBeenCalledTimes(1)
  expect(hooks.onWaitEnd).toHaveBeenCalledTimes(1)
  await expect(invoke({ questions: [] }, signal)).rejects.toThrow()
  expect(request).toHaveBeenCalledTimes(1)
})
it("rejects late native replies after operation cancellation and releases the still-live run wait", async () => {
  const controller = new AbortController()
  const hooks = { onWaitStart: vi.fn(), onWaitEnd: vi.fn() }
  request.mockImplementation(async () => {
    controller.abort()
    return { requestId: "r", answers: {} }
  })
  const { questions } = functionAskInput(["Continue?"])
  await expect(
    functionUserInputInvoker({ threadId: "thread", interactionWaitHooks: hooks })(
      { questions },
      controller.signal
    )
  ).rejects.toThrow()
  expect(hooks.onWaitStart).toHaveBeenCalledTimes(1)
  expect(hooks.onWaitEnd).toHaveBeenCalledTimes(1)
})

it("does not resume an aborted native run when its independent operation is still live", async () => {
  const run = new AbortController()
  const operation = new AbortController()
  const hooks = { onWaitStart: vi.fn(), onWaitEnd: vi.fn() }
  request.mockImplementation(async () => {
    run.abort(Error("Native run stopped"))
    return { requestId: "r", answers: {} }
  })
  const { questions } = functionAskInput(["Continue?"])
  await expect(
    functionUserInputInvoker({
      threadId: "thread",
      abortSignal: run.signal,
      interactionWaitHooks: hooks
    })({ questions }, operation.signal)
  ).rejects.toThrow("Native run stopped")
  expect(operation.signal.aborted).toBe(false)
  expect(hooks.onWaitStart).toHaveBeenCalledTimes(1)
  expect(hooks.onWaitEnd).not.toHaveBeenCalled()
})
