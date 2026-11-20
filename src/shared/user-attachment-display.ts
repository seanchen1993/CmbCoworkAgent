function decodeAttachmentFilename(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
}

/** Project the transport payload in a user message to the text mounted by the chat bubble. */
export function projectUserAttachmentContent(content: string): {
  text: string
  incomplete: boolean
} {
  if (!content.includes("<attachment ")) return { text: content, incomplete: false }

  const fileNames: string[] = []
  let incomplete = false
  const opener = /<attachment\s+filename="([^"]*)"/g
  const close = "</attachment>"
  const textParts: string[] = []
  const lastTagEnd = content.lastIndexOf(">")
  let end = 0
  let match: RegExpExecArray | null
  while ((match = opener.exec(content))) {
    if (opener.lastIndex > lastTagEnd) break
    const openingEnd = content.indexOf(">", opener.lastIndex)
    let lastAttribute = openingEnd - 1
    while (lastAttribute >= opener.lastIndex && /\s/.test(content[lastAttribute])) lastAttribute -= 1
    const selfClosing = lastAttribute >= opener.lastIndex && content[lastAttribute] === "/"
    const closingStart = selfClosing ? -1 : content.indexOf(close, openingEnd + 1)
    fileNames.push(`📎 ${decodeAttachmentFilename(match[1])}`)
    textParts.push(content.slice(end, match.index))
    incomplete = !selfClosing && closingStart < 0
    end = selfClosing ? openingEnd + 1 : incomplete ? content.length : closingStart + close.length
    opener.lastIndex = end
  }
  textParts.push(content.slice(end))
  const textOnly = textParts.join("").trim()

  return {
    text: fileNames.length > 0 ? `${fileNames.join("\n")}\n\n${textOnly}`.trim() : textOnly,
    incomplete
  }
}

export function cleanUserAttachmentContentForDisplay(content: string): string {
  return projectUserAttachmentContent(content).text
}
