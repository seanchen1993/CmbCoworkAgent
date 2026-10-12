import { describe, expect, it } from "vitest"
import {
  botMessageAttachmentPresentation,
  sameBotMessageAttachment,
  type BotMessageAttachment
} from "./bot-message-attachments"

function file(id: string, name: string, mime: string): BotMessageAttachment {
  return {
    id,
    name,
    mime,
    conversationId: "conversation",
    runId: null,
    size: 279,
    sha256: "a".repeat(64),
    createdAt: 123,
    origin: "upload"
  }
}
describe("immutable uploaded message media", () => {
  it("turns real uploaded raster descriptors into the existing gallery contract and keeps named files", () => {
    const image = file("image", "sample.png", "image/png")
    const csv = file("csv", "project-records.csv", "text/csv")
    const view = botMessageAttachmentPresentation({
      conversationId: "conversation",
      attachments: [image.id, csv.id],
      attachmentFiles: [image, csv]
    })
    expect(view.imageGroups).toEqual([
      [
        {
          id: image.id,
          sourceId: image.id,
          sourceConversationId: "conversation",
          name: image.name,
          mime: image.mime,
          size: image.size,
          sha256: image.sha256
        }
      ]
    ])
    expect(view.files).toEqual([{ id: csv.id, artifact: csv, unavailable: false }])
  })
  it("does not display unrelated metadata, execute SVG or duplicate already published images", () => {
    const image = file("image", "sample.png", "image/png")
    const svg = file("svg", "drawing.svg", "image/svg+xml")
    const foreign = { ...file("foreign", "secret.png", "image/png"), conversationId: "other" }
    const published = {
      id: image.id,
      sourceId: image.id,
      sourceConversationId: "conversation",
      name: image.name,
      mime: image.mime,
      size: image.size,
      sha256: image.sha256
    }
    const view = botMessageAttachmentPresentation({
      conversationId: "conversation",
      attachments: [image.id, svg.id, foreign.id],
      attachmentFiles: [image, svg, foreign],
      images: [published]
    })
    expect(view.imageGroups).toEqual([[published]])
    expect(view.files).toEqual([
      { id: svg.id, artifact: svg, unavailable: false },
      { id: foreign.id, artifact: undefined, unavailable: true }
    ])
  })
  it("preserves old Host links without inventing metadata and rejects mismatched preview identities", () => {
    expect(
      botMessageAttachmentPresentation({ conversationId: "conversation", attachments: ["old"] })
        .files
    ).toEqual([{ id: "old", artifact: undefined, unavailable: false }])
    const original = file("original", "文件.csv", "text/csv")
    expect(sameBotMessageAttachment(original, original)).toBe(true)
    for (const changed of [
      { sha256: "b".repeat(64) },
      { name: "另一文件.csv" },
      { size: 280 },
      { conversationId: "other" },
      { id: "other" },
      { runId: "another-run" }
    ])
      expect(sameBotMessageAttachment({ ...original, ...changed }, original)).toBe(false)
  })
  it("shows all historical bounded images through six-image gallery groups", () => {
    const images = Array.from({ length: 8 }, (_, index) =>
      file(`image-${index}`, `${index}.png`, "image/png")
    )
    const view = botMessageAttachmentPresentation({
      conversationId: "conversation",
      attachments: images.map((image) => image.id),
      attachmentFiles: images
    })
    expect(view.imageGroups.map((group) => group.length)).toEqual([6, 2])
    expect(view.files).toEqual([])
  })
})
