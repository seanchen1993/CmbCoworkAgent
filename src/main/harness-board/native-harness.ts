import { createHash, randomUUID } from "node:crypto"
import { existsSync, mkdirSync, realpathSync } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import type {
  HarnessNativeFeatureBinding,
  HarnessProjectMetadata,
  HarnessProjectDetailViewModel,
  HarnessRunDetailViewModel,
  HarnessFeatureSummary,
  HarnessNodeStatus,
  HarnessStatus,
  HarnessSessionWorkspace,
  HarnessDeployUnitMapping,
  HarnessWorkflow,
  HarnessArtifact
} from "../../shared/harness-board-types"
import {
  parseProjectRuntimeManifest,
  projectRuntimeExtensionContract,
  PROJECT_RUNTIME_MAX_BYTES,
  type ProjectRuntimeManifest
} from "../../shared/project-runtime"
import type { HarnessHostFeatureInputs } from "../../shared/project-runtime/host-types"
import type { LocalProjectView } from "../../shared/project-runtime/platform-api"
import type { PluginStartUseIdentity } from "../../shared/plugin-start-use"
import { getOpenworkDir, getPlugins } from "../storage"
import { derivationContentIdentity, snapshotDerivationSource } from "../plugins/derivation-source"
import { readProjectRuntimeDescription } from "./project-runtime/description"
import { withHarnessStoreMutation } from "./async-json-store"
import {
  readRuntimeScopedFile,
  probeRuntimeScopedFile,
  runtimeDirectory,
  runtimeDirectoryIdentity
} from "./project-runtime/safe-files"
import { readRuntimeScopedFileAsync } from "./project-runtime/safe-files-async"
import { readProjectKnowledgeDeployUnits } from "./knowledge-deploy-units"
import { HARNESS_PROJECT_STORE_MAX_BYTES } from "./store-limits"
import { hostGoal, parseHarnessHostFeatureInputs } from "./project-runtime/host-state-protocol"
import { HOST_CONTEXT_MATERIAL_ROOT_LIMIT } from "../../shared/project-runtime/extension-contract"
import { resolveWorkflowWorktreeIsolationBoundary } from "../services/git-worktree"
import { resolveProjectKnowledgeBases } from "../services/knowledge-base-manager"

interface NativeFeatureRecord extends HarnessNativeFeatureBinding {
  manifest: ProjectRuntimeManifest
  sessionWorkspace: HarnessSessionWorkspace
  selectedDeployUnits: HarnessDeployUnitMapping[]
  createdAt: number
  goal?: string
  requiresKnowledge?: true
  packageMaterialRoots?: number
  harnessFeatureInputs?: HarnessHostFeatureInputs
}

export type NativeHarnessViewProjection = "summary" | "discussion"

export interface NativeHarnessRuntime {
  create(
    input: {
      projectId: string
      name: string
      goal: string
      workspace: string
      installedPluginId: string
      expectedPlugin: PluginStartUseIdentity
      harnessFeatureInputs?: HarnessHostFeatureInputs
    },
    guard?: () => void
  ): Promise<LocalProjectView>
  view(hostRunId: string, projection?: NativeHarnessViewProjection): LocalProjectView | undefined
}
type NativeFeaturePreflight = (input: {
  original: HarnessNativeFeatureBinding
  workspace: string
  assertCurrent(): void
}) => Promise<() => void>

let runtime: NativeHarnessRuntime | undefined
export function configureNativeHarnessRuntime(value: NativeHarnessRuntime): void {
  runtime = value
}
export function nativeHarnessRuntimeView(
  id: string,
  projection?: NativeHarnessViewProjection
): LocalProjectView | undefined {
  if (!runtime) throw Error("HARNESS_NATIVE_RUNTIME_UNAVAILABLE")
  return runtime.view(id, projection)
}

const NATIVE_FEATURE_ROWS =
  "SELECT project_id,feature_id,host_run_id,data FROM native_harness_features"
const MAX_DATE_TIMESTAMP = 8_640_000_000_000_000

/** Separate durable identity index; HostStore remains the only execution state owner. */
export class NativeHarnessFeatureStore {
  private readonly database: DatabaseSync
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true })
    this.database = new DatabaseSync(path)
    try {
      this.database.exec(`CREATE TABLE IF NOT EXISTS native_harness_features (
        project_id TEXT NOT NULL, feature_id TEXT NOT NULL, host_run_id TEXT NOT NULL UNIQUE,
        data TEXT NOT NULL, PRIMARY KEY (project_id, feature_id))`)
    } catch (error) {
      this.database.close()
      throw error
    }
  }
  private decode(row: Record<string, unknown> | undefined): NativeFeatureRecord | undefined {
    if (!row) return undefined
    if (typeof row.data !== "string") throw Error("HARNESS_NATIVE_BINDING_INVALID")
    const data = JSON.parse(row.data) as NativeFeatureRecord | null
    if (
      !data ||
      data.engine !== "host" ||
      !data.projectId ||
      data.projectId !== row.project_id ||
      !data.featureId ||
      data.featureId !== row.feature_id ||
      !data.hostRunId ||
      data.hostRunId !== row.host_run_id ||
      typeof data.title !== "string" ||
      (data.goal !== undefined && typeof data.goal !== "string") ||
      typeof data.createdAt !== "number" ||
      !Number.isFinite(data.createdAt) ||
      Math.abs(data.createdAt) > MAX_DATE_TIMESTAMP ||
      !isAbsolute(data.workspace) ||
      !isAbsolute(data.repositoryWorkspace) ||
      data.expectedPlugin?.pluginId !== data.installedPluginId ||
      !/^[a-f0-9]{64}$/.test(data.expectedPlugin.digest) ||
      (data.workspaceMode !== undefined && data.workspaceMode !== "selected-directory") ||
      (data.workspaceMode === "selected-directory" &&
        (typeof data.workspaceIdentity !== "string" ||
          !data.workspaceIdentity ||
          data.workspaceIdentity.length > 8192 ||
          !!data.worktree ||
          (data.repositoryWorkspaceIdentity !== undefined &&
            (typeof data.repositoryWorkspaceIdentity !== "string" ||
              !data.repositoryWorkspaceIdentity ||
              data.repositoryWorkspaceIdentity.length > 8192)) ||
          (!data.repositoryWorkspaceIdentity && data.workspace !== data.repositoryWorkspace))) ||
      (data.supportsDeployUnits !== undefined && data.supportsDeployUnits !== true) ||
      (data.requiresKnowledge !== undefined && (!data.supportsDeployUnits || data.requiresKnowledge !== true)) ||
      (data.packageMaterialRoots !== undefined && (!data.supportsDeployUnits ||
        !Number.isInteger(data.packageMaterialRoots) || data.packageMaterialRoots < 0 ||
        data.packageMaterialRoots >= HOST_CONTEXT_MATERIAL_ROOT_LIMIT)) ||
      (data.packageDigest !== undefined && !/^[a-f0-9]{64}$/.test(data.packageDigest))
    )
      throw Error("HARNESS_NATIVE_BINDING_INVALID")
    data.manifest = parseProjectRuntimeManifest(data.manifest)
    if (data.harnessFeatureInputs) {
      if (!data.supportsDeployUnits || !data.goal) throw Error("HARNESS_NATIVE_BINDING_INVALID")
      data.harnessFeatureInputs = parseHarnessHostFeatureInputs(data.harnessFeatureInputs)
    }
    return data
  }
  get(projectId: string, featureId: string): NativeFeatureRecord | undefined {
    return this.decode(
      this.database
        .prepare(`${NATIVE_FEATURE_ROWS} WHERE project_id=? AND feature_id=?`)
        .get(projectId, featureId)
    )
  }
  byRun(id: string): NativeFeatureRecord | undefined {
    return this.decode(
      this.database.prepare(`${NATIVE_FEATURE_ROWS} WHERE host_run_id=?`).get(id)
    )
  }
  list(projectId: string): NativeFeatureRecord[] {
    const rows = this.database
      .prepare(`${NATIVE_FEATURE_ROWS} WHERE project_id=? ORDER BY rowid`)
      .all(projectId)
    try {
      return rows.map((row) => this.decode(row)!)
    } catch (error) {
      // Classify stored records only. Database access failures reach the caller unchanged.
      throw Error("HARNESS_NATIVE_FEATURE_INDEX_UNREADABLE", { cause: error })
    }
  }
  insert(record: NativeFeatureRecord): void {
    this.database
      .prepare("INSERT INTO native_harness_features VALUES (?,?,?,?)")
      .run(record.projectId, record.featureId, record.hostRunId, JSON.stringify(record))
  }
  update(record: NativeFeatureRecord): void {
    if (
      this.database
        .prepare(
          "UPDATE native_harness_features SET data=? WHERE project_id=? AND feature_id=? AND host_run_id=?"
        )
        .run(JSON.stringify(record), record.projectId, record.featureId, record.hostRunId)
        .changes !== 1
    )
      throw Error("HARNESS_NATIVE_BINDING_CHANGED")
  }
  close(): void {
    this.database.close()
  }
}
let cached: { path: string; store: NativeHarnessFeatureStore } | undefined
let projectCache: { fingerprint: string; projects: HarnessProjectMetadata[] } | undefined
function store(): NativeHarnessFeatureStore {
  const path = join(getOpenworkDir(), "harness-native-features.sqlite")
  if (cached?.path !== path) {
    cached?.store.close()
    cached = { path, store: new NativeHarnessFeatureStore(path) }
  }
  return cached.store
}
function existingStore(): NativeHarnessFeatureStore | undefined {
  return existsSync(join(getOpenworkDir(), "harness-native-features.sqlite")) ? store() : undefined
}
export function closeNativeHarnessFeatureStore(): void {
  cached?.store.close()
  cached = undefined
  projectCache = undefined
}
function publicBinding(record: NativeFeatureRecord): HarnessNativeFeatureBinding {
  return {
    engine: record.engine,
    projectId: record.projectId,
    featureId: record.featureId,
    hostRunId: record.hostRunId,
    title: record.title,
    workspace: record.workspace,
    repositoryWorkspace: record.repositoryWorkspace,
    ...(record.workspaceMode
      ? {
          workspaceMode: record.workspaceMode,
          workspaceIdentity: record.workspaceIdentity,
          ...(record.repositoryWorkspaceIdentity
            ? {
                repositoryWorkspaceIdentity: record.repositoryWorkspaceIdentity
              }
            : {})
        }
      : {}),
    installedPluginId: record.installedPluginId,
    ...(record.supportsDeployUnits ? { supportsDeployUnits: true as const } : {}),
    expectedPlugin: structuredClone(record.expectedPlugin),
    ...(record.packageDigest ? { packageDigest: record.packageDigest } : {}),
    ...(record.goal ? { initialUserMessage: record.goal } : {}),
    ...(record.worktree ? { worktree: structuredClone(record.worktree) } : {})
  }
}
export function readNativeHarnessFeature(projectId: string, featureId: string) {
  const record = existingStore()?.get(projectId, featureId)
  return record && publicBinding(record)
}
export function findNativeHarnessFeatureByRunId(hostRunId: string) {
  const record = existingStore()?.byRun(hostRunId)
  return record && publicBinding(record)
}
export function observeDurableNativeHarnessProject(projectId: string) {
  const root = getOpenworkDir()
  const relative = "harness-board-projects.json"
  // A same-size overwrite can leave identical timestamps. Cache parsing by verified bytes.
  const { bytes, fingerprint, generation } = readRuntimeScopedFile(
    root, relative, HARNESS_PROJECT_STORE_MAX_BYTES
  )
  if (projectCache?.fingerprint !== fingerprint) {
    const value = bytes && JSON.parse(bytes.toString("utf8"))
    projectCache = { fingerprint, projects: value?.projects ?? [] }
  }
  return {
    fingerprint: generation ?? fingerprint,
    project: projectCache.projects.find((item) => item.projectId === projectId)
  }
}

function currentNativeHarnessProject(binding: HarnessNativeFeatureBinding): HarnessProjectMetadata {
  const { project } = observeDurableNativeHarnessProject(binding.projectId)
  assertNativeHarnessFeatureBinding(binding, project)
  return project as HarnessProjectMetadata
}

export function assertNativeHarnessFeatureCurrent(binding: HarnessNativeFeatureBinding): void {
  currentNativeHarnessProject(binding)
}

/** The caller supplies current host-owned project facts, never renderer metadata. */
export function assertNativeHarnessFeatureBinding(
  binding: HarnessNativeFeatureBinding,
  project: HarnessProjectMetadata | undefined,
  options: { allowArchivedRead?: boolean } = {}
): void {
  if (
    !project ||
    (project.lifecycle?.status !== "active" &&
      !(options.allowArchivedRead && project.lifecycle?.status === "archived")) ||
    project.nativeBinding?.engine !== "host" ||
    project.nativeBinding.installedPluginId !== binding.installedPluginId ||
    project["harness-adapter"]?.id !== binding.installedPluginId ||
    (binding.workspaceMode === "selected-directory"
      ? !!binding.worktree ||
        runtimeDirectoryIdentity(binding.workspace) !== binding.workspaceIdentity ||
        runtimeDirectoryIdentity(binding.repositoryWorkspace) !==
          (binding.repositoryWorkspaceIdentity ?? binding.workspaceIdentity)
      : (!binding.worktree && dirname(dirname(binding.workspace)) !== nativeProjectRoot(project)) ||
        (binding.worktree && binding.worktree.workspaceDirectory !== binding.workspace)) ||
    realpathSync(binding.workspace) !== binding.workspace
  )
    throw Error("HARNESS_NATIVE_PROJECT_CHANGED")
  const current = readNativeHarnessFeature(binding.projectId, binding.featureId)
  if (!current || JSON.stringify(current) !== JSON.stringify(binding))
    throw Error("HARNESS_NATIVE_BINDING_CHANGED")
}

/** Reading a stage for a normal conversation never starts a Host or an adapter. */
export function readNativeHarnessFeatureStage(projectId: string, featureId: string) {
  const record = existingStore()?.get(projectId, featureId)
  if (!record) throw Error("HARNESS_NATIVE_FEATURE_MISSING")
  const view = runtime ? recordView(record, "summary") : undefined
  if (!runtime && record.packageDigest) throw Error("HARNESS_NATIVE_RUNTIME_UNAVAILABLE")
  const manifest = view?.project.manifest ?? record.manifest
  const stage = manifest.stages[view?.project.stageIndex ?? 0]
  return stage ? { name: stage.title, status: stageStatus(view, stage.id) } : null
}

/** Read current discussion facts without creating a run, preparing actions or granting access. */
export function readNativeHarnessDiscussionState(projectId: string, featureId: string) {
  const record = existingStore()?.get(projectId, featureId)
  if (!record) throw Error("HARNESS_NATIVE_FEATURE_MISSING")
  const binding = publicBinding(record)
  assertNativeHarnessFeatureCurrent(binding)
  if (!runtime && record.packageDigest) throw Error("HARNESS_NATIVE_RUNTIME_UNAVAILABLE")
  const view = runtime ? recordView(record, "discussion") : undefined
  return structuredClone({
    binding,
    manifest: view?.project.manifest ?? record.manifest,
    goal: view?.project.goal ?? record.goal ?? null,
    stageIndex: view?.project.stageIndex ?? 0,
    status: view?.project.status ?? "not_started",
    version: view?.project.version ?? null,
    operations: view?.operations ?? [],
    inputWait: view?.inputWaitError
      ? { status: "unknown" as const, reason: "input_ledger_unreadable" }
      : view?.inputWait ?? null
  })
}

export async function nativeHarnessPlugin(id: string) {
  const plugin = getPlugins().find((item) => item.id === id)
  if (!plugin) return undefined
  const description = await readProjectRuntimeDescription(plugin.path)
  if (description?.status !== "ready" || description.manifest.mode !== "host") return undefined
  const file = await readRuntimeScopedFileAsync(
    plugin.path, "devclaw.project-runtime.json", PROJECT_RUNTIME_MAX_BYTES
  )
  if (!file.bytes || createHash("sha256").update(file.bytes).digest("hex") !== description.declarationDigest)
    throw Error("PROJECT_PACKAGE_IDENTITY_MISMATCH")
  const contract = projectRuntimeExtensionContract(JSON.parse(file.bytes.toString("utf8")))
  return { plugin, manifest: description.manifest,
    ...(contract?.context?.provider?.materials?.featureInputs ? { featureInputs: true as const } : {}) }
}

export function nativeProjectRoot(project: HarnessProjectMetadata): string {
  const parent = realpathSync(project.workspacePath)
  const root = resolve(parent, project.projectDir)
  if (dirname(root) !== parent || root === parent) throw Error("HARNESS_NATIVE_WORKSPACE_INVALID")
  return root
}
export function initializeNativeHarnessProject(project: HarnessProjectMetadata): void {
  const root = nativeProjectRoot(project)
  mkdirSync(root, { recursive: true })
  if (realpathSync(root) !== root) throw Error("HARNESS_NATIVE_WORKSPACE_INVALID")
}
function assertNativeFeatureConfiguration(
  sessionWorkspace: HarnessSessionWorkspace,
  selectedDeployUnits: readonly HarnessDeployUnitMapping[],
  featureInputs: boolean
): void {
  if (featureInputs && (sessionWorkspace?.source === "directory" ||
    (sessionWorkspace?.source === "deployUnit" &&
      selectedDeployUnits.some((unit) => unit.deployUnitId === sessionWorkspace.deployUnitId)))) {
    if (selectedDeployUnits.length) {
      try {
        parseHarnessHostFeatureInputs({
          selectedDeployUnits: [...new Set(selectedDeployUnits.map((unit) => unit.deployUnitId))],
          knowledgeRoots: []
        })
      } catch {
        throw Error("所选发布单元超过原生流程支持的数量或编号长度，请在编辑特性配置中调整。")
      }
    }
    return
  }
  if (sessionWorkspace?.source !== "directory" || selectedDeployUnits.length)
    throw Error(
      "原生项目请选择目录作为需求工作区；多仓库或部署单元请使用插件声明的配置，旧发布单元配置不会注入原生流程"
    )
}

export async function createNativeHarnessFeature(input: {
  project: HarnessProjectMetadata
  featureId: string
  repositoryWorkspace: string
  sessionWorkspace: HarnessSessionWorkspace
  selectedDeployUnits: HarnessDeployUnitMapping[]
  guard?: () => void | Promise<void>
}): Promise<HarnessNativeFeatureBinding> {
  const { project, featureId } = input
  return withHarnessStoreMutation(`native-feature:${project.projectId}:${featureId}`, async () => {
    await input.guard?.()
    if (project.lifecycle.status !== "active" || !project.nativeBinding)
      throw Error("HARNESS_NATIVE_PROJECT_UNAVAILABLE")
    if (store().get(project.projectId, featureId)) throw Error("该特性已存在")
    const source = await nativeHarnessPlugin(project.nativeBinding.installedPluginId)
    if (!source?.plugin.enabled) throw Error("PROJECT_PLUGIN_UNAVAILABLE")
    const snapshot = await snapshotDerivationSource(source.plugin.path)
    await input.guard?.()
    const manifestFile = snapshot.files.find((file) => file.path === "devclaw.project-runtime.json")
    if (!manifestFile) throw Error("PROJECT_PLUGIN_UNAVAILABLE")
    const rawManifest = JSON.parse(manifestFile.bytes.toString("utf8")) as unknown
    const manifest = parseProjectRuntimeManifest(rawManifest)
    const context = projectRuntimeExtensionContract(rawManifest)?.context
    const materials = context?.provider?.materials
    const featureInputs = project.nativeBinding.supportsDeployUnits === true
    if (featureInputs && !materials?.featureInputs) throw Error("PROJECT_PACKAGE_IDENTITY_MISMATCH")
    assertNativeFeatureConfiguration(input.sessionWorkspace, input.selectedDeployUnits, featureInputs)
    if (
      manifest.mode !== "host" ||
      manifest.plugin.id !== source.plugin.name ||
      manifest.plugin.version !== source.plugin.version
    )
      throw Error("PROJECT_PACKAGE_IDENTITY_MISMATCH")
    const expectedPlugin = {
      pluginId: source.plugin.id,
      name: source.plugin.name,
      version: source.plugin.version,
      digest: derivationContentIdentity(snapshot.files)
    }
    const root = nativeProjectRoot(project)
    if (realpathSync(root) !== root) throw Error("HARNESS_NATIVE_WORKSPACE_INVALID")
    const hostRunId = `harness-feature:${randomUUID()}`
    const repositoryWorkspace = runtimeDirectory(realpathSync(input.repositoryWorkspace))
    const workspaceIdentity = runtimeDirectoryIdentity(repositoryWorkspace)
    await input.guard?.()
    if (runtimeDirectoryIdentity(repositoryWorkspace) !== workspaceIdentity)
      throw Error("HARNESS_NATIVE_WORKSPACE_INVALID")
    const record: NativeFeatureRecord = {
      engine: "host",
      projectId: project.projectId,
      featureId,
      hostRunId,
      title: featureId,
      workspace: repositoryWorkspace,
      repositoryWorkspace,
      workspaceMode: "selected-directory",
      workspaceIdentity,
      repositoryWorkspaceIdentity: workspaceIdentity,
      installedPluginId: source.plugin.id,
      expectedPlugin,
      ...(featureInputs ? { supportsDeployUnits: true as const } : {}),
      ...(featureInputs && context?.knowledge.required ? { requiresKnowledge: true as const } : {}),
      ...(featureInputs ? { packageMaterialRoots: materials!.roots.filter(root => root.source === "package").length } : {}),
      manifest,
      sessionWorkspace: input.sessionWorkspace,
      selectedDeployUnits: input.selectedDeployUnits,
      createdAt: Date.now()
    }
    store().insert(record)
    return publicBinding(record)
  })
}

export async function ensureNativeHarnessFeatureRun(
  projectId: string,
  featureId: string,
  goal: string,
  guard: () => void = () => {},
  executionWorkspace?: string,
  preflight?: NativeFeaturePreflight
): Promise<LocalProjectView> {
  return withHarnessStoreMutation(`native-feature:${projectId}:${featureId}`, async () => {
    const hostRuntime = runtime
    if (!hostRuntime) throw Error("HARNESS_NATIVE_RUNTIME_UNAVAILABLE")
    guard()
    const record = store().get(projectId, featureId)
    if (!record) throw Error("HARNESS_NATIVE_FEATURE_MISSING")
    const original = publicBinding(record)
    const initialProject = currentNativeHarnessProject(original)
    if (record.packageDigest && !hostRuntime.view(record.hostRunId))
      throw Error("HARNESS_NATIVE_EXECUTION_MISSING")
    const originalRecord = JSON.stringify(record)
    const firstStart = !record.goal
    const pinnedInputs = record.harnessFeatureInputs
    const pendingKnowledge =
      !firstStart && !record.packageDigest && !!pinnedInputs?.knowledgeRoots.length &&
      !hostRuntime.view(record.hostRunId)
    const selectingWorkspace = firstStart && !record.packageDigest &&
      record.workspaceMode === "selected-directory"
    let workspace = record.workspace
    if (executionWorkspace !== undefined) {
      if (
        typeof executionWorkspace !== "string" ||
        !isAbsolute(executionWorkspace) ||
        executionWorkspace.length > 4096
      )
        throw Error("HARNESS_NATIVE_WORKSPACE_INVALID")
      workspace = runtimeDirectory(realpathSync(executionWorkspace))
      if (!selectingWorkspace && workspace !== record.workspace)
        throw Error("本次执行已固定目录，不能更换运行目录")
    }
    const workspaceIdentity = runtimeDirectoryIdentity(workspace)
    const knowledgeIds = initialProject.knowledgeBaseIds ?? []
    const assertPreflightCurrent = () => {
      guard()
      const currentProject = currentNativeHarnessProject(original)
      if (
        runtime !== hostRuntime ||
        JSON.stringify(store().get(projectId, featureId)) !== originalRecord ||
        runtimeDirectoryIdentity(workspace) !== workspaceIdentity ||
        (pendingKnowledge && hostRuntime.view(record.hostRunId) !== undefined) ||
        (record.supportsDeployUnits && firstStart &&
          JSON.stringify(currentProject.knowledgeBaseIds ?? []) !== JSON.stringify(knowledgeIds))
      )
        throw Error("HARNESS_NATIVE_BINDING_CHANGED")
    }
    if (record.worktree) await resolveWorkflowWorktreeIsolationBoundary(record.worktree)
    assertPreflightCurrent()
    goal = hostGoal(goal)
    if (record.goal && record.goal !== goal) throw Error("HARNESS_NATIVE_REQUIREMENT_CHANGED")

    let harnessFeatureInputs = pinnedInputs
    if (firstStart) {
      if (record.supportsDeployUnits) {
        const selectedDeployUnits = [...new Set(record.selectedDeployUnits.map((unit) => unit.deployUnitId))]
        if (!selectedDeployUnits.length)
          throw Error("请在编辑特性配置中选择发布单元后重试")
        const sources = await resolveProjectKnowledgeBases(knowledgeIds)
        if (sources.length !== knowledgeIds.length || (record.requiresKnowledge && !sources.length))
          throw Error("请在编辑项目中选择已同步的系统约束知识库后重试")
        if (sources.length + (record.packageMaterialRoots ?? 0) > HOST_CONTEXT_MATERIAL_ROOT_LIMIT)
          throw Error("已选知识库超过插件支持的材料根目录数量，请在编辑项目中调整选择")
        harnessFeatureInputs = parseHarnessHostFeatureInputs({
          selectedDeployUnits,
          knowledgeRoots: sources.map((source) => ({
            id: source.id,
            path: runtimeDirectory(source.path),
            identity: runtimeDirectoryIdentity(source.path)
          }))
        })
      }
    } else if (pendingKnowledge && pinnedInputs) {
      // Keep the durable input selection if Host creation was interrupted. A normal UAT
      // checkout swap changes the inode while leaving each pinned library and path intact.
      const sources = await resolveProjectKnowledgeBases(pinnedInputs.knowledgeRoots.map((root) => root.id))
      assertPreflightCurrent()
      const byId = new Map(sources.map((source) => [source.id, source.path]))
      const knowledgeRoots = pinnedInputs.knowledgeRoots.map((root) => {
        const path = byId.get(root.id)
        if (!path || runtimeDirectory(path) !== root.path)
          throw Error("PROJECT_KNOWLEDGE_BINDING_CHANGED")
        return { ...root, identity: runtimeDirectoryIdentity(path) }
      })
      const changed = knowledgeRoots.some(
        (root, index) => root.identity !== pinnedInputs.knowledgeRoots[index].identity
      )
      if (changed) {
        if (!preflight) throw Error("PROJECT_KNOWLEDGE_PREFLIGHT_REQUIRED")
        harnessFeatureInputs = parseHarnessHostFeatureInputs({ ...pinnedInputs, knowledgeRoots })
      }
    }
    if (firstStart || pendingKnowledge) {
      assertPreflightCurrent()
      const assertReady = await preflight?.({ original, workspace, assertCurrent: assertPreflightCurrent })
      if (harnessFeatureInputs && (firstStart || harnessFeatureInputs !== pinnedInputs)) {
        const { assertHarnessFeatureKnowledgeAvailable } = await import("./project-runtime/package-input-identity")
        assertPreflightCurrent()
        try {
          await assertHarnessFeatureKnowledgeAvailable(harnessFeatureInputs, record.requiresKnowledge === true)
        } catch (error) {
          if (error instanceof Error && error.message === "PROJECT_KNOWLEDGE_LIMIT")
            throw Error("系统约束知识库超过运行支持的材料大小或数量。请在编辑项目中调整知识库后重试。")
          throw Error("系统约束知识库缺少可读取的材料。请重新同步知识库，或在编辑项目中调整选择后重试。")
        }
        assertPreflightCurrent()
        if (harnessFeatureInputs.knowledgeRoots.length) {
          const availableDeployUnits = new Set(await readProjectKnowledgeDeployUnits(
            harnessFeatureInputs.knowledgeRoots.map((root) => root.path), "host"
          ))
          if (harnessFeatureInputs.selectedDeployUnits.some((id) => !availableDeployUnits.has(id))) {
            if (firstStart) throw Error("PROJECT_KNOWLEDGE_DEPLOY_UNITS_MISMATCH")
            throw Error("首次启动记录待恢复，但原发布单元已不在当前系统约束知识库。请恢复原发布单元后重试，或新建特性。")
          }
        }
      }
      assertPreflightCurrent()
      assertReady?.()
    }
    const assertKnowledgeRoots = () => {
      if (!firstStart && !pendingKnowledge) return
      for (const root of harnessFeatureInputs?.knowledgeRoots ?? []) {
        if (runtimeDirectoryIdentity(root.path) !== root.identity)
          throw Error("PROJECT_KNOWLEDGE_BINDING_CHANGED")
      }
    }
    assertKnowledgeRoots()
    if (selectingWorkspace) {
      record.repositoryWorkspaceIdentity ??= record.workspaceIdentity
      record.workspace = workspace
      record.workspaceIdentity = workspaceIdentity
    }
    if (harnessFeatureInputs) record.harnessFeatureInputs = harnessFeatureInputs
    record.goal = goal
    // Persist the original request before Host creation so a crash/retry never substitutes it.
    store().update(record)
    const assertCurrent = () => {
      guard()
      assertNativeHarnessFeatureCurrent(publicBinding(record))
      assertKnowledgeRoots()
    }
    const view = await hostRuntime.create(
      {
        projectId: record.hostRunId,
        name: record.title,
        goal,
        workspace: record.workspace,
        installedPluginId: record.installedPluginId,
        expectedPlugin: record.expectedPlugin,
        ...(harnessFeatureInputs ? { harnessFeatureInputs } : {})
      },
      assertCurrent
    )
    assertCurrent()
    assertNativeView(record, view)
    record.packageDigest = view.project.pluginDigest
    store().update(record)
    return view
  })
}
function assertNativeView(record: NativeFeatureRecord, view: LocalProjectView): void {
  const p = view.project
  if (
    p.projectId !== record.hostRunId ||
    p.installedPluginId !== record.installedPluginId ||
    p.workspace !== record.workspace ||
    p.goal !== record.goal ||
    (record.packageDigest !== undefined && p.pluginDigest !== record.packageDigest)
  )
    throw Error("HARNESS_NATIVE_BINDING_CHANGED")
}
function recordView(
  record: NativeFeatureRecord,
  projection?: NativeHarnessViewProjection
): LocalProjectView | undefined {
  const view = nativeHarnessRuntimeView(record.hostRunId, projection)
  if (view) assertNativeView(record, view)
  else if (record.packageDigest) throw Error("HARNESS_NATIVE_EXECUTION_MISSING")
  // A crash between Host creation and identity publication resumes through the exact create CAS.
  return record.packageDigest ? view : undefined
}
export function assertNativeHarnessProjectMutable(projectId: string, adapterChange = false): void {
  const records = existingStore()?.list(projectId) ?? []
  if (adapterChange && records.length) throw Error("已有原生需求的项目不能更换插件绑定")
  for (const record of records) {
    const view = recordView(record, "summary")
    if (
      view?.operations.some((op) =>
        ["prepared", "started", "cancel_requested", "unknown", "succeeded"].includes(op.status)
      )
    )
      throw Error("请先停止或核对尚未结算的需求，再修改项目生命周期")
  }
}
export function nativeHarnessFeatureConfiguration(projectId: string, featureId: string) {
  const record = existingStore()?.get(projectId, featureId)
  return (
    record && {
      projectId,
      featureId,
      selectedDeployUnitMappings: record.selectedDeployUnits,
      sessionWorkspace: record.sessionWorkspace,
      sessionContextInjectionSource: "cmbdevclaw" as const
    }
  )
}
export function updateNativeHarnessFeatureConfiguration(
  projectId: string,
  featureId: string,
  repositoryWorkspace: string,
  sessionWorkspace: HarnessSessionWorkspace,
  selectedDeployUnits: HarnessDeployUnitMapping[]
) {
  const record = store().get(projectId, featureId)
  if (!record) throw Error("HARNESS_NATIVE_FEATURE_MISSING")
  assertNativeFeatureConfiguration(sessionWorkspace, selectedDeployUnits, record.supportsDeployUnits === true)
  assertNativeHarnessFeatureCurrent(publicBinding(record))
  if (record.worktree || record.goal || record.packageDigest)
    throw Error("需求已固定隔离工作区，不能更换原执行的工作区配置")
  record.repositoryWorkspace = realpathSync(repositoryWorkspace)
  if (record.workspaceMode === "selected-directory") {
    record.workspace = runtimeDirectory(record.repositoryWorkspace)
    record.workspaceIdentity = runtimeDirectoryIdentity(record.workspace)
    record.repositoryWorkspaceIdentity = record.workspaceIdentity
  }
  record.sessionWorkspace = sessionWorkspace
  record.selectedDeployUnits = selectedDeployUnits
  store().update(record)
  return nativeHarnessFeatureConfiguration(projectId, featureId)!
}
function workflow(manifest: ProjectRuntimeManifest): HarnessWorkflow {
  return {
    display: { mode: "ordered_nodes" },
    nodes: manifest.stages.map((stage) => ({
      id: stage.id,
      label: stage.title,
      ...(stage.userGuide === undefined ? {} : { userGuide: stage.userGuide }),
      artifactDefinitions: stage.artifactIds.map((id) => ({
        id,
        required: true,
        artifactType: "file"
      }))
    }))
  }
}
function stageStatus(view: LocalProjectView | undefined, stageId: string): HarnessNodeStatus {
  const operations = view?.operations.filter((op) => op.stageId === stageId) ?? []
  if (operations.some((op) => op.status === "transitioned")) return "done"
  const latest = operations.sort((a, b) => b.updatedAt - a.updatedAt)[0]
  if (!latest) return "not_started"
  if (latest.status === "failed") return "error"
  if (latest.status === "unknown" || latest.status === "cancel_requested") return "unknown"
  if (["prepared", "cancelled", "succeeded"].includes(latest.status)) return "blocked"
  return "in_progress"
}
function status(value: HarnessNodeStatus): HarnessStatus {
  const labels = {
    not_started: "未开始",
    in_progress: "执行中",
    done: "已完成",
    blocked: "待确认",
    warning: "需关注",
    error: "失败",
    skipped: "已跳过",
    archived: "已归档",
    unknown: "待核对"
  }
  return {
    label: labels[value],
    uiKind: value === "not_started" ? "pending" : value === "in_progress" ? "active" : value
  }
}
function artifact(
  record: NativeFeatureRecord,
  manifest: ProjectRuntimeManifest,
  id: string
): HarnessArtifact {
  const declaration = manifest.artifacts.find((item) => item.id === id)!
  const base = {
    id,
    artifactLabel: id,
    artifactType: "file" as const,
    required: declaration.required,
    path: declaration.path
  }
  try {
    const present = probeRuntimeScopedFile(record.workspace, declaration.path).present
    return {
      ...base,
      exists: present,
      artifactStatus: present ? "generated" : "missing",
      status: { label: present ? "已生成" : "未生成", uiKind: present ? "ok" : "pending" }
    }
  } catch {
    return {
      ...base,
      artifactStatus: "unknown",
      status: { label: "文件范围需核对", uiKind: "warning" }
    }
  }
}
function summary(
  record: NativeFeatureRecord,
  view: LocalProjectView | undefined
): HarnessFeatureSummary {
  const manifest = view?.project.manifest ?? record.manifest
  const stage = manifest.stages[view?.project.stageIndex ?? 0]
  const current = view?.project.status === "completed" ? "done" : stageStatus(view, stage?.id ?? "")
  return {
    engine: "host",
    id: record.featureId,
    slug: record.featureId,
    kind: "feature",
    title: record.title,
    location: "active",
    featureStatus: current,
    overallStatus: status(current),
    nodeIds: manifest.stages.map((s) => s.id),
    currentNodeId: stage?.id ?? manifest.stages.at(-1)!.id,
    currentNodeStatus: current,
    summary: {
      text: record.goal?.slice(0, 500) ?? "等待输入需求并开始执行",
      updatedAt: new Date(view?.project.updatedAt ?? record.createdAt).toISOString()
    }
  }
}
function readNativeProjectDetailStorage<T>(failure: string, read: () => T): T {
  try {
    return read()
  } catch (error) {
    if (error instanceof Error) {
      const { code, errcode } = error as NodeJS.ErrnoException & { errcode?: number }
      if (code === "ERR_SQLITE_ERROR" && typeof errcode === "number") {
        // SQLite stores the primary result code in the low byte of extended codes.
        const primaryCode = errcode & 0xff
        const SQLITE_CORRUPT = 11
        const SQLITE_NOTADB = 26
        if (primaryCode === SQLITE_CORRUPT || primaryCode === SQLITE_NOTADB)
          throw Error(failure, { cause: error })
      }
    }
    throw error
  }
}

export async function nativeHarnessProjectDetail(
  project: HarnessProjectMetadata
): Promise<HarnessProjectDetailViewModel> {
  const records = readNativeProjectDetailStorage("HARNESS_NATIVE_FEATURE_INDEX_UNREADABLE", () =>
    store().list(project.projectId)
  )
  const views = readNativeProjectDetailStorage("HARNESS_NATIVE_EXECUTION_UNREADABLE", () =>
    records.map((record) => recordView(record, "summary"))
  )
  const manifest =
    views[0]?.project.manifest ??
    records[0]?.manifest ??
    (await nativeHarnessPlugin(project.nativeBinding!.installedPluginId))?.manifest
  if (!manifest) throw Error("PROJECT_PLUGIN_UNAVAILABLE")
  const firstHostRun = views.reduce(
    (earliest, view) => Math.min(earliest, view?.project.createdAt ?? Infinity),
    Infinity
  )
  const managedRunFirstStartedAt = project.managedRunFirstStartedAt ??
    (Number.isFinite(firstHostRun) ? new Date(firstHostRun).toISOString() : undefined)
  let projectRootPath: string
  try {
    projectRootPath = nativeProjectRoot(project)
  } catch (error) {
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined
    if (code === "ENOENT" || code === "ENOTDIR")
      throw Error("HARNESS_NATIVE_PROJECT_DIRECTORY_MISSING", { cause: error })
    throw error
  }
  return {
    project: {
      ...project,
      projectRootPath,
      ...(managedRunFirstStartedAt ? { managedRunFirstStartedAt } : {})
    },
    adapterSnapshot: { mode: "project", mock: false },
    workflow: workflow(manifest),
    runs: records.map((record, index) => summary(record, views[index])),
    watchRefs: [],
    loading: false,
    error: null
  }
}
export function nativeHarnessRunDetail(
  project: HarnessProjectMetadata,
  featureId: string
): HarnessRunDetailViewModel {
  const record = store().get(project.projectId, featureId)
  if (!record) throw Error("HARNESS_NATIVE_FEATURE_MISSING")
  assertNativeHarnessFeatureBinding(publicBinding(record), project, { allowArchivedRead: true })
  const view = recordView(record)
  const manifest = view?.project.manifest ?? record.manifest
  const overview = summary(record, view)
  const stageIndex = view?.project.stageIndex ?? 0
  return {
    nativeBinding: publicBinding(record),
    ...(view ? { nativeProject: view } : {}),
    project: { ...project, projectRootPath: record.workspace },
    adapterSnapshot: { mode: "run", mock: false },
    workflow: workflow(manifest),
    run: {
      id: featureId,
      slug: featureId,
      title: record.title,
      kind: "feature",
      hookLogRefs: [],
      watchRefs: [],
      skipNodeAvailable: false,
      selectedDeployUnits: record.selectedDeployUnits,
      sessionWorkspace: record.sessionWorkspace,
      resolvedSessionWorkspacePath: record.repositoryWorkspace,
      featureStatus: overview.featureStatus,
      overallStatus: overview.overallStatus,
      currentNodeId: overview.currentNodeId,
      unmatchedHooks: [],
      nodes: manifest.stages.map((stage, index) => {
        const nodeStatus = index < stageIndex ? "done" : stageStatus(view, stage.id)
        return {
          id: stage.id,
          label: stage.title,
          nodeStatus,
          status: status(nodeStatus),
          hooks: [],
          artifacts: stage.artifactIds.map((id) => artifact(record, manifest, id))
        }
      })
    },
    sessions: (view?.operations ?? []).flatMap((op) =>
      op.execution
        ? [
            {
              projectId: project.projectId,
              slug: featureId,
              threadId: op.execution.threadId,
              source: "host",
              createdAt: new Date(op.createdAt).toISOString(),
              lastActiveAt: new Date(op.updatedAt).toISOString()
            }
          ]
        : []
    )
  }
}
