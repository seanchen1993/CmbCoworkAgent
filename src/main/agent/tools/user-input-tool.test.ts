import { beforeEach, describe, expect, it, vi } from "vitest"

const fixture = vi.hoisted(() => ({
  request: vi.fn<typeof import("../../services/user-input").requestUserInput>()
}))
vi.mock("../../services/user-input", () => ({
  requestUserInput: fixture.request,
  UserInputRequestRejectedError: class extends Error {}
}))
import { createRequestUserInputTool } from "./user-input-tool"

beforeEach(() => {
  fixture.request.mockReset().mockResolvedValue({
    requestId: "pending",
    ignored: true,
    answers: {},
    submittedAt: "2026-10-18T00:00:00.000Z"
  })
})

describe("Original user-input option normalization", () => {
  it.each([true, false])(
    "keeps filtering and ignored receipts with auto resolution %s",
    async (allowAutoResolution) => {
      const options = ["其他", "完整报告", "只看合计", "我来补充", "以上都不是"].map((label) => ({
        label,
        description: "合成说明"
      }))
      const question = { id: "format", header: "格式", question: "需要哪种格式？", options }
      const result = await createRequestUserInputTool({
        threadId: "original-thread",
        requestUserInputConfig: { allowAutoResolution, autoResolutionType: "user_message" }
      }).invoke({ questions: [question] })
      expect(fixture.request).toHaveBeenCalledOnce()
      expect(fixture.request.mock.calls[0][0].questions).toEqual([
        { ...question, options: options.slice(1, 3) }
      ])
      expect(options).toHaveLength(5)
      if (typeof result !== "string") throw new Error("Expected the original string receipt")
      expect(JSON.parse(result)).toMatchObject({ status: "ignored", answers: {} })
    }
  )
})
