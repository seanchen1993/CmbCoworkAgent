function decodeAttachmentFilename(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
}

/** Project the transport payload in a user message to the text mounted by the chat bubble. */
export function cleanUserAttachmentContentForDisplay(content: string): string {
  if (!content.includes("<attachment ")) return content

  const fileNames: string[] = []
  const textOnly = content
    .replace(
      /<attachment\s+filename="([^"]*)"[^>]*>[\s\S]*?<\/attachment>/g,
      (_match, encodedName: string) => {
        fileNames.push(`📎 ${decodeAttachmentFilename(encodedName)}`)
        return ""
      }
    )
    .trim()

  return fileNames.length > 0 ? `${fileNames.join("\n")}\n\n${textOnly}`.trim() : textOnly
}
