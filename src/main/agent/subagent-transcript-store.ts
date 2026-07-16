import { createHash, randomUUID } from "crypto"
import { existsSync, mkdirSync, readFileSync, statSync } from "fs"
import { appendFile, readFile, rename, rm, unlink, writeFile } from "fs/promises"
import { join } from "path"
import { getOpenworkDir } from "../storage"
import { HeadTailTextAccumulator } from "../../shared/head-tail-text"
import type { HeadTailTextInputKind } from "../../shared/head-tail-text"
import type {
  PersistedSubagentTranscriptMessage,
  SubagentTranscriptRunStatus,
  SubagentTranscriptRunSummary
} from "../../shared/subagent-transcript"

const STORE_VERSION = 1 as const
const DEFAULT_MAX_RUN_BYTES = 128 * 1024 * 1024
const DEFAULT_MAX_PENDING_BYTES = 8 * 1024 * 1024
const FLUSH_DEBOUNCE_MS = 100
const EAGER_FLUSH_BYTES = 64 * 1024

type TranscriptRole = PersistedSubagentTranscriptMessage["role"]

interface RunStartDetails {
  name?: string
  description?: string
  subagentType?: string
}

export interface SubagentTranscriptMessagePatch {
  id: string
  role: TranscriptRole
  content?: unknown
  contentKind?: HeadTailTextInputKind
  toolCalls?: unknown[]
  toolCallChunks?: unknown[]
  toolCallId?: string
  name?: string
  status?: string
  isError?: boolean
  createdAt?: number
}

interface TranscriptEventBase {
  version: typeof STORE_VERSION
  at: number
}

interface RunStartEvent extends TranscriptEventBase, RunStartDetails {
  type: "run_start"
  threadId: string
  subagentId: string
}

interface MessagePatchEvent extends TranscriptEventBase {
  type: "message_patch"
  messageId: string
  role: TranscriptRole
  contentMode?: "append" | "replace"
  content?: unknown
  toolCalls?: unknown[]
  toolCallChunks?: unknown[]
  toolCallId?: string
  name?: string
  status?: string
  isError?: boolean
  createdAt: number
}

interface RunEndEvent extends TranscriptEventBase {
  type: "run_end"
  status: Exclude<SubagentTranscriptRunStatus, "running">
  finalResult?: string
}

interface StorageLimitEvent extends TranscriptEventBase {
  type: "storage_limit"
  reason: "run_limit" | "backpressure"
  limitBytes: number
}

type TranscriptEvent = RunStartEvent | MessagePatchEvent | RunEndEvent | StorageLimitEvent

interface ActiveMessageState {
  text?: HeadTailTextAccumulator
  currentLength: number
}

interface RunState {
  key: string
  threadId: string
  subagentId: string
  logPath: string
  metaPath: string
  started: boolean
  ended: boolean
  messageIds: Set<string>
  messages: Map<string, ActiveMessageState>
  summary: SubagentTranscriptRunSummary
  writtenBytes: number
  pending: string
  pendingBytes: number
  timer?: ReturnType<typeof setTimeout>
  drainPromise?: Promise<void>
  finalizePromise?: Promise<void>
  metaDirty: boolean
  limitRecorded: boolean
  revision: number
}

export interface SubagentTranscriptStoreOptions {
  baseDir?: string
  maxRunBytes?: number
  maxPendingBytes?: number
}

function stableSegment(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function contentLength(content: unknown): number {
  if (typeof content === "string") return content.length
  if (!Array.isArray(content)) return 0
  return content.reduce((total, block) => {
    const record = asRecord(block)
    const text = typeof record?.text === "string" ? record.text : ""
    const nested = typeof record?.content === "string" ? record.content : ""
    return total + text.length + nested.length
  }, 0)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function readExistingSummary(metaPath: string): SubagentTranscriptRunSummary | null {
  if (!existsSync(metaPath)) return null
  try {
    const parsed = JSON.parse(readFileSync(metaPath, "utf8")) as SubagentTranscriptRunSummary
    if (parsed?.version !== STORE_VERSION || !parsed.threadId || !parsed.subagentId) return null
    return parsed
  } catch {
    return null
  }
}

function mergeToolCalls(
  existing: PersistedSubagentTranscriptMessage["tool_calls"] | undefined,
  incoming: unknown[] | undefined
): PersistedSubagentTranscriptMessage["tool_calls"] | undefined {
  const byId = new Map((existing ?? []).map((toolCall) => [toolCall.id, toolCall]))
  for (const raw of incoming ?? []) {
    const record = asRecord(raw)
    if (!record) continue
    const fn = asRecord(record.function)
    const id = typeof record.id === "string" ? record.id : ""
    const name =
      (typeof record.name === "string" && record.name) ||
      (typeof fn?.name === "string" && fn.name) ||
      ""
    if (!id || !name) continue
    let args = asRecord(record.args)
    const serializedArgs =
      typeof record.args === "string"
        ? record.args
        : typeof fn?.arguments === "string"
          ? fn.arguments
          : ""
    if (!args && serializedArgs) {
      try {
        args = asRecord(JSON.parse(serializedArgs))
      } catch {
        args = undefined
      }
    }
    const previous = byId.get(id)
    byId.set(id, {
      id,
      name,
      args: args && Object.keys(args).length > 0 ? args : (previous?.args ?? {})
    })
  }
  return byId.size > 0 ? [...byId.values()] : undefined
}

interface MaterializedMessageState extends PersistedSubagentTranscriptMessage {
  chunkArgs: Map<string, string>
}

interface RecoveredTranscriptLog {
  messages: PersistedSubagentTranscriptMessage[]
  started: boolean
  ended: boolean
  status?: Exclude<SubagentTranscriptRunStatus, "running">
  details: RunStartDetails
  startedAt?: number
  completedAt?: number
  lastActivityAt?: number
  storageLimit?: Pick<StorageLimitEvent, "reason" | "limitBytes">
}

function applyToolCallChunks(
  message: MaterializedMessageState,
  chunks: unknown[] | undefined
): void {
  if (!chunks) return
  const calls = new Map((message.tool_calls ?? []).map((toolCall) => [toolCall.id, toolCall]))
  for (const raw of chunks) {
    const record = asRecord(raw)
    if (!record) continue
    const index = typeof record.index === "number" ? record.index : 0
    const observedId = typeof record.id === "string" && record.id ? record.id : undefined
    const indexedCall = [...calls.values()][index]
    const fallbackKey = indexedCall?.id ?? `index:${index}`
    const key = observedId ?? fallbackKey
    const previousArgs =
      message.chunkArgs.get(key) ??
      (observedId && observedId !== fallbackKey ? message.chunkArgs.get(fallbackKey) : undefined) ??
      ""
    const incomingArgs =
      typeof record.args === "string"
        ? record.args
        : asRecord(record.args)
          ? JSON.stringify(record.args)
          : ""
    const nextArgs =
      incomingArgs.startsWith(previousArgs) && incomingArgs.length >= previousArgs.length
        ? incomingArgs
        : previousArgs + incomingArgs
    message.chunkArgs.set(key, nextArgs)
    if (observedId && observedId !== fallbackKey) message.chunkArgs.delete(fallbackKey)

    const existing = calls.get(key) ?? indexedCall
    const name =
      (typeof record.name === "string" && record.name) || existing?.name || `tool_${index + 1}`
    let args = existing?.args ?? {}
    if (nextArgs) {
      try {
        const parsed = JSON.parse(nextArgs)
        if (asRecord(parsed)) args = parsed
      } catch {
        // Partial JSON is expected while tool-call args are streaming.
      }
    }
    const id = observedId ?? existing?.id ?? key
    if (observedId && existing?.id && existing.id !== observedId) calls.delete(existing.id)
    calls.set(id, { id, name, args })
  }
  message.tool_calls = calls.size > 0 ? [...calls.values()] : undefined
}

function recoverTranscriptLog(
  text: string,
  expected?: { threadId: string; subagentId: string }
): RecoveredTranscriptLog {
  const order: string[] = []
  const messages = new Map<string, MaterializedMessageState>()
  const recovered: RecoveredTranscriptLog = {
    messages: [],
    started: false,
    ended: false,
    details: {}
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue
    let rawEvent: unknown
    try {
      rawEvent = JSON.parse(line)
    } catch {
      // A crash can leave one partial final line; prior complete lines are valid.
      continue
    }
    const event = asRecord(rawEvent)
    if (!event || event.version !== STORE_VERSION || typeof event.type !== "string") continue
    const at = typeof event.at === "number" && Number.isFinite(event.at) ? event.at : undefined
    if (at !== undefined) {
      recovered.lastActivityAt = Math.max(recovered.lastActivityAt ?? at, at)
    }

    if (event.type === "run_start") {
      const eventThreadId = typeof event.threadId === "string" ? event.threadId : ""
      const eventSubagentId = typeof event.subagentId === "string" ? event.subagentId : ""
      if (
        !eventThreadId ||
        !eventSubagentId ||
        (expected &&
          (eventThreadId !== expected.threadId || eventSubagentId !== expected.subagentId))
      ) {
        continue
      }
      recovered.started = true
      if (at !== undefined) recovered.startedAt ??= at
      for (const key of ["name", "description", "subagentType"] as const) {
        if (typeof event[key] === "string" && event[key]) recovered.details[key] = event[key]
      }
      continue
    }
    if (event.type === "run_end") {
      if (["completed", "failed", "cancelled", "interrupted"].includes(String(event.status))) {
        recovered.status = event.status as Exclude<SubagentTranscriptRunStatus, "running">
        recovered.ended = true
        if (at !== undefined) recovered.completedAt = at
      }
      continue
    }
    if (event.type === "storage_limit") {
      if (
        (event.reason === "run_limit" || event.reason === "backpressure") &&
        typeof event.limitBytes === "number" &&
        Number.isFinite(event.limitBytes)
      ) {
        recovered.storageLimit = {
          reason: event.reason,
          limitBytes: event.limitBytes
        }
      }
      continue
    }
    if (event.type !== "message_patch") continue
    const messageId = typeof event.messageId === "string" ? event.messageId : ""
    const role = typeof event.role === "string" ? event.role : ""
    if (!messageId || !["user", "assistant", "system", "tool"].includes(role)) continue
    recovered.started = true
    let message = messages.get(messageId)
    if (!message) {
      message = {
        id: messageId,
        role: role as TranscriptRole,
        content: "",
        created_at:
          typeof event.createdAt === "number" && Number.isFinite(event.createdAt)
            ? event.createdAt
            : (at ?? Date.now()),
        chunkArgs: new Map()
      }
      messages.set(messageId, message)
      order.push(messageId)
    }
    message.role = role as TranscriptRole
    if (event.contentMode === "append" && typeof event.content === "string") {
      message.content = `${typeof message.content === "string" ? message.content : ""}${event.content}`
    } else if (event.contentMode === "replace") {
      message.content = event.content ?? ""
    }
    message.tool_calls = mergeToolCalls(
      message.tool_calls,
      Array.isArray(event.toolCalls) ? event.toolCalls : undefined
    )
    applyToolCallChunks(
      message,
      Array.isArray(event.toolCallChunks) ? event.toolCallChunks : undefined
    )
    if (typeof event.toolCallId === "string" && event.toolCallId) {
      message.tool_call_id = event.toolCallId
    }
    if (typeof event.name === "string" && event.name) message.name = event.name
    if (typeof event.status === "string" && event.status) message.status = event.status
    if (typeof event.isError === "boolean") message.is_error = event.isError
  }
  recovered.messages = order.map((id) => {
    const { chunkArgs, ...message } = messages.get(id)!
    chunkArgs.clear()
    return message
  })
  return recovered
}

function storageLimitMessage(limit: RecoveredTranscriptLog["storageLimit"]): string | undefined {
  if (!limit) return undefined
  return limit.reason === "run_limit"
    ? `Transcript exceeded the ${limit.limitBytes}-byte run limit.`
    : `Transcript writer exceeded the ${limit.limitBytes}-byte pending buffer.`
}

export class SubagentTranscriptStore {
  private readonly baseDir: string
  private readonly maxRunBytes: number
  private readonly maxPendingBytes: number
  private readonly runs = new Map<string, RunState>()
  private readonly retiredThreads = new Set<string>()

  constructor(options: SubagentTranscriptStoreOptions = {}) {
    this.baseDir = options.baseDir ?? join(getOpenworkDir(), "subagent-transcripts")
    this.maxRunBytes = options.maxRunBytes ?? DEFAULT_MAX_RUN_BYTES
    this.maxPendingBytes = options.maxPendingBytes ?? DEFAULT_MAX_PENDING_BYTES
  }

  startRun(threadId: string, subagentId: string, details: RunStartDetails = {}): boolean {
    if (this.retiredThreads.has(threadId)) return false
    const run = this.getRun(threadId, subagentId)
    if (run.started) {
      const missingDetails = {
        ...(!run.summary.name && details.name ? { name: details.name } : {}),
        ...(!run.summary.description && details.description
          ? { description: details.description }
          : {}),
        ...(!run.summary.subagentType && details.subagentType
          ? { subagentType: details.subagentType }
          : {})
      }
      if (Object.keys(missingDetails).length > 0) {
        run.summary = { ...run.summary, ...missingDetails, lastActivityAt: Date.now() }
        this.queueEvent(run, {
          version: STORE_VERSION,
          type: "run_start",
          threadId,
          subagentId,
          ...missingDetails,
          at: Date.now()
        })
        if (run.ended) {
          run.summary.completeness = this.pendingCompleteness(run)
          if (!run.finalizePromise) {
            run.finalizePromise = this.finalizeRun(run)
            void run.finalizePromise.catch((error) => {
              console.warn("[SubagentTranscript] late-metadata flush failed:", error)
            })
          }
        }
      }
      return false
    }
    const now = Date.now()
    run.started = true
    run.summary = {
      ...run.summary,
      ...details,
      status: "running",
      completeness: this.pendingCompleteness(run),
      startedAt: now,
      lastActivityAt: now
    }
    this.queueEvent(run, {
      version: STORE_VERSION,
      type: "run_start",
      threadId,
      subagentId,
      ...details,
      at: now
    })
    return true
  }

  recordMessage(
    threadId: string,
    subagentId: string,
    patch: SubagentTranscriptMessagePatch
  ): boolean {
    if (this.retiredThreads.has(threadId) || !patch.id) return false
    const run = this.getRun(threadId, subagentId)
    if (!run.started) this.startRun(threadId, subagentId)

    let message = run.messages.get(patch.id)
    if (!message) {
      message = { currentLength: 0 }
      run.messages.set(patch.id, message)
    }
    let contentMode: MessagePatchEvent["contentMode"]
    let persistedContent: unknown
    if (typeof patch.content === "string") {
      message.text ??= new HeadTailTextAccumulator(16_000, 8_000)
      const result = message.text.ingest(patch.content, patch.contentKind)
      run.summary.totalChars += result.totalChars - message.currentLength
      message.currentLength = result.totalChars
      if (result.persistenceMode !== "noop") {
        contentMode = result.persistenceMode
        persistedContent = result.persistedContent
      }
    } else if (patch.content !== undefined) {
      const nextLength = contentLength(patch.content)
      run.summary.totalChars += nextLength - message.currentLength
      message.currentLength = nextLength
      message.text = undefined
      contentMode = "replace"
      persistedContent = patch.content
    }

    const hasToolPatch =
      (patch.toolCalls?.length ?? 0) > 0 || (patch.toolCallChunks?.length ?? 0) > 0
    const hasMetadataPatch = Boolean(
      patch.toolCallId || patch.name || patch.status || patch.isError !== undefined
    )
    if (!contentMode && !hasToolPatch && !hasMetadataPatch) return false

    if (!run.messageIds.has(patch.id)) {
      run.messageIds.add(patch.id)
      run.summary.totalMessages += 1
    }

    const now = Date.now()
    run.summary.lastActivityAt = now
    this.queueEvent(run, {
      version: STORE_VERSION,
      type: "message_patch",
      messageId: patch.id,
      role: patch.role,
      ...(contentMode ? { contentMode, content: persistedContent } : {}),
      ...(patch.toolCalls?.length ? { toolCalls: patch.toolCalls } : {}),
      ...(patch.toolCallChunks?.length ? { toolCallChunks: patch.toolCallChunks } : {}),
      ...(patch.toolCallId ? { toolCallId: patch.toolCallId } : {}),
      ...(patch.name ? { name: patch.name } : {}),
      ...(patch.status ? { status: patch.status } : {}),
      ...(patch.isError !== undefined ? { isError: patch.isError } : {}),
      createdAt: patch.createdAt ?? now,
      at: now
    })
    if (run.ended) {
      run.summary.completeness = this.pendingCompleteness(run)
      if (!run.finalizePromise) {
        run.finalizePromise = this.finalizeRun(run)
        void run.finalizePromise.catch((error) => {
          console.warn("[SubagentTranscript] late-message flush failed:", error)
        })
      }
    }
    return true
  }

  endRun(
    threadId: string,
    subagentId: string,
    status: Exclude<SubagentTranscriptRunStatus, "running">,
    finalResult?: string
  ): void {
    if (this.retiredThreads.has(threadId)) return
    const run = this.getRun(threadId, subagentId)
    if (!run.started) this.startRun(threadId, subagentId)
    if (run.ended) return
    const now = Date.now()
    run.ended = true
    run.summary.status = status
    // Remain "recording" until the run_end event and all prior deltas have
    // reached disk. The UI must not claim durability before that boundary.
    run.summary.completeness = this.pendingCompleteness(run)
    run.summary.completedAt = now
    run.summary.lastActivityAt = now
    this.queueEvent(
      run,
      {
        version: STORE_VERSION,
        type: "run_end",
        status,
        ...(finalResult ? { finalResult } : {}),
        at: now
      },
      true
    )
    run.finalizePromise = this.finalizeRun(run)
    void run.finalizePromise.catch((error) => {
      console.warn("[SubagentTranscript] completion flush failed:", error)
    })
  }

  markThreadRuns(
    threadId: string,
    status: Exclude<SubagentTranscriptRunStatus, "running" | "completed">
  ): void {
    for (const run of this.runs.values()) {
      if (run.threadId === threadId && !run.ended) this.endRun(threadId, run.subagentId, status)
    }
  }

  async flushThread(threadId: string): Promise<void> {
    const runs = [...this.runs.values()].filter((run) => run.threadId === threadId)
    const results = await Promise.allSettled(
      runs.map((run) => run.finalizePromise ?? this.flushRun(run))
    )
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected"
    )
    if (rejected) throw rejected.reason
  }

  async flushAll(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.runs.values()].map((run) => run.finalizePromise ?? this.flushRun(run))
    )
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected"
    )
    if (rejected) throw rejected.reason
  }

  getRunSummary(threadId: string, subagentId: string): SubagentTranscriptRunSummary | null {
    const active = this.runs.get(this.runKey(threadId, subagentId))
    if (active) return { ...active.summary, storedBytes: active.writtenBytes + active.pendingBytes }
    const { logPath, metaPath } = this.paths(threadId, subagentId)
    const summary = readExistingSummary(metaPath)
    const validSummary =
      summary?.threadId === threadId && summary.subagentId === subagentId ? summary : null
    let logBytes: number | undefined
    try {
      logBytes = existsSync(logPath) ? statSync(logPath).size : undefined
    } catch {
      logBytes = undefined
    }
    if (validSummary && (logBytes === undefined || validSummary.storedBytes === logBytes)) {
      return validSummary
    }
    // The append-only log is authoritative. A crash can occur after its write
    // succeeds but before the replace-on-write metadata summary is committed.
    if (logBytes !== undefined) {
      const recovered = this.getRun(threadId, subagentId)
      return {
        ...recovered.summary,
        storedBytes: recovered.writtenBytes + recovered.pendingBytes
      }
    }
    return validSummary
  }

  retireThread(threadId: string): boolean {
    const wasRetired = this.retiredThreads.has(threadId)
    this.retiredThreads.add(threadId)
    return wasRetired
  }

  restoreThread(threadId: string, wasRetired: boolean): void {
    if (!wasRetired) this.retiredThreads.delete(threadId)
  }

  async purgeThread(threadId: string): Promise<void> {
    await this.flushThread(threadId).catch(() => undefined)
    for (const [key, run] of this.runs) {
      if (run.threadId !== threadId) continue
      if (run.timer) clearTimeout(run.timer)
      this.runs.delete(key)
    }
    await rm(this.threadDir(threadId), { recursive: true, force: true })
  }

  /** Test/repair reader. P2 will add indexed cursor paging on top of the event log. */
  async readRunMessages(
    threadId: string,
    subagentId: string
  ): Promise<PersistedSubagentTranscriptMessage[]> {
    await this.flushThread(threadId)
    const { logPath } = this.paths(threadId, subagentId)
    let text: string
    try {
      text = await readFile(logPath, "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
      throw error
    }

    return recoverTranscriptLog(text, { threadId, subagentId }).messages
  }

  private getRun(threadId: string, subagentId: string): RunState {
    const key = this.runKey(threadId, subagentId)
    const existing = this.runs.get(key)
    if (existing) return existing

    const { runDir, logPath, metaPath } = this.paths(threadId, subagentId)
    let persisted: SubagentTranscriptRunSummary | null = null
    let writtenBytes = 0
    let initializationError: string | undefined
    try {
      mkdirSync(runDir, { recursive: true })
      persisted = readExistingSummary(metaPath)
      writtenBytes = existsSync(logPath) ? statSync(logPath).size : 0
    } catch (error) {
      initializationError = errorMessage(error)
      console.warn("[SubagentTranscript] Failed to initialize storage:", error)
    }
    const now = Date.now()
    const validPersisted =
      persisted?.threadId === threadId && persisted.subagentId === subagentId ? persisted : null
    let recoveredLog: RecoveredTranscriptLog = {
      messages: [],
      started: false,
      ended: false,
      details: {}
    }
    if (writtenBytes > 0 && !initializationError) {
      try {
        recoveredLog = recoverTranscriptLog(readFileSync(logPath, "utf8"), {
          threadId,
          subagentId
        })
      } catch (error) {
        initializationError = errorMessage(error)
        console.warn("[SubagentTranscript] Failed to recover active message state:", error)
      }
    }
    const recoveredMessages = recoveredLog.messages
    const recoveredHasState =
      recoveredLog.started || recoveredLog.ended || recoveredMessages.length > 0
    const recoveredStatus = recoveredLog.status ?? validPersisted?.status ?? ("running" as const)
    const recoveredLimitRecorded =
      Boolean(recoveredLog.storageLimit) || validPersisted?.completeness === "partial"
    const recoveredTotalChars = recoveredMessages.reduce(
      (total, message) => total + contentLength(message.content),
      0
    )
    const initialSummary = recoveredHasState
      ? ({
          version: STORE_VERSION,
          threadId,
          subagentId,
          ...validPersisted,
          ...recoveredLog.details,
          status: recoveredStatus,
          completeness:
            validPersisted?.completeness === "storage_error" && validPersisted.storageError
              ? "storage_error"
              : recoveredLimitRecorded
                ? "partial"
                : recoveredStatus === "running"
                  ? "recording"
                  : "complete",
          startedAt: recoveredLog.startedAt ?? validPersisted?.startedAt ?? now,
          ...(recoveredStatus !== "running" && {
            completedAt: recoveredLog.completedAt ?? validPersisted?.completedAt ?? now
          }),
          lastActivityAt: recoveredLog.lastActivityAt ?? validPersisted?.lastActivityAt ?? now,
          totalMessages: recoveredMessages.length,
          totalChars: recoveredTotalChars,
          storedBytes: writtenBytes,
          storageError:
            validPersisted?.completeness === "storage_error"
              ? validPersisted.storageError
              : (storageLimitMessage(recoveredLog.storageLimit) ??
                (recoveredLimitRecorded ? validPersisted?.storageError : undefined))
        } satisfies SubagentTranscriptRunSummary)
      : (validPersisted ??
        ({
          version: STORE_VERSION,
          threadId,
          subagentId,
          status: "running",
          completeness: "recording",
          startedAt: now,
          lastActivityAt: now,
          totalMessages: 0,
          totalChars: 0,
          storedBytes: writtenBytes
        } satisfies SubagentTranscriptRunSummary))
    const recoveredMessageStates = new Map<string, ActiveMessageState>()
    for (const message of recoveredMessages) {
      const currentLength = contentLength(message.content)
      if (typeof message.content === "string") {
        const text = new HeadTailTextAccumulator(16_000, 8_000)
        text.ingest(message.content)
        recoveredMessageStates.set(message.id, { text, currentLength })
      } else {
        recoveredMessageStates.set(message.id, { currentLength })
      }
    }
    const run: RunState = {
      key,
      threadId,
      subagentId,
      logPath,
      metaPath,
      started: Boolean(validPersisted || recoveredHasState),
      ended: recoveredStatus !== "running",
      messageIds: new Set(recoveredMessages.map((message) => message.id)),
      messages: recoveredMessageStates,
      summary: initializationError
        ? {
            ...initialSummary,
            completeness: "storage_error",
            storageError: initializationError
          }
        : initialSummary,
      writtenBytes,
      pending: "",
      pendingBytes: 0,
      metaDirty: false,
      limitRecorded: recoveredLimitRecorded,
      revision: 0
    }
    this.runs.set(key, run)
    return run
  }

  private queueEvent(run: RunState, event: TranscriptEvent, bypassLimit = false): void {
    run.revision += 1
    let line: string
    try {
      line = `${JSON.stringify(event)}\n`
    } catch (error) {
      run.limitRecorded = true
      run.summary.completeness = "partial"
      run.summary.storageError = `Transcript event serialization failed: ${errorMessage(error)}`
      run.metaDirty = true
      if (!run.timer) {
        run.timer = setTimeout(() => {
          run.timer = undefined
          void this.drain(run).catch((drainError) => {
            console.warn("[SubagentTranscript] metadata flush failed:", drainError)
          })
        }, FLUSH_DEBOUNCE_MS)
        run.timer.unref?.()
      }
      return
    }
    const bytes = Buffer.byteLength(line)
    if (!bypassLimit) {
      const projectedRunBytes = run.writtenBytes + run.pendingBytes + bytes
      if (projectedRunBytes > this.maxRunBytes) {
        this.recordStorageLimit(run, "run_limit", this.maxRunBytes)
        return
      }
      if (run.pendingBytes + bytes > this.maxPendingBytes) {
        this.recordStorageLimit(run, "backpressure", this.maxPendingBytes)
        return
      }
    }

    run.pending += line
    run.pendingBytes += bytes
    run.summary.storedBytes = run.writtenBytes + run.pendingBytes
    run.metaDirty = true
    if (run.pendingBytes >= EAGER_FLUSH_BYTES) {
      if (run.timer) clearTimeout(run.timer)
      run.timer = undefined
      void this.drain(run).catch((error) => {
        console.warn("[SubagentTranscript] eager flush failed:", error)
      })
      return
    }
    if (!run.timer) {
      run.timer = setTimeout(() => {
        run.timer = undefined
        void this.drain(run).catch((error) => {
          console.warn("[SubagentTranscript] buffered flush failed:", error)
        })
      }, FLUSH_DEBOUNCE_MS)
      run.timer.unref?.()
    }
  }

  private recordStorageLimit(
    run: RunState,
    reason: StorageLimitEvent["reason"],
    limitBytes: number
  ): void {
    if (run.limitRecorded) {
      // Content counters continue to describe what was observed even after the
      // durable byte cap is reached. Persist those updated counters as partial
      // metadata instead of leaving the last pre-limit snapshot indefinitely.
      run.metaDirty = true
      if (!run.timer) {
        run.timer = setTimeout(() => {
          run.timer = undefined
          void this.drain(run).catch((error) => {
            console.warn("[SubagentTranscript] partial metadata flush failed:", error)
          })
        }, FLUSH_DEBOUNCE_MS)
        run.timer.unref?.()
      }
      return
    }
    run.limitRecorded = true
    if (run.summary.completeness !== "storage_error") {
      run.summary.completeness = "partial"
      run.summary.storageError =
        reason === "run_limit"
          ? `Transcript exceeded the ${limitBytes}-byte run limit.`
          : `Transcript writer exceeded the ${limitBytes}-byte pending buffer.`
    }
    this.queueEvent(
      run,
      { version: STORE_VERSION, type: "storage_limit", reason, limitBytes, at: Date.now() },
      true
    )
  }

  private pendingCompleteness(run: RunState): SubagentTranscriptRunSummary["completeness"] {
    if (run.summary.completeness === "storage_error" && run.summary.storageError) {
      return "storage_error"
    }
    return run.limitRecorded ? "partial" : "recording"
  }

  private async flushRun(run: RunState): Promise<void> {
    if (run.timer) {
      clearTimeout(run.timer)
      run.timer = undefined
    }
    await this.drain(run)
    // A transient append/meta failure may succeed on an explicit terminal or
    // shutdown retry. Promote the summary only after that retry is durable.
    if (run.ended && run.summary.completeness === "storage_error" && !run.summary.storageError) {
      run.summary.completeness = run.limitRecorded ? "partial" : "complete"
      run.metaDirty = true
      await this.drain(run)
    }
  }

  private async finalizeRun(run: RunState): Promise<void> {
    try {
      while (true) {
        const revision = run.revision
        await this.flushRun(run)
        if (revision !== run.revision) continue
        if (run.summary.completeness !== "storage_error") {
          run.summary.completeness = run.limitRecorded ? "partial" : "complete"
          run.metaDirty = true
          await this.flushRun(run)
        }
        if (revision === run.revision && !run.pending && !run.metaDirty && !run.drainPromise) {
          return
        }
      }
    } finally {
      run.finalizePromise = undefined
    }
  }

  private async drain(run: RunState): Promise<void> {
    if (run.drainPromise) {
      await run.drainPromise
      if (run.pending || run.metaDirty) await this.drain(run)
      return
    }

    const operation = (async () => {
      while (run.pending) {
        const batch = run.pending
        const batchBytes = run.pendingBytes
        run.pending = ""
        run.pendingBytes = 0
        try {
          await appendFile(run.logPath, batch, { encoding: "utf8", mode: 0o600 })
          run.writtenBytes += batchBytes
          run.summary.storedBytes = run.writtenBytes
          run.summary.storageError = run.limitRecorded ? run.summary.storageError : undefined
        } catch (error) {
          run.pending = batch + run.pending
          run.pendingBytes = batchBytes + run.pendingBytes
          run.summary.completeness = "storage_error"
          run.summary.storageError = errorMessage(error)
          run.metaDirty = true
          throw error
        }
      }
      if (run.metaDirty) {
        run.metaDirty = false
        if (run.summary.completeness === "storage_error") {
          // A successful retry should not leave a running transcript stuck in
          // storage_error forever. If this metadata write fails again, the
          // catch below restores the error state atomically.
          run.summary.completeness = run.ended
            ? run.limitRecorded
              ? "partial"
              : "complete"
            : run.limitRecorded
              ? "partial"
              : "recording"
          if (!run.limitRecorded) run.summary.storageError = undefined
        }
        try {
          await this.writeMeta(run)
        } catch (error) {
          run.metaDirty = true
          run.summary.completeness = "storage_error"
          run.summary.storageError = errorMessage(error)
          throw error
        }
      }
    })()
    run.drainPromise = operation
    try {
      await operation
    } finally {
      run.drainPromise = undefined
    }
  }

  private async writeMeta(run: RunState): Promise<void> {
    const tempPath = `${run.metaPath}.${randomUUID()}.tmp`
    const payload = `${JSON.stringify({ ...run.summary, storedBytes: run.writtenBytes }, null, 2)}\n`
    try {
      await writeFile(tempPath, payload, { encoding: "utf8", mode: 0o600 })
      await rename(tempPath, run.metaPath)
    } finally {
      await unlink(tempPath).catch(() => undefined)
    }
  }

  private runKey(threadId: string, subagentId: string): string {
    return `${threadId}\u0000${subagentId}`
  }

  private threadDir(threadId: string): string {
    return join(this.baseDir, stableSegment(threadId))
  }

  private paths(
    threadId: string,
    subagentId: string
  ): {
    runDir: string
    logPath: string
    metaPath: string
  } {
    const runDir = this.threadDir(threadId)
    const base = stableSegment(subagentId)
    return {
      runDir,
      logPath: join(runDir, `${base}.events.jsonl`),
      metaPath: join(runDir, `${base}.meta.json`)
    }
  }
}

let defaultStore: SubagentTranscriptStore | undefined

export function getSubagentTranscriptStore(): SubagentTranscriptStore {
  defaultStore ??= new SubagentTranscriptStore()
  return defaultStore
}

export async function flushAllSubagentTranscripts(): Promise<void> {
  await getSubagentTranscriptStore().flushAll()
}
