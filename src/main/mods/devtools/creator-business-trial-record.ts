import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
import type { DevelopmentBusinessTrialStatus } from "../../../shared/mods/development"
import type { HarnessProjectMetadata } from "../../../shared/harness-board-types"
import {
  parseCompositionUnitContext,
  type CompositionUnitContextSelection
} from "../../../shared/project-runtime/composition-api"
import type { DevelopmentScope } from "../v2/development-session"
import type { PluginMetadata } from "../../types"

export interface BusinessTrialCandidate {
  copyId: string
  digest: string
  name: string
  version: string
  sources: Array<{ pluginId: string; directory: string; identity: string; digest: string }>
}
export interface CreatorBusinessTrialRecord {
  schemaVersion: 1
  version: number
  id: string
  scope: DevelopmentScope
  planId: string
  candidate: BusinessTrialCandidate
  goal: string
  phase: DevelopmentBusinessTrialStatus["phase"]
  turnId?: string
  accountingRunId?: string
  settled: boolean
  nonce: string
  workspace?: string
  workspaceIdentity?: string
  packageDigest?: string
  plugin?: PluginMetadata
  project?: HarnessProjectMetadata
  featureId: string
  selection?: CompositionUnitContextSelection
  runId?: string
  error?: string
  feedback: Array<{ id: string; at: number; message: string }>
  physical?: Array<{ threadId: string; requestId: string; confirmed?: boolean }>
  stopRequested?: boolean
}
export interface CreatorBusinessTrialProofBinding {
  accountingRunId?: string
  root: string
  packageDigest: string
  candidate: BusinessTrialCandidate
  plugin: PluginMetadata
  workspace: string
  workspaceIdentity: string
  featureId: string
  scope: DevelopmentScope
  planId: string
  goal: string
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const hash = /^[a-f0-9]{64}$/
const phases = new Set([
  "needs-confirmation",
  "preparing",
  "needs-configuration",
  "ready",
  "starting",
  "running",
  "completed",
  "failed",
  "unknown",
  "cancelled"
])
function invalid(): never {
  throw Error("BUSINESS_TRIAL_RECORD_INVALID")
}
function object(value: unknown, required: string[], optional: string[] = []) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    return invalid()
  const row = value as Record<string, unknown>
  if (
    required.some((key) => !Object.hasOwn(row, key)) ||
    Object.keys(row).some((key) => !required.includes(key) && !optional.includes(key))
  )
    return invalid()
  return row
}
function text(value: unknown, max: number, empty = false, multiline = false): string {
  if (
    typeof value !== "string" ||
    value.length > max ||
    (!empty && !value.trim()) ||
    (!multiline &&
      [...value].some((character) => {
        const code = character.charCodeAt(0)
        return code === 127 || code < 32
      }))
  )
    return invalid()
  return value
}
function absolute(value: unknown) {
  const path = text(value, 32768)
  if (!isAbsolute(path)) return invalid()
  return path
}
function digest(value: unknown) {
  if (typeof value !== "string" || !hash.test(value)) return invalid()
  return value
}
function integer(value: unknown, minimum = 0) {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) return invalid()
}
function boolean(value: unknown) {
  if (typeof value !== "boolean") invalid()
}
function validateScope(value: unknown) {
  const scope = object(value, ["threadId", "workspace", "incarnation"])
  text(scope.threadId, 256)
  absolute(scope.workspace)
  const incarnation = object(scope.incarnation, ["token", "legacyCreatedAt"])
  if (incarnation.token !== null) text(incarnation.token, 256)
  integer(incarnation.legacyCreatedAt)
}
function validateCandidate(value: unknown) {
  const candidate = object(value, ["copyId", "digest", "name", "version", "sources"])
  text(candidate.copyId, 256)
  digest(candidate.digest)
  text(candidate.name, 256)
  text(candidate.version, 128)
  if (!Array.isArray(candidate.sources) || candidate.sources.length > 8) invalid()
  const seen = new Set<string>()
  for (const value of candidate.sources) {
    const source = object(value, ["pluginId", "directory", "identity", "digest"])
    text(source.pluginId, 256)
    absolute(source.directory)
    digest(source.identity)
    digest(source.digest)
    const key = JSON.stringify(source)
    if (seen.has(key)) invalid()
    seen.add(key)
  }
}
function validatePlugin(value: unknown) {
  const plugin = object(
    value,
    [
      "id",
      "name",
      "version",
      "path",
      "enabled",
      "description",
      "author",
      "createdAt",
      "updatedAt",
      "skillCount",
      "mcpServerCount"
    ],
    [
      "hookCount",
      "modCount",
      "businessModCount",
      "businessExtensionCount",
      "hookPath",
      "origin",
      "useScenario",
      "hasProjectMode"
    ]
  )
  for (const key of ["id", "name", "version"]) text(plugin[key], 256)
  absolute(plugin.path)
  boolean(plugin.enabled)
  for (const key of ["description", "author", "createdAt", "updatedAt"])
    text(plugin[key], key === "description" ? 8192 : 256, true, key === "description")
  for (const key of [
    "skillCount",
    "mcpServerCount",
    "hookCount",
    "modCount",
    "businessModCount",
    "businessExtensionCount"
  ])
    if (plugin[key] !== undefined) integer(plugin[key])
  if (plugin.hookPath !== undefined) {
    const path = text(plugin.hookPath, 512)
    if (
      /[\\:]/.test(path) ||
      path.split("/").some((part) => !part || part === "." || part === "..")
    )
      invalid()
  }
  if (plugin.origin !== undefined && !["local", "market"].includes(String(plugin.origin))) invalid()
  if (plugin.useScenario !== undefined) text(plugin.useScenario, 8192, true, true)
  if (plugin.hasProjectMode !== undefined) boolean(plugin.hasProjectMode)
}
function validateProject(value: unknown) {
  const project = object(
    value,
    [
      "projectId",
      "name",
      "description",
      "projectCode",
      "projectDir",
      "projectFromLean",
      "workspacePath",
      "systemId",
      "systemName",
      "harness-adapter",
      "lifecycle"
    ],
    ["creator", "systemConstraintFirstLoadedAt", "managedRunFirstStartedAt"]
  )
  for (const key of ["projectId", "name", "projectCode", "projectDir"]) text(project[key], 256)
  for (const key of ["description", "systemId", "systemName"]) text(project[key], 8192, true, true)
  absolute(project.workspacePath)
  boolean(project.projectFromLean)
  const adapter = object(project["harness-adapter"], ["id", "name", "type"], ["version"])
  text(adapter.id, 256)
  text(adapter.name, 256)
  if (adapter.type !== "plugin") invalid()
  if (adapter.version !== undefined) text(adapter.version, 128)
  const lifecycle = object(project.lifecycle, ["status", "createAt"], ["updateAt"])
  if (!["active", "archived"].includes(String(lifecycle.status))) invalid()
  text(lifecycle.createAt, 128)
  if (lifecycle.updateAt !== undefined) text(lifecycle.updateAt, 128)
  for (const key of ["systemConstraintFirstLoadedAt", "managedRunFirstStartedAt"])
    if (project[key] !== undefined) text(project[key], 128)
  if (project.creator !== undefined) {
    const creator = object(
      project.creator,
      [],
      ["sapId", "ystId", "userName", "orgName", "pathName", "upperOrgLv0", "upperOrgLv1"]
    )
    for (const value of Object.values(creator)) text(value, 1024, true)
  }
}

/** Pure persistent shape/ownership validation. No directory reads, approvals or content cache. */
export function parseCreatorBusinessTrialRecord(
  raw: string,
  id: string,
  options: { root: string; packagesRoot: string }
): CreatorBusinessTrialRecord {
  if (
    Buffer.byteLength(raw) > 256 * 1024 ||
    !id.startsWith("creator-business-trial:") ||
    !uuid.test(id.slice("creator-business-trial:".length))
  )
    invalid()
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return invalid()
  }
  const row = object(
    value,
    [
      "schemaVersion",
      "version",
      "id",
      "scope",
      "planId",
      "candidate",
      "goal",
      "phase",
      "settled",
      "nonce",
      "featureId",
      "feedback"
    ],
    [
      "turnId",
      "accountingRunId",
      "workspace",
      "workspaceIdentity",
      "packageDigest",
      "plugin",
      "project",
      "selection",
      "runId",
      "error",
      "physical",
      "stopRequested"
    ]
  )
  if (
    row.schemaVersion !== 1 ||
    row.id !== id ||
    !phases.has(String(row.phase)) ||
    typeof row.nonce !== "string" ||
    !uuid.test(row.nonce)
  )
    invalid()
  integer(row.version, 1)
  validateScope(row.scope)
  validateCandidate(row.candidate)
  text(row.planId, 256)
  text(row.goal, 8000, false, true)
  text(row.featureId, 256)
  boolean(row.settled)
  if (row.stopRequested !== undefined) boolean(row.stopRequested)
  for (const key of ["turnId", "runId", "accountingRunId"])
    if (row[key] !== undefined) text(row[key], 256)
  if (row.error !== undefined) text(row.error, 8192, true, true)
  if (!Array.isArray(row.feedback) || row.feedback.length > 8) invalid()
  const feedbackIds = new Set<string>()
  for (const value of row.feedback) {
    const feedback = object(value, ["id", "at", "message"])
    const key = text(feedback.id, 256)
    if (feedbackIds.has(key)) invalid()
    feedbackIds.add(key)
    integer(feedback.at)
    text(feedback.message, 4000, false, true)
  }
  if (row.physical !== undefined) {
    if (!Array.isArray(row.physical) || row.physical.length > 64) invalid()
    const seen = new Set<string>()
    for (const value of row.physical) {
      const physical = object(value, ["threadId", "requestId"], ["confirmed"])
      const key = JSON.stringify([text(physical.threadId, 256), text(physical.requestId, 256)])
      if (seen.has(key)) invalid()
      seen.add(key)
      if (physical.confirmed !== undefined) boolean(physical.confirmed)
    }
  }
  if (row.selection !== undefined) parseCompositionUnitContext(row.selection)
  if (row.workspace !== undefined) {
    const workspace = absolute(row.workspace)
    const path = relative(resolve(options.root), resolve(workspace)).split(/[\\/]/)
    if (path.length !== 2 || !/^trial-[a-zA-Z0-9]{6}$/.test(path[0]) || path[1] !== "workspace")
      invalid()
    const identity = text(row.workspaceIdentity, 32768 + 128)
    if (
      !identity.startsWith(workspace + ":") ||
      !/^-?\d+:-?\d+$/.test(identity.slice(workspace.length + 1))
    )
      invalid()
  } else if (row.workspaceIdentity !== undefined) invalid()
  if (row.packageDigest !== undefined) digest(row.packageDigest)
  if (row.plugin !== undefined) validatePlugin(row.plugin)
  if (row.project !== undefined) validateProject(row.project)
  const record = value as CreatorBusinessTrialRecord
  if (
    !!record.plugin !== !!record.packageDigest ||
    (record.plugin &&
      (!record.workspace ||
        record.plugin.id !== id ||
        record.plugin.name !== record.candidate.name ||
        record.plugin.version !== record.candidate.version ||
        !record.plugin.enabled ||
        record.plugin.path !==
          join(resolve(options.packagesRoot), record.packageDigest!, "package")))
  )
    invalid()
  if (
    record.project &&
    (!record.workspace ||
      !record.plugin ||
      record.project.projectId !== id ||
      record.project.name !== record.candidate.name ||
      record.project.description !== record.goal ||
      record.project.workspacePath !== dirname(record.workspace) ||
      record.project.projectDir !== basename(record.workspace) ||
      record.project["harness-adapter"].id !== record.plugin.id ||
      record.project["harness-adapter"].name !== record.plugin.name ||
      record.project["harness-adapter"].version !== record.plugin.version)
  )
    invalid()
  if ((record.runId || record.physical?.length) && !record.project) invalid()
  if (
    ["needs-configuration", "ready", "starting", "running"].includes(record.phase) &&
    !record.plugin
  )
    invalid()
  if (record.phase === "running" && !record.project) invalid()
  if (
    record.phase === "completed" &&
    (!record.project ||
      !record.runId ||
      !record.physical?.length ||
      record.physical.some((item) => item.confirmed !== true))
  )
    invalid()
  if (
    record.phase === "needs-confirmation" &&
    (record.workspace || record.plugin || record.project || record.runId || record.physical?.length)
  )
    invalid()
  return record
}

/** The process-local proof only identifies what was captured; callers still run live owner,
 * grant and complete source checks. Historical terminal records do not need a live proof. */
export function assertCreatorBusinessTrialProofBinding(
  record: CreatorBusinessTrialRecord,
  proof: CreatorBusinessTrialProofBinding
): void {
  const project = record.project
  if (
    !record.plugin ||
    !record.workspace ||
    !record.packageDigest ||
    record.plugin.path !== proof.root ||
    record.packageDigest !== proof.packageDigest ||
    record.workspace !== proof.workspace ||
    record.workspaceIdentity !== proof.workspaceIdentity ||
    record.featureId !== proof.featureId ||
    record.goal !== proof.goal ||
    record.planId !== proof.planId ||
    record.accountingRunId !== proof.accountingRunId ||
    JSON.stringify(record.scope) !== JSON.stringify(proof.scope) ||
    JSON.stringify(record.plugin) !== JSON.stringify(proof.plugin) ||
    JSON.stringify(record.candidate) !== JSON.stringify(proof.candidate) ||
    (record.phase === "running" && !project) ||
    (project &&
      (project.projectId !== record.id ||
        project.lifecycle.status !== "active" ||
        project.name !== record.candidate.name ||
        project.description !== record.goal ||
        project.workspacePath !== dirname(proof.workspace) ||
        project.projectDir !== basename(proof.workspace) ||
        project["harness-adapter"].id !== proof.plugin.id ||
        project["harness-adapter"].name !== proof.plugin.name ||
        project["harness-adapter"].version !== proof.plugin.version))
  )
    throw Error("BUSINESS_TRIAL_PROOF_CHANGED")
}
