import { createHash } from "node:crypto"
import {
  authoringPlainRecord,
  readAuthoringConfigSnapshot,
  type AuthoringAtomicSettings,
  type AuthoringConfigSnapshot
} from "./authoring-config-snapshot"

const KEY = "mods-authoring-install-journal-v1"
const ABSENT = "\0authoring-journal-absent"
const MAX_BYTES = 4 * 1024 * 1024
const MAX_ROWS = 64
interface AuditSummary {
  operationId: string
  versionId: string
  phase: string
  digest: string
}
const phases = [
  "intent",
  "catalog-committed",
  "config-restoring",
  "config-restored",
  "settled",
  "reconciled",
  "partial",
  "unknown"
] as const
export type AuthoringInstallPhase = (typeof phases)[number]
export type AuthoringInstallFailure =
  | "catalog-unconfirmed"
  | "config-unconfirmed"
  | "scope-changed"
  | "storage-failed"
  | "interrupted"
const failures: AuthoringInstallFailure[] = [
  "catalog-unconfirmed",
  "config-unconfirmed",
  "scope-changed",
  "storage-failed",
  "interrupted"
]
export interface AuthoringInstallIntent {
  operationId: string
  installationId: string
  versionId: string
  workspace: string
  draftId: string
  revision: number
  configuration: "unchanged" | "restore"
}
export interface AuthoringInstallJournalRecord extends AuthoringInstallIntent {
  reconciliation?: AuthoringInstallReconciliation
  schemaVersion: 1
  journalRevision: number
  phase: AuthoringInstallPhase
  lastConfirmedPhase: "intent" | "catalog-committed" | "config-restoring" | "config-restored"
  expectedCatalogDigest: string
  nextCatalogDigest: string
  reason?: AuthoringInstallFailure
  /** Host-only durable snapshots. Never use a journal row as the renderer summary. */
  configBefore?: AuthoringConfigSnapshot
  configTarget?: AuthoringConfigSnapshot
}
export interface AuthoringInstallReconciliation {
  catalog: "before" | "after"
  configuration: "unchanged" | "restored" | "different"
  observedVersionId?: string
  catalogDigest: string
  configDigest: string
  observedAt: number
  originalPhase: Exclude<AuthoringInstallPhase, "settled" | "reconciled">
}
export function isAuthoringInstallTerminal(phase: AuthoringInstallPhase) {
  return phase === "settled" || phase === "reconciled"
}

/** Sources whose terminal observing operations must be retired in the same acknowledged batch. */
export function authoringRetirementClosure(
  versionId: string,
  operations: AuthoringInstallJournalRecord[],
  eligible: ReadonlySet<string>
): string[] | undefined {
  const closure = new Set([versionId])
  for (const target of closure) {
    if (!eligible.has(target)) return undefined
    for (const operation of operations) {
      if (operation.reconciliation?.observedVersionId !== target) continue
      if (!isAuthoringInstallTerminal(operation.phase)) return undefined
      closure.add(operation.versionId)
    }
  }
  return [...closure].sort()
}
const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
const sha = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value)
function binding(input: unknown): AuthoringInstallIntent {
  const row = authoringPlainRecord(input)
  if (
    !uuid(row.operationId) ||
    !uuid(row.installationId) ||
    !uuid(row.versionId) ||
    typeof row.workspace !== "string" ||
    !row.workspace ||
    row.workspace.length > 4096 ||
    row.workspace.includes("\0") ||
    typeof row.draftId !== "string" ||
    !/^[a-z][a-z0-9-]{0,63}$/.test(row.draftId) ||
    !Number.isSafeInteger(row.revision) ||
    Number(row.revision) < 1 ||
    typeof row.configuration !== "string" ||
    !["unchanged", "restore"].includes(row.configuration)
  )
    throw Error("AUTHORING_INSTALL_INVALID")
  return {
    operationId: row.operationId,
    installationId: row.installationId,
    versionId: row.versionId,
    workspace: row.workspace,
    draftId: row.draftId,
    revision: row.revision as number,
    configuration: row.configuration as AuthoringInstallIntent["configuration"]
  }
}
/** Hashes exact raw catalog bytes, including a distinct missing-file state. Not an OS-level CAS. */
export function authoringCatalogDigest(raw: string | null): string {
  if (
    !(raw === null || typeof raw === "string") ||
    (raw !== null && Buffer.byteLength(raw) > 1024 * 1024)
  )
    throw Error("AUTHORING_INSTALL_CATALOG_LIMIT")
  return createHash("sha256").update(JSON.stringify({ raw })).digest("hex")
}
function readRecord(input: unknown): AuthoringInstallJournalRecord {
  const row = authoringPlainRecord(input)
  const result = binding(row)
  if (
    row.schemaVersion !== 1 ||
    !Number.isSafeInteger(row.journalRevision) ||
    Number(row.journalRevision) < 1 ||
    !phases.includes(row.phase as AuthoringInstallPhase) ||
    !["intent", "catalog-committed", "config-restoring", "config-restored"].includes(
      String(row.lastConfirmedPhase)
    ) ||
    !sha(row.expectedCatalogDigest) ||
    !sha(row.nextCatalogDigest) ||
    (row.phase === "partial" || row.phase === "unknown"
      ? !failures.includes(row.reason as AuthoringInstallFailure)
      : row.phase === "reconciled"
        ? row.reason !== undefined && !failures.includes(row.reason as AuthoringInstallFailure)
        : row.reason !== undefined)
  )
    throw Error("AUTHORING_INSTALL_JOURNAL_INVALID")
  const minimumRevision = {
    intent: 1,
    "catalog-committed": 2,
    "config-restoring": 3,
    "config-restored": 4,
    settled: result.configuration === "restore" ? 5 : 3,
    reconciled: 2,
    partial: 2,
    unknown: 2
  }
  if (
    Number(row.journalRevision) < minimumRevision[row.phase as AuthoringInstallPhase] ||
    (row.phase === "intent" && row.journalRevision !== 1) ||
    (["intent", "catalog-committed", "config-restoring", "config-restored"].includes(
      String(row.phase)
    ) &&
      row.phase !== row.lastConfirmedPhase) ||
    (row.phase === "settled" &&
      row.lastConfirmedPhase !==
        (result.configuration === "restore" ? "config-restored" : "catalog-committed")) ||
    (result.configuration === "unchanged" &&
      ["config-restoring", "config-restored"].includes(String(row.lastConfirmedPhase)))
  )
    throw Error("AUTHORING_INSTALL_JOURNAL_INVALID")
  let reconciliation: AuthoringInstallReconciliation | undefined
  if (row.phase === "reconciled") {
    const observation = authoringPlainRecord(row.reconciliation)
    if (
      !["before", "after"].includes(String(observation.catalog)) ||
      !["unchanged", "restored", "different"].includes(String(observation.configuration)) ||
      !sha(observation.catalogDigest) ||
      !sha(observation.configDigest) ||
      !Number.isSafeInteger(observation.observedAt) ||
      Number(observation.observedAt) < 0 ||
      ![
        "intent",
        "catalog-committed",
        "config-restoring",
        "config-restored",
        "partial",
        "unknown"
      ].includes(String(observation.originalPhase)) ||
      (observation.observedVersionId !== undefined && !uuid(observation.observedVersionId)) ||
      observation.catalogDigest !==
        (observation.catalog === "before" ? row.expectedCatalogDigest : row.nextCatalogDigest) ||
      (observation.catalog === "after" && observation.observedVersionId !== result.versionId)
    )
      throw Error("AUTHORING_INSTALL_RECONCILIATION_INVALID")
    reconciliation = observation as unknown as AuthoringInstallReconciliation
  } else if (row.reconciliation !== undefined)
    throw Error("AUTHORING_INSTALL_RECONCILIATION_INVALID")
  const configBefore =
    row.configBefore === undefined ? undefined : readAuthoringConfigSnapshot(row.configBefore)
  const configTarget =
    row.configTarget === undefined ? undefined : readAuthoringConfigSnapshot(row.configTarget)
  if (
    (result.configuration === "restore" && (!configBefore || !configTarget)) ||
    (result.configuration === "unchanged" && configTarget) ||
    (configBefore && configBefore.workspace !== result.workspace) ||
    (configTarget &&
      (configTarget.workspace !== result.workspace || configTarget.plugin !== configBefore?.plugin))
  )
    throw Error("AUTHORING_INSTALL_SNAPSHOT_BINDING")
  return {
    ...result,
    ...(reconciliation ? { reconciliation } : {}),
    schemaVersion: 1,
    journalRevision: row.journalRevision as number,
    phase: row.phase as AuthoringInstallPhase,
    lastConfirmedPhase:
      row.lastConfirmedPhase as AuthoringInstallJournalRecord["lastConfirmedPhase"],
    expectedCatalogDigest: row.expectedCatalogDigest,
    nextCatalogDigest: row.nextCatalogDigest,
    ...(row.reason === undefined ? {} : { reason: row.reason as AuthoringInstallFailure }),
    ...(configBefore ? { configBefore } : {}),
    ...(configTarget ? { configTarget } : {})
  }
}

/** Host journal only. Neither transitions nor a parsed record authenticate external side effects. */
export class AuthoringInstallJournal {
  constructor(private readonly store: AuthoringAtomicSettings) {}
  private rows() {
    const stored = this.store.getSetting(KEY, ABSENT),
      raw = stored === ABSENT ? undefined : stored
    if (raw !== undefined && Buffer.byteLength(raw) > MAX_BYTES)
      throw Error("AUTHORING_INSTALL_JOURNAL_LIMIT")
    const decoded: unknown = raw === undefined ? [] : JSON.parse(raw)
    const envelope = Array.isArray(decoded)
      ? { rows: decoded, audit: [] }
      : authoringPlainRecord(decoded)
    const input = envelope.rows
    if (
      !Array.isArray(input) ||
      input.length > MAX_ROWS ||
      !Array.isArray(envelope.audit) ||
      envelope.audit.length > MAX_ROWS
    )
      throw Error("AUTHORING_INSTALL_JOURNAL_INVALID")
    const audit = envelope.audit.map((entry) => {
      const value = authoringPlainRecord(entry)
      if (
        !uuid(value.operationId) ||
        !uuid(value.versionId) ||
        typeof value.phase !== "string" ||
        !sha(value.digest)
      )
        throw Error("AUTHORING_INSTALL_JOURNAL_INVALID")
      return value as unknown as AuditSummary
    })
    const rows = input.map(readRecord)
    if (new Set(rows.map((row) => row.operationId)).size !== rows.length)
      throw Error("AUTHORING_INSTALL_JOURNAL_INVALID")
    return { raw, rows, audit }
  }
  private commit(
    raw: string | undefined,
    rows: AuthoringInstallJournalRecord[],
    guard: () => void,
    archived: AuthoringInstallJournalRecord[] = []
  ) {
    if (typeof this.store.compareAndSetSetting !== "function")
      throw Error("AUTHORING_INSTALL_ATOMIC_REQUIRED")
    const decoded = raw === undefined ? [] : JSON.parse(raw)
    const audit: AuditSummary[] = Array.isArray(decoded) ? [] : decoded.audit
    const summaries = [
      ...audit,
      ...archived.map((row) => ({
        operationId: row.operationId,
        versionId: row.versionId,
        phase: row.phase,
        digest: createHash("sha256").update(JSON.stringify(row)).digest("hex")
      }))
    ].slice(-MAX_ROWS)
    const encoded = JSON.stringify(summaries.length ? { rows, audit: summaries } : rows)
    if (rows.length > MAX_ROWS || Buffer.byteLength(encoded) > MAX_BYTES)
      throw Error("AUTHORING_INSTALL_JOURNAL_LIMIT")
    guard()
    if (!this.store.compareAndSetSetting(KEY, raw, encoded))
      throw Error("AUTHORING_INSTALL_JOURNAL_CHANGED")
    // The CAS is the durable journal effect. Post-CAS revocation is an uncertain caller outcome.
    guard()
  }
  read(operationId: string, workspace: string): AuthoringInstallJournalRecord | undefined {
    if (!uuid(operationId) || typeof workspace !== "string")
      throw Error("AUTHORING_INSTALL_INVALID")
    return this.rows().rows.find(
      (row) => row.operationId === operationId && row.workspace === workspace
    )
  }

  /** Host-only records include opaque configuration snapshots; never return them from IPC. */
  listAll(): AuthoringInstallJournalRecord[] {
    return this.rows().rows
  }

  /** Explicit source retirement retains bounded operation digests, never a false execution state. */
  retireVersions(versionIds: ReadonlySet<string>, assertCurrent: () => void) {
    const { raw, rows } = this.rows()
    const archived = rows.filter((row) => versionIds.has(row.versionId))
    if (
      archived.some((row) => !isAuthoringInstallTerminal(row.phase)) ||
      rows.some(
        (row) =>
          row.reconciliation?.observedVersionId &&
          versionIds.has(row.reconciliation.observedVersionId) &&
          !versionIds.has(row.versionId)
      )
    )
      throw Error("AUTHORING_INSTALL_PENDING")
    this.commit(
      raw,
      rows.filter((row) => !versionIds.has(row.versionId)),
      assertCurrent,
      archived
    )
  }

  /** Host-only records include opaque configuration snapshots; never return them from IPC. */
  list(workspace: string): AuthoringInstallJournalRecord[] {
    if (
      typeof workspace !== "string" ||
      !workspace ||
      workspace.length > 4096 ||
      workspace.includes("\0")
    )
      throw Error("AUTHORING_INSTALL_INVALID")
    return this.rows().rows.filter((row) => row.workspace === workspace)
  }
  begin(
    input: AuthoringInstallIntent & {
      expectedCatalogRaw: string | null
      nextCatalogRaw: string
      configBefore?: AuthoringConfigSnapshot
      configTarget?: AuthoringConfigSnapshot
      assertCurrent: () => void
    }
  ): AuthoringInstallJournalRecord {
    const row = authoringPlainRecord(input),
      captured = binding(row),
      guard = row.assertCurrent
    if (typeof guard !== "function" || typeof row.nextCatalogRaw !== "string")
      throw Error("AUTHORING_INSTALL_INVALID")
    const expectedCatalogDigest = authoringCatalogDigest(row.expectedCatalogRaw as string | null)
    const nextCatalogDigest = authoringCatalogDigest(row.nextCatalogRaw)
    const record = readRecord({
      ...captured,
      schemaVersion: 1,
      journalRevision: 1,
      phase: "intent",
      lastConfirmedPhase: "intent",
      expectedCatalogDigest,
      nextCatalogDigest,
      configBefore: row.configBefore,
      configTarget: row.configTarget
    })
    guard()
    const { raw, rows } = this.rows()
    if (
      rows.some(
        (item) =>
          item.operationId === captured.operationId ||
          (item.installationId === captured.installationId &&
            !isAuthoringInstallTerminal(item.phase))
      )
    )
      throw Error("AUTHORING_INSTALL_PENDING")
    let retained = rows
    if (rows.length >= MAX_ROWS) {
      const keep = new Set<AuthoringInstallJournalRecord>()
      const seen = new Set<string>()
      for (const item of [...rows].reverse()) {
        const keys = [
          `version:${item.versionId}`,
          ...(item.configBefore
            ? [
                `config:${item.workspace}:${item.configBefore.plugin}:${item.configBefore.compiledDigest}`
              ]
            : []),
          ...(item.reconciliation?.observedVersionId
            ? [`observed:${item.reconciliation.observedVersionId}`]
            : [])
        ]
        if (!isAuthoringInstallTerminal(item.phase) || keys.some((key) => !seen.has(key)))
          keep.add(item)
        keys.forEach((key) => seen.add(key))
      }
      retained = rows.filter((item) => keep.has(item))
    }
    this.commit(
      raw,
      [...retained, record],
      guard as () => void,
      rows.filter((item) => !retained.includes(item))
    )
    return record
  }
  advance(input: {
    operationId: string
    workspace: string
    expectedRevision: number
    next: Exclude<AuthoringInstallPhase, "intent">
    observedCatalogDigest?: string
    reason?: AuthoringInstallFailure
    assertCurrent: () => void
  }): AuthoringInstallJournalRecord {
    const row = authoringPlainRecord(input)
    const operationId = row.operationId,
      workspace = row.workspace,
      guard = row.assertCurrent
    if (
      !uuid(operationId) ||
      typeof workspace !== "string" ||
      typeof guard !== "function" ||
      !Number.isSafeInteger(row.expectedRevision) ||
      Number(row.expectedRevision) < 1 ||
      !phases.includes(row.next as AuthoringInstallPhase) ||
      row.next === "intent"
    )
      throw Error("AUTHORING_INSTALL_INVALID")
    guard()
    const { raw, rows } = this.rows()
    const index = rows.findIndex(
      (item) => item.operationId === operationId && item.workspace === workspace
    )
    const current = rows[index]
    if (
      !current ||
      current.journalRevision !== row.expectedRevision ||
      current.journalRevision === Number.MAX_SAFE_INTEGER
    )
      throw Error("AUTHORING_INSTALL_JOURNAL_CHANGED")
    const next = row.next as Exclude<AuthoringInstallPhase, "intent">
    const allowed =
      current.phase === "intent"
        ? "catalog-committed"
        : current.phase === "catalog-committed"
          ? current.configuration === "restore"
            ? "config-restoring"
            : "settled"
          : current.phase === "config-restoring"
            ? "config-restored"
            : current.phase === "config-restored"
              ? "settled"
              : undefined
    const uncertain = next === "partial" || next === "unknown"
    if (
      !allowed ||
      (!uncertain && next !== allowed) ||
      (uncertain
        ? !failures.includes(row.reason as AuthoringInstallFailure)
        : row.reason !== undefined) ||
      (!uncertain && row.observedCatalogDigest !== current.nextCatalogDigest)
    )
      throw Error("AUTHORING_INSTALL_TRANSITION")
    const record: AuthoringInstallJournalRecord = {
      ...current,
      phase: next,
      journalRevision: current.journalRevision + 1,
      lastConfirmedPhase: uncertain || next === "settled" ? current.lastConfirmedPhase : next,
      ...(uncertain ? { reason: row.reason as AuthoringInstallFailure } : {})
    }
    rows[index] = record
    this.commit(raw, rows, guard as () => void)
    return record
  }
  /** Records explicit acceptance of a freshly observed state; it never replays external writes. */
  reconcile(input: {
    operationId: string
    workspace: string
    expectedRevision: number
    observation: Omit<AuthoringInstallReconciliation, "originalPhase">
    assertCurrent(): void
  }): AuthoringInstallJournalRecord {
    const captured = authoringPlainRecord(input),
      guard = captured.assertCurrent
    const observation = authoringPlainRecord(captured.observation)
    if (
      typeof guard !== "function" ||
      !uuid(captured.operationId) ||
      typeof captured.workspace !== "string"
    )
      throw Error("AUTHORING_INSTALL_INVALID")
    guard()
    const { raw, rows } = this.rows()
    const index = rows.findIndex(
      (row) => row.operationId === captured.operationId && row.workspace === captured.workspace
    )
    const current = rows[index]
    if (
      !current ||
      isAuthoringInstallTerminal(current.phase) ||
      current.journalRevision !== captured.expectedRevision ||
      current.journalRevision === Number.MAX_SAFE_INTEGER
    )
      throw Error("AUTHORING_INSTALL_JOURNAL_CHANGED")
    const record = readRecord({
      ...current,
      phase: "reconciled",
      journalRevision: current.journalRevision + 1,
      reconciliation: { ...observation, originalPhase: current.phase }
    })
    rows[index] = record
    this.commit(raw, rows, guard as () => void)
    return record
  }
}
