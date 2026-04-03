export type FrontmatterValue = string | string[]

export type SkillFrontmatter = Record<string, FrontmatterValue>

function extractFrontmatterBlock(content: string): string | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  return match ? match[1] : null
}

function normalizeKey(key: string): string {
  return key.trim().toLowerCase().replace(/-/g, "_")
}

function stripQuotes(value: string): string {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim()
  }
  return trimmed
}

function parseInlineArray(raw: string): string[] | null {
  const trimmed = raw.trim()
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return null
  const inner = trimmed.slice(1, -1).trim()
  if (!inner) return []
  return inner
    .split(",")
    .map((item) => stripQuotes(item))
    .filter(Boolean)
}

function normalizeValue(raw: string): FrontmatterValue {
  const inlineArray = parseInlineArray(raw)
  if (inlineArray) return inlineArray
  return stripQuotes(raw)
}

export function parseSkillFrontmatter(content: string): SkillFrontmatter {
  const block = extractFrontmatterBlock(content)
  if (!block) return {}

  const result: SkillFrontmatter = {}
  let pendingListKey: string | null = null
  const pendingListValues: string[] = []

  const flushPendingList = (): void => {
    if (!pendingListKey) return
    result[pendingListKey] = pendingListValues.slice()
    pendingListKey = null
    pendingListValues.length = 0
  }

  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.replace(/\t/g, "  ")
    const trimmed = line.trim()

    if (!trimmed || trimmed.startsWith("#")) continue

    if (pendingListKey && /^\s*-\s+/.test(line)) {
      pendingListValues.push(stripQuotes(trimmed.slice(1).trim()))
      continue
    }

    flushPendingList()

    const colonIdx = line.indexOf(":")
    if (colonIdx <= 0) continue

    const key = normalizeKey(line.slice(0, colonIdx))
    const rawValue = line.slice(colonIdx + 1).trim()

    if (!rawValue) {
      pendingListKey = key
      continue
    }

    result[key] = normalizeValue(rawValue)
  }

  flushPendingList()
  return result
}

export function getFrontmatterString(
  frontmatter: SkillFrontmatter,
  key: string
): string | undefined {
  const value = frontmatter[normalizeKey(key)]
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

export function getFrontmatterStringArray(
  frontmatter: SkillFrontmatter,
  key: string
): string[] | undefined {
  const value = frontmatter[normalizeKey(key)]
  if (Array.isArray(value)) {
    const items = value.map((item) => stripQuotes(item)).filter(Boolean)
    return items.length > 0 ? items : undefined
  }
  if (typeof value === "string" && value.trim()) {
    const inlineArray = parseInlineArray(value)
    if (inlineArray) return inlineArray.length > 0 ? inlineArray : undefined
    const items = value
      .split(",")
      .map((item) => stripQuotes(item))
      .filter(Boolean)
    return items.length > 0 ? items : undefined
  }
  return undefined
}
