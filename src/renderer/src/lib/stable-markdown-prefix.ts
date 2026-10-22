const MIN_PREFIX_CHARACTERS = 2048

/**
 * Only a leading, explicitly closed fenced code block is independent of future
 * references, lists, tables and HTML. Require the closing line and one complete
 * blank line, so an appended token cannot turn a provisional fence into content.
 * This is deliberately not a general incremental Markdown parser.
 */
export function stableMarkdownPrefixLength(text: string): number {
  const opening = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)\r?\n/.exec(text)
  if (!opening || (opening[1][0] === "`" && opening[2].includes("`"))) return 0
  const marker = opening[1][0]
  let start = opening[0].length
  while (start < text.length) {
    const end = text.indexOf("\n", start)
    if (end < 0) return 0
    const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*\r?$/.exec(text.slice(start, end))
    if (closing && closing[1][0] === marker && closing[1].length >= opening[1].length) {
      const blank = /^[ \t]*\r?\n/.exec(text.slice(end + 1))
      if (!blank) return 0
      const length = end + 1 + blank[0].length
      return length >= MIN_PREFIX_CHARACTERS ? length : 0
    }
    start = end + 1
  }
  return 0
}
