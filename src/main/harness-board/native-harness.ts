import { randomUUID } from "node:crypto"
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
  type ProjectRuntimeManifest
} from "../../shared/project-runtime"
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
import { HARNESS_PROJECT_STORE_MAX_BYTES } from "./store-limits"
import { hostGoal } from "./project-runtime/host-state-protocol"
import { resolveWorkflowWorktreeIsolationBoundary } from "../services/git-worktree"

interface NativeFeatureRecord extends HarnessNativeFeatureBinding {
  manifest: ProjectRuntimeManifest
  sessionWorkspace: HarnessSessionWorkspace
  selectedDeployUnits: HarnessDeployUnitMapping[]
  createdAt: number
  goal?: string
}

export interface NativeHarnessRuntime {
  create(
    input: {
      projectId: string
      name: string
      goal: string
      workspace: string
      installedPluginId: string
      expectedPlugin: PluginStartUseIdentity
    },
    guard?: () => void
  ): Promise<LocalProjectView>
  view(hostRunId: string): LocalProjectView | undefined
}
let runtime: NativeHarnessRuntime | undefined
export function configureNativeHarnessRuntime(value: NativeHarnessRuntime): void {
  runtime = value
}
export function nativeHarnessRuntimeView(id: string): LocalProjectView | undefined {
  if (!runtime) throw Error("HARNESS_NATIVE_RUNTIME_UNAVAILABLE")
  return runtime.view(id)
}

/** Separate durable identity index; HostStore remains the only execution state owner. */
export class NativeHarnessFeatureStore {
  private readonly database: DatabaseSync
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true })
    this.database = new DatabaseSync(path)
    this.database.exec(`CREATE TABLE IF NOT EXISTS native_harness_features (
      project_id TEXT NOT NULL, feature_id TEXT NOT NULL, host_run_id TEXT NOT NULL UNIQUE,
      data TEXT NOT NULL, PRIMARY KEY (project_id, feature_id))`)
  }
  private decode(row: unknown): NativeFeatureRecord | undefined {
    if (!row) return undefined
    const data = JSON.parse((row as { data: string }).data) as NativeFeatureRecord
    if (
      data.engine !== "host" ||
      !data.projectId ||
      !data.featureId ||
      !data.hostRunId ||
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
      (data.packageDigest !== undefined && !/^[a-f0-9]{64}$/.test(data.packageDigest))
    )
      throw Error("HARNESS_NATIVE_BINDING_INVALID")
    data.manifest = parseProjectRuntimeManifest(data.manifest)
    return data
  }
  get(projectId: string, featureId: string): NativeFeatureRecord | undefined {
    return this.decode(
      this.database
        .prepare("SELECT data FROM native_harness_features WHERE project_id=? AND feature_id=?")
        .get(projectId, featureId)
    )
  }
  byRun(id: string): NativeFeatureRecord | undefined {
    return this.decode(
      this.database.prepare("SELECT data FROM native_harness_features WHERE host_run_id=?").get(id)
    )
  }
  list(projectId: string): NativeFeatureRecord[] {
    return this.database
      .prepare("SELECT data FROM native_harness_features WHERE project_id=? ORDER BY rowid")
      .all(projectId)
      .map((row) => this.decode(row)!)
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
export function assertNativeHarnessFeatureCurrent(binding: HarnessNativeFeatureBinding): void {
  const file = readRuntimeScopedFile(
    getOpenworkDir(),
    "harness-board-projects.json",
    HARNESS_PROJECT_STORE_MAX_BYTES
  )
  const value = file.bytes && JSON.parse(file.bytes.toString("utf8"))
  const project = value?.projects?.find(
    (item: HarnessProjectMetadata) => item.projectId === binding.projectId
  )
  assertNativeHarnessFeatureBinding(binding, project)
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
  const view = runtime ? recordView(record) : undefined
  if (!runtime && record.packageDigest) throw Error("HARNESS_NATIVE_RUNTIME_UNAVAILABLE")
  const manifest = view?.project.manifest ?? record.manifest
  const stage = manifest.stages[view?.project.stageIndex ?? 0]
  return stage ? { name: stage.title, status: stageStatus(view, stage.id) } : null
}

export async function nativeHarnessPlugin(id: string) {
  const plugin = getPlugins().find((item) => item.id === id)
  if (!plugin) return undefined
  const description = await readProjectRuntimeDescription(plugin.path)
  if (description?.status !== "ready" || description.manifest.mode !== "host") return undefined
  return { plugin, manifest: description.manifest }
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
export function assertNativeFeatureConfiguration(
  sessionWorkspace: HarnessSessionWorkspace,
  selectedDeployUnits: readonly HarnessDeployUnitMapping[] = []
): void {
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
  assertNativeFeatureConfiguration(input.sessionWorkspace, input.selectedDeployUnits)
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
    const manifest = parseProjectRuntimeManifest(JSON.parse(manifestFile.bytes.toString("utf8")))
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
  executionWorkspace?: string
): Promise<LocalProjectView> {
  return withHarnessStoreMutation(`native-feature:${projectId}:${featureId}`, async () => {
    if (!runtime) throw Error("HARNESS_NATIVE_RUNTIME_UNAVAILABLE")
    guard()
    const record = store().get(projectId, featureId)
    if (!record) throw Error("HARNESS_NATIVE_FEATURE_MISSING")
    assertNativeHarnessFeatureCurrent(publicBinding(record))
    if (executionWorkspace !== undefined) {
      if (
        typeof executionWorkspace !== "string" ||
        !isAbsolute(executionWorkspace) ||
        executionWorkspace.length > 4096
      )
        throw Error("HARNESS_NATIVE_WORKSPACE_INVALID")
      const selected = runtimeDirectory(realpathSync(executionWorkspace))
      if (
        (record.goal || record.packageDigest || record.workspaceMode !== "selected-directory") &&
        selected !== record.workspace
      )
        throw Error("本次执行已固定目录，不能更换运行目录")
      if (!record.goal && !record.packageDigest && record.workspaceMode === "selected-directory") {
        record.repositoryWorkspaceIdentity ??= record.workspaceIdentity
        record.workspace = selected
        record.workspaceIdentity = runtimeDirectoryIdentity(selected)
      }
    }
    if (record.worktree) await resolveWorkflowWorktreeIsolationBoundary(record.worktree)
    guard()
    goal = hostGoal(goal)
    if (record.goal && record.goal !== goal) throw Error("HARNESS_NATIVE_REQUIREMENT_CHANGED")
    record.goal = goal
    // Persist the original request before Host creation so a crash/retry never substitutes it.
    store().update(record)
    const assertCurrent = () => {
      guard()
      assertNativeHarnessFeatureCurrent(publicBinding(record))
    }
    const view = await runtime.create(
      {
        projectId: record.hostRunId,
        name: record.title,
        goal,
        workspace: record.workspace,
        installedPluginId: record.installedPluginId,
        expectedPlugin: record.expectedPlugin
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
function recordView(record: NativeFeatureRecord): LocalProjectView | undefined {
  const view = nativeHarnessRuntimeView(record.hostRunId)
  if (view) assertNativeView(record, view)
  else if (record.packageDigest) throw Error("HARNESS_NATIVE_EXECUTION_MISSING")
  // A crash between Host creation and identity publication resumes through the exact create CAS.
  return record.packageDigest ? view : undefined
}
export function assertNativeHarnessProjectMutable(projectId: string, adapterChange = false): void {
  const records = existingStore()?.list(projectId) ?? []
  if (adapterChange && records.length) throw Error("已有原生需求的项目不能更换插件绑定")
  for (const record of records) {
    const view = recordView(record)
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
  assertNativeFeatureConfiguration(sessionWorkspace, selectedDeployUnits)
  const record = store().get(projectId, featureId)
  if (!record) throw Error("HARNESS_NATIVE_FEATURE_MISSING")
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
export async function nativeHarnessProjectDetail(
  project: HarnessProjectMetadata
): Promise<HarnessProjectDetailViewModel> {
  const records = store().list(project.projectId)
  const views = records.map((record) => recordView(record))
  const manifest =
    views[0]?.project.manifest ??
    records[0]?.manifest ??
    (await nativeHarnessPlugin(project.nativeBinding!.installedPluginId))?.manifest
  if (!manifest) throw Error("PROJECT_PLUGIN_UNAVAILABLE")
  return {
    project: { ...project, projectRootPath: nativeProjectRoot(project) },
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
      nodes: manifest.stages.map((stage) => {
        const nodeStatus = stageStatus(view, stage.id)
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
