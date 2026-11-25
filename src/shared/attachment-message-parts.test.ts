import { describe, expect, it } from "vitest"
import { buildAttachmentMessageParts, chatAttachmentBudgetError } from "./attachment-message-parts"

const document = (n: number) => ({
  filename: "report<.html", filePath: "/docs/report<.html", content: "中".repeat(n),
  mimeType: "text/html", size: n * 3, truncated: true
})

describe("ordinary submission attachment budgets", () => {
  it("counts complete legacy document bodies and declared images across a single turn", () => {
    const message = (sizes: number[]) =>
      buildAttachmentMessageParts(sizes.map(document)).attachmentModelBlocks
    expect(chatAttachmentBudgetError(message([12_000, 12_000]), 1)).toBeUndefined()
    expect(chatAttachmentBudgetError(message([12_001, 12_000]), 1)).toContain("24,000")
    expect(chatAttachmentBudgetError(message([3, 3]), 2)).toContain("3")
    expect(chatAttachmentBudgetError(message([0, 0, 0, 0]))).toContain("3")
    expect(chatAttachmentBudgetError("普通提问".repeat(10_000))).toBeUndefined()
  })
})
