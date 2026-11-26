import type { FileAttachment, SubmittedChatImage } from "./file-attachment"
import { submittedAttachmentImages, MAX_ATTACHMENT_PICKER_FILES, MAX_ATTACHMENT_TOTAL_CHARS } from "./file-attachment"

const escXml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

export function chatImageMarker(image: Pick<SubmittedChatImage, "filename" | "slot">) {
  return `<attachment filename="${escXml(image.filename)}" media="image" slot="${image.slot}" />`
}

/** Count the legacy document envelopes, skipping their opaque contents. Images use their sidecar. */
export function chatAttachmentBudgetError(message: string, images: number | readonly SubmittedChatImage[] = 0): string | undefined {
  if (typeof images !== "number" && (!Array.isArray(images) || images.length > MAX_ATTACHMENT_PICKER_FILES ||
      images.some(image => !image || typeof image.filename !== "string" || image.filename.length > 512 ||
        !Number.isInteger(image.slot)))) return "图片引用无效"
  const markers = new Set(typeof images === "number" ? [] : images.map(image => "\n" + chatImageMarker(image)))
  let files = typeof images === "number" ? images : images.length
  let chars = 0
  const opener = /<attachment filename="[^"]*"(?: input_id="[^"]*")?(?: path="[^"]*")? type="[^"]*" size="\d+"(?: truncated="true")?>\n/g
  const closing = "\n</attachment>"
  let match = opener.exec(message)
  while (match) {
    const end = message.indexOf(closing, opener.lastIndex)
    if (end < 0) break
    files++
    let content = message.slice(opener.lastIndex, end)
    for (const marker of markers) {
      if (!content.includes(marker)) continue
      content = content.replace(marker, "")
      markers.delete(marker)
      files--
    }
    chars += content.length
    opener.lastIndex = end + closing.length
    match = opener.exec(message)
  }
  if (files > MAX_ATTACHMENT_PICKER_FILES) return "每条消息最多添加 3 个附件"
  if (chars > MAX_ATTACHMENT_TOTAL_CHARS) return "附件文本合计超过 24,000 字符"
  return undefined
}

/** Extracted from the original composer; queued, private and group sends share the same wire format. */
export function buildAttachmentMessageParts(attachments: readonly FileAttachment[], forBot = false): {
  attachmentModelBlocks: string
  attachmentDisplayPrefix: string
} {
  const refs = forBot ? [] : submittedAttachmentImages(attachments)
  let imageIndex = 0
  return {
    attachmentModelBlocks: attachments
      .map(att => {
        if (att.image && !forBot) return "\n\n" + chatImageMarker(refs[imageIndex++])
        const imageBlocks = forBot ? "" : (att.embeddedImages ?? []).map(() =>
          "\n" + chatImageMarker(refs[imageIndex++])).join("")
        const originalUnavailable = forBot && att.originalUnavailable && !att.botInputId
        const truncAttr = att.truncated ? ' truncated="true"' : ""
        const pathAttr = !originalUnavailable && att.filePath ? ` path="${escXml(att.filePath)}"` : ""
        const inputAttr = att.botInputId ? ` input_id="${escXml(att.botInputId)}"` : ""
        const notice = originalUnavailable ? "Only extracted text is available. The original file version was not retained.\n\n" : ""
        const safeContent = att.content.replace(/<\/attachment>/gi, "< /attachment>")
        return `\n\n<attachment filename="${escXml(att.filename)}"${inputAttr}${pathAttr} type="${att.mimeType}" size="${att.size}"${truncAttr}>\n${notice}${safeContent}${imageBlocks}\n</attachment>`
      })
      .join(""),
    attachmentDisplayPrefix: attachments.map((att) => `📎 ${att.filename}`).join("\n")
  }
}
