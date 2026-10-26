import { mkdirSync } from "node:fs"
import { dirname, isAbsolute } from "node:path"
import { DatabaseSync } from "node:sqlite"
import type { UserInputRequest, UserInputResponse } from "../types"
import { requestUserInputSchema } from "../../shared/user-input-schema"
import type { ClawActionIdentity } from "../../shared/mods/claw-actions"

/** Retained only after the original restricted provider and native Flow facts settle. */
export interface HostContextResumeProof {
  authority: {
    protocol: "devclaw.native-project-context-readonly/v1"
    workspace: string
    threadId: string
    operationId: string
    inputIdentity: string
    provider: ClawActionIdentity
    policy: "native-materials-only/v1"
  }
  providerId: string
  runId: string
  executionId: string
  definitionDigest: string
  canonicalContextDigest: string
}

/** Main-issued binding. Persisting it does not preserve authorization or a live model continuation. */
export interface HostUserInputBinding {
  projectId: string
  operationId: string
  stageId: string
  installedPluginId: string
  expectedVersion: number
  pluginDigest: string
  inputFingerprint: string
  incarnationKey: string
}

export interface HostUserInputRecord {
  schemaVersion: 1
  request: UserInputRequest
  binding: HostUserInputBinding
  status: "waiting" | "answered" | "consumed" | "cancelled"
  response: UserInputResponse | null
  reason: string | null
  continuation?: {
    protocol: "host-user-input-interrupt/v1"
    toolCallId: string
    claimed: boolean
    priorToolsSettled: boolean
    requiredContextText?: string
    contextResumeProof?: HostContextResumeProof
    continueIntent?: { remainingSteps: number; deadlineAt: number }
  }
}

function checkRecord(record: HostUserInputRecord): HostUserInputRecord {
  if (
    record.schemaVersion !== 1 ||
    !["waiting", "answered", "consumed", "cancelled"].includes(record.status) ||
    !record.request.requestId ||
    !record.request.threadId ||
    !Number.isSafeInteger(record.binding.expectedVersion) ||
    record.binding.expectedVersion < 1 ||
    !/^[a-f0-9]{64}$/.test(record.binding.pluginDigest) ||
    !/^[a-f0-9]{64}$/.test(record.binding.inputFingerprint) ||
    [
      record.binding.projectId,
      record.binding.operationId,
      record.binding.stageId,
      record.binding.installedPluginId,
      record.binding.incarnationKey
    ].some((value) => typeof value !== "string" || !value || value.length > 4096) ||
    JSON.stringify(record).length > 256 * 1024
  )
    throw Error("HOST_USER_INPUT_RECORD_INVALID")
  requestUserInputSchema.parse({ questions: record.request.questions })
  if (
    record.continuation &&
    (record.continuation.protocol !== "host-user-input-interrupt/v1" ||
      typeof record.continuation.toolCallId !== "string" ||
      !record.continuation.toolCallId ||
      record.continuation.toolCallId.length > 256 ||
      typeof record.continuation.claimed !== "boolean" ||
      typeof record.continuation.priorToolsSettled !== "boolean")
  )
    throw Error("HOST_USER_INPUT_RECORD_INVALID")
  if (
    record.continuation?.requiredContextText !== undefined &&
    (typeof record.continuation.requiredContextText !== "string" ||
      Buffer.byteLength(record.continuation.requiredContextText) > 32_000)
  )
    throw Error("HOST_USER_INPUT_RECORD_INVALID")
  const intent = record.continuation?.continueIntent
  const context = record.continuation?.contextResumeProof
  if (
    context &&
    (context.authority?.protocol !== "devclaw.native-project-context-readonly/v1" ||
      context.authority.policy !== "native-materials-only/v1" ||
      context.authority.threadId !== record.request.threadId ||
      context.authority.operationId !== record.binding.operationId ||
      context.authority.inputIdentity !== record.binding.inputFingerprint ||
      [
        context.authority.workspace,
        context.providerId,
        context.runId,
        context.executionId,
        context.authority.provider?.pluginId,
        context.authority.provider?.plugin,
        context.authority.provider?.actionId
      ].some((value) => typeof value !== "string" || !value || value.length > 4096) ||
      [
        context.definitionDigest,
        context.canonicalContextDigest,
        context.authority.provider?.digest
      ].some((value) => !/^[a-f0-9]{64}$/.test(value)))
  )
    throw Error("HOST_USER_INPUT_CONTEXT_PROOF_INVALID")
  if (
    intent &&
    (!Number.isSafeInteger(intent.remainingSteps) ||
      intent.remainingSteps < 1 ||
      intent.remainingSteps > 64 ||
      !Number.isSafeInteger(intent.deadlineAt) ||
      intent.deadlineAt < 1)
  )
    throw Error("HOST_USER_INPUT_RECORD_INVALID")
  return record
}

function answerIdentity(response: UserInputResponse): string {
  return JSON.stringify({
    ignored: response.ignored === true,
    answers: Object.entries(response.answers).sort(([a], [b]) => a.localeCompare(b))
  })
}

/** A request ledger only. It never changes a Host operation or dispatches an executor. */
export class HostUserInputStore {
  private readonly db: DatabaseSync
  constructor(path: string) {
    if (!isAbsolute(path)) throw Error("HOST_USER_INPUT_PATH_INVALID")
    mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path, { timeout: 1000 })
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS host_user_inputs (
        id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS host_one_waiting_user_input
        ON host_user_inputs(thread_id) WHERE status='waiting';
    `)
  }

  close(): void {
    this.db.close()
  }

  get(id: string): HostUserInputRecord | undefined {
    const row = this.db
      .prepare("SELECT id,thread_id,status,data FROM host_user_inputs WHERE id=?")
      .get(id)
    if (!row) return undefined
    const record = checkRecord(JSON.parse(String(row.data)))
    if (
      record.request.requestId !== row.id ||
      record.request.threadId !== row.thread_id ||
      record.status !== row.status
    )
      throw Error("HOST_USER_INPUT_STORAGE_MISMATCH")
    return record
  }

  pending(threadId: string): HostUserInputRecord | undefined {
    const row = this.db
      .prepare("SELECT id FROM host_user_inputs WHERE thread_id=? AND status='waiting'")
      .get(threadId)
    return row ? this.get(String(row.id)) : undefined
  }

  unconsumedContinuation(operationId: string): HostUserInputRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT id FROM host_user_inputs
      WHERE status IN ('waiting','answered') AND json_extract(data,'$.binding.operationId')=?
      AND json_extract(data,'$.continuation.protocol')='host-user-input-interrupt/v1' LIMIT 1`
      )
      .get(operationId)
    return row ? this.get(String(row.id)) : undefined
  }

  create(
    request: UserInputRequest,
    binding: HostUserInputBinding,
    continuation?: HostUserInputRecord["continuation"]
  ): HostUserInputRecord {
    const record = checkRecord({
      schemaVersion: 1,
      request,
      binding,
      status: "waiting",
      response: null,
      reason: null,
      ...(continuation ? { continuation } : {})
    })
    this.db
      .prepare("INSERT INTO host_user_inputs(id,thread_id,status,data) VALUES (?,?,?,?)")
      .run(request.requestId, request.threadId, record.status, JSON.stringify(record))
    return record
  }

  answer(response: UserInputResponse): HostUserInputRecord {
    return this.transaction(() => {
      const record = this.get(response.requestId)
      if (!record || record.status === "cancelled") throw Error("HOST_USER_INPUT_REQUEST_EXPIRED")
      if (record.response) {
        if (answerIdentity(record.response) !== answerIdentity(response))
          throw Error("HOST_USER_INPUT_ANSWER_CONFLICT")
        return record
      }
      record.response = structuredClone(response)
      record.status = "answered"
      return this.save(record)
    })
  }

  consume(id: string): void {
    this.transaction(() => {
      const record = this.get(id)
      if (!record || record.status !== "answered") throw Error("HOST_USER_INPUT_NOT_ANSWERED")
      record.status = "consumed"
      this.save(record)
    })
  }

  claimContinuation(id: string): HostUserInputRecord {
    return this.transaction(() => {
      const record = this.get(id)
      if (
        !record?.continuation?.priorToolsSettled ||
        record.continuation.claimed ||
        record.status !== "answered"
      )
        throw Error("HOST_USER_INPUT_CONTINUATION_UNAVAILABLE")
      record.continuation.claimed = true
      return this.save(record)
    })
  }

  disqualifyContinuation(operationId: string): void {
    this.transaction(() => {
      const record = this.unconsumedContinuation(operationId)
      if (!record?.continuation || record.continuation.claimed) return
      record.continuation.priorToolsSettled = false
      record.reason = "HOST_INPUT_UNPROVED_EXTERNAL_LIFETIME"
      this.save(record)
    })
  }

  cancel(id: string, reason: string): void {
    this.transaction(() => {
      const record = this.get(id)
      if (!record || record.status !== "waiting") return
      record.status = "cancelled"
      record.reason = reason.slice(0, 2048)
      this.save(record)
    })
  }

  private save(record: HostUserInputRecord): HostUserInputRecord {
    checkRecord(record)
    this.db
      .prepare("UPDATE host_user_inputs SET status=?,data=? WHERE id=?")
      .run(record.status, JSON.stringify(record), record.request.requestId)
    return record
  }

  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE")
    try {
      const result = work()
      this.db.exec("COMMIT")
      return result
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    }
  }
}
