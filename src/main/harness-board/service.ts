import { execFileSync } from "child_process"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs"
import { basename, isAbsolute, join, relative, resolve } from "path"
import * as chardet from "jschardet"
import * as iconv from "iconv-lite"
import { v4 as uuid } from "uuid"
import { getOpenworkDir, getPlugins } from "../storage"
import type { PluginMetadata } from "../types"
import type {
  HarnessAdapterRegistryItem,
  HarnessAdapterSnapshot,
  HarnessAdapterType,
  HarnessArtifact,
  HarnessArtifactKind,
  HarnessFeatureCreateInput,
  HarnessFeatureCreateResult,
  HarnessProjectCreateInput,
  HarnessProjectDetailViewModel,
  HarnessProjectListItem,
  HarnessProjectMetadata,
  HarnessProjectMetadataUpdateInput,
  HarnessRunDetailViewModel,
  HarnessRunNode,
  HarnessFeatureSummary,
  HarnessStatus,
  HarnessWatchRef,
  HarnessWorkflow
} from "../../shared/harness-board-types"

interface HarnessProjectStoreFile {
  version: 1
  projects: HarnessProjectMetadata[]
}

type HarnessHookLogRef = HarnessRunDetailViewModel["run"]["hookLogRefs"][number]
type HarnessInspectCommandName = "project" | "run" | "createProject" | "createFeature"
type HarnessInspectCommandConfigKey = "projectStatus" | "featureStatus" | "createProject" | "createFeature"
type HarnessPlatformConfigKey =
  | HarnessInspectCommandConfigKey
  | "plugin_dir_prompt"
  | "plugin_dir_hook"
  | "dialog_tips"
  | "feature_create_prompt"

const HARNESS_INSPECT_COMMAND_CONFIG_KEYS: Record<HarnessInspectCommandName, HarnessInspectCommandConfigKey> = {
  project: "projectStatus",
  run: "featureStatus",
  createProject: "createProject",
  createFeature: "createFeature"
}

interface ConfiguredHarnessInvocation {
  cwd: string
  invocation: {
    executable: string
    args: string[]
  }
}

interface HarnessHookLogEntry {
  nodeId: string
  hook: HarnessRunNode["hooks"][number]
}

const HARNESS_BOARD_FILE = join(getOpenworkDir(), "harness-board-projects.json")

const HARNESS_ADAPTER_TIMEOUT_MS = 15_000
const HARNESS_ADAPTER_MAX_BUFFER = 10 * 1024 * 1024
const CHARDET_CONFIDENCE_THRESHOLD = 0.8
const CHARDET_SAMPLE_BYTES = 8_192
const HARNESS_NAME_PATTERN = /^[\u4e00-\u9fffA-Za-z0-9_-]+$/u
const HARNESS_NAME_RULE_MESSAGE = "仅支持中文、英文字母、数字、-、_，不允许空格"

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

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function pluginAdapterId(plugin: PluginMetadata): string {
  return basename(plugin.path) || normalizeText(plugin.name) || plugin.id
}

function pluginHasBoardConfig(plugin: PluginMetadata): boolean {
  return existsSync(join(plugin.path, "board_core", "board_config.json"))
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
    .filter(pluginHasBoardConfig)
    .map(pluginToHarnessAdapter)
    .sort((a, b) => a.name.localeCompare(b.name))
}

function resolveHarnessAdapter(adapterId: string, adapterType: HarnessAdapterType): HarnessAdapterSnapshot {
  if (adapterType !== "plugin") {
    throw new Error(`Unsupported harness adapter type: ${adapterType}`)
  }
  const plugin = getPlugins().find(
    (item) => pluginHasBoardConfig(item) && pluginMatchesAdapterId(item, adapterId)
  )
  if (!plugin) {
    throw new Error("Selected plugin is not installed or does not provide board_core/board_config.json")
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
    (item) => pluginHasBoardConfig(item) && pluginMatchesAdapterId(item, adapter.id)
  )
  if (!plugin) {
    throw new Error(`Harness adapter plugin not found: ${adapter.id}`)
  }
  return plugin.path
}

function toTrimmedOutput(value: unknown): string {
  if (Buffer.isBuffer(value)) return decodeAdapterBuffer(value).trim()
  return typeof value === "string" ? value.trim() : ""
}

function isValidUtf8Buffer(buffer: Buffer): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buffer)
    return true
  } catch {
    return false
  }
}

function detectAdapterOutputEncoding(buffer: Buffer): string {
  if (buffer.length === 0) return "utf-8"
  if (isValidUtf8Buffer(buffer)) return "utf-8"

  const detected = chardet.detect(buffer.subarray(0, CHARDET_SAMPLE_BYTES))
  const encoding = typeof detected === "string" ? detected : detected?.encoding
  const confidence = typeof detected === "object" ? detected.confidence : 1
  if (
    encoding &&
    encoding.toLowerCase() !== "ascii" &&
    iconv.encodingExists(encoding) &&
    confidence >= CHARDET_CONFIDENCE_THRESHOLD
  ) {
    return encoding
  }

  return process.platform === "win32" ? "gb18030" : "utf-8"
}

function decodeAdapterBuffer(buffer: Buffer): string {
  if (buffer.length === 0) return ""
  const encoding = detectAdapterOutputEncoding(buffer)
  try {
    return iconv.decode(buffer, encoding)
  } catch {
    return buffer.toString("utf-8")
  }
}

function formatAdapterError(error: unknown, label = "Harness adapter"): string {
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
  return `${label} ${exitInfo}: ${suffix}`
}

function tokenizeInspectCommand(command: string): string[] {
  const tokens: string[] = []
  let current = ""
  let quote: '"' | "'" | null = null

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]
    if (!ch) continue

    if (!quote) {
      if (ch === "\\") {
        const next = command[i + 1]
        if (next && (/\s/.test(next) || next === '"' || next === "'" || next === "\\")) {
          current += next
          i += 1
          continue
        }
        current += ch
        continue
      }
      if (ch === '"' || ch === "'") {
        quote = ch
        continue
      }
      if (/\s/.test(ch)) {
        if (current) {
          tokens.push(current)
          current = ""
        }
        continue
      }
      current += ch
      continue
    }

    if (quote === '"' && ch === "\\") {
      const next = command[i + 1]
      if (next === '"' || next === "\\") {
        current += next
        i += 1
        continue
      }
    }

    if (ch === quote) {
      quote = null
      continue
    }

    current += ch
  }

  if (quote) {
    throw new Error("Inspect adapter command parse failed: quote is not closed")
  }
  if (current) {
    tokens.push(current)
  }
  return tokens
}

function replaceHarnessConfigPlaceholders(
  value: string,
  project: HarnessProjectMetadata,
  mode: HarnessInspectCommandName,
  cwd: string,
  feature?: string
): string {
  const replacements: Record<string, string> = {
    pluginWorkspace: project.workspace.path,
    project: project.projectCode,
    projectCode: project.projectCode,
    feature: feature ?? "",
    pluginPath: cwd,
    mode
  }
  return value.replace(/\$\{(pluginWorkspace|project|projectCode|feature|pluginPath|mode)\}/g, (_, key: string) => {
    return replacements[key] ?? ""
  })
}

function parseInspectCommand(
  command: string,
  project: HarnessProjectMetadata,
  mode: HarnessInspectCommandName,
  cwd: string,
  feature?: string
): { executable: string; args: string[] } {
  const tokens = tokenizeInspectCommand(command.trim()).map((token) =>
    replaceHarnessConfigPlaceholders(token, project, mode, cwd, feature)
  )
  const [executable, ...args] = tokens
  if (!executable) {
    throw new Error("Inspect adapter command is empty")
  }
  return { executable, args }
}

function readBoardConfig(cwd: string): Record<string, unknown> | null {
  const configPath = join(cwd, "board_core", "board_config.json")
  if (!existsSync(configPath)) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf-8")) as unknown
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Invalid board_config.json: ${message}`)
  }

  return isObject(parsed) ? parsed : null
}

function readBoardConfigPlatformText(cwd: string, key: HarnessPlatformConfigKey): string | null {
  const parsed = readBoardConfig(cwd)
  if (!parsed || !isObject(parsed.inspectCommands)) return null
  const platformCommands = parsed.inspectCommands[process.platform]
  if (!isObject(platformCommands)) return null

  const command = normalizeText(platformCommands[key]).trim()
  return command || null
}

function readBoardConfigInspectCommand(cwd: string, mode: HarnessInspectCommandName): string | null {
  return readBoardConfigPlatformText(cwd, HARNESS_INSPECT_COMMAND_CONFIG_KEYS[mode])
}

function projectDirectoryPath(project: HarnessProjectMetadata): string {
  const workspacePath = resolve(project.workspace.path)
  const projectPath = resolve(workspacePath, project.projectCode)
  if (projectPath === workspacePath || !isInsideDirectory(workspacePath, projectPath)) {
    throw new Error(`Project code resolves outside workspace: ${project.projectCode}`)
  }
  return projectPath
}

function isInsideDirectory(basePath: string, targetPath: string): boolean {
  const relativePath = relative(resolve(basePath), resolve(targetPath))
  return relativePath === "" || (!!relativePath && !relativePath.startsWith("..") && !isAbsolute(relativePath))
}

function resolveAdapterFilePath(project: HarnessProjectMetadata, value: unknown): string | null {
  const rawPath = normalizeText(value).trim()
  if (!rawPath) return null
  const normalizedPath = rawPath.replace(/\\/g, "/")

  const projectPath = projectDirectoryPath(project)
  const resolvedPath = isAbsolute(normalizedPath)
    ? resolve(normalizedPath)
    : normalizedPath === project.projectCode || normalizedPath.startsWith(`${project.projectCode}/`)
      ? resolve(project.workspace.path, normalizedPath)
      : resolve(projectPath, normalizedPath)

  return isInsideDirectory(projectPath, resolvedPath) ? resolvedPath : null
}

function projectDirectoryMissingMessage(project: HarnessProjectMetadata): string {
  return `请确认项目「${project.projectCode}」的工作区「${project.workspace.path}」下是否有对应特性。`
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

function buildOptionalConfiguredHarnessInvocation(
  project: HarnessProjectMetadata,
  mode: HarnessInspectCommandName,
  feature?: string
): ConfiguredHarnessInvocation | null {
  const cwd = adapterPluginDir(project)
  const configuredCommand = readBoardConfigInspectCommand(cwd, mode)
  if (!configuredCommand) return null

  return {
    cwd,
    invocation: parseInspectCommand(configuredCommand, project, mode, cwd, feature)
  }
}

function buildConfiguredHarnessInvocation(
  project: HarnessProjectMetadata,
  mode: HarnessInspectCommandName,
  feature?: string
): ConfiguredHarnessInvocation {
  const configured = buildOptionalConfiguredHarnessInvocation(project, mode, feature)
  if (!configured) {
    const configKey = HARNESS_INSPECT_COMMAND_CONFIG_KEYS[mode]
    throw new Error(`插件未配置 inspectCommands.${process.platform}.${configKey}，请检查插件设置`)
  }
  return configured
}

function runHarnessInvocation({ cwd, invocation }: ConfiguredHarnessInvocation): Buffer {
  try {
    return execFileSync(invocation.executable, invocation.args, {
      cwd,
      encoding: "buffer",
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
        PYTHONUTF8: "1"
      },
      maxBuffer: HARNESS_ADAPTER_MAX_BUFFER,
      timeout: HARNESS_ADAPTER_TIMEOUT_MS
    })
  } catch (error) {
    throw new Error(formatAdapterError(error))
  }
}

function runConfiguredHarnessCommand(
  project: HarnessProjectMetadata,
  mode: HarnessInspectCommandName,
  feature?: string
): Buffer {
  return runHarnessInvocation(buildConfiguredHarnessInvocation(project, mode, feature))
}

function runInspectAdapter(
  project: HarnessProjectMetadata,
  mode: "project" | "run",
  feature?: string
): Record<string, unknown> {
  const stdoutBuffer = runConfiguredHarnessCommand(project, mode, feature)

  const raw = decodeAdapterBuffer(stdoutBuffer).trim()
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

const UNKNOWN_STATUS: HarnessStatus = { label: "未知", uiKind: "unknown" }

function normalizeStatus(value: unknown): HarnessStatus {
  if (!isObject(value)) return UNKNOWN_STATUS

  const label = normalizeText(value.label)
  if (!label || !HARNESS_UI_KINDS.has(value.uiKind as HarnessStatus["uiKind"])) {
    return UNKNOWN_STATUS
  }

  return {
    label,
    uiKind: value.uiKind as HarnessStatus["uiKind"]
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
  const normalizedPath = rawPath.replace(/\\/g, "/")
  if (isAbsolute(normalizedPath)) {
    const relativePath = relative(project.workspace.path, normalizedPath)
    if (relativePath && !relativePath.startsWith("..") && !isAbsolute(relativePath)) {
      return relativePath.replace(/\\/g, "/")
    }
    return normalizedPath
  }
  if (normalizedPath === ".autobizdevops" || normalizedPath.startsWith(".autobizdevops/")) {
    return `${project.projectCode}/${normalizedPath}`
  }
  return normalizedPath
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

function normalizeProjectRun(value: unknown, workflow: HarnessWorkflow): HarnessFeatureSummary | null {
  if (!isObject(value)) return null
  const slug = normalizeText(value.featureId) || normalizeText(value.featureName)
  if (!slug) return null

  const currentNodeId = normalizeText(value.currentNodeId) || "unknown"
  const currentNodeDefinition = workflow.nodes.find((node) => node.id === currentNodeId)
  const status = statusFromWorkflowStateId(
    workflow,
    currentNodeDefinition,
    normalizeText(value.currentStateId)
  )
  const currentNodeLabel = currentNodeDefinition?.label ?? currentNodeId
  const summaryText = currentNodeLabel ? `${currentNodeLabel} · ${status.label}` : status.label

  return {
    id: slug,
    kind: "feature",
    slug,
    title: normalizeText(value.featureName) || slug,
    location: status.uiKind === "archived" ? "archived" : "active",
    overallStatus: status,
    currentNodeId,
    summary: {
      text: summaryText,
      updatedAt: ""
    }
  }
}

function normalizeProjectRuns(snapshot: Record<string, unknown>, workflow: HarnessWorkflow): HarnessFeatureSummary[] {
  if (!Array.isArray(snapshot.runs)) return []
  return snapshot.runs
    .map((run) => normalizeProjectRun(run, workflow))
    .filter((run): run is HarnessFeatureSummary => run !== null)
}

function normalizeWorkflowStateDefinition(
  value: unknown
): NonNullable<HarnessWorkflow["nodes"][number]["states"]>[number] | null {
  if (!isObject(value)) return null
  const id = normalizeText(value.id)
  if (!id) return null
  const status = normalizeStatus(value)
  return {
    id,
    label: status.label,
    uiKind: status.uiKind
  }
}

function normalizeWorkflowNodeDefinition(value: unknown): HarnessWorkflow["nodes"][number] | null {
  if (!isObject(value)) return null
  const id = normalizeText(value.id)
  if (!id) return null
  const group = normalizeText(value.group)

  return {
    id,
    label: normalizeText(value.label) || id,
    ...(group ? { group } : {}),
    description: normalizeText(value.description) || undefined,
    states: Array.isArray(value.states)
      ? value.states
          .map((state) => normalizeWorkflowStateDefinition(state))
          .filter((state): state is NonNullable<typeof state> => state !== null)
      : undefined,
    artifactDefinitions: Array.isArray(value.artifactDefinitions)
      ? value.artifactDefinitions
          .map((artifact) => {
            if (!isObject(artifact)) return null
            const artifactId = normalizeText(artifact.id)
            if (!artifactId) return null
            return {
              id: artifactId,
              label: normalizeText(artifact.label) || artifactId,
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
    display: isObject(workflow.display)
      ? {
          mode: normalizeText(workflow.display.mode) || "ordered_nodes",
          groupBy: normalizeText(workflow.display.groupBy) || undefined
        }
      : {
          mode: "ordered_nodes",
          groupBy: "group"
        },
    states: Array.isArray(workflow.states)
      ? workflow.states
          .map((state) => normalizeWorkflowStateDefinition(state))
          .filter((state): state is NonNullable<typeof state> => state !== null)
      : undefined,
    nodes: Array.isArray(workflow.nodes)
      ? workflow.nodes
          .map((node) => normalizeWorkflowNodeDefinition(node))
          .filter((node): node is HarnessWorkflow["nodes"][number] => node !== null)
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
        kind: "file",
        path: null,
        required: artifact.required,
        status: UNKNOWN_STATUS
      })
    }
    byNode.set(node.id, artifacts)
  }
  return byNode
}

function statusFromWorkflowStateId(
  workflow: HarnessWorkflow,
  nodeDefinition: HarnessWorkflow["nodes"][number] | undefined,
  stateId: string
): HarnessStatus {
  const state =
    nodeDefinition?.states?.find((item) => item.id === stateId) ??
    workflow.states?.find((item) => item.id === stateId)
  return state ? { label: state.label, uiKind: state.uiKind } : UNKNOWN_STATUS
}

function normalizeArtifact(
  project: HarnessProjectMetadata,
  value: unknown,
  definition?: HarnessArtifact
): HarnessArtifact | null {
  if (!isObject(value)) return null
  const id = normalizeText(value.id)
  if (!id) return null
  return {
    id,
    label: definition?.label || normalizeText(value.label) || id,
    kind: normalizeArtifactKind(value.kind),
    path: normalizeAdapterPath(project, value.path),
    required: typeof value.required === "boolean" ? value.required : definition?.required ?? false,
    status: normalizeStatus(value.status),
    ...(typeof value.nonEmpty === "boolean" ? { nonEmpty: value.nonEmpty } : {}),
    ...(typeof value.size === "number" ? { size: value.size } : {}),
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
    status: normalizeStatus(value.status),
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
  const runNodesById = new Map<string, Record<string, unknown>>()
  if (Array.isArray(nodes)) {
    for (const node of nodes) {
      if (!isObject(node)) continue
      const id = normalizeText(node.id)
      if (id) runNodesById.set(id, node)
    }
  }
  const artifactDefinitions = workflowArtifactDefinitions(workflow)
  return workflow.nodes.map((nodeDefinition): HarnessRunNode => {
      const node = runNodesById.get(nodeDefinition.id)
      const id = nodeDefinition.id
      const definitions = artifactDefinitions.get(id)
      const stateId = normalizeText(node?.stateId)
      return {
        id,
        label: nodeDefinition.label,
        ...(nodeDefinition.group ? { group: nodeDefinition.group } : {}),
        status: statusFromWorkflowStateId(workflow, nodeDefinition, stateId),
        artifacts: Array.isArray(node?.artifacts)
          ? node.artifacts
              .map((artifact) => {
                const artifactId = isObject(artifact) ? normalizeText(artifact.id) : ""
                return normalizeArtifact(project, artifact, artifactId ? definitions?.get(artifactId) : undefined)
              })
              .filter((artifact): artifact is HarnessArtifact => artifact !== null)
          : [],
        hooks: Array.isArray(node?.hooks)
          ? node.hooks
              .map((hook) => normalizeHook(hook))
              .filter((hook): hook is HarnessRunNode["hooks"][number] => hook !== null)
          : []
      }
    })
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
    lifecycle: {
      status: value.lifecycle && lifecycle.status === "archived" ? "archived" : "active"
    }
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
      status: project.lifecycle.status
    }
  }
}

function requireProject(projectId: string): HarnessProjectMetadata {
  const project = readProjectStore().projects.find((item) => item.projectId === projectId)
  if (!project) {
    throw new Error("Project not found")
  }
  return project
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
  validateHarnessName(input.name, "项目名称")
  validateHarnessName(input.projectCode, "项目编号")
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
  validateHarnessName(input.name, "项目名称")
  validateHarnessName(input.projectCode, "项目编号")
}

function validateHarnessName(value: unknown, label: string): void {
  if (!HARNESS_NAME_PATTERN.test(normalizeText(value))) {
    throw new Error(`${label}${HARNESS_NAME_RULE_MESSAGE}`)
  }
}

function validateProjectCodeUnique(code: string, store: HarnessProjectStoreFile, excludeProjectId?: string): void {
  const trimmed = code.trim()
  const duplicate = store.projects.find(
    (item) => item.projectCode === trimmed && item.projectId !== excludeProjectId
  )
  if (duplicate) {
    throw new Error(`项目编号：${trimmed} 已被使用，请更换`)
  }
}

function validateFeatureCreateInput(input: HarnessFeatureCreateInput): void {
  const feature = normalizeText(input.feature).trim()
  if (!normalizeText(input.projectId).trim() || !feature) {
    throw new Error("Project and feature name are required")
  }
  if (feature.includes("\0")) {
    throw new Error("Feature name contains invalid characters")
  }
  validateHarnessName(input.feature, "特性名称")
}

function okStatus(_id: string, label: string): HarnessStatus {
  return { label, uiKind: "ok" }
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

function makeProjectDetailViewModel(
  project: HarnessProjectMetadata,
  data: {
    workflow: HarnessWorkflow
    runs: HarnessFeatureSummary[]
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
      mock: false
    },
    projectState: data.projectState,
    workflow: data.workflow,
    runs: data.runs,
    watchRefs: data.watchRefs,
    loading: false,
    error: data.error
  }
}

function initializeHarnessProject(project: HarnessProjectMetadata): void {
  try {
    const projectPath = projectDirectoryPath(project)
    if (existsSync(projectPath)) {
      throw new Error(`项目目录已存在：${projectPath}`)
    }

    const configured = buildConfiguredHarnessInvocation(project, "createProject")

    mkdirSync(projectPath, { recursive: true })
    runHarnessInvocation(configured)
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error)
    if (raw.includes("已存在")) {
      throw new Error("该项目编号已在所选工作区存在")
    }
    throw new Error(`创建项目失败：${raw}`)
  }
}

function readHarnessFeatureMetadata(metadata: unknown): { projectId: string; slug: string } | null {
  if (!isObject(metadata) || !isObject(metadata.harnessFeature)) return null
  const projectId = normalizeText(metadata.harnessFeature.projectId).trim()
  const slug = normalizeText(metadata.harnessFeature.slug).trim()
  return projectId && slug ? { projectId, slug } : null
}

export function buildHarnessFeatureCreatePrompt(metadata: unknown): string | null {
  const feature = readHarnessFeatureMetadata(metadata)
  if (!feature) return null

  const project = requireProject(feature.projectId)
  const cwd = adapterPluginDir(project)
  const template = readBoardConfigPlatformText(cwd, "feature_create_prompt")
  if (!template) return null

  return replaceHarnessConfigPlaceholders(template, project, "createFeature", cwd, feature.slug).trim() || null
}

export function buildHarnessFeaturePluginDirPrompt(metadata: unknown): string | null {
  const feature = readHarnessFeatureMetadata(metadata)
  if (!feature) return null

  const project = requireProject(feature.projectId)
  const cwd = adapterPluginDir(project)
  const template = readBoardConfigPlatformText(cwd, "plugin_dir_prompt")
  if (!template) return null

  return replaceHarnessConfigPlaceholders(template, project, "run", cwd, feature.slug).trim() || null
}

export function buildHarnessFeaturePluginOutputDir(metadata: unknown): string | null {
  const feature = readHarnessFeatureMetadata(metadata)
  if (!feature) return null

  const project = requireProject(feature.projectId)
  const cwd = adapterPluginDir(project)
  const template = readBoardConfigPlatformText(cwd, "plugin_dir_hook")
  if (!template) return null

  return replaceHarnessConfigPlaceholders(template, project, "run", cwd, feature.slug).trim() || null
}

export function buildHarnessFeatureDialogTips(projectId: string, slug: string): string | null {
  const normalizedProjectId = normalizeText(projectId).trim()
  const feature = normalizeText(slug).trim()
  if (!normalizedProjectId || !feature) return null

  const project = requireProject(normalizedProjectId)
  const cwd = adapterPluginDir(project)
  const template = readBoardConfigPlatformText(cwd, "dialog_tips")
  if (!template) return null

  return replaceHarnessConfigPlaceholders(template, project, "run", cwd, feature).trim() || null
}

export function listHarnessProjects(): HarnessProjectListItem[] {
  return readProjectStore().projects.map(toListItem)
}

export function createHarnessProject(input: HarnessProjectCreateInput): HarnessProjectMetadata {
  validateCreateInput(input)
  const store = readProjectStore()
  validateProjectCodeUnique(input.projectCode, store)
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
      status: "active"
    }
  }

  initializeHarnessProject(project)
  store.projects.unshift(project)
  writeProjectStore(store)
  return project
}

export function createHarnessFeature(input: HarnessFeatureCreateInput): HarnessFeatureCreateResult {
  validateFeatureCreateInput(input)
  const project = requireProject(input.projectId)
  const feature = input.feature.trim()
  const workspacePath = projectDirectoryPath(project)

  if (!existsSync(workspacePath)) {
    throw new Error(projectDirectoryMissingMessage(project))
  }

  try {
    runConfiguredHarnessCommand(project, "createFeature", feature)
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error)
    if (raw.includes("已存在")) {
      throw new Error("该特性在当前项目路径下已存在")
    }
    throw new Error(`创建特性失败：${raw}`)
  }

  return {
    projectId: project.projectId,
    slug: feature,
    title: feature,
    workspacePath
  }
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

  validateProjectCodeUnique(input.projectCode, store, projectId)
  const existing = store.projects[index]
  const existingWorkspacePath = existing.workspace.path.trim()
  const requestedWorkspacePath = input.workspace.path.trim()
  if (requestedWorkspacePath !== existingWorkspacePath) {
    throw new Error("项目工作区路径不允许修改")
  }
  const newCode = input.projectCode.trim()
  const codeChanged = existing.projectCode !== newCode
  if (codeChanged) {
    const oldPath = resolve(existing.workspace.path, existing.projectCode)
    const newPath = resolve(existing.workspace.path, newCode)
    if (existsSync(oldPath)) {
      if (existsSync(newPath)) {
        throw new Error(`重命名失败：目标目录已存在 ${newPath}`)
      }
      try {
        renameSync(oldPath, newPath)
      } catch (e) {
        throw new Error(`重命名项目目录失败：${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }
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
      path: existing.workspace.path
    },
    "harness-adapter": harnessAdapter,
    lifecycle: {
      ...existing.lifecycle
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

  const existing = store.projects[index]
  const archived: HarnessProjectMetadata = {
    ...existing,
    lifecycle: {
      ...existing.lifecycle,
      status: "archived"
    }
  }

  store.projects[index] = archived
  writeProjectStore(store)
  return archived
}

export function getHarnessProjectDetail(projectId: string): HarnessProjectDetailViewModel {
  const project = requireProject(projectId)
  const fallbackWatchRefs = makeWatchRefs(project.projectCode)

  if (!existsSync(projectDirectoryPath(project))) {
    return makeProjectDetailViewModel(project, {
      workflow: normalizeWorkflow(null),
      runs: [],
      watchRefs: fallbackWatchRefs,
      projectState: { label: "项目目录不存在", uiKind: "warning" },
      error: projectDirectoryMissingMessage(project)
    })
  }

  try {
    const snapshot = runInspectAdapter(project, "project")
    const workflow = normalizeWorkflow(snapshot.workflow)
    const runs = normalizeProjectRuns(snapshot, workflow)
    return makeProjectDetailViewModel(project, {
      workflow,
      runs,
      watchRefs: normalizeWatchRefs(project, snapshot.watchRefs, fallbackWatchRefs),
      projectState: okStatus("inspected", "Inspect 已加载"),
      error: null
    })
  } catch (error) {
    return makeProjectDetailViewModel(project, {
      workflow: normalizeWorkflow(null),
      runs: [],
      watchRefs: fallbackWatchRefs,
      projectState: { label: "Inspect 读取失败", uiKind: "warning" },
      error: formatProjectDetailError(project, error)
    })
  }
}

export function getHarnessRunDetail(projectId: string, slug: string): HarnessRunDetailViewModel {
  const project = requireProject(projectId)
  const snapshot = runInspectAdapter(project, "run", slug)
  const workflow = normalizeWorkflow(snapshot.workflow)
  const run = isObject(snapshot.run) ? snapshot.run : {}
  const featureSlug = normalizeText(run.featureId) || normalizeText(run.featureName) || slug
  const title = normalizeText(run.featureName) || featureSlug
  const currentNodeId = normalizeText(run.currentNodeId)
  const nodes = normalizeRunNodes(project, run.nodes, workflow)
  const hookLogRefs = normalizeHookLogRefs(project, run.hookLogRefs)
  const hookLogEntries = readHookLogRefs(project, hookLogRefs)
  const { nodes: nodesWithHookLogs, unmatchedHooks } = applyHookLogEntries(nodes, hookLogEntries)
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
      mock: false
    },
    workflow,
    run: {
      id: featureSlug,
      kind: "feature",
      slug: featureSlug,
      title,
      source: {
        label: project["harness-adapter"].name
      },
      hookLogRefs,
      watchRefs: normalizeWatchRefs(project, run.watchRefs, makeWatchRefs(project.projectCode, featureSlug)),
      currentNodeId,
      nodes: nodesWithHookLogs,
      unmatchedHooks
    },
    sessions: []
  }
}
