import { randomUUID } from "node:crypto"
import type { SavedFlow } from "../../../shared/mods/flows/types"
import type { EvaluationTask, EvaluationView } from "../../../shared/mods/evaluation-api"
import type { HarnessEvaluationCase } from "../../../shared/mods/evaluation"
import { flowDigest } from "../flows/store"
import { parseFlowDefinition } from "../../../shared/mods/flows/schema"

export interface EvaluationObservation {
  fact: HarnessEvaluationCase
  environmentDigest: string | null
  modelFingerprint: string | null
  reasons: string[]
}
export interface EvaluationRecord {
  schemaVersion: 1
  id: string
  workspace: string
  threadId: string
  revision: number
  createdAt: number
  state: EvaluationView["state"]
  provider: "real" | "controlled"
  tasks: EvaluationTask[]
  budget: EvaluationView["budget"]
  baseline: SavedFlow
  candidate: SavedFlow
  results: { baseline: EvaluationObservation[]; candidate: EvaluationObservation[] }
  /** Durable start marker precedes every Flow launch; a crash never auto-replays it. */
  pending?: { variant: "baseline" | "candidate"; caseId: string; runId?: string }
  reasons: string[]
}
interface Settings {
  getSetting(key: string, fallback?: string): string
  compareAndSetSetting?(key: string, expected: string | undefined, value: string): boolean
}
const MAX_BYTES = 2 * 1024 * 1024
const MAX_ROWS = 16
const publicReasons = new Set([
  "missing-or-invalid-runtime-receipt",
  "environment-not-completely-observed",
  "missing-or-invalid-native-check",
  "execution-or-publication-not-confirmed"
])
const reasonsValid = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length <= 16 &&
  value.every((reason) => typeof reason === "string" && publicReasons.has(reason))
const clone = <T>(value: T): T => structuredClone(value)
const finite = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0
export class EvaluationCreateNotPersisted extends Error {
  constructor(error: unknown) {
    super(error instanceof Error ? error.message : "EVALUATION_INVALID", { cause: error })
  }
}
export class EvaluationStore {
  constructor(private readonly settings: Settings) {}
  private key(workspace: string, threadId: string) {
    return JSON.stringify(["mods-evaluation-v1", workspace, threadId])
  }
  private decode(raw: string, workspace: string, threadId: string): EvaluationRecord[] {
    if (Buffer.byteLength(raw) > MAX_BYTES) throw Error("EVALUATION_LIMIT")
    const rows = JSON.parse(raw || "[]") as EvaluationRecord[]
    if (!Array.isArray(rows)) throw Error("EVALUATION_INVALID")
    if (rows.length > MAX_ROWS) throw Error("EVALUATION_LIMIT")
    const ids = new Set<string>()
    for (const row of rows) {
      if (
        !row ||
        row.schemaVersion !== 1 ||
        row.workspace !== workspace ||
        row.threadId !== threadId ||
        typeof row.id !== "string" ||
        !/^[a-f0-9-]{36}$/.test(row.id) ||
        ids.has(row.id) ||
        !finite(row.revision) ||
        row.revision < 1 ||
        !finite(row.createdAt) ||
        !["running", "complete", "cancelled", "interrupted"].includes(row.state) ||
        !["real", "controlled"].includes(row.provider) ||
        !Array.isArray(row.tasks) ||
        row.tasks.length < 1 ||
        row.tasks.length > 5 ||
        !row.results ||
        !Array.isArray(row.results.baseline) ||
        !Array.isArray(row.results.candidate) ||
        row.results.baseline.length > row.tasks.length ||
        row.results.candidate.length > row.tasks.length ||
        !row.budget ||
        !finite(row.budget.timeoutMs) ||
        !finite(row.budget.maxExecutions) ||
        !reasonsValid(row.reasons)
      )
        throw Error("EVALUATION_INVALID")
      ids.add(row.id)
      const cases = new Set<string>()
      for (const task of row.tasks) {
        if (
          !task ||
          typeof task.id !== "string" ||
          !/^[A-Za-z0-9_-]{1,60}$/.test(task.id) ||
          cases.has(task.id) ||
          typeof task.goal !== "string" ||
          !task.goal.trim() ||
          task.goal.length > 4000
        )
          throw Error("EVALUATION_INVALID")
        cases.add(task.id)
      }
      for (const flow of [row.baseline, row.candidate]) {
        if (
          !flow ||
          !finite(flow.revision) ||
          flow.revision < 1 ||
          flowDigest(parseFlowDefinition(flow.definition)) !== flow.digest
        )
          throw Error("EVALUATION_INVALID")
      }
      for (const variant of ["baseline", "candidate"] as const) {
        const seen = new Set<string>()
        for (const value of row.results[variant]) {
          const fact = value?.fact
          if (
            !fact ||
            !cases.has(fact.caseId) ||
            seen.has(fact.caseId) ||
            !/^[A-Za-z0-9_-]{1,100}$/.test(fact.runId) ||
            !["passed", "failed", "unknown", "cancelled"].includes(fact.result) ||
            !Array.isArray(fact.evidenceIds) ||
            fact.evidenceIds.length > 32 ||
            fact.evidenceIds.some(
              (id) => typeof id !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(id)
            ) ||
            (fact.result === "passed" && !fact.evidenceIds.length) ||
            [
              fact.modelCalls,
              fact.durationMs,
              fact.inputTokens,
              fact.outputTokens,
              fact.humanTakeovers
            ].some((n) => n !== null && (!finite(n) || n > 1_000_000_000)) ||
            [value.environmentDigest, value.modelFingerprint].some(
              (digest) =>
                digest !== null && (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest))
            ) ||
            !reasonsValid(value.reasons)
          )
            throw Error("EVALUATION_INVALID")
          seen.add(fact.caseId)
        }
      }
      if (
        row.pending &&
        (!cases.has(row.pending.caseId) ||
          !["baseline", "candidate"].includes(row.pending.variant) ||
          (row.pending.runId !== undefined && !/^flow_[a-f0-9-]{36}$/.test(row.pending.runId)))
      )
        throw Error("EVALUATION_INVALID")
    }
    return rows
  }
  list(workspace: string, threadId: string) {
    return clone(
      this.decode(this.settings.getSetting(this.key(workspace, threadId), ""), workspace, threadId)
    )
  }
  discard(workspace: string, threadId: string, id: string, expectedDigest: string): void {
    const key = this.key(workspace, threadId)
    const raw = this.settings.getSetting(key, "")
    const rows = this.decode(raw, workspace, threadId)
    const row = rows.find(value => value.id === id)
    if (!row || flowDigest(row) !== expectedDigest) throw Error("EVALUATION_STALE")
    if (row.pending || !["complete", "cancelled"].includes(row.state)) throw Error("EVALUATION_BUSY")
    if (!this.settings.compareAndSetSetting?.(key, raw, JSON.stringify(rows.filter(value => value.id !== id))))
      throw Error("EVALUATION_STALE")
  }
  put(record: EvaluationRecord, expectedRevision: number, beforePersist?: () => void) {
    const detached = clone(record)
    const key = this.key(detached.workspace, detached.threadId)
    const raw = this.settings.getSetting(key, "")
    const rows = this.decode(raw, detached.workspace, detached.threadId)
    const prior = rows.find((row) => row.id === detached.id)
    if ((prior?.revision ?? 0) !== expectedRevision || detached.revision !== expectedRevision + 1)
      throw Error("EVALUATION_STALE")
    if (
      prior &&
      flowDigest([
        prior.baseline,
        prior.candidate,
        prior.tasks,
        prior.budget,
        prior.provider,
        prior.createdAt
      ]) !==
        flowDigest([
          detached.baseline,
          detached.candidate,
          detached.tasks,
          detached.budget,
          detached.provider,
          detached.createdAt
        ])
    )
      throw Error("EVALUATION_INVALID")
    if (prior && prior.state !== "running") throw Error("EVALUATION_STALE")
    const next = [...rows.filter((row) => row.id !== detached.id), detached]
    const encoded = JSON.stringify(next)
    this.decode(encoded, detached.workspace, detached.threadId)
    beforePersist?.()
    if (
      !this.settings.compareAndSetSetting ||
      !this.settings.compareAndSetSetting(key, raw || undefined, encoded)
    )
      throw Error("EVALUATION_STALE")
    return clone(detached)
  }
  create(
    input: Omit<
      EvaluationRecord,
      "id" | "schemaVersion" | "revision" | "createdAt" | "state" | "results" | "reasons"
    >
  ) {
    let persistenceAttempted = false
    try {
      return this.put(
        {
          ...clone(input),
          id: randomUUID(),
          schemaVersion: 1,
          revision: 1,
          createdAt: Date.now(),
          state: "running",
          results: { baseline: [], candidate: [] },
          reasons: []
        },
        0,
        () => { persistenceAttempted = true }
      )
    } catch (error) {
      if (!persistenceAttempted) throw new EvaluationCreateNotPersisted(error)
      throw error
    }
  }
}
