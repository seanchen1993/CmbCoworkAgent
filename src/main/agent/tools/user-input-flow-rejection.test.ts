import { beforeEach, expect, it, vi } from "vitest"
import { createRequestUserInputTool } from "./user-input-tool"
import { requestUserInput, UserInputRequestRejectedError } from "../../services/user-input"

vi.mock("../../services/user-input", () => ({
  requestUserInput: vi.fn(),
  UserInputRequestRejectedError: class extends Error {
    constructor(
      readonly code: string,
      message: string
    ) {
      super(message)
    }
  }
}))
const input = {
  questions: [
    {
      id: "choice",
      header: "Choice",
      question: "Select",
      options: [
        { label: "Yes", description: "Continue" },
        { label: "No", description: "Stop" }
      ]
    }
  ]
}
beforeEach(() => vi.clearAllMocks())

it.each([
  [new UserInputRequestRejectedError("REJECTED", "refused"), "user-input-rejected", "rejected"],
  [Error("cancelled"), "user-input-cancelled", "cancelled"]
] as const)("native flow receives host rejection %s", async (failure, reason, status) => {
  vi.mocked(requestUserInput).mockRejectedValue(failure)
  const controller = new AbortController()
  const rejected = vi.fn(() => controller.abort(Error("flow terminated")))
  const tool = createRequestUserInputTool({
    threadId: "thread",
    abortSignal: controller.signal,
    onRejected: rejected
  })
  const result = JSON.parse(await tool.invoke(input))
  expect(result.status).toBe(status)
  expect(rejected).toHaveBeenCalledExactlyOnceWith(reason)
  expect(controller.signal.aborted).toBe(true)
})
it("ordinary tool calls retain their prior cancelled-result behavior without a flow callback", async () => {
  vi.mocked(requestUserInput).mockRejectedValue(Error("cancelled"))
  const result = JSON.parse(await createRequestUserInputTool({ threadId: "thread" }).invoke(input))
  expect(result).toMatchObject({ status: "cancelled", error: "cancelled" })
})
