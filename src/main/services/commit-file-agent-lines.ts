/**
 * Commit-file Agent lines
 *
 * The commit-time adoption measurement (adoption-tracker) already decides HOW
 * MANY lines of each normalised content a commit adopted from agent
 * generations. It never records WHICH physical lines those are. This module
 * places them in the committed file without changing any count: positions
 * prefer the lines the commit itself added (read from its diff), and repeated
 * content such as `}` goes to the copy nearest the other agent lines.
 *
 * Everything here is pure except `readCommitFileDiffs`, which runs one bounded,
 * asynchronous `git diff-tree` per commit.
 */

import { execFile } from "child_process"
import { promisify } from "util"

const execFileAsync = promisify(execFile)

const DIFF_TIMEOUT_MS = 5_000
const DIFF_MAX_BUFFER_BYTES = 8 * 1024 * 1024
// Beyond this many files the command line gets long (Windows caps it near 32K
// characters); diffing the whole commit and ignoring the extra files is cheaper.
const MAX_DIFF_PATHSPECS = 200

/** Cap on `agentLineRanges` entries per file; the line count stays exact. */
export const MAX_AGENT_LINE_RANGES = 5000

export interface CommitFileDiff {
  /** New-side line ranges the commit added, 1-based and inclusive, ascending. */
  addedRanges: Array<[number, number]>
  addedLineCount: number
  deletedLineCount: number
  /** git printed "Binary files … differ": the diff carries no line information. */
  binary: boolean
}

/** The non-blank lines of a committed file, as the adoption measurement hashes them. */
export interface CommittedLineIndex {
  /** 1-based physical line number of each non-blank line, in file order. */
  lineNumbers: Uint32Array
  /** Normalised-content hash of each non-blank line, aligned with `lineNumbers`. */
  hashes: Uint32Array
  /** Physical line count, blank lines included. */
  totalLines: number
}

export interface AgentLinePlacement {
  /** Ascending 1-based line numbers, one per adopted line. */
  lineNumbers: number[]
  /** Lines placed outside the commit's added lines; null when no diff was available. */
  outsideDiff: number | null
}

export function emptyCommitFileDiff(): CommitFileDiff {
  return { addedRanges: [], addedLineCount: 0, deletedLineCount: 0, binary: false }
}

// ─────────────────────────────────────────────────────────
// Diff parsing
// ─────────────────────────────────────────────────────────

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

const C_ESCAPES: Record<string, number> = {
  a: 7,
  b: 8,
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
  '"': 34,
  "\\": 92
}

/** Decode a C-style quoted git path (`"a\tb\303\251"`); unquoted input is returned as is. */
export function unquoteGitPath(value: string): string {
  if (!value.startsWith('"')) return value
  const bytes: number[] = []
  let i = 1
  while (i < value.length) {
    const ch = value[i]
    if (ch === '"') break
    if (ch !== "\\") {
      const char = String.fromCodePoint(value.codePointAt(i) ?? 0xfffd)
      for (const byte of Buffer.from(char, "utf8")) bytes.push(byte)
      i += char.length
      continue
    }
    const next = value[i + 1] ?? ""
    if (next >= "0" && next <= "7") {
      const octal = /^[0-7]{1,3}/.exec(value.slice(i + 1))?.[0] ?? next
      bytes.push(parseInt(octal, 8) & 0xff)
      i += 1 + octal.length
      continue
    }
    bytes.push(C_ESCAPES[next] ?? next.charCodeAt(0))
    i += 2
  }
  return Buffer.from(bytes).toString("utf8")
}

function parseHeaderPath(rest: string, prefix: "a/" | "b/"): string | null {
  // git appends a tab after a label that contains a space; a real trailing tab
  // in a file name is always quoted as `\t`, so this can only be the separator.
  const label = rest.endsWith("\t") ? rest.slice(0, -1) : rest
  if (label === "/dev/null") return null
  const path = unquoteGitPath(label)
  return path.startsWith(prefix) ? path.slice(prefix.length) : path
}

/**
 * Parse `git diff-tree -p --unified=0 --no-renames --src-prefix=a/ --dst-prefix=b/`
 * output into per-file added-line ranges, keyed by the repository-relative path
 * (the old path for a deleted file). Content lines are skipped by count, so code
 * that happens to look like a header is never misread.
 */
export function parseUnifiedZeroDiff(output: string): Map<string, CommitFileDiff> {
  const files = new Map<string, CommitFileDiff>()
  let current: CommitFileDiff | null = null
  let oldPath: string | null = null
  let newPath: string | null = null
  let pendingOld = 0
  let pendingNew = 0

  const finish = (): void => {
    const key = newPath ?? oldPath
    if (current && key) files.set(key, current)
    current = null
    oldPath = null
    newPath = null
  }

  for (const line of output.split("\n")) {
    if (pendingOld > 0 || pendingNew > 0) {
      if (line.startsWith("\\")) continue
      if (line.startsWith("-") && pendingOld > 0) {
        pendingOld--
        continue
      }
      if (line.startsWith("+") && pendingNew > 0) {
        pendingNew--
        continue
      }
      // Malformed hunk: stop counting and read the line as a header instead.
      pendingOld = 0
      pendingNew = 0
    }

    if (line.startsWith("diff --git ")) {
      finish()
      current = emptyCommitFileDiff()
      continue
    }
    if (!current) continue
    if (line.startsWith("--- ")) {
      oldPath = parseHeaderPath(line.slice(4), "a/")
    } else if (line.startsWith("+++ ")) {
      newPath = parseHeaderPath(line.slice(4), "b/")
    } else if (line.startsWith("Binary files ")) {
      current.binary = true
      // Binary sections carry no ---/+++ labels; recover the path from the
      // "Binary files a/x and b/y differ" line when it is unambiguous.
      const match = /^Binary files (.+) and (.+) differ$/.exec(line)
      if (match) {
        oldPath = parseHeaderPath(match[1], "a/")
        newPath = parseHeaderPath(match[2], "b/")
      }
    } else {
      const hunk = HUNK_HEADER.exec(line)
      if (hunk) {
        const oldCount = hunk[2] === undefined ? 1 : Number(hunk[2])
        const newStart = Number(hunk[3])
        const newCount = hunk[4] === undefined ? 1 : Number(hunk[4])
        if (newCount > 0) current.addedRanges.push([newStart, newStart + newCount - 1])
        current.addedLineCount += newCount
        current.deletedLineCount += oldCount
        pendingOld = oldCount
        pendingNew = newCount
      }
    }
  }
  finish()
  return files
}

// ─────────────────────────────────────────────────────────
// git
// ─────────────────────────────────────────────────────────

function isFatalGitError(error: unknown): boolean {
  const record = error as { killed?: unknown; code?: unknown } | null
  if (!record || typeof record !== "object") return true
  // A timeout or an output overflow would only repeat; a spawn failure (cwd or
  // git missing) has a string code. A non-zero git exit has a numeric code and
  // is worth one retry in the root-commit form.
  return record.killed === true || typeof record.code !== "number"
}

/**
 * Read the commit's diff against its first parent for `relPaths`. Returns null
 * when git cannot answer in time; callers then place lines by file content only.
 * A root commit (no parent) is retried as a creation diff.
 */
export async function readCommitFileDiffs(args: {
  cwd: string
  commitSha: string
  relPaths: readonly string[]
}): Promise<Map<string, CommitFileDiff> | null> {
  const pathspecs = args.relPaths.length <= MAX_DIFF_PATHSPECS ? ["--", ...args.relPaths] : []
  const base = [
    "-c",
    "core.quotePath=false",
    "--literal-pathspecs",
    "diff-tree",
    "-r",
    "-p",
    "--unified=0",
    "--no-color",
    "--no-ext-diff",
    "--no-renames",
    "--src-prefix=a/",
    "--dst-prefix=b/"
  ]
  const run = async (revisions: string[]): Promise<Map<string, CommitFileDiff>> => {
    const { stdout } = await execFileAsync("git", [...base, ...revisions, ...pathspecs], {
      cwd: args.cwd,
      encoding: "utf-8",
      timeout: DIFF_TIMEOUT_MS,
      maxBuffer: DIFF_MAX_BUFFER_BYTES,
      windowsHide: true
    })
    return parseUnifiedZeroDiff(stdout)
  }

  try {
    return await run([`${args.commitSha}^1`, args.commitSha])
  } catch (error) {
    if (isFatalGitError(error)) return null
  }
  try {
    return await run(["--root", "--no-commit-id", args.commitSha])
  } catch {
    return null
  }
}

// ─────────────────────────────────────────────────────────
// Placement
// ─────────────────────────────────────────────────────────

function buildLineFlags(
  ranges: ReadonlyArray<readonly [number, number]>,
  size: number
): Uint8Array {
  const flags = new Uint8Array(size + 1)
  for (const [start, end] of ranges) {
    for (let line = Math.max(1, start); line <= Math.min(end, size); line++) flags[line] = 1
  }
  return flags
}

function distanceToNearest(sortedAnchors: Uint32Array, line: number): number {
  let lo = 0
  let hi = sortedAnchors.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (sortedAnchors[mid] < line) lo = mid + 1
    else hi = mid
  }
  let best = Number.POSITIVE_INFINITY
  if (lo < sortedAnchors.length) best = sortedAnchors[lo] - line
  if (lo > 0) best = Math.min(best, line - sortedAnchors[lo - 1])
  return best
}

/** Choose `count` lines from `pool` (ascending), nearest to the anchors first, then earliest. */
function pickNearest(pool: number[], count: number, sortedAnchors: Uint32Array): number[] {
  if (sortedAnchors.length === 0) return pool.slice(0, count)
  return pool
    .map((line) => ({ line, distance: distanceToNearest(sortedAnchors, line) }))
    .sort((a, b) => a.distance - b.distance || a.line - b.line)
    .slice(0, count)
    .map((entry) => entry.line)
}

/**
 * Place `adoptedCounts` (hash → adopted line count, as consumed by the adoption
 * measurement) onto physical lines of the committed file. Lines the commit
 * added are taken first; when a content has more candidates than it needs, the
 * ones nearest the lines already placed win. Only positions are decided here;
 * the result always holds exactly as many lines as the counts ask for, provided
 * the counts were consumed from this same index.
 */
export function placeAgentLines(
  index: CommittedLineIndex,
  adoptedCounts: ReadonlyMap<number, number>,
  addedRanges: ReadonlyArray<readonly [number, number]> | null
): AgentLinePlacement {
  const added = addedRanges ? buildLineFlags(addedRanges, index.totalLines) : null
  const need = new Map<number, number>()
  for (const [hash, count] of adoptedCounts) if (count > 0) need.set(hash, count)
  if (need.size === 0) return { lineNumbers: [], outsideDiff: added ? 0 : null }

  const candidates = new Map<number, { added: number[]; other: number[] }>()
  for (let i = 0; i < index.hashes.length; i++) {
    const hash = index.hashes[i]
    if (!need.has(hash)) continue
    let entry = candidates.get(hash)
    if (!entry) {
      entry = { added: [], other: [] }
      candidates.set(hash, entry)
    }
    const line = index.lineNumbers[i]
    if (added && added[line] === 1) entry.added.push(line)
    else entry.other.push(line)
  }

  const picked: number[] = []
  let outside = 0
  for (const tier of ["added", "other"] as const) {
    const ambiguous: number[] = []
    for (const [hash, remaining] of need) {
      if (remaining <= 0) continue
      const pool = candidates.get(hash)?.[tier] ?? []
      if (pool.length === 0) continue
      if (pool.length > remaining) {
        ambiguous.push(hash)
        continue
      }
      for (const line of pool) picked.push(line)
      need.set(hash, remaining - pool.length)
      if (tier === "other") outside += pool.length
    }
    if (ambiguous.length === 0) continue
    // Anchor on this tier's certain placements only, so the result does not
    // depend on the order ambiguous contents are visited in.
    const anchors = Uint32Array.from(picked).sort()
    for (const hash of ambiguous) {
      const remaining = need.get(hash) ?? 0
      const chosen = pickNearest(candidates.get(hash)?.[tier] ?? [], remaining, anchors)
      for (const line of chosen) picked.push(line)
      need.set(hash, remaining - chosen.length)
      if (tier === "other") outside += chosen.length
    }
  }

  picked.sort((a, b) => a - b)
  return { lineNumbers: picked, outsideDiff: added ? outside : null }
}

/** Count the non-blank committed lines that the commit added. */
export function countAddedNonBlankLines(
  index: CommittedLineIndex,
  addedRanges: ReadonlyArray<readonly [number, number]>
): number {
  const added = buildLineFlags(addedRanges, index.totalLines)
  let count = 0
  for (const line of index.lineNumbers) if (added[line] === 1) count++
  return count
}

/**
 * Compress ascending line numbers into `start-end` ranges. A single line is
 * still written as `n-n`: a bare number such as `2026` would let ES dynamic
 * mapping type the field as a date.
 */
export function formatLineRanges(
  sortedLines: readonly number[],
  maxRanges = MAX_AGENT_LINE_RANGES
): { ranges: string[]; truncated: boolean } {
  const ranges: string[] = []
  let start = -1
  let previous = -1
  for (const line of sortedLines) {
    if (start < 0) {
      start = previous = line
      continue
    }
    if (line === previous || line === previous + 1) {
      previous = line
      continue
    }
    if (ranges.length === maxRanges) return { ranges, truncated: true }
    ranges.push(`${start}-${previous}`)
    start = previous = line
  }
  if (start >= 0) {
    if (ranges.length === maxRanges) return { ranges, truncated: true }
    ranges.push(`${start}-${previous}`)
  }
  return { ranges, truncated: false }
}
