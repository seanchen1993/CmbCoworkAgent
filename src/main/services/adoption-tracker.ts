/**
 * Adoption Tracker
 *
 * Captures "code generation" events from agent write/edit tools, measures
 * "adoption" outcomes from three sources (10-minute timer, workspace file
 * changes, git commits), and reports both as telemetry events via the
 * existing `event-reporter` pipeline.
 *
 * ── Design guarantees ────────────────────────────────────
 *   1. Side-effect only. Every public entry point is non-blocking and wraps
 *      its body in try/catch. A failure in the tracker must NEVER surface
 *      into the main tool-invocation / git-commit / watcher flows.
 *   2. Performance. Line-level hashing uses a lightweight FNV-1a 32-bit
 *      function; no new deps; no per-line crypto hashing.
 *   3. Local first, upload best-effort. JSONL shards on disk are the
 *      durable log; uploads reuse `trackEvent()` which is fire-and-forget.
 *   4. Only code files are tracked (whitelist + build-output blacklist).
 *
 * ── Storage layout ───────────────────────────────────────
 *   ~/.cmbcoworkagent/adoption/
 *     current.jsonl                ← append-only, rotated on size/age
 *     YYYY-MM-DDTHH-MM-SS.jsonl    ← sealed shards
 *   ~/.cmbcoworkagent/adoption-index.sqlite
 *     └─ gen_events                ← lookup index for commit-time L3
 *
 *   Retention: 7 days / 100 MB hard cap.
 */

import { appendFile, readdir, readFile, stat, unlink, rename } from "fs/promises"
import { existsSync, mkdirSync } from "fs"
import { extname, join, relative, resolve as resolvePath } from "path"
import { randomUUID } from "crypto"
import { getOpenworkDir } from "../storage"
import { trackEvent } from "./event-reporter"
import {
  closeAdoptionIndex,
  findPendingDueBefore,
  findPendingGenForFile,
  flushAdoptionIndex,
  initializeAdoptionIndex,
  insertGenEvent,
  markMeasured,
  deleteOlderThan
} from "./adoption-index"

// ─────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────

const L2_MEASURE_DELAY_MS = 10 * 60 * 1000 // 10 minutes
const L2_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const SWEEP_INTERVAL_MS = 5 * 60 * 1000 // heartbeat cadence — 5min; L2 延迟 10min 足够容忍
const SHARD_SIZE_LIMIT_BYTES = 10 * 1024 * 1024 // 10 MB per shard
const SHARD_MAX_AGE_MS = 30 * 60 * 1000 // rotate every 30 min
const DISK_HARD_CAP_BYTES = 100 * 1024 * 1024 // 100 MB
const MAX_LINES_FOR_MEASURE = 3000 // skip giant files (applied symmetrically at gen + measure)
const MAX_CONTEXT_ENTRIES = 32 // bound in-memory context size

const CODE_EXTENSIONS = new Set<string>([
  // Frontend
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "vue",
  "svelte",
  "html",
  "css",
  "scss",
  "sass",
  "less",
  // Backend
  "py",
  "go",
  "rs",
  "java",
  "kt",
  "scala",
  "rb",
  "php",
  "c",
  "cc",
  "cpp",
  "h",
  "hpp",
  "cs",
  "swift",
  "m",
  "mm",
  // Scripts & data
  "sh",
  "bash",
  "zsh",
  "sql",
  "lua",
  "r",
  "dart",
  // Markup / templates
  "proto",
  "graphql",
  "tf",
  // Config (user said xml/yaml are legitimate config code)
  "xml",
  "yaml",
  "yml"
])

const EXCLUDED_PATH_SEGMENTS = [
  "node_modules",
  "dist",
  "build",
  "out",
  ".next",
  "__pycache__",
  "target",
  ".venv",
  "venv",
  ".git",
  "coverage"
]

const EXCLUDED_FILENAME_PATTERNS = [
  /package-lock\.json$/i,
  /pnpm-lock\.yaml$/i,
  /yarn\.lock$/i,
  /\.min\.(js|css)$/i,
  /\.map$/i
]

// ─────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────

export interface AdoptionContext {
  traceId?: string
  modelId?: string
  modelName?: string
  usedSkills?: string[]
  primarySkill?: string | null
}

export interface RecordGenInput {
  threadId: string
  tool: "write_file" | "edit_file"
  /** Absolute or workspace-relative path (tracker resolves it). */
  filePath: string
  /** The content that was written (write_file) or the new_string (edit_file). */
  generatedContent: string
  /** Optional: when provided, stepIndex is included in the gen event. */
  stepIndex?: number
  /** Optional: workspace root — used to turn absolute path into relative. */
  workspacePath?: string
}

interface JsonlGenEntry {
  t: "gen"
  eventId: string
  threadId: string
  traceId?: string
  filePath: string
  lineCount: number
  lineHashes: string // hex string of packed UInt32 hashes
  fingerprint: string
  createdAt: number
}

// ─────────────────────────────────────────────────────────
// Module state
// ─────────────────────────────────────────────────────────

let initialized = false
let sweepTimer: NodeJS.Timeout | null = null
let currentShardPath: string | null = null
let currentShardSize = 0
let currentShardStartMs = 0

/** threadId → AdoptionContext. Evicted oldest-first at MAX_CONTEXT_ENTRIES. */
const threadContexts = new Map<string, AdoptionContext>()

// ─────────────────────────────────────────────────────────
// Paths
// ─────────────────────────────────────────────────────────

function getAdoptionDir(): string {
  const dir = join(getOpenworkDir(), "adoption")
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function getCurrentShardPath(): string {
  return join(getAdoptionDir(), "current.jsonl")
}

function generateSealedShardName(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "")
  return join(getAdoptionDir(), `${ts}.jsonl`)
}

// ─────────────────────────────────────────────────────────
// File-type filtering
// ─────────────────────────────────────────────────────────

export function isCodeFile(filePath: string): boolean {
  if (!filePath) return false
  const ext = extname(filePath).slice(1).toLowerCase()
  if (!CODE_EXTENSIONS.has(ext)) return false

  const normalized = filePath.replace(/\\/g, "/").toLowerCase()
  for (const seg of EXCLUDED_PATH_SEGMENTS) {
    if (normalized.includes(`/${seg}/`) || normalized.endsWith(`/${seg}`)) return false
  }
  for (const re of EXCLUDED_FILENAME_PATTERNS) {
    if (re.test(normalized)) return false
  }
  return true
}

// ─────────────────────────────────────────────────────────
// Line hashing (FNV-1a 32-bit) + normalisation
// ─────────────────────────────────────────────────────────

function fnv1a32(input: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
  }
  return h >>> 0
}

function normalizeLine(line: string): string {
  return line.trim().replace(/\s+/g, " ")
}

function computeLineHashes(content: string): Uint32Array {
  const lines = content.split(/\r?\n/)
  const hashes: number[] = []
  for (const raw of lines) {
    const norm = normalizeLine(raw)
    if (norm.length === 0) continue // skip blank lines — noise for matching
    hashes.push(fnv1a32(norm))
  }
  return new Uint32Array(hashes)
}

function packLineHashes(hashes: Uint32Array): Uint8Array {
  return new Uint8Array(hashes.buffer, hashes.byteOffset, hashes.byteLength)
}

function unpackLineHashes(bytes: Uint8Array): Uint32Array {
  const copy = new Uint8Array(bytes.length)
  copy.set(bytes)
  return new Uint32Array(copy.buffer)
}

function hashesToHex(hashes: Uint32Array): string {
  // 8 hex chars per u32, compact for JSONL
  const parts: string[] = []
  for (let i = 0; i < hashes.length; i++) {
    parts.push(hashes[i].toString(16).padStart(8, "0"))
  }
  return parts.join("")
}

function contentFingerprint(content: string): string {
  // Cheap whole-content 32-bit fingerprint (not cryptographic — just a quick diff hint).
  return fnv1a32(content).toString(16).padStart(8, "0")
}

// ─────────────────────────────────────────────────────────
// Context (set by TraceCollector during agent lifecycle)
// ─────────────────────────────────────────────────────────

export function setAdoptionContext(threadId: string, ctx: AdoptionContext): void {
  if (!threadId) return
  // Evict oldest if size cap would be exceeded (Map preserves insertion order).
  if (!threadContexts.has(threadId) && threadContexts.size >= MAX_CONTEXT_ENTRIES) {
    const oldest = threadContexts.keys().next().value
    if (oldest !== undefined) threadContexts.delete(oldest)
  }
  // Merge so a later setUsedSkills call doesn't wipe modelId set earlier.
  const prior = threadContexts.get(threadId)
  threadContexts.set(threadId, { ...(prior ?? {}), ...ctx })
}

export function clearAdoptionContext(threadId: string): void {
  threadContexts.delete(threadId)
}

function getContext(threadId: string): AdoptionContext {
  return threadContexts.get(threadId) ?? {}
}

// ─────────────────────────────────────────────────────────
// Shard rotation / retention
// ─────────────────────────────────────────────────────────

async function maybeRotateShard(): Promise<void> {
  const shardPath = getCurrentShardPath()
  if (!existsSync(shardPath)) return

  const shouldRotateBySize = currentShardSize >= SHARD_SIZE_LIMIT_BYTES
  const shouldRotateByAge = Date.now() - currentShardStartMs >= SHARD_MAX_AGE_MS

  if (!shouldRotateBySize && !shouldRotateByAge) return

  try {
    const sealed = generateSealedShardName()
    await rename(shardPath, sealed)
    currentShardPath = null
    currentShardSize = 0
    currentShardStartMs = 0
  } catch (e) {
    console.warn("[AdoptionTracker] rotate failed:", e)
  }
}

async function enforceRetention(): Promise<void> {
  const dir = getAdoptionDir()
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return
  }

  const cutoff = Date.now() - L2_RETENTION_MS
  interface ShardStat {
    name: string
    mtimeMs: number
    size: number
  }
  const shards: ShardStat[] = []

  for (const name of entries) {
    if (!name.endsWith(".jsonl")) continue
    if (name === "current.jsonl") continue
    try {
      const st = await stat(join(dir, name))
      shards.push({ name, mtimeMs: st.mtimeMs, size: st.size })
    } catch {
      // ignore
    }
  }

  // Age-based deletion
  for (const s of shards) {
    if (s.mtimeMs < cutoff) {
      try {
        await unlink(join(dir, s.name))
      } catch {
        // ignore
      }
    }
  }

  // Size-based deletion (keep newest until under cap)
  const remaining = shards.filter((s) => s.mtimeMs >= cutoff)
  let total = remaining.reduce((acc, s) => acc + s.size, 0)
  if (total > DISK_HARD_CAP_BYTES) {
    remaining.sort((a, b) => a.mtimeMs - b.mtimeMs) // oldest first
    for (const s of remaining) {
      if (total <= DISK_HARD_CAP_BYTES) break
      try {
        await unlink(join(dir, s.name))
        total -= s.size
      } catch {
        // ignore
      }
    }
  }

  // Also clean old index rows
  try {
    deleteOlderThan(cutoff)
  } catch {
    // ignore
  }
}

// ─────────────────────────────────────────────────────────
// JSONL writer
// ─────────────────────────────────────────────────────────

async function appendJsonl(entry: unknown): Promise<{ shardFile: string; offset: number }> {
  const shardPath = getCurrentShardPath()
  if (currentShardPath !== shardPath) {
    currentShardPath = shardPath
    currentShardSize = existsSync(shardPath) ? (await stat(shardPath)).size : 0
    if (currentShardSize === 0) currentShardStartMs = Date.now()
  }
  const line = JSON.stringify(entry) + "\n"
  const offset = currentShardSize
  await appendFile(shardPath, line, "utf-8")
  currentShardSize += Buffer.byteLength(line, "utf-8")
  // Size / age rotation is checked on next sweep — avoid fs stat on hot path.
  return { shardFile: shardPath, offset }
}

// ─────────────────────────────────────────────────────────
// Public API — side-effect only
// ─────────────────────────────────────────────────────────

/**
 * Called by LocalSandbox after a successful write_file / edit_file.
 * Never throws; never blocks the caller (returns synchronously).
 */
export function recordGen(input: RecordGenInput): void {
  if (!initialized) return
  queueMicrotask(() => {
    doRecordGen(input).catch((e) => {
      console.warn("[AdoptionTracker] recordGen unexpected error:", e)
    })
  })
}

async function doRecordGen(input: RecordGenInput): Promise<void> {
  try {
    if (!isCodeFile(input.filePath)) return

    const absPath = input.workspacePath
      ? resolvePath(input.workspacePath, input.filePath)
      : resolvePath(input.filePath)

    const relPath = input.workspacePath
      ? relative(input.workspacePath, absPath).replace(/\\/g, "/")
      : absPath.replace(/\\/g, "/")

    // ── Cheap upper-bound line count check (skip hashing for giant baselines) ──
    // Counts every physical line incl. blanks — non-blank count can only be ≤ this.
    // If this already exceeds the cap, we short-circuit: emit L1 + terminal
    // `skipped_large` adopt event and skip hashing / JSONL / sqlite entirely.
    const rawLineCount = input.generatedContent.split(/\r?\n/).length
    const eventId = `g_${randomUUID()}`
    const createdAt = Date.now()

    if (rawLineCount > MAX_LINES_FOR_MEASURE) {
      emitSkippedLargeAtGen({
        eventId,
        input,
        absPath,
        relPath,
        lineCount: rawLineCount,
        createdAt
      })
      return
    }

    const hashes = computeLineHashes(input.generatedContent)
    if (hashes.length === 0) return // empty-after-normalization → nothing worth tracking

    // Non-blank line count may still exceed threshold only when rawLineCount is
    // already close; stay symmetric with the measure-time check.
    if (hashes.length > MAX_LINES_FOR_MEASURE) {
      emitSkippedLargeAtGen({
        eventId,
        input,
        absPath,
        relPath,
        lineCount: hashes.length,
        createdAt
      })
      return
    }

    const fingerprint = contentFingerprint(input.generatedContent)

    // ── JSONL record ────────────────────────────────────
    const jsonlEntry: JsonlGenEntry = {
      t: "gen",
      eventId,
      threadId: input.threadId,
      traceId: getContext(input.threadId).traceId,
      filePath: absPath,
      lineCount: hashes.length,
      lineHashes: hashesToHex(hashes),
      fingerprint,
      createdAt
    }
    const { shardFile, offset } = await appendJsonl(jsonlEntry)

    // ── Index row ───────────────────────────────────────
    insertGenEvent({
      event_id: eventId,
      file_path: absPath,
      content_fingerprint: fingerprint,
      shard_file: shardFile,
      shard_offset: offset,
      line_hashes: packLineHashes(hashes),
      created_at: createdAt,
      measured: 0
    })

    // ── Cloud event (metadata only) ─────────────────────
    const ctx = getContext(input.threadId)
    trackEvent("code_gen", "code_adoption", {
      schemaVersion: 1,
      eventId,
      threadId: input.threadId,
      traceId: ctx.traceId,
      stepIndex: input.stepIndex,
      tool: input.tool,
      language: extname(absPath).slice(1).toLowerCase() || null,
      lineCount: hashes.length,
      usedSkills: ctx.usedSkills ?? [],
      primarySkill: ctx.primarySkill ?? null,
      modelId: ctx.modelId ?? null,
      modelName: ctx.modelName ?? null,
      // note: filePath / content / fingerprint intentionally withheld
      createdAt: new Date(createdAt).toISOString(),
      relativeHint: relPath.split("/").slice(-1)[0] // leaf filename only, not a full path
    })
  } catch (e) {
    console.warn("[AdoptionTracker] doRecordGen failed:", e)
  }
}

/**
 * Emit the L1 `code_gen` + a terminal `code_adopt(skipped_large)` pair for a
 * generation whose baseline exceeded `MAX_LINES_FOR_MEASURE`. Skips JSONL and
 * sqlite index so we do not blow up local storage with giant BLOBs.
 */
function emitSkippedLargeAtGen(args: {
  eventId: string
  input: RecordGenInput
  absPath: string
  relPath: string
  lineCount: number
  createdAt: number
}): void {
  const { eventId, input, absPath, relPath, lineCount, createdAt } = args
  const ctx = getContext(input.threadId)
  const language = extname(absPath).slice(1).toLowerCase() || null

  // L1 — record that the agent generated code (metadata only, no path/content)
  trackEvent("code_gen", "code_adoption", {
    schemaVersion: 1,
    eventId,
    threadId: input.threadId,
    traceId: ctx.traceId,
    stepIndex: input.stepIndex,
    tool: input.tool,
    language,
    lineCount,
    usedSkills: ctx.usedSkills ?? [],
    primarySkill: ctx.primarySkill ?? null,
    modelId: ctx.modelId ?? null,
    modelName: ctx.modelName ?? null,
    createdAt: new Date(createdAt).toISOString(),
    relativeHint: relPath.split("/").slice(-1)[0]
  })

  // Terminal L2/L3 equivalent — no hashing possible, so mark skipped_large now.
  trackEvent("code_adopt", "code_adoption", {
    schemaVersion: 1,
    eventId: `a_${randomUUID()}`,
    genEventId: eventId,
    threadId: input.threadId,
    traceId: ctx.traceId ?? null,
    verdict: "skipped_large",
    diffRatio: null,
    measureSource: "gen_oversize",
    measureLatencyMs: 0,
    measuredAt: new Date(createdAt).toISOString(),
    commitSha: null
  })
}

/**
 * Measure a specific file against the most recent unmeasured gen event.
 * Produces a `code_adopt` event if a pending gen is found. Never throws.
 */
function measureFile(
  filePath: string,
  source: "timer_10m" | "watcher_change" | "watcher_unlink" | "git_commit" | "session_end",
  opts?: {
    currentContent?: string // callers may supply the already-read content
    verdictOverride?: "deleted"
    commitSha?: string
  }
): void {
  if (!initialized) return
  queueMicrotask(() => {
    doMeasureFile(filePath, source, opts).catch((e) => {
      console.warn("[AdoptionTracker] measureFile unexpected error:", e)
    })
  })
}

async function doMeasureFile(
  filePath: string,
  source: "timer_10m" | "watcher_change" | "watcher_unlink" | "git_commit" | "session_end",
  opts?: { currentContent?: string; verdictOverride?: "deleted"; commitSha?: string }
): Promise<void> {
  try {
    const absPath = resolvePath(filePath)
    const minCreated = Date.now() - L2_RETENTION_MS
    const pending = findPendingGenForFile(absPath, minCreated)
    if (!pending) return

    // Compute diffRatio (0..100)
    let verdict: "measured" | "deleted" | "committed" | "skipped_large" = "measured"
    let diffRatio: number | null = null

    if (opts?.verdictOverride === "deleted") {
      verdict = "deleted"
      diffRatio = 0
    } else {
      const storedHashes = pending.line_hashes ? unpackLineHashes(pending.line_hashes) : null
      if (!storedHashes || storedHashes.length === 0) {
        // No baseline — nothing to compare against
        return
      }
      if (storedHashes.length > MAX_LINES_FOR_MEASURE) {
        verdict = "skipped_large"
        diffRatio = null
      } else {
        let current = opts?.currentContent
        if (current === undefined) {
          try {
            current = await readFile(absPath, "utf-8")
          } catch {
            // File unreadable — treat as deleted
            verdict = "deleted"
            diffRatio = 0
          }
        }
        if (verdict === "measured" && current !== undefined) {
          const currentHashes = computeLineHashes(current)
          diffRatio = computeDiffRatio(storedHashes, currentHashes)
          if (source === "git_commit") verdict = "committed"
        }
      }
    }

    // Write adoption record to JSONL
    const adoptEventId = `a_${randomUUID()}`
    const measuredAt = Date.now()
    await appendJsonl({
      t: "adopt",
      eventId: adoptEventId,
      genEventId: pending.event_id,
      verdict,
      diffRatio,
      measureSource: source,
      measuredAt,
      commitSha: opts?.commitSha ?? null
    })

    markMeasured(pending.event_id)

    // Cloud event
    const threadCtx: AdoptionContext = {} // best-effort — context may already be cleared
    trackEvent("code_adopt", "code_adoption", {
      schemaVersion: 1,
      eventId: adoptEventId,
      genEventId: pending.event_id,
      threadId: null, // not carried on the index row
      traceId: threadCtx.traceId ?? null,
      verdict,
      diffRatio,
      measureSource: source,
      measureLatencyMs: measuredAt - pending.created_at,
      measuredAt: new Date(measuredAt).toISOString(),
      commitSha: opts?.commitSha ?? null
    })
  } catch (e) {
    console.warn("[AdoptionTracker] doMeasureFile failed:", e)
  }
}

/**
 * Compute a percentage [0..100] of how many baseline lines still appear in
 * the current file (multiset intersection on FNV hashes).
 */
function computeDiffRatio(baseline: Uint32Array, current: Uint32Array): number {
  if (baseline.length === 0) return 0
  const counts = new Map<number, number>()
  for (let i = 0; i < current.length; i++) {
    const h = current[i]
    counts.set(h, (counts.get(h) ?? 0) + 1)
  }
  let kept = 0
  for (let i = 0; i < baseline.length; i++) {
    const h = baseline[i]
    const c = counts.get(h)
    if (c && c > 0) {
      kept++
      counts.set(h, c - 1)
    }
  }
  const ratio = (kept / baseline.length) * 100
  return Math.round(ratio * 100) / 100 // two decimals
}

// ─────────────────────────────────────────────────────────
// External notification entry points
// ─────────────────────────────────────────────────────────

/** Called by workspace-watcher on any content-changing event. */
export function notifyFileChange(absPath: string): void {
  if (!isCodeFile(absPath)) return
  measureFile(absPath, "watcher_change")
}

/** Called by workspace-watcher on deletion. */
export function notifyFileUnlink(absPath: string): void {
  if (!isCodeFile(absPath)) return
  measureFile(absPath, "watcher_unlink", { verdictOverride: "deleted" })
}

/**
 * Called by git IPC commit handler before the actual `git commit` is
 * executed. Best-effort measurement of each staged code file against its
 * most recent unmeasured gen event. Returns immediately; work happens in
 * background microtasks.
 */
export function measureForCommit(stagedAbsolutePaths: string[], commitSha?: string): void {
  if (!initialized) return
  for (const absPath of stagedAbsolutePaths) {
    if (!isCodeFile(absPath)) continue
    measureFile(absPath, "git_commit", { commitSha })
  }
}

// ─────────────────────────────────────────────────────────
// Sweep (heartbeat-like, but internal — not the user-facing heartbeat)
// ─────────────────────────────────────────────────────────

async function sweep(): Promise<void> {
  if (!initialized) return
  try {
    // 1. Measure pending items that are past the 10-minute due time.
    const dueAt = Date.now() - L2_MEASURE_DELAY_MS
    const dueItems = findPendingDueBefore(dueAt, 50)
    for (const item of dueItems) {
      measureFile(item.file_path, "timer_10m")
    }

    // 2. Rotate current shard if size / age triggers.
    await maybeRotateShard()

    // 3. Enforce retention.
    await enforceRetention()

    // 4. Persist sqlite changes.
    flushAdoptionIndex()
  } catch (e) {
    console.warn("[AdoptionTracker] sweep failed:", e)
  }
}

// ─────────────────────────────────────────────────────────
// Lifecycle
// ─────────────────────────────────────────────────────────

export async function initializeAdoptionTracker(): Promise<void> {
  if (initialized) return
  try {
    getAdoptionDir() // ensure dir exists
    await initializeAdoptionIndex()
    initialized = true

    sweepTimer = setInterval(() => {
      sweep().catch((e) => console.warn("[AdoptionTracker] sweep error:", e))
    }, SWEEP_INTERVAL_MS)
    if (typeof sweepTimer.unref === "function") sweepTimer.unref()

    console.log("[AdoptionTracker] initialized")
  } catch (e) {
    console.warn("[AdoptionTracker] init failed — tracker disabled:", e)
    initialized = false
  }
}

export function shutdownAdoptionTracker(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer)
    sweepTimer = null
  }
  try {
    flushAdoptionIndex()
    closeAdoptionIndex()
  } catch {
    // ignore
  }
  threadContexts.clear()
  initialized = false
}
