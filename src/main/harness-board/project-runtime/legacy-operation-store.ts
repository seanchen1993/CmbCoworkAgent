import { DatabaseSync } from "node:sqlite"
import { randomUUID } from "node:crypto"
import type {
  LegacyProjectOperation,
  LegacyProjectRuntimeBinding
} from "../../../shared/project-runtime/legacy-operations"
import { hostDigest, hostRecord, hostStateError, hostText } from "./host-state-protocol"
import type { ProjectWorkspaceModeGuard } from "./workspace-mode-guard"

function timestamp(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) hostStateError("LEGACY_LEDGER_INVALID")
  return Number(value)
}
function binding(value: unknown): LegacyProjectRuntimeBinding {
  const raw = hostRecord(value, [
    "schemaVersion",
    "projectId",
    "workspace",
    "installedPluginId",
    "packageId",
    "packageVersion",
    "packageDigest",
    "enabledAt",
    "mods"
  ])
  if (raw.schemaVersion !== 1) hostStateError("LEGACY_LEDGER_VERSION")
  const mods = raw.mods === null ? null : hostRecord(raw.mods, ["modId", "digest", "grantEpoch"])
  return {
    schemaVersion: 1,
    projectId: hostText(raw.projectId),
    workspace: hostText(raw.workspace),
    installedPluginId: hostText(raw.installedPluginId),
    packageId: hostText(raw.packageId),
    packageVersion: hostText(raw.packageVersion),
    packageDigest: hostDigest(raw.packageDigest),
    mods: mods
      ? {
          modId: hostText(mods.modId),
          digest: hostDigest(mods.digest),
          grantEpoch: timestamp(mods.grantEpoch)
        }
      : null,
    enabledAt: timestamp(raw.enabledAt)
  }
}
function operation(value: unknown): LegacyProjectOperation {
  const raw = hostRecord(value, [
    "schemaVersion",
    "operationId",
    "projectId",
    "featureId",
    "workspace",
    "installedPluginId",
    "packageDigest",
    "threadId",
    "threadIncarnation",
    "requestId",
    "inputDigest",
    "status",
    "startedAt",
    "settledAt",
    "terminalCode",
    "businessStateValidity"
  ])
  if (
    raw.schemaVersion !== 1 ||
    raw.businessStateValidity !== "unknown" ||
    !["started", "succeeded", "failed", "cancelled", "unknown"].includes(String(raw.status))
  )
    hostStateError("LEGACY_LEDGER_INVALID")
  return {
    schemaVersion: 1,
    operationId: hostText(raw.operationId),
    projectId: hostText(raw.projectId),
    featureId: hostText(raw.featureId),
    workspace: hostText(raw.workspace),
    installedPluginId: hostText(raw.installedPluginId),
    packageDigest: hostDigest(raw.packageDigest),
    threadId: hostText(raw.threadId),
    threadIncarnation: hostText(raw.threadIncarnation),
    requestId: hostText(raw.requestId),
    inputDigest: hostDigest(raw.inputDigest),
    status: raw.status as LegacyProjectOperation["status"],
    startedAt: timestamp(raw.startedAt),
    settledAt: raw.settledAt === null ? null : timestamp(raw.settledAt),
    terminalCode: raw.terminalCode === null ? null : hostText(raw.terminalCode),
    businessStateValidity: "unknown"
  }
}

/** Cross-instance admission and durable result accounting, never a writer of plugin business state. */
export class LegacyOperationStore {
  private db: DatabaseSync
  private tickets = new WeakMap<object, string>()
  constructor(
    path: string,
    private readonly now = () => Date.now(),
    private readonly workspaceModeGuard?: ProjectWorkspaceModeGuard
  ) {
    this.db = new DatabaseSync(path)
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS legacy_bindings (project_id TEXT PRIMARY KEY, workspace TEXT NOT NULL, plugin_id TEXT NOT NULL, data TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS legacy_binding_scope ON legacy_bindings(workspace,plugin_id);
      CREATE TABLE IF NOT EXISTS legacy_operations (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, request_id TEXT NOT NULL, workspace TEXT NOT NULL, plugin_id TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(project_id,request_id));
      CREATE UNIQUE INDEX IF NOT EXISTS legacy_active_scope ON legacy_operations(workspace,plugin_id) WHERE status IN ('started','unknown');`)
  }
  close(): void {
    this.db.close()
  }
  private transaction<T>(work: () => T, workspace?: string): T {
    if (workspace && this.workspaceModeGuard)
      return this.workspaceModeGuard.run("legacy", workspace, () => this.transaction(work))
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
  getBinding(projectId: string): LegacyProjectRuntimeBinding | undefined {
    const row = this.db
      .prepare("SELECT data FROM legacy_bindings WHERE project_id=?")
      .get(projectId)
    return row ? binding(JSON.parse(String(row.data))) : undefined
  }
  enable(
    input: Omit<LegacyProjectRuntimeBinding, "schemaVersion" | "enabledAt">
  ): LegacyProjectRuntimeBinding {
    const next = binding({ ...input, schemaVersion: 1, enabledAt: this.now() })
    return this.transaction(() => {
      const previous = this.getBinding(next.projectId)
      if (previous) {
        if (
          JSON.stringify({ ...previous, enabledAt: 0 }) !==
          JSON.stringify({ ...next, enabledAt: 0 })
        )
          hostStateError("LEGACY_BINDING_ALREADY_FIXED")
        return previous
      }
      this.db
        .prepare("INSERT INTO legacy_bindings VALUES (?,?,?,?)")
        .run(next.projectId, next.workspace, next.installedPluginId, JSON.stringify(next))
      return next
    }, next.workspace)
  }
  get(id: string): LegacyProjectOperation | undefined {
    const row = this.db.prepare("SELECT data FROM legacy_operations WHERE id=?").get(id)
    return row ? operation(JSON.parse(String(row.data))) : undefined
  }
  /** Removes only opt-in routing. History and unknown ownership are never discarded. */
  disable(projectId: string): void {
    this.transaction(() => {
      if (
        this.db
          .prepare(
            "SELECT id FROM legacy_operations WHERE project_id=? AND status IN ('started','unknown')"
          )
          .get(projectId)
      )
        hostStateError("LEGACY_OPERATION_ACTIVE")
      this.db.prepare("DELETE FROM legacy_bindings WHERE project_id=?").run(projectId)
    })
  }
  list(projectId: string, limit = 50): LegacyProjectOperation[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
      hostStateError("LEGACY_LEDGER_LIMIT")
    return this.db
      .prepare("SELECT data FROM legacy_operations WHERE project_id=? ORDER BY rowid DESC LIMIT ?")
      .all(projectId, limit)
      .map((row) => operation(JSON.parse(String(row.data))))
  }
  admit(
    input: Pick<
      LegacyProjectOperation,
      | "projectId"
      | "featureId"
      | "workspace"
      | "installedPluginId"
      | "packageDigest"
      | "threadId"
      | "threadIncarnation"
      | "requestId"
      | "inputDigest"
    >
  ): { operation: LegacyProjectOperation; ticket: object } {
    const next = operation({
      ...input,
      schemaVersion: 1,
      operationId: randomUUID(),
      status: "started",
      startedAt: this.now(),
      settledAt: null,
      terminalCode: null,
      businessStateValidity: "unknown"
    })
    const result = this.transaction(() => {
      const owner = this.getBinding(next.projectId)
      if (
        !owner ||
        owner.workspace !== next.workspace ||
        owner.installedPluginId !== next.installedPluginId ||
        owner.packageDigest !== next.packageDigest
      )
        hostStateError("LEGACY_BINDING_CHANGED")
      if (
        this.db
          .prepare("SELECT id FROM legacy_operations WHERE project_id=? AND request_id=?")
          .get(next.projectId, next.requestId)
      )
        hostStateError("LEGACY_OPERATION_ALREADY_RECORDED")
      if (
        this.db
          .prepare(
            "SELECT id FROM legacy_operations WHERE workspace=? AND plugin_id=? AND status IN ('started','unknown')"
          )
          .get(next.workspace, next.installedPluginId)
      )
        hostStateError("LEGACY_OPERATION_ACTIVE")
      this.db
        .prepare("INSERT INTO legacy_operations VALUES (?,?,?,?,?,?,?)")
        .run(
          next.operationId,
          next.projectId,
          next.requestId,
          next.workspace,
          next.installedPluginId,
          next.status,
          JSON.stringify(next)
        )
      return next
    }, next.workspace)
    const ticket = Object.freeze({})
    this.tickets.set(ticket, result.operationId)
    return { operation: result, ticket }
  }
  settle(
    ticket: object,
    status: Exclude<LegacyProjectOperation["status"], "started">,
    code: string
  ): LegacyProjectOperation {
    const id = this.tickets.get(ticket) ?? hostStateError("LEGACY_TICKET_INVALID")
    return this.transaction(() => {
      const current = this.get(id) ?? hostStateError("LEGACY_OPERATION_MISSING")
      if (current.status !== "started") hostStateError("LEGACY_OPERATION_SETTLED")
      const next = operation({ ...current, status, terminalCode: code, settledAt: this.now() })
      this.db
        .prepare("UPDATE legacy_operations SET status=?,data=? WHERE id=?")
        .run(status, JSON.stringify(next), id)
      return next
    })
  }
  /** Startup only. No run is resumed and no unknown side effect relinquishes its scope. */
  recoverInterrupted(): string[] {
    return this.transaction(() => {
      const rows = this.db
        .prepare("SELECT data FROM legacy_operations WHERE status='started'")
        .all()
      return rows.map((row) => {
        const next = operation({ ...operation(JSON.parse(String(row.data))), status: "unknown" })
        this.db
          .prepare("UPDATE legacy_operations SET status='unknown',data=? WHERE id=?")
          .run(JSON.stringify(next), next.operationId)
        return next.operationId
      })
    })
  }
}
