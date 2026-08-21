const MIN_STREAMING_MARKDOWN_DELAY_MS = 50
const MAX_STREAMING_MARKDOWN_DELAY_MS = 1000
const STREAMING_MARKDOWN_CHARS_PER_MS = 64
const STREAMING_MARKDOWN_DELAY_STEP_MS = 25

export const MAX_STREAMING_MARKDOWN_RENDER_CHARS = 64 * 1024
const STREAMING_MARKDOWN_HEAD_CHARS = 8 * 1024
const STREAMING_MARKDOWN_TAIL_CHARS = 48 * 1024
const STREAMING_MARKDOWN_BOUNDARY_SEARCH_CHARS = 2 * 1024

export interface StreamingMarkdownPreview {
  head: string
  tail: string
  omittedCharacters: number
}

export interface StreamingMarkdownRenderPlan extends StreamingMarkdownPreview {
  renderFullDocument: boolean
}

function findParagraphBoundaryBefore(text: string, target: number): number {
  const boundary = text.lastIndexOf("\n\n", target)
  return boundary >= Math.max(0, target - STREAMING_MARKDOWN_BOUNDARY_SEARCH_CHARS)
    ? boundary + 2
    : target
}

function findParagraphBoundaryAfter(text: string, target: number): number {
  const boundary = text.indexOf("\n\n", target)
  return boundary >= 0 && boundary <= target + STREAMING_MARKDOWN_BOUNDARY_SEARCH_CHARS
    ? boundary + 2
    : target
}

/**
 * Bound repeated Markdown parsing while retaining both the start of the answer
 * and the active streaming tail. The omitted middle is restored as soon as the
 * stream completes. Splitting the two fragments also lets React.memo keep the
 * stable head parsed exactly once while only the bounded tail changes.
 */
export function buildStreamingMarkdownPreview(text: string): StreamingMarkdownPreview {
  if (text.length <= MAX_STREAMING_MARKDOWN_RENDER_CHARS) {
    return { head: text, tail: "", omittedCharacters: 0 }
  }

  const headEnd = findParagraphBoundaryBefore(text, STREAMING_MARKDOWN_HEAD_CHARS)
  const desiredTailStart = Math.max(headEnd, text.length - STREAMING_MARKDOWN_TAIL_CHARS)
  const tailStart = findParagraphBoundaryAfter(text, desiredTailStart)
  return {
    head: text.slice(0, headEnd),
    tail: text.slice(tailStart),
    omittedCharacters: Math.max(0, tailStart - headEnd)
  }
}

/**
 * Keep completion from synchronously parsing and mounting an unbounded document.
 * A user can explicitly opt into the full render, while short messages retain
 * the existing immediate completion behavior.
 */
export function buildStreamingMarkdownRenderPlan(
  text: string,
  isStreaming: boolean,
  isExpanded: boolean
): StreamingMarkdownRenderPlan {
  if (!isStreaming && isExpanded) {
    return {
      head: text,
      tail: "",
      omittedCharacters: 0,
      renderFullDocument: true
    }
  }

  const preview = buildStreamingMarkdownPreview(text)
  return {
    ...preview,
    renderFullDocument: preview.omittedCharacters === 0
  }
}

/**
 * Keep cumulative Markdown parsing on a roughly fixed CPU budget as an answer grows.
 * Short answers retain the existing responsive cadence, while long answers update less
 * often instead of repeatedly paying an ever-growing parse cost every 50 ms.
 */
export function getStreamingMarkdownDelayMs(textLength: number): number {
  const safeLength = Number.isFinite(textLength) ? Math.max(0, textLength) : 0
  const proportionalDelay = Math.ceil(
    safeLength / STREAMING_MARKDOWN_CHARS_PER_MS / STREAMING_MARKDOWN_DELAY_STEP_MS
  ) * STREAMING_MARKDOWN_DELAY_STEP_MS

  return Math.min(
    MAX_STREAMING_MARKDOWN_DELAY_MS,
    Math.max(MIN_STREAMING_MARKDOWN_DELAY_MS, proportionalDelay)
  )
}
