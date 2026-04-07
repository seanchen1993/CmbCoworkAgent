import { existsSync, readdirSync, readFileSync, writeFileSync, statSync } from "fs"
import { join, basename } from "path"

/**
 * Per-fact memory file with frontmatter.
 *
 * Each memory file under the memory dir (excluding MEMORY.md and legacy daily logs)
 * is expected to start with a YAML frontmatter block:
 *
 *   ---
 *   name: 用户偏好 TypeScript
 *   description: 用户在所有项目中都偏好使用 TypeScript 而非 JavaScript
 *   type: feedback
 *   ---
 *
 *   (memory body)
 */

export type MemoryType = "user" | "feedback" | "project" | "reference"

export interface MemoryHeader {
  filename: string
  filePath: string
  name: string
  description: string
  type: MemoryType | null
  mtimeMs: number
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/
const VALID_TYPES: ReadonlySet<MemoryType> = new Set(["user", "feedback", "project", "reference"])

// Daily log filenames look like 2026-04-05.md — keep them for legacy search but exclude from manifest.
const DAILY_LOG_RE = /^\d{4}-\d{2}-\d{2}\.md$/

export function parseFrontmatter(content: string): {
  frontmatter: Record<string, string>
  body: string
} {
  const m = content.match(FRONTMATTER_RE)
  if (!m) return { frontmatter: {}, body: content }
  const frontmatter: Record<string, string> = {}
  for (const line of m[1].split(/\r?\n/)) {
    const idx = line.indexOf(":")
    if (idx === -1) continue
    const key = line.slice(0, idx).trim()
    const val = line
      .slice(idx + 1)
      .trim()
      .replace(/^["']|["']$/g, "")
    if (key) frontmatter[key] = val
  }
  return { frontmatter, body: content.slice(m[0].length) }
}

export function buildFrontmatter(header: {
  name: string
  description: string
  type: MemoryType
}): string {
  return `---\nname: ${escapeYaml(header.name)}\ndescription: ${escapeYaml(header.description)}\ntype: ${header.type}\n---\n\n`
}

function escapeYaml(s: string): string {
  // Keep it simple: collapse to single line, strip control chars.
  let out = ""
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c === 10 || c === 13) {
      if (out.length > 0 && out.charCodeAt(out.length - 1) !== 32) out += " "
    } else if (c >= 32) {
      out += s[i]
    }
  }
  return out.trim()
}

function parseMemoryType(value: string | undefined): MemoryType | null {
  if (!value) return null
  const v = value.toLowerCase().trim()
  return VALID_TYPES.has(v as MemoryType) ? (v as MemoryType) : null
}

/**
 * Scan the memory directory for per-fact memory files (excluding MEMORY.md and daily logs).
 * Returns headers sorted newest-first.
 */
export function scanMemoryFiles(memoryDir: string): MemoryHeader[] {
  if (!existsSync(memoryDir)) return []
  const out: MemoryHeader[] = []
  for (const name of readdirSync(memoryDir)) {
    if (!name.endsWith(".md")) continue
    if (name === "MEMORY.md") continue
    if (DAILY_LOG_RE.test(name)) continue
    const filePath = join(memoryDir, name)
    try {
      const stat = statSync(filePath)
      if (!stat.isFile()) continue
      // Read only the first ~2KB to extract frontmatter — bodies can be long.
      const fd = readFileSync(filePath, "utf-8")
      const head = fd.slice(0, 2048)
      const { frontmatter } = parseFrontmatter(head)
      const type = parseMemoryType(frontmatter.type)
      // Files without name+type frontmatter are not part of the per-fact manifest.
      if (!frontmatter.name || !type) continue
      out.push({
        filename: name,
        filePath,
        name: frontmatter.name,
        description: frontmatter.description ?? "",
        type,
        mtimeMs: stat.mtimeMs
      })
    } catch {
      // Skip unreadable files
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return out
}

/**
 * Convert mtime to a short freshness suffix used inside the manifest.
 * Returns empty string for "today" memories so the manifest stays clean.
 */
export function ageSuffix(mtimeMs: number, now: number = Date.now()): string {
  const days = Math.max(0, Math.floor((now - mtimeMs) / (1000 * 60 * 60 * 24)))
  if (days === 0) return ""
  if (days === 1) return " _(yesterday)_"
  if (days < 30) return ` _(${days}d ago)_`
  if (days < 365) return ` _(${Math.floor(days / 30)}mo ago)_`
  return ` _(${Math.floor(days / 365)}y ago)_`
}

/**
 * Caveat shown when a recalled memory is older than `MEMORY_FRESHNESS_DAYS`.
 * The agent should verify against current state before asserting it as fact.
 */
export const MEMORY_FRESHNESS_DAYS = 14

export function memoryFreshnessText(mtimeMs: number, now: number = Date.now()): string {
  const days = Math.max(0, Math.floor((now - mtimeMs) / (1000 * 60 * 60 * 24)))
  if (days <= MEMORY_FRESHNESS_DAYS) return ""
  return (
    `> ⚠️ This memory is ${days} days old. Memories are point-in-time observations, ` +
    `not live state — claims about code, files, decisions or preferences may be outdated. ` +
    `Verify against the current project before asserting as fact.`
  )
}

// Keep MEMORY.md injection bounded so it never eats the context window.
// Mirrors Claude Code's auto-memory limits (memdir.ts).
export const MAX_MANIFEST_LINES = 200
export const MAX_MANIFEST_BYTES = 25_000

function applyManifestTruncation(
  body: string,
  totalHeaders: number
): { content: string; truncated: boolean; truncatedReason?: string } {
  const lines = body.split("\n")
  let truncated = false
  let reason: string | undefined

  let trimmed = lines
  if (trimmed.length > MAX_MANIFEST_LINES) {
    trimmed = trimmed.slice(0, MAX_MANIFEST_LINES)
    truncated = true
    reason = `${MAX_MANIFEST_LINES} line cap`
  }

  let content = trimmed.join("\n")
  if (Buffer.byteLength(content, "utf-8") > MAX_MANIFEST_BYTES) {
    // Cut on the last newline before the byte cap to avoid mid-line truncation.
    const buf = Buffer.from(content, "utf-8").subarray(0, MAX_MANIFEST_BYTES)
    let s = buf.toString("utf-8")
    const lastNl = s.lastIndexOf("\n")
    if (lastNl > 0) s = s.slice(0, lastNl)
    content = s
    truncated = true
    reason = reason
      ? `${reason} + ${MAX_MANIFEST_BYTES}-byte cap`
      : `${MAX_MANIFEST_BYTES}-byte cap`
  }

  if (truncated) {
    content +=
      `\n\n> ⚠️ Manifest truncated (${reason}). ` +
      `Showing the most-recently-updated entries; ${totalHeaders} memories total. ` +
      `Older entries are still searchable via the memory_search tool.\n`
  }

  return { content, truncated, truncatedReason: reason }
}

/**
 * Format the manifest as the body of MEMORY.md, grouped by type.
 * This file is auto-generated — users should not hand-edit it.
 *
 * Headers are sorted newest-first by mtime, so when truncation kicks in
 * the most relevant (recently-touched) memories survive.
 */
export function formatManifest(headers: MemoryHeader[]): string {
  const lines: string[] = []
  lines.push("# Memory Index")
  lines.push("")
  lines.push(
    "> This file is auto-generated from the frontmatter of memory files in this directory."
  )
  lines.push("> Do not hand-edit — your edits will be overwritten on the next memory write.")
  lines.push("")

  if (headers.length === 0) {
    lines.push(
      "_No memories yet. They will appear here as the assistant learns about you and your work._"
    )
    return lines.join("\n") + "\n"
  }

  const now = Date.now()
  const groups: Record<MemoryType, MemoryHeader[]> = {
    user: [],
    feedback: [],
    project: [],
    reference: []
  }
  for (const h of headers) {
    if (h.type) groups[h.type].push(h)
  }

  const sectionTitles: Record<MemoryType, string> = {
    user: "User",
    feedback: "Feedback",
    project: "Project",
    reference: "Reference"
  }

  for (const type of ["user", "feedback", "project", "reference"] as const) {
    const items = groups[type]
    if (items.length === 0) continue
    lines.push(`## ${sectionTitles[type]}`)
    for (const h of items) {
      const desc = h.description ? ` — ${h.description}` : ""
      const age = ageSuffix(h.mtimeMs, now)
      lines.push(`- [${h.name}](${h.filename})${desc}${age}`)
    }
    lines.push("")
  }

  const body = lines.join("\n")
  const { content } = applyManifestTruncation(body, headers.length)
  return content
}

/**
 * Regenerate MEMORY.md from the current set of per-fact files in memoryDir.
 * Returns the number of headers indexed.
 *
 * NOTE: This rewrites MEMORY.md from scratch and clobbers any LLM/user edits.
 * Use it only as a bootstrap (when MEMORY.md does not yet exist) — for incremental
 * updates the summarizer asks the LLM to maintain MEMORY.md directly.
 */
export function regenerateManifest(memoryDir: string): number {
  if (!existsSync(memoryDir)) return 0
  const headers = scanMemoryFiles(memoryDir)
  const content = formatManifest(headers)
  writeFileSync(join(memoryDir, "MEMORY.md"), content, "utf-8")
  return headers.length
}

/**
 * Remove a single entry's line from MEMORY.md without touching anything else.
 * Used when the user deletes a fact file via the UI — we want to preserve
 * any LLM-curated grouping/notes the user added to MEMORY.md.
 *
 * Matches lines containing `](filename)` in markdown link syntax.
 */
export function removeEntryFromManifest(memoryDir: string, filename: string): boolean {
  const memoryMd = join(memoryDir, "MEMORY.md")
  if (!existsSync(memoryMd)) return false
  const content = readFileSync(memoryMd, "utf-8")
  const needle = `](${filename})`
  if (!content.includes(needle)) return false
  const lines = content.split("\n")
  const filtered = lines.filter((line) => !line.includes(needle))
  writeFileSync(memoryMd, filtered.join("\n"), "utf-8")
  return true
}

/**
 * Validate and normalize a per-fact filename.
 * Required form: {type}_{slug}.md where slug is alphanumeric/underscore/hyphen,
 * and {type} is one of the valid memory types.
 */
export function isValidFactFilename(name: string, type: MemoryType): boolean {
  const safe = basename(name)
  if (safe !== name) return false
  if (!safe.endsWith(".md")) return false
  if (safe === "MEMORY.md") return false
  if (DAILY_LOG_RE.test(safe)) return false
  const re = new RegExp(`^${type}_[a-zA-Z0-9_\\-\\u4e00-\\u9fff]{1,80}\\.md$`)
  return re.test(safe)
}

/**
 * Generate a fallback filename when the LLM-provided one is invalid.
 */
export function generateFactFilename(name: string, type: MemoryType): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 60) || "memory"
  return `${type}_${slug}.md`
}
