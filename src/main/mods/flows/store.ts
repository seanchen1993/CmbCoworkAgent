import { createHash } from "node:crypto"
import { parseFlowDefinition } from "../../../shared/mods/flows/schema"
import type { FlowRun, SavedFlow } from "../../../shared/mods/flows/types"
import type { FlowPersistence } from "./contracts"
import {
  planFlowRecoveryReservation,
  planRecoveryHistoryRetention,
  type FlowRecoveryCandidate,
  type RecoveryHistoryRun
} from "./recovery-history"

export interface FlowSettingsStore {
  getSetting(key: string, fallback?: string): string
  setSetting(key: string, value: string): void
  /** Atomic replace, or insert only if absent when expected is undefined; false means conflict. */
  compareAndSetSetting?(key: string, expected: string | undefined, value: string): boolean
}
export function flowDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}
export class FlowStore implements FlowPersistence {
  constructor(private readonly settings: FlowSettingsStore) {}
  private key(kind: string, ...parts: string[]): string {
    return JSON.stringify(["diy-flow-v1", kind, ...parts])
  }
  list(workspace: string): SavedFlow[] {
    const rows: SavedFlow[] = JSON.parse(
      this.settings.getSetting(this.key("definitions", workspace), "[]")
    )
    if (!Array.isArray(rows) || rows.length > 32) throw Error("FLOW_STORAGE_INVALID")
    return rows.map((row) => {
      const definition = parseFlowDefinition(row.definition)
      if (
        flowDigest(definition) !== row.digest ||
        !Number.isSafeInteger(row.revision) ||
        row.revision < 1
      )
        throw Error("FLOW_STORAGE_INVALID")
      return { ...row, definition }
    })
  }
  get(workspace: string, id: string): SavedFlow | undefined {
    return this.list(workspace).find((row) => row.definition.id === id)
  }
  save(workspace: string, input: unknown, expectedRevision: number): SavedFlow {
    const definition = parseFlowDefinition(input)
    const rows = this.list(workspace)
    const prior = rows.find((row) => row.definition.id === definition.id)
    if ((prior?.revision ?? 0) !== expectedRevision) throw Error("FLOW_REVISION_CHANGED")
    if (!prior && rows.length >= 32) throw Error("FLOW_DEFINITION_LIMIT")
    const saved = {
      definition,
      revision: expectedRevision + 1,
      digest: flowDigest(definition),
      updatedAt: Date.now()
    }
    const next = [...rows.filter((row) => row.definition.id !== definition.id), saved]
    this.settings.setSetting(this.key("definitions", workspace), JSON.stringify(next))
    return structuredClone(saved)
  }
  runs(workspace: string, threadId: string): FlowRun[] {
    const rows: FlowRun[] = JSON.parse(
      this.settings.getSetting(this.key("runs", workspace, threadId), "[]")
    )
    if (!Array.isArray(rows) || rows.length > 20) throw Error("FLOW_RUN_STORAGE_INVALID")
    for (const row of rows) {
      if (
        row.workspace !== workspace ||
        row.threadId !== threadId ||
        !Array.isArray(row.attempts) ||
        row.attempts.length > 512
      )
        throw Error("FLOW_RUN_STORAGE_INVALID")
    }
    return rows
  }
  run(workspace: string, threadId: string, id: string): FlowRun | undefined {
    return this.runs(workspace, threadId).find((row) => row.id === id)
  }
  /** Host-only. Evidence, authority and the prior owner's lease must be fenced by the caller. */
  reserveRecovery(
    workspace: string,
    threadId: string,
    candidate: FlowRecoveryCandidate,
    input: { childRunId: string; now: number; assertCurrent(): void }
  ): RecoveryHistoryRun {
    if (!this.settings.compareAndSetSetting) throw Error("FLOW_RECOVERY_ATOMIC_STORE_REQUIRED")
    input.assertCurrent()
    const key = this.key("runs", workspace, threadId)
    const raw = this.settings.getSetting(key, "[]")
    const rows: RecoveryHistoryRun[] = JSON.parse(raw)
    if (
      !Array.isArray(rows) ||
      rows.length > 20 ||
      rows.some((row) => !row || row.workspace !== workspace || row.threadId !== threadId)
    )
      throw Error("FLOW_RUN_STORAGE_INVALID")
    const planned = planFlowRecoveryReservation(rows, candidate, input)
    const encoded = JSON.stringify(planned.rows)
    input.assertCurrent()
    if (!this.settings.compareAndSetSetting(key, raw, encoded)) throw Error("FLOW_RECOVERY_STALE")
    // No callback after commit: even an interrupted reply leaves a discoverable consumed source.
    return structuredClone(planned.child)
  }

  put(run: FlowRun): void {
    const key = this.key("runs", run.workspace, run.threadId)
    const raw = this.settings.getSetting(key, "")
    const existing: RecoveryHistoryRun[] = JSON.parse(raw || "[]")
    if (
      !Array.isArray(existing) ||
      existing.length > 20 ||
      existing.some(
        (row) =>
          !row ||
          row.workspace !== run.workspace ||
          row.threadId !== run.threadId ||
          !Array.isArray(row.attempts) ||
          row.attempts.length > 512
      )
    )
      throw Error("FLOW_RUN_STORAGE_INVALID")
    const prior = existing.find((row) => row.id === run.id)
    if (prior?.recovery?.consumedBy) {
      if (flowDigest(prior) === flowDigest(run)) return
      throw Error("FLOW_RECOVERY_SOURCE_CONSUMED")
    }
    if (prior?.recovery && !(run as RecoveryHistoryRun).recovery)
      throw Error("FLOW_RECOVERY_LINEAGE_INVALID")
    const rows = existing.filter((row) => row.id !== run.id)
    const complete = [run, ...rows] as RecoveryHistoryRun[]
    if (
      complete.some((row) => row.recovery || row.attempts.some((attempt) => attempt.reusedFrom))
    ) {
      const retained = planRecoveryHistoryRetention(complete, [run.id])
      if (!this.settings.compareAndSetSetting) throw Error("FLOW_RECOVERY_ATOMIC_STORE_REQUIRED")
      if (!this.settings.compareAndSetSetting(key, raw, JSON.stringify(retained)))
        throw Error("FLOW_RECOVERY_STALE")
      return
    }
    const next = complete.slice(0, 20)
    let encoded = JSON.stringify(next)
    while (Buffer.byteLength(encoded) > 4 * 1024 * 1024 && next.length > 1) {
      next.pop()
      encoded = JSON.stringify(next)
    }
    if (Buffer.byteLength(encoded) > 4 * 1024 * 1024) throw Error("FLOW_HISTORY_LIMIT")
    // A recovery may commit after our read even if that read had no lineage yet.
    // Never let an ordinary update overwrite its newly consumed source and child.
    if (this.settings.compareAndSetSetting) {
      if (!this.settings.compareAndSetSetting(key, raw || undefined, encoded))
        throw Error("FLOW_RECOVERY_STALE")
      return
    }
    this.settings.setSetting(key, encoded)
  }
}
