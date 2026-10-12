// Grok 0.18 suggestion matching; type-only Tiptap dependency replaced by a structural text position.
const SUGGESTION_CONTEXT_LIMIT = 200
const SUGGESTION_QUERY_LIMIT = 50
const SUGGESTION_PUNCTUATION = String.raw`,\+\*\?\$\@\|#{}\(\)\^\-\[\]\\!%'"~=<>:;`

function escapeSuggestionChar(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export function findSpaceSuggestionMatch({
  char,
  $position
}: {
  char: string
  $position: {
    pos: number
    nodeBefore?: { isText: boolean; text: string }
    nodeAfter?: { isText: boolean; text: string }
  }
}): { range: { from: number; to: number }; query: string; text: string } | null {
  const position = $position.pos
  const before = $position.nodeBefore?.isText ? $position.nodeBefore.text : undefined
  if (!before) return null
  const context =
    before.length > SUGGESTION_CONTEXT_LIMIT ? before.slice(-SUGGESTION_CONTEXT_LIMIT) : before
  const contextStart = position - context.length
  const after = $position.nodeAfter?.isText ? ($position.nodeAfter.text ?? "") : ""
  const continuationEnd = after.search(/\s/)
  const continuation = continuationEnd === -1 ? after : after.slice(0, continuationEnd)
  const searchable = context + continuation
  const escapedChar = escapeSuggestionChar(char)
  const token = `[^${escapedChar}${SUGGESTION_PUNCTUATION}\\s]`
  const boundary = `(?:\\.[ |$]| |[${SUGGESTION_PUNCTUATION}/]|)`
  const multiWord = new RegExp(`(^|\\s|\\()(${escapedChar}((?:${token}${boundary}){0,120}))$`)
  const singleWord = new RegExp(
    `(^|\\s|\\()(${escapedChar}((?:${token}){0,${SUGGESTION_QUERY_LIMIT}}))$`
  )
  const match = multiWord.exec(searchable) ?? singleWord.exec(searchable)
  if (match == null || match.index == null) return null
  const leadOffset = match.index + match[1]!.length
  const from = contextStart + leadOffset
  const to = from + match[2]!.length
  if (from >= position || to < position || match[3]!.length > SUGGESTION_QUERY_LIMIT) return null
  return { range: { from, to }, query: match[3]!, text: match[2]! }
}
