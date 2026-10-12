/** Copied Grok palette matching, keyboard and virtual row primitives. See PROVENANCE. */
const COMBINING_MARKS = new RegExp("\\p{M}+", "gu")
const LETTER_OR_NUMBER = /[\p{L}\p{N}]/u
const MAX_FUZZY_SPAN_MULTIPLIER = 3

export function normalizePaletteSearch(value: string): string {
  let normalized = ""
  let separated = false
  for (let index = 0; index < value.length; index += 1) {
    const character = value
      .charAt(index)
      .normalize("NFKD")
      .replace(COMBINING_MARKS, "")
      .toLowerCase()
    for (const unit of character) {
      if (!LETTER_OR_NUMBER.test(unit)) {
        separated = true
        continue
      }
      if (separated && normalized.length > 0) normalized += " "
      separated = false
      normalized += unit
    }
  }
  return normalized
}

export function paletteSearchTokens(value: string): string[] {
  const normalized = normalizePaletteSearch(value)
  return normalized.length === 0 ? [] : normalized.split(" ")
}

export function fuzzyPaletteScore(value: string, query: string): number | null {
  if (query.length === 0) return 0
  const lowerValue = value.toLowerCase()
  let score = 0
  let queryIndex = 0
  let previousMatch = -2
  let firstMatch = -1
  let lastMatch = -1
  for (let index = 0; index < lowerValue.length && queryIndex < query.length; index += 1) {
    if (lowerValue[index] !== query[queryIndex]) continue
    if (firstMatch < 0) firstMatch = index
    const previousCharacter = value.charAt(index - 1)
    const isBoundary =
      index === 0 ||
      previousCharacter === " " ||
      previousCharacter === "-" ||
      previousCharacter === "_" ||
      previousCharacter === "/" ||
      previousCharacter === "."
    const isCamelBoundary =
      previousCharacter >= "a" &&
      previousCharacter <= "z" &&
      value.charAt(index) >= "A" &&
      value.charAt(index) <= "Z"
    let characterScore = 1
    if (isBoundary || isCamelBoundary) characterScore += 4
    if (previousMatch === index - 1) characterScore += 3
    score += characterScore
    previousMatch = index
    lastMatch = index
    queryIndex += 1
  }
  if (
    queryIndex < query.length ||
    lastMatch - firstMatch + 1 > query.length * MAX_FUZZY_SPAN_MULTIPLIER
  )
    return null
  return score - firstMatch * 0.1 - lowerValue.length * 0.02
}

export function movePaletteHighlight(current: number, rowCount: number, delta: -1 | 1): number {
  if (rowCount <= 0) return 0
  const bounded = Math.min(Math.max(current, 0), rowCount - 1)
  return Math.min(Math.max(bounded + delta, 0), rowCount - 1)
}

// The immutable palette keeps a 49px row, 2px gap, 8px leading inset, and six
// rows of overscan. These pure geometry helpers keep the mounted list finite
// while preserving the shipped keyboard/scroll contract.
// @evidence src/app/dist/renderer/assets/index-UbX-y3il.js#byteOffset=5508887
export interface CommandPaletteVirtualWindow {
  start: number
  end: number
}

export function commandPaletteVirtualWindow({
  rowCount,
  rowPitchPx,
  leadingOffsetPx,
  scrollTopPx,
  viewportPx,
  overscanRows
}: {
  rowCount: number
  rowPitchPx: number
  leadingOffsetPx: number
  scrollTopPx: number
  viewportPx: number
  overscanRows: number
}): CommandPaletteVirtualWindow {
  if (rowCount <= 0) return { start: 0, end: 0 }
  const firstVisible = Math.floor((scrollTopPx - leadingOffsetPx) / rowPitchPx)
  const lastVisible = Math.floor((scrollTopPx + viewportPx) / rowPitchPx)
  const start = Math.min(Math.max(0, firstVisible - overscanRows), Math.max(0, rowCount - 1))
  const end = Math.max(Math.min(rowCount, lastVisible + 1 + overscanRows), start)
  return { start, end }
}

// @evidence src/app/dist/renderer/assets/index-UbX-y3il.js#byteOffset=5517000
export function commandPaletteScrollTopForRow({
  rowIndex,
  rowPitchPx,
  rowGapPx,
  leadingOffsetPx,
  scrollTopPx,
  viewportPx,
  edgeInsetPx = 0
}: {
  rowIndex: number
  rowPitchPx: number
  rowGapPx: number
  leadingOffsetPx: number
  scrollTopPx: number
  viewportPx: number
  edgeInsetPx?: number
}): number | null {
  const rowHeightPx = rowPitchPx - rowGapPx
  const rowTopPx = leadingOffsetPx + rowIndex * rowPitchPx
  const rowBottomPx = rowTopPx + rowHeightPx
  if (rowTopPx < scrollTopPx + edgeInsetPx) return Math.max(0, rowTopPx - edgeInsetPx)
  if (rowBottomPx > scrollTopPx + viewportPx - edgeInsetPx)
    return rowBottomPx - viewportPx + edgeInsetPx
  return null
}

export function paletteShortcutNumber(
  rowIndex: number,
  isNested: boolean,
  isModifierHeld: boolean
): number | null {
  if (isNested || !isModifierHeld || rowIndex >= 9 || rowIndex < 0) return null
  return rowIndex + 1
}

export function paletteIndexedShortcutIndex(
  key: string,
  isNested: boolean,
  rowCount: number
): number | null {
  if (isNested || !/^[1-9]$/.test(key)) return null
  const index = Number(key) - 1
  return index < rowCount ? index : null
}
