import type { FileAttachment } from "./file-attachment"

const escXml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

/** Extracted from the original composer; queued, private and group sends share the same wire format. */
export function buildAttachmentMessageParts(attachments: readonly FileAttachment[]): {
  attachmentModelBlocks: string
  attachmentDisplayPrefix: string
} {
  return {
    attachmentModelBlocks: attachments
      .map((att) => {
        const truncAttr = att.truncated ? ' truncated="true"' : ""
        const pathAttr = att.filePath ? ` path="${escXml(att.filePath)}"` : ""
        const safeContent = att.content.replace(/<\/attachment>/gi, "< /attachment>")
        return `\n\n<attachment filename="${escXml(att.filename)}"${pathAttr} type="${att.mimeType}" size="${att.size}"${truncAttr}>\n${safeContent}\n</attachment>`
      })
      .join(""),
    attachmentDisplayPrefix: attachments.map((att) => `📎 ${att.filename}`).join("\n")
  }
}
