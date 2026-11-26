import { submittedAttachmentImages } from "./file-attachment"
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


it("counts a visual document as one attachment and locates each trusted image", () => {
  const ref = (id: string, filename: string) => ({ id, filename, width: 12, height: 6 })
  const document = { filename: "report.docx", filePath: "report.docx", mimeType: "application/docx",
    size: 4, content: "Row A 【图 1】 and Row B 【图 2】", truncated: false,
    embeddedImages: [ref("a", "report.docx · 图 1"), ref("b", "report.docx · 图 2")] }
  const picture = { ...document, filename: "photo.png", content: "", embeddedImages: undefined,
    image: ref("c", "photo.png") }
  const files = [document, picture]
  const refs = submittedAttachmentImages(files)
  const { attachmentModelBlocks } = buildAttachmentMessageParts(files)
  expect(refs.map(item => item.slot)).toEqual([0, 1, 2])
  expect(attachmentModelBlocks).toMatch(/slot="0"[\s\S]*slot="1"[^\n]*\n<\/attachment>[\s\S]*slot="2"/)
  expect(chatAttachmentBudgetError(attachmentModelBlocks, refs)).toBeUndefined()
  expect(chatAttachmentBudgetError(attachmentModelBlocks, [null] as never)).toBe("图片引用无效")
})
