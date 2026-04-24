/**
 * Adoption Tracker
 *
 * Captures "code generation" events from agent write/edit tools, measures
 * "adoption" outcomes at git commit time (plus a terminal `skipped_large`
 * verdict for oversize baselines), and reports both as telemetry events via
 * the existing `event-reporter` pipeline. A former 10-minute retention timer
 * was removed — its I/O fanout outweighed its signal value.
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
import { execFileSync } from "child_process"
import * as iconv from "iconv-lite"
import * as chardet from "jschardet"
import { getOpenworkDir } from "../storage"
import { ensureVersionedSkillIdentifier } from "../utils/skill-identifiers"
import { trackEvent } from "./event-reporter"
import {
  closeAdoptionIndex,
  findPendingGenForFile,
  flushAdoptionIndex,
  initializeAdoptionIndex,
  insertGenEvent,
  markMeasured,
  deleteOlderThan,
  deleteMeasuredOlderThan,
  trimToRowCap,
  vacuumAdoptionIndex
} from "./adoption-index"

// ─────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────

// Longest window during which a pending gen row is still eligible to be matched
// against a future git commit. Older rows are dropped by retention. (Previously
// also doubled as the L2 timer window — L2 has been removed, this is now purely
// "how long do we keep a baseline around for commit-time attribution".)
const GEN_ATTRIBUTION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
const SWEEP_INTERVAL_MS = 5 * 60 * 1000 // shard rotation / retention / VACUUM cadence
const SHARD_SIZE_LIMIT_BYTES = 10 * 1024 * 1024 // 10 MB per shard
const SHARD_MAX_AGE_MS = 30 * 60 * 1000 // rotate every 30 min
const DISK_HARD_CAP_BYTES = 100 * 1024 * 1024 // 100 MB
const MAX_LINES_FOR_MEASURE = 3000 // skip giant files (applied symmetrically at gen + measure)
const MAX_CONTEXT_ENTRIES = 32 // bound in-memory context size
const STAGED_BLOB_MAX_BYTES = 8 * 1024 * 1024 // cap git show output per staged file

// sqlite index safeguards — keep the on-disk file bounded even under abuse
const INDEX_MEASURED_RETENTION_MS = 3 * 24 * 60 * 60 * 1000 // already-measured rows: 3 days
const INDEX_MAX_ROWS = 5000 // hard row cap (oldest measured dropped first)
const INDEX_VACUUM_EVERY_N_SWEEPS = 12 // VACUUM cadence (12 × 5min = 1h)

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
  /**
   * Full list of skills the turn used. Cloud-side attribution counts each
   * entry — there is no "primary" skill concept on the client (the former
   * `primarySkill` field has been removed because it was merely `usedSkills[0]`).
   */
  usedSkills?: string[]
}

export interface RecordGenInput {
  threadId: string
  tool: "write_file" | "edit_file"
  /** Absolute or workspace-relative path (tracker resolves it). */
  filePath: string
  /**
   * The content that was written (write_file) or one copy of the new_string
   * (edit_file). For replaceAll edits, `occurrences` expands this baseline into
   * a repeated line-hash multiset without materialising a repeated string.
   */
  generatedContent: string
  /** Optional: when provided, stepIndex is included in the gen event. */
  stepIndex?: number
  /** Optional: workspace root — used to turn absolute path into relative. */
  workspacePath?: string
  /**
   * Optional: non-blank lines removed by this tool call. When provided, the
   * tracker uses this directly. write_file passes 0 here (it can only create
   * new files).
   */
  deletedLineCount?: number
  /**
   * Optional: the local `old_string` fragment being replaced by edit_file.
   * Together with `newString` and `occurrences` the tracker derives a cheap
   * net-deletion count in the microtask — no full-file scan, no references
   * to editor buffers retained. Slight over/undercount at oldString boundary
   * lines is accepted: deletedLineCount is an auxiliary metric; the primary
   * adoption signal is `generatedContent` (= newString) retention.
   */
  oldString?: string
  /** Optional: the local `new_string` fragment. See `oldString`. */
  newString?: string
  /** Optional: replacement count returned by the edit tool. Defaults to 1. */
  occurrences?: number
}

interface JsonlGenEntry {
  t: "gen"
  eventId: string
  threadId: string
  traceId?: string
  filePath: string
  lineCount: number
  deletedLineCount: number
  fingerprint: string
  createdAt: number
  // NOTE: lineHashes deliberately NOT stored here — sqlite index owns the BLOB.
  // Keeping JSONL lean (~200B/record) lets the 100MB cap hold far more history.
}

// ─────────────────────────────────────────────────────────
// Module state
// ─────────────────────────────────────────────────────────

let initialized = false
let sweepTimer: NodeJS.Timeout | null = null
let sweepCount = 0
let currentShardPath: string | null = null
let currentShardSize = 0
let currentShardStartMs = 0

/**
 * Serialises JSONL appends so concurrent callers never race on `currentShardSize`.
 * The chain always resolves (errors are swallowed) so one failure does not block
 * subsequent writes.
 */
let appendChain: Promise<unknown> = Promise.resolve()

/**
 * In-flight measurement dedup. Keyed by the pending gen event_id. Prevents
 * duplicate emission if the same commit batch happens to pass the same file
 * through measureFile twice (e.g. rename + modify variants).
 */
const inFlightMeasurements = new Set<string>()

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
  // Segment-level match so root-relative paths like "node_modules/foo/x.ts" are
  // also excluded (the earlier substring check only caught paths with a leading "/").
  const segments = normalized.split("/").filter(Boolean)
  for (const seg of EXCLUDED_PATH_SEGMENTS) {
    if (segments.includes(seg)) return false
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

/**
 * Count non-blank, whitespace-normalised lines in `content`. Mirrors the
 * normalisation used by `computeLineHashes` so the count matches the number of
 * hashes we would actually compare. Exported so write/edit tool call sites can
 * compute `deletedLineCount` against the same definition the tracker uses for
 * added lines.
 */
export function countNonBlankLines(content: string): number {
  if (!content) return 0
  const lines = content.split(/\r?\n/)
  let count = 0
  for (const raw of lines) {
    if (normalizeLine(raw).length > 0) count++
  }
  return count
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

function getGenerationOccurrenceCount(input: RecordGenInput): number {
  if (input.tool !== "edit_file") return 1
  if (typeof input.occurrences !== "number" || !Number.isFinite(input.occurrences)) return 1
  const occurrences = Math.floor(input.occurrences)
  // edit_file reports 0 for the empty-file insertion special case; the new
  // string still appears once in the generated baseline.
  return occurrences > 0 ? occurrences : 1
}

function repeatLineHashes(hashes: Uint32Array, occurrences: number): Uint32Array {
  if (occurrences <= 1) return hashes
  const repeated = new Uint32Array(hashes.length * occurrences)
  for (let i = 0; i < occurrences; i++) {
    repeated.set(hashes, i * hashes.length)
  }
  return repeated
}

function packLineHashes(hashes: Uint32Array): Uint8Array {
  return new Uint8Array(hashes.buffer, hashes.byteOffset, hashes.byteLength)
}

function unpackLineHashes(bytes: Uint8Array): Uint32Array {
  const copy = new Uint8Array(bytes.length)
  copy.set(bytes)
  return new Uint32Array(copy.buffer)
}

function contentFingerprint(content: string): string {
  // Cheap whole-content 32-bit fingerprint (not cryptographic — just a quick diff hint).
  return fnv1a32(content).toString(16).padStart(8, "0")
}

function isValidUtf8(buffer: Buffer): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buffer)
    return true
  } catch {
    return false
  }
}

function detectTextEncoding(buffer: Buffer): string {
  if (buffer.length === 0) return "utf-8"
  try {
    const detected = chardet.detect(buffer)
    const encoding = typeof detected === "string" ? detected : detected?.encoding
    const confidence = typeof detected === "string" ? 1 : (detected?.confidence ?? 0)
    if (!encoding || encoding.toLowerCase() === "ascii" || !iconv.encodingExists(encoding)) {
      return "utf-8"
    }
    if (confidence >= 0.8) return encoding
    return isValidUtf8(buffer) ? "utf-8" : encoding
  } catch {
    return "utf-8"
  }
}

function decodeCodeBuffer(buffer: Buffer): string {
  return iconv.decode(buffer, detectTextEncoding(buffer))
}

function generationFingerprint(content: string, occurrences: number): string {
  if (occurrences <= 1) return contentFingerprint(content)
  // Avoid materialising repeated content; include the repeat count so replaceAll
  // baselines don't share a fingerprint with a single replacement.
  return contentFingerprint(`${occurrences}\0${content}`)
}

function getDeletionOccurrenceCount(input: RecordGenInput): number {
  if (typeof input.occurrences !== "number" || !Number.isFinite(input.occurrences)) return 1
  return Math.max(0, Math.floor(input.occurrences))
}

function deriveDeletedLineCount(input: RecordGenInput): number {
  if (typeof input.deletedLineCount === "number") {
    return Math.max(0, input.deletedLineCount)
  }
  if (typeof input.oldString !== "string") return 0

  const occurrences = getDeletionOccurrenceCount(input)
  if (occurrences === 0) return 0

  const oldNonBlank = countNonBlankLines(input.oldString)
  const newNonBlank =
    typeof input.newString === "string" ? countNonBlankLines(input.newString) : 0
  return Math.max(0, oldNonBlank - newNonBlank) * occurrences
}

function normalizeUsedSkills(skills: unknown): string[] {
  if (!Array.isArray(skills)) return []

  const normalized = new Set<string>()
  for (const skill of skills) {
    if (typeof skill !== "string") continue
    const identifier = ensureVersionedSkillIdentifier(skill)
    if (identifier) normalized.add(identifier)
  }
  return Array.from(normalized)
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

  const cutoff = Date.now() - GEN_ATTRIBUTION_WINDOW_MS
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

  // ── Index-side retention guards ─────────────────────────
  // 1. Drop any row older than the 7-day window (safety net; normally empty).
  try {
    deleteOlderThan(cutoff)
  } catch {
    // ignore
  }
  // 2. Drop measured rows more aggressively — once measured they have no
  //    further use for pending lookups.
  try {
    deleteMeasuredOlderThan(Date.now() - INDEX_MEASURED_RETENTION_MS)
  } catch {
    // ignore
  }
  // 3. Belt-and-suspenders row cap — protects against a single-day generation
  //    spree blowing up the sqlite file.
  try {
    trimToRowCap(INDEX_MAX_ROWS)
  } catch {
    // ignore
  }
}

// ─────────────────────────────────────────────────────────
// JSONL writer
// ─────────────────────────────────────────────────────────

function appendJsonl(entry: unknown): Promise<{ shardFile: string; offset: number }> {
  // Serialise every append through appendChain so two concurrent callers cannot
  // both read `currentShardSize` before either has bumped it — the offsets we
  // hand back to the sqlite index would otherwise alias.
  const task = appendChain.then(() => doAppendJsonl(entry))
  appendChain = task.catch(() => undefined)
  return task
}

async function doAppendJsonl(entry: unknown): Promise<{ shardFile: string; offset: number }> {
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

    // Snapshot attribution context *before* any await. Between the await on
    // appendJsonl below and our subsequent use of ctx, TraceCollector.finish()
    // can run and clearAdoptionContext(threadId) — which would zero out the
    // skill/model/trace fields on both the cloud event and the sqlite row,
    // and in turn strip skill attribution from the downstream code_adopt.
    const ctx = getContext(input.threadId)

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
    const generationOccurrences = getGenerationOccurrenceCount(input)
    const rawLineCount = input.generatedContent.split(/\r?\n/).length * generationOccurrences
    const eventId = `g_${randomUUID()}`
    const createdAt = Date.now()

    if (rawLineCount > MAX_LINES_FOR_MEASURE) {
      emitSkippedLargeAtGen({
        eventId,
        input,
        absPath,
        relPath,
        lineCount: rawLineCount,
        createdAt,
        ctx
      })
      return
    }

    const singleHashes = computeLineHashes(input.generatedContent)
    if (singleHashes.length === 0) return // empty-after-normalization → nothing worth tracking
    const repeatedHashCount = singleHashes.length * generationOccurrences

    // Non-blank line count may still exceed threshold only when rawLineCount is
    // already close; stay symmetric with the measure-time check.
    if (repeatedHashCount > MAX_LINES_FOR_MEASURE) {
      emitSkippedLargeAtGen({
        eventId,
        input,
        absPath,
        relPath,
        lineCount: repeatedHashCount,
        createdAt,
        ctx
      })
      return
    }

    const hashes = repeatLineHashes(singleHashes, generationOccurrences)
    const fingerprint = generationFingerprint(input.generatedContent, generationOccurrences)

    // ── JSONL record ────────────────────────────────────
    // Derive net-deletion count here (in the microtask), NOT at the tool
    // call site — this keeps edit_file's hot path free of any O(N) scan for
    // files that are about to be filtered out anyway (non-code, oversize,
    // empty-after-normalization — all handled above).
    // Only the local `oldString` / `newString` fragments are scanned — no
    // full-file reads — so the cost is proportional to the edit size, not
    // the file size. Boundary-line merging (e.g. oldString ending mid-line)
    // can introduce small +/- 1 errors; acceptable for an auxiliary metric.
    const deletedLineCount = deriveDeletedLineCount(input)
    const jsonlEntry: JsonlGenEntry = {
      t: "gen",
      eventId,
      threadId: input.threadId,
      traceId: ctx.traceId,
      filePath: absPath,
      lineCount: hashes.length,
      deletedLineCount,
      fingerprint,
      createdAt
    }
    const { shardFile, offset } = await appendJsonl(jsonlEntry)

    // ── Index row ───────────────────────────────────────
    // Persist attribution columns so the commit-time `code_adopt` event can
    // carry them too (ES can then slice adoption rates by skill / model / trace
    // directly, without a two-step join against code_gen). Using the snapshot
    // taken before the await — see the top of this function.
    const usedSkills = normalizeUsedSkills(ctx.usedSkills)
    insertGenEvent({
      event_id: eventId,
      file_path: absPath,
      content_fingerprint: fingerprint,
      shard_file: shardFile,
      shard_offset: offset,
      line_hashes: packLineHashes(hashes),
      created_at: createdAt,
      measured: 0,
      used_skills: usedSkills.length > 0 ? JSON.stringify(usedSkills) : null,
      thread_id: input.threadId || null,
      trace_id: ctx.traceId ?? null,
      model_id: ctx.modelId ?? null,
      model_name: ctx.modelName ?? null
    })

    // ── Cloud event (metadata only) ─────────────────────
    trackEvent("code_gen", "code_adoption", {
      schemaVersion: 1,
      eventId,
      threadId: input.threadId,
      traceId: ctx.traceId,
      stepIndex: input.stepIndex,
      tool: input.tool,
      language: extname(absPath).slice(1).toLowerCase() || null,
      lineCount: hashes.length,
      deletedLineCount,
      usedSkills,
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
  /** Attribution snapshot taken before any await — see doRecordGen. */
  ctx: AdoptionContext
}): void {
  const { eventId, input, absPath, relPath, lineCount, createdAt, ctx } = args
  const language = extname(absPath).slice(1).toLowerCase() || null
  const deletedLineCount = deriveDeletedLineCount(input)
  const usedSkills = normalizeUsedSkills(ctx.usedSkills)

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
    deletedLineCount,
    usedSkills,
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
    generatedLineCount: lineCount,
    adoptedLineCount: null,
    measureSource: "gen_oversize",
    measureLatencyMs: 0,
    measuredAt: new Date(createdAt).toISOString(),
    commitSha: null,
    // Mirror the attribution fields attached by the normal commit path, so
    // ES can aggregate adoption rates (including the skipped_large bucket)
    // uniformly — otherwise these rows look like they have no skill.
    usedSkills,
    modelId: ctx.modelId ?? null,
    modelName: ctx.modelName ?? null
  })
}

interface MeasureOpts {
  /** Callers may supply the already-read content to avoid a readFile round trip. */
  currentContent?: string | Buffer
  commitSha?: string
  /**
   * When true, short-circuit to `verdict: deleted` without reading the worktree
   * or comparing hashes. Used by the commit path for files staged as deletions.
   */
  stagedDeleted?: boolean
}

/**
 * Resolve the pending gen row for a file (most recent unmeasured within the
 * attribution window) and produce a `code_adopt` event against it. Never throws.
 *
 * Only commit-driven measurements remain — the 10-min timer was retired for
 * being the dominant I/O spike source with marginal value over L1 + L3.
 */
function measureFile(filePath: string, opts?: MeasureOpts): void {
  if (!initialized) return
  queueMicrotask(() => {
    doMeasureFile(filePath, opts).catch((e) => {
      console.warn("[AdoptionTracker] measureFile unexpected error:", e)
    })
  })
}

async function doMeasureFile(filePath: string, opts?: MeasureOpts): Promise<void> {
  let pendingId: string | null = null
  try {
    const absPath = resolvePath(filePath)
    const minCreated = Date.now() - GEN_ATTRIBUTION_WINDOW_MS
    const pending = findPendingGenForFile(absPath, minCreated)
    if (!pending) return

    // Dedup concurrent measurements for the same pending gen. Even without the
    // timer/commit race, a single commit batch can pass the same file twice
    // (rare but cheap to guard against).
    if (inFlightMeasurements.has(pending.event_id)) return
    inFlightMeasurements.add(pending.event_id)
    pendingId = pending.event_id

    let verdict: "deleted" | "committed" | "skipped_large" = "committed"

    const storedHashes = pending.line_hashes ? unpackLineHashes(pending.line_hashes) : null
    if (!storedHashes || storedHashes.length === 0) {
      // No baseline — nothing to compare against
      return
    }
    const generatedLineCount = storedHashes.length
    let adoptedLineCount: number | null = null

    if (opts?.stagedDeleted) {
      // Commit path explicitly told us this file is being removed. Skip readFile
      // (the worktree may still have stale content) and emit the deletion verdict.
      verdict = "deleted"
      adoptedLineCount = 0
    } else if (storedHashes.length > MAX_LINES_FOR_MEASURE) {
      verdict = "skipped_large"
      adoptedLineCount = null
    } else {
      let current = opts?.currentContent
      if (current === undefined) {
        try {
          current = await readFile(absPath)
        } catch {
          // File unreadable (removed / renamed) — terminal verdict: deleted
          verdict = "deleted"
          adoptedLineCount = 0
        }
      }
      if (verdict === "committed" && current !== undefined) {
        const currentText = Buffer.isBuffer(current) ? decodeCodeBuffer(current) : current
        const currentHashes = computeLineHashes(currentText)
        adoptedLineCount = countAdoptedLines(storedHashes, currentHashes)
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
      generatedLineCount,
      adoptedLineCount,
      measureSource: "git_commit",
      measuredAt,
      commitSha: opts?.commitSha ?? null
    })

    markMeasured(pending.event_id)

    // Pull attribution columns that were persisted at gen time, so cloud ES
    // can aggregate adoption rates by skill / model without a two-step join
    // against code_gen via genEventId.
    let usedSkills: string[] = []
    if (pending.used_skills) {
      try {
        const parsed = JSON.parse(pending.used_skills) as unknown
        usedSkills = normalizeUsedSkills(parsed)
      } catch {
        // corrupt row — treat as no skill attribution
      }
    }

    trackEvent("code_adopt", "code_adoption", {
      schemaVersion: 1,
      eventId: adoptEventId,
      genEventId: pending.event_id,
      threadId: pending.thread_id ?? null,
      traceId: pending.trace_id ?? null,
      verdict,
      generatedLineCount,
      adoptedLineCount,
      measureSource: "git_commit",
      measureLatencyMs: measuredAt - pending.created_at,
      measuredAt: new Date(measuredAt).toISOString(),
      commitSha: opts?.commitSha ?? null,
      usedSkills,
      modelId: pending.model_id ?? null,
      modelName: pending.model_name ?? null
    })
  } catch (e) {
    console.warn("[AdoptionTracker] doMeasureFile failed:", e)
  } finally {
    if (pendingId !== null) inFlightMeasurements.delete(pendingId)
  }
}

/** Count how many generated baseline lines still appear in the committed file. */
function countAdoptedLines(baseline: Uint32Array, current: Uint32Array): number {
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
  return kept
}

// ─────────────────────────────────────────────────────────
// External notification entry points
// ─────────────────────────────────────────────────────────

/** One staged file, captured against the index at pre-commit time. */
export interface StagedSnapshot {
  /** Absolute path to the file in the working tree. */
  absPath: string
  /**
   * Staged blob content exactly as it will land in the commit. Kept as bytes
   * so Windows projects using GBK/Shift_JIS/etc. are not forced through UTF-8.
   * `null` signals the file was staged for deletion.
   */
  stagedContent: Buffer | null
}

/**
 * Capture staged snapshots right BEFORE `git commit` runs. The commit clears
 * the index, so callers must invoke this after `git add` and before `git commit`.
 *
 * Never throws; failures only skip adoption measurement for that commit.
 */
export function captureStagedSnapshotsForCommit(workingDir: string): StagedSnapshot[] {
  try {
    const raw = execFileSync("git", ["diff", "--cached", "--name-status", "-z"], {
      encoding: "utf-8",
      cwd: workingDir,
      timeout: 5000,
      maxBuffer: 1024 * 1024
    })
    if (!raw) return []

    const snapshots: StagedSnapshot[] = []
    // Output format with -z:
    //   Normal:      <STATUS>\0<path>\0
    //   Rename/copy: <Rnnn|Cnnn>\0<old>\0<new>\0
    const tokens = raw.split("\0").filter(Boolean)
    for (let i = 0; i < tokens.length; ) {
      const status = tokens[i]
      if (!status || !/^[ACDMRTU]/.test(status)) {
        i++
        continue
      }

      const isRenameOrCopy = status.startsWith("R") || status.startsWith("C")
      const pathsNeeded = isRenameOrCopy ? 2 : 1
      if (i + pathsNeeded >= tokens.length) break
      const relPath = isRenameOrCopy ? tokens[i + 2] : tokens[i + 1]
      i += 1 + pathsNeeded
      if (!relPath) continue

      const absPath = resolvePath(workingDir, relPath)
      if (status === "D") {
        snapshots.push({ absPath, stagedContent: null })
        continue
      }
      if (!isCodeFile(absPath)) continue

      try {
        const stagedContent = execFileSync("git", ["show", `:${relPath}`], {
          cwd: workingDir,
          timeout: 5000,
          maxBuffer: STAGED_BLOB_MAX_BYTES
        })
        snapshots.push({ absPath, stagedContent })
      } catch {
        // Binary / too-large / other failure — skip silently.
      }
    }
    return snapshots
  } catch (e) {
    console.warn("[AdoptionTracker] adoption pre-commit capture skipped:", e)
    return []
  }
}

/**
 * Called by git IPC commit handler AFTER the actual `git commit` succeeds.
 * The caller is responsible for capturing staged blob content *before* the
 * commit runs (because `git commit` clears the index); we compare the hash
 * of the staged blob — not whatever happens to be on disk — against the
 * pending gen baseline. Returns immediately; work happens in background
 * microtasks.
 *
 * NOTE: we deliberately do NOT hook workspace-watcher. Every fs.watch
 * event would otherwise hit sqlite for every keystroke-level save; commit
 * is the only signal we treat as adoption. Deletions surface via a null
 * stagedContent (→ `verdict: deleted`).
 */
export function measureForCommit(snapshots: StagedSnapshot[], commitSha?: string): void {
  if (!initialized) return
  for (const snap of snapshots) {
    if (!isCodeFile(snap.absPath)) continue
    if (snap.stagedContent === null) {
      measureFile(snap.absPath, { stagedDeleted: true, commitSha })
      continue
    }
    measureFile(snap.absPath, {
      currentContent: snap.stagedContent,
      commitSha
    })
  }
}

// ─────────────────────────────────────────────────────────
// Sweep — housekeeping only (no measurement). Handles shard rotation,
// retention enforcement, periodic sqlite VACUUM, and index flush.
// ─────────────────────────────────────────────────────────

async function sweep(): Promise<void> {
  if (!initialized) return
  sweepCount++
  try {
    // 1. Rotate current shard if size / age triggers.
    await maybeRotateShard()

    // 2. Enforce retention (age + measured-age + row-cap all applied here).
    await enforceRetention()

    // 3. Reclaim sqlite free pages periodically. VACUUM is expensive-ish, so
    //    we only run it every N sweeps (≈ hourly by default).
    if (sweepCount % INDEX_VACUUM_EVERY_N_SWEEPS === 0) {
      try {
        vacuumAdoptionIndex()
      } catch {
        // ignore
      }
    }

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
