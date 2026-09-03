const LONG_PREVIEW_LINE_CHARS = 240
const MAX_SOFT_WRAP_LINE_COUNT = 20

/** Soft-wrap compact/minified source while keeping large multiline files virtualized. */
export function shouldSoftWrapCodePreview(lines: readonly string[]): boolean {
  return (
    lines.length <= MAX_SOFT_WRAP_LINE_COUNT &&
    lines.some((line) => line.length > LONG_PREVIEW_LINE_CHARS)
  )
}
