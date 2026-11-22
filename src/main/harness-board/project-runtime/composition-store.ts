import { existsSync, mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { randomUUID } from "node:crypto"
import { AsyncLocalStorage } from "node:async_hooks"
import { DatabaseSync } from "node:sqlite"
import {
  compositionText,
  parseProjectComposition,
  parseCompositionCompletion,
  type CompositionCompletionProof
} from "../../../shared/project-runtime/composition"
import { runtimeDigest, runtimeDirectory, runtimeDirectoryIdentity } from "./safe-files"
import {
  acquireCompositionAdmission,
  compositionDatabaseIdentity,
  compositionWorkspaceKey,
  compositionWorkspaceKeys,
  existingCompositionDatabaseIdentity
} from "./composition-admission"

import {
  parseCompositionUnitContext, parseCompositionUnitContexts,
  type CompositionRun, type CompositionUnitContextSelection
} from "../../../shared/project-runtime/composition-api"
export type {
  CompositionRun,
  CompositionUnitState,
  CompositionStatus
} from "../../../shared/project-runtime/composition-api"

/** Main-only observation returned synchronously, never supplied by IPC or reused across calls. */
export interface CompositionWorkspaceObservation {
  readonly workspace: string
  readonly identity: string
}

const COMPOSITION_BUSY_TIMEOUT_MS = 5_000

function readCompositionLeases(db: DatabaseSync, key: string): string[] {
  return db.prepare(`SELECT l.run_id FROM composition_leases l WHERE l.workspace=?
    UNION
    SELECT l.run_id FROM composition_unit_workspaces u
    JOIN composition_leases l ON l.run_id=u.run_id WHERE u.workspace=?`).all(key, key).map(row => {
    if (typeof row.run_id !== "string" || !row.run_id) throw Error("COMPOSITION_STORAGE_INVALID")
    return row.run_id
  })
}

/** Read the committed ledger under the workspace locks, without taking the ledger writer mutex. */
function guardCompositionWorkspace<T>(
  path: string,
  workspace: string,
  work: (release?: () => void) => T,
  retain: boolean,
  opened?: { db: DatabaseSync; identity: string; owner?: string }
): T {
  const keys = compositionWorkspaceKeys(workspace)
  const releases: Array<() => void> = []
  const release = () => {
    let failure: unknown
    while (releases.length) {
      try { releases.pop()!() } catch (error) { failure ??= error }
    }
    if (failure) throw failure
  }
  let attached = false
  let readOnly: DatabaseSync | undefined
  try {
    for (const key of keys) releases.push(acquireCompositionAdmission(path, key, "reader"))
    const identity = compositionDatabaseIdentity(path)
    if (opened && opened.identity !== identity) throw Error("COMPOSITION_STORAGE_CHANGED")
    const db = opened?.db ?? (readOnly = new DatabaseSync(path, { readOnly: true, timeout: 0 }))
    const leases = keys.map(key => readCompositionLeases(db, key))
    const blocking = leases.flat().find(runId => runId !== opened?.owner)
    if (blocking) {
      const run = db.prepare(`SELECT json_extract(data,'$.configurationPending') AS pending
        FROM composition_runs WHERE id=?`).get(blocking)
      if (!run) throw Error("COMPOSITION_STORAGE_INVALID")
      throw Error(run.pending === 1
        ? "当前组合等待配置，请先完成参数与授权，或取消本次组合后继续会话"
        : "COMPOSITION_WORKSPACE_BUSY")
    }
    // A valid lexical lease cannot move its owner to an unrelated physical directory.
    if (opened?.owner && !leases.at(-1)?.includes(opened.owner))
      throw Error("COMPOSITION_WORKSPACE_OWNER_CHANGED")
    if (compositionDatabaseIdentity(path) !== identity)
      throw Error("COMPOSITION_STORAGE_CHANGED")
    const currentKeys = compositionWorkspaceKeys(workspace)
    if (keys.length !== currentKeys.length || keys.some((key, index) => key !== currentKeys[index]))
      throw Error("COMPOSITION_ADMISSION_SCOPE_CHANGED")
    readOnly?.close()
    readOnly = undefined
    const result = work(retain ? release : undefined)
    attached = retain
    return result
  } finally {
    try {
      readOnly?.close()
    } finally {
      if (!attached) release()
    }
  }
}

export function guardUnopenedCompositionWorkspace<T>(
  path: string,
  workspace: string,
  work: (release?: () => void) => T,
  retain = false
): T {
  return guardCompositionWorkspace(path, workspace, work, retain)
}

/** Dedicated database; the original host/legacy schemas and guards are untouched. */
export class ProjectCompositionStore {
  private readonly db: DatabaseSync
  private readonly owner = new AsyncLocalStorage<string>()
  private readonly identity: string
  constructor(
    private readonly path: string,
    private readonly now = () => Date.now(),
    private readonly assertWorkspaceIdle?: (workspace: string, parentProjectId: string) => void
  ) {
    const missing: string[] = []
    let parent = dirname(resolve(path))
    while (!existsSync(parent)) {
      missing.push(parent)
      parent = dirname(parent)
    }
    runtimeDirectory(parent)
    for (const directory of missing.reverse()) {
      mkdirSync(directory, { recursive: true })
      runtimeDirectory(directory)
    }
    const before = existingCompositionDatabaseIdentity(path)
    this.db = new DatabaseSync(path, { timeout: COMPOSITION_BUSY_TIMEOUT_MS })
    try {
      this.identity = compositionDatabaseIdentity(path)
      if (before && before !== this.identity) throw Error("COMPOSITION_STORAGE_CHANGED")
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS composition_runs (
          id TEXT PRIMARY KEY, project_id TEXT NOT NULL, request_id TEXT NOT NULL,
          version INTEGER NOT NULL, data TEXT NOT NULL, UNIQUE(project_id,request_id));
        CREATE TABLE IF NOT EXISTS composition_leases (
          workspace TEXT PRIMARY KEY, project_id TEXT NOT NULL UNIQUE,
          run_id TEXT NOT NULL UNIQUE REFERENCES composition_runs(id));
        CREATE TABLE IF NOT EXISTS composition_unit_workspaces (
          workspace TEXT PRIMARY KEY, run_id TEXT NOT NULL, unit_id TEXT NOT NULL,
          directory_identity TEXT NOT NULL, directory_path TEXT NOT NULL, UNIQUE(run_id,unit_id));`)
    } catch (error) {
      this.db.close()
      throw error
    }
  }
  close(): void {
    this.db.close()
  }
  /** Main-only scope inherited through original engine async calls; every mutation rechecks lease. */
  withWorkspaceOwner<T>(runId: string, work: () => T): T {
    const run = this.require(runId)
    if (!["running", "waiting-approval", "cancel-requested"].includes(run.status))
      throw Error("COMPOSITION_OWNER_NOT_ACTIVE")
    return this.owner.run(runId, work)
  }
  /** Read-only authority check. Real mutations still acquire the workspace admission lock. */
  assertWorkspaceAuthority(
    workspace: string,
    expectedUnit?: { runId: string; unitId: string }
  ): CompositionWorkspaceObservation {
    const owner = this.owner.getStore()
    if (!owner) throw Error("COMPOSITION_WORKSPACE_OWNER_CHANGED")
    const identity = runtimeDirectoryIdentity(workspace)
    const canonical = resolve(workspace)
    const key = process.platform === "win32" ? canonical.toLowerCase() : canonical
    const unit = expectedUnit
      ? this.db.prepare(`SELECT u.workspace,u.directory_path,u.directory_identity,u.unit_id,l.run_id
          FROM composition_unit_workspaces u
          LEFT JOIN composition_leases l ON l.run_id=u.run_id WHERE u.run_id=? AND u.unit_id=?`)
          .get(expectedUnit.runId, expectedUnit.unitId)
      : this.db.prepare(`SELECT u.workspace,u.directory_path,u.directory_identity,u.unit_id,l.run_id
          FROM composition_unit_workspaces u
          JOIN composition_leases l ON l.run_id=u.run_id WHERE u.workspace=?`).get(key)
    if (expectedUnit && (!unit || String(unit.directory_path) !== canonical || unit.workspace !== key))
      throw Error("COMPOSITION_INTERNAL_SCOPE_CHANGED")
    if (unit) {
      if (unit.run_id !== owner || String(unit.directory_path) !== canonical ||
        identity !== unit.directory_identity || (expectedUnit &&
          (unit.run_id !== expectedUnit.runId || unit.unit_id !== expectedUnit.unitId)))
        throw Error("COMPOSITION_WORKSPACE_OWNER_CHANGED")
      return Object.freeze({ workspace: canonical, identity })
    }
    const lease = this.db.prepare("SELECT run_id FROM composition_leases WHERE workspace=?").get(key)
    if (!lease || lease.run_id !== owner) throw Error("COMPOSITION_WORKSPACE_OWNER_CHANGED")
    return Object.freeze({ workspace: canonical, identity })
  }
  /** Original host/legacy transactions share this fence until their synchronous commit. */
  guardWorkspaceMutation<T>(workspace: string, work: () => T): T {
    return this.guardWorkspaceAdmission(workspace, work, false)
  }

  guardWorkspaceAdmission<T>(
    workspace: string,
    work: (release?: () => void) => T,
    retain: boolean
  ): T {
    return guardCompositionWorkspace(this.path, workspace, work, retain, {
      db: this.db,
      identity: this.identity,
      owner: this.owner.getStore()
    })
  }

  private claimWorkspace<T>(key: string, work: () => T): T {
    const release = acquireCompositionAdmission(this.path, key, "writer")
    try {
      if (compositionDatabaseIdentity(this.path) !== this.identity)
        throw Error("COMPOSITION_STORAGE_CHANGED")
      return this.transaction(work)
    } finally {
      release()
    }
  }

  registerUnitWorkspace(runId: string, unitId: string, workspace: string): void {
    const canonical = runtimeDirectory(workspace)
    const key = compositionWorkspaceKey(canonical)
    const identity = runtimeDirectoryIdentity(canonical)
    const priorWorkspace = () => this.db
      .prepare("SELECT workspace,directory_identity FROM composition_unit_workspaces WHERE run_id=? AND unit_id=?")
      .get(runId, unitId)
    const assertCurrent = () => {
      if (compositionDatabaseIdentity(this.path) !== this.identity)
        throw Error("COMPOSITION_STORAGE_CHANGED")
      const run = this.require(runId)
      if (!run.definition.units.some((unit) => unit.id === unitId) ||
        !this.db.prepare("SELECT run_id FROM composition_leases WHERE run_id=?").get(runId))
        throw Error("COMPOSITION_OWNER_NOT_ACTIVE")
      return run
    }
    const matchesPrior = (previous: Record<string, unknown>) => {
      if (previous.workspace !== key || previous.directory_identity !== identity)
        throw Error("COMPOSITION_WORKSPACE_OWNER_CHANGED")
    }
    // A retained unit's immutable binding needs no writer lock during repeated preparation.
    const previous = priorWorkspace()
    if (previous) {
      assertCurrent()
      matchesPrior(previous)
      return
    }
    this.claimWorkspace(key, () => {
      const run = assertCurrent()
      const existing = priorWorkspace()
      if (existing) {
        matchesPrior(existing)
        return
      }
      if (readCompositionLeases(this.db, key).length) throw Error("COMPOSITION_WORKSPACE_BUSY")
      this.assertWorkspaceIdle?.(canonical, run.definition.parentProjectId)
      this.db
        .prepare("INSERT INTO composition_unit_workspaces VALUES (?,?,?,?,?)")
        .run(key, runId, unitId, identity, canonical)
    })
  }

  unitWorkspace(runId: string, unitId: string): string | undefined {
    const row = this.db
      .prepare(
        "SELECT directory_path,directory_identity FROM composition_unit_workspaces WHERE run_id=? AND unit_id=?"
      )
      .get(runId, unitId)
    if (!row) return undefined
    const directory = String(row.directory_path)
    if (runtimeDirectoryIdentity(directory) !== row.directory_identity)
      throw Error("COMPOSITION_WORKSPACE_OWNER_CHANGED")
    return directory
  }
  list(parentProjectId: string, limit = 50): CompositionRun[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw Error("COMPOSITION_LIST_LIMIT")
    return this.db
      .prepare("SELECT id FROM composition_runs WHERE project_id=? ORDER BY rowid DESC LIMIT ?")
      .all(compositionText(parentProjectId), limit)
      .map((row) => this.require(String(row.id)))
  }
  parentForHostUnit(projectId: string): string | undefined {
    const match = /^composition:([^:]+):([^:]+)$/.exec(projectId)
    if (!match) return undefined
    const run = this.get(match[1])
    return run?.definition.units.some((unit) => unit.id === match[2])
      ? run.definition.parentProjectId
      : undefined
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
  get(id: string): CompositionRun | undefined {
    const row = this.db.prepare("SELECT version,data FROM composition_runs WHERE id=?").get(id)
    if (!row) return undefined
    const run = JSON.parse(String(row.data)) as CompositionRun
    const definition = parseProjectComposition(run.definition)
    if (
      run.id !== id ||
      run.version !== row.version ||
      !Number.isSafeInteger(run.version) ||
      run.version < 1 ||
      run.definitionDigest !== runtimeDigest(JSON.stringify(definition)) ||
      ![
        "running",
        "waiting-approval",
        "succeeded",
        "failed",
        "cancel-requested",
        "cancelled",
        "unknown"
      ].includes(run.status) ||
      !Array.isArray(run.units) ||
      run.units.length !== definition.units.length
    )
      throw Error("COMPOSITION_STORAGE_INVALID")
    if ((run.configurationPending !== undefined && typeof run.configurationPending !== "boolean") ||
        (run.configurationPending && (run.status !== "running" ||
          run.units.some(unit => unit.status !== "pending" || unit.attemptId || unit.engineRunId))))
      throw Error("COMPOSITION_STORAGE_INVALID")
    if (run.unitContexts !== undefined)
      parseCompositionUnitContexts(run.unitContexts, definition.units.map(unit => unit.id))
    for (const [index, unit] of run.units.entries()) {
      if (
        unit.id !== definition.units[index].id ||
        ![
          "pending",
          "running",
          "waiting-approval",
          "succeeded",
          "failed",
          "cancelled",
          "unknown"
        ].includes(unit.status) ||
        (unit.status === "succeeded" && !unit.proof)
      )
        throw Error("COMPOSITION_STORAGE_INVALID")
      if (unit.proof) parseCompositionCompletion(unit.proof, definition.units[index])
    }
    if (run.status === "succeeded" && run.units.some((unit) => unit.status !== "succeeded"))
      throw Error("COMPOSITION_STORAGE_INVALID")
    return run
  }
  private require(id: string): CompositionRun {
    const run = this.get(id)
    if (!run) throw Error("COMPOSITION_RUN_MISSING")
    return run
  }
  private save(run: CompositionRun): CompositionRun {
    const before = run.version
    run.version++
    run.updatedAt = this.now()
    const update = this.db
      .prepare("UPDATE composition_runs SET version=?,data=? WHERE id=? AND version=?")
      .run(run.version, JSON.stringify(run), run.id, before)
    if (update.changes !== 1) throw Error("COMPOSITION_VERSION_CONFLICT")
    if (["succeeded", "failed", "cancelled"].includes(run.status))
      this.db.prepare("DELETE FROM composition_leases WHERE run_id=?").run(run.id)
    return structuredClone(run)
  }
  create(value: unknown, requestId: string, configurationPending = false): { run: CompositionRun; created: boolean } {
    const definition = parseProjectComposition(value)
    definition.workspace = runtimeDirectory(definition.workspace)
    compositionText(requestId)
    const digest = runtimeDigest(JSON.stringify(definition))
    const workspaceKey = compositionWorkspaceKey(definition.workspace)
    const readPrevious = () => this.db
      .prepare("SELECT id FROM composition_runs WHERE project_id=? AND request_id=?")
      .get(definition.parentProjectId, requestId)
    const replay = (previous: Record<string, unknown>) => {
      const run = this.require(String(previous.id))
      if (run.definitionDigest !== digest) throw Error("COMPOSITION_IDEMPOTENCY_CONFLICT")
      return { run, created: false }
    }
    const previous = readPrevious()
    if (previous) return replay(previous)
    return this.claimWorkspace(workspaceKey, () => {
      const existing = readPrevious()
      if (existing) return replay(existing)
      if (
        readCompositionLeases(this.db, workspaceKey).length ||
        this.db.prepare("SELECT run_id FROM composition_leases WHERE project_id=?")
          .get(definition.parentProjectId)
      )
        throw Error("COMPOSITION_WORKSPACE_BUSY")
      this.assertWorkspaceIdle?.(definition.workspace, definition.parentProjectId)
      const run: CompositionRun = {
        id: randomUUID(),
        requestId,
        version: 1,
        definition,
        definitionDigest: digest,
        status: "running",
        units: definition.units.map((unit) => ({ id: unit.id, status: "pending" })),
        createdAt: this.now(),
        updatedAt: this.now()
      }
      if (configurationPending) run.configurationPending = true
      this.db
        .prepare("INSERT INTO composition_runs VALUES (?,?,?,?,?)")
        .run(run.id, definition.parentProjectId, requestId, run.version, JSON.stringify(run))
      this.db
        .prepare("INSERT INTO composition_leases VALUES (?,?,?)")
        .run(workspaceKey, definition.parentProjectId, run.id)
      return { run, created: true }
    })
  }
  claim(id: string, expectedVersion: number, resume = false): CompositionRun {
    return this.transaction(() => {
      const run = this.require(id)
      if (run.configurationPending) throw Error("COMPOSITION_CONFIGURATION_REQUIRED")
      if (run.version !== expectedVersion) throw Error("COMPOSITION_VERSION_CONFLICT")
      if (resume ? !["waiting-approval", "unknown"].includes(run.status) : run.status !== "running")
        throw Error("COMPOSITION_NOT_RUNNABLE")
      const unit = run.units.find((unit) => unit.status !== "succeeded")
      if (
        !unit ||
        (resume
          ? ![
              "waiting-approval",
              "unknown",
              ...(run.status === "unknown" ? ["pending"] : [])
            ].includes(unit.status)
          : unit.status !== "pending")
      )
        throw Error("COMPOSITION_UNIT_NOT_RUNNABLE")
      if (resume && run.status !== "unknown" && !unit.engineRunId)
        throw Error("COMPOSITION_ENGINE_ID_REQUIRED")
      unit.status = "running"
      unit.attemptId = randomUUID()
      run.status = "running"
      return this.save(run)
    })
  }
  confirmConfiguration(id: string, expectedVersion: number): CompositionRun {
    return this.transaction(() => {
      const run = this.require(id)
      if (run.version !== expectedVersion) throw Error("COMPOSITION_VERSION_CONFLICT")
      if (!run.configurationPending || run.status !== "running" ||
          run.units.some(unit => unit.status !== "pending" || unit.attemptId || unit.engineRunId))
        throw Error("COMPOSITION_CONFIGURATION_CHANGED")
      run.configurationPending = false
      return this.save(run)
    })
  }
  saveUnitContext(id: string, expectedVersion: number, unitId: string, value: CompositionUnitContextSelection): CompositionRun {
    const selection = parseCompositionUnitContext(value)
    return this.transaction(() => {
      const run = this.require(id)
      if (run.version !== expectedVersion) throw Error("COMPOSITION_VERSION_CONFLICT")
      if (!run.configurationPending || run.status !== "running" ||
          !run.definition.units.some(unit => unit.id === unitId) ||
          run.units.some(unit => unit.status !== "pending" || unit.attemptId || unit.engineRunId))
        throw Error("COMPOSITION_CONFIGURATION_CHANGED")
      run.unitContexts = { ...run.unitContexts, [unitId]: selection }
      return this.save(run)
    })
  }
  settle(
    id: string,
    attemptId: string,
    result: {
      status: "succeeded" | "failed" | "cancelled" | "unknown" | "waiting-approval"
      engineRunId?: string
      proof?: CompositionCompletionProof
      reason?: string
    }
  ): CompositionRun {
    return this.transaction(() => {
      const run = this.require(id)
      const unit = run.units.find((unit) => unit.attemptId === attemptId)
      if (
        !unit ||
        unit.status !== "running" ||
        !["running", "cancel-requested"].includes(run.status)
      )
        throw Error("COMPOSITION_ATTEMPT_CHANGED")
      if (result.status === "succeeded" && !result.proof)
        throw Error("COMPOSITION_COMPLETE_PROOF_REQUIRED")
      if (result.proof)
        result = {
          ...result,
          proof: parseCompositionCompletion(
            result.proof,
            run.definition.units.find((entry) => entry.id === unit.id)!
          )
        }
      if (result.status === "waiting-approval" && !result.engineRunId)
        throw Error("COMPOSITION_ENGINE_ID_REQUIRED")
      unit.status = result.status
      unit.engineRunId = result.proof?.engineRunId ?? result.engineRunId ?? unit.engineRunId
      unit.proof = result.proof
      unit.reason = result.reason
      if (run.status === "cancel-requested") {
        // A waiting engine has not confirmed cancellation, so retain the lease as uncertain.
        run.status =
          result.status === "unknown" || result.status === "waiting-approval"
            ? "unknown"
            : "cancelled"
      } else
        run.status =
          result.status === "succeeded"
            ? run.units.every((unit) => unit.status === "succeeded")
              ? "succeeded"
              : "running"
            : result.status
      return this.save(run)
    })
  }
  consumeApproval(id: string, unitId: string, expectedVersion: number): CompositionRun {
    return this.transaction(() => {
      const run = this.require(id)
      if (run.version !== expectedVersion) throw Error("COMPOSITION_VERSION_CONFLICT")
      if (
        run.status !== "waiting-approval" ||
        run.units.find((unit) => unit.id === unitId)?.status !== "waiting-approval"
      )
        throw Error("COMPOSITION_APPROVAL_CHANGED")
      return this.save(run)
    })
  }
  cancel(id: string): CompositionRun {
    return this.transaction(() => {
      const run = this.require(id)
      if (["succeeded", "failed", "cancelled", "unknown"].includes(run.status)) return run
      const current = run.units.find((unit) => unit.status !== "succeeded")
      run.status = !current || current.status === "pending" ? "cancelled" : "cancel-requested"
      if (run.configurationPending) run.configurationPending = false
      return this.save(run)
    })
  }
  markUnknown(id: string): CompositionRun {
    return this.transaction(() => {
      const run = this.require(id)
      if (!["running", "cancel-requested"].includes(run.status)) return run
      run.status = "unknown"
      for (const unit of run.units) if (unit.status === "running") unit.status = "unknown"
      return this.save(run)
    })
  }
  /** Explicit startup reconciliation only, after the host knows the former process has exited. */
  recoverInterruptedRuns(limit = 256): CompositionRun[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256)
      throw Error("COMPOSITION_RECOVERY_LIMIT")
    return this.transaction(() => {
      const rows = this.db
        .prepare(
          "SELECT id FROM composition_runs WHERE json_extract(data,'$.status') IN ('running','cancel-requested') LIMIT ?"
        )
        .all(limit)
      const recovered: CompositionRun[] = []
      for (const row of rows) {
        const run = this.require(String(row.id))
        if (run.configurationPending) continue
        run.status = "unknown"
        for (const unit of run.units) if (unit.status === "running") unit.status = "unknown"
        recovered.push(this.save(run))
      }
      return recovered
    })
  }
}
