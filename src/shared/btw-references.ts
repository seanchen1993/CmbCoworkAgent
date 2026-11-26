import { cleanUserAttachmentContentForDisplay } from "./user-attachment-display"

const marker = "# userselect:\n```userselect\n"
const end = "\n```"

export function appendBtwReferences(text: string, refs: readonly { text: string }[]): string {
  if (!refs.length) return text
  return [text, marker + JSON.stringify(refs.map(r => ({ text: r.text }))) + end].filter(Boolean).join("\n\n")
}

export function readBtwReferences(text: string): { body: string; quotes: string[] } {
  let start = text.lastIndexOf(marker)
  if (start < 0) return { body: text, quotes: [] }
  // Durable model messages can carry attachment XML after the selection block.
  const original = text
  if (!text.endsWith(end) && text.includes("<attachment ", start + marker.length)) {
    text = cleanUserAttachmentContentForDisplay(text)
    start = text.lastIndexOf(marker)
  }
  if (start >= 0 && (!start || text.slice(start - 2, start) === "\n\n") && text.endsWith(end)) {
    try {
      const items: unknown = JSON.parse(text.slice(start + marker.length, -end.length))
      if (Array.isArray(items) && items.length > 0 && items.length <= 8 && items.every(item => item && typeof item.text === "string")) {
        return { body: text.slice(0, Math.max(0, start - 2)), quotes: items.map(item => item.text) }
      }
    } catch { /* User-authored text that resembles a reference remains visible. */ }
  }
  return { body: original, quotes: [] }
}
