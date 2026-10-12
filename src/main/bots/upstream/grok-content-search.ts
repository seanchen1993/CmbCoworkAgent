// Extracted unchanged from Grok Bot 0.18; see PROVENANCE.json.
const SNIPPET_LEAD = 30,
  SNIPPET_TRAIL = 60,
  ELLIPSIS = "…"
export function buildContentSnippet(text: string, normalizedQuery: string): string | null {
  if (normalizedQuery.length === 0) return null
  const flat = text.replace(/\s+/g, " ").trim(),
    index = flat.toLowerCase().indexOf(normalizedQuery)
  if (index < 0) return null
  const start = Math.max(0, index - SNIPPET_LEAD),
    end = Math.min(flat.length, index + normalizedQuery.length + SNIPPET_TRAIL)
  return `${start > 0 ? ELLIPSIS : ""}${flat.slice(start, end)}${end < flat.length ? ELLIPSIS : ""}`
}
