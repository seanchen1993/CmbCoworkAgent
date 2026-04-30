import * as iconv from "iconv-lite"

export interface SkillArchiveEntry {
  decodedName: string
}

export interface ZipArchiveEntryLike {
  entryName: string
  rawEntryName?: Buffer
  header?: {
    flags_efs?: boolean
  }
}

export function normalizeArchiveEntryName(input: string): string {
  return String(input || "")
    .replace(/\\/g, "/")
    .replace(/\0/g, "")
}

function isValidUtf8(buf: Buffer): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buf)
    return true
  } catch {
    return false
  }
}

function containsCjk(text: string): boolean {
  return /[\u3400-\u9fff]/.test(text)
}

function scoreDecodedName(name: string): number {
  let score = 0
  for (const ch of name) {
    if (/[\u3400-\u9fff]/.test(ch)) score += 4
    else if (/[A-Za-z0-9._\- ()[\]]/.test(ch)) score += 1
    else if (/[\u2500-\u259f]/.test(ch)) score -= 3
    else if (ch === "\uFFFD") score -= 4
  }
  return score
}

export function decodeArchiveEntryName(entry: ZipArchiveEntryLike): string {
  const fallback = normalizeArchiveEntryName(entry.entryName)
  const raw = Buffer.isBuffer(entry.rawEntryName) ? entry.rawEntryName : null
  if (!raw || raw.length === 0) return fallback

  try {
    const utf8Valid = isValidUtf8(raw)
    const hasUtf8Flag = entry.header?.flags_efs === true
    const utf8Name = utf8Valid ? normalizeArchiveEntryName(raw.toString("utf-8")) : ""

    if (hasUtf8Flag && utf8Name) return utf8Name
    if (utf8Name && (containsCjk(utf8Name) || !fallback.includes("\uFFFD"))) return utf8Name

    const candidates: string[] = []
    if (iconv.encodingExists("gb18030")) {
      candidates.push(normalizeArchiveEntryName(iconv.decode(raw, "gb18030")))
    }
    if (iconv.encodingExists("cp437")) {
      candidates.push(normalizeArchiveEntryName(iconv.decode(raw, "cp437")))
    }

    let best = utf8Name || fallback
    let bestScore = scoreDecodedName(best)
    for (const candidate of candidates) {
      if (!candidate) continue
      const score = scoreDecodedName(candidate)
      if (score > bestScore) {
        best = candidate
        bestScore = score
      }
    }
    if (best) return best
  } catch {
    /* fall back below */
  }

  return fallback
}

function isSafeArchiveRelativePath(input: string): boolean {
  const normalized = normalizeArchiveEntryName(input)
  if (!normalized || normalized.startsWith("/")) return false
  const segments = normalized.split("/").filter(Boolean)
  if (segments.length === 0) return false
  return segments.every((segment) => segment !== "." && segment !== "..")
}

function getArchivePathDepth(input: string): number {
  return normalizeArchiveEntryName(input).split("/").filter(Boolean).length
}

export function isSkillMarkdownArchivePath(input: string): boolean {
  return /(^|\/)SKILL\.md$/i.test(normalizeArchiveEntryName(input))
}

export function selectRootSkillMarkdownEntry<T extends SkillArchiveEntry>(
  entries: readonly T[],
  isDirectory: (entry: T) => boolean
): T | null {
  const candidates = entries.filter(
    (item) =>
      !isDirectory(item) &&
      isSkillMarkdownArchivePath(item.decodedName) &&
      isSafeArchiveRelativePath(item.decodedName)
  )
  candidates.sort((a, b) => {
    const depthDiff = getArchivePathDepth(a.decodedName) - getArchivePathDepth(b.decodedName)
    if (depthDiff !== 0) return depthDiff
    return normalizeArchiveEntryName(a.decodedName).localeCompare(
      normalizeArchiveEntryName(b.decodedName)
    )
  })
  return candidates[0] ?? null
}
