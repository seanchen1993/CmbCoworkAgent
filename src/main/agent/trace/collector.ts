/**
 * Agent Trace Collector
 *
 * Collects execution data during a single agent run and writes the completed
 * trace to a local JSONL file.  Remote reporting is delegated to an
 * ITraceReporter (default: NoopTraceReporter).
 *
 * Usage (from ipc/agent.ts):
 *
 *   const tracer = new TraceCollector(threadId, userMessage, modelId)
 *   tracer.beginStep()
 *   tracer.recordToolCall({ name, args, result, durationMs })
 *   tracer.endStep(assistantText)
 *   await tracer.finish("success")
 */

import { createHash } from "crypto"
import { join } from "path"
import { homedir } from "os"
import { lstat, opendir, readFile, rename, rmdir, unlink, writeFile } from "fs/promises"
import { v4 as uuid } from "uuid"
import type {
  AgentTrace,
  TraceContext,
  TraceExecutionMode,
  TraceHarnessFeatureContext,
  TraceKind,
  TraceObservabilityContext,
  TraceSkillEvalExtension,
  TraceStep,
  TraceChatMessage,
  TraceToolCall,
  TraceModelCall,
  TraceNode,
  TraceNodeStatus,
  TraceOutcome,
  TraceTriggerSource,
  ITraceReporter,
  RoutingTrace
} from "./types"
import { NoopTraceReporter, TRACE_OBSERVABILITY_SCHEMA_VERSION } from "./types"
import { hasSuspectedTechnicalDetailSupplement } from "./technical-detail-supplement"
import { summarizeTraceCacheTokens } from "./token-usage"
import { app, safeStorage } from "electron"
import { getLocalIP } from "../../net-utils"
import { getUserInfo } from "../../storage"
import { listAllSkills } from "../../ipc/skills"
import { getHarnessProjectAdapterSnapshot } from "../../harness-board/service"
import { nowIsoLocal } from "../../util/local-time"
import { deriveUpperOrgLevelsFromPath } from "../../org-levels"
import {
  DEFAULT_SKILL_VERSION,
  ensureVersionedSkillIdentifier,
  parseSkillIdentifier
} from "../../utils/skill-identifiers"
import {
  makePluginSkillSourceRef,
  normalizeSkillSourceRefs,
  parsePluginSkillSourceRef,
  type PluginSkillSourceRef
} from "../../utils/skill-source"
import {
  setAdoptionContext,
  clearAdoptionContext,
  patchAdoptionContextForTrace
} from "../../services/adoption-tracker"
import { flushSystemConstraintReadSummaries } from "../../services/system-constraint-read-reporter"
import { sanitizeTraceForCloudUpload } from "./sanitizer"
import { buildSkillEvalTraceExtension } from "../skill-eval/documents"
import {
  getTraceLocalStorage,
  type TraceKeyProtector,
  type TraceStorageInitializationResult
} from "./local-storage"
import { TraceContentInterner, rehydrateTraceContent } from "./content-refs"
import {
  TRACE_COLLECTION_MAX_BYTES,
  TRACE_PERSISTED_MAX_BYTES,
  TraceCollectionBudget,
  clampText
} from "./bounds"
import {
  appendSkillEvalWindowTurn,
  getSkillEvalWindowAssistantText,
  getSkillEvalWindowContextByRawName
} from "../skill-eval/window"

// ─────────────────────────────────────────────────────────
// Global reporter registry
// ─────────────────────────────────────────────────────────

let _reporter: ITraceReporter = new NoopTraceReporter()
const pendingTraceReports = new Set<Promise<void>>()

/** Replace the global reporter (call at app startup for remote upload). */
export function setTraceReporter(reporter: ITraceReporter): void {
  _reporter = reporter
}

export function getTraceReporter(): ITraceReporter {
  return _reporter
}

function reportTraceInBackground(trace: AgentTrace): void {
  const reporter = _reporter
  const reportTask = Promise.resolve()
    .then(() => reporter.report(sanitizeTraceForCloudUpload(trace)))
    .catch((error) => {
      console.warn("[Tracer] Reporter.report() threw:", error)
    })
  pendingTraceReports.add(reportTask)
  void reportTask.finally(() => {
    pendingTraceReports.delete(reportTask)
  })
}

export function hasPendingTraceReports(): boolean {
  return pendingTraceReports.size > 0
}

/** Wait for reports already scheduled by completed traces, bounded for app shutdown. */
export async function flushPendingTraceReports(timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs)

  while (pendingTraceReports.size > 0) {
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) {
      console.warn(
        `[Tracer] Timed out waiting for ${pendingTraceReports.size} pending trace report(s)`
      )
      return false
    }

    let timeoutId: ReturnType<typeof setTimeout> | undefined
    const completed = await Promise.race([
      Promise.allSettled(Array.from(pendingTraceReports)).then(() => true as const),
      new Promise<false>((resolve) => {
        timeoutId = setTimeout(() => resolve(false), remainingMs)
      })
    ])
    if (timeoutId !== undefined) clearTimeout(timeoutId)
    if (!completed) {
      console.warn(
        `[Tracer] Timed out waiting for ${pendingTraceReports.size} pending trace report(s)`
      )
      return false
    }
  }

  return true
}

// ─────────────────────────────────────────────────────────
// Storage helpers
// ─────────────────────────────────────────────────────────

function getOpenworkDir(): string {
  return process.env.CMB_COWORK_AGENT_HOME || join(homedir(), ".cmbcoworkagent")
}

function getTracesRootDir(): string {
  return process.env.CMB_COWORK_TRACES_DIR || join(getOpenworkDir(), "traces")
}

function getThreadTracesDir(threadId: string): string {
  return join(getTracesRootDir(), threadId)
}

const MAX_TRACES_PER_THREAD = 50
const TRACE_WRITE_QUEUE_MAX_ITEMS = 16
const TRACE_WRITE_QUEUE_MAX_BYTES = 8 * 1024 * 1024
const TRACE_PRUNE_MAX_ENTRIES = 4_096
const TRACE_IO_YIELD_INTERVAL = 128
let traceStorageDisabledLogged = false

interface QueuedTraceWrite {
  trace: AgentTrace
  estimatedBytes: number
}

const traceWriteQueue: QueuedTraceWrite[] = []
let traceWriteQueueBytes = 0
let traceWriteQueueRunning = false
let droppedTraceWrites = 0
const traceWriteQueueWaiters: Array<() => void> = []

function yieldTraceIo(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

function traceLocalStorage() {
  return getTraceLocalStorage(getTracesRootDir(), safeStorage as TraceKeyProtector | undefined)
}

function notifyTraceWriteQueueIdle(): void {
  if (traceWriteQueueRunning || traceWriteQueue.length > 0) return
  for (const resolve of traceWriteQueueWaiters.splice(0)) resolve()
}

async function drainTraceWriteQueue(): Promise<void> {
  if (traceWriteQueueRunning) return
  traceWriteQueueRunning = true
  try {
    while (traceWriteQueue.length > 0) {
      const queued = traceWriteQueue.shift()
      if (!queued) continue
      await yieldTraceIo()
      try {
        const serialized = JSON.stringify(queued.trace)
        if (Buffer.byteLength(serialized, "utf8") > TRACE_PERSISTED_MAX_BYTES) {
          droppedTraceWrites += 1
          continue
        }
        const storage = traceLocalStorage()
        const filePath = join(
          getThreadTracesDir(queued.trace.threadId),
          `${queued.trace.traceId}.jsonl`
        )
        const written = await storage.appendJsonLine(filePath, serialized)
        if (!written) {
          if (!traceStorageDisabledLogged) {
            traceStorageDisabledLogged = true
            console.warn("[Tracer] Local trace persistence is disabled or over its byte budget")
          }
          continue
        }
        await pruneOldTraces(queued.trace.threadId)
      } catch (error) {
        droppedTraceWrites += 1
        if (!traceStorageDisabledLogged) {
          traceStorageDisabledLogged = true
          console.warn(
            `[Tracer] Trace was not persisted: ${
              error instanceof Error ? error.message : String(error)
            }`
          )
        }
      } finally {
        traceWriteQueueBytes = Math.max(0, traceWriteQueueBytes - queued.estimatedBytes)
      }
    }
  } finally {
    traceWriteQueueRunning = false
    notifyTraceWriteQueueIdle()
  }
}

function writeTraceFile(trace: AgentTrace): boolean {
  const estimatedBytes = TRACE_COLLECTION_MAX_BYTES
  const queuedItems = traceWriteQueue.length + (traceWriteQueueRunning ? 1 : 0)
  if (
    queuedItems >= TRACE_WRITE_QUEUE_MAX_ITEMS ||
    traceWriteQueueBytes + estimatedBytes > TRACE_WRITE_QUEUE_MAX_BYTES
  ) {
    droppedTraceWrites += 1
    return false
  }
  traceWriteQueue.push({ trace, estimatedBytes })
  traceWriteQueueBytes += estimatedBytes
  void drainTraceWriteQueue()
  return true
}

export function getTraceWriteQueueDiagnostics(): {
  queuedItems: number
  queuedBytes: number
  droppedItems: number
  maxItems: number
  maxBytes: number
} {
  return {
    queuedItems: traceWriteQueue.length + (traceWriteQueueRunning ? 1 : 0),
    queuedBytes: traceWriteQueueBytes,
    droppedItems: droppedTraceWrites,
    maxItems: TRACE_WRITE_QUEUE_MAX_ITEMS,
    maxBytes: TRACE_WRITE_QUEUE_MAX_BYTES
  }
}

export async function flushTraceWriteQueue(): Promise<void> {
  if (!traceWriteQueueRunning && traceWriteQueue.length === 0) return
  await new Promise<void>((resolve) => traceWriteQueueWaiters.push(resolve))
}

export function parseStoredTraceLine(line: string): AgentTrace {
  const plaintext = traceLocalStorage().decodeStoredLine(line)
  return normalizeTrace(JSON.parse(plaintext) as AgentTrace)
}

/** Initialize encrypted trace storage and migrate legacy plaintext JSONL files. */
export function initializeTraceStorageSecurity(): Promise<TraceStorageInitializationResult> {
  return traceLocalStorage().initialize()
}

/** Delete the oldest trace files in a thread directory, keeping at most MAX_TRACES_PER_THREAD. */
async function pruneOldTraces(threadId: string): Promise<void> {
  try {
    const dir = getThreadTracesDir(threadId)
    const files: Array<{ name: string; filePath: string; mtimeMs: number }> = []
    let directory
    try {
      directory = await opendir(dir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return
      throw error
    }
    let scanned = 0
    for await (const entry of directory) {
      scanned += 1
      if (scanned > TRACE_PRUNE_MAX_ENTRIES) break
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue
      const filePath = join(dir, entry.name)
      try {
        files.push({ name: entry.name, filePath, mtimeMs: (await lstat(filePath)).mtimeMs })
      } catch {
        // File disappeared between directory enumeration and stat.
      }
      if (scanned % TRACE_IO_YIELD_INTERVAL === 0) await yieldTraceIo()
    }

    if (files.length <= MAX_TRACES_PER_THREAD) return

    // Sort newest first, delete the tail.
    files.sort((a, b) => b.mtimeMs - a.mtimeMs)
    const toDelete = files.slice(MAX_TRACES_PER_THREAD)

    for (const entry of toDelete) {
      try {
        await traceLocalStorage().runFileOperation(entry.filePath, async () => {
          await unlink(entry.filePath)
        })
      } catch (e) {
        console.warn(`[Tracer] Failed to prune trace ${entry.name}:`, e)
      }
    }
  } catch (e) {
    console.warn("[Tracer] Failed to prune old traces:", e)
  }
}

function normalizeTrace(parsed: AgentTrace): AgentTrace {
  return {
    ...parsed,
    observabilitySchemaVersion:
      parsed.observabilitySchemaVersion ?? TRACE_OBSERVABILITY_SCHEMA_VERSION,
    traceKind: parsed.traceKind ?? "root",
    executionMode: parsed.executionMode ?? "normal",
    rootTraceId: parsed.rootTraceId ?? parsed.traceId,
    rootThreadId: parsed.rootThreadId ?? parsed.threadId,
    usedSkills: Array.isArray(parsed.usedSkills) ? parsed.usedSkills : [],
    evolvedSkills: Array.isArray(parsed.evolvedSkills) ? parsed.evolvedSkills : [],
    triggerSource: parsed.triggerSource ?? "chat"
  }
}

function getAppVersionForTrace(): string {
  try {
    return typeof app?.getVersion === "function" ? app.getVersion() : "unknown"
  } catch {
    return "unknown"
  }
}

function getSkillAuthor(skill: {
  metadata?: Record<string, string>
  pluginName?: string
}): string | undefined {
  const metadataAuthor = skill.metadata?.author || skill.metadata?.owner
  if (metadataAuthor) return metadataAuthor
  return skill.pluginName
}

function buildSkillAuthorByRawName(
  rawSkillNames: string[],
  skills: Array<{
    name: string
    version: string
    metadata?: Record<string, string>
    pluginName?: string
  }>
): Record<string, string | undefined> {
  const byName = new Map(skills.map((skill) => [skill.name, skill]))
  const byVersionedName = new Map(
    skills.map((skill) => [ensureVersionedSkillIdentifier(skill.name, skill.version), skill])
  )
  const result: Record<string, string | undefined> = {}

  for (const rawSkillName of rawSkillNames) {
    const parsed = parseSkillIdentifier(rawSkillName)
    const skill = byVersionedName.get(rawSkillName) ?? byName.get(parsed.name)
    const author = skill ? getSkillAuthor(skill) : undefined
    if (author) result[rawSkillName] = author
  }

  return result
}

// ─────────────────────────────────────────────────────────
// TraceCollector class
// ─────────────────────────────────────────────────────────

export interface TraceCollectorOptions extends Partial<TraceObservabilityContext> {
  traceId?: string
  triggerSource?: TraceTriggerSource
  harnessFeature?: TraceHarnessFeatureContext
  includeSkillEval?: boolean
}

function compactUndefined<T extends Record<string, unknown>>(record: T): T {
  for (const key of Object.keys(record)) {
    if (record[key] === undefined) delete record[key]
  }
  return record
}

function buildObservabilityContext(
  traceId: string,
  threadId: string,
  options: TraceCollectorOptions
): TraceObservabilityContext {
  const traceKind: TraceKind = options.traceKind ?? "root"
  const executionMode: TraceExecutionMode = options.executionMode ?? "normal"
  const rootTraceId = options.rootTraceId ?? traceId
  const rootThreadId = options.rootThreadId ?? threadId
  const subagentThreadId =
    options.subagentThreadId ?? (traceKind === "subagent" ? threadId : undefined)
  return compactUndefined({
    observabilitySchemaVersion: TRACE_OBSERVABILITY_SCHEMA_VERSION,
    traceKind,
    executionMode,
    rootTraceId,
    rootThreadId,
    parentTraceId: options.parentTraceId,
    parentThreadId: options.parentThreadId,
    parentSpanId: options.parentSpanId,
    linkType: options.linkType,
    subagentKind: options.subagentKind,
    subagentRunId: options.subagentRunId,
    subagentThreadId,
    handoffAction: options.handoffAction,
    handoffSourceAgent: options.handoffSourceAgent,
    handoffTargetAgent: options.handoffTargetAgent,
    coordinatorWorkerId: options.coordinatorWorkerId,
    coordinatorWorkerTurn: options.coordinatorWorkerTurn,
    coordinatorWorkerRole: options.coordinatorWorkerRole,
    coordinatorWorkerWorkload: options.coordinatorWorkerWorkload,
    workflowRunId: options.workflowRunId,
    workflowAgentIndex: options.workflowAgentIndex,
    workflowPhase: options.workflowPhase,
    workflowAgentLabel: options.workflowAgentLabel
  }) as TraceObservabilityContext
}

const TRACE_MAX_STEPS = 128
const TRACE_MAX_TOOL_CALLS = 512
const TRACE_MAX_TOOL_CALLS_PER_STEP = 64
const TRACE_MAX_MODEL_CALLS = 64
const TRACE_MAX_MODEL_MESSAGES = 64
const TRACE_MAX_NODES = 512
const TRACE_MAX_SKILLS = 128

function boundTraceToolCall(call: TraceToolCall, budget: TraceCollectionBudget): TraceToolCall {
  // Take the name first: args can drain the budget, and a nameless (or
  // placeholder-named) tool call corrupts per-tool analytics.
  const name = budget.takeText(String(call.name ?? "unknown"), 512)
  const args = budget.takeValue(call.args, 32 * 1024)
  return {
    name: name || "unknown",
    args:
      args && typeof args === "object" && !Array.isArray(args)
        ? (args as Record<string, unknown>)
        : {},
    ...(typeof call.result === "string" ? { result: budget.takeText(call.result, 16 * 1024) } : {}),
    ...(typeof call.durationMs === "number" && Number.isFinite(call.durationMs)
      ? { durationMs: Math.max(0, Math.min(call.durationMs, 24 * 60 * 60 * 1000)) }
      : {})
  }
}

/**
 * Content-addressed id for one chat message. Two messages with the same role,
 * text and tool linkage are the same message as far as a trace reader is
 * concerned, so they collapse to one stored copy.
 */
function chatMessageId(message: TraceChatMessage): string {
  return createHash("sha1")
    .update(
      [
        message.role,
        message.content ?? "",
        message.reasoning ?? "",
        message.name ?? "",
        message.toolCallId ?? ""
      ].join("\u0000")
    )
    .digest("hex")
    .slice(0, 16)
}

/** True for the LLM input windows recorded by beginLlmNode / recordModelCall. */
function isChatMessageArray(value: unknown): value is TraceChatMessage[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        item !== null &&
        typeof item === "object" &&
        typeof (item as TraceChatMessage).role === "string"
    )
  )
}

const COUNTABLE_NODE_METADATA_KEYS = [
  "toolCallId",
  "messageId",
  "toolCallCount",
  "toolNames",
  "index"
] as const

function pickCountableMetadata(
  metadata: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!metadata) return undefined
  const picked: Record<string, unknown> = {}
  for (const key of COUNTABLE_NODE_METADATA_KEYS) {
    if (metadata[key] !== undefined) picked[key] = metadata[key]
  }
  return Object.keys(picked).length > 0 ? picked : undefined
}

function boundTraceChatMessage(
  message: TraceChatMessage,
  budget: TraceCollectionBudget
): TraceChatMessage {
  const allowedRoles = new Set(["system", "user", "assistant", "tool", "unknown"])
  const role = allowedRoles.has(message.role) ? message.role : "unknown"
  return {
    role,
    ...(typeof message.mid === "string" ? { mid: message.mid } : {}),
    ...(typeof message.ref === "string" ? { ref: message.ref } : {}),
    content: budget.takeText(String(message.content ?? ""), 16 * 1024),
    ...(typeof message.reasoning === "string"
      ? { reasoning: budget.takeText(message.reasoning, 8 * 1024) }
      : {}),
    ...(typeof message.name === "string" ? { name: budget.takeText(message.name, 512) } : {}),
    ...(typeof message.toolCallId === "string"
      ? { toolCallId: budget.takeText(message.toolCallId, 512) }
      : {})
  }
}

/**
 * Skill name lists are top-level analytic dimensions, not tool/model payloads:
 * they stay out of the collection budget so a heavy conversation cannot blank
 * or truncate the very skill names the dashboard groups on. The item cap still
 * bounds the field.
 */
function boundStringList(values: readonly string[], maxItems = TRACE_MAX_SKILLS): string[] {
  return values.slice(0, maxItems).map((value) => clampText(String(value), 1024))
}

function boundSkillEvalExtension(
  skillEval: TraceSkillEvalExtension | undefined,
  budget: TraceCollectionBudget
): TraceSkillEvalExtension | undefined {
  if (!skillEval || !budget.canAdd(16 * 1024)) return undefined
  const boundList = (values: readonly string[], maxItems = 64): string[] =>
    values.slice(0, maxItems).map((value) => budget.takeText(String(value), 2048))
  const boundChecks = (
    checks: TraceSkillEvalExtension["records"][number]["checks"]
  ): TraceSkillEvalExtension["records"][number]["checks"] =>
    checks.slice(0, 64).map((check) => {
      const detail = budget.takeValue(check.detail, 4 * 1024)
      return {
        ...check,
        name: budget.takeText(check.name, 512),
        label: budget.takeText(check.label, 1024),
        ...(detail && typeof detail === "object" && !Array.isArray(detail)
          ? { detail: detail as Record<string, unknown> }
          : {})
      }
    })

  return {
    schemaVersion: budget.takeText(skillEval.schemaVersion, 128),
    evalRulesVersion: budget.takeText(skillEval.evalRulesVersion, 128),
    evaluatedAt: budget.takeText(skillEval.evaluatedAt, 64),
    records: skillEval.records.slice(0, 8).map((record) => {
      const bounded = { ...record }
      const mutableBounded = bounded as unknown as Record<string, unknown>
      for (const [key, value] of Object.entries(bounded)) {
        if (typeof value === "string") {
          mutableBounded[key] = budget.takeText(value, 4096)
        }
      }
      return {
        ...bounded,
        contextTraceIds: boundList(record.contextTraceIds, 20),
        skillEvalTraceIds: boundList(record.skillEvalTraceIds, 20),
        failedProcessChecks: boundList(record.failedProcessChecks),
        failedOutcomeChecks: boundList(record.failedOutcomeChecks),
        failedResultChecks: boundList(record.failedResultChecks),
        warningTags: record.warningTags.slice(0, 64),
        checks: boundChecks(record.checks),
        outcomeChecks: boundChecks(record.outcomeChecks),
        resultChecks: boundChecks(record.resultChecks),
        warnings: boundList(record.warnings),
        outcomeWarnings: boundList(record.outcomeWarnings),
        resultWarnings: boundList(record.resultWarnings),
        resultIssues: boundList(record.resultIssues),
        artifacts: record.artifacts.slice(0, 64).map((artifact) => ({
          ...artifact,
          label: budget.takeText(artifact.label, 2048)
        }))
      }
    })
  }
}

export class TraceCollector {
  private readonly collectionBudget = new TraceCollectionBudget()
  private readonly traceId: string
  private readonly threadId: string
  private readonly startedAt: string
  private readonly userMessage: string
  private readonly suspectedTechnicalDetailSupplement: boolean
  private modelId: string
  private modelName: string | undefined
  private routingTrace: RoutingTrace | undefined
  private readonly triggerSource: TraceTriggerSource
  private readonly harnessFeature: TraceHarnessFeatureContext | undefined
  private readonly harnessAdapterPromise: ReturnType<typeof getHarnessProjectAdapterSnapshot>
  private observability: TraceObservabilityContext
  private readonly includeSkillEval: boolean

  private steps: TraceStep[] = []
  private usedSkills: string[] = []
  private skillSource: string[] = []
  private evolvedSkills: string[] = []
  private modelCalls: TraceModelCall[] = []
  private nodes: TraceNode[] = []
  private nodeIndexById = new Map<string, number>()
  private llmNodeByMessageId = new Map<string, string>()
  private toolNodeByCallId = new Map<string, string>()
  private readonly rootNodeId: string
  private terminalNodeAdded = false
  private finishPromise: Promise<AgentTrace> | undefined

  /**
   * Ids of chat messages whose content is already stored somewhere in this
   * trace. Shared by beginLlmNode and recordModelCall, so the second recording
   * of the same window collapses to refs.
   */
  private readonly storedChatMessageIds = new Set<string>()

  /**
   * Assigns the canonical copy of every repeated value in this trace. Recorders
   * run steps-first, so the literal lands on the flattest structure and the
   * later copies keep only an id.
   */
  private readonly contentInterner = new TraceContentInterner()

  /** The step currently being built (between beginStep / endStep). */
  private currentStepIndex = 0
  private currentStepStartedAt: string = nowIsoLocal()
  private currentToolCalls: TraceToolCall[] = []
  private recordedToolCallCount = 0

  /**
   * Counted as work arrives, independent of every array. The arrays stop at
   * their TRACE_MAX_* caps; the turn does not, and these totals are what the
   * operations dashboard aggregates.
   */
  private observedToolCallCount = 0
  private observedModelCallCount = 0
  private observedInputTokens = 0
  private observedOutputTokens = 0
  private observedTotalTokens = 0

  constructor(
    threadId: string,
    userMessage: string,
    modelId: string,
    options: TraceCollectorOptions = {}
  ) {
    this.traceId = clampText(options.traceId ?? uuid(), 256)
    this.threadId = clampText(threadId, 256)
    this.suspectedTechnicalDetailSupplement = hasSuspectedTechnicalDetailSupplement(userMessage)
    this.userMessage = clampText(userMessage, 64 * 1024)
    this.modelId = clampText(modelId, 1024)
    this.triggerSource = options.triggerSource ?? "chat"
    this.harnessFeature = options.harnessFeature
      ? {
          projectId: clampText(options.harnessFeature.projectId, 1024),
          slug: clampText(options.harnessFeature.slug, 1024),
          ...(options.harnessFeature.nodeName
            ? { nodeName: clampText(options.harnessFeature.nodeName, 1024) }
            : {}),
          ...(options.harnessFeature.nodeStatus
            ? { nodeStatus: clampText(options.harnessFeature.nodeStatus, 256) }
            : {})
        }
      : undefined
    this.harnessAdapterPromise = this.harnessFeature
      ? getHarnessProjectAdapterSnapshot(this.harnessFeature.projectId).catch(() => null)
      : Promise.resolve(null)
    this.observability = buildObservabilityContext(this.traceId, this.threadId, options)
    this.includeSkillEval = options.includeSkillEval ?? this.observability.traceKind === "root"
    this.startedAt = nowIsoLocal()
    this.rootNodeId = `trace:${this.traceId}`
    this.pushNode({
      id: this.rootNodeId,
      type: "trace",
      parentId: null,
      name: "Agent Trace",
      status: "running",
      startedAt: this.startedAt,
      input: { userMessage: this.userMessage },
      metadata: {
        ...this.observability,
        traceId: this.traceId,
        threadId: this.threadId,
        modelId: this.modelId,
        triggerSource: this.triggerSource
      }
    })
    // Publish context to adoption tracker (side-effect only). Project-mode
    // conversations also carry their harness project / adapter so emitted
    // code_gen/code_adopt events can be sliced by project / plugin directly.
    try {
      // setAdoptionContext intentionally merges incremental updates. A new
      // trace is a new ownership epoch, though, so reset the prior turn first;
      // otherwise a background-finishing child could leave stale Skill/model/
      // project fields for a fast continuation on the same thread.
      clearAdoptionContext(this.threadId)
      setAdoptionContext(this.threadId, {
        traceId: this.traceId,
        modelId: this.modelId,
        ...this.observability,
        ...(this.harnessFeature
          ? {
              harnessProjectId: this.harnessFeature.projectId,
              harnessFeatureSlug: this.harnessFeature.slug,
              harnessNodeName: this.harnessFeature.nodeName,
              harnessNodeStatus: this.harnessFeature.nodeStatus,
              harnessAdapterName: undefined,
              harnessAdapterVersion: undefined
            }
          : {})
      })
      if (this.harnessFeature) {
        void this.harnessAdapterPromise.then((adapter) => {
          if (!adapter) return
          patchAdoptionContextForTrace(this.threadId, this.traceId, {
            harnessAdapterName: String(adapter.name).slice(0, 1024),
            harnessAdapterVersion: String(adapter.version).slice(0, 1024)
          })
        })
      }
    } catch {
      // never block trace setup
    }
  }

  getTraceId(): string {
    return this.traceId
  }

  getTraceContext(): TraceContext {
    return {
      traceId: this.traceId,
      threadId: this.threadId,
      rootNodeId: this.rootNodeId,
      ...this.observability,
      ...(this.harnessFeature ? { harnessFeature: { ...this.harnessFeature } } : {})
    }
  }

  setObservabilityContext(patch: Partial<TraceObservabilityContext>): void {
    // Observability is trace linkage (root/parent/subagent/workflow ids), all
    // first-party and short. It must not be budgeted: a drained budget makes
    // takeValue return the placeholder *string*, which then spreads into this
    // object character by character and corrupts both the trace tree and the
    // adoption context.
    this.observability = compactUndefined({
      ...this.observability,
      ...patch
    }) as TraceObservabilityContext
    const root = this.getNode(this.rootNodeId)
    if (root) {
      root.metadata = { ...(root.metadata ?? {}), ...this.observability }
    }
    try {
      setAdoptionContext(this.threadId, this.observability)
    } catch {
      // ignore
    }
  }

  setExecutionMode(mode: TraceExecutionMode): void {
    this.setObservabilityContext({ executionMode: mode })
  }

  /** Update the modelId (can be resolved after construction). */
  setModelId(id: string): void {
    this.modelId = clampText(id, 1024)
    const root = this.getNode(this.rootNodeId)
    if (root) {
      root.metadata = { ...(root.metadata ?? {}), modelId: this.modelId }
    }
    try {
      setAdoptionContext(this.threadId, { modelId: this.modelId })
    } catch {
      // ignore
    }
  }

  /** Set the human-readable model name (e.g. "minmax") for display in trace UI. */
  setModelName(name: string): void {
    this.modelName = clampText(name, 1024)
    const root = this.getNode(this.rootNodeId)
    if (root) {
      root.metadata = { ...(root.metadata ?? {}), modelName: this.modelName }
    }
    try {
      setAdoptionContext(this.threadId, { modelName: this.modelName })
    } catch {
      // ignore
    }
  }

  /**
   * Attach the routing funnel record to this trace.
   * Side-effect only — never throws.
   */
  setRoutingTrace(rt: RoutingTrace): void {
    try {
      this.routingTrace = this.collectionBudget.takeValue(rt, 64 * 1024) as RoutingTrace
      const root = this.getNode(this.rootNodeId)
      if (root) {
        root.metadata = { ...(root.metadata ?? {}), routingTrace: this.routingTrace }
      }
    } catch (e) {
      console.warn("[Tracer] setRoutingTrace failed:", e)
    }
  }

  /**
   * Set which skills were actually used for this run (feeds the trace document's
   * own `usedSkills`).
   *
   * NOTE: this intentionally does NOT write the adoption context's usedSkills.
   * Code-gen skill attribution is sticky across the thread and is owned solely
   * by the caller (ipc/agent.ts `syncUsedSkillsContext`), which writes the
   * adoption context with the thread's active skill set right after this call.
   * Writing current-run skills here would only be a value the caller overwrites,
   * and risks bypassing the sticky attribution if ever called on its own.
   */
  setUsedSkills(skills: string[]): void {
    this.usedSkills = boundStringList(skills)
    const root = this.getNode(this.rootNodeId)
    if (root) {
      root.metadata = { ...(root.metadata ?? {}), usedSkills: [...this.usedSkills] }
    }
  }

  /** Set source markers keyed by the same skill identifier used in usedSkills. */
  setSkillSource(skillSource: string[]): void {
    this.skillSource = normalizeSkillSourceRefs(boundStringList(skillSource))
    const root = this.getNode(this.rootNodeId)
    if (root) {
      const metadata = { ...(root.metadata ?? {}) }
      const normalized = normalizeSkillSourceRefs(this.skillSource)
      if (normalized.length > 0) metadata.skillSource = normalized
      else delete metadata.skillSource
      root.metadata = metadata
    }
  }

  /** Set which used skills came from cloud trace evolution. */
  setEvolvedSkills(skills: string[]): void {
    this.evolvedSkills = boundStringList(skills)
    const root = this.getNode(this.rootNodeId)
    if (root) {
      root.metadata = { ...(root.metadata ?? {}), evolvedSkills: [...this.evolvedSkills] }
    }
  }

  /** Return the root trace node id. */
  getRootNodeId(): string {
    return this.rootNodeId
  }

  /**
   * Called when the model starts producing a new message
   * (i.e. before tool calls for that step are known).
   */
  beginStep(): void {
    this.currentStepStartedAt = nowIsoLocal()
    this.currentToolCalls = []
  }

  /** Record a tool call within the current step. */
  recordToolCall(call: TraceToolCall): void {
    this.observedToolCallCount += 1
    // The count caps are hard: past them the array itself must stop growing.
    if (
      this.recordedToolCallCount >= TRACE_MAX_TOOL_CALLS ||
      this.currentToolCalls.length >= TRACE_MAX_TOOL_CALLS_PER_STEP
    ) {
      return
    }
    // A spent byte budget is not a reason to forget the call happened. Keep the
    // name and drop the payload: totalToolCalls is counted off this array and
    // tool names are a queried dimension, so dropping the entry would understate
    // exactly the longest turns.
    if (!this.collectionBudget.canAdd(256)) {
      this.currentToolCalls.push({
        name: clampText(String(call.name ?? "unknown"), 128),
        args: {},
        ...(typeof call.durationMs === "number" && Number.isFinite(call.durationMs)
          ? { durationMs: Math.max(0, Math.min(call.durationMs, 24 * 60 * 60 * 1000)) }
          : {}),
        truncated: true
      })
      this.recordedToolCallCount += 1
      return
    }
    this.currentToolCalls.push(
      this.internToolCallArgs(boundTraceToolCall(call, this.collectionBudget))
    )
    this.recordedToolCallCount += 1
  }

  private getTotalToolCalls(): number {
    const stepToolCalls = this.steps.reduce((sum, step) => sum + step.toolCalls.length, 0)
    const nodeToolCalls = this.nodes.filter((node) => node.type === "tool").length
    const metadataToolCalls = this.nodes.reduce((sum, node) => {
      const toolNames = node.metadata?.toolNames
      if (!Array.isArray(toolNames)) return sum
      return (
        sum + toolNames.filter((name) => typeof name === "string" && name.trim().length > 0).length
      )
    }, 0)
    const metadataToolCallCounts = this.nodes.reduce((sum, node) => {
      const count = node.metadata?.toolCallCount
      if (typeof count !== "number" || !Number.isFinite(count) || count <= 0) return sum
      return sum + Math.floor(count)
    }, 0)
    return Math.max(
      this.observedToolCallCount,
      stepToolCalls,
      nodeToolCalls,
      metadataToolCalls,
      metadataToolCallCounts
    )
  }

  /**
   * Claim a value for whichever recorder got there first. The winner keeps the
   * bytes and stamps the id; everyone after it keeps only the id. Values too
   * small to pay for a ref are left alone.
   */
  private internValue(value: unknown): { mid: string } | { ref: string } | undefined {
    return this.contentInterner.claim(value)
  }

  /** Tool args: canonical on the step, ids on the model call and the tool node. */
  private internToolCallArgs(call: TraceToolCall): TraceToolCall {
    const claim = this.internValue(call.args)
    if (!claim) return call
    return "mid" in claim
      ? { ...call, argsMid: claim.mid }
      : { ...call, args: {}, argsRef: claim.ref }
  }

  /**
   * The output message repeats the step's assistant text and, once the llm node
   * copies it, the reasoning too. Keep whichever copy arrived first.
   */
  private internMessageText(message: TraceChatMessage): TraceChatMessage {
    let output = message
    const contentClaim = this.internValue(output.content)
    if (contentClaim) {
      output =
        "mid" in contentClaim
          ? { ...output, contentMid: contentClaim.mid }
          : { ...output, content: "", contentRef: contentClaim.ref }
    }
    if (typeof output.reasoning === "string") {
      const reasoningClaim = this.internValue(output.reasoning)
      if (reasoningClaim) {
        if ("mid" in reasoningClaim) {
          output = { ...output, reasoningMid: reasoningClaim.mid }
        } else {
          const rest = { ...output }
          delete rest.reasoning
          output = { ...rest, reasoningRef: reasoningClaim.ref }
        }
      }
    }
    return output
  }

  /**
   * Node input/output/metadata values, which are untyped and often duplicates.
   * Returns the id to store in a sibling `*Ref` field when the value is a
   * repeat, or undefined when this copy is the one keeping the bytes.
   */
  private internNodeValue(value: unknown): string | undefined {
    const claim = this.internValue(value)
    if (!claim || "mid" in claim) return undefined
    return claim.ref
  }

  /**
   * Replace every message already stored in this trace with a ref to the stored
   * copy. The window slides one call at a time and each call records it twice,
   * so without this the same text lands in the trace roughly nine times and
   * crowds out everything recorded later.
   */
  private dedupeChatMessages(messages: readonly TraceChatMessage[]): TraceChatMessage[] {
    return messages.map((message) => {
      const mid = chatMessageId(message)
      if (this.storedChatMessageIds.has(mid)) {
        return { role: message.role, content: "", ref: mid }
      }
      this.storedChatMessageIds.add(mid)
      return { ...message, mid }
    })
  }

  /** Record one LLM run (input context + output message). */
  recordModelCall(call: TraceModelCall): void {
    this.observedModelCallCount += 1
    const usage = call.tokenUsage
    if (usage) {
      const input = usage.inputTokens ?? 0
      const output = usage.outputTokens ?? 0
      this.observedInputTokens += input
      this.observedOutputTokens += output
      this.observedTotalTokens += usage.totalTokens ?? input + output
    }
    if (this.modelCalls.length >= TRACE_MAX_MODEL_CALLS) return
    // Token totals are summed off this array by the dashboard, so a spent
    // budget must cost the messages, not the entry: keep timing and usage.
    if (!this.collectionBudget.canAdd(512)) {
      this.modelCalls.push({
        ...(typeof call.messageId === "string"
          ? { messageId: clampText(call.messageId, 128) }
          : {}),
        startedAt: clampText(call.startedAt, 64),
        inputMessages: [],
        outputMessage: { role: "assistant", content: "" },
        toolCalls: [],
        ...(call.tokenUsage ? { tokenUsage: call.tokenUsage } : {}),
        truncated: true
      })
      return
    }
    const inputMessages = this.dedupeChatMessages(
      call.inputMessages.slice(0, TRACE_MAX_MODEL_MESSAGES)
    ).map((message) => boundTraceChatMessage(message, this.collectionBudget))
    const toolCalls = call.toolCalls
      .slice(0, TRACE_MAX_TOOL_CALLS_PER_STEP)
      .map((toolCall) =>
        this.internToolCallArgs(boundTraceToolCall(toolCall, this.collectionBudget))
      )
    const tokenUsage = this.collectionBudget.takeValue(call.tokenUsage, 1024)
    this.modelCalls.push({
      ...(typeof call.messageId === "string" ? { messageId: clampText(call.messageId, 512) } : {}),
      startedAt: clampText(call.startedAt, 64),
      inputMessages,
      outputMessage: this.internMessageText(
        boundTraceChatMessage(call.outputMessage, this.collectionBudget)
      ),
      toolCalls,
      ...(tokenUsage && typeof tokenUsage === "object"
        ? { tokenUsage: tokenUsage as TraceModelCall["tokenUsage"] }
        : {})
    })
  }

  beginLlmNode(params?: {
    messageId?: string
    startedAt?: string
    input?: unknown
    name?: string
    metadata?: Record<string, unknown>
  }): string {
    const messageId = params?.messageId
    if (messageId) {
      const existing = this.llmNodeByMessageId.get(messageId)
      if (existing) return existing
    }

    const id = `llm:${uuid()}`
    const rawMetadata = this.collectionBudget.takeValue(params?.metadata, 32 * 1024)
    const metadata =
      rawMetadata && typeof rawMetadata === "object" && !Array.isArray(rawMetadata)
        ? (rawMetadata as Record<string, unknown>)
        : {}
    const stored = this.pushNode({
      id,
      type: "llm",
      parentId: this.rootNodeId,
      name: params?.name ?? "LLM Call",
      status: "running",
      startedAt: params?.startedAt ?? nowIsoLocal(),
      input: isChatMessageArray(params?.input)
        ? this.dedupeChatMessages(params.input)
        : params?.input,
      metadata: {
        ...metadata,
        ...(messageId ? { messageId } : {})
      }
    })
    if (messageId && stored) this.llmNodeByMessageId.set(messageId, id)
    return id
  }

  addToolNode(params: {
    name: string
    input?: unknown
    parentId?: string
    llmMessageId?: string
    toolCallId?: string
    startedAt?: string
    metadata?: Record<string, unknown>
  }): string {
    if (params.toolCallId) {
      const existing = this.toolNodeByCallId.get(params.toolCallId)
      if (existing) return existing
    }

    const byMessage = params.llmMessageId
      ? this.llmNodeByMessageId.get(params.llmMessageId)
      : undefined
    const parentId = params.parentId ?? byMessage ?? this.rootNodeId
    const id = `tool:${uuid()}`
    const rawMetadata = this.collectionBudget.takeValue(params.metadata, 32 * 1024)
    const metadata =
      rawMetadata && typeof rawMetadata === "object" && !Array.isArray(rawMetadata)
        ? (rawMetadata as Record<string, unknown>)
        : {}

    const stored = this.pushNode({
      id,
      type: "tool",
      parentId,
      name: params.name,
      status: "running",
      startedAt: params.startedAt ?? nowIsoLocal(),
      input: params.input,
      metadata: {
        ...metadata,
        ...(params.toolCallId ? { toolCallId: params.toolCallId } : {})
      }
    })

    if (params.toolCallId && stored) this.toolNodeByCallId.set(params.toolCallId, id)
    return id
  }

  addToolResultNode(params: {
    output?: unknown
    parentId?: string
    toolCallId?: string
    startedAt?: string
    status?: TraceNodeStatus
    metadata?: Record<string, unknown>
  }): string {
    const parentId =
      params.parentId ??
      (params.toolCallId ? this.toolNodeByCallId.get(params.toolCallId) : undefined) ??
      this.rootNodeId
    const id = `tool_result:${uuid()}`
    const now = params.startedAt ?? nowIsoLocal()

    this.pushNode({
      id,
      type: "tool_result",
      parentId,
      name: "Tool Result",
      status: params.status ?? "success",
      startedAt: now,
      endedAt: now,
      output: params.output,
      metadata: params.metadata
    })

    if (parentId !== this.rootNodeId) {
      this.endNode(parentId, params.status ?? "success")
    }
    return id
  }

  endLlmNode(params: {
    nodeId?: string
    messageId?: string
    status?: TraceNodeStatus
    endedAt?: string
    output?: unknown
    metadata?: Record<string, unknown>
  }): void {
    const targetId =
      params.nodeId ??
      (params.messageId ? this.llmNodeByMessageId.get(params.messageId) : undefined)
    if (!targetId) return
    const node = this.getNode(targetId)
    if (!node) return

    node.status = params.status ?? "success"
    node.endedAt = params.endedAt ?? nowIsoLocal()
    if (params.output !== undefined) {
      const bounded = this.collectionBudget.takeValue(params.output, 32 * 1024)
      const ref = this.internNodeValue(bounded)
      if (ref) {
        node.output = undefined
        node.outputRef = ref
      } else {
        node.output = bounded
      }
    }
    if (params.metadata) {
      const metadata = this.collectionBudget.takeValue(params.metadata, 32 * 1024)
      if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
        const interned: Record<string, unknown> = {}
        for (const [key, value] of Object.entries(metadata as Record<string, unknown>)) {
          const ref = this.internNodeValue(value)
          if (ref) interned[`${key}Ref`] = ref
          else interned[key] = value
        }
        node.metadata = { ...(node.metadata ?? {}), ...interned }
      }
    }
  }

  addTerminalNode(params: {
    type: "message" | "error" | "cancel"
    name?: string
    status?: TraceNodeStatus
    output?: unknown
    metadata?: Record<string, unknown>
    startedAt?: string
    endedAt?: string
  }): string {
    this.terminalNodeAdded = true
    const id = `${params.type}:${uuid()}`
    this.pushNode({
      id,
      type: params.type,
      parentId: this.rootNodeId,
      name:
        params.name ??
        (params.type === "error"
          ? "Run Error"
          : params.type === "cancel"
            ? "Run Cancelled"
            : "Run Completed"),
      status:
        params.status ??
        (params.type === "error" ? "error" : params.type === "cancel" ? "cancelled" : "success"),
      startedAt: params.startedAt ?? nowIsoLocal(),
      endedAt: params.endedAt ?? nowIsoLocal(),
      output: params.output,
      metadata: params.metadata
    })
    return id
  }

  /**
   * Called after the model message + its tool calls are complete.
   * @param assistantText - The assistant's text reasoning for this step.
   */
  endStep(assistantText: string): void {
    if (this.steps.length >= TRACE_MAX_STEPS) {
      this.currentToolCalls = []
      return
    }
    // Keep the step (and the tool calls already attached to it) even with no
    // budget left for its text — the step count and its tool calls are what
    // totalToolCalls is derived from.
    if (!this.collectionBudget.canAdd(128)) {
      this.steps.push({
        index: this.currentStepIndex++,
        startedAt: this.currentStepStartedAt,
        assistantText: "",
        toolCalls: [...this.currentToolCalls],
        truncated: true
      })
      this.currentToolCalls = []
      return
    }
    const boundedText = this.collectionBudget.takeText(assistantText, 32 * 1024)
    const textClaim = this.internValue(boundedText)
    const step: TraceStep = {
      index: this.currentStepIndex++,
      startedAt: this.currentStepStartedAt,
      // Steps are canonical for assistant text, so this is always the literal.
      assistantText: boundedText,
      ...(textClaim && "mid" in textClaim ? { assistantTextMid: textClaim.mid } : {}),
      toolCalls: [...this.currentToolCalls]
    }
    this.steps.push(step)
    this.currentToolCalls = []
  }

  /**
   * Finalize the trace, write to disk, and (optionally) report remotely.
   * Safe to call multiple times — only the first call takes effect.
   */
  finish(outcome: TraceOutcome, errorMessage?: string): Promise<AgentTrace> {
    // Finishing touches several non-idempotent side channels (skill-eval
    // windows, local persistence, cloud reporting, and adoption cleanup). Keep
    // the documented first-call-wins contract even when two teardown paths race.
    this.finishPromise ??= this.finishOnce(outcome, errorMessage)
    return this.finishPromise
  }

  private async finishOnce(outcome: TraceOutcome, errorMessage?: string): Promise<AgentTrace> {
    const endedAt = nowIsoLocal()
    const durationMs = Date.now() - new Date(this.startedAt).getTime()
    const totalToolCalls = this.getTotalToolCalls()

    // Resolve skill versions and merge into "name-version" format
    let skillAuthorByRawName: Record<string, string | undefined> = {}
    const resolveSkillVersions = async (
      skills: string[],
      collectAuthors = false
    ): Promise<string[]> => {
      if (skills.length === 0) return []
      try {
        const allSkills = await listAllSkills()
        const skillVersionMap = new Map(allSkills.map((s) => [s.name, s.version]))
        const resolved = Array.from(
          new Set(
            skills
              .map((skill) => {
                const parsed = parseSkillIdentifier(skill)
                const listedVersion = skillVersionMap.get(parsed.name)
                const resolvedVersion =
                  parsed.version && parsed.version !== DEFAULT_SKILL_VERSION
                    ? parsed.version
                    : (listedVersion ?? parsed.version)
                return ensureVersionedSkillIdentifier(parsed.name, resolvedVersion)
              })
              .filter(Boolean)
          )
        )
        if (collectAuthors) {
          skillAuthorByRawName = buildSkillAuthorByRawName(resolved, allSkills)
        }
        return boundStringList(resolved)
      } catch (e) {
        console.warn("[Tracer] Failed to resolve skill versions:", e)
        return boundStringList(
          Array.from(
            new Set(skills.map((skill) => ensureVersionedSkillIdentifier(skill)).filter(Boolean))
          )
        )
      }
    }

    const usedSkillsWithVersions = await resolveSkillVersions(this.usedSkills, true)
    const parsedSkillSource = this.skillSource
      .map(parsePluginSkillSourceRef)
      .filter((ref): ref is PluginSkillSourceRef => Boolean(ref))
    const skillSourceSkillsWithVersions = await resolveSkillVersions(
      parsedSkillSource.map((ref) => ref.skill)
    )
    const usedSkillSet = new Set(usedSkillsWithVersions)
    const skillSource = normalizeSkillSourceRefs(
      parsedSkillSource.map((ref, index) =>
        makePluginSkillSourceRef(
          ref.pluginId,
          skillSourceSkillsWithVersions[index] ?? ref.skill,
          ref.pluginName
        )
      ),
      usedSkillsWithVersions
    ).filter((ref) => {
      const parsed = parsePluginSkillSourceRef(ref)
      return Boolean(parsed && usedSkillSet.has(parsed.skill))
    })
    const evolvedSkillsWithVersions = await resolveSkillVersions(this.evolvedSkills)

    const userInfo = getUserInfo()
    const boundedPathName = userInfo?.pathName ? clampText(userInfo.pathName, 4096) : undefined
    const upperOrgLevels = deriveUpperOrgLevelsFromPath(boundedPathName)

    // Project-mode traces also record the bound adapter plugin's version, so
    // operations analytics can attribute a project conversation to a plugin
    // version. Best-effort: any resolution failure leaves the fields absent.
    let harnessAdapterFields: {
      harnessAdapterId?: string
      harnessAdapterName?: string
      harnessAdapterVersion?: string
    } = {}
    if (this.harnessFeature) {
      try {
        const adapter = await this.harnessAdapterPromise
        if (adapter) {
          harnessAdapterFields = {
            harnessAdapterId: clampText(adapter.id, 1024),
            harnessAdapterName: clampText(adapter.name, 1024),
            harnessAdapterVersion: clampText(adapter.version, 1024)
          }
        }
      } catch (e) {
        console.warn("[Tracer] Failed to resolve harness adapter for trace:", e)
      }
    }

    const boundedErrorMessage = errorMessage ? clampText(errorMessage, 16 * 1024) : undefined
    const trace: AgentTrace = {
      traceId: this.traceId,
      threadId: this.threadId,
      ...this.observability,
      startedAt: this.startedAt,
      endedAt,
      durationMs,
      userMessage: this.userMessage,
      suspectedTechnicalDetailSupplement: this.suspectedTechnicalDetailSupplement,
      modelId: this.modelId,
      ...(this.modelName ? { modelName: this.modelName } : {}),
      // Identity and org fields come from getUserInfo(), not from tools or
      // models, so they are deliberately outside the collection budget: a
      // long conversation must never be able to rename its own author.
      userIp: clampText(getLocalIP(), 256),
      userName: userInfo?.userName ? clampText(userInfo.userName, 1024) : undefined,
      sapId: userInfo?.sapId ? clampText(userInfo.sapId, 256) : undefined,
      ystId: userInfo?.ystId ? clampText(userInfo.ystId, 256) : undefined,
      originOrgId: userInfo?.originOrgId ? clampText(userInfo.originOrgId, 1024) : undefined,
      orgName: userInfo?.orgName ? clampText(userInfo.orgName, 2048) : undefined,
      pathName: boundedPathName,
      pathId: userInfo?.originPathId ? clampText(userInfo.originPathId, 1024) : undefined,
      upperOrgLv0: upperOrgLevels.upperOrgLv0
        ? clampText(upperOrgLevels.upperOrgLv0, 1024)
        : undefined,
      upperOrgLv1: upperOrgLevels.upperOrgLv1
        ? clampText(upperOrgLevels.upperOrgLv1, 1024)
        : undefined,
      upperOrgLv2: upperOrgLevels.upperOrgLv2
        ? clampText(upperOrgLevels.upperOrgLv2, 1024)
        : undefined,
      upperOrgLv3: upperOrgLevels.upperOrgLv3
        ? clampText(upperOrgLevels.upperOrgLv3, 1024)
        : undefined,
      appVersion: getAppVersionForTrace(),
      steps: this.steps,
      modelCalls: this.modelCalls,
      // Flattened for dashboard aggregation — `sum` cannot reach into the
      // per-call array above.
      ...summarizeTraceCacheTokens(this.modelCalls),
      // Counted as the turn ran, so these stay right past TRACE_MAX_MODEL_CALLS.
      totalInputTokens: this.observedInputTokens,
      totalOutputTokens: this.observedOutputTokens,
      totalTokens: this.observedTotalTokens,
      totalModelCalls: this.observedModelCallCount,
      nodes: this.finalizeNodes(
        outcome,
        endedAt,
        usedSkillsWithVersions,
        skillSource,
        evolvedSkillsWithVersions,
        boundedErrorMessage
      ),
      totalToolCalls,
      outcome,
      ...(boundedErrorMessage ? { errorMessage: boundedErrorMessage } : {}),
      usedSkills: usedSkillsWithVersions,
      ...(skillSource.length > 0 ? { skillSource } : {}),
      evolvedSkills: evolvedSkillsWithVersions,
      triggerSource: this.triggerSource,
      ...(this.harnessFeature
        ? {
            harnessProjectId: this.harnessFeature.projectId,
            harnessFeatureSlug: this.harnessFeature.slug,
            ...(this.harnessFeature.nodeName
              ? { harnessNodeName: this.harnessFeature.nodeName }
              : {}),
            ...(this.harnessFeature.nodeStatus
              ? { harnessNodeStatus: this.harnessFeature.nodeStatus }
              : {}),
            ...harnessAdapterFields
          }
        : {}),
      ...(this.routingTrace ? { metadata: { routingTrace: this.routingTrace } } : {})
    }
    let skillEval: TraceSkillEvalExtension | undefined
    if (this.includeSkillEval) {
      try {
        const windowTurn = appendSkillEvalWindowTurn({
          traceId: trace.traceId,
          threadId: trace.threadId,
          startedAt: trace.startedAt,
          endedAt: trace.endedAt,
          usedSkills: usedSkillsWithVersions,
          userMessage: trace.userMessage,
          assistantText: getSkillEvalWindowAssistantText(trace),
          outcome: trace.outcome
        })
        const evalRawSkillNames = windowTurn.evalSkillNames
        const windowContextByRawName = getSkillEvalWindowContextByRawName(
          trace.threadId,
          evalRawSkillNames
        )
        skillEval = buildSkillEvalTraceExtension(trace, {
          skillAuthorByRawName,
          windowContextByRawName,
          evalRawSkillNames
        })
      } catch (e) {
        console.warn("[Tracer] buildSkillEvalTraceExtension failed:", e)
      }
    }
    const boundedSkillEval = boundSkillEvalExtension(skillEval, this.collectionBudget)
    const traceWithEval: AgentTrace = boundedSkillEval
      ? { ...trace, skillEval: boundedSkillEval }
      : trace

    try {
      try {
        flushSystemConstraintReadSummaries(this.traceId, outcome)
      } catch (error) {
        console.warn("[Tracer] Failed to flush system-constraint read telemetry:", error)
      }
      writeTraceFile(traceWithEval)

      // Keep reporting off the main run path, but track it so graceful app
      // shutdown can wait for already-scheduled uploads within a hard bound.
      reportTraceInBackground(traceWithEval)
    } finally {
      // A child trace may finish in the background after a continuation has
      // installed a newer context on the same worker thread. Only clear the
      // context still owned by this trace, even when persistence fails.
      try {
        clearAdoptionContext(this.threadId, this.traceId)
      } catch {
        // ignore
      }
    }

    return traceWithEval
  }

  private finalizeNodes(
    outcome: TraceOutcome,
    endedAt: string,
    resolvedUsedSkills: string[],
    resolvedSkillSource: string[],
    resolvedEvolvedSkills: string[],
    errorMessage?: string
  ): TraceNode[] {
    const finalStatus: TraceNodeStatus =
      outcome === "error"
        ? "error"
        : outcome === "cancelled"
          ? "cancelled"
          : outcome === "unknown"
            ? "unknown"
            : "success"
    for (const node of this.nodes) {
      if (node.type === "llm" || node.type === "tool") {
        if (node.status === "running") {
          node.status = finalStatus
        }
        if (!node.endedAt) node.endedAt = endedAt
      }
    }

    if (!this.terminalNodeAdded) {
      if (outcome === "error") {
        this.addTerminalNode({
          type: "error",
          output: errorMessage ?? "Unknown error",
          status: "error",
          startedAt: endedAt,
          endedAt
        })
      } else if (outcome === "cancelled") {
        this.addTerminalNode({
          type: "cancel",
          status: "cancelled",
          startedAt: endedAt,
          endedAt
        })
      } else if (outcome === "unknown") {
        this.addTerminalNode({
          type: "message",
          name: "Run Ended",
          output: errorMessage ?? "Run ended without a final success signal",
          status: "unknown",
          startedAt: endedAt,
          endedAt
        })
      } else {
        this.addTerminalNode({
          type: "message",
          output: "Run completed",
          status: "success",
          startedAt: endedAt,
          endedAt
        })
      }
    }

    const root = this.getNode(this.rootNodeId)
    if (root) {
      root.status = finalStatus
      root.endedAt = endedAt
      root.output = {
        outcome,
        totalSteps: this.steps.length,
        totalToolCalls: this.getTotalToolCalls(),
        ...(errorMessage ? { errorMessage } : {})
      }
      root.metadata = {
        ...(root.metadata ?? {}),
        ...this.observability,
        usedSkills: [...resolvedUsedSkills],
        ...(resolvedSkillSource.length > 0 ? { skillSource: [...resolvedSkillSource] } : {}),
        evolvedSkills: [...resolvedEvolvedSkills],
        triggerSource: this.triggerSource
      }
    }

    return this.nodes
  }

  /**
   * Structural and countable metadata only: the tool/result pairing key, the
   * llm message id, and the per-node tool counts getTotalToolCalls reads.
   */
  private pushNode(node: TraceNode): boolean {
    if (this.nodes.length >= TRACE_MAX_NODES) return false
    // Structure is what makes the tree readable and countable; only the payload
    // is negotiable. With no budget left, keep the node and drop input/output.
    if (!this.collectionBudget.canAdd(256)) {
      const skeleton: TraceNode = {
        ...node,
        id: clampText(node.id, 512),
        parentId: node.parentId ? clampText(node.parentId, 512) : null,
        ...(node.name ? { name: clampText(node.name, 512) } : {}),
        startedAt: clampText(node.startedAt, 64),
        ...(node.endedAt ? { endedAt: clampText(node.endedAt, 64) } : {}),
        input: undefined,
        output: undefined,
        // Payload goes, but these keys are how the tree pairs a tool with its
        // result and how getTotalToolCalls counts — dropping them would undo
        // the very thing the skeleton exists to preserve.
        metadata: pickCountableMetadata(node.metadata),
        truncated: true
      }
      const skeletonIndex = this.nodes.push(skeleton) - 1
      this.nodeIndexById.set(skeleton.id, skeletonIndex)
      return true
    }
    const metadata = this.collectionBudget.takeValue(node.metadata, 32 * 1024)
    const rawInput =
      node.input !== undefined && !isChatMessageArray(node.input)
        ? this.collectionBudget.takeValue(node.input, 32 * 1024)
        : undefined
    const boundedInputRef = rawInput !== undefined ? this.internNodeValue(rawInput) : undefined
    const boundedInput = boundedInputRef ? undefined : rawInput
    const boundedNode: TraceNode = {
      ...node,
      // Structure (ids, parent links, timestamps) stays out of the budget:
      // nodeIndexById and the parentId chain are keyed on these, so a budget
      // that could blank them would silently flatten the trace tree.
      id: clampText(node.id, 512),
      parentId: node.parentId ? clampText(node.parentId, 512) : null,
      ...(node.name ? { name: clampText(node.name, 512) } : {}),
      startedAt: clampText(node.startedAt, 64),
      ...(node.endedAt ? { endedAt: clampText(node.endedAt, 64) } : {}),
      // Everything passes through the byte budget — a node input has no
      // exemption, and letting chat-message arrays skip it put the whole llm
      // input window outside the 480KB pool.
      //
      // Interning comes after bounding, never before: ids are content
      // addresses, so one taken from the pre-truncation value would match
      // nothing. Chat-message arrays are bounded but not interned, because
      // their messages already carry per-message refs.
      ...(node.input !== undefined
        ? {
            input: isChatMessageArray(node.input)
              ? this.collectionBudget.takeValue(node.input, 32 * 1024)
              : boundedInput
          }
        : {}),
      ...(boundedInputRef ? { inputRef: boundedInputRef } : {}),
      ...(node.output !== undefined
        ? { output: this.collectionBudget.takeValue(node.output, 32 * 1024) }
        : {}),
      ...(metadata && typeof metadata === "object" && !Array.isArray(metadata)
        ? { metadata: metadata as Record<string, unknown> }
        : {})
    }
    const index = this.nodes.push(boundedNode) - 1
    this.nodeIndexById.set(boundedNode.id, index)
    return true
  }

  private getNode(id: string): TraceNode | undefined {
    const idx = this.nodeIndexById.get(id)
    if (idx === undefined) return undefined
    return this.nodes[idx]
  }

  private endNode(id: string, status: TraceNodeStatus): void {
    const node = this.getNode(id)
    if (!node) return
    node.status = status
    node.endedAt = nowIsoLocal()
  }
}

/** Construct optional child-run telemetry behind a hard failure boundary. */
export function createTraceCollectorSafely(
  threadId: string,
  userMessage: string,
  modelId: string,
  options: TraceCollectorOptions = {},
  scope = "Tracer"
): TraceCollector | undefined {
  try {
    return new TraceCollector(threadId, userMessage, modelId, options)
  } catch (error) {
    console.warn(`[${scope}] trace creation failed; continuing without telemetry:`, error)
    return undefined
  }
}

/** Run a synchronous trace mutation without allowing telemetry to affect the run. */
export function runTraceSideEffect(scope: string, effect: () => void): void {
  try {
    effect()
  } catch (error) {
    console.warn(`[${scope}] trace update failed; continuing without this telemetry:`, error)
  }
}

/** Complete and persist a child trace without delaying the worker/workflow result. */
export function finishTraceInBackground(
  tracer: TraceCollector,
  outcome: TraceOutcome,
  errorMessage?: string,
  scope = "Tracer",
  beforeFinish?: () => void
): void {
  // Defer the whole finish call, not just its returned promise. Async functions
  // execute synchronously until their first await, so calling finish inline
  // would still add telemetry work to the child-run completion path.
  setImmediate(() => {
    if (beforeFinish) {
      runTraceSideEffect(`${scope} pre-finish`, beforeFinish)
    }
    try {
      void tracer.finish(outcome, errorMessage).catch((error) => {
        console.warn(`[${scope}] background trace finish failed:`, error)
      })
    } catch (error) {
      console.warn(`[${scope}] background trace finish failed:`, error)
    }
  })
}

// ─────────────────────────────────────────────────────────
// Trace reading utilities (used by optimizer)
// ─────────────────────────────────────────────────────────

const TRACE_READ_MAX_DIRECTORY_ENTRIES = 4_096
const TRACE_READ_MAX_THREADS = 1_024
const TRACE_READ_MAX_FILES = 4_096
const TRACE_READ_MAX_FILE_BYTES = 2 * 1024 * 1024
const TRACE_READ_MAX_TOTAL_BYTES = 32 * 1024 * 1024
const TRACE_READ_MAX_RESULTS = 512
const TRACE_DELETE_MAX_IDS = 256

interface TraceReadBudget {
  entries: number
  files: number
  bytes: number
}

function createTraceReadBudget(): TraceReadBudget {
  return { entries: 0, files: 0, bytes: 0 }
}

function isSafeTraceSegment(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 256 &&
    value !== "." &&
    value !== ".." &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !value.includes("\0")
  )
}

async function pathIsFile(filePath: string): Promise<boolean> {
  try {
    return (await lstat(filePath)).isFile()
  } catch {
    return false
  }
}

/** List threadIds without ever materializing an unbounded directory. */
export async function listTracedThreads(): Promise<string[]> {
  const threads: string[] = []
  let directory
  try {
    directory = await opendir(getTracesRootDir())
  } catch {
    return threads
  }
  let scanned = 0
  for await (const entry of directory) {
    scanned += 1
    if (scanned > TRACE_READ_MAX_DIRECTORY_ENTRIES || threads.length >= TRACE_READ_MAX_THREADS)
      break
    if (entry.isDirectory() && isSafeTraceSegment(entry.name)) threads.push(entry.name)
    if (scanned % TRACE_IO_YIELD_INTERVAL === 0) await yieldTraceIo()
  }
  return threads
}

async function listThreadTraceFiles(threadId: string, budget: TraceReadBudget): Promise<string[]> {
  if (!isSafeTraceSegment(threadId)) return []
  const files: string[] = []
  let directory
  try {
    directory = await opendir(getThreadTracesDir(threadId))
  } catch {
    return files
  }
  for await (const entry of directory) {
    budget.entries += 1
    if (
      budget.entries > TRACE_READ_MAX_DIRECTORY_ENTRIES ||
      budget.files + files.length >= TRACE_READ_MAX_FILES
    ) {
      break
    }
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(join(getThreadTracesDir(threadId), entry.name))
    }
    if (budget.entries % TRACE_IO_YIELD_INTERVAL === 0) await yieldTraceIo()
  }
  budget.files += files.length
  return files
}

async function readTraceFileBounded(
  filePath: string,
  budget: TraceReadBudget,
  maxResults: number
): Promise<AgentTrace[]> {
  try {
    const fileStat = await lstat(filePath)
    if (
      !fileStat.isFile() ||
      fileStat.size > TRACE_READ_MAX_FILE_BYTES ||
      budget.bytes + fileStat.size > TRACE_READ_MAX_TOTAL_BYTES
    ) {
      return []
    }
    budget.bytes += fileStat.size
    const raw = await readFile(filePath, "utf8")
    const traces: AgentTrace[] = []
    let cursor = 0
    let lineCount = 0
    while (cursor <= raw.length && traces.length < maxResults && lineCount < 256) {
      const newline = raw.indexOf("\n", cursor)
      const end = newline < 0 ? raw.length : newline
      const line = raw.slice(cursor, end).replace(/\r$/, "")
      cursor = newline < 0 ? raw.length + 1 : newline + 1
      lineCount += 1
      if (!line.trim()) continue
      try {
        // Storage keeps one copy of each repeated value; every reader gets the
        // whole thing back, so no caller has to know refs exist.
        traces.push(rehydrateTraceContent(parseStoredTraceLine(line)))
      } catch {
        // Skip malformed or undecryptable trace lines.
      }
      if (lineCount % TRACE_IO_YIELD_INTERVAL === 0) await yieldTraceIo()
    }
    return traces
  } catch {
    return []
  }
}

async function readThreadTracesBounded(
  threadId: string,
  budget: TraceReadBudget,
  maxResults: number
): Promise<AgentTrace[]> {
  const files = await listThreadTraceFiles(threadId, budget)
  const traces: AgentTrace[] = []
  for (const filePath of files) {
    if (traces.length >= maxResults || budget.bytes >= TRACE_READ_MAX_TOTAL_BYTES) break
    traces.push(...(await readTraceFileBounded(filePath, budget, maxResults - traces.length)))
    await yieldTraceIo()
  }
  return traces
}

/** Read a bounded trace window for one thread, sorted oldest first. */
export async function readThreadTraces(threadId: string): Promise<AgentTrace[]> {
  if (!isSafeTraceSegment(threadId)) return []
  const traces = await readThreadTracesBounded(
    threadId,
    createTraceReadBudget(),
    TRACE_READ_MAX_RESULTS
  )
  return traces.sort((a, b) => a.startedAt.localeCompare(b.startedAt))
}

async function findTraceLocation(
  traceId: string,
  budget: TraceReadBudget
): Promise<{ threadId: string; filePath: string } | null> {
  if (!isSafeTraceSegment(traceId)) return null
  for (const threadId of await listTracedThreads()) {
    const directPath = join(getThreadTracesDir(threadId), `${traceId}.jsonl`)
    if (await pathIsFile(directPath)) return { threadId, filePath: directPath }
    for (const filePath of await listThreadTraceFiles(threadId, budget)) {
      const traces = await readTraceFileBounded(filePath, budget, 256)
      if (traces.some((trace) => trace.traceId === traceId)) return { threadId, filePath }
      if (budget.files >= TRACE_READ_MAX_FILES || budget.bytes >= TRACE_READ_MAX_TOTAL_BYTES) {
        return null
      }
    }
  }
  return null
}

/** Read one trace by ID across a bounded number of thread/files. */
export async function readTraceById(traceId: string): Promise<AgentTrace | null> {
  return (await readTracesByIds([traceId]))[0] ?? null
}

/** Resolve selected traces with one shared scan/byte budget. */
export async function readTracesByIds(traceIds: readonly string[]): Promise<AgentTrace[]> {
  const requested = new Set(
    [...new Set(traceIds)].filter(isSafeTraceSegment).slice(0, TRACE_DELETE_MAX_IDS)
  )
  if (requested.size === 0) return []
  const found = new Map<string, AgentTrace>()
  const budget = createTraceReadBudget()
  for (const threadId of await listTracedThreads()) {
    for (const filePath of await listThreadTraceFiles(threadId, budget)) {
      const traces = await readTraceFileBounded(filePath, budget, 256)
      for (const trace of traces) {
        if (requested.has(trace.traceId) && !found.has(trace.traceId)) {
          found.set(trace.traceId, trace)
        }
      }
      if (
        found.size === requested.size ||
        budget.files >= TRACE_READ_MAX_FILES ||
        budget.bytes >= TRACE_READ_MAX_TOTAL_BYTES
      ) {
        return traceIds.flatMap((traceId) => {
          const trace = found.get(traceId)
          return trace ? [trace] : []
        })
      }
    }
  }
  return traceIds.flatMap((traceId) => {
    const trace = found.get(traceId)
    return trace ? [trace] : []
  })
}

/** Read a bounded recent window across all trace threads. */
export async function readRecentTraces(limit = 20): Promise<AgentTrace[]> {
  const boundedLimit = Math.max(0, Math.min(Math.floor(limit), TRACE_READ_MAX_RESULTS))
  if (boundedLimit === 0) return []
  const budget = createTraceReadBudget()
  const all: AgentTrace[] = []
  for (const threadId of await listTracedThreads()) {
    if (budget.files >= TRACE_READ_MAX_FILES || budget.bytes >= TRACE_READ_MAX_TOTAL_BYTES) break
    all.push(
      ...(await readThreadTracesBounded(threadId, budget, TRACE_READ_MAX_RESULTS - all.length))
    )
    if (all.length >= TRACE_READ_MAX_RESULTS) break
  }
  return all.sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, boundedLimit)
}

export async function deleteTraceById(traceId: string): Promise<{
  success: boolean
  threadId?: string
  error?: string
}> {
  const location = await findTraceLocation(traceId, createTraceReadBudget())
  if (!location) return { success: true }
  try {
    await traceLocalStorage().runFileOperation(location.filePath, async () => {
      const fileStat = await lstat(location.filePath)
      if (!fileStat.isFile() || fileStat.size > TRACE_READ_MAX_FILE_BYTES) {
        throw new Error("Trace file exceeds the safe deletion budget")
      }
      const raw = await readFile(location.filePath, "utf8")
      const keptLines: string[] = []
      let removed = false
      let lineCount = 0
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue
        lineCount += 1
        if (lineCount > 256) throw new Error("Trace file contains too many records")
        try {
          if (parseStoredTraceLine(line).traceId === traceId) {
            removed = true
            continue
          }
        } catch {
          // Keep malformed lines to avoid destructive data loss.
        }
        keptLines.push(line)
      }
      if (!removed) return
      if (keptLines.length === 0) {
        await unlink(location.filePath)
        return
      }
      const tempPath = `${location.filePath}.delete-${process.pid}-${uuid()}`
      try {
        await writeFile(tempPath, `${keptLines.join("\n")}\n`, { encoding: "utf8", mode: 0o600 })
        await rename(tempPath, location.filePath)
      } finally {
        await unlink(tempPath).catch(() => undefined)
      }
    })
    await rmdir(getThreadTracesDir(location.threadId)).catch(() => undefined)
    return { success: true, threadId: location.threadId }
  } catch (error) {
    return {
      success: false,
      threadId: location.threadId,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

export async function deleteTraces(traceIds: string[]): Promise<{
  deletedIds: string[]
  failed: Array<{ traceId: string; error: string }>
}> {
  const deletedIds: string[] = []
  const failed: Array<{ traceId: string; error: string }> = []
  const uniqueIds = [...new Set(traceIds)].slice(0, TRACE_DELETE_MAX_IDS)
  for (const traceId of uniqueIds) {
    const result = await deleteTraceById(traceId)
    if (result.success) deletedIds.push(traceId)
    else failed.push({ traceId, error: result.error ?? "Unknown error" })
    await yieldTraceIo()
  }
  return { deletedIds, failed }
}

/** Return the traces directory path (for display purposes). */
export function getTracesDir(): string {
  return getTracesRootDir()
}
