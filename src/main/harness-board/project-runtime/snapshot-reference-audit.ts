import { existsSync, lstatSync } from "node:fs"
import { join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import type { SnapshotReferenceAudit } from "./snapshot-retention"
import { parseHostOperation, parseHostProjectState } from "./host-state-protocol"
import { parseProjectComposition } from "../../../shared/project-runtime/composition"
import { parseCompositionUnitContext, parseCompositionUnitContexts } from "../../../shared/project-runtime/composition-api"

export function projectSnapshotRoots(base: string): string[] {
  return [
    join(base, "local-projects", "packages"),
    join(base, "legacy-project-runtime", "packages"),
    join(base, "project-compositions", "legacy-packages"),
    join(base, "project-compositions", "capability-packages")
  ].map((path) => resolve(path))
}

/** Conservatively include every digest, including nested receipts and fields added by older writers. */
export function snapshotDigestsInRecord(value: unknown): Set<string> {
  const found = new Set<string>()
  const visit = (item: unknown, depth: number) => {
    if (depth > 64) throw Error("SNAPSHOT_REFERENCE_DEPTH")
    if (typeof item === "string") {
      if (/^[a-f0-9]{64}$/.test(item)) found.add(item)
      for (const match of item.matchAll(/(?:^|[\\/])([a-f0-9]{64})(?=[\\/]|$)/g))
        found.add(match[1])
    } else if (Array.isArray(item)) for (const child of item) visit(child, depth + 1)
    else if (item && typeof item === "object")
      for (const child of Object.values(item)) visit(child, depth + 1)
  }
  visit(value, 0)
  return found
}

interface Table {
  optional?: boolean
  columns: string[]
  json?: string[]
  requiresDigest?: boolean
  optionalJson?: string[]
  validate?(value: unknown): void
  references?(value: unknown): unknown
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("SNAPSHOT_REFERENCE_RECORD_INVALID")
  return value as Record<string, unknown>
}
function primaryDigest(value: unknown): void {
  const row = record(value)
  if (typeof row.packageDigest !== "string" || !/^[a-f0-9]{64}$/.test(row.packageDigest))
    throw Error("SNAPSHOT_REFERENCE_DIGEST_INVALID")
}
function legacy(value: unknown): void {
  primaryDigest(value)
  const row = record(value)
  if (row.schemaVersion !== 1) throw Error("SNAPSHOT_REFERENCE_SCHEMA_UNKNOWN")
  const allowed =
    row.operationId === undefined
      ? [
          "schemaVersion",
          "projectId",
          "workspace",
          "installedPluginId",
          "packageId",
          "packageVersion",
          "packageDigest",
          "enabledAt",
          "mods"
        ]
      : [
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
        ]
  if (Object.keys(row).length !== allowed.length || allowed.some((key) => !Object.hasOwn(row, key)))
    throw Error("SNAPSHOT_REFERENCE_SCHEMA_UNKNOWN")
}
function composition(value: unknown): void {
  const row = record(value)
  const definition = parseProjectComposition(row.definition)
  if (row.unitContexts !== undefined) parseCompositionUnitContexts(row.unitContexts, definition.units.map(unit => unit.id))
  if (
    !Number.isSafeInteger(row.version) ||
    ![
      "running",
      "waiting-approval",
      "succeeded",
      "failed",
      "cancel-requested",
      "cancelled",
      "unknown"
    ].includes(String(row.status))
  )
    throw Error("SNAPSHOT_REFERENCE_RECORD_INVALID")
  const allowed = [
    "id",
    "requestId",
    "version",
    "definition",
    "definitionDigest",
    "status",
    "units",
    "createdAt",
    "updatedAt",
    "configurationPending",
    "unitContexts"
  ]
  if (Object.keys(row).some((key) => !allowed.includes(key)))
    throw Error("SNAPSHOT_REFERENCE_SCHEMA_UNKNOWN")
  if (
    (row.configurationPending !== undefined && typeof row.configurationPending !== "boolean") ||
    (row.configurationPending &&
      (row.status !== "running" ||
        !Array.isArray(row.units) ||
        row.units.some((unit) => {
          const state = record(unit)
          return state.status !== "pending" || state.attemptId || state.engineRunId
        })))
  )
    throw Error("SNAPSHOT_REFERENCE_RECORD_INVALID")
}
function capabilitySources(value: unknown): void {
  if (!Array.isArray(value) || value.length > 16) throw Error("SNAPSHOT_REFERENCE_RECORD_INVALID")
  for (const source of value) {
    primaryDigest(source)
    const row = record(source)
    if (
      Object.keys(row).length !== 3 ||
      typeof row.pluginId !== "string" ||
      typeof row.capabilityId !== "string"
    )
      throw Error("SNAPSHOT_REFERENCE_SCHEMA_UNKNOWN")
  }
}
const databases: Array<{ path: string[]; tables: Record<string, Table>; hostSchema?: boolean }> = [
  {
    path: ["local-projects", "state.sqlite"],
    hostSchema: true,
    tables: {
      project_runtime_meta: { columns: ["key", "value"] },
      host_projects: {
        columns: ["id", "version", "data"],
        json: ["data"],
        requiresDigest: true,
        validate: (value) => {
          parseHostProjectState(value)
        }
      },
      host_operations: {
        columns: [
          "id",
          "project_id",
          "idempotency_key",
          "status",
          "data",
          "owner_nonce",
          "transition_result"
        ],
        json: ["data"],
        optionalJson: ["transition_result"],
        requiresDigest: true,
        validate: (value) => {
          parseHostOperation(value)
        }
      }
    }
  },
  {
    path: ["legacy-project-runtime", "operations.sqlite"],
    tables: {
      legacy_bindings: {
        columns: ["project_id", "workspace", "plugin_id", "data"],
        json: ["data"],
        requiresDigest: true,
        validate: legacy
      },
      legacy_operations: {
        columns: ["id", "project_id", "request_id", "workspace", "plugin_id", "status", "data"],
        json: ["data"],
        requiresDigest: true,
        validate: legacy
      }
    }
  },
  {
    path: ["project-compositions", "state.sqlite"],
    tables: {
      composition_runs: {
        columns: ["id", "project_id", "request_id", "version", "data"],
        json: ["data"],
        requiresDigest: true,
        validate: composition,
        references: value => ({ ...record(value), unitContexts: undefined })
      },
      composition_leases: { columns: ["workspace", "project_id", "run_id"] },
      composition_unit_workspaces: {
        columns: ["workspace", "run_id", "unit_id", "directory_identity", "directory_path"]
      }
    }
  },
  {
    path: ["project-compositions", "internal-projects.sqlite"],
    tables: {
      internal_projects: {
        columns: ["id", "revision", "digest", "data"],
        json: ["data"],
        requiresDigest: true,
        validate: value => {
          primaryDigest(value)
          const row = record(value)
          if (row.contextSelection !== undefined) parseCompositionUnitContext(row.contextSelection)
        },
        references: value => ({ ...record(value), contextSelection: undefined })
      }
    }
  },
  {
    path: ["project-compositions", "capabilities.sqlite"],
    tables: {
      project_capability_selections: {
        columns: ["project_id", "workspace", "revision", "sources"],
        json: ["sources"],
        validate: capabilitySources
      }
    }
  },
  {
    path: ["project-compositions", "stage-checks.sqlite"],
    tables: {
      contracts: { columns: ["run", "unit", "data"], json: ["data"] },
      transitions: { columns: ["id", "run", "unit", "status", "data"], optionalJson: ["data"] },
      receipts: { columns: ["seq", "run", "unit", "data"], json: ["data"] },
      source_baselines: {
        optional: true,
        columns: ["run", "unit", "data"],
        json: ["data"],
        requiresDigest: true,
        validate: (value) => {
          primaryDigest(value)
          const row = record(value)
          if (row.apiVersion !== "devclaw.source-baseline/v1" || !Array.isArray(row.files))
            throw Error("SNAPSHOT_REFERENCE_SCHEMA_UNKNOWN")
        }
      }
    }
  },
  {
    path: ["local-projects", "library.sqlite"],
    tables: {
      entries: { columns: ["id", "project_id", "data"], json: ["data"] },
      files: { columns: ["entry_id", "path", "bytes"] }
    }
  }
]

/** No constructors/migrations/writes, no UI pagination, and no status-based history expiry. */
export function auditProjectSnapshotReferences(
  base: string,
  root: string,
  nativeReferences: () => SnapshotReferenceAudit
): SnapshotReferenceAudit {
  const digests = new Set<string>(),
    blockers: string[] = []
  if (!projectSnapshotRoots(base).includes(resolve(root)))
    return { complete: false, digests, blockers: ["SNAPSHOT_ROOT_UNREGISTERED"] }
  const include = (text: unknown, required: boolean, validate?: (value: unknown) => void,
    references?: (value: unknown) => unknown): void => {
    if (typeof text !== "string" || Buffer.byteLength(text) > 16 * 1024 * 1024)
      throw Error("SNAPSHOT_REFERENCE_RECORD_INVALID")
    const value: unknown = JSON.parse(text)
    if (!value || typeof value !== "object") throw Error("SNAPSHOT_REFERENCE_RECORD_INVALID")
    validate?.(value)
    const found = snapshotDigestsInRecord(references ? references(value) : value)
    if (required && !found.size) throw Error("SNAPSHOT_REFERENCE_DIGEST_MISSING")
    for (const digest of found) digests.add(digest)
  }
  for (const specification of databases) {
    const path = join(base, ...specification.path)
    if (!existsSync(path)) continue
    let db: DatabaseSync | undefined
    try {
      const stat = lstatSync(path)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
        throw Error("SNAPSHOT_REFERENCE_DATABASE_UNSAFE")
      db = new DatabaseSync(path, { readOnly: true, timeout: 1000 })
      db.exec("BEGIN")
      const actual = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .all()
        .map((row) => String(row.name))
        .sort()
      if (
        actual.some((name) => !Object.hasOwn(specification.tables, name)) ||
        Object.entries(specification.tables).some(
          ([name, shape]) => !shape.optional && !actual.includes(name)
        )
      )
        throw Error("SNAPSHOT_REFERENCE_SCHEMA_UNKNOWN")
      for (const [table, shape] of Object.entries(specification.tables)) {
        if (shape.optional && !actual.includes(table)) continue
        const columns = db
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .map((row) => String(row.name))
        if (JSON.stringify(columns) !== JSON.stringify(shape.columns))
          throw Error("SNAPSHOT_REFERENCE_SCHEMA_UNKNOWN")
        // SQLite iterates every row; never borrow listProjects/listOperations' 50/200 item caps.
        const selected = [...(shape.json ?? []), ...(shape.optionalJson ?? [])]
        if (!selected.length) continue
        for (const row of db.prepare(`SELECT ${selected.join(",")} FROM ${table}`).iterate()) {
          for (const column of shape.json ?? [])
            include(row[column], !!shape.requiresDigest, shape.validate, shape.references)
          for (const column of shape.optionalJson ?? [])
            if (row[column] !== null) include(row[column], false)
        }
      }
      if (
        specification.hostSchema &&
        db.prepare("SELECT value FROM project_runtime_meta WHERE key='schema'").get()?.value !== "1"
      )
        throw Error("SNAPSHOT_REFERENCE_SCHEMA_UNKNOWN")
      db.exec("ROLLBACK")
    } catch (error) {
      blockers.push(
        `${specification.path.join("/")}: ${error instanceof Error ? error.message : "audit failed"}`
      )
    } finally {
      db?.close()
    }
  }
  try {
    const native = nativeReferences()
    for (const digest of native.digests) digests.add(digest)
    blockers.push(...native.blockers)
    if (!native.complete) blockers.push("SNAPSHOT_NATIVE_REFERENCE_AUDIT_INCOMPLETE")
  } catch {
    blockers.push("SNAPSHOT_NATIVE_REFERENCE_AUDIT_FAILED")
  }
  return { complete: blockers.length === 0, digests, blockers }
}
