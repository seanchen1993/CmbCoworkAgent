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
 *   Retention: 14 days / 100 MB hard cap.
 */

import { appendFile, readdir, readFile, stat, unlink, rename } from "fs/promises"
import { existsSync, mkdirSync, statSync } from "fs"
import { basename, dirname, extname, join, relative, resolve as resolvePath, sep } from "path"
import { randomUUID } from "crypto"
import { execFile, execFileSync } from "child_process"
import { promisify } from "util"
import * as iconv from "iconv-lite"
import * as chardet from "jschardet"
import { getOpenworkDir } from "../storage"
import {
  TRACE_OBSERVABILITY_SCHEMA_VERSION,
  type TraceObservabilityContext
} from "../agent/trace/types"
import { ensureVersionedSkillIdentifier } from "../utils/skill-identifiers"
import { normalizeSkillSourceRefs } from "../utils/skill-source"
import { extractShellFileOps } from "../agent/exec-policy"
import { trackEvent } from "./event-reporter"
import {
  closeAdoptionIndex,
  findPendingGensForFile,
  flushAdoptionIndex,
  getGenRowByEventId,
  initializeAdoptionIndex,
  insertGenEvent,
  listPendingGenPaths,
  markMeasured,
  updateGenFilePath,
  deleteOlderThan,
  deleteMeasuredOlderThan,
  trimToRowCap,
  vacuumAdoptionIndex,
  type GenIndexRow
} from "./adoption-index"

// ─────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────

// Longest window during which a pending gen row is still eligible to be matched
// against a future git commit. Older rows are dropped by retention. (Previously
// also doubled as the L2 timer window — L2 has been removed, this is now purely
// "how long do we keep a baseline around for commit-time attribution".)
// Bumped 7 → 14 days to catch slower-to-commit work; worst-case footprint is
// still bounded by DISK_HARD_CAP_BYTES + INDEX_MAX_ROWS, not by the window.
const GEN_ATTRIBUTION_WINDOW_MS = 14 * 24 * 60 * 60 * 1000
// Slack added to a commit's creation time when using it as an upper bound on
// eligible gen rows. Covers git's 1-second committer-time granularity (a gen
// written in the same wall-clock second as the commit must not be floored out)
// plus minor clock jitter, while staying far below the multi-second gap to any
// *subsequent* (post-commit) generation we want to exclude.
const COMMIT_ATTRIBUTION_TOLERANCE_MS = 2 * 1000
const SWEEP_INTERVAL_MS = 5 * 60 * 1000 // shard rotation / retention / VACUUM cadence
const SHARD_SIZE_LIMIT_BYTES = 10 * 1024 * 1024 // 10 MB per shard
const SHARD_MAX_AGE_MS = 30 * 60 * 1000 // rotate every 30 min
const DISK_HARD_CAP_BYTES = 100 * 1024 * 1024 // 100 MB
const MAX_LINES_FOR_MEASURE = 20000 // skip giant files (applied symmetrically at gen + measure)
const MAX_CONTEXT_ENTRIES = 32 // bound in-memory context size
const STAGED_BLOB_MAX_BYTES = 8 * 1024 * 1024 // cap git show output per staged file

// sqlite index safeguards — keep the on-disk file bounded even under abuse
// Already-measured rows are kept for the full attribution window (14 days) so the
// local line-level 溯源 reader can still recover stored per-line hashes for any
// commit inside that window. (Kept aligned with GEN_ATTRIBUTION_WINDOW_MS;
// INDEX_MAX_ROWS still caps total growth.)
const INDEX_MEASURED_RETENTION_MS = 14 * 24 * 60 * 60 * 1000
// Row cap doubled (5000 → 10000) alongside the 7 → 14 day window so heavy users
// get a window that is genuinely 14 days rather than being silently truncated by
// the cap. 10000 rows is still a tiny sql.js file loaded fully into memory.
const INDEX_MAX_ROWS = 10000 // hard row cap (oldest measured dropped first)
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
  // Config
  // NOTE: yaml/yml and .properties are intentionally NOT tracked — they are
  // config/serialization formats whose churn is mostly mechanical and would
  // distort code-adoption stats. xml stays (legitimate config code).
  "xml"
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

export interface AdoptionContext extends Partial<TraceObservabilityContext> {
  traceId?: string
  modelId?: string
  modelName?: string
  /**
   * Full list of skills the turn used. Cloud-side attribution counts each
   * entry — there is no "primary" skill concept on the client (the former
   * `primarySkill` field has been removed because it was merely `usedSkills[0]`).
   */
  usedSkills?: string[]
  /** Source refs for plugin-owned usedSkills, format: "plugin:<pluginId>/<skillIdentifier>". */
  skillSource?: string[]
  /**
   * Harness Board attribution (project-mode conversations only). Carried onto
   * the emitted code_gen/code_adopt events so the dashboard can slice adoption
   * rates by project / plugin directly, without a traceId → project join.
   */
  harnessProjectId?: string
  harnessFeatureSlug?: string
  /**
   * Harness Board workflow stage name (group-label, e.g. "Dev-代码实现") current at
   * gen time, so emitted code_gen/code_adopt events can be sliced by stage.
   * Forward-only; no raw node id.
   */
  harnessNodeName?: string
  /** Stage status at gen time (group-label's node status, e.g. 进行中/已完成). Forward-only. */
  harnessNodeStatus?: string
  harnessAdapterName?: string
  harnessAdapterVersion?: string
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

export interface AdoptionLineBaseline {
  generatedLineHashes: Uint32Array
  supersededLineHashes: Uint32Array
  rawGeneratedLineCount: number
}

export interface AdoptionLineMeasureResult {
  generatedLineCount: number
  effectiveGeneratedLineCount: number
  adoptedLineCount: number
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

/** In-flight measurement dedup keyed by absolute file path. */
const inFlightFileMeasurements = new Set<string>()

/** threadId → AdoptionContext. Evicted oldest-first at MAX_CONTEXT_ENTRIES. */
const threadContexts = new Map<string, AdoptionContext>()

type GenIndexObservabilityColumns = Pick<
  GenIndexRow,
  | "observability_schema_version"
  | "trace_kind"
  | "execution_mode"
  | "root_trace_id"
  | "root_thread_id"
  | "parent_trace_id"
  | "parent_thread_id"
  | "parent_span_id"
  | "link_type"
  | "subagent_kind"
  | "subagent_run_id"
  | "subagent_thread_id"
  | "handoff_action"
  | "handoff_source_agent"
  | "handoff_target_agent"
  | "coordinator_worker_id"
  | "coordinator_worker_turn"
  | "coordinator_worker_role"
  | "coordinator_worker_workload"
  | "workflow_run_id"
  | "workflow_agent_index"
  | "workflow_phase"
  | "workflow_agent_label"
>

type AdoptionObservabilityEventProperties = {
  observabilitySchemaVersion?: number
  traceKind?: string
  executionMode?: string
  rootTraceId?: string | null
  rootThreadId?: string | null
  parentTraceId?: string | null
  parentThreadId?: string | null
  parentSpanId?: string | null
  linkType?: string | null
  subagentKind?: string | null
  subagentRunId?: string | null
  subagentThreadId?: string | null
  handoffAction?: string | null
  handoffSourceAgent?: string | null
  handoffTargetAgent?: string | null
  coordinatorWorkerId?: string | null
  coordinatorWorkerTurn?: number | null
  coordinatorWorkerRole?: string | null
  coordinatorWorkerWorkload?: string | null
  workflowRunId?: string | null
  workflowAgentIndex?: number | null
  workflowPhase?: string | null
  workflowAgentLabel?: string | null
}

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
// git work-tree gate
//
// code_gen is only reported for files that live inside a git work tree. Files
// generated outside any git repo can never reach a commit, so our commit-driven
// measurement never closes the loop on them — they would sit forever as "100%
// uncommitted" noise. Such files are also where external platforms (e.g.
// tag-dev / data-dev) own reporting via their own hook; gating here keeps the two
// producers from double-counting the same generation, with the partition keyed
// purely on a signal we own (git membership) — no coordination with that hook.
//
// Strict semantics: only a positive "true" from `--is-inside-work-tree` counts.
// A missing repo, a git error, or git being unavailable all resolve to false
// (skip). The result is cached per directory so the hot path spawns git at most
// once per directory for the whole session. Trade-off: if git is ever
// unavailable, code_gen reporting stops entirely — acceptable, since git is a
// hard dependency of the rest of the app.
// ─────────────────────────────────────────────────────────

const GIT_WORKTREE_CACHE_MAX = 256
const gitWorkTreeCache = new Map<string, boolean>()

function isInsideGitWorkTree(absPath: string): boolean {
  const dir = dirname(absPath)
  const cached = gitWorkTreeCache.get(dir)
  if (cached !== undefined) return cached

  let inside = false
  try {
    const out = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: dir,
      encoding: "utf-8",
      timeout: 5000,
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"]
    })
    inside = out.trim() === "true"
  } catch {
    // Not a repo / git error / git missing — treat as outside a work tree.
    inside = false
  }

  // Bounded cache (Map preserves insertion order → evict oldest first).
  if (!gitWorkTreeCache.has(dir) && gitWorkTreeCache.size >= GIT_WORKTREE_CACHE_MAX) {
    const oldest = gitWorkTreeCache.keys().next().value
    if (oldest !== undefined) gitWorkTreeCache.delete(oldest)
  }
  gitWorkTreeCache.set(dir, inside)
  return inside
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

function getGenerationOccurrenceCount(input: Pick<RecordGenInput, "tool" | "occurrences">): number {
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

function subtractLineHashMultiset(source: Uint32Array, subtract: Uint32Array): Uint32Array {
  if (source.length === 0) return source
  if (subtract.length === 0) return source

  const subtractCounts = buildLineHashCounts(subtract)
  const kept: number[] = []
  for (let i = 0; i < source.length; i++) {
    const h = source[i]
    const count = subtractCounts.get(h)
    if (count && count > 0) {
      subtractCounts.set(h, count - 1)
    } else {
      kept.push(h)
    }
  }
  return new Uint32Array(kept)
}

export function buildAdoptionLineBaseline(
  input: Pick<RecordGenInput, "tool" | "generatedContent" | "oldString" | "occurrences">
): AdoptionLineBaseline {
  const generationOccurrences = getGenerationOccurrenceCount(input)
  const rawGeneratedLineHashes = repeatLineHashes(
    computeLineHashes(input.generatedContent),
    generationOccurrences
  )
  if (input.tool !== "edit_file" || typeof input.oldString !== "string") {
    return {
      generatedLineHashes: rawGeneratedLineHashes,
      supersededLineHashes: new Uint32Array(0),
      rawGeneratedLineCount: rawGeneratedLineHashes.length
    }
  }

  const oldLineHashes = repeatLineHashes(
    computeLineHashes(input.oldString),
    getDeletionOccurrenceCount(input)
  )
  return {
    generatedLineHashes: subtractLineHashMultiset(rawGeneratedLineHashes, oldLineHashes),
    supersededLineHashes: subtractLineHashMultiset(oldLineHashes, rawGeneratedLineHashes),
    rawGeneratedLineCount: rawGeneratedLineHashes.length
  }
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

function getDeletionOccurrenceCount(input: Pick<RecordGenInput, "occurrences">): number {
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
  const newNonBlank = typeof input.newString === "string" ? countNonBlankLines(input.newString) : 0
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

function parseStoredSkills(value: string | null): string[] {
  if (!value) return []
  try {
    return normalizeUsedSkills(JSON.parse(value) as unknown)
  } catch {
    return []
  }
}

function parseStoredSkillSource(value: string | null, usedSkills: string[]): string[] {
  if (!value) return []
  try {
    return normalizeSkillSourceRefs(JSON.parse(value) as unknown, usedSkills)
  } catch {
    return []
  }
}

// ─────────────────────────────────────────────────────────
// Context (set by TraceCollector during agent lifecycle)
// ─────────────────────────────────────────────────────────

function hasObservabilityContext(ctx: AdoptionContext): boolean {
  return Boolean(
    ctx.traceId ||
      ctx.observabilitySchemaVersion ||
      ctx.traceKind ||
      ctx.executionMode ||
      ctx.rootTraceId ||
      ctx.parentTraceId ||
      ctx.subagentKind ||
      ctx.workflowRunId ||
      ctx.coordinatorWorkerId
  )
}

function buildObservabilityEventProperties(
  ctx: AdoptionContext,
  threadId: string | null | undefined
): AdoptionObservabilityEventProperties {
  if (!hasObservabilityContext(ctx)) return {}
  return {
    observabilitySchemaVersion:
      ctx.observabilitySchemaVersion ?? TRACE_OBSERVABILITY_SCHEMA_VERSION,
    traceKind: ctx.traceKind ?? "root",
    executionMode: ctx.executionMode ?? "normal",
    rootTraceId: ctx.rootTraceId ?? ctx.traceId ?? null,
    rootThreadId: ctx.rootThreadId ?? threadId ?? null,
    parentTraceId: ctx.parentTraceId ?? null,
    parentThreadId: ctx.parentThreadId ?? null,
    parentSpanId: ctx.parentSpanId ?? null,
    linkType: ctx.linkType ?? null,
    subagentKind: ctx.subagentKind ?? null,
    subagentRunId: ctx.subagentRunId ?? null,
    subagentThreadId: ctx.subagentThreadId ?? null,
    handoffAction: ctx.handoffAction ?? null,
    handoffSourceAgent: ctx.handoffSourceAgent ?? null,
    handoffTargetAgent: ctx.handoffTargetAgent ?? null,
    coordinatorWorkerId: ctx.coordinatorWorkerId ?? null,
    coordinatorWorkerTurn: ctx.coordinatorWorkerTurn ?? null,
    coordinatorWorkerRole: ctx.coordinatorWorkerRole ?? null,
    coordinatorWorkerWorkload: ctx.coordinatorWorkerWorkload ?? null,
    workflowRunId: ctx.workflowRunId ?? null,
    workflowAgentIndex: ctx.workflowAgentIndex ?? null,
    workflowPhase: ctx.workflowPhase ?? null,
    workflowAgentLabel: ctx.workflowAgentLabel ?? null
  }
}

function buildGenIndexObservabilityColumns(
  ctx: AdoptionContext,
  threadId: string | null | undefined
): GenIndexObservabilityColumns {
  const props = buildObservabilityEventProperties(ctx, threadId)
  return {
    observability_schema_version: props.observabilitySchemaVersion ?? null,
    trace_kind: props.traceKind ?? null,
    execution_mode: props.executionMode ?? null,
    root_trace_id: props.rootTraceId ?? null,
    root_thread_id: props.rootThreadId ?? null,
    parent_trace_id: props.parentTraceId ?? null,
    parent_thread_id: props.parentThreadId ?? null,
    parent_span_id: props.parentSpanId ?? null,
    link_type: props.linkType ?? null,
    subagent_kind: props.subagentKind ?? null,
    subagent_run_id: props.subagentRunId ?? null,
    subagent_thread_id: props.subagentThreadId ?? null,
    handoff_action: props.handoffAction ?? null,
    handoff_source_agent: props.handoffSourceAgent ?? null,
    handoff_target_agent: props.handoffTargetAgent ?? null,
    coordinator_worker_id: props.coordinatorWorkerId ?? null,
    coordinator_worker_turn: props.coordinatorWorkerTurn ?? null,
    coordinator_worker_role: props.coordinatorWorkerRole ?? null,
    coordinator_worker_workload: props.coordinatorWorkerWorkload ?? null,
    workflow_run_id: props.workflowRunId ?? null,
    workflow_agent_index: props.workflowAgentIndex ?? null,
    workflow_phase: props.workflowPhase ?? null,
    workflow_agent_label: props.workflowAgentLabel ?? null
  }
}

function hasPendingObservabilityContext(pending: GenIndexRow): boolean {
  return Boolean(
    pending.trace_id ||
      pending.observability_schema_version ||
      pending.trace_kind ||
      pending.execution_mode ||
      pending.root_trace_id ||
      pending.parent_trace_id ||
      pending.subagent_kind ||
      pending.workflow_run_id ||
      pending.coordinator_worker_id
  )
}

function buildPendingObservabilityEventProperties(
  pending: GenIndexRow
): AdoptionObservabilityEventProperties {
  if (!hasPendingObservabilityContext(pending)) return {}
  return {
    observabilitySchemaVersion:
      pending.observability_schema_version ?? TRACE_OBSERVABILITY_SCHEMA_VERSION,
    traceKind: pending.trace_kind ?? "root",
    executionMode: pending.execution_mode ?? "normal",
    rootTraceId: pending.root_trace_id ?? pending.trace_id ?? null,
    rootThreadId: pending.root_thread_id ?? pending.thread_id ?? null,
    parentTraceId: pending.parent_trace_id ?? null,
    parentThreadId: pending.parent_thread_id ?? null,
    parentSpanId: pending.parent_span_id ?? null,
    linkType: pending.link_type ?? null,
    subagentKind: pending.subagent_kind ?? null,
    subagentRunId: pending.subagent_run_id ?? null,
    subagentThreadId: pending.subagent_thread_id ?? null,
    handoffAction: pending.handoff_action ?? null,
    handoffSourceAgent: pending.handoff_source_agent ?? null,
    handoffTargetAgent: pending.handoff_target_agent ?? null,
    coordinatorWorkerId: pending.coordinator_worker_id ?? null,
    coordinatorWorkerTurn: pending.coordinator_worker_turn ?? null,
    coordinatorWorkerRole: pending.coordinator_worker_role ?? null,
    coordinatorWorkerWorkload: pending.coordinator_worker_workload ?? null,
    workflowRunId: pending.workflow_run_id ?? null,
    workflowAgentIndex: pending.workflow_agent_index ?? null,
    workflowPhase: pending.workflow_phase ?? null,
    workflowAgentLabel: pending.workflow_agent_label ?? null
  }
}

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
  // 1. Drop any row older than the 14-day window (safety net; normally empty).
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
  if (!initialized) {
    console.warn("[AdoptionTracker] recordGen skipped — tracker not initialized")
    return
  }
  console.log(
    `[AdoptionTracker] recordGen: tool=${input.tool} file=${input.filePath} threadId=${input.threadId}`
  )
  queueMicrotask(() => {
    doRecordGen(input).catch((e) => {
      console.warn("[AdoptionTracker] recordGen unexpected error:", e)
    })
  })
}

async function doRecordGen(input: RecordGenInput): Promise<void> {
  try {
    if (!isCodeFile(input.filePath)) {
      console.log(`[AdoptionTracker] recordGen skip — not a code file: ${input.filePath}`)
      return
    }

    // Snapshot attribution context *before* any await. Between the await on
    // appendJsonl below and our subsequent use of ctx, TraceCollector.finish()
    // can run and clearAdoptionContext(threadId) — which would zero out the
    // skill/model/trace fields on both the cloud event and the sqlite row,
    // and in turn strip skill attribution from the downstream code_adopt.
    const ctx = getContext(input.threadId)

    const absPath = input.workspacePath
      ? resolvePath(input.workspacePath, input.filePath)
      : resolvePath(input.filePath)

    // git-gate: only report generations that live inside a git work tree (see
    // isInsideGitWorkTree). Non-git files never reach a commit and are where
    // external platforms own reporting via their own hook — skipping them here
    // avoids double-counting and removes events that could never close the loop.
    if (!isInsideGitWorkTree(absPath)) {
      console.log(`[AdoptionTracker] recordGen skip — not in a git work tree: ${input.filePath}`)
      return
    }

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

    const baseline = buildAdoptionLineBaseline(input)

    // Keep the measured baseline guard explicit too, so the persisted row never
    // exceeds the commit-time comparison cap.
    if (baseline.rawGeneratedLineCount > MAX_LINES_FOR_MEASURE) {
      emitSkippedLargeAtGen({
        eventId,
        input,
        absPath,
        relPath,
        lineCount: baseline.rawGeneratedLineCount,
        createdAt,
        ctx
      })
      return
    }

    const hashes = baseline.generatedLineHashes
    const oldLineHashes = baseline.supersededLineHashes
    if (hashes.length === 0 && oldLineHashes.length === 0) {
      console.log(`[AdoptionTracker] recordGen skip — empty after normalization: ${input.filePath}`)
      return
    }
    const fingerprint = generationFingerprint(input.generatedContent, generationOccurrences)

    // `hashes` is the net-new baseline. For edit_file this removes unchanged
    // oldString context from newString, while `oldLineHashes` keeps only the
    // old-only lines that should supersede earlier agent generations.
    const reportedLineCount = hashes.length

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
      lineCount: reportedLineCount,
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
    const observabilityColumns = buildGenIndexObservabilityColumns(ctx, input.threadId)
    const observabilityProps = buildObservabilityEventProperties(ctx, input.threadId)
    const skillSource = normalizeSkillSourceRefs(ctx.skillSource, usedSkills)
    insertGenEvent({
      event_id: eventId,
      file_path: absPath,
      content_fingerprint: fingerprint,
      shard_file: shardFile,
      shard_offset: offset,
      line_hashes: packLineHashes(hashes),
      old_line_hashes: oldLineHashes.length > 0 ? packLineHashes(oldLineHashes) : null,
      created_at: createdAt,
      measured: 0,
      tool: input.tool,
      used_skills: usedSkills.length > 0 ? JSON.stringify(usedSkills) : null,
      skill_source: skillSource.length > 0 ? JSON.stringify(skillSource) : null,
      thread_id: input.threadId || null,
      trace_id: ctx.traceId ?? null,
      model_id: ctx.modelId ?? null,
      model_name: ctx.modelName ?? null,
      harness_project_id: ctx.harnessProjectId ?? null,
      harness_feature_slug: ctx.harnessFeatureSlug ?? null,
      harness_node_name: ctx.harnessNodeName ?? null,
      harness_node_status: ctx.harnessNodeStatus ?? null,
      harness_adapter_name: ctx.harnessAdapterName ?? null,
      harness_adapter_version: ctx.harnessAdapterVersion ?? null,
      ...observabilityColumns
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
      lineCount: reportedLineCount,
      deletedLineCount,
      usedSkills,
      ...(skillSource.length > 0 ? { skillSource } : {}),
      modelId: ctx.modelId ?? null,
      modelName: ctx.modelName ?? null,
      harnessProjectId: ctx.harnessProjectId ?? null,
      harnessFeatureSlug: ctx.harnessFeatureSlug ?? null,
      harnessNodeName: ctx.harnessNodeName ?? null,
      harnessNodeStatus: ctx.harnessNodeStatus ?? null,
      harnessAdapterName: ctx.harnessAdapterName ?? null,
      harnessAdapterVersion: ctx.harnessAdapterVersion ?? null,
      ...observabilityProps,
      // note: filePath / content / fingerprint intentionally withheld
      createdAt: new Date(createdAt).toISOString(),
      relativeHint: relPath.split("/").slice(-1)[0] // leaf filename only, not a full path
    })
    console.log(
      `[AdoptionTracker] recordGen OK: eventId=${eventId} file=${relPath} lineCount=${reportedLineCount} rawHashes=${baseline.rawGeneratedLineCount} supersededHashes=${oldLineHashes.length} deletedLineCount=${deletedLineCount} threadId=${input.threadId} traceId=${ctx.traceId ?? "none"}`
    )
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
  const observabilityProps = buildObservabilityEventProperties(ctx, input.threadId)
  const skillSource = normalizeSkillSourceRefs(ctx.skillSource, usedSkills)

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
    ...(skillSource.length > 0 ? { skillSource } : {}),
    modelId: ctx.modelId ?? null,
    modelName: ctx.modelName ?? null,
    harnessProjectId: ctx.harnessProjectId ?? null,
    harnessFeatureSlug: ctx.harnessFeatureSlug ?? null,
    harnessNodeName: ctx.harnessNodeName ?? null,
    harnessNodeStatus: ctx.harnessNodeStatus ?? null,
    harnessAdapterName: ctx.harnessAdapterName ?? null,
    harnessAdapterVersion: ctx.harnessAdapterVersion ?? null,
    ...observabilityProps,
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
    effectiveGeneratedLineCount: lineCount,
    adoptedLineCount: null,
    measureSource: "gen_oversize",
    measureLatencyMs: 0,
    generatedAt: new Date(createdAt).toISOString(),
    measuredAt: new Date(createdAt).toISOString(),
    commitSha: null,
    // Mirror the attribution fields attached by the normal commit path, so
    // ES can aggregate adoption rates (including the skipped_large bucket)
    // uniformly — otherwise these rows look like they have no skill.
    usedSkills,
    ...(skillSource.length > 0 ? { skillSource } : {}),
    modelId: ctx.modelId ?? null,
    modelName: ctx.modelName ?? null,
    harnessProjectId: ctx.harnessProjectId ?? null,
    harnessFeatureSlug: ctx.harnessFeatureSlug ?? null,
    harnessNodeName: ctx.harnessNodeName ?? null,
    harnessNodeStatus: ctx.harnessNodeStatus ?? null,
    harnessAdapterName: ctx.harnessAdapterName ?? null,
    harnessAdapterVersion: ctx.harnessAdapterVersion ?? null,
    ...observabilityProps
  })
}

interface MeasureOpts {
  /** Callers may supply the already-read content to avoid a readFile round trip. */
  currentContent?: string | Buffer
  commitSha?: string
  /**
   * Commit creation time (epoch ms). Used as an inclusive upper bound (plus a
   * small tolerance) on eligible gen rows so generations made *after* this
   * commit are never attributed to it. Critical for out-of-order re-measures
   * (commit reconciler / hook sync) that run long after the commit, when newer
   * uncommitted gens for the same file may exist. Omit to disable the bound.
   */
  commitTimeMs?: number
  /**
   * When true, short-circuit to `verdict: deleted` without reading the worktree
   * or comparing hashes. Used by the commit path for files staged as deletions.
   */
  stagedDeleted?: boolean
}

/**
 * Inclusive upper bound on eligible gen `created_at`, derived from a commit's
 * creation time plus tolerance. Returns undefined when no commit time is known
 * (preserving the legacy "no upper bound" behaviour).
 */
function resolveMaxGenCreatedAt(commitTimeMs?: number): number | undefined {
  if (typeof commitTimeMs !== "number" || !Number.isFinite(commitTimeMs)) return undefined
  return commitTimeMs + COMMIT_ATTRIBUTION_TOLERANCE_MS
}

/** Why a pending generation was voided (effective/adopted = 0). Carried on the
 *  `superseded` code_adopt purely so the 溯源 view can explain the 0. */
export type SupersedeReason =
  | "same_path_rewrite" // a newer write_file recreated the file at the same path
  | "agent_rm" // the agent deleted the file (rm / git rm) before it was committed

/**
 * Emit a terminal `superseded` code_adopt that voids an older generation:
 * effective/adopted = 0, so the discarded draft stops inflating the
 * adoption-rate denominator, while still emitting an adopt event so the gen is
 * not later miscounted as "generated but never committed" by the
 * uncommitted-analysis anti-join.
 *
 * Two triggers share this primitive (`reason` distinguishes them for display):
 *   - `same_path_rewrite`: a newer write_file recreated the file from scratch
 *     (write_file only succeeds on a non-existent path), so none of the older
 *     draft's lines survived. Inferred at commit time. `measureSource =
 *     git_commit`, carries the commit's sha.
 *   - `agent_rm`: the agent deleted the file before it was ever committed.
 *     Driven in real time by shell-op monitoring. `measureSource =
 *     agent_file_op`, no commit (commitSha = null).
 */
async function emitSupersededAdopt(
  pending: GenIndexRow,
  generatedLineCount: number,
  commitSha: string | null,
  reason: SupersedeReason,
  measureSource: "git_commit" | "agent_file_op" = "git_commit"
): Promise<void> {
  const adoptEventId = `a_${randomUUID()}`
  const measuredAt = Date.now()
  await appendJsonl({
    t: "adopt",
    eventId: adoptEventId,
    genEventId: pending.event_id,
    verdict: "superseded",
    reason,
    generatedLineCount,
    effectiveGeneratedLineCount: 0,
    adoptedLineCount: 0,
    measureSource,
    measuredAt,
    commitSha
  })

  const usedSkills = parseStoredSkills(pending.used_skills)
  const skillSource = parseStoredSkillSource(pending.skill_source, usedSkills)
  const observabilityProps = buildPendingObservabilityEventProperties(pending)

  trackEvent("code_adopt", "code_adoption", {
    schemaVersion: 1,
    eventId: adoptEventId,
    genEventId: pending.event_id,
    threadId: pending.thread_id ?? null,
    traceId: pending.trace_id ?? null,
    verdict: "superseded",
    reason,
    generatedLineCount,
    effectiveGeneratedLineCount: 0,
    adoptedLineCount: 0,
    measureSource,
    measureLatencyMs: measuredAt - pending.created_at,
    generatedAt: new Date(pending.created_at).toISOString(),
    measuredAt: new Date(measuredAt).toISOString(),
    commitSha,
    usedSkills,
    ...(skillSource.length > 0 ? { skillSource } : {}),
    modelId: pending.model_id ?? null,
    modelName: pending.model_name ?? null,
    harnessProjectId: pending.harness_project_id ?? null,
    harnessFeatureSlug: pending.harness_feature_slug ?? null,
    harnessNodeName: pending.harness_node_name ?? null,
    harnessNodeStatus: pending.harness_node_status ?? null,
    harnessAdapterName: pending.harness_adapter_name ?? null,
    harnessAdapterVersion: pending.harness_adapter_version ?? null,
    ...observabilityProps
  })

  console.log(
    `[AdoptionTracker] measure verdict=superseded reason=${reason} genEventId=${pending.event_id} generatedLines=${generatedLineCount} commitSha=${commitSha ?? "none"}`
  )
}

/**
 * Resolve all pending gen rows for a file (newest first within the attribution
 * window) and produce `code_adopt` events against them. Never throws.
 *
 * Only commit-driven measurements remain — the 10-min timer was retired for
 * being the dominant I/O spike source with marginal value over L1 + L3.
 */
function measureFile(filePath: string, opts?: MeasureOpts): void {
  if (!initialized) {
    console.warn("[AdoptionTracker] measureFile skipped — tracker not initialized")
    return
  }
  queueMicrotask(() => {
    doMeasureFile(filePath, opts).catch((e) => {
      console.warn("[AdoptionTracker] measureFile unexpected error:", e)
    })
  })
}

async function doMeasureFile(filePath: string, opts?: MeasureOpts): Promise<void> {
  let absPath = ""
  try {
    absPath = resolvePath(filePath)
    const minCreated = Date.now() - GEN_ATTRIBUTION_WINDOW_MS
    const maxCreated = resolveMaxGenCreatedAt(opts?.commitTimeMs)
    const pendingRows = findPendingGensForFile(absPath, minCreated, maxCreated)
    console.log(
      `[AdoptionTracker] doMeasureFile: absPath=${absPath} pendingGens=${pendingRows.length} commitSha=${opts?.commitSha ?? "none"} commitTimeMs=${opts?.commitTimeMs ?? "none"} stagedDeleted=${opts?.stagedDeleted ?? false}`
    )
    if (pendingRows.length === 0) return

    // Dedup concurrent measurements for the same file. Even without the
    // timer/commit race, a single commit batch can pass the same file twice
    // (rare but cheap to guard against).
    if (inFlightFileMeasurements.has(absPath)) {
      console.log(
        `[AdoptionTracker] doMeasureFile dedup skip: absPath=${absPath} (already in-flight)`
      )
      return
    }
    inFlightFileMeasurements.add(absPath)

    let currentHashCounts: Map<number, number> | null = null
    let missingCurrentContent = false
    const supersededHashCounts = new Map<number, number>()

    if (!opts?.stagedDeleted) {
      let current = opts?.currentContent
      if (current === undefined) {
        try {
          current = await readFile(absPath)
        } catch {
          missingCurrentContent = true
        }
      }

      if (!missingCurrentContent && current !== undefined) {
        const currentText = Buffer.isBuffer(current) ? decodeCodeBuffer(current) : current
        currentHashCounts = buildLineHashCounts(computeLineHashes(currentText))
      }
    }

    let sawFullRewrite = false
    for (const pending of pendingRows) {
      const storedHashes = pending.line_hashes ? unpackLineHashes(pending.line_hashes) : null

      // A newer full-file write_file already recreated this file from scratch
      // (write_file only succeeds on a non-existent path), so every older
      // generation's lines are gone. Emit a terminal `superseded` verdict
      // (0 effective / 0 adopted) instead of letting the discarded draft inflate
      // the adoption-rate denominator. We still emit an adopt event so the gen is
      // not later miscounted as "generated but never committed".
      if (sawFullRewrite) {
        if (storedHashes && storedHashes.length > 0) {
          await emitSupersededAdopt(
            pending,
            storedHashes.length,
            opts?.commitSha ?? null,
            "same_path_rewrite"
          )
        }
        markMeasured(pending.event_id)
        continue
      }

      let verdict: "deleted" | "committed" | "skipped_large" = "committed"
      if (!storedHashes || storedHashes.length === 0) {
        // No net-new baseline. This can be a legitimate supersession-only
        // edit (for example an agent deleting a previously generated line).
        // Apply old-only hashes so older rows are not counted again, then
        // clear the local row without emitting a code_adopt event.
        if (pending.old_line_hashes) {
          try {
            addLineHashesToCounts(supersededHashCounts, unpackLineHashes(pending.old_line_hashes))
          } catch {
            // corrupt row — keep measuring older rows without supersession hints
          }
        }
        markMeasured(pending.event_id)
        continue
      }
      const generatedLineCount = storedHashes.length
      const oversizedBaseline = storedHashes.length > MAX_LINES_FOR_MEASURE
      const { effectiveLineCount, adoptedFromEffective } = consumeEffectiveAdoptionLines(
        storedHashes,
        supersededHashCounts,
        oversizedBaseline ? null : currentHashCounts
      )
      let adoptedLineCount: number | null = null

      if (opts?.stagedDeleted || missingCurrentContent) {
        // Commit path explicitly told us this file is being removed, or the
        // file is unreadable after commit. Both are terminal deletion verdicts.
        verdict = "deleted"
        adoptedLineCount = 0
      } else if (oversizedBaseline) {
        verdict = "skipped_large"
        adoptedLineCount = null
      } else {
        adoptedLineCount = adoptedFromEffective
      }

      const adoptEventId = `a_${randomUUID()}`
      const measuredAt = Date.now()
      await appendJsonl({
        t: "adopt",
        eventId: adoptEventId,
        genEventId: pending.event_id,
        verdict,
        generatedLineCount,
        effectiveGeneratedLineCount: effectiveLineCount,
        adoptedLineCount,
        measureSource: "git_commit",
        measuredAt,
        commitSha: opts?.commitSha ?? null
      })

      markMeasured(pending.event_id)

      // Pull attribution columns that were persisted at gen time, so cloud ES
      // can aggregate adoption rates by skill / model without a two-step join
      // against code_gen via genEventId.
      const usedSkills = parseStoredSkills(pending.used_skills)
      const skillSource = parseStoredSkillSource(pending.skill_source, usedSkills)
      const observabilityProps = buildPendingObservabilityEventProperties(pending)

      trackEvent("code_adopt", "code_adoption", {
        schemaVersion: 1,
        eventId: adoptEventId,
        genEventId: pending.event_id,
        threadId: pending.thread_id ?? null,
        traceId: pending.trace_id ?? null,
        verdict,
        generatedLineCount,
        effectiveGeneratedLineCount: effectiveLineCount,
        adoptedLineCount,
        measureSource: "git_commit",
        measureLatencyMs: measuredAt - pending.created_at,
        generatedAt: new Date(pending.created_at).toISOString(),
        measuredAt: new Date(measuredAt).toISOString(),
        commitSha: opts?.commitSha ?? null,
        usedSkills,
        ...(skillSource.length > 0 ? { skillSource } : {}),
        modelId: pending.model_id ?? null,
        modelName: pending.model_name ?? null,
        harnessProjectId: pending.harness_project_id ?? null,
        harnessFeatureSlug: pending.harness_feature_slug ?? null,
        harnessNodeName: pending.harness_node_name ?? null,
        harnessNodeStatus: pending.harness_node_status ?? null,
        harnessAdapterName: pending.harness_adapter_name ?? null,
        harnessAdapterVersion: pending.harness_adapter_version ?? null,
        ...observabilityProps
      })

      console.log(
        `[AdoptionTracker] measure verdict=${verdict} genEventId=${pending.event_id} file=${absPath} generatedLines=${generatedLineCount} effectiveLines=${effectiveLineCount} adoptedLines=${adoptedLineCount} commitSha=${opts?.commitSha ?? "none"} threadId=${pending.thread_id ?? "none"}`
      )

      if (pending.old_line_hashes) {
        try {
          addLineHashesToCounts(supersededHashCounts, unpackLineHashes(pending.old_line_hashes))
        } catch {
          // corrupt row — keep measuring older rows without supersession hints
        }
      }

      // Once we pass a full-file write_file (rows are newest-first), every older
      // row is a pre-rewrite draft that cannot have survived — void it next.
      if (pending.tool === "write_file") sawFullRewrite = true
    }
  } catch (e) {
    console.warn("[AdoptionTracker] doMeasureFile failed:", e)
  } finally {
    if (absPath) inFlightFileMeasurements.delete(absPath)
  }
}

function buildLineHashCounts(lines: Uint32Array): Map<number, number> {
  const counts = new Map<number, number>()
  addLineHashesToCounts(counts, lines)
  return counts
}

function addLineHashesToCounts(counts: Map<number, number>, lines: Uint32Array): void {
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i]
    counts.set(h, (counts.get(h) ?? 0) + 1)
  }
}

/**
 * Count effective generated lines after excluding older baseline lines that a
 * later agent edit explicitly replaced, then consume the subset still present
 * in the committed file.
 */
function consumeEffectiveAdoptionLines(
  baseline: Uint32Array,
  supersededCounts: Map<number, number>,
  availableCounts: Map<number, number> | null
): { effectiveLineCount: number; adoptedFromEffective: number } {
  if (baseline.length === 0) {
    return { effectiveLineCount: 0, adoptedFromEffective: 0 }
  }

  let effectiveLineCount = 0
  let adoptedFromEffective = 0
  for (let i = 0; i < baseline.length; i++) {
    const h = baseline[i]
    const superseded = supersededCounts.get(h)
    if (superseded && superseded > 0) {
      supersededCounts.set(h, superseded - 1)
      continue
    }

    effectiveLineCount++
    if (!availableCounts) continue
    const c = availableCounts.get(h)
    if (c && c > 0) {
      adoptedFromEffective++
      availableCounts.set(h, c - 1)
    }
  }
  return { effectiveLineCount, adoptedFromEffective }
}

export function evaluateAdoptionLineBaselines(
  baselinesNewestFirst: AdoptionLineBaseline[],
  committedContent: string | null
): AdoptionLineMeasureResult[] {
  const availableCounts =
    committedContent === null ? null : buildLineHashCounts(computeLineHashes(committedContent))
  const supersededHashCounts = new Map<number, number>()
  const results: AdoptionLineMeasureResult[] = []

  for (const baseline of baselinesNewestFirst) {
    const { effectiveLineCount, adoptedFromEffective } = consumeEffectiveAdoptionLines(
      baseline.generatedLineHashes,
      supersededHashCounts,
      availableCounts
    )
    results.push({
      generatedLineCount: baseline.generatedLineHashes.length,
      effectiveGeneratedLineCount: effectiveLineCount,
      adoptedLineCount: committedContent === null ? 0 : adoptedFromEffective
    })

    if (baseline.supersededLineHashes.length > 0) {
      addLineHashesToCounts(supersededHashCounts, baseline.supersededLineHashes)
    }
  }

  return results
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

const execFileAsync = promisify(execFile)

// Bound how many `git show` blob reads run at once so a large staged set can't
// spawn dozens of git processes simultaneously.
const GIT_SHOW_CONCURRENCY = 4

/**
 * Run `fn` over `items` with at most `limit` in flight at once, preserving index.
 */
async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>
): Promise<void> {
  let next = 0
  const workerCount = Math.min(Math.max(1, limit), items.length)
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const idx = next++
      if (idx >= items.length) return
      await fn(items[idx], idx)
    }
  })
  await Promise.all(workers)
}

/**
 * Capture staged snapshots right BEFORE `git commit` runs. The commit clears
 * the index, so callers must invoke this after `git add` and before `git commit`.
 *
 * Never throws; failures only skip adoption measurement for that commit.
 */
export async function captureStagedSnapshotsForCommit(
  workingDir: string
): Promise<StagedSnapshot[]> {
  try {
    // Resolve the git root — git diff --cached returns paths relative to the
    // top-level working tree, NOT the -C directory. When the -C directory is a
    // subfolder of the repo (common in worktree setups), resolvePath(workingDir,
    // relPath) would duplicate path segments and fail to match gen events later.
    let gitRoot = workingDir
    try {
      gitRoot = (
        await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
          encoding: "utf-8",
          cwd: workingDir,
          timeout: 5000,
          maxBuffer: 1024 * 1024,
          windowsHide: true
        })
      ).stdout.trim()
    } catch {
      // Fallback to workingDir — best-effort
    }

    const raw = (
      await execFileAsync("git", ["diff", "--cached", "--name-status", "-z"], {
        encoding: "utf-8",
        cwd: workingDir,
        timeout: 5000,
        maxBuffer: 1024 * 1024,
        windowsHide: true
      })
    ).stdout
    if (!raw) {
      console.log(`[AdoptionTracker] pre-commit capture: no staged files in ${workingDir}`)
      return []
    }

    // Parse the staged list first (cheap, order-sensitive), then read blobs with
    // bounded concurrency below.
    type StagedEntry = { absPath: string; relPath: string; deleted: boolean }
    const entries: StagedEntry[] = []
    let totalStaged = 0
    let skippedNonCode = 0
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

      totalStaged++
      const absPath = resolvePath(gitRoot, relPath)
      if (status === "D") {
        entries.push({ absPath, relPath, deleted: true })
        continue
      }
      if (!isCodeFile(absPath)) {
        skippedNonCode++
        continue
      }
      entries.push({ absPath, relPath, deleted: false })
    }

    // Read each staged blob concurrently (bounded). Holes (failed reads) are
    // filtered out afterwards; order is preserved to match the staged list.
    const slots: (StagedSnapshot | undefined)[] = new Array(entries.length)
    await mapWithConcurrency(entries, GIT_SHOW_CONCURRENCY, async (entry, idx) => {
      if (entry.deleted) {
        slots[idx] = { absPath: entry.absPath, stagedContent: null }
        return
      }
      try {
        const stagedContent = (
          await execFileAsync("git", ["show", `:${entry.relPath}`], {
            encoding: "buffer",
            cwd: workingDir,
            timeout: 5000,
            maxBuffer: STAGED_BLOB_MAX_BYTES,
            windowsHide: true
          })
        ).stdout
        slots[idx] = { absPath: entry.absPath, stagedContent }
      } catch {
        // Binary / too-large / other failure — skip silently.
      }
    })

    const snapshots = slots.filter((s): s is StagedSnapshot => s !== undefined)
    console.log(
      `[AdoptionTracker] pre-commit capture: totalStaged=${totalStaged} codeFiles=${snapshots.length} skippedNonCode=${skippedNonCode} gitRoot=${gitRoot}`
    )
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
export function measureForCommit(
  snapshots: StagedSnapshot[],
  commitSha?: string,
  commitTimeMs?: number
): void {
  if (!initialized) {
    console.warn("[AdoptionTracker] measureForCommit skipped — tracker not initialized")
    return
  }
  console.log(
    `[AdoptionTracker] measureForCommit: snapshotCount=${snapshots.length} commitSha=${commitSha ?? "unknown"} commitTimeMs=${commitTimeMs ?? "none"}`
  )
  for (const snap of snapshots) {
    if (!isCodeFile(snap.absPath)) continue
    if (snap.stagedContent === null) {
      measureFile(snap.absPath, { stagedDeleted: true, commitSha, commitTimeMs })
      continue
    }
    measureFile(snap.absPath, {
      currentContent: snap.stagedContent,
      commitSha,
      commitTimeMs
    })
  }
}

export function hasPendingGenerationsForCommit(
  snapshots: StagedSnapshot[],
  commitTimeMs?: number
): boolean {
  if (!initialized) return false
  const minCreated = Date.now() - GEN_ATTRIBUTION_WINDOW_MS
  // Mirror the upper bound used at measure time so the "should I measure this
  // commit?" gate and the measurement itself agree — otherwise the reconciler
  // would re-process (and re-emit git.commit.created for) commits whose only
  // pending gens are newer than the commit and would be skipped anyway.
  const maxCreated = resolveMaxGenCreatedAt(commitTimeMs)
  for (const snap of snapshots) {
    if (!isCodeFile(snap.absPath)) continue
    if (findPendingGensForFile(snap.absPath, minCreated, maxCreated).length > 0) return true
  }
  return false
}

// ─────────────────────────────────────────────────────────
// Agent shell file ops (rm / mv) — keep pending generations honest when the
// agent deletes or relocates a generated file BEFORE it is committed.
//
// Attribution is keyed by absolute file path, so a path change between gen time
// and commit time orphans the pending generation: it never gets a code_adopt
// and is later miscounted as "generated but never committed" (phantom 0%
// adoption), even though the code lives on. write_file refuses to overwrite, so
// an agent "rewrite/move" ALWAYS deletes the old path first via an explicit
// shell command — which we observe here:
//
//   • rm / git rm  → the generated code was discarded at that path. Void the
//     pending gen (superseded / agent_rm, effective=0), mirroring the same-path
//     write→delete→write supersession but driven by an explicit delete.
//   • mv / git mv  → the generated code moved. Transfer the pending gen's
//     file_path so commit-time attribution finds it at its new home.
//
// Only AGENT commands flow through LocalSandbox.execute → here; a human deleting
// or moving a file in their own editor is intentionally NOT intercepted (that is
// a genuine rejection/relocation and must keep its real outcome). Side-effect
// only; never throws; acts only on exit code 0.
// ─────────────────────────────────────────────────────────

function pathHasGlobMeta(p: string): boolean {
  return /[*?[\]{}]/.test(p)
}

/** True when `candidate` equals `base` or is nested under it. Both absolute,
 *  both produced by `resolvePath` so separators already agree per-platform.
 *  Exported for unit testing. */
export function isPathAtOrUnder(candidate: string, base: string): boolean {
  if (candidate === base) return true
  return candidate.startsWith(base.endsWith(sep) ? base : base + sep)
}

/**
 * Called by LocalSandbox after a shell command finishes. Reacts to agent rm/mv
 * so generations relocated/deleted before commit are not orphaned. Returns
 * immediately; work happens in a background microtask. Never throws.
 */
export function recordShellFileOps(command: string, cwd: string, exitCode: number | null): void {
  if (!initialized) return
  if (exitCode !== 0 || !command) return
  queueMicrotask(() => {
    doRecordShellFileOps(command, cwd).catch((e) => {
      console.warn("[AdoptionTracker] recordShellFileOps unexpected error:", e)
    })
  })
}

async function doRecordShellFileOps(command: string, cwd: string): Promise<void> {
  try {
    const ops = extractShellFileOps(command)
    if (ops.length === 0) return
    const baseDir = cwd ? resolvePath(cwd) : process.cwd()
    for (const op of ops) {
      if (op.op === "rm") {
        for (const raw of op.paths) {
          if (!raw || pathHasGlobMeta(raw)) continue
          const target = resolvePath(baseDir, raw)
          // Only void when the path is actually gone. Guards `git rm --cached`
          // (un-tracks but keeps the file), `rm`/`git rm`/`git mv` dry-runs
          // (`-n`), and any flag we don't model — if it still exists it was not
          // deleted, so the generation must not be voided.
          if (existsSync(target)) continue
          await voidPendingGensUnderPath(target)
        }
      } else if (op.op === "mv" && op.dest && !pathHasGlobMeta(op.dest)) {
        const destAbs = resolvePath(baseDir, op.dest)
        for (const raw of op.paths) {
          if (!raw || pathHasGlobMeta(raw)) continue
          const srcAbs = resolvePath(baseDir, raw)
          // Only transfer when the move actually happened: source gone AND
          // destination present. Guards `mv -n` no-clobber skips and `git mv -n`
          // dry-runs (source untouched), and mangled/unresolved paths.
          if (existsSync(srcAbs) || !existsSync(destAbs)) continue
          transferPendingGensUnderPath(srcAbs, resolveMvFinalBase(srcAbs, destAbs))
        }
      }
    }
  } catch (e) {
    console.warn("[AdoptionTracker] doRecordShellFileOps failed:", e)
  }
}

/**
 * Resolve the base path an `mv SRC DEST` actually lands SRC at, disambiguating
 * "rename SRC → DEST" from "move SRC into directory DEST". Runs post-`mv`, so
 * DEST exists; if DEST is a directory AND DEST/basename(SRC) now exists, SRC was
 * moved inside it; otherwise SRC was renamed to DEST. Best-effort.
 * Exported for unit testing.
 */
export function resolveMvFinalBase(srcAbs: string, destAbs: string): string {
  try {
    if (existsSync(destAbs) && statSync(destAbs).isDirectory()) {
      const inside = join(destAbs, basename(srcAbs))
      if (existsSync(inside)) return inside
    }
  } catch {
    // fall through to rename semantics
  }
  return destAbs
}

/** Void every pending gen at or under `prefixAbs` (an agent-deleted file/dir). */
async function voidPendingGensUnderPath(prefixAbs: string): Promise<void> {
  const minCreated = Date.now() - GEN_ATTRIBUTION_WINDOW_MS
  let pending: { event_id: string; file_path: string }[]
  try {
    pending = listPendingGenPaths(minCreated)
  } catch {
    return
  }
  for (const { event_id, file_path } of pending) {
    if (!isPathAtOrUnder(file_path, prefixAbs)) continue
    const row = getGenRowByEventId(event_id)
    if (!row || row.measured) continue
    const storedHashes = row.line_hashes ? unpackLineHashes(row.line_hashes) : null
    const generatedLineCount = storedHashes ? storedHashes.length : 0
    if (generatedLineCount > 0) {
      await emitSupersededAdopt(row, generatedLineCount, null, "agent_rm", "agent_file_op")
    }
    markMeasured(event_id)
    console.log(
      `[AdoptionTracker] agent rm voided pending gen: eventId=${event_id} file=${file_path} generatedLines=${generatedLineCount}`
    )
  }
}

/** Transfer pending gens at or under `srcAbs` to `finalBase` (an agent mv). */
function transferPendingGensUnderPath(srcAbs: string, finalBase: string): void {
  if (srcAbs === finalBase) return
  const minCreated = Date.now() - GEN_ATTRIBUTION_WINDOW_MS
  let pending: { event_id: string; file_path: string }[]
  try {
    pending = listPendingGenPaths(minCreated)
  } catch {
    return
  }
  for (const { event_id, file_path } of pending) {
    if (!isPathAtOrUnder(file_path, srcAbs)) continue
    // Suffix is "" for an exact-file move, "/sub/x.ts" for a dir move.
    const newPath = finalBase + file_path.slice(srcAbs.length)
    updateGenFilePath(event_id, newPath)
    console.log(
      `[AdoptionTracker] agent mv transferred pending gen: eventId=${event_id} ${file_path} -> ${newPath}`
    )
  }
}

// ─────────────────────────────────────────────────────────
// Local line-level 溯源 (read-only)
//
// Reconstructs, on demand, which committed lines a past generation was credited
// for. Content was never stored — only per-line FNV hashes (sqlite) — so we
// re-read the committed blob via `git show <sha>:<path>` and intersect its line
// hashes with the stored generation hashes. This recovers the *committed* text
// of adopted lines; lines the agent generated but that never reached the commit
// have no retrievable text (only a count). Only works for the current machine's
// own recent (≤7d) commits whose sqlite row survives.
// ─────────────────────────────────────────────────────────

export interface LocalAdoptionLine {
  lineNumber: number
  text: string
  /** True when this committed line matched a stored generated-line hash. */
  adopted: boolean
}

export interface LocalGenAdoptionLines {
  genEventId: string
  available: boolean
  /** Populated when available=false to explain the degradation. */
  reason?: string
  /** Repo-relative path of the committed file (best-effort). */
  relPath?: string
  /** Number of generated (net-new) lines recorded at gen time. */
  generatedLineCount?: number
  /** Committed lines that matched a stored generated-line hash. */
  matchedLineCount?: number
  /** True when the committed file exceeded the display cap and was truncated. */
  truncated?: boolean
  lines?: LocalAdoptionLine[]
}

const LOCAL_TRACE_MAX_GENS = 50
const LOCAL_TRACE_MAX_LINES = 4000

/**
 * Walk the committed file's physical lines, marking each as adopted when its
 * normalised hash is present in the stored generated-line multiset (consuming
 * the count so multiplicity is respected — mirrors the commit-time measure).
 */
function matchCommittedLinesAgainstHashes(
  committedText: string,
  storedHashes: Uint32Array,
  maxLines: number
): { lines: LocalAdoptionLine[]; matchedLineCount: number; truncated: boolean } {
  const counts = buildLineHashCounts(storedHashes)
  const physical = committedText.split(/\r?\n/)
  const limit = Math.min(physical.length, maxLines)
  const lines: LocalAdoptionLine[] = []
  let matchedLineCount = 0
  for (let i = 0; i < limit; i++) {
    const raw = physical[i]
    const norm = normalizeLine(raw)
    let adopted = false
    if (norm.length > 0) {
      const h = fnv1a32(norm)
      const c = counts.get(h)
      if (c && c > 0) {
        counts.set(h, c - 1)
        adopted = true
        matchedLineCount++
      }
    }
    lines.push({ lineNumber: i + 1, text: raw, adopted })
  }
  return { lines, matchedLineCount, truncated: physical.length > limit }
}

/**
 * Reconstruct local line-level adoption for specific generations of a commit.
 * Never throws — each gen degrades independently to `available: false` with a
 * human-readable reason. Side-effect free.
 */
export async function readLocalCommitAdoptionLines(
  commitSha: string,
  genEventIds: string[]
): Promise<LocalGenAdoptionLines[]> {
  const sha = (commitSha ?? "").trim()
  const ids = Array.isArray(genEventIds)
    ? genEventIds
        .filter((id): id is string => typeof id === "string" && id.length > 0)
        .slice(0, LOCAL_TRACE_MAX_GENS)
    : []
  if (!sha || ids.length === 0) return []

  const results: LocalGenAdoptionLines[] = []
  for (const genEventId of ids) {
    try {
      const row = getGenRowByEventId(genEventId)
      if (!row || !row.line_hashes || !row.file_path) {
        results.push({
          genEventId,
          available: false,
          reason: "本地无该生成记录或哈希已过期（仅当前机器近 14 天可逐行）"
        })
        continue
      }
      const absPath = row.file_path
      let gitRoot: string
      try {
        gitRoot = (
          await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
            encoding: "utf-8",
            cwd: dirname(absPath),
            timeout: 5000,
            maxBuffer: 1024 * 1024,
            windowsHide: true
          })
        ).stdout.trim()
      } catch {
        results.push({ genEventId, available: false, reason: "无法定位本地 git 仓库" })
        continue
      }
      const relPath = relative(gitRoot, absPath).replace(/\\/g, "/")
      let blob: Buffer
      try {
        blob = (
          await execFileAsync("git", ["show", `${sha}:${relPath}`], {
            encoding: "buffer",
            cwd: gitRoot,
            timeout: 5000,
            maxBuffer: STAGED_BLOB_MAX_BYTES,
            windowsHide: true
          })
        ).stdout
      } catch {
        results.push({
          genEventId,
          available: false,
          relPath,
          reason: "该文件在此 commit 中不存在（可能已删除或重命名）"
        })
        continue
      }
      const committedText = decodeCodeBuffer(blob)
      const storedHashes = unpackLineHashes(row.line_hashes)
      const { lines, matchedLineCount, truncated } = matchCommittedLinesAgainstHashes(
        committedText,
        storedHashes,
        LOCAL_TRACE_MAX_LINES
      )
      results.push({
        genEventId,
        available: true,
        relPath,
        generatedLineCount: storedHashes.length,
        matchedLineCount,
        truncated,
        lines
      })
    } catch (e) {
      results.push({
        genEventId,
        available: false,
        reason: e instanceof Error ? e.message : String(e)
      })
    }
  }
  return results
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
