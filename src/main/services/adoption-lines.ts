import * as iconv from "iconv-lite"
import * as chardet from "jschardet"

// Shared by generation, committed blobs and the worker. Changing this
// normalization would invalidate existing persisted line baselines.
export function fnv1a32(input: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
  }
  return h >>> 0
}

export function normalizeLine(line: string): string {
  return line.trim().replace(/\s+/g, " ")
}

export interface LineEntry {
  hash: number
  text: string
}

export function computeLineEntries(content: string): LineEntry[] {
  const entries: LineEntry[] = []
  for (const raw of content.split(/\r?\n/)) {
    const norm = normalizeLine(raw)
    if (norm.length !== 0) entries.push({ hash: fnv1a32(norm), text: raw })
  }
  return entries
}

export function computeLineHashes(content: string): Uint32Array {
  const hashes: number[] = []
  for (const raw of content.split(/\r?\n/)) {
    const norm = normalizeLine(raw)
    if (norm.length !== 0) hashes.push(fnv1a32(norm))
  }
  return new Uint32Array(hashes)
}

export function lineEntriesToTexts(entries: LineEntry[]): string[] {
  return entries.map((entry) => entry.text)
}

export function subtractLineEntryMultiset(source: LineEntry[], subtract: LineEntry[]): LineEntry[] {
  if (source.length === 0 || subtract.length === 0) return source
  const counts = new Map<number, number>()
  for (const entry of subtract) counts.set(entry.hash, (counts.get(entry.hash) ?? 0) + 1)
  return source.filter((entry) => {
    const count = counts.get(entry.hash) ?? 0
    if (count === 0) return true
    counts.set(entry.hash, count - 1)
    return false
  })
}

function isValidUtf8(buffer: Buffer): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buffer)
    return true
  } catch {
    return false
  }
}

export function decodeCodeBuffer(buffer: Buffer): string {
  if (buffer.length === 0) return ""
  if (buffer.every((byte) => byte < 0x80)) return buffer.toString("utf8")
  let encoding = "utf-8"
  try {
    const detected = chardet.detect(buffer)
    const name = typeof detected === "string" ? detected : detected?.encoding
    const confidence = typeof detected === "string" ? 1 : (detected?.confidence ?? 0)
    if (name && name.toLowerCase() !== "ascii" && iconv.encodingExists(name)) {
      if (confidence >= 0.8 || !isValidUtf8(buffer)) encoding = name
    }
  } catch {
    /* Preserve the old UTF-8 fallback. */
  }
  return iconv.decode(buffer, encoding)
}

export interface ShellEditLineFragments {
  generatedContent: string
  oldString: string
  deletedLineCount: number
}

export function shellEditLineFragments(
  before: Buffer | string,
  after: Buffer | string
): ShellEditLineFragments | null {
  const beforeText = typeof before === "string" ? before : decodeCodeBuffer(before)
  const afterText = typeof after === "string" ? after : decodeCodeBuffer(after)
  if (beforeText === afterText) return null
  const oldLines = computeLineEntries(beforeText)
  const newLines = computeLineEntries(afterText)
  const added = subtractLineEntryMultiset(newLines, oldLines)
  const deleted = subtractLineEntryMultiset(oldLines, newLines)
  if (added.length === 0 && deleted.length === 0) return null
  return {
    generatedContent: lineEntriesToTexts(added).join("\n"),
    oldString: lineEntriesToTexts(deleted).join("\n"),
    deletedLineCount: deleted.length
  }
}
