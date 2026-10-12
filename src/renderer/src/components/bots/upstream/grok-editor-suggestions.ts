// Extracted from Grok Bot 0.18 editor-suggestion-provider.ts. See PROVENANCE.json.
export interface EditorSuggestionEntry {
  readonly id: string
  readonly category: string
  readonly label: string
  readonly subtitle?: string
  readonly keywords: readonly string[]
}

function recencyKey(entry: EditorSuggestionEntry): string {
  return `${entry.category}:${entry.id}`
}

function normalizeSuggestionText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
}

function fuzzySuggestionScore(value: string, token: string): number | null {
  if (token.length === 0) return 0
  const lower = value.toLowerCase()
  let score = 0
  let matched = 0
  let first = -1
  let last = -1
  for (let index = 0; index < lower.length && matched < token.length; index += 1) {
    if (lower[index] !== token[matched]) continue
    if (first < 0) first = index
    const previous = index === 0 ? "" : value[index - 1]!
    const boundary =
      index === 0 ||
      previous === " " ||
      previous === "-" ||
      previous === "_" ||
      previous === "/" ||
      previous === "."
    const camelBoundary =
      previous >= "a" && previous <= "z" && value[index]! >= "A" && value[index]! <= "Z"
    let weight = 1
    if (boundary || camelBoundary) weight += 4
    if (last === index - 1) weight += 3
    score += weight
    last = index
    matched += 1
  }
  if (matched < token.length || last - first + 1 > token.length * 3) return null
  return score - first * 0.1 - value.length * 0.02
}

function entryScore(entry: EditorSuggestionEntry, query: string): number | null {
  const normalizedQuery = normalizeSuggestionText(query)
  if (normalizedQuery.length === 0) return 0
  const tokens = normalizedQuery.split(" ")
  const candidates = [entry.label, entry.subtitle ?? "", ...entry.keywords]
  let score = 0
  for (const token of tokens) {
    let best: number | null = null
    for (const candidate of candidates) {
      const next = fuzzySuggestionScore(normalizeSuggestionText(candidate), token)
      if (next != null && (best == null || next > best)) best = next
    }
    if (best == null) return null
    score += best
  }
  return score + (fuzzySuggestionScore(normalizeSuggestionText(entry.label), normalizedQuery) ?? 0)
}

/** Exact first-seen dedupe plus recent-first ranking used by the shipped rows. */
export function filterEditorSuggestionEntries(
  entries: readonly EditorSuggestionEntry[],
  query: string,
  recentKeys: readonly string[] = []
): EditorSuggestionEntry[] {
  const seen = new Set<string>()
  const unique = entries.filter((entry) => {
    const key = recencyKey(entry)
    if (seen.has(key)) return false
    seen.add(key)
    return entryScore(entry, query) != null
  })
  const recent = new Map<string, number>()
  recentKeys.forEach((key, index) => {
    if (!recent.has(key)) recent.set(key, index)
  })
  const scores = new Map(unique.map((entry) => [recencyKey(entry), entryScore(entry, query) ?? 0]))
  const normalizedQuery = normalizeSuggestionText(query)
  if (normalizedQuery.length === 0) {
    return unique.sort(
      (left, right) =>
        (recent.get(recencyKey(left)) ?? Number.POSITIVE_INFINITY) -
        (recent.get(recencyKey(right)) ?? Number.POSITIVE_INFINITY)
    )
  }
  return unique.sort((left, right) => {
    const scoreDifference =
      (scores.get(recencyKey(right)) ?? 0) - (scores.get(recencyKey(left)) ?? 0)
    if (scoreDifference !== 0) return scoreDifference
    const recencyDifference =
      (recent.get(recencyKey(right)) ?? -1) - (recent.get(recencyKey(left)) ?? -1)
    return recencyDifference
  })
}

export function selectEditorSuggestion(
  entries: readonly EditorSuggestionEntry[],
  activeIndex: number,
  key: string
):
  | { readonly kind: "move"; readonly activeIndex: number }
  | { readonly kind: "select"; readonly entry: EditorSuggestionEntry }
  | { readonly kind: "dismiss" }
  | { readonly kind: "noop" } {
  if (entries.length === 0) return key === "Escape" ? { kind: "dismiss" } : { kind: "noop" }
  if (key === "ArrowDown" || key === "ArrowUp") {
    const delta = key === "ArrowDown" ? 1 : -1
    return {
      kind: "move",
      activeIndex: (Math.max(0, activeIndex) + delta + entries.length) % entries.length
    }
  }
  if (key === "Enter" || key === "Tab")
    return {
      kind: "select",
      entry: entries[Math.min(Math.max(activeIndex, 0), entries.length - 1)]!
    }
  return key === "Escape" ? { kind: "dismiss" } : { kind: "noop" }
}
