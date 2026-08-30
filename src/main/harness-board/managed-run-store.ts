import { randomUUID } from "crypto"
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync
} from "fs"
import { dirname, join } from "path"
import type {
  ManagedRunEvent,
  ManagedRunEventCursor,
  ManagedRunEventsPage,
  ManagedRunDecisionFacts,
  ManagedRunIdentity,
  ManagedRunSnapshot,
  ManagedRunStatus,
  ManagedRunSummary
} from "../../shared/harness-board-types"

export interface ManagedRunStoreOptions {
  /** Fixed single-project managed-runs root used by tests. */
  rootDir?: string
}

export interface ManagedRunProjectDirectory {
  projectId: string
  projectDirectory: string
}

export interface ManagedRunProjectDirectoryProvider {
  resolveProjectDirectory(projectId: string): string
  listProjectDirectories(): ManagedRunProjectDirectory[]
}

export interface ManagedRunRecord extends ManagedRunIdentity {
  snapshot: ManagedRunSnapshot | null
  corrupt: boolean
  modifiedAtMs: number
}

type ManagedRunEventInput = {
  type: ManagedRunEvent["type"]
  scope?: ManagedRunEvent["scope"]
  source?: ManagedRunEvent["source"]
  nodeId?: string
  featureStatus?: ManagedRunEvent["featureStatus"]
  nodeStatus?: ManagedRunEvent["nodeStatus"]
  slashSkill?: string
  threadId?: string
  workspacePath?: string
  sourceThreadId?: string
  targetThreadId?: string
  decision?: string
  reasonCode?: string
  decisionFacts?: ManagedRunEvent["decisionFacts"]
  decisionRule?: string
  outcome?: ManagedRunEvent["outcome"]
  endReason?: ManagedRunEvent["endReason"]
  summary?: string
  [key: string]: unknown
}

interface JournalValidationState {
  size: number
  modifiedAtMs: number
}

const MANAGED_RUNS_DIR_NAME = "managed-runs"
const PROJECT_INTERNAL_DIR_NAME = ".cmbdevclaw"
const RUN_FILE_NAME = "run.json"
const EVENTS_FILE_NAME = "events.ndjson"
const SAFE_SEGMENT_PATTERN = /^[A-Za-z0-9_%-]+$/u
const MANAGED_RUN_TIME_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u
const EVENT_READ_CHUNK_BYTES = 64 * 1024
const EVENT_SUMMARY_MAX_LENGTH = 1024
const EVENT_CURSOR_VERSION = 1
const MANAGED_RUN_HASH_PATTERN = /^v1:sha256:[a-f0-9]{64}$/u
const MANAGED_RUN_EVENT_TYPES = new Set<ManagedRunEvent["type"]>([
  "run_started",
  "feature_inspected",
  "decision_made",
  "session_created",
  "session_started",
  "session_completed",
  "provider_retry_scheduled",
  "provider_retry_sent",
  "provider_retry_reset",
  "biz_retry_reuse_thread",
  "biz_retry_new_thread",
  "human_gate_requested",
  "human_gate_approved",
  "human_gate_rejected",
  "human_gate_conflict",
  "run_cancelled",
  "run_failed",
  "run_completed"
])
const MANAGED_RUN_STATUSES = new Set(["running", "failed", "completed", "cancelled"])
const HARNESS_FEATURE_STATUSES = new Set([
  "not_started",
  "in_progress",
  "done",
  "blocked",
  "warning",
  "error",
  "skipped",
  "archived",
  "unknown"
])
const HARNESS_NODE_STATUSES = new Set([
  "not_started",
  "in_progress",
  "done",
  "blocked",
  "warning",
  "error",
  "skipped",
  "archived",
  "unknown"
])
const MANAGED_RUN_CHANGED_FIELDS = new Set([
  "currentNode",
  "featureStatus",
  "currentNodeStatus",
  "nextAction"
])
const MANAGED_RUN_EVENT_SOURCES = new Set([
  "feature_status",
  "agent_end_reason",
  "controller_policy",
  "managed_run",
  "human_gate"
])
const AGENT_END_REASON_CODES = new Set([
  "normal",
  "provider_error",
  "hook_halt",
  "failure_fuse",
  "unknown"
])

export class ManagedRunCorruptError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ManagedRunCorruptError"
  }
}

export function formatManagedRunTimestamp(date = new Date()): string {
  const gmt8Date = new Date(date.getTime() + 8 * 60 * 60 * 1000)
  const pad = (value: number): string => String(value).padStart(2, "0")
  return (
    [gmt8Date.getUTCFullYear(), pad(gmt8Date.getUTCMonth() + 1), pad(gmt8Date.getUTCDate())].join(
      "-"
    ) +
    " " +
    [
      pad(gmt8Date.getUTCHours()),
      pad(gmt8Date.getUTCMinutes()),
      pad(gmt8Date.getUTCSeconds())
    ].join(":")
  )
}

function encodeSegment(value: string, label: string): string {
  const normalized = value.trim()
  if (
    !normalized ||
    normalized === "." ||
    normalized === ".." ||
    normalized.includes("/") ||
    normalized.includes("\\")
  ) {
    throw new Error(`Invalid ManagedRun ${label}`)
  }
  const encoded = encodeURIComponent(normalized)
  if (!SAFE_SEGMENT_PATTERN.test(encoded)) throw new Error(`Invalid ManagedRun ${label}`)
  return encoded
}

function decodeSegment(value: string, label: string): string {
  try {
    const decoded = decodeURIComponent(value)
    if (
      !decoded ||
      decoded === "." ||
      decoded === ".." ||
      decoded.includes("/") ||
      decoded.includes("\\")
    ) {
      throw new Error("unsafe segment")
    }
    return decoded
  } catch {
    throw new Error(`Invalid ManagedRun ${label}`)
  }
}

function assertRunId(runId: string): string {
  const normalized = runId.trim()
  if (!/^mr_[A-Za-z0-9_-]+$/u.test(normalized)) {
    throw new Error("Invalid ManagedRun runId")
  }
  return normalized
}

let projectDirectoryProvider: ManagedRunProjectDirectoryProvider | null = null

export function configureManagedRunProjectDirectories(
  provider: ManagedRunProjectDirectoryProvider
): void {
  projectDirectoryProvider = provider
}

function runDirectory(rootDir: string, identity: ManagedRunIdentity): string {
  return join(rootDir, encodeSegment(identity.featureId, "featureId"), assertRunId(identity.runId))
}

function featureDirectory(rootDir: string, featureId: string): string {
  return join(rootDir, encodeSegment(featureId, "featureId"))
}

function runFilePath(rootDir: string, identity: ManagedRunIdentity): string {
  return join(runDirectory(rootDir, identity), RUN_FILE_NAME)
}

function eventsFilePath(rootDir: string, identity: ManagedRunIdentity): string {
  return join(runDirectory(rootDir, identity), EVENTS_FILE_NAME)
}

function ensureDirectory(path: string): void {
  mkdirSync(path, { recursive: true })
}

function fsyncPath(path: string): void {
  const descriptor = openSync(path, "r")
  try {
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}

function fsyncDirectory(path: string): void {
  try {
    fsyncPath(path)
  } catch {
    // Some platforms do not allow opening directories for fsync.
  }
}

function atomicWrite(path: string, content: string): void {
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`
  let descriptor: number | null = null
  try {
    descriptor = openSync(temporaryPath, "w", 0o600)
    writeFileSync(descriptor, content, "utf8")
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = null
    renameSync(temporaryPath, path)
    fsyncDirectory(dirname(path))
  } catch (error) {
    if (descriptor !== null) closeSync(descriptor)
    if (existsSync(temporaryPath)) rmSync(temporaryPath, { force: true })
    throw error
  }
}

function boundedText(value: string | undefined, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined
  const normalized = value.trim()
  if (!normalized) return undefined
  return normalized.length > maxLength
    ? `${normalized.slice(0, Math.max(0, maxLength - 1))}…`
    : normalized
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function isOptionalText(value: unknown, maxLength = 4096): boolean {
  return value === undefined || (typeof value === "string" && value.length <= maxLength)
}

function isNonNegativeInteger(value: unknown): boolean {
  return Number.isInteger(value) && (value as number) >= 0
}

function isOptionalNonNegativeNumber(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isFinite(value) && value >= 0)
}

function isAgentEndReason(value: unknown): boolean {
  if (!isPlainRecord(value) || !AGENT_END_REASON_CODES.has(value.code as string)) return false
  return isOptionalText(value.message, EVENT_SUMMARY_MAX_LENGTH)
}

function isManagedRunDecisionFacts(value: unknown): value is ManagedRunDecisionFacts {
  if (!isPlainRecord(value)) return false
  return (
    typeof value.currentNodeId === "string" &&
    value.currentNodeId.length > 0 &&
    HARNESS_FEATURE_STATUSES.has(value.featureStatus as string) &&
    HARNESS_NODE_STATUSES.has(value.currentNodeStatus as string) &&
    Array.isArray(value.changedFields) &&
    value.changedFields.length <= MANAGED_RUN_CHANGED_FIELDS.size &&
    value.changedFields.every((field) => MANAGED_RUN_CHANGED_FIELDS.has(field as string)) &&
    typeof value.initialInspection === "boolean" &&
    isNonNegativeInteger(value.bizRetryCount) &&
    isNonNegativeInteger(value.providerRetryCount) &&
    isOptionalText(value.slashSkill, 256) &&
    isOptionalText(value.previousNodeId, 512) &&
    isOptionalNonNegativeNumber(value.contextInputTokens) &&
    isOptionalNonNegativeNumber(value.contextMaxTokens) &&
    isOptionalNonNegativeNumber(value.contextUsageRatio) &&
    isOptionalNonNegativeNumber(value.contextReuseThreshold) &&
    (value.contextReusable === undefined || typeof value.contextReusable === "boolean") &&
    (value.terminalOutcome === undefined ||
      value.terminalOutcome === "success" ||
      value.terminalOutcome === "error") &&
    isOptionalText(value.terminalReason, EVENT_SUMMARY_MAX_LENGTH)
  )
}

function isManagedRunCurrentSession(value: unknown): boolean {
  if (value === undefined) return true
  if (!isPlainRecord(value)) return false
  return (
    typeof value.threadId === "string" &&
    value.threadId.length > 0 &&
    value.threadId.length <= 512 &&
    isOptionalText(value.workspacePath, 4096)
  )
}

function isManagedRunDecisionBaseline(value: unknown): boolean {
  if (value === undefined) return true
  if (!isPlainRecord(value)) return false
  return (
    typeof value.nodeId === "string" &&
    value.nodeId.length > 0 &&
    value.nodeId.length <= 512 &&
    typeof value.featureStateHash === "string" &&
    MANAGED_RUN_HASH_PATTERN.test(value.featureStateHash) &&
    HARNESS_FEATURE_STATUSES.has(value.featureStatus as string) &&
    HARNESS_NODE_STATUSES.has(value.nodeStatus as string) &&
    typeof value.nextActionHash === "string" &&
    MANAGED_RUN_HASH_PATTERN.test(value.nextActionHash)
  )
}

function isManagedRunLastDecision(value: unknown): boolean {
  if (value === undefined) return true
  if (!isPlainRecord(value)) return false
  return (
    typeof value.decision === "string" &&
    value.decision.length > 0 &&
    value.decision.length <= 128 &&
    isOptionalText(value.reasonCode, 128) &&
    isOptionalText(value.summary, EVENT_SUMMARY_MAX_LENGTH) &&
    isOptionalText(value.rule, EVENT_SUMMARY_MAX_LENGTH) &&
    (value.facts === undefined || isManagedRunDecisionFacts(value.facts)) &&
    typeof value.createTime === "string" &&
    MANAGED_RUN_TIME_PATTERN.test(value.createTime)
  )
}

function normalizeSnapshot(value: unknown): ManagedRunSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ManagedRunCorruptError("ManagedRun run.json must contain an object")
  }
  const snapshot = value as Partial<ManagedRunSnapshot>
  if (
    snapshot.version !== 2 ||
    typeof snapshot.runId !== "string" ||
    !snapshot.runId.trim() ||
    typeof snapshot.projectId !== "string" ||
    !snapshot.projectId.trim() ||
    typeof snapshot.featureId !== "string" ||
    !snapshot.featureId.trim() ||
    !MANAGED_RUN_STATUSES.has(snapshot.status as string) ||
    !isOptionalText(snapshot.workspacePath, 4096) ||
    !isManagedRunCurrentSession(snapshot.currentSession) ||
    !isManagedRunDecisionBaseline(snapshot.decisionBaseline) ||
    (snapshot.currentSession === undefined) !== (snapshot.decisionBaseline === undefined) ||
    !isNonNegativeInteger(snapshot.providerRetryCount) ||
    !isNonNegativeInteger(snapshot.bizRetryCount) ||
    (snapshot.nextRetryAt !== undefined &&
      (typeof snapshot.nextRetryAt !== "string" ||
        !MANAGED_RUN_TIME_PATTERN.test(snapshot.nextRetryAt))) ||
    !isOptionalText(snapshot.failureReason, EVENT_SUMMARY_MAX_LENGTH) ||
    !isOptionalText(snapshot.cancellationReason, EVENT_SUMMARY_MAX_LENGTH) ||
    typeof snapshot.startedAt !== "string" ||
    !MANAGED_RUN_TIME_PATTERN.test(snapshot.startedAt) ||
    typeof snapshot.updatedAt !== "string" ||
    !MANAGED_RUN_TIME_PATTERN.test(snapshot.updatedAt) ||
    (snapshot.completedAt !== undefined &&
      (typeof snapshot.completedAt !== "string" ||
        !MANAGED_RUN_TIME_PATTERN.test(snapshot.completedAt))) ||
    !isManagedRunLastDecision(snapshot.lastDecision)
  ) {
    throw new ManagedRunCorruptError("ManagedRun run.json has an invalid snapshot")
  }
  return snapshot as ManagedRunSnapshot
}

function readSnapshot(path: string): ManagedRunSnapshot {
  return normalizeSnapshot(JSON.parse(readFileSync(path, "utf8")))
}

function normalizeEvent(value: unknown, identity: ManagedRunIdentity): ManagedRunEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ManagedRunCorruptError("ManagedRun event must contain an object")
  }
  const event = value as Partial<ManagedRunEvent>
  const validDecisionFacts =
    event.decisionFacts === undefined || isManagedRunDecisionFacts(event.decisionFacts)
  const validFeatureInspection =
    event.type !== "feature_inspected" ||
    (event.scope === "stage" &&
      typeof event.nodeId === "string" &&
      event.nodeId.length > 0 &&
      HARNESS_FEATURE_STATUSES.has(event.featureStatus as string) &&
      HARNESS_NODE_STATUSES.has(event.nodeStatus as string))
  const validDecision =
    event.type !== "decision_made" ||
    (typeof event.decision === "string" &&
      event.decision.length > 0 &&
      isManagedRunDecisionFacts(event.decisionFacts) &&
      typeof event.decisionRule === "string" &&
      event.decisionRule.length > 0)
  const validSessionCompletion =
    event.type !== "session_completed" ||
    (typeof event.threadId === "string" &&
      event.threadId.length > 0 &&
      (event.outcome === "success" || event.outcome === "error") &&
      isAgentEndReason(event.endReason))
  if (
    event.version !== 2 ||
    typeof event.eventId !== "string" ||
    !event.eventId.trim() ||
    typeof event.createTime !== "string" ||
    !MANAGED_RUN_TIME_PATTERN.test(event.createTime) ||
    typeof event.type !== "string" ||
    !MANAGED_RUN_EVENT_TYPES.has(event.type as ManagedRunEvent["type"]) ||
    typeof event.runId !== "string" ||
    event.runId !== identity.runId ||
    (event.scope !== "global" && event.scope !== "stage") ||
    (event.source !== undefined && !MANAGED_RUN_EVENT_SOURCES.has(event.source)) ||
    (event.featureStatus !== undefined &&
      !HARNESS_FEATURE_STATUSES.has(event.featureStatus as string)) ||
    (event.nodeStatus !== undefined && !HARNESS_NODE_STATUSES.has(event.nodeStatus as string)) ||
    (event.outcome !== undefined && event.outcome !== "success" && event.outcome !== "error") ||
    !isOptionalText(event.nodeId, 512) ||
    !isOptionalText(event.threadId, 512) ||
    !isOptionalText(event.workspacePath, 4096) ||
    !isOptionalText(event.sourceThreadId, 512) ||
    !isOptionalText(event.targetThreadId, 512) ||
    !isOptionalText(event.slashSkill, 256) ||
    !isOptionalText(event.decision, 128) ||
    !isOptionalText(event.reasonCode, 128) ||
    !isOptionalText(event.decisionRule, EVENT_SUMMARY_MAX_LENGTH) ||
    !isOptionalText(event.summary, EVENT_SUMMARY_MAX_LENGTH) ||
    !validDecisionFacts ||
    !validFeatureInspection ||
    !validDecision ||
    !validSessionCompletion ||
    (event.endReason !== undefined && !isAgentEndReason(event.endReason))
  ) {
    throw new ManagedRunCorruptError("ManagedRun event has an invalid schema")
  }
  return event as ManagedRunEvent
}

function encodeEventCursor(identity: ManagedRunIdentity, offset: number): ManagedRunEventCursor {
  return Buffer.from(
    JSON.stringify({
      version: EVENT_CURSOR_VERSION,
      projectId: identity.projectId,
      featureId: identity.featureId,
      runId: identity.runId,
      offset
    }),
    "utf8"
  ).toString("base64url")
}

function decodeEventCursor(
  cursor: ManagedRunEventCursor,
  identity: ManagedRunIdentity
): number {
  if (!cursor || cursor.length > 4096) throw new Error("Invalid ManagedRun event cursor")
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("invalid cursor payload")
    }
    const payload = parsed as Record<string, unknown>
    if (
      payload.version !== EVENT_CURSOR_VERSION ||
      payload.projectId !== identity.projectId ||
      payload.featureId !== identity.featureId ||
      payload.runId !== identity.runId ||
      !Number.isSafeInteger(payload.offset)
    ) {
      throw new Error("cursor identity mismatch")
    }
    return payload.offset as number
  } catch {
    throw new Error("Invalid ManagedRun event cursor")
  }
}

function fileModifiedAtMs(path: string): number {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

function recordModifiedAtMs(rootDir: string, identity: ManagedRunIdentity): number {
  return Math.max(
    fileModifiedAtMs(runFilePath(rootDir, identity)),
    fileModifiedAtMs(eventsFilePath(rootDir, identity)),
    fileModifiedAtMs(runDirectory(rootDir, identity))
  )
}

export function resolveManagedRunProjectRoot(projectDirectory: string): string {
  return join(projectDirectory, PROJECT_INTERNAL_DIR_NAME, MANAGED_RUNS_DIR_NAME)
}

export class ManagedRunStore {
  private readonly fixedRootDir?: string
  private readonly validatedJournals = new Map<string, JournalValidationState>()

  constructor(options: ManagedRunStoreOptions = {}) {
    this.fixedRootDir = options.rootDir
  }

  private rootDirForProject(projectId: string): string {
    if (this.fixedRootDir) return this.fixedRootDir
    if (!projectDirectoryProvider) {
      throw new Error("ManagedRun project directory provider is not configured")
    }
    return resolveManagedRunProjectRoot(projectDirectoryProvider.resolveProjectDirectory(projectId))
  }

  getRootDir(projectId?: string): string {
    if (this.fixedRootDir) return this.fixedRootDir
    if (!projectId) throw new Error("ManagedRun projectId is required")
    return this.rootDirForProject(projectId)
  }

  private ensureHealthyJournal(identity: ManagedRunIdentity): { repaired: boolean } {
    const path = eventsFilePath(this.rootDirForProject(identity.projectId), identity)
    if (!existsSync(path)) return { repaired: false }
    const initialStat = statSync(path)
    const cached = this.validatedJournals.get(path)
    if (cached?.size === initialStat.size && cached.modifiedAtMs === initialStat.mtimeMs) {
      return { repaired: false }
    }

    const content = readFileSync(path)
    let lineStart = 0
    for (let index = 0; index <= content.length; index += 1) {
      const atEnd = index === content.length
      if (!atEnd && content[index] !== 0x0a) continue
      let lineEnd = index
      if (lineEnd > lineStart && content[lineEnd - 1] === 0x0d) lineEnd -= 1
      const line = content.subarray(lineStart, lineEnd).toString("utf8").trim()
      if (line) {
        try {
          normalizeEvent(JSON.parse(line) as unknown, identity)
        } catch (error) {
          const remaining = atEnd
            ? ""
            : content
                .subarray(index + 1)
                .toString("utf8")
                .trim()
          if (remaining) {
            throw error instanceof ManagedRunCorruptError
              ? error
              : new ManagedRunCorruptError(String(error))
          }
          truncateSync(path, lineStart)
          fsyncPath(path)
          const repairedStat = statSync(path)
          this.validatedJournals.set(path, {
            size: repairedStat.size,
            modifiedAtMs: repairedStat.mtimeMs
          })
          return { repaired: true }
        }
      }
      lineStart = index + 1
    }

    if (content.length > 0 && content[content.length - 1] !== 0x0a) {
      const descriptor = openSync(path, "a")
      try {
        writeFileSync(descriptor, "\n", "utf8")
        fsyncSync(descriptor)
      } finally {
        closeSync(descriptor)
      }
      const repairedStat = statSync(path)
      this.validatedJournals.set(path, {
        size: repairedStat.size,
        modifiedAtMs: repairedStat.mtimeMs
      })
      return { repaired: true }
    }

    this.validatedJournals.set(path, {
      size: initialStat.size,
      modifiedAtMs: initialStat.mtimeMs
    })
    return { repaired: false }
  }

  private appendPreparedEvent(
    snapshot: ManagedRunSnapshot,
    event: ManagedRunEventInput,
    createTime: string
  ): ManagedRunEvent {
    const rootDir = this.rootDirForProject(snapshot.projectId)
    const path = eventsFilePath(rootDir, snapshot)
    ensureDirectory(runDirectory(rootDir, snapshot))
    this.ensureHealthyJournal(snapshot)
    const summary = boundedText(event.summary, EVENT_SUMMARY_MAX_LENGTH)
    const slashSkill =
      typeof event.slashSkill === "string" ? boundedText(event.slashSkill, 256) : undefined
    const endReasonMessage = boundedText(event.endReason?.message, EVENT_SUMMARY_MAX_LENGTH)
    const next: ManagedRunEvent = {
      ...event,
      version: 2,
      eventId: randomUUID(),
      createTime,
      type: event.type as ManagedRunEvent["type"],
      runId: snapshot.runId,
      scope: event.scope ?? (event.nodeId ? "stage" : "global"),
      nodeId: boundedText(event.nodeId, 512),
      featureStatus: event.featureStatus,
      nodeStatus: event.nodeStatus,
      threadId: boundedText(event.threadId, 512),
      sourceThreadId: boundedText(event.sourceThreadId, 512),
      targetThreadId: boundedText(event.targetThreadId, 512),
      workspacePath: boundedText(event.workspacePath, 4096),
      decision: boundedText(event.decision, 128),
      reasonCode: boundedText(event.reasonCode, 128),
      decisionRule: boundedText(event.decisionRule, EVENT_SUMMARY_MAX_LENGTH),
      outcome: event.outcome,
      endReason: event.endReason
        ? {
            code: event.endReason.code,
            ...(endReasonMessage ? { message: endReasonMessage } : {})
          }
        : undefined,
      slashSkill,
      summary
    }
    const validated = normalizeEvent(next, snapshot)
    const descriptor = openSync(path, "a", 0o600)
    try {
      writeFileSync(descriptor, `${JSON.stringify(validated)}\n`, "utf8")
      fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
    const nextStat = statSync(path)
    this.validatedJournals.set(path, {
      size: nextStat.size,
      modifiedAtMs: nextStat.mtimeMs
    })
    return validated
  }

  createRun(projectId: string, featureId: string, workspacePath?: string): ManagedRunSnapshot {
    const runId = `mr_${randomUUID().replace(/-/gu, "")}`
    const now = formatManagedRunTimestamp()
    const snapshot: ManagedRunSnapshot = {
      version: 2,
      runId,
      projectId,
      featureId,
      status: "running",
      ...(workspacePath?.trim() ? { workspacePath: workspacePath.trim() } : {}),
      providerRetryCount: 0,
      bizRetryCount: 0,
      startedAt: now,
      updatedAt: now
    }
    this.writeSnapshot(snapshot)
    this.appendEvent(snapshot, {
      type: "run_started",
      scope: "global",
      source: "managed_run",
      summary: "托管运行已启动"
    })
    return snapshot
  }

  writeSnapshot(snapshot: ManagedRunSnapshot): void {
    const validated = normalizeSnapshot(snapshot)
    const rootDir = this.rootDirForProject(validated.projectId)
    const path = runFilePath(rootDir, validated)
    ensureDirectory(runDirectory(rootDir, validated))
    atomicWrite(path, `${JSON.stringify(validated, null, 2)}\n`)
  }

  appendEvent(snapshot: ManagedRunSnapshot, event: ManagedRunEventInput): ManagedRunEvent {
    return this.appendPreparedEvent(snapshot, event, formatManagedRunTimestamp())
  }

  updateSnapshot(snapshot: ManagedRunSnapshot, event?: ManagedRunEventInput): ManagedRunSnapshot {
    const now = formatManagedRunTimestamp()
    const reasonCode = boundedText(event?.reasonCode, 128)
    const summary = boundedText(event?.summary, EVENT_SUMMARY_MAX_LENGTH)
    const rule = boundedText(event?.decisionRule, EVENT_SUMMARY_MAX_LENGTH)
    const lastDecision =
      event?.type === "decision_made" && typeof event.decision === "string"
        ? {
            decision: event.decision,
            ...(reasonCode ? { reasonCode } : {}),
            ...(summary ? { summary } : {}),
            ...(event.decisionFacts ? { facts: event.decisionFacts } : {}),
            ...(rule ? { rule } : {}),
            createTime: now
          }
        : snapshot.lastDecision
    const next: ManagedRunSnapshot = {
      ...snapshot,
      updatedAt: now,
      ...(lastDecision ? { lastDecision } : {})
    }
    this.writeSnapshot(next)
    if (event) this.appendPreparedEvent(next, event, now)
    return next
  }

  getRun(identity: ManagedRunIdentity): ManagedRunRecord {
    const rootDir = this.rootDirForProject(identity.projectId)
    const path = runFilePath(rootDir, identity)
    const modifiedAtMs = recordModifiedAtMs(rootDir, identity)
    if (!existsSync(path)) {
      return { ...identity, snapshot: null, corrupt: true, modifiedAtMs }
    }
    try {
      const snapshot = readSnapshot(path)
      if (
        snapshot.runId !== identity.runId ||
        snapshot.projectId !== identity.projectId ||
        snapshot.featureId !== identity.featureId
      ) {
        throw new ManagedRunCorruptError("ManagedRun identity mismatch")
      }
      return { ...identity, snapshot, corrupt: false, modifiedAtMs }
    } catch {
      return { ...identity, snapshot: null, corrupt: true, modifiedAtMs }
    }
  }

  private listFeatureRuns(projectId: string, featureId: string): ManagedRunRecord[] {
    const path = featureDirectory(this.rootDirForProject(projectId), featureId)
    if (!existsSync(path)) return []
    const records: ManagedRunRecord[] = []
    for (const runSegment of readdirSync(path, { withFileTypes: true })) {
      if (!runSegment.isDirectory() || !/^mr_[A-Za-z0-9_-]+$/u.test(runSegment.name)) continue
      records.push(this.getRun({ projectId, featureId, runId: runSegment.name }))
    }
    return records
  }

  private listRunsInRoot(rootDir: string, projectId?: string): ManagedRunRecord[] {
    if (!existsSync(rootDir)) return []
    const records: ManagedRunRecord[] = []
    for (const featureSegment of readdirSync(rootDir, { withFileTypes: true })) {
      if (!featureSegment.isDirectory()) continue
      let featureId: string
      try {
        featureId = decodeSegment(featureSegment.name, "featureId")
      } catch {
        continue
      }
      const featurePath = join(rootDir, featureSegment.name)
      for (const runSegment of readdirSync(featurePath, { withFileTypes: true })) {
        if (!runSegment.isDirectory() || !/^mr_[A-Za-z0-9_-]+$/u.test(runSegment.name)) continue
        if (projectId) {
          records.push(this.getRun({ projectId, featureId, runId: runSegment.name }))
          continue
        }
        try {
          const snapshot = readSnapshot(join(featurePath, runSegment.name, RUN_FILE_NAME))
          records.push(this.getRun(snapshot))
        } catch {
          // Fixed-root test stores cannot attribute a corrupt snapshot to a project.
        }
      }
    }
    return records
  }

  listRuns(): ManagedRunRecord[] {
    if (this.fixedRootDir) return this.listRunsInRoot(this.fixedRootDir)
    if (!projectDirectoryProvider) {
      throw new Error("ManagedRun project directory provider is not configured")
    }
    return projectDirectoryProvider
      .listProjectDirectories()
      .flatMap(({ projectId, projectDirectory }) =>
        this.listRunsInRoot(resolveManagedRunProjectRoot(projectDirectory), projectId)
      )
  }

  findRunningRun(projectId: string, featureId: string): ManagedRunRecord | null {
    for (const record of this.listFeatureRuns(projectId, featureId)) {
      if (
        record.corrupt ||
        !record.snapshot ||
        isManagedRunTerminal(record.snapshot.status)
      ) {
        continue
      }
      try {
        this.ensureHealthyJournal(record)
        return record
      } catch {
        // A corrupt Run is quarantined history, not an active execution source.
      }
    }
    return null
  }

  getLatestRun(projectId: string, featureId: string): ManagedRunSummary | null {
    const record = this.listFeatureRuns(projectId, featureId).sort(
      (left, right) => right.modifiedAtMs - left.modifiedAtMs
    )[0]
    if (!record) return null
    if (record.corrupt || !record.snapshot) {
      return {
        version: 2,
        runId: record.runId,
        projectId: record.projectId,
        featureId: record.featureId,
        status: "corrupt",
        corrupt: true,
        providerRetryCount: 0,
        bizRetryCount: 0,
        startedAt: "",
        updatedAt: ""
      }
    }
    try {
      this.ensureHealthyJournal(record)
      return record.snapshot
    } catch {
      return { ...record.snapshot, status: "corrupt", corrupt: true }
    }
  }

  validateRunEvents(identity: ManagedRunIdentity): { repaired: boolean } {
    return this.ensureHealthyJournal(identity)
  }

  listEvents(
    identity: ManagedRunIdentity,
    cursor?: ManagedRunEventCursor,
    limit = 200
  ): ManagedRunEventsPage {
    const path = eventsFilePath(this.rootDirForProject(identity.projectId), identity)
    if (!existsSync(path)) return { events: [], hasMore: false }
    this.ensureHealthyJournal(identity)
    const size = statSync(path).size
    const normalizedCursor = cursor === undefined ? size : decodeEventCursor(cursor, identity)
    if (normalizedCursor < 0 || normalizedCursor > size) {
      throw new Error("Invalid ManagedRun event cursor")
    }
    if (normalizedCursor > 0 && normalizedCursor < size) {
      const cursorDescriptor = openSync(path, "r")
      try {
        const previousByte = Buffer.allocUnsafe(1)
        readSync(cursorDescriptor, previousByte, 0, 1, normalizedCursor - 1)
        if (previousByte[0] !== 0x0a) throw new Error("Invalid ManagedRun event cursor")
      } finally {
        closeSync(cursorDescriptor)
      }
    }

    const boundedLimit = Math.min(Math.max(Number.isInteger(limit) ? limit : 200, 1), 500)
    if (normalizedCursor === 0) return { events: [], hasMore: false }
    const newestFirst: ManagedRunEvent[] = []
    let nextCursor = normalizedCursor
    const descriptor = openSync(path, "r")
    try {
      const readByte = (position: number): number => {
        const byte = Buffer.allocUnsafe(1)
        readSync(descriptor, byte, 0, 1, position)
        return byte[0]
      }
      const readEventRange = (start: number, end: number): ManagedRunEvent | null => {
        if (end <= start) return null
        const lineBuffer = Buffer.allocUnsafe(end - start)
        readSync(descriptor, lineBuffer, 0, lineBuffer.length, start)
        let lineEnd = lineBuffer.length
        if (lineEnd > 0 && lineBuffer[lineEnd - 1] === 0x0d) lineEnd -= 1
        const line = lineBuffer.subarray(0, lineEnd).toString("utf8").trim()
        return line ? normalizeEvent(JSON.parse(line) as unknown, identity) : null
      }

      let lineEnd = normalizedCursor
      if (lineEnd > 0 && readByte(lineEnd - 1) === 0x0a) lineEnd -= 1
      let scanPosition = lineEnd
      while (newestFirst.length < boundedLimit && scanPosition > 0) {
        const chunkStart = Math.max(0, scanPosition - EVENT_READ_CHUNK_BYTES)
        const chunk = Buffer.allocUnsafe(scanPosition - chunkStart)
        const bytesRead = readSync(descriptor, chunk, 0, chunk.length, chunkStart)
        for (
          let index = bytesRead - 1;
          index >= 0 && newestFirst.length < boundedLimit;
          index -= 1
        ) {
          if (chunk[index] !== 0x0a) continue
          const lineStart = chunkStart + index + 1
          const event = readEventRange(lineStart, lineEnd)
          if (event) {
            newestFirst.push(event)
            nextCursor = lineStart
          }
          lineEnd = chunkStart + index
        }
        scanPosition = chunkStart
      }
      if (newestFirst.length < boundedLimit && scanPosition === 0 && lineEnd > 0) {
        const event = readEventRange(0, lineEnd)
        if (event) {
          newestFirst.push(event)
          nextCursor = 0
        }
      }
    } finally {
      closeSync(descriptor)
    }

    return {
      events: newestFirst.reverse(),
      ...(nextCursor > 0 ? { nextCursor: encodeEventCursor(identity, nextCursor) } : {}),
      hasMore: nextCursor > 0
    }
  }

  removeProject(projectId: string, projectDirectory?: string): void {
    const path = projectDirectory
      ? resolveManagedRunProjectRoot(projectDirectory)
      : this.rootDirForProject(projectId)
    if (existsSync(path)) rmSync(path, { recursive: true, force: true })
  }
}

export const managedRunStore = new ManagedRunStore()

export function isManagedRunTerminal(status: ManagedRunStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled"
}
