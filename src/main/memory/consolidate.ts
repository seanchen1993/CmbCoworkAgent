/**
 * Dream consolidation — the async "sleep phase" of the memory system.
 *
 * Mirrors how the human brain consolidates memories during slow-wave sleep:
 * - Identifies semantically redundant facts and merges them
 * - Extracts meta-patterns when 3+ facts point to the same conclusion
 * - Archives stale facts that have never been recalled (safe move, not delete)
 * - Updates MEMORY.md after all operations are applied
 *
 * Trigger conditions (both must hold for auto-trigger):
 *   1. At least DREAM_MIN_INTERVAL_MS since the last Dream run
 *   2. At least DREAM_MIN_NEW_FACTS new facts since last run, OR total facts > DREAM_MIN_TOTAL
 *
 * A manual trigger (IPC: memory:consolidate) bypasses the condition check.
 */

import { ChatOpenAI } from "@langchain/openai"
import { HumanMessage, SystemMessage } from "@langchain/core/messages"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs"
import { basename, join } from "path"
import { getMemoryStore } from "./store"
import { notifyMemoryChanged } from "./events"
import {
  scanMemoryFiles,
  buildFrontmatter,
  isValidFactFilename,
  generateFactFilename,
  parseMemoryType,
  type MemoryType,
  type MemoryHeader
} from "./manifest"

// ─── Auto-trigger thresholds ───────────────────────────────────────────────
const DREAM_MIN_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days
const DREAM_MIN_NEW_FACTS = 20
const DREAM_MIN_TOTAL = 50
/**
 * Minimum conversations since last Dream before auto-triggering.
 * Mirrors Claude Code's session-count gate — prevents a single new fact from
 * triggering Dream after 7 idle days.
 */
const DREAM_MIN_SESSIONS = 5

// ─── Safety thresholds ─────────────────────────────────────────────────────
/**
 * A fact must be at least this old AND meet ALL other criteria to be eligible
 * for LLM-suggested archive. The cheap pre-pass never archives by age alone —
 * only the LLM consolidation pass can archive, and only after safety re-checks.
 *
 * Reference: Claude Code never auto-archives by age; OpenClaw's light dream
 * deduplicates by similarity score, not age. We keep this threshold high and
 * purely as a guard for the LLM-validation step.
 */
const ARCHIVE_MIN_AGE_DAYS = 180

// ─── Content budget sent to LLM ────────────────────────────────────────────
const MAX_BODY_CHARS_PER_FILE = 800
const MAX_FILES_TO_LLM = 100

const ARCHIVE_SUBDIR = "archive"
const STATE_FILENAME = ".dream_state.json"

// ─── Types ─────────────────────────────────────────────────────────────────
interface DreamState {
  lastRunAt: number
  factCountAtLastRun: number
  /** Number of summarize calls (conversations) since last Dream run. */
  sessionsSinceLastRun: number
}

interface ArchiveOp {
  action: "archive"
  filename: string
  reason: string
}

interface MergeOp {
  action: "merge"
  /** Source files to archive after merge. */
  sources: string[]
  type: MemoryType
  filename: string
  name: string
  description: string
  content: string
}

interface CreateMetaOp {
  action: "create_meta"
  type: MemoryType
  filename: string
  name: string
  description: string
  content: string
}

interface SkipOp {
  action: "skip"
  filename: string
}

type DreamOp = ArchiveOp | MergeOp | CreateMetaOp | SkipOp

export interface ConsolidateOptions {
  model: ChatOpenAI
  memoryDir: string
}

export interface ConsolidateResult {
  archived: number
  merged: number
  created: number
  skipped: number
}

// ─── State persistence ─────────────────────────────────────────────────────
function readDreamState(memoryDir: string): DreamState {
  const path = join(memoryDir, STATE_FILENAME)
  try {
    if (existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<DreamState>
      return {
        lastRunAt: raw.lastRunAt ?? 0,
        factCountAtLastRun: raw.factCountAtLastRun ?? 0,
        sessionsSinceLastRun: raw.sessionsSinceLastRun ?? 0
      }
    }
  } catch {
    /* corrupt state — treat as first run */
  }
  return { lastRunAt: 0, factCountAtLastRun: 0, sessionsSinceLastRun: 0 }
}

/**
 * Increment the session counter in Dream state.
 * Called by the agent layer after each successful summarizeAndSave so Dream
 * can gate on "enough new conversations" before triggering.
 */
export function incrementDreamSessions(memoryDir: string): void {
  const state = readDreamState(memoryDir)
  writeDreamState(memoryDir, { ...state, sessionsSinceLastRun: state.sessionsSinceLastRun + 1 })
}

function writeDreamState(memoryDir: string, state: DreamState): void {
  try {
    writeFileSync(join(memoryDir, STATE_FILENAME), JSON.stringify(state, null, 2), "utf-8")
  } catch (e) {
    console.warn("[Dream] Failed to write state:", e instanceof Error ? e.message : e)
  }
}

/**
 * Returns true if the auto-trigger conditions are met.
 * @param currentFactCount Total per-fact files currently in the memory dir.
 */
export function shouldRunDream(memoryDir: string, currentFactCount: number): boolean {
  const state = readDreamState(memoryDir)
  const ageOk = Date.now() - state.lastRunAt >= DREAM_MIN_INTERVAL_MS
  const sessionsOk = state.sessionsSinceLastRun >= DREAM_MIN_SESSIONS
  const growthOk =
    currentFactCount - state.factCountAtLastRun >= DREAM_MIN_NEW_FACTS ||
    currentFactCount >= DREAM_MIN_TOTAL
  // Require: time gate AND (sessions gate OR growth gate).
  // The sessions gate prevents a single idle-week conversation from triggering Dream.
  return ageOk && (sessionsOk || growthOk)
}

// ─── LLM prompt ─────────────────────────────────────────────────────────────
const DREAM_SYSTEM_PROMPT = `You are a memory consolidation agent running the "dream phase".
Your job is to review existing per-fact memories and output consolidation operations.

You will receive a list of memory files, each with:
- recall_count: how many times the memory has been retrieved during conversations
- age_days: how old the memory is
- type / name / description (from frontmatter)
- body (first ~800 chars)

## Your tasks

1. **archive** — Mark a fact as obsolete so it is safely moved to an archive folder.
   Only archive when ALL of the following hold:
   - recall_count = 0 (never retrieved in any conversation)
   - age_days ≥ 90 (old enough to judge relevance)
   - type is NOT "user" (user profile facts should never be archived)
   - You are confident the fact is no longer relevant (e.g. superseded by a newer fact, describes a completed one-time task)

2. **merge** — Combine 2–3 files that describe the same topic.
   - List source filenames (they will be archived after the merge)
   - Write the merged content as a single complete fact
   - Use the same type as the sources

3. **create_meta** — Create a new high-level insight when you see 3+ facts pointing to the same pattern.
   Example: three separate feedbacks confirming the same coding preference → one authoritative meta-fact.
   - The meta-fact's content should cite the pattern clearly and note confidence

4. **skip** — Leave everything else unchanged.

## Safety rules

- NEVER archive a fact that has recall_count > 0
- NEVER archive a "user" type memory
- NEVER archive facts created less than 30 days ago (too new)
- Be conservative: when in doubt, skip
- A merge must not lose information — the merged content must be at least as complete as the sources
- create_meta should only trigger for 3+ clearly-related facts, not vague similarities

## Output format

Output ONLY a valid JSON object (no markdown fences):

{
  "operations": [
    { "action": "archive", "filename": "feedback_old.md", "reason": "Superseded by feedback_updated.md" },
    {
      "action": "merge",
      "sources": ["feedback_a.md", "feedback_b.md"],
      "type": "feedback",
      "filename": "feedback_merged.md",
      "name": "合并后的标题",
      "description": "合并后的一句话摘要",
      "content": "合并后正文（纯 markdown，不含 frontmatter）"
    },
    {
      "action": "create_meta",
      "type": "feedback",
      "filename": "feedback_meta_pattern.md",
      "name": "元模式标题",
      "description": "从 N 条记忆提炼的模式",
      "content": "正文"
    },
    { "action": "skip", "filename": "feedback_recent.md" }
  ]
}

IMPORTANT: recall_count and age_days should NOT prevent merge or create_meta operations.
Even brand-new files (age_days=0) with recall_count=0 SHOULD be merged if they clearly describe
the same topic or overlap significantly. Only the "archive" operation requires the age/recall gates
listed above. When you see files with very similar names, descriptions, or content — merge them.
When you see 3+ files pointing to a common pattern — create a meta-fact.

If there is genuinely nothing to consolidate, return { "operations": [] }.
Use the same language as the memory content (Chinese for Chinese content).`

// ─── Prompt builder ─────────────────────────────────────────────────────────
function buildDreamPrompt(
  headers: MemoryHeader[],
  recallMap: Map<string, { totalRecalls: number; lastRecalledAt: number | null }>
): string {
  const now = Date.now()
  const lines: string[] = ["MEMORY FILES:\n"]

  for (const h of headers.slice(0, MAX_FILES_TO_LLM)) {
    const stats = recallMap.get(h.filePath)
    const recallCount = stats?.totalRecalls ?? 0
    const ageDays = Math.floor((now - h.mtimeMs) / (1000 * 60 * 60 * 24))

    let body = ""
    try {
      const raw = readFileSync(h.filePath, "utf-8")
      // Strip frontmatter for the body excerpt
      const bodyStart = raw.indexOf("---\n", 4)
      const bodyText = bodyStart !== -1 ? raw.slice(bodyStart + 4).trimStart() : raw
      body =
        bodyText.length > MAX_BODY_CHARS_PER_FILE
          ? bodyText.slice(0, MAX_BODY_CHARS_PER_FILE) + "…"
          : bodyText
    } catch {
      /* unreadable */
    }

    lines.push(`### ${h.filename}`)
    lines.push(`type: ${h.type} | recall_count: ${recallCount} | age_days: ${ageDays}`)
    lines.push(`name: ${h.name}`)
    lines.push(`description: ${h.description}`)
    if (body) lines.push(`\n${body}`)
    lines.push("---")
  }

  lines.push("\nOutput the JSON consolidation operations now.")
  return lines.join("\n")
}

// ─── Response parsing ────────────────────────────────────────────────────────
function parseOps(raw: string): DreamOp[] {
  let cleaned = raw.replace(/<think>[\s\S]*?<\/think>\s*/g, "").trim()
  cleaned = cleaned
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim()
  const start = cleaned.indexOf("{")
  const end = cleaned.lastIndexOf("}")
  if (start === -1 || end === -1) return []
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as { operations?: unknown }
    if (!Array.isArray(parsed.operations)) return []
    return parsed.operations.filter(isValidOp)
  } catch (e) {
    console.warn("[Dream] Failed to parse response:", e instanceof Error ? e.message : e)
    return []
  }
}

function isValidOp(o: unknown): o is DreamOp {
  if (!o || typeof o !== "object") return false
  const op = o as Record<string, unknown>
  if (op.action === "archive") {
    return typeof op.filename === "string" && op.filename.endsWith(".md")
  }
  if (op.action === "merge") {
    return (
      Array.isArray(op.sources) &&
      op.sources.length >= 2 &&
      typeof op.type === "string" &&
      typeof op.name === "string" &&
      typeof op.content === "string" &&
      op.content.length > 0
    )
  }
  if (op.action === "create_meta") {
    return (
      typeof op.type === "string" &&
      typeof op.name === "string" &&
      typeof op.content === "string" &&
      op.content.length > 0
    )
  }
  if (op.action === "skip") {
    return typeof op.filename === "string"
  }
  return false
}

// ─── Operation appliers ──────────────────────────────────────────────────────
function archiveFile(memoryDir: string, filename: string, reason: string): boolean {
  const safe = basename(filename)
  if (!safe.endsWith(".md") || safe === "MEMORY.md" || safe.startsWith(".")) return false

  const src = join(memoryDir, safe)
  if (!existsSync(src)) return false

  const archiveDir = join(memoryDir, ARCHIVE_SUBDIR)
  if (!existsSync(archiveDir)) mkdirSync(archiveDir, { recursive: true })

  // Avoid clobbering existing archive entries
  let dest = join(archiveDir, safe)
  if (existsSync(dest)) {
    const ts = Date.now()
    dest = join(archiveDir, safe.replace(/\.md$/, `_${ts}.md`))
  }

  try {
    renameSync(src, dest)
    console.log(`[Dream] Archived ${safe} → archive/ (${reason})`)
    return true
  } catch (e) {
    console.warn("[Dream] Failed to archive", safe, ":", e instanceof Error ? e.message : e)
    return false
  }
}

function applyMerge(
  memoryDir: string,
  op: MergeOp,
  existingFilenames: Set<string>
): { created: string | null; archived: string[] } {
  const type = parseMemoryType(op.type)
  if (!type) return { created: null, archived: [] }

  // Determine merged file name
  let filename = op.filename ?? ""
  if (!filename || !isValidFactFilename(filename, type)) {
    filename = generateFactFilename(op.name, type)
  }
  // Avoid collision
  const isTaken = (name: string) => existingFilenames.has(name) || existsSync(join(memoryDir, name))
  if (isTaken(filename)) {
    let i = 2
    while (isTaken(filename.replace(/\.md$/, `_${i}.md`))) i++
    filename = filename.replace(/\.md$/, `_${i}.md`)
  }

  // Write merged file
  const fm = buildFrontmatter({ name: op.name, description: op.description ?? "", type })
  const body = op.content.trim()
  try {
    writeFileSync(join(memoryDir, filename), fm + body + "\n", "utf-8")
    existingFilenames.add(filename)
  } catch (e) {
    console.warn("[Dream] Failed to write merged file:", e instanceof Error ? e.message : e)
    return { created: null, archived: [] }
  }

  // Archive source files
  const archived: string[] = []
  for (const src of op.sources) {
    const ok = archiveFile(memoryDir, src, `merged into ${filename}`)
    if (ok) {
      existingFilenames.delete(basename(src))
      archived.push(src)
    }
  }

  return { created: join(memoryDir, filename), archived }
}

function applyCreateMeta(
  memoryDir: string,
  op: CreateMetaOp,
  existingFilenames: Set<string>
): string | null {
  const type = parseMemoryType(op.type)
  if (!type) return null

  let filename = op.filename ?? ""
  if (!filename || !isValidFactFilename(filename, type)) {
    filename = generateFactFilename(op.name, type)
  }
  const isTaken = (name: string) => existingFilenames.has(name) || existsSync(join(memoryDir, name))
  if (isTaken(filename)) {
    let i = 2
    while (isTaken(filename.replace(/\.md$/, `_${i}.md`))) i++
    filename = filename.replace(/\.md$/, `_${i}.md`)
  }

  const fm = buildFrontmatter({ name: op.name, description: op.description ?? "", type })
  try {
    writeFileSync(join(memoryDir, filename), fm + op.content.trim() + "\n", "utf-8")
    existingFilenames.add(filename)
    return join(memoryDir, filename)
  } catch (e) {
    console.warn("[Dream] Failed to write meta-fact:", e instanceof Error ? e.message : e)
    return null
  }
}

// ─── Pre-pass: identify candidates worth sending to LLM ─────────────────────
/**
 * Filter headers to files that are worth including in the Dream LLM prompt.
 * This is NOT about auto-archiving (reference implementations don't do that) —
 * it's about reducing the prompt size to a manageable set of candidates.
 *
 * Priority (descending):
 *   1. Files with potential duplicates (same type + very similar name prefix)
 *   2. Old files with recall_count = 0 (consolidation candidates)
 *   3. Recently updated files (may have superseded older facts)
 *
 * Returns at most MAX_FILES_TO_LLM headers, covering all types.
 */
function selectCandidatesForLLM(
  headers: MemoryHeader[],
  recallMap: Map<string, { totalRecalls: number; lastRecalledAt: number | null }>
): MemoryHeader[] {
  if (headers.length <= MAX_FILES_TO_LLM) return headers

  const now = Date.now()
  // Score each file: higher score = more interesting to the consolidator
  const scored = headers.map((h) => {
    const stats = recallMap.get(h.filePath)
    const recalls = stats?.totalRecalls ?? 0
    const ageDays = (now - h.mtimeMs) / (1000 * 60 * 60 * 24)
    // Interesting if: 0 recalls + old, or recently modified, or has potential peers
    let score = 0
    if (recalls === 0 && ageDays > 30) score += 2 // unaccessed + aging
    if (ageDays < 7) score += 1 // recently updated
    if (recalls > 5) score += 1 // frequently recalled (merge target)
    return { h, score }
  })

  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, MAX_FILES_TO_LLM).map((s) => s.h)
}

// ─── Dream serialization queue ───────────────────────────────────────────────
let dreamQueue: Promise<void> = Promise.resolve()

export function consolidateMemories(options: ConsolidateOptions): Promise<ConsolidateResult> {
  let resolve!: (r: ConsolidateResult) => void
  const resultP = new Promise<ConsolidateResult>((res) => {
    resolve = res
  })

  const next = dreamQueue.then(async () => {
    const result = await consolidateInner(options)
    resolve(result)
  })
  dreamQueue = next.catch(() => undefined)
  return resultP
}

async function consolidateInner(options: ConsolidateOptions): Promise<ConsolidateResult> {
  const { model, memoryDir } = options
  const result: ConsolidateResult = { archived: 0, merged: 0, created: 0, skipped: 0 }

  if (!existsSync(memoryDir)) return result

  try {
    const store = await getMemoryStore(memoryDir)
    const recallMap = store.getRecallStats()

    const allHeaders = scanMemoryFiles(memoryDir)
    if (allHeaders.length === 0) {
      writeDreamState(memoryDir, {
        lastRunAt: Date.now(),
        factCountAtLastRun: 0,
        sessionsSinceLastRun: 0
      })
      return result
    }

    // Select which files are interesting enough to include in the LLM prompt.
    // We never auto-archive by age alone — only the LLM decides what to consolidate.
    const candidates = selectCandidatesForLLM(allHeaders, recallMap)
    const userPrompt = buildDreamPrompt(candidates, recallMap)

    const response = await model.invoke([
      new SystemMessage(DREAM_SYSTEM_PROMPT),
      new HumanMessage(userPrompt)
    ])

    const raw =
      typeof response.content === "string" ? response.content : JSON.stringify(response.content)
    const ops = parseOps(raw)

    const existingFilenames = new Set(allHeaders.map((h) => h.filename))
    const touchedPaths: string[] = []

    for (const op of ops) {
      try {
        if (op.action === "archive") {
          // LLM-suggested archive: validate against safety rules first
          const header = allHeaders.find((h) => h.filename === basename(op.filename))
          if (!header) continue
          if (header.type === "user") {
            console.log(`[Dream] Skipping LLM archive of user-type file: ${op.filename}`)
            continue
          }
          const stats = recallMap.get(header.filePath)
          if ((stats?.totalRecalls ?? 0) > 0) {
            console.log(`[Dream] Skipping LLM archive of recalled file: ${op.filename}`)
            continue
          }
          const ageDays = (Date.now() - header.mtimeMs) / (1000 * 60 * 60 * 24)
          if (ageDays < ARCHIVE_MIN_AGE_DAYS) {
            console.log(
              `[Dream] Skipping LLM archive of recent file (${Math.floor(ageDays)}d): ${op.filename}`
            )
            continue
          }
          const ok = archiveFile(memoryDir, op.filename, op.reason)
          if (ok) {
            existingFilenames.delete(basename(op.filename))
            result.archived++
          }
        } else if (op.action === "merge") {
          const { created, archived } = applyMerge(memoryDir, op, existingFilenames)
          if (created) {
            touchedPaths.push(created)
            result.merged++
            result.archived += archived.length
          }
        } else if (op.action === "create_meta") {
          const created = applyCreateMeta(memoryDir, op, existingFilenames)
          if (created) {
            touchedPaths.push(created)
            result.created++
          }
        } else if (op.action === "skip") {
          result.skipped++
        }
      } catch (e) {
        console.warn("[Dream] Failed to apply op:", op.action, e instanceof Error ? e.message : e)
      }
    }

    // Re-index touched files + remove archived ones from search store
    for (const p of touchedPaths) {
      try {
        if (existsSync(p)) store.addDocument(p, readFileSync(p, "utf-8"))
      } catch {
        /* non-critical */
      }
    }
    // Remove archived files from the store (they moved to archive/ subdir)
    const afterHeaders = scanMemoryFiles(memoryDir)
    const afterPaths = new Set(afterHeaders.map((h) => h.filePath))
    for (const h of allHeaders) {
      if (!afterPaths.has(h.filePath)) {
        try {
          store.removeDocument(h.filePath)
        } catch {
          /* non-critical */
        }
      }
    }

    // Persist Dream state
    writeDreamState(memoryDir, {
      lastRunAt: Date.now(),
      factCountAtLastRun: afterHeaders.length,
      sessionsSinceLastRun: 0 // reset after a successful Dream run
    })

    console.log(
      `[Dream] Complete — archived: ${result.archived}, merged: ${result.merged}, ` +
        `created: ${result.created}, skipped: ${result.skipped}`
    )

    if (result.archived > 0 || result.merged > 0 || result.created > 0) {
      try {
        notifyMemoryChanged()
      } catch (e) {
        console.warn(
          "[Dream] Failed to broadcast memory:changed:",
          e instanceof Error ? e.message : e
        )
      }
    }
  } catch (e) {
    console.warn("[Dream] Failed:", e instanceof Error ? e.message : e)
  }

  return result
}
