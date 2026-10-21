import { createHash, randomUUID } from "node:crypto"
import type { AuthoringAtomicSettings } from "../mods/devtools/authoring-config-snapshot"
import type { RuntimePluginSourceBinding } from "../plugins/runtime-source-scope"
import type { HookConfig } from "./types"

export interface StageRecoveryHookIdentity {
  projectId: string
  operationId: string
  threadId: string
  baselineId: string
  packageDigest: string
  stageId: string
  policyDigest: string
  hookDigest: string
}
export interface StageRecoveryHookIntent {
  schemaVersion: 1
  id: string
  identity: StageRecoveryHookIdentity
  phase: "started" | "settled" | "unknown" | "reconciled"
  exitCode?: number
  createdAt: number
  settledAt?: number
  reconciliation?: {
    outcome: "confirmed-completed" | "confirmed-not-executed"
    evidenceDigest: string
    observedAt: number
  }
}
export type StageRecoveryHookInspection =
  | {
      outcome: "unknown"
    }
  | {
      outcome: "confirmed-completed" | "confirmed-not-executed"
      evidenceDigest: string
      exitCode?: number
      /** Supplied only by the native inspector; never deserialize a renderer approval as evidence. */
      assertCurrent(): void
    }
export interface StageRecoveryHookSettlement {
  /** A fact write for this exact intent, never a new execution grant. */
  settle(exitCode: number | null, uncertain: boolean, resultDigest?: string): void
}

const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)
function fail(): never {
  throw Error("PROJECT_STAGE_DEBUG_HOOK_JOURNAL_CHANGED")
}
function assertIdentity(value: StageRecoveryHookIdentity): void {
  if (
    !value ||
    Object.values(value).length !== 8 ||
    Object.values(value).some(
      (item) =>
        typeof item !== "string" ||
        !item ||
        item.length > 256 ||
        Array.from(item).some((character) => character.charCodeAt(0) < 32)
    ) ||
    ![value.packageDigest, value.policyDigest, value.hookDigest].every((item) =>
      /^[a-f0-9]{64}$/.test(item)
    )
  )
    fail()
}

/** Native append/CAS journal. An OS process closing never proves a remote effect was undone. */
export class StageRecoveryHookJournal {
  constructor(private readonly settings: AuthoringAtomicSettings) {}
  private key(projectId: string) {
    if (
      !projectId ||
      projectId.length > 128 ||
      Array.from(projectId).some((character) => character.charCodeAt(0) < 32)
    )
      fail()
    return `project-stage-recovery-hooks-v1:${projectId}`
  }
  private read(projectId: string): { raw: string | undefined; entries: StageRecoveryHookIntent[] } {
    const raw = this.settings.getSetting(this.key(projectId), "")
    if (!raw) return { raw: undefined, entries: [] }
    if (Buffer.byteLength(raw) > 128 * 1024) fail()
    let entries: StageRecoveryHookIntent[]
    try {
      entries = JSON.parse(raw)
    } catch {
      return fail()
    }
    if (
      !Array.isArray(entries) ||
      entries.length > 128 ||
      entries.some(
        (entry) =>
          !entry ||
          entry.schemaVersion !== 1 ||
          !/^[a-f0-9-]{36}$/.test(entry.id) ||
          entry.identity?.projectId !== projectId ||
          !["started", "settled", "unknown", "reconciled"].includes(entry.phase) ||
          ![
            entry.identity.packageDigest,
            entry.identity.policyDigest,
            entry.identity.hookDigest
          ].every((value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)) ||
          !Number.isSafeInteger(entry.createdAt) ||
          (entry.phase === "settled" && !Number.isSafeInteger(entry.exitCode))
      )
    )
      fail()
    for (const entry of entries) assertIdentity(entry.identity)
    if (
      entries.some(
        (entry) =>
          entry.phase === "reconciled" &&
          (!entry.reconciliation ||
            !["confirmed-completed", "confirmed-not-executed"].includes(
              entry.reconciliation.outcome
            ) ||
            !/^[a-f0-9]{64}$/.test(entry.reconciliation.evidenceDigest) ||
            !Number.isSafeInteger(entry.reconciliation.observedAt))
      )
    )
      fail()
    return { raw, entries }
  }
  list(projectId: string, operationId?: string): StageRecoveryHookIntent[] {
    return structuredClone(
      this.read(projectId).entries.filter(
        (entry) => operationId === undefined || entry.identity.operationId === operationId
      )
    )
  }
  hasUnresolved(projectId: string, operationId?: string): boolean {
    return this.list(projectId, operationId).some((entry) =>
      ["started", "unknown"].includes(entry.phase)
    )
  }
  begin(identity: StageRecoveryHookIdentity, guard: () => void): StageRecoveryHookSettlement {
    assertIdentity(identity)
    guard()
    const previous = this.read(identity.projectId)
    if (
      previous.entries.length >= 128 ||
      previous.entries.some((entry) => ["started", "unknown"].includes(entry.phase))
    )
      throw Error("PROJECT_STAGE_DEBUG_RECOVERY_HOOK_OUTCOME_UNCONFIRMED")
    const intent: StageRecoveryHookIntent = {
      schemaVersion: 1,
      id: randomUUID(),
      identity: structuredClone(identity),
      phase: "started",
      createdAt: Date.now()
    }
    const next = JSON.stringify([...previous.entries, intent])
    guard()
    if (!this.settings.compareAndSetSetting(this.key(identity.projectId), previous.raw, next))
      fail()
    // Validate immediately, before any command starts. Corrupt identities never become intents.
    this.read(identity.projectId)
    let settled = false
    return {
      settle: (exitCode, uncertain, resultDigest) => {
        if (settled) fail()
        // Persist the physical fact independently and BEFORE publishing the public intent.
        // A lost CAS/IPC result must not erase an actual command completion.
        const fact = {
          schemaVersion: 1,
          intentId: intent.id,
          identity: intent.identity,
          exitCode,
          uncertain,
          resultDigest:
            resultDigest ??
            createHash("sha256")
              .update(JSON.stringify([exitCode, uncertain]))
              .digest("hex"),
          settledAt: Date.now()
        }
        if (!/^[a-f0-9]{64}$/.test(fact.resultDigest)) fail()
        const factKey = this.factKey(intent)
        if (!this.settings.compareAndSetSetting(factKey, undefined, JSON.stringify(fact))) fail()
        const current = this.read(identity.projectId)
        const index = current.entries.findIndex((entry) => entry.id === intent.id)
        if (index < 0 || !same(current.entries[index], intent)) fail()
        const result: StageRecoveryHookIntent = {
          ...intent,
          phase: uncertain || !Number.isSafeInteger(exitCode) ? "unknown" : "settled",
          ...(Number.isSafeInteger(exitCode) ? { exitCode: exitCode! } : {}),
          settledAt: Date.now()
        }
        current.entries[index] = result
        if (
          !this.settings.compareAndSetSetting(
            this.key(identity.projectId),
            current.raw,
            JSON.stringify(current.entries)
          )
        )
          fail()
        settled = true
      }
    }
  }
  private factKey(intent: StageRecoveryHookIntent): string {
    return `project-stage-recovery-hook-physical-v1:${intent.identity.projectId}:${intent.id}`
  }
  /** Host-written close receipt, never an artifact inference or a user assertion. */
  inspectPhysical(intent: StageRecoveryHookIntent): StageRecoveryHookInspection {
    const key = this.factKey(intent)
    const raw = this.settings.getSetting(key, "")
    if (!raw) return { outcome: "unknown" }
    if (Buffer.byteLength(raw) > 8192) fail()
    let fact: {
      schemaVersion: number
      intentId: string
      identity: StageRecoveryHookIdentity
      exitCode: number | null
      uncertain: boolean
      resultDigest: string
      settledAt: number
    }
    try {
      fact = JSON.parse(raw)
    } catch {
      return fail()
    }
    if (
      fact.schemaVersion !== 1 ||
      fact.intentId !== intent.id ||
      !same(fact.identity, intent.identity) ||
      typeof fact.uncertain !== "boolean" ||
      !/^[a-f0-9]{64}$/.test(fact.resultDigest) ||
      !Number.isSafeInteger(fact.settledAt) ||
      (fact.exitCode !== null && !Number.isSafeInteger(fact.exitCode))
    )
      fail()
    if (fact.uncertain || !Number.isSafeInteger(fact.exitCode)) return { outcome: "unknown" }
    return {
      outcome: "confirmed-completed",
      exitCode: fact.exitCode!,
      evidenceDigest: createHash("sha256").update(raw).digest("hex"),
      assertCurrent: () => {
        if (this.settings.getSetting(key, "") !== raw) fail()
      }
    }
  }
  /** An inspector only reads exact external operation evidence. This does not rerun a Hook,
   * inherit any approval, upgrade the whole stage to passed, or manufacture a native terminal.
   */
  async reconcile(
    projectId: string,
    intentId: string,
    inspect: (intent: StageRecoveryHookIntent) => Promise<StageRecoveryHookInspection>,
    guard: () => void
  ): Promise<boolean> {
    guard()
    const before = this.read(projectId)
    const intent = before.entries.find((entry) => entry.id === intentId)
    if (!intent || !["started", "unknown"].includes(intent.phase)) fail()
    const observation = await inspect(structuredClone(intent))
    guard()
    if (observation.outcome === "unknown") return false
    if (
      !["confirmed-completed", "confirmed-not-executed"].includes(observation.outcome) ||
      !/^[a-f0-9]{64}$/.test(observation.evidenceDigest) ||
      typeof observation.assertCurrent !== "function" ||
      (observation.exitCode !== undefined && !Number.isSafeInteger(observation.exitCode))
    )
      fail()
    observation.assertCurrent()
    guard()
    const current = this.read(projectId)
    if (current.raw !== before.raw) fail()
    const index = current.entries.findIndex((entry) => entry.id === intentId)
    current.entries[index] = {
      ...intent,
      phase: "reconciled",
      ...(observation.exitCode !== undefined ? { exitCode: observation.exitCode } : {}),
      reconciliation: {
        outcome: observation.outcome,
        evidenceDigest: observation.evidenceDigest,
        observedAt: Date.now()
      }
    }
    observation.assertCurrent()
    guard()
    if (
      !this.settings.compareAndSetSetting(
        this.key(projectId),
        before.raw,
        JSON.stringify(current.entries)
      )
    )
      fail()
    return true
  }
}

interface NativeJournalProvider {
  begin(source: Readonly<RuntimePluginSourceBinding>, hook: HookConfig): StageRecoveryHookSettlement
  unresolved(projectId: string, operationId?: string): boolean
}
let provider: NativeJournalProvider | undefined
/** Main-only native installation, never a renderer-provided callback. */
export function configureStageRecoveryHookJournal(value: NativeJournalProvider): void {
  provider = value
}
export function beginStageRecoveryHook(
  source: Readonly<RuntimePluginSourceBinding>,
  hook: HookConfig
): StageRecoveryHookSettlement {
  if (!provider) throw Error("PROJECT_STAGE_DEBUG_HOOK_JOURNAL_UNAVAILABLE")
  return provider.begin(source, hook)
}
export function hasUnresolvedStageRecoveryHook(projectId: string, operationId?: string): boolean {
  return provider?.unresolved(projectId, operationId) ?? false
}
