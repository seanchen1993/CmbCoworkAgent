import { DatabaseSync } from "node:sqlite"
import { basename, dirname, join } from "node:path"
import { mkdirSync } from "node:fs"
import type { PluginMetadata } from "../../types"
import type { HarnessProjectMetadata } from "../../../shared/harness-board-types"
import type { InternalHarnessProjectContext, InternalHarnessProjectWorkspaceIndex } from "../internal-project-context"
import { registerInternalHarnessProjectProvider } from "../internal-project-context"
import { compositionText } from "../../../shared/project-runtime/composition"
import { runtimeDigest, runtimeDirectory, runtimeDirectoryIdentity } from "./safe-files"
import { readRuntimeScopedFileAsync } from "./safe-files-async"
import { RetainedPackageSnapshots } from "./package-snapshots"
import { parseCompositionUnitContext, type CompositionUnitContextSelection } from "../../../shared/project-runtime/composition-api"
import type { HarnessDeployUnitMapping } from "../../../shared/harness-board-types"
import type { CompositionWorkspaceObservation } from "./composition-store"

export function internalContextDeployUnitMappings(record: Pick<CompositionInternalProject, "workspace" | "contextSelection">): HarnessDeployUnitMapping[] {
  return record.contextSelection?.deployUnitIds.map(id => ({
    deployUnitIdMapping: `composition:${runtimeDigest(id)}`,
    deployUnitId: id,
    localRepoPath: record.workspace
  })) ?? []
}

export interface CompositionInternalProject {
  contextSelection?: CompositionUnitContextSelection
  projectId: string
  parentProjectId: string
  compositionRunId: string
  unitId: string
  featureId: string
  goal: string
  workspace: string
  /** Host-captured at original creation. Old records retain the original full-context path. */
  workspaceIdentity?: string
  plugin: PluginMetadata
  packageDigest: string
  workflow?: import("../../../shared/project-runtime/composition").ProjectCompositionUnit["workflow"]
  project: HarnessProjectMetadata
  phase:
    | "registered"
    | "initializing"
    | "initialized"
    | "creating-feature"
    | "feature-created"
    | "starting"
    | "running"
    | "unknown"
  engineRunId?: string
}

/** Hidden execution metadata lives separately; original visible project/feature stores are untouched. */
export class CompositionInternalProjects {
  private readonly db: DatabaseSync
  private readonly verified = new Map<
    string,
    { root: string; rootIdentity: string; assertCurrent(): void; config: Record<string, unknown> }
  >()
  constructor(
    path: string,
    private readonly assertScope: (
      record: CompositionInternalProject,
      kind?: "authority"
    ) => CompositionWorkspaceObservation | void
  ) {
    mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path, { timeout: 1000 })
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS internal_projects (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, digest TEXT NOT NULL, data TEXT NOT NULL);`)
  }
  async prepare(
    plugin: PluginMetadata,
    packageDigest: string,
    signal?: AbortSignal
  ): Promise<void> {
    const existing = this.verified.get(packageDigest)
    if (existing) {
      existing.assertCurrent()
      if (existing.root !== plugin.path) throw Error("COMPOSITION_INTERNAL_SOURCE_CHANGED")
      return
    }
    const snapshots = new RetainedPackageSnapshots(dirname(dirname(plugin.path)))
    if (plugin.path !== join(snapshots.root, packageDigest, "package"))
      throw Error("COMPOSITION_INTERNAL_SOURCE_CHANGED")
    const assertCurrent = await snapshots.captureGuardAsync(packageDigest, signal)
    const board = await readRuntimeScopedFileAsync(
      plugin.path,
      "board_core/board_config.json",
      256 * 1024
    )
    if (!board.bytes) throw Error("COMPOSITION_INTERNAL_BOARD_REQUIRED")
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(board.bytes))
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw Error("COMPOSITION_INTERNAL_BOARD_INVALID")
    assertCurrent()
    this.verified.set(packageDigest, {
      root: plugin.path,
      rootIdentity: runtimeDirectoryIdentity(plugin.path),
      assertCurrent,
      config: value as Record<string, unknown>
    })
  }
  close(): void {
    this.verified.clear()
    this.db.close()
  }
  register(): () => void {
    return registerInternalHarnessProjectProvider(
      (id) => this.context(id),
      (id) => this.captureIdentityGuard(id),
      (id) => this.workspaceIndex(id)
    )
  }
  create(
    input: Omit<CompositionInternalProject, "phase" | "projectId" | "project">,
    parent: HarnessProjectMetadata
  ): CompositionInternalProject {
    const workspace = runtimeDirectory(input.workspace)
    const projectId = `composition-legacy:${compositionText(input.compositionRunId)}:${compositionText(input.unitId)}`
    const project: HarnessProjectMetadata = {
      ...structuredClone(parent),
      projectId,
      name: parent.name,
      description: input.goal,
      workspacePath: dirname(workspace),
      projectDir: basename(workspace),
      projectCode: basename(workspace),
      "harness-adapter": {
        id: input.plugin.id,
        name: input.plugin.name,
        version: input.plugin.version,
        type: "plugin"
      },
      lifecycle: { status: "active", createAt: new Date().toISOString() }
    }
    const record: CompositionInternalProject = {
      ...structuredClone(input),
      workspace,
      workspaceIdentity: runtimeDirectoryIdentity(workspace),
      projectId,
      project,
      phase: "registered"
    }
    this.assertScope(record)
    this.db.exec("BEGIN IMMEDIATE")
    try {
      const existing = this.get(projectId)
      if (existing) {
        if (
          existing.workspace !== workspace ||
          existing.packageDigest !== input.packageDigest ||
          existing.plugin.id !== input.plugin.id ||
          existing.goal !== input.goal ||
          existing.featureId !== input.featureId ||
          JSON.stringify(existing.workflow) !== JSON.stringify(input.workflow) ||
          JSON.stringify(existing.contextSelection) !== JSON.stringify(input.contextSelection)
        )
          throw Error("COMPOSITION_INTERNAL_IDENTITY_CHANGED")
        this.db.exec("COMMIT")
        return existing
      }
      const data = JSON.stringify(record)
      this.db
        .prepare("INSERT INTO internal_projects VALUES (?,1,?,?)")
        .run(projectId, runtimeDigest(data), data)
      this.db.exec("COMMIT")
      return record
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    }
  }
  /** Fresh original owner/directory facts only; full context and token boundaries still hash content. */
  private workspaceIndex(projectId: string): InternalHarnessProjectWorkspaceIndex | undefined {
    const record = this.get(projectId)
    if (!record) return undefined
    const observed = this.assertScope(record, "authority")
    const verified = this.verified.get(record.packageDigest)
    if (!verified || verified.root !== record.plugin.path)
      throw Error("COMPOSITION_INTERNAL_SOURCE_NOT_ADMITTED")
    if (runtimeDirectoryIdentity(verified.root) !== verified.rootIdentity)
      throw Error("COMPOSITION_INTERNAL_SOURCE_CHANGED")
    const adapter = record.project["harness-adapter"]
    if (record.projectId !== `composition-legacy:${record.compositionRunId}:${record.unitId}` ||
      adapter.id !== record.plugin.id || adapter.name !== record.plugin.name ||
      adapter.version !== record.plugin.version)
      throw Error("COMPOSITION_INTERNAL_IDENTITY_CHANGED")
    if (record.workspaceIdentity === undefined) {
      const original = this.context(projectId)
      return original ? { projectId, featureId: original.featureId, workspace: record.workspace } : undefined
    }
    if ((observed && observed.workspace !== record.workspace) ||
      (observed?.identity ?? runtimeDirectoryIdentity(record.workspace)) !== record.workspaceIdentity)
      throw Error("COMPOSITION_WORKSPACE_OWNER_CHANGED")
    return { projectId, featureId: record.featureId, workspace: record.workspace }
  }
  get(projectId: string): CompositionInternalProject | undefined {
    const row = this.db
      .prepare("SELECT digest,data FROM internal_projects WHERE id=?")
      .get(projectId)
    if (!row) return undefined
    const data = String(row.data)
    if (runtimeDigest(data) !== row.digest) throw Error("COMPOSITION_INTERNAL_STORAGE_CHANGED")
    const record = JSON.parse(data) as CompositionInternalProject
    if (record.contextSelection !== undefined) parseCompositionUnitContext(record.contextSelection)
    if (
      record.projectId !== projectId ||
      record.project.projectId !== projectId ||
      join(record.project.workspacePath, record.project.projectDir) !== record.workspace
    )
      throw Error("COMPOSITION_INTERNAL_STORAGE_CHANGED")
    return record
  }
  advance(
    projectId: string,
    expected: CompositionInternalProject["phase"],
    phase: CompositionInternalProject["phase"],
    engineRunId?: string
  ): CompositionInternalProject {
    this.db.exec("BEGIN IMMEDIATE")
    try {
      const record = this.get(projectId)
      if (!record || record.phase !== expected) throw Error("COMPOSITION_INTERNAL_PHASE_CHANGED")
      this.assertScope(record)
      const next = { ...record, phase, ...(engineRunId ? { engineRunId } : {}) }
      const data = JSON.stringify(next)
      this.db
        .prepare("UPDATE internal_projects SET revision=revision+1,digest=?,data=? WHERE id=?")
        .run(runtimeDigest(data), data, projectId)
      this.db.exec("COMMIT")
      return next
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    }
  }
  /** Fresh identity and ownership on every getter, without repeating package content admission. */
  private captureIdentityGuard(projectId: string): () => void {
    const identity = () => {
      const record = this.get(projectId)
      if (!record) throw Error("COMPOSITION_INTERNAL_IDENTITY_CHANGED")
      const observed = this.assertScope(record, "authority")
      const verified = this.verified.get(record.packageDigest)
      if (!verified || verified.root !== record.plugin.path)
        throw Error("COMPOSITION_INTERNAL_SOURCE_NOT_ADMITTED")
      if (record.workspaceIdentity === undefined) this.context(projectId)
      else if ((observed && observed.workspace !== record.workspace) ||
        (observed?.identity ?? runtimeDirectoryIdentity(record.workspace)) !== record.workspaceIdentity)
        throw Error("COMPOSITION_WORKSPACE_OWNER_CHANGED")
      const immutable: Partial<CompositionInternalProject> = { ...record }
      delete immutable.phase
      delete immutable.engineRunId
      return runtimeDigest(JSON.stringify(immutable))
    }
    const expected = identity()
    return () => {
      if (identity() !== expected) throw Error("COMPOSITION_INTERNAL_IDENTITY_CHANGED")
    }
  }
  context(projectId: string): InternalHarnessProjectContext | undefined {
    const record = this.get(projectId)
    if (!record) return undefined
    this.assertScope(record)
    const verified = this.verified.get(record.packageDigest)
    if (!verified || verified.root !== record.plugin.path)
      throw Error("COMPOSITION_INTERNAL_SOURCE_NOT_ADMITTED")
    verified.assertCurrent()
    runtimeDirectory(record.workspace)
    return {
      parentProjectId: record.parentProjectId,
      compositionRunId: record.compositionRunId,
      unitId: record.unitId,
      featureId: record.featureId,
      goal: record.goal,
      context: {
        project: record.project,
        plugin: record.plugin,
        configSnapshot: { value: structuredClone(verified.config), error: null },
        projectDirectoryExists: true,
        selectedDeployUnits: internalContextDeployUnitMappings(record),
        sessionContextInjectionSource: "plugin",
        leanToken: ""
      },
      featureBinding: {
        projectId,
        featureId: record.featureId,
        selectedDeployUnitMappings: internalContextDeployUnitMappings(record),
        sessionWorkspace: { source: "directory", path: record.workspace },
        sessionContextInjectionSource: "plugin",
        createdAt: record.project.lifecycle.createAt,
        updatedAt: record.project.lifecycle.createAt
      }
    }
  }
}
