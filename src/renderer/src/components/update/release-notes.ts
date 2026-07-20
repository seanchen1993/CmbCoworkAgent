const INLINE_OR_FENCED_CODE_PATTERN = /(`+)[\s\S]*?\1/g

// A literal `\n` is ambiguous inside a Windows path. Protect common drive and
// UNC paths before decoding escaped line breaks. The boundary lookahead stops
// a path before Markdown list/heading markers or Chinese text on the next line.
const ESCAPED_BREAK_BOUNDARY = String.raw`[rn](?=\s*(?:\\[rn]|[-*+#>]|\d+[.)]|[A-Z]|\p{Script=Han}))`
const DRIVE_PATH_PATTERN = new RegExp(
  String.raw`[A-Za-z]:(?:\\(?!${ESCAPED_BREAK_BOUNDARY})[^\s\\\x60]+)+`,
  "gu"
)
const UNC_PATH_PATTERN = new RegExp(
  String.raw`\\\\[^\s\\\x60]+(?:\\(?!${ESCAPED_BREAK_BOUNDARY})[^\s\\\x60]+)+`,
  "gu"
)

function protectMatches(
  content: string,
  pattern: RegExp,
  protectedValues: string[],
  escapeBackslashesForMarkdown = false
): string {
  return content.replace(pattern, (value) => {
    const protectedValue = escapeBackslashesForMarkdown ? value.replace(/\\/g, "\\\\") : value
    const index = protectedValues.push(protectedValue) - 1
    return `\uE000${index}\uE001`
  })
}

/**
 * Accept real line breaks and the two-character forms `\n`, `\r\n`, and `\r`.
 * Markdown code spans/blocks and common Windows paths retain their backslashes.
 */
export function normalizeReleaseNotesForDisplay(releaseNotes: string): string {
  const protectedValues: string[] = []
  let content = protectMatches(releaseNotes, INLINE_OR_FENCED_CODE_PATTERN, protectedValues)
  content = protectMatches(content, DRIVE_PATH_PATTERN, protectedValues, true)
  content = protectMatches(content, UNC_PATH_PATTERN, protectedValues, true)
  content = content.replace(/\\r\\n|\\n|\\r/g, "\n")

  return content.replace(/\uE000(\d+)\uE001/g, (_match, index: string) => {
    return protectedValues[Number(index)] ?? ""
  })
}

/** Only web links are allowed from server-authored release notes. */
export function sanitizeReleaseNotesUrl(value: string, key: string): string {
  if (key !== "href") return ""

  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : ""
  } catch {
    return ""
  }
}
