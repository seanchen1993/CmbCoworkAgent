export const READ_FILE_DEFAULT_LIMIT = 2_000
export const READ_FILE_MAX_LIMIT = 20_000
export const READ_FILE_HOOK_FEEDBACK_CHAR_LIMIT = 8_000

const READ_FILE_PAGINATION_HEADER_RE =
  /^\[Lines (?<start>\d+)-(?<end>\d+) of (?<total>\d+)\. (?<suffix>.+)\]$/
const READ_FILE_FORMATTED_LINE_RE = /^\s*(?<line>\d+)(?:\.(?<chunk>\d+))?\t/
const READ_FILE_GENERATED_HEADER_RE =
  /^\[(?:More content is available after line \d+; use offset=\d+ to read more\.|Output was truncated within line \d+; reformat long lines or use a more specific command before continuing\.)\]$/
const READ_FILE_POST_HOOK_FEEDBACK_RE =
  /\n\n(?=\[Hook (?:output|context|notice|requested review)\])/
const READ_FILE_TRUNCATION_MSG = `

[Output was truncated due to size limits. The file content is very large. Consider reformatting the file to make it easier to navigate. For example, if this is JSON, use execute(command='jq . {file_path}') to pretty-print it with line breaks. For other formats, you can use appropriate formatting tools to split long lines.]`
const READ_FILE_HOOK_FEEDBACK_TRUNCATION_MSG = "\n[Hook feedback truncated due to size limits.]"

type ReadFilePaginationHeader = {
  start: number
  end: number
  total: number
}

function splitReadFilePostHookFeedback(result: string): {
  content: string
  hookFeedback: string | null
} {
  const match = READ_FILE_POST_HOOK_FEEDBACK_RE.exec(result)
  if (!match) return { content: result, hookFeedback: null }
  return {
    content: result.slice(0, match.index),
    hookFeedback: result.slice(match.index + 2)
  }
}

function truncateReadFilePostHookFeedback(
  hookFeedback: string | null,
  maxChars = READ_FILE_HOOK_FEEDBACK_CHAR_LIMIT
): string | null {
  if (!hookFeedback) return null
  if (maxChars <= 0) return null
  if (hookFeedback.length <= maxChars) return hookFeedback

  if (maxChars <= READ_FILE_HOOK_FEEDBACK_TRUNCATION_MSG.length) {
    return READ_FILE_HOOK_FEEDBACK_TRUNCATION_MSG.trimStart().slice(0, maxChars)
  }

  return (
    hookFeedback.slice(0, maxChars - READ_FILE_HOOK_FEEDBACK_TRUNCATION_MSG.length) +
    READ_FILE_HOOK_FEEDBACK_TRUNCATION_MSG
  )
}

function appendReadFilePostHookFeedback(content: string, hookFeedback: string | null): string {
  const cappedFeedback = truncateReadFilePostHookFeedback(hookFeedback)
  return cappedFeedback ? `${content}\n\n${cappedFeedback}` : content
}

function parseReadFilePaginationHeader(line: string): ReadFilePaginationHeader | null {
  const match = READ_FILE_PAGINATION_HEADER_RE.exec(line)
  if (!match?.groups) return null
  const start = Number(match.groups.start)
  const end = Number(match.groups.end)
  const total = Number(match.groups.total)
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || !Number.isSafeInteger(total)) {
    return null
  }
  return { start, end, total }
}

function parseReadFileSourceLine(line: string): number | null {
  const match = READ_FILE_FORMATTED_LINE_RE.exec(line)
  if (!match?.groups?.line) return null
  const sourceLine = Number(match.groups.line)
  return Number.isSafeInteger(sourceLine) ? sourceLine : null
}

function findLastVisibleReadFileSourceLine(lines: string[]): number | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const sourceLine = parseReadFileSourceLine(lines[i])
    if (sourceLine != null) return sourceLine
  }
  return null
}

function adjustReadFilePaginationHeader(
  visibleLines: string[],
  fullLines: string[],
  header: ReadFilePaginationHeader
): string[] {
  const contentLines = visibleLines.slice(1)
  const lastVisibleSourceLine = findLastVisibleReadFileSourceLine(contentLines)
  if (lastVisibleSourceLine == null) {
    return [
      `[Lines ${header.start}-${header.end} of ${header.total}. Output was truncated before file content; retry with a smaller limit.]`,
      ...contentLines
    ]
  }

  const nextLine = fullLines[visibleLines.length]
  const nextSourceLine = nextLine ? parseReadFileSourceLine(nextLine) : null
  if (nextSourceLine === lastVisibleSourceLine) {
    return [
      `[Lines ${header.start}-${lastVisibleSourceLine} of ${header.total}. Output was truncated within line ${lastVisibleSourceLine}; reformat long lines or use a more specific command before continuing.]`,
      ...contentLines
    ]
  }

  return [
    `[Lines ${header.start}-${lastVisibleSourceLine} of ${header.total}. Use offset=${lastVisibleSourceLine} to read more.]`,
    ...contentLines
  ]
}

function joinReadFileLinesWithinCharLimit(lines: string[], maxLength: number): string {
  if (maxLength <= 0) return ""

  const visibleLines: string[] = []
  let visibleLength = 0
  for (const line of lines) {
    const nextLength = visibleLength + (visibleLines.length > 0 ? 1 : 0) + line.length
    if (nextLength > maxLength) break
    visibleLines.push(line)
    visibleLength = nextLength
  }

  if (visibleLines.length > 0) return visibleLines.join("\n")
  return (lines[0] ?? "").slice(0, maxLength)
}

export function trimReadFileOutputLines(result: string, limit: number): string {
  const { content, hookFeedback } = splitReadFilePostHookFeedback(result)
  const lines = content.split("\n")
  const header = parseReadFilePaginationHeader(lines[0] ?? "")
  const hasGeneratedHeader = header !== null || READ_FILE_GENERATED_HEADER_RE.test(lines[0] ?? "")
  const maxOutputLines = hasGeneratedHeader ? limit + 1 : limit
  if (lines.length <= maxOutputLines) {
    return appendReadFilePostHookFeedback(content, hookFeedback)
  }

  if (!header && hasGeneratedHeader) {
    const visibleLines = [lines[0], ...lines.slice(1, limit + 1)]
    return appendReadFilePostHookFeedback(visibleLines.join("\n"), hookFeedback)
  }

  let trimmedContent: string
  if (!header) {
    const visibleLines = lines.slice(0, limit)
    const lastVisibleSourceLine = findLastVisibleReadFileSourceLine(visibleLines)
    const nextSourceLine = parseReadFileSourceLine(lines[limit] ?? "")
    if (lastVisibleSourceLine != null && nextSourceLine === lastVisibleSourceLine) {
      trimmedContent = [
        `[Output was truncated within line ${lastVisibleSourceLine}; reformat long lines or use a more specific command before continuing.]`,
        ...visibleLines
      ].join("\n")
      return appendReadFilePostHookFeedback(trimmedContent, hookFeedback)
    }
    if (
      lastVisibleSourceLine != null &&
      nextSourceLine != null &&
      nextSourceLine > lastVisibleSourceLine
    ) {
      trimmedContent = [
        `[More content is available after line ${lastVisibleSourceLine}; use offset=${lastVisibleSourceLine} to read more.]`,
        ...visibleLines
      ].join("\n")
      return appendReadFilePostHookFeedback(trimmedContent, hookFeedback)
    }
    trimmedContent = visibleLines.join("\n")
    return appendReadFilePostHookFeedback(trimmedContent, hookFeedback)
  }

  const visibleLines = [lines[0], ...lines.slice(1, limit + 1)]
  trimmedContent = adjustReadFilePaginationHeader(visibleLines, lines, header).join("\n")
  return appendReadFilePostHookFeedback(trimmedContent, hookFeedback)
}

export function getReadFileOutputCharLimit(toolTokenLimitBeforeEvict?: number): number | undefined {
  return toolTokenLimitBeforeEvict ? 4 * toolTokenLimitBeforeEvict : undefined
}

export function truncateReadFileOutputByChars(
  result: string,
  filePath: string,
  toolTokenLimitBeforeEvict?: number
): string {
  const outputCharLimit = getReadFileOutputCharLimit(toolTokenLimitBeforeEvict)
  if (!outputCharLimit || result.length <= outputCharLimit) return result

  const { content, hookFeedback } = splitReadFilePostHookFeedback(result)
  const truncationMsg = READ_FILE_TRUNCATION_MSG.replace("{file_path}", filePath)
  let cappedHookFeedback = truncateReadFilePostHookFeedback(hookFeedback)
  let preservedSuffix = (cappedHookFeedback ? `\n\n${cappedHookFeedback}` : "") + truncationMsg
  if (preservedSuffix.length > outputCharLimit && cappedHookFeedback) {
    const hookBudget = Math.max(0, outputCharLimit - truncationMsg.length - 2)
    cappedHookFeedback = truncateReadFilePostHookFeedback(hookFeedback, hookBudget)
    preservedSuffix = (cappedHookFeedback ? `\n\n${cappedHookFeedback}` : "") + truncationMsg
  }
  const maxContentLength = outputCharLimit - preservedSuffix.length
  if (maxContentLength <= 0) return preservedSuffix.trimStart().slice(0, outputCharLimit)

  const fullLines = content.split("\n")
  const visibleContent = joinReadFileLinesWithinCharLimit(fullLines, maxContentLength)
  const visibleLines = visibleContent ? visibleContent.split("\n") : []

  if (visibleLines.length === 0) return content.substring(0, maxContentLength) + preservedSuffix

  const header = parseReadFilePaginationHeader(visibleLines[0] ?? "")
  const adjustedLines = header
    ? adjustReadFilePaginationHeader(visibleLines, fullLines, header)
    : visibleLines
  return joinReadFileLinesWithinCharLimit(adjustedLines, maxContentLength) + preservedSuffix
}
