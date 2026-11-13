export const MAX_STREAMING_MARKDOWN_RENDER_CHARS = 64 * 1024
const HEAD_CHARS = 8 * 1024
const TAIL_CHARS = 48 * 1024
const BOUNDARY_SEARCH_CHARS = 2 * 1024

export interface StreamingMarkdownPreview {
  head: string
  tail: string
  omittedCharacters: number
}

export function buildStreamingMarkdownPreview(
  text: string,
  maxRenderCharacters = MAX_STREAMING_MARKDOWN_RENDER_CHARS
): StreamingMarkdownPreview {
  // A retained display may have less room than the live Markdown view. Only lower
  // its full-document threshold; keep the same paragraph boundaries and fragments.
  const threshold = Number.isFinite(maxRenderCharacters)
    ? Math.max(HEAD_CHARS + TAIL_CHARS,
        Math.min(MAX_STREAMING_MARKDOWN_RENDER_CHARS, maxRenderCharacters))
    : MAX_STREAMING_MARKDOWN_RENDER_CHARS
  if (text.length <= threshold) {
    return { head: text, tail: "", omittedCharacters: 0 }
  }
  const rawHeadEnd = text.lastIndexOf("\n\n", HEAD_CHARS)
  const headEnd = rawHeadEnd >= HEAD_CHARS - BOUNDARY_SEARCH_CHARS ? rawHeadEnd + 2 : HEAD_CHARS
  const desiredTailStart = Math.max(headEnd, text.length - TAIL_CHARS)
  const rawTailStart = text.indexOf("\n\n", desiredTailStart)
  const tailStart = rawTailStart >= 0 && rawTailStart <= desiredTailStart + BOUNDARY_SEARCH_CHARS
    ? rawTailStart + 2
    : desiredTailStart
  return {
    head: text.slice(0, headEnd),
    tail: text.slice(tailStart),
    omittedCharacters: Math.max(0, tailStart - headEnd)
  }
}
