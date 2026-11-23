import type { FileAttachment } from "./file-attachment"

const escXml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

/** Extracted from the original composer; queued, private and group sends share the same wire format. */
export function buildAttachmentMessageParts(attachments: readonly FileAttachment[], forBot = false): {
  attachmentModelBlocks: string
  attachmentDisplayPrefix: string
} {
  return {
    attachmentModelBlocks: attachments
      .map((att) => {
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
