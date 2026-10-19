import { createHash, randomUUID } from "node:crypto"
import type { AuthoringAtomicSettings } from "./authoring-config-snapshot"
import type { CreatorTraceUsage } from "./creator-model-accounting"

export const CREATOR_REQUEST_LIMITS = Object.freeze({
  operations: 32,
  candidates: 3,
  durationMs: 10 * 60_000,
  modelAttempts: 64,
  retainedRequests: 16
})
export interface CreatorRequestObservation {
  runId: string
  startedAt: number
  operations: number
  candidates: number
  groupId?: string
  nativeRuns?: string[]
  /** Missing on historical rows: earlier model usage is unknown, never a measured zero. */
  model?: CreatorModelObservation
}
export interface CreatorModelObservation {
  limit: number
  historicalUsageUnknown: boolean
  attempts: Array<{
    id: string
    traceId?: string
    state: "pending" | "reported" | "unknown"
    inputTokens?: number
    outputTokens?: number
    traceUsage?: Omit<CreatorTraceUsage, "traceId">
  }>
  /** No trustworthy price source exists in the original model registry. */
  cost: { state: "unavailable"; reason: "pricing-unavailable" }
  hardMoneyLimit?: { amount: number; currency: string }
}
const absent = "\0creator-request-absent"
// 16 requests × 64 genuine attempts × maximum 256-character trace references fit this bound.
const MAX_CREATOR_BUDGET_BYTES = 1024 * 1024
function validMoneyLimit(
  value: unknown
): value is NonNullable<CreatorModelObservation["hardMoneyLimit"]> {
  if (!value || typeof value !== "object") return false
  const row = value as Record<string, unknown>
  return (
    Object.keys(row).every((key) => ["amount", "currency"].includes(key)) &&
    typeof row.amount === "number" &&
    Number.isFinite(row.amount) &&
    row.amount >= 0 &&
    typeof row.currency === "string" &&
    /^[A-Z]{3}$/.test(row.currency)
  )
}
function validModelObservation(value: unknown): value is CreatorModelObservation {
  if (!value || typeof value !== "object") return false
  const row = value as CreatorModelObservation
  return (
    Object.keys(row).every((key) =>
      ["limit", "historicalUsageUnknown", "attempts", "cost", "hardMoneyLimit"].includes(key)
    ) &&
    Number.isSafeInteger(row.limit) &&
    row.limit > 0 &&
    row.limit <= CREATOR_REQUEST_LIMITS.modelAttempts &&
    typeof row.historicalUsageUnknown === "boolean" &&
    row.cost?.state === "unavailable" &&
    row.cost.reason === "pricing-unavailable" &&
    Object.keys(row.cost).length === 2 &&
    (row.hardMoneyLimit === undefined || validMoneyLimit(row.hardMoneyLimit)) &&
    Array.isArray(row.attempts) &&
    row.attempts.length <= row.limit &&
    new Set(row.attempts.map((attempt) => attempt?.id)).size === row.attempts.length &&
    row.attempts.every(
      (attempt) =>
        attempt &&
        Object.keys(attempt).every((key) =>
          ["id", "traceId", "state", "inputTokens", "outputTokens", "traceUsage"].includes(key)
        ) &&
        typeof attempt.id === "string" &&
        attempt.id.length > 0 &&
        attempt.id.length <= 160 &&
        (attempt.traceId === undefined ||
          (typeof attempt.traceId === "string" &&
            attempt.traceId.length > 0 &&
            attempt.traceId.length <= 256)) &&
        ["pending", "reported", "unknown"].includes(attempt.state) &&
        (attempt.traceUsage === undefined ||
          (attempt.traceId !== undefined && validTraceUsage(attempt.traceUsage))) &&
        (attempt.state === "reported"
          ? [attempt.inputTokens, attempt.outputTokens].every(
              (value) => Number.isSafeInteger(value) && value! >= 0
            )
          : attempt.inputTokens === undefined && attempt.outputTokens === undefined)
    )
  )
}
function validTraceUsage(usage: Omit<CreatorTraceUsage, "traceId">): boolean {
  const fields = ["modelCalls", "toolCalls", "inputTokens", "outputTokens", "usageReportedCalls"]
  return (
    !!usage &&
    typeof usage === "object" &&
    Object.keys(usage).length === fields.length &&
    Object.entries(usage).every(
      ([key, value]) => fields.includes(key) && Number.isSafeInteger(value) && value >= 0
    ) &&
    usage.usageReportedCalls <= usage.modelCalls
  )
}

export function creatorModelSummary(model: CreatorModelObservation | undefined) {
  const reported = model?.attempts.filter((attempt) => attempt.state === "reported") ?? []
  const traces = new Map(
    model?.attempts.flatMap((attempt) =>
      attempt.traceId && attempt.traceUsage ? [[attempt.traceId, attempt.traceUsage] as const] : []
    ) ?? []
  )
  const traceValues = [...traces.values()]
  return {
    attemptLimit: model?.limit ?? CREATOR_REQUEST_LIMITS.modelAttempts,
    attempts: model?.attempts.length ?? 0,
    usageReportedAttempts: reported.length,
    usageUnknownAttempts:
      model?.attempts.filter((attempt) => attempt.state === "unknown").length ?? 0,
    usagePendingAttempts:
      model?.attempts.filter((attempt) => attempt.state === "pending").length ?? 0,
    historicalUsageUnknown: model?.historicalUsageUnknown ?? true,
    coverage:
      !model || model.historicalUsageUnknown || reported.length !== model.attempts.length
        ? ("partial" as const)
        : ("complete" as const),
    // Absence of a reported value remains unknown; a real provider-reported zero is retained.
    ...(reported.length
      ? {
          inputTokens: reported.reduce((sum, attempt) => sum + attempt.inputTokens!, 0),
          outputTokens: reported.reduce((sum, attempt) => sum + attempt.outputTokens!, 0)
        }
      : {}),
    traceIds: [
      ...new Set(
        model?.attempts.flatMap((attempt) => (attempt.traceId ? [attempt.traceId] : [])) ?? []
      )
    ],
    traceCoverage:
      model &&
      !model.historicalUsageUnknown &&
      model.attempts.every((attempt) => attempt.traceId && traces.has(attempt.traceId))
        ? ("complete" as const)
        : ("partial" as const),
    ...(traceValues.length
      ? {
          recordedModelCalls: traceValues.reduce((sum, usage) => sum + usage.modelCalls, 0),
          recordedToolCalls: traceValues.reduce((sum, usage) => sum + usage.toolCalls, 0),
          recordedUsageReportedCalls: traceValues.reduce(
            (sum, usage) => sum + usage.usageReportedCalls,
            0
          )
        }
      : {}),
    cost: { state: "unavailable" as const, reason: "pricing-unavailable" as const },
    ...(model?.hardMoneyLimit ? { hardMoneyLimit: model.hardMoneyLimit } : {})
  }
}

/** Accounting only: a persisted request never restores a lease, approval or permission. */
export class CreatorRequestBudgets {
  private readonly memory = new Map<string, string>()
  constructor(
    private readonly settings?: AuthoringAtomicSettings,
    private readonly now: () => number = Date.now
  ) {}

  private key(scope: string) {
    return "creator-request-budget:" + createHash("sha256").update(scope).digest("hex")
  }

  private read(key: string) {
    const raw = this.settings?.getSetting(key, absent) ?? this.memory.get(key) ?? absent
    if (raw === absent) return { raw, rows: [] as CreatorRequestObservation[] }
    if (Buffer.byteLength(raw) > MAX_CREATOR_BUDGET_BYTES)
      throw Error("DEVELOPMENT_BUDGET_UNCONFIRMED")
    let rows: CreatorRequestObservation[]
    try {
      rows = JSON.parse(raw)
    } catch {
      throw Error("DEVELOPMENT_BUDGET_UNCONFIRMED")
    }
    if (
      !Array.isArray(rows) ||
      rows.length > CREATOR_REQUEST_LIMITS.retainedRequests ||
      rows.some(
        (row) =>
          !row ||
          typeof row.runId !== "string" ||
          !row.runId ||
          row.runId.length > 160 ||
          Object.keys(row).some(
            (key) =>
              ![
                "runId",
                "startedAt",
                "operations",
                "candidates",
                "groupId",
                "nativeRuns",
                "model"
              ].includes(key)
          ) ||
          (row.groupId !== undefined &&
            (typeof row.groupId !== "string" || !row.groupId || row.groupId.length > 160)) ||
          (row.nativeRuns !== undefined &&
            (!Array.isArray(row.nativeRuns) ||
              row.nativeRuns.length > CREATOR_REQUEST_LIMITS.operations ||
              row.nativeRuns.some((id) => typeof id !== "string" || !id || id.length > 160) ||
              new Set(row.nativeRuns).size !== row.nativeRuns.length)) ||
          (row.model !== undefined && !validModelObservation(row.model)) ||
          !Number.isSafeInteger(row.startedAt) ||
          row.startedAt < 0 ||
          !Number.isSafeInteger(row.operations) ||
          row.operations < 0 ||
          row.operations > CREATOR_REQUEST_LIMITS.operations ||
          !Number.isSafeInteger(row.candidates) ||
          row.candidates < 0 ||
          row.candidates > CREATOR_REQUEST_LIMITS.candidates
      ) ||
      new Set(rows.map((row) => row.runId)).size !== rows.length
    )
      throw Error("DEVELOPMENT_BUDGET_UNCONFIRMED")
    return { raw, rows }
  }

  latest(scope: string): CreatorRequestObservation | undefined {
    const latest = this.read(this.key(scope)).rows.at(-1)
    return latest ? structuredClone(latest) : undefined
  }
  modelReference(scope: string, nativeRunId: string): string | undefined {
    const row = this.read(this.key(scope)).rows.find(
      (row) => row.runId === nativeRunId || row.nativeRuns?.includes(nativeRunId)
    )
    return row?.model ? row.runId : undefined
  }

  /** Birth binds accounting only. It performs no provider request and consumes no attempt. */
  bindModel(
    scope: string,
    runId: string,
    groupId?: string,
    policy: {
      modelAttemptLimit?: number
      hardMoneyLimit?: CreatorModelObservation["hardMoneyLimit"]
    } = {}
  ) {
    if (
      !runId ||
      runId.length > 160 ||
      (groupId !== undefined && (!groupId || groupId.length > 160))
    )
      throw Error("DEVELOPMENT_MODEL_ACCOUNTING_SCOPE")
    const key = this.key(scope)
    const { raw, rows } = this.read(key)
    const existing =
      rows.find((row) => row.runId === runId || row.nativeRuns?.includes(runId)) ??
      (groupId ? rows.find((row) => row.groupId === groupId) : undefined)
    const limit = policy.modelAttemptLimit ?? CREATOR_REQUEST_LIMITS.modelAttempts
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > CREATOR_REQUEST_LIMITS.modelAttempts ||
      (policy.hardMoneyLimit !== undefined && !validMoneyLimit(policy.hardMoneyLimit))
    )
      throw Error("DEVELOPMENT_BUDGET_UNCONFIRMED")
    const row: CreatorRequestObservation = existing ?? {
      runId,
      startedAt: this.now(),
      operations: 0,
      candidates: 0,
      ...(groupId ? { groupId, nativeRuns: [] } : {})
    }
    const next = {
      ...row,
      model: row.model ?? {
        limit,
        attempts: [],
        historicalUsageUnknown: !!existing,
        cost: { state: "unavailable" as const, reason: "pricing-unavailable" as const },
        ...(policy.hardMoneyLimit ? { hardMoneyLimit: policy.hardMoneyLimit } : {})
      }
    }
    if (
      row.model &&
      ((policy.modelAttemptLimit !== undefined && policy.modelAttemptLimit !== row.model.limit) ||
        (policy.hardMoneyLimit !== undefined &&
          JSON.stringify(policy.hardMoneyLimit) !== JSON.stringify(row.model.hardMoneyLimit)))
    )
      throw Error("DEVELOPMENT_BUDGET_UNCONFIRMED")
    // Keep the original request/goal association after goal completion or replacement.
    if (next.nativeRuns && !next.nativeRuns.includes(runId)) {
      if (next.nativeRuns.length >= CREATOR_REQUEST_LIMITS.operations)
        throw Error("DEVELOPMENT_TURN_BUDGET")
      next.nativeRuns = [...next.nativeRuns, runId]
    }
    this.write(
      key,
      raw,
      [...rows.filter((row) => row !== existing), next].slice(
        -CREATOR_REQUEST_LIMITS.retainedRequests
      )
    )
    return { runId: next.runId, groupId: next.groupId }
  }

  claimModel(scope: string, boundRunId: string, traceId?: string) {
    const key = this.key(scope),
      { raw, rows } = this.read(key)
    const row = rows.find((row) => row.runId === boundRunId)
    if (!row?.model || (traceId !== undefined && (!traceId || traceId.length > 256)))
      throw Error("DEVELOPMENT_MODEL_ACCOUNTING_SCOPE")
    if (
      this.now() < row.startedAt ||
      this.now() - row.startedAt >= CREATOR_REQUEST_LIMITS.durationMs
    )
      throw Error("DEVELOPMENT_TURN_BUDGET")
    if (row.model.hardMoneyLimit) throw Error("DEVELOPMENT_MODEL_COST_UNSUPPORTED")
    if (row.model.historicalUsageUnknown) throw Error("DEVELOPMENT_MODEL_HISTORY_UNCONFIRMED")
    if (row.model.attempts.length >= row.model.limit)
      throw Error("DEVELOPMENT_MODEL_ATTEMPT_BUDGET")
    const id = randomUUID()
    row.model.attempts.push({ id, state: "pending", ...(traceId ? { traceId } : {}) })
    this.write(key, raw, rows)
    return id
  }

  settleModel(
    scope: string,
    boundRunId: string,
    attemptId: string,
    usage?: { inputTokens?: number; outputTokens?: number }
  ): void {
    const key = this.key(scope),
      { raw, rows } = this.read(key)
    const attempt = rows
      .find((row) => row.runId === boundRunId)
      ?.model?.attempts.find((item) => item.id === attemptId)
    if (!attempt) throw Error("DEVELOPMENT_MODEL_ACCOUNTING_SCOPE")
    const reported = [usage?.inputTokens, usage?.outputTokens].every(
      (value) => Number.isSafeInteger(value) && value! >= 0
    )
    const state = reported ? "reported" : "unknown"
    if (attempt.state !== "pending") {
      if (
        attempt.state === state &&
        (!reported ||
          (attempt.inputTokens === usage?.inputTokens &&
            attempt.outputTokens === usage?.outputTokens))
      )
        return
      // Later malformed/truncated bytes invalidate an earlier provisional usage, never restore it.
      if (attempt.state === "unknown" || state === "reported")
        throw Error("DEVELOPMENT_BUDGET_UNCONFIRMED")
    }
    attempt.state = state
    delete attempt.inputTokens
    delete attempt.outputTokens
    if (reported)
      Object.assign(attempt, { inputTokens: usage!.inputTokens, outputTokens: usage!.outputTokens })
    this.write(key, raw, rows)
  }

  recordModelTrace(scope: string, boundRunId: string, snapshot: CreatorTraceUsage): void {
    const { traceId, ...usage } = snapshot
    if (!validTraceUsage(usage)) throw Error("DEVELOPMENT_BUDGET_UNCONFIRMED")
    const key = this.key(scope),
      { raw, rows } = this.read(key)
    const attempt = rows
      .find((row) => row.runId === boundRunId)
      ?.model?.attempts.find((item) => item.traceId === traceId)
    // The collector may publish its initial zero before any provider request has occurred.
    if (!attempt) return
    const previous = attempt.traceUsage
    if (
      previous &&
      Object.entries(previous).some(([key, value]) => usage[key as keyof typeof usage] < value)
    )
      throw Error("DEVELOPMENT_BUDGET_UNCONFIRMED")
    if (JSON.stringify(previous) === JSON.stringify(usage)) return
    attempt.traceUsage = usage
    this.write(key, raw, rows)
  }

  private write(key: string, raw: string, rows: CreatorRequestObservation[]): void {
    const value = JSON.stringify(rows)
    if (Buffer.byteLength(value) > MAX_CREATOR_BUDGET_BYTES)
      throw Error("DEVELOPMENT_BUDGET_UNCONFIRMED")
    if (this.settings) {
      if (!this.settings.compareAndSetSetting(key, raw === absent ? undefined : raw, value))
        throw Error("DEVELOPMENT_BUDGET_UNCONFIRMED")
    } else {
      if (!this.memory.has(key) && this.memory.size >= 32)
        throw Error("DEVELOPMENT_BUDGET_UNCONFIRMED")
      this.memory.set(key, value)
    }
  }

  claim(
    scope: string,
    runId: string,
    kind: "operation" | "candidate",
    groupId?: string
  ): CreatorRequestObservation {
    if (!runId || runId.length > 160) throw Error("DEVELOPMENT_TURN_CHANGED")
    if (groupId !== undefined && (!groupId || groupId.length > 160))
      throw Error("DEVELOPMENT_BUDGET_UNCONFIRMED")
    const key = this.key(scope),
      { raw, rows } = this.read(key),
      now = this.now()
    // The first host-owned association wins even if a goal ends during this native turn.
    const existing =
      rows.find((row) => row.runId === runId || row.nativeRuns?.includes(runId)) ??
      (groupId ? rows.find((row) => row.groupId === groupId) : undefined)
    const record = existing ?? {
      runId,
      startedAt: now,
      operations: 0,
      candidates: 0,
      ...(groupId ? { groupId, nativeRuns: [] as string[] } : {})
    }
    if (now < record.startedAt || now - record.startedAt >= CREATOR_REQUEST_LIMITS.durationMs)
      throw Error("DEVELOPMENT_TURN_BUDGET")
    if (kind === "operation" && record.operations >= CREATOR_REQUEST_LIMITS.operations)
      throw Error("DEVELOPMENT_TURN_BUDGET")
    if (kind === "candidate" && record.candidates >= CREATOR_REQUEST_LIMITS.candidates)
      throw Error("DEVELOPMENT_REPAIR_BUDGET")
    if (
      record.nativeRuns &&
      !record.nativeRuns.includes(runId) &&
      record.nativeRuns.length >= CREATOR_REQUEST_LIMITS.operations
    )
      throw Error("DEVELOPMENT_TURN_BUDGET")
    const next = {
      ...record,
      ...(record.groupId
        ? { nativeRuns: [...new Set([...(record.nativeRuns ?? []), runId])] }
        : {}),
      operations: record.operations + Number(kind === "operation"),
      candidates: record.candidates + Number(kind === "candidate")
    }
    const value = JSON.stringify(
      [...rows.filter((row) => row !== existing), next].slice(
        -CREATOR_REQUEST_LIMITS.retainedRequests
      )
    )
    if (Buffer.byteLength(value) > MAX_CREATOR_BUDGET_BYTES)
      throw Error("DEVELOPMENT_BUDGET_UNCONFIRMED")
    if (this.settings) {
      if (!this.settings.compareAndSetSetting(key, raw === absent ? undefined : raw, value))
        throw Error("DEVELOPMENT_BUDGET_UNCONFIRMED")
    } else {
      // Production uses durable settings; the fallback is bounded for isolated service hosts.
      if (!this.memory.has(key) && this.memory.size >= 32)
        throw Error("DEVELOPMENT_BUDGET_UNCONFIRMED")
      this.memory.set(key, value)
    }
    return next
  }
}
