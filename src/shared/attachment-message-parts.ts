import type { FileAttachment, SubmittedChatImage } from "./file-attachment"
import { MAX_ATTACHMENT_PICKER_FILES, MAX_ATTACHMENT_TOTAL_CHARS } from "./file-attachment"

const escXml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

export function chatImageMarker(image: Pick<SubmittedChatImage, "filename" | "slot">) {
  return `<attachment filename="${escXml(image.filename)}" media="image" slot="${image.slot}" />`
}

/** Count the legacy document envelopes, skipping their opaque contents. Images use their sidecar. */
export function chatAttachmentBudgetError(message: string, imageCount = 0): string | undefined {
  let files = imageCount
  let chars = 0
  const opener = /<attachment filename="[^"]*"(?: input_id="[^"]*")?(?: path="[^"]*")? type="[^"]*" size="\d+"(?: truncated="true")?>\n/g
  const closing = "\n</attachment>"
  let match = opener.exec(message)
  while (match) {
    const end = message.indexOf(closing, opener.lastIndex)
    if (end < 0) break
    files++
    chars += end - opener.lastIndex
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
  return {
    attachmentModelBlocks: attachments
      .map((att, slot) => {
        if (att.image && !forBot) return "\n\n" + chatImageMarker({ filename: att.filename, slot })
        const originalUnavailable = forBot && att.originalUnavailable && !att.botInputId
        const truncAttr = att.truncated ? ' truncated="true"' : ""
        const pathAttr = !originalUnavailable && att.filePath ? ` path="${escXml(att.filePath)}"` : ""
        const inputAttr = att.botInputId ? ` input_id="${escXml(att.botInputId)}"` : ""
        const notice = originalUnavailable ? "Only extracted text is available. The original file version was not retained.\n\n" : ""
        const safeContent = att.content.replace(/<\/attachment>/gi, "< /attachment>")
        return `\n\n<attachment filename="${escXml(att.filename)}"${inputAttr}${pathAttr} type="${att.mimeType}" size="${att.size}"${truncAttr}>\n${notice}${safeContent}\n</attachment>`
      })
      .join(""),
    attachmentDisplayPrefix: attachments.map((att) => `📎 ${att.filename}`).join("\n")
  }
}
