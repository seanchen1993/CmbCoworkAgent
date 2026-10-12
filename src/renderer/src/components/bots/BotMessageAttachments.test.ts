import { describe, expect, it, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { createElement } from "react"
import type { BotMessage } from "../../../../shared/bot-types"
import { BotMessageAttachments } from "./BotMessageAttachments"

vi.mock("./BotPeerImages", () => ({
  BotPeerImages: ({ images }: { images: { id: string; name: string }[] }) =>
    createElement(
      "div",
      { "data-gallery-ids": images.map((image) => image.id).join(",") },
      images.map((image) => image.name).join(",")
    )
}))
const base: BotMessage = {
  id: "message",
  conversationId: "conversation",
  sequence: 1,
  sender: "user",
  botId: null,
  text: "检查附件",
  runId: null,
  replyTo: null,
  createdAt: 123,
  attachments: []
}
const identity = {
  conversationId: base.conversationId,
  runId: null,
  size: 279,
  sha256: "a".repeat(64),
  createdAt: 123,
  origin: "upload" as const
}
function render(message: BotMessage, saveFile?: () => void) {
  return renderToStaticMarkup(
    createElement(BotMessageAttachments, {
      message,
      openImage: () => {},
      openFile: () => {},
      saveFile
    })
  )
}
describe("uploaded message attachment cards", () => {
  it("renders real names, sizes and provenance instead of generic attachment numbers", () => {
    const html = render({
      ...base,
      attachments: ["csv", "image"],
      attachmentFiles: [
        { ...identity, id: "csv", name: "project-records.csv", mime: "text/csv" },
        { ...identity, id: "image", name: "sample.png", mime: "image/png" }
      ]
    })
    expect(html).toContain("project-records.csv")
    expect(html).toContain("279 B")
    expect(html).toContain("用户上传")
    expect(html).toContain('data-gallery-ids="image"')
    expect(html).not.toContain("附件 1")
    expect(html).toContain("data-bot-quote-ignore")
  })
  it("renders removed files as unavailable and retains old Host fallback", () => {
    expect(render({ ...base, attachments: ["deleted"], attachmentFiles: [] })).toContain("disabled")
    expect(render({ ...base, attachments: ["deleted"], attachmentFiles: [] })).toContain(
      "已删除或不可用"
    )
    expect(render({ ...base, attachments: ["legacy"] })).toContain("附件 1")
  })
  it("offers a separate native-save action only for an available file and supported caller", () => {
    const message = {
      ...base,
      attachments: ["csv"],
      attachmentFiles: [{ ...identity, id: "csv", name: "result.csv", mime: "text/csv" }]
    }
    expect(render(message)).not.toContain('aria-label="保存 result.csv"')
    const html = render(message, () => {})
    expect(html).toContain('aria-label="查看附件 result.csv"')
    expect(html).toContain('aria-label="保存 result.csv"')
    expect(html).not.toMatch(/<button[^>]*>(?:(?!<\/button>).)*<button/s)
    expect(render({ ...message, attachmentFiles: [] }, () => {})).not.toContain('aria-label="保存')
  })
})
