import { createHash } from "node:crypto"
import type { AuthoringAtomicSettings } from "./authoring-config-snapshot"

export const CREATOR_REQUEST_LIMITS = Object.freeze({
  operations: 32,
  candidates: 3,
  durationMs: 10 * 60_000,
  retainedRequests: 16
})
export interface CreatorRequestObservation {
  runId: string
  startedAt: number
  operations: number
  candidates: number
  groupId?: string
  nativeRuns?: string[]
}
const absent = "\0creator-request-absent"

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
    if (Buffer.byteLength(raw) > 128 * 1024) throw Error("DEVELOPMENT_BUDGET_UNCONFIRMED")
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
              !["runId", "startedAt", "operations", "candidates", "groupId", "nativeRuns"].includes(
                key
              )
          ) ||
          (row.groupId !== undefined &&
            (typeof row.groupId !== "string" || !row.groupId || row.groupId.length > 160)) ||
          (row.nativeRuns !== undefined &&
            (!Array.isArray(row.nativeRuns) ||
              row.nativeRuns.length > CREATOR_REQUEST_LIMITS.operations ||
              row.nativeRuns.some((id) => typeof id !== "string" || !id || id.length > 160) ||
              new Set(row.nativeRuns).size !== row.nativeRuns.length)) ||
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
    if (Buffer.byteLength(value) > 128 * 1024) throw Error("DEVELOPMENT_BUDGET_UNCONFIRMED")
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
