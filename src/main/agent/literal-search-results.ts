/** Original Cmb LocalSandbox search bounds, shared by desktop and Bot readers. */
export const CMB_SEARCH_MAX_MATCHES = 200
export const CMB_SEARCH_MAX_CHARS = 24_000
export const CMB_SEARCH_MAX_FILES = 1_000

export function truncateCmbSearchLine(line: string): string {
  return line.length <= 1000 ? line : line.slice(0, 1000) + "...(truncated)"
}

/** Extracted from encodingAwareLiteralSearch's append accumulator. The caller
 * supplies only paths already checked against its own project authority. */
export function createCmbLiteralSearchResults() {
  const results: Record<string, Array<[number, string]>> = Object.create(null)
  let matches = 0,
    characters = 0
  return {
    results,
    append(path: string, line: number, value: string): boolean {
      const text = truncateCmbSearchLine(value)
      const size = path.length + text.length + 16
      if (matches >= CMB_SEARCH_MAX_MATCHES || characters + size > CMB_SEARCH_MAX_CHARS)
        return false
      results[path] ??= []
      results[path].push([line, text])
      matches++
      characters += size
      return true
    }
  }
}
