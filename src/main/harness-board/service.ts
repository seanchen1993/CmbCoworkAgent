import { execFileSync } from "child_process"
import { existsSync, readFileSync, writeFileSync } from "fs"
import { basename, isAbsolute, join, relative, resolve } from "path"
import { v4 as uuid } from "uuid"
import { getOpenworkDir, getPlugins } from "../storage"
import type { PluginMetadata } from "../types"
import type {
  HarnessAdapterRegistryItem,
  HarnessAdapterSnapshot,
  HarnessAdapterType,
  HarnessArtifact,
  HarnessArtifactKind,
  HarnessProjectCreateInput,
  HarnessProjectDetailViewModel,
  HarnessProjectListItem,
  HarnessProjectMetadata,
  HarnessProjectMetadataUpdateInput,
  HarnessRunDetailViewModel,
  HarnessRunNode,
  HarnessFeatureSummary,
  HarnessSessionBinding,
  HarnessSessionBindingUpsertInput,
  HarnessStatus,
  HarnessWatchRef,
  HarnessWorkflow
} from "../../shared/harness-board-types"

interface HarnessProjectStoreFile {
  version: 1
  projects: HarnessProjectMetadata[]
}

interface HarnessSessionBindingStoreFile {
  version: 1
  bindings: HarnessSessionBinding[]
}

type HarnessHookLogRef = HarnessRunDetailViewModel["run"]["hookLogRefs"][number]

interface HarnessHookLogEntry {
  nodeId: string
  hook: HarnessRunNode["hooks"][number]
}

const HARNESS_BOARD_FILE = join(getOpenworkDir(), "harness-board-projects.json")
const HARNESS_SESSION_BINDINGS_FILE = join(getOpenworkDir(), "harness-board-session-bindings.json")

const DEFAULT_CACHE = {
  featureCount: null,
  activeFeatureCount: null,
  lastInspectedAt: null
}

const HARNESS_ADAPTER_TIMEOUT_MS = 15_000
const HARNESS_ADAPTER_MAX_BUFFER = 10 * 1024 * 1024

const AUTOBIZDEVOPS_WORKFLOW_NODES = [
  { id: "biz.discuss", label: "需求澄清" },
  { id: "biz.prd", label: "PRD 生成" },
  { id: "dev.plan", label: "计划生成" },
  { id: "dev.code", label: "代码实现" },
  { id: "dev.review", label: "需求实现评审" },
  { id: "dev.utest", label: "单元测试" },
  { id: "dev.e2e", label: "E2E 测试" },
  { id: "dev.verify", label: "验收汇总" },
  { id: "ops.cicd", label: "CI/CD" },
  { id: "ops.archive", label: "归档" }
]

const HARNESS_UI_KINDS = new Set<HarnessStatus["uiKind"]>([
  "pending",
  "active",
  "done",
  "blocked",
  "warning",
  "skipped",
  "archived",
  "unknown",
  "ok",
  "error"
])

function emptyProjectStore(): HarnessProjectStoreFile {
  return {
    version: 1,
    projects: []
  }
}

function emptySessionBindingStore(): HarnessSessionBindingStoreFile {
  return {
    version: 1,
    bindings: []
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function pluginAdapterId(plugin: PluginMetadata): string {
  return basename(plugin.path) || normalizeText(plugin.name) || plugin.id
}

function pluginHasInspectAdapter(plugin: PluginMetadata): boolean {
  return existsSync(join(plugin.path, "inspect_state.py"))
}

function pluginMatchesAdapterId(plugin: PluginMetadata, adapterId: string): boolean {
  return (
    pluginAdapterId(plugin) === adapterId ||
    plugin.name === adapterId ||
    plugin.id === adapterId ||
    basename(plugin.path) === adapterId
  )
}

function pluginToHarnessAdapter(plugin: PluginMetadata): HarnessAdapterRegistryItem {
  const id = pluginAdapterId(plugin)
  return {
    id,
    name: normalizeText(plugin.name) || id,
    version: normalizeText(plugin.version),
    type: "plugin",
    description: normalizeText(plugin.description)
  }
}

export function listHarnessAdapters(): HarnessAdapterRegistryItem[] {
  return getPlugins()
    .filter(pluginHasInspectAdapter)
    .map(pluginToHarnessAdapter)
    .sort((a, b) => a.name.localeCompare(b.name))
}

function resolveHarnessAdapter(adapterId: string, adapterType: HarnessAdapterType): HarnessAdapterSnapshot {
  if (adapterType !== "plugin") {
    throw new Error(`Unsupported harness adapter type: ${adapterType}`)
  }
  const plugin = getPlugins().find(
    (item) => pluginHasInspectAdapter(item) && pluginMatchesAdapterId(item, adapterId)
  )
  if (!plugin) {
    throw new Error("Selected plugin is not installed or does not provide inspect_state.py")
  }
  const adapter = pluginToHarnessAdapter(plugin)
  return {
    id: adapter.id,
    name: adapter.name,
    version: adapter.version,
    type: adapter.type
  }
}

function adapterPluginDir(project: HarnessProjectMetadata): string {
  const adapter = project["harness-adapter"]
  if (adapter.type !== "plugin") {
    throw new Error(`Unsupported harness adapter type: ${adapter.type}`)
  }

  const plugin = getPlugins().find(
    (item) => pluginHasInspectAdapter(item) && pluginMatchesAdapterId(item, adapter.id)
  )
  if (!plugin) {
    throw new Error(`Harness adapter plugin not found: ${adapter.id}`)
  }
  return plugin.path
}

function toTrimmedOutput(value: unknown): string {
  if (Buffer.isBuffer(value)) return value.toString("utf-8").trim()
  return typeof value === "string" ? value.trim() : ""
}

function formatAdapterError(error: unknown): string {
  const maybeError = error as {
    message?: string
    status?: number
    signal?: string
    stderr?: unknown
    stdout?: unknown
  }
  const stderr = toTrimmedOutput(maybeError.stderr)
  const stdout = toTrimmedOutput(maybeError.stdout)
  const suffix = stderr || stdout || maybeError.message || String(error)
  const exitInfo =
    typeof maybeError.status === "number"
      ? `exit ${maybeError.status}`
      : maybeError.signal
        ? `signal ${maybeError.signal}`
        : "failed"
  return `Inspect adapter ${exitInfo}: ${suffix}`
}

function projectDirectoryPath(project: HarnessProjectMetadata): string {
  return join(project.workspace.path, project.projectCode)
}

function isInsideDirectory(basePath: string, targetPath: string): boolean {
  const relativePath = relative(resolve(basePath), resolve(targetPath))
  return relativePath === "" || (!!relativePath && !relativePath.startsWith("..") && !isAbsolute(relativePath))
}

function resolveAdapterFilePath(project: HarnessProjectMetadata, value: unknown): string | null {
  const rawPath = normalizeText(value).trim()
  if (!rawPath) return null

  const projectPath = projectDirectoryPath(project)
  const resolvedPath = isAbsolute(rawPath)
    ? resolve(rawPath)
    : rawPath === project.projectCode || rawPath.startsWith(`${project.projectCode}/`)
      ? resolve(project.workspace.path, rawPath)
      : resolve(projectPath, rawPath)

  return isInsideDirectory(projectPath, resolvedPath) ? resolvedPath : null
}

function projectDirectoryMissingMessage(project: HarnessProjectMetadata): string {
  return `请确认项目「${project.projectCode}」的工作区「${project.workspace.path}」下是否有对应 feature。`
}

function isProjectMissingError(message: string): boolean {
  return message.includes("project 不存在")
}

function formatProjectDetailError(project: HarnessProjectMetadata, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (isProjectMissingError(message)) {
    return projectDirectoryMissingMessage(project)
  }
  return message.startsWith("读取项目状态失败") ? message : `读取项目状态失败：${message}`
}

function runInspectAdapter(
  project: HarnessProjectMetadata,
  mode: "project" | "run",
  feature?: string
): Record<string, unknown> {
  const cwd = adapterPluginDir(project)
  const scriptPath = join(cwd, "inspect_state.py")
  if (!existsSync(scriptPath)) {
    throw new Error(`Inspect adapter not found: ${scriptPath}`)
  }

  const args = [
    "inspect_state.py",
    "--mode",
    mode,
    "--workspace",
    project.workspace.path,
    "--project",
    project.projectCode
  ]
  if (mode === "run") {
    args.push("--feature", feature ?? "")
  }

  let stdout = ""
  try {
    stdout = execFileSync("python3", args, {
      cwd,
      encoding: "utf-8",
      maxBuffer: HARNESS_ADAPTER_MAX_BUFFER,
      timeout: HARNESS_ADAPTER_TIMEOUT_MS
    })
  } catch (error) {
    throw new Error(formatAdapterError(error))
  }

  const raw = stdout.trim()
  if (!raw) {
    throw new Error("Inspect adapter returned empty output")
  }

  try {
    const parsed = JSON.parse(raw) as unknown
    if (!isObject(parsed)) {
      throw new Error("top-level JSON is not an object")
    }
    return parsed
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Inspect adapter returned invalid JSON: ${message}`)
  }
}

function statusFromId(id: string): HarnessStatus {
  switch (id) {
    case "not_started":
    case "pending":
      return { id: id || "not_started", label: "未开始", uiKind: "pending" }
    case "in_progress":
    case "active":
      return { id: "in_progress", label: "进行中", uiKind: "active" }
    case "done":
      return { id: "done", label: "已完成", uiKind: "done" }
    case "blocked":
    case "needs_fix":
      return { id: "blocked", label: "已阻断", uiKind: "blocked" }
    case "warning":
      return { id: "warning", label: "提示", uiKind: "warning" }
    case "error":
      return { id: "error", label: "错误", uiKind: "error" }
    case "archived":
      return { id: "archived", label: "已归档", uiKind: "archived" }
    case "passed":
    case "present":
    case "ok":
      return { id: id || "ok", label: "正常", uiKind: "ok" }
    case "missing":
      return { id: "missing", label: "未生成", uiKind: "warning" }
    case "skipped":
      return { id: "skipped", label: "跳过", uiKind: "skipped" }
    default:
      return { id: id || "unknown", label: id || "未知", uiKind: "unknown" }
  }
}

function normalizeStatus(value: unknown, fallbackId = "unknown"): HarnessStatus {
  if (!isObject(value)) {
    return statusFromId(normalizeText(value) || fallbackId)
  }

  const fallback = statusFromId(normalizeText(value.id) || fallbackId)
  const uiKind = HARNESS_UI_KINDS.has(value.uiKind as HarnessStatus["uiKind"])
    ? (value.uiKind as HarnessStatus["uiKind"])
    : fallback.uiKind
  return {
    id: normalizeText(value.id) || fallback.id,
    label: normalizeText(value.label) || fallback.label,
    uiKind,
    ...(typeof value.isCurrent === "boolean" ? { isCurrent: value.isCurrent } : {})
  }
}

function normalizeArtifactKind(value: unknown): HarnessArtifactKind {
  const kind = normalizeText(value)
  switch (kind) {
    case "directory":
    case "report":
    case "log":
    case "external":
    case "virtual":
      return kind
    default:
      return "file"
  }
}

function normalizeAdapterPath(project: HarnessProjectMetadata, value: unknown): string | null {
  const rawPath = normalizeText(value).trim()
  if (!rawPath) return null
  if (isAbsolute(rawPath)) {
    const relativePath = relative(project.workspace.path, rawPath)
    if (relativePath && !relativePath.startsWith("..") && !isAbsolute(relativePath)) {
      return relativePath
    }
    return rawPath
  }
  if (rawPath === ".autobizdevops" || rawPath.startsWith(".autobizdevops/")) {
    return `${project.projectCode}/${rawPath}`
  }
  return rawPath
}

function normalizeWatchRefs(
  project: HarnessProjectMetadata,
  refs: unknown,
  fallback: HarnessWatchRef[]
): HarnessWatchRef[] {
  if (!Array.isArray(refs)) return fallback
  const normalized = refs
    .map((ref): HarnessWatchRef | null => {
      if (!isObject(ref)) return null
      const path = normalizeAdapterPath(project, ref.path)
      if (!path) return null
      return {
        path,
        purpose: normalizeText(ref.purpose) || "artifacts"
      }
    })
    .filter((ref): ref is HarnessWatchRef => ref !== null)
  return normalized.length > 0 ? normalized : fallback
}

function workflowNodeInfo(nodeId: string): { label: string; progressIndex: number } | null {
  const index = AUTOBIZDEVOPS_WORKFLOW_NODES.findIndex((node) => node.id === nodeId)
  if (index === -1) return null
  return {
    label: AUTOBIZDEVOPS_WORKFLOW_NODES[index].label,
    progressIndex: index + 1
  }
}

function normalizeProjectRun(value: unknown, generatedAt: string): HarnessFeatureSummary | null {
  if (!isObject(value)) return null
  const slug = normalizeText(value.featureId) || normalizeText(value.featureName)
  if (!slug) return null

  const currentNodeId = normalizeText(value.currentNodeId)
  const nodeInfo = workflowNodeInfo(currentNodeId)
  const status = normalizeStatus(value.status, currentNodeId ? "in_progress" : "unknown")
  const currentNodeLabel = nodeInfo?.label ?? currentNodeId

  return {
    id: slug,
    kind: "feature",
    slug,
    title: normalizeText(value.featureName) || slug,
    location: status.uiKind === "archived" ? "archived" : "active",
    overallStatus: status,
    position: {
      currentNodeId: currentNodeId || "unknown",
      currentNodeLabel,
      currentNodeState: status.id,
      progressIndex: nodeInfo?.progressIndex ?? 0,
      totalNodes: AUTOBIZDEVOPS_WORKFLOW_NODES.length
    },
    summary: {
      text: currentNodeLabel ? `${currentNodeLabel} · ${status.label}` : status.label,
      updatedAt: generatedAt
    },
    sourceHealth: okStatus("adapter_loaded", "Inspect 已加载")
  }
}

function normalizeProjectRuns(snapshot: Record<string, unknown>, generatedAt: string): HarnessFeatureSummary[] {
  if (!Array.isArray(snapshot.runs)) return []
  return snapshot.runs
    .map((run) => normalizeProjectRun(run, generatedAt))
    .filter((run): run is HarnessFeatureSummary => run !== null)
}

function normalizeWorkflowNodeDefinition(value: unknown): HarnessWorkflow["nodes"][number] | null {
  if (!isObject(value)) return null
  const id = normalizeText(value.id)
  if (!id) return null

  return {
    id,
    label: normalizeText(value.label) || id,
    group: normalizeText(value.group) || "Default",
    order: typeof value.order === "number" ? value.order : 0,
    description: normalizeText(value.description) || undefined,
    states: Array.isArray(value.states) ? value.states.map((state) => normalizeStatus(state)) : undefined,
    artifactDefinitions: Array.isArray(value.artifactDefinitions)
      ? value.artifactDefinitions
          .map((artifact) => {
            if (!isObject(artifact)) return null
            const artifactId = normalizeText(artifact.id)
            if (!artifactId) return null
            return {
              id: artifactId,
              label: normalizeText(artifact.label) || normalizeText(artifact.name) || artifactId,
              kind: normalizeArtifactKind(artifact.kind),
              required: typeof artifact.required === "boolean" ? artifact.required : false
            }
          })
          .filter((artifact): artifact is NonNullable<typeof artifact> => artifact !== null)
      : undefined,
    hookDefinitions: Array.isArray(value.hookDefinitions)
      ? value.hookDefinitions
          .map((hook) => {
            if (!isObject(hook)) return null
            const hookId = normalizeText(hook.id)
            if (!hookId) return null
            return {
              id: hookId,
              label: normalizeText(hook.label) || hookId,
              event: normalizeText(hook.event),
              required: typeof hook.required === "boolean" ? hook.required : false
            }
          })
          .filter((hook): hook is NonNullable<typeof hook> => hook !== null)
      : undefined
  }
}

function normalizeWorkflow(value: unknown): HarnessWorkflow {
  const workflow = isObject(value) ? value : {}
  return {
    id: normalizeText(workflow.id) || "autobizdevops.default",
    version: normalizeText(workflow.version) || "1.0.0",
    kind: normalizeText(workflow.kind) || "graph",
    display: isObject(workflow.display)
      ? {
          mode: normalizeText(workflow.display.mode) || "ordered_nodes",
          groupBy: normalizeText(workflow.display.groupBy) || undefined
        }
      : {
          mode: "ordered_nodes",
          groupBy: "group"
        },
    nodes: Array.isArray(workflow.nodes)
      ? workflow.nodes
          .map((node) => normalizeWorkflowNodeDefinition(node))
          .filter((node): node is HarnessWorkflow["nodes"][number] => node !== null)
      : [],
    transitions: Array.isArray(workflow.transitions)
      ? workflow.transitions
          .map((transition) => {
            if (!isObject(transition) || !isObject(transition.from) || !isObject(transition.to)) {
              return null
            }
            const id = normalizeText(transition.id)
            const fromNodeId = normalizeText(transition.from.nodeId)
            const toNodeId = normalizeText(transition.to.nodeId)
            if (!id || !fromNodeId || !toNodeId) return null
            return {
              id,
              from: {
                nodeId: fromNodeId,
                state: normalizeText(transition.from.state)
              },
              to: {
                nodeId: toNodeId,
                state: normalizeText(transition.to.state)
              }
            }
          })
          .filter((transition): transition is NonNullable<typeof transition> => transition !== null)
      : []
  }
}

function workflowArtifactDefinitions(workflow: HarnessWorkflow): Map<string, Map<string, HarnessArtifact>> {
  const byNode = new Map<string, Map<string, HarnessArtifact>>()
  for (const node of workflow.nodes) {
    const artifacts = new Map<string, HarnessArtifact>()
    for (const artifact of node.artifactDefinitions ?? []) {
      artifacts.set(artifact.id, {
        id: artifact.id,
        label: artifact.label,
        kind: artifact.kind,
        path: null,
        required: artifact.required,
        status: statusFromId("unknown")
      })
    }
    byNode.set(node.id, artifacts)
  }
  return byNode
}

function normalizeArtifact(
  project: HarnessProjectMetadata,
  value: unknown,
  definition?: HarnessArtifact
): HarnessArtifact | null {
  if (!isObject(value)) return null
  const id = normalizeText(value.id)
  if (!id) return null
  const exists = typeof value.exists === "boolean" ? value.exists : undefined
  return {
    id,
    label: normalizeText(value.label) || normalizeText(value.name) || definition?.label || id,
    kind: normalizeArtifactKind(value.kind || definition?.kind),
    path: normalizeAdapterPath(project, value.path),
    required: typeof value.required === "boolean" ? value.required : definition?.required ?? false,
    status: normalizeStatus(value.status, exists === false ? "missing" : "present"),
    ...(typeof exists === "boolean" ? { exists } : {}),
    ...(typeof value.nonEmpty === "boolean" ? { nonEmpty: value.nonEmpty } : {}),
    ...(typeof value.size === "number" ? { size: value.size } : {}),
    ...(typeof value.updatedAt === "string" ? { updatedAt: value.updatedAt } : {}),
    ...(typeof value.summary === "string" ? { summary: value.summary } : {}),
    ...(isObject(value.validation)
      ? {
          validation: {
            status:
              value.validation.status === "valid" ||
              value.validation.status === "invalid" ||
              value.validation.status === "unknown"
                ? value.validation.status
                : "unknown",
            message: normalizeText(value.validation.message)
          }
        }
      : {})
  }
}

function normalizeHook(value: unknown): HarnessRunNode["hooks"][number] | null {
  if (!isObject(value)) return null
  const hookId = normalizeText(value.hookId)
  if (!hookId) return null
  return {
    hookId,
    label: normalizeText(value.label) || hookId,
    event: normalizeText(value.event) || undefined,
    status: normalizeStatus(value.status, "unknown"),
    decision: normalizeText(value.decision) || undefined,
    exitCode: typeof value.exitCode === "number" ? value.exitCode : undefined,
    durationMs: typeof value.durationMs === "number" ? value.durationMs : undefined,
    summary: normalizeText(value.summary),
    ts: normalizeText(value.ts) || undefined
  }
}

function normalizeHookLogRefs(
  project: HarnessProjectMetadata,
  refs: unknown
): HarnessRunDetailViewModel["run"]["hookLogRefs"] {
  if (!Array.isArray(refs)) return []
  return refs
    .map((ref): HarnessHookLogRef | null => {
      if (!isObject(ref)) return null
      const path = normalizeAdapterPath(project, ref.path)
      if (!path) return null
      return {
        id: normalizeText(ref.id) || "default",
        path,
        format: normalizeText(ref.format) || "ndjson"
      }
    })
    .filter((ref): ref is HarnessHookLogRef => ref !== null)
}

function readHookLogRefs(
  project: HarnessProjectMetadata,
  refs: HarnessHookLogRef[]
): HarnessHookLogEntry[] {
  const entries: HarnessHookLogEntry[] = []

  for (const ref of refs) {
    if (ref.format !== "ndjson") continue
    const filePath = resolveAdapterFilePath(project, ref.path)
    if (!filePath || !existsSync(filePath)) continue

    const lines = readFileSync(filePath, "utf-8").split(/\r?\n/)
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue

      try {
        const parsed = JSON.parse(trimmed) as unknown
        if (!isObject(parsed)) continue
        const hook = normalizeHook(parsed)
        if (!hook) continue
        entries.push({
          nodeId: normalizeText(parsed.nodeId),
          hook
        })
      } catch {
        // Malformed hook log lines should not break feature detail rendering.
      }
    }
  }

  return entries
}

function applyHookLogEntries(
  nodes: HarnessRunNode[],
  entries: HarnessHookLogEntry[]
): { nodes: HarnessRunNode[]; unmatchedHooks: HarnessRunNode["hooks"] } {
  const hooksByNode = new Map<string, HarnessRunNode["hooks"]>()
  const unmatchedHooks: HarnessRunNode["hooks"] = []
  const nodeIds = new Set(nodes.map((node) => node.id))

  for (const entry of entries) {
    if (entry.nodeId && nodeIds.has(entry.nodeId)) {
      hooksByNode.set(entry.nodeId, [...(hooksByNode.get(entry.nodeId) ?? []), entry.hook])
    } else {
      unmatchedHooks.push(entry.hook)
    }
  }

  return {
    nodes: nodes.map((node) => ({
      ...node,
      hooks: [...node.hooks, ...(hooksByNode.get(node.id) ?? [])]
    })),
    unmatchedHooks
  }
}

function normalizeRunNodes(
  project: HarnessProjectMetadata,
  nodes: unknown,
  workflow: HarnessWorkflow
): HarnessRunNode[] {
  if (!Array.isArray(nodes)) return []
  const artifactDefinitions = workflowArtifactDefinitions(workflow)
  return nodes
    .map((node): HarnessRunNode | null => {
      if (!isObject(node)) return null
      const id = normalizeText(node.id)
      if (!id) return null
      const definitions = artifactDefinitions.get(id)
      return {
        id,
        label: normalizeText(node.label) || id,
        group: normalizeText(node.group) || "Default",
        order: typeof node.order === "number" ? node.order : 0,
        status: normalizeStatus(node.status),
        artifacts: Array.isArray(node.artifacts)
          ? node.artifacts
              .map((artifact) => {
                const artifactId = isObject(artifact) ? normalizeText(artifact.id) : ""
                return normalizeArtifact(project, artifact, artifactId ? definitions?.get(artifactId) : undefined)
              })
              .filter((artifact): artifact is HarnessArtifact => artifact !== null)
          : [],
        hooks: Array.isArray(node.hooks)
          ? node.hooks
              .map((hook) => normalizeHook(hook))
              .filter((hook): hook is HarnessRunNode["hooks"][number] => hook !== null)
          : []
      }
    })
    .filter((node): node is HarnessRunNode => node !== null)
}

function normalizeSourceHealth(value: unknown): HarnessStatus | undefined {
  if (!isObject(value)) return undefined
  const stateFound = value.stateFound === true
  const featureDirExists = value.featureDirExists === true
  const hasErrors = Array.isArray(value.stateErrors) && value.stateErrors.length > 0
  if (stateFound && featureDirExists && !hasErrors) {
    return okStatus("ok", "状态正常")
  }
  return { id: "source_warning", label: "状态异常", uiKind: "warning" }
}

function normalizeProject(value: unknown): HarnessProjectMetadata | null {
  if (!isObject(value)) return null
  if (typeof value.projectId !== "string" || typeof value.name !== "string") return null
  const product = isObject(value.product) ? value.product : {}
  const workspace = isObject(value.workspace) ? value.workspace : {}
  const harnessAdapter = isObject(value["harness-adapter"]) ? value["harness-adapter"] : null
  if (!harnessAdapter) return null
  const lifecycle = isObject(value.lifecycle) ? value.lifecycle : {}
  const adapterId = normalizeText(harnessAdapter.id)
  const adapterName = normalizeText(harnessAdapter.name)
  if (!adapterId || !adapterName || harnessAdapter.type !== "plugin") return null

  return {
    projectId: value.projectId,
    name: value.name,
    description: normalizeText(value.description),
    projectCode: normalizeText(value.projectCode),
    product: {
      code: normalizeText(product.code),
      name: normalizeText(product.name)
    },
    workspace: {
      path: normalizeText(workspace.path)
    },
    "harness-adapter": {
      id: adapterId,
      name: adapterName,
      version: normalizeText(harnessAdapter.version),
      type: "plugin"
    },
    owner: isObject(value.owner)
      ? {
          id: normalizeText(value.owner.id) || undefined,
          name: normalizeText(value.owner.name) || undefined
        }
      : undefined,
    lifecycle: {
      status: value.lifecycle && lifecycle.status === "archived" ? "archived" : "active",
      createdAt: normalizeText(lifecycle.createdAt) || new Date().toISOString(),
      updatedAt: normalizeText(lifecycle.updatedAt) || new Date().toISOString(),
      archivedAt: typeof lifecycle.archivedAt === "string" ? lifecycle.archivedAt : null
    },
    cachedRunSummary: isObject(value.cachedRunSummary)
      ? {
          featureCount:
            typeof value.cachedRunSummary.featureCount === "number"
              ? value.cachedRunSummary.featureCount
              : null,
          activeFeatureCount:
            typeof value.cachedRunSummary.activeFeatureCount === "number"
              ? value.cachedRunSummary.activeFeatureCount
              : null,
          lastInspectedAt:
            typeof value.cachedRunSummary.lastInspectedAt === "string"
              ? value.cachedRunSummary.lastInspectedAt
              : null
        }
      : DEFAULT_CACHE
  }
}

function normalizeSessionBinding(value: unknown): HarnessSessionBinding | null {
  if (!isObject(value)) return null
  if (
    typeof value.projectId !== "string" ||
    typeof value.threadId !== "string" ||
    typeof value.slug !== "string"
  ) {
    return null
  }
  return {
    projectId: value.projectId,
    threadId: value.threadId,
    createdAt: normalizeText(value.createdAt),
    lastActiveAt: normalizeText(value.lastActiveAt),
    slug: value.slug
  }
}

function readProjectStore(): HarnessProjectStoreFile {
  getOpenworkDir()
  if (!existsSync(HARNESS_BOARD_FILE)) return emptyProjectStore()
  try {
    const parsed = JSON.parse(readFileSync(HARNESS_BOARD_FILE, "utf-8")) as unknown
    if (!isObject(parsed)) return emptyProjectStore()
    return {
      version: 1,
      projects: Array.isArray(parsed.projects)
        ? parsed.projects
            .map((item) => normalizeProject(item))
            .filter((item): item is HarnessProjectMetadata => item !== null)
        : []
    }
  } catch {
    return emptyProjectStore()
  }
}

function writeProjectStore(store: HarnessProjectStoreFile): void {
  getOpenworkDir()
  writeFileSync(HARNESS_BOARD_FILE, `${JSON.stringify(store, null, 2)}\n`)
}

function readSessionBindingStore(): HarnessSessionBindingStoreFile {
  getOpenworkDir()
  if (!existsSync(HARNESS_SESSION_BINDINGS_FILE)) return emptySessionBindingStore()
  try {
    const parsed = JSON.parse(readFileSync(HARNESS_SESSION_BINDINGS_FILE, "utf-8")) as unknown
    if (!isObject(parsed)) return emptySessionBindingStore()
    return {
      version: 1,
      bindings: Array.isArray(parsed.bindings)
        ? parsed.bindings
            .map((item) => normalizeSessionBinding(item))
            .filter((item): item is HarnessSessionBinding => item !== null)
        : []
    }
  } catch {
    return emptySessionBindingStore()
  }
}

function writeSessionBindingStore(store: HarnessSessionBindingStoreFile): void {
  getOpenworkDir()
  writeFileSync(HARNESS_SESSION_BINDINGS_FILE, `${JSON.stringify(store, null, 2)}\n`)
}

function toListItem(project: HarnessProjectMetadata): HarnessProjectListItem {
  const harnessAdapter = project["harness-adapter"]
  return {
    projectId: project.projectId,
    name: project.name,
    description: project.description,
    projectCode: project.projectCode,
    productCode: project.product.code,
    productName: project.product.name,
    workspacePath: project.workspace.path,
    harnessAdapter: {
      id: harnessAdapter.id,
      name: harnessAdapter.name,
      type: harnessAdapter.type
    },
    lifecycle: {
      status: project.lifecycle.status,
      createdAt: project.lifecycle.createdAt,
      updatedAt: project.lifecycle.updatedAt
    },
    cachedRunSummary: project.cachedRunSummary ?? DEFAULT_CACHE
  }
}

function requireProject(projectId: string): HarnessProjectMetadata {
  const project = readProjectStore().projects.find((item) => item.projectId === projectId)
  if (!project) {
    throw new Error("Project not found")
  }
  return project
}

function sessionBindingKey(binding: Pick<HarnessSessionBinding, "projectId" | "slug" | "threadId">): string {
  return `${binding.projectId}:${binding.slug}:${binding.threadId}`
}

function sortSessionBindings(bindings: HarnessSessionBinding[]): HarnessSessionBinding[] {
  return [...bindings].sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt))
}

function validateCreateInput(input: HarnessProjectCreateInput): void {
  const required = [
    input.adapterId,
    input.adapterType,
    input.name,
    input.projectCode,
    input.description,
    input.product?.code,
    input.product?.name,
    input.workspace?.path
  ]
  if (required.some((value) => typeof value !== "string" || value.trim().length === 0)) {
    throw new Error("Project name, code, description, product and workspace are required")
  }
}

function validateProjectMetadataInput(input: HarnessProjectMetadataUpdateInput): void {
  const required = [
    input.adapterId,
    input.adapterType,
    input.name,
    input.projectCode,
    input.description,
    input.product?.code,
    input.product?.name,
    input.workspace?.path
  ]
  if (required.some((value) => typeof value !== "string" || value.trim().length === 0)) {
    throw new Error("Project name, code, description, product and workspace are required")
  }
}

function okStatus(id: string, label: string): HarnessStatus {
  return { id, label, uiKind: "ok" }
}

function makeWatchRefs(projectName: string, slug?: string): HarnessWatchRef[] {
  const base = `${projectName}/.autobizdevops`
  return slug
    ? [
        { path: `${base}/STATE.md`, purpose: "run-state" },
        { path: `${base}/features/${slug}`, purpose: "artifacts" },
        { path: `${base}/features/${slug}/hooks.ndjson`, purpose: "hook-log" }
      ]
    : [
        { path: `${base}/STATE.md`, purpose: "run-list" }
      ]
}

function collectSessionsBySlug(projectId: string): Record<string, HarnessSessionBinding[]> {
  const sessionStore = readSessionBindingStore()
  const sessionsBySlug: Record<string, HarnessSessionBinding[]> = {}
  for (const binding of sessionStore.bindings.filter((item) => item.projectId === projectId)) {
    sessionsBySlug[binding.slug] = [...(sessionsBySlug[binding.slug] ?? []), binding]
  }
  return sessionsBySlug
}

function makeProjectDetailViewModel(
  project: HarnessProjectMetadata,
  data: {
    generatedAt: string
    runs: HarnessFeatureSummary[]
    sessionsBySlug: Record<string, HarnessSessionBinding[]>
    watchRefs: HarnessWatchRef[]
    projectState: HarnessStatus
    error: string | null
  }
): HarnessProjectDetailViewModel {
  return {
    project: {
      projectId: project.projectId,
      name: project.name,
      projectCode: project.projectCode,
      productCode: project.product.code,
      productName: project.product.name,
      workspacePath: project.workspace.path
    },
    adapterSnapshot: {
      schemaVersion: "harness.adapter.inspect.v1",
      mode: "project",
      generatedAt: data.generatedAt,
      mock: false
    },
    projectState: data.projectState,
    runs: data.runs,
    sessionsBySlug: data.sessionsBySlug,
    watchRefs: data.watchRefs,
    loading: false,
    error: data.error
  }
}

export function listHarnessProjects(): HarnessProjectListItem[] {
  return readProjectStore().projects.map(toListItem)
}

export function createHarnessProject(input: HarnessProjectCreateInput): HarnessProjectMetadata {
  validateCreateInput(input)
  const store = readProjectStore()
  const now = new Date().toISOString()
  const harnessAdapter = resolveHarnessAdapter(input.adapterId, input.adapterType)
  const project: HarnessProjectMetadata = {
    projectId: uuid(),
    name: input.name.trim(),
    description: input.description.trim(),
    projectCode: input.projectCode.trim(),
    product: {
      code: input.product.code.trim(),
      name: input.product.name.trim()
    },
    workspace: {
      path: input.workspace.path.trim()
    },
    "harness-adapter": harnessAdapter,
    lifecycle: {
      status: "active",
      createdAt: now,
      updatedAt: now,
      archivedAt: null
    },
    cachedRunSummary: DEFAULT_CACHE
  }

  store.projects.unshift(project)
  writeProjectStore(store)
  return project
}

export function updateHarnessProjectMetadata(
  projectId: string,
  input: HarnessProjectMetadataUpdateInput
): HarnessProjectMetadata {
  validateProjectMetadataInput(input)
  const harnessAdapter = resolveHarnessAdapter(input.adapterId, input.adapterType)
  const store = readProjectStore()
  const index = store.projects.findIndex((item) => item.projectId === projectId)
  if (index === -1) {
    throw new Error("Project not found")
  }

  const existing = store.projects[index]
  const updated: HarnessProjectMetadata = {
    ...existing,
    name: input.name.trim(),
    description: input.description.trim(),
    projectCode: input.projectCode.trim(),
    product: {
      code: input.product.code.trim(),
      name: input.product.name.trim()
    },
    workspace: {
      path: input.workspace.path.trim()
    },
    "harness-adapter": harnessAdapter,
    lifecycle: {
      ...existing.lifecycle,
      updatedAt: new Date().toISOString()
    }
  }

  store.projects[index] = updated
  writeProjectStore(store)
  return updated
}

export function archiveHarnessProject(projectId: string): HarnessProjectMetadata {
  const store = readProjectStore()
  const index = store.projects.findIndex((item) => item.projectId === projectId)
  if (index === -1) {
    throw new Error("Project not found")
  }

  const now = new Date().toISOString()
  const existing = store.projects[index]
  const archived: HarnessProjectMetadata = {
    ...existing,
    lifecycle: {
      ...existing.lifecycle,
      status: "archived",
      updatedAt: now,
      archivedAt: existing.lifecycle.archivedAt ?? now
    }
  }

  store.projects[index] = archived
  writeProjectStore(store)
  return archived
}

export function upsertHarnessSessionBinding(input: HarnessSessionBindingUpsertInput): HarnessSessionBinding {
  const project = requireProject(input.projectId)
  const slug = input.slug.trim()
  const threadId = input.threadId.trim()
  if (!slug || !threadId) {
    throw new Error("Feature slug and thread id are required")
  }

  const store = readSessionBindingStore()
  const now = new Date().toISOString()
  const key = sessionBindingKey({ projectId: project.projectId, slug, threadId })
  const existing = store.bindings.find((item) => sessionBindingKey(item) === key)
  const binding: HarnessSessionBinding = {
    projectId: project.projectId,
    slug,
    threadId,
    createdAt: existing?.createdAt || now,
    lastActiveAt: now
  }

  const nextBindings = store.bindings.filter((item) => sessionBindingKey(item) !== key)
  nextBindings.push(binding)
  writeSessionBindingStore({ version: 1, bindings: sortSessionBindings(nextBindings) })
  return binding
}

export function getHarnessProjectDetail(projectId: string): HarnessProjectDetailViewModel {
  const project = requireProject(projectId)
  const sessionsBySlug = collectSessionsBySlug(projectId)
  const fallbackWatchRefs = makeWatchRefs(project.projectCode)

  if (!existsSync(projectDirectoryPath(project))) {
    return makeProjectDetailViewModel(project, {
      generatedAt: new Date().toISOString(),
      runs: [],
      sessionsBySlug,
      watchRefs: fallbackWatchRefs,
      projectState: { id: "project_directory_missing", label: "项目目录不存在", uiKind: "warning" },
      error: projectDirectoryMissingMessage(project)
    })
  }

  try {
    const snapshot = runInspectAdapter(project, "project")
    const generatedAt = normalizeText(snapshot.generatedAt) || new Date().toISOString()
    const runs = normalizeProjectRuns(snapshot, generatedAt)
    return makeProjectDetailViewModel(project, {
      generatedAt,
      runs,
      sessionsBySlug,
      watchRefs: normalizeWatchRefs(project, snapshot.watchRefs, fallbackWatchRefs),
      projectState: okStatus("inspected", "Inspect 已加载"),
      error: null
    })
  } catch (error) {
    return makeProjectDetailViewModel(project, {
      generatedAt: new Date().toISOString(),
      runs: [],
      sessionsBySlug,
      watchRefs: fallbackWatchRefs,
      projectState: { id: "inspect_failed", label: "Inspect 读取失败", uiKind: "warning" },
      error: formatProjectDetailError(project, error)
    })
  }
}

export function getHarnessRunDetail(projectId: string, slug: string): HarnessRunDetailViewModel {
  const project = requireProject(projectId)
  const sessionStore = readSessionBindingStore()
  const snapshot = runInspectAdapter(project, "run", slug)
  const generatedAt = normalizeText(snapshot.generatedAt) || new Date().toISOString()
  const workflow = normalizeWorkflow(snapshot.workflow)
  const run = isObject(snapshot.run) ? snapshot.run : {}
  const featureSlug = normalizeText(run.featureId) || normalizeText(run.featureName) || slug
  const title = normalizeText(run.featureName) || featureSlug
  const overallStatus = normalizeStatus(run.overallStatus)
  const nodes = normalizeRunNodes(project, run.nodes, workflow)
  const hookLogRefs = normalizeHookLogRefs(project, run.hookLogRefs)
  const hookLogEntries = readHookLogRefs(project, hookLogRefs)
  const { nodes: nodesWithHookLogs, unmatchedHooks } = applyHookLogEntries(nodes, hookLogEntries)
  const sessions = sessionStore.bindings.filter(
    (item) => item.projectId === projectId && item.slug === featureSlug
  )

  return {
    project: {
      projectId: project.projectId,
      name: project.name,
      projectCode: project.projectCode,
      productCode: project.product.code,
      workspacePath: project.workspace.path
    },
    adapterSnapshot: {
      schemaVersion: "harness.adapter.inspect.v1",
      mode: "run",
      generatedAt,
      mock: false
    },
    workflow,
    run: {
      id: featureSlug,
      kind: "feature",
      slug: featureSlug,
      title,
      location: overallStatus.uiKind === "archived" ? "archived" : "active",
      source: {
        label: project["harness-adapter"].name,
        summary: isObject(run.summary) ? normalizeText(run.summary.text) : overallStatus.label
      },
      sourceHealth: normalizeSourceHealth(run.sourceHealth),
      hookLogRefs,
      watchRefs: normalizeWatchRefs(project, run.watchRefs, makeWatchRefs(project.projectCode, featureSlug)),
      overallStatus,
      position: {
        currentNodeId: isObject(run.position) ? normalizeText(run.position.currentNodeId) : "",
        currentNodeState: isObject(run.position)
          ? normalizeText(run.position.currentNodeState) || overallStatus.id
          : overallStatus.id,
        progressIndex: isObject(run.position) && typeof run.position.progressIndex === "number"
          ? run.position.progressIndex
          : 0,
        totalNodes: isObject(run.position) && typeof run.position.totalNodes === "number"
          ? run.position.totalNodes
          : nodesWithHookLogs.length
      },
      nodes: nodesWithHookLogs,
      unmatchedHooks
    },
    sessions
  }
}
