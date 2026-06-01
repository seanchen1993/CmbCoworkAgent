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
  HarnessArtifactStatus,
  HarnessArtifactType,
  HarnessBoardCompatibility,
  HarnessEventStatus,
  HarnessFeatureCreateInput,
  HarnessFeatureCreateResult,
  HarnessNodeStatus,
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
  HarnessWorkflow,
  HarnessWorkflowArtifactDefinition,
  HarnessWorkflowNextAction
} from "../../shared/harness-board-types"

interface HarnessProjectStoreFile {
  version: 1
  projects: HarnessProjectMetadata[]
}

type HarnessHookLogRef = HarnessRunDetailViewModel["run"]["hookLogRefs"][number]
type HarnessInspectCommandName = "project" | "run" | "createProject" | "createFeature"
type HarnessInspectCommandConfigKey = "project_status" | "feature_status" | "create_project" | "create_feature"
type HarnessPlatformConfigKey =
  | HarnessInspectCommandConfigKey
  | "system_prompt_inject"
  | "plugin_dir_hook"
  | "dialog_tips"

const HARNESS_INSPECT_COMMAND_CONFIG_KEYS: Record<HarnessInspectCommandName, HarnessInspectCommandConfigKey> = {
  project: "project_status",
  run: "feature_status",
  createProject: "create_project",
  createFeature: "create_feature"
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

const HARNESS_NODE_STATUSES = new Set<HarnessNodeStatus>([
  "not_started",
  "in_progress",
  "done",
  "blocked",
  "skipped",
  "archived",
  "unknown"
])

const DEFAULT_NODE_STATUS_LABELS: Record<HarnessNodeStatus, string> = {
  not_started: "未开始",
  in_progress: "进行中",
  done: "已完成",
  blocked: "阻断",
  skipped: "跳过",
  archived: "已归档",
  unknown: "未知"
}

const NODE_STATUS_UI_KIND: Record<HarnessNodeStatus, HarnessStatus["uiKind"]> = {
  not_started: "pending",
  in_progress: "active",
  done: "done",
  blocked: "blocked",
  skipped: "skipped",
  archived: "archived",
  unknown: "unknown"
}

const HARNESS_ARTIFACT_TYPES = new Set<HarnessArtifactType>([
  "file",
  "directory",
  "markdown",
  "text",
  "log",
  "yaml",
  "json",
  "report",
  "external",
  "virtual",
  "unknown"
])

const HARNESS_ARTIFACT_STATUSES = new Set<HarnessArtifactStatus>([
  "generated",
  "missing",
  "partial",
  "invalid",
  "unknown"
])

const HARNESS_EVENT_STATUSES = new Set<HarnessEventStatus>([
  "success",
  "blocked",
  "skipped",
  "error",
  "unknown"
])

const DEFAULT_ARTIFACT_STATUS_LABELS: Record<HarnessArtifactStatus, string> = {
  generated: "已生成",
  missing: "未生成",
  partial: "部分生成",
  invalid: "不可用",
  unknown: "未知"
}

const ARTIFACT_STATUS_UI_KIND: Record<HarnessArtifactStatus, HarnessStatus["uiKind"]> = {
  generated: "ok",
  missing: "warning",
  partial: "warning",
  invalid: "error",
  unknown: "unknown"
}

const APP_BOARD_API_VERSION = 1
const BOARD_CONFIG_REL_PATH = join("board_core", "board_config.json")

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

function parsePositiveInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value
  if (typeof value === "string" && /^[1-9]\d*$/.test(value.trim())) {
    return Number.parseInt(value.trim(), 10)
  }
  return null
}

function pluginAdapterId(plugin: PluginMetadata): string {
  return plugin.id
}

function pluginHasBoardConfig(plugin: PluginMetadata): boolean {
  return existsSync(join(plugin.path, BOARD_CONFIG_REL_PATH))
}

function makeBoardCompatibility(
  status: HarnessBoardCompatibility["status"],
  label: string,
  message?: string,
  pluginApiVersion?: number
): HarnessBoardCompatibility {
  return {
    status,
    compatible: status === "compatible",
    appApiVersion: APP_BOARD_API_VERSION,
    ...(pluginApiVersion !== undefined ? { pluginApiVersion } : {}),
    label,
    ...(message ? { message } : {})
  }
}

function evaluateBoardPluginCompatibility(
  plugin: PluginMetadata | null,
  pluginName: string
): HarnessBoardCompatibility {
  const displayName = plugin?.name || pluginName || "插件"
  if (!plugin) {
    return makeBoardCompatibility(
      "missing-plugin",
      "插件未安装",
      `项目使用的插件未安装：${displayName}`
    )
  }

  if (!pluginHasBoardConfig(plugin)) {
    return makeBoardCompatibility(
      "missing-board-config",
      "插件与看板不兼容",
      `插件「${displayName}」未提供看板能力，请安装兼容版本插件。`
    )
  }

  let config: Record<string, unknown> | null
  try {
    config = readBoardConfig(plugin.path)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return makeBoardCompatibility(
      "invalid-board-config",
      "配置错误",
      `插件「${displayName}」的 ${BOARD_CONFIG_REL_PATH} 配置错误：${message}`
    )
  }

  const pluginApiVersion = parsePositiveInteger(config?.apiVersion)
  if (pluginApiVersion === null) {
    return makeBoardCompatibility(
      "invalid-api-version",
      "插件与客户端版本不兼容",
      `插件「${displayName}」未声明 apiVersion，请将插件和客户端升级至最新版。`
    )
  }

  if (pluginApiVersion < APP_BOARD_API_VERSION) {
    return makeBoardCompatibility(
      "plugin-too-old",
      "插件版本过低",
      `插件「${displayName}」的apiVersion: ${pluginApiVersion} 低于客户端支持的版本: ${APP_BOARD_API_VERSION}，请到应用市场升级插件。`,
      pluginApiVersion
    )
  }
  if (pluginApiVersion > APP_BOARD_API_VERSION) {
    return makeBoardCompatibility(
      "app-too-old",
      "客户端版本过低",
      `插件「${displayName}」的apiVersion: ${pluginApiVersion} 高于客户端支持的版本: ${APP_BOARD_API_VERSION}，请获取最新版客户端。`,
      pluginApiVersion
    )
  }

  return makeBoardCompatibility("compatible", "兼容", undefined, pluginApiVersion)
}

function pluginMatchesAdapterId(plugin: PluginMetadata, adapterId: string): boolean {
  return (
    pluginAdapterId(plugin) === adapterId ||
    plugin.name === adapterId ||
    basename(plugin.path) === adapterId
  )
}

function findPluginForAdapterSnapshot(adapter: HarnessAdapterSnapshot): PluginMetadata | null {
  if (adapter.type !== "plugin") return null
  const plugins = getPlugins().filter(pluginHasBoardConfig)
  const adapterName = normalizeText(adapter.name).trim()
  if (adapterName) {
    const plugin = plugins.find((item) => item.name === adapterName)
    if (plugin) return plugin
  }

  const adapterId = normalizeText(adapter.id).trim()
  if (!adapterId) return null
  return plugins.find((item) => pluginMatchesAdapterId(item, adapterId)) ?? null
}

function findPluginByAdapterName(adapter: HarnessAdapterSnapshot): PluginMetadata | null {
  if (adapter.type !== "plugin") return null
  const adapterName = normalizeText(adapter.name).trim()
  if (!adapterName) return null
  return getPlugins().find((item) => item.name === adapterName) ?? null
}

function pluginToHarnessAdapter(plugin: PluginMetadata): HarnessAdapterRegistryItem {
  const id = pluginAdapterId(plugin)
  return {
    id,
    name: normalizeText(plugin.name) || id,
    version: normalizeText(plugin.version),
    type: "plugin",
    description: normalizeText(plugin.description),
    boardCompatibility: evaluateBoardPluginCompatibility(plugin, normalizeText(plugin.name) || id)
  }
}

function pluginToHarnessAdapterSnapshot(plugin: PluginMetadata): HarnessAdapterSnapshot {
  const adapter = pluginToHarnessAdapter(plugin)
  return {
    id: adapter.id,
    name: adapter.name,
    version: adapter.version,
    type: adapter.type
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
  const compatibility = evaluateBoardPluginCompatibility(plugin, plugin.name)
  if (!compatibility.compatible) {
    throw new Error(compatibility.message || "Selected plugin is not compatible with current APP")
  }
  return pluginToHarnessAdapterSnapshot(plugin)
}

function resolveHarnessAdapterSnapshot(adapter: HarnessAdapterSnapshot): HarnessAdapterSnapshot {
  const plugin = findPluginForAdapterSnapshot(adapter)
  if (!plugin) {
    throw new Error("Selected plugin is not installed or does not provide board_core/board_config.json")
  }
  return pluginToHarnessAdapterSnapshot(plugin)
}

function adapterPluginDir(project: HarnessProjectMetadata): string {
  const adapter = project["harness-adapter"]
  if (adapter.type !== "plugin") {
    throw new Error(`Unsupported harness adapter type: ${adapter.type}`)
  }

  const plugin = findAdapterPlugin(project)
  const compatibility = evaluateBoardPluginCompatibility(plugin, adapter.name || adapter.id)
  if (!compatibility.compatible) {
    throw new Error(compatibility.message || `Harness adapter plugin not compatible: ${adapter.name || adapter.id}`)
  }
  if (!plugin) {
    throw new Error(`Harness adapter plugin not found: ${adapter.name || adapter.id}`)
  }
  return plugin.path
}

function findAdapterPlugin(project: HarnessProjectMetadata): PluginMetadata | null {
  const adapter = project["harness-adapter"]
  return findPluginByAdapterName(adapter)
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
    pluginWorkspace: project.workspacePath,
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
  feature?: string,
  projectCodes?: string[]
): { executable: string; args: string[] } {
  const tokens = tokenizeInspectCommand(command.trim()).flatMap((token) =>
    token === "${projectCodes...}" && projectCodes
      ? projectCodes
      : [replaceHarnessConfigPlaceholders(token, project, mode, cwd, feature)]
  )
  const [executable, ...args] = tokens
  if (!executable) {
    throw new Error("Inspect adapter command is empty")
  }
  return { executable, args }
}

function readBoardConfig(cwd: string): Record<string, unknown> | null {
  const configPath = join(cwd, BOARD_CONFIG_REL_PATH)
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
  const workspacePath = resolve(project.workspacePath)
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
  return resolveProjectScopedPath(project, value)?.absolutePath ?? null
}

function resolveProjectScopedPath(
  project: HarnessProjectMetadata,
  value: unknown
): { absolutePath: string; relativePath: string } | null {
  const rawPath = normalizeText(value).trim()
  if (!rawPath) return null
  const normalizedPath = rawPath.replace(/\\/g, "/")

  const projectPath = projectDirectoryPath(project)
  const resolvedPath = isAbsolute(normalizedPath)
    ? resolve(normalizedPath)
    : resolve(projectPath, normalizedPath)

  if (!isInsideDirectory(projectPath, resolvedPath)) return null
  const relativePath = relative(projectPath, resolvedPath).replace(/\\/g, "/")
  return {
    absolutePath: resolvedPath,
    relativePath: relativePath || "."
  }
}

function projectDirectoryMissingMessage(project: HarnessProjectMetadata): string {
  return `请确认项目「${project.projectCode}」的工作区「${project.workspacePath}」下是否有对应特性。`
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
  const invocation = buildConfiguredHarnessInvocation(project, mode, feature)
  const cmdLine = [invocation.invocation.executable, ...invocation.invocation.args].join(" ")

  if (mode === "project") {
    console.log(`[HarnessBoard] [project_status] Running: ${cmdLine}`)
  }

  const stdoutBuffer = runHarnessInvocation(invocation)

  const raw = decodeAdapterBuffer(stdoutBuffer).trim()

  if (mode === "project") {
    console.log(`[HarnessBoard] [project_status] Result bytes: ${stdoutBuffer.length}`)
  }

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

const UNKNOWN_NODE_STATUS: HarnessNodeStatus = "unknown"
const UNKNOWN_ARTIFACT_TYPE: HarnessArtifactType = "unknown"
const UNKNOWN_ARTIFACT_STATUS: HarnessArtifactStatus = "unknown"

function normalizeNodeStatus(value: unknown): HarnessNodeStatus {
  const nodeStatus = normalizeText(value)
  return HARNESS_NODE_STATUSES.has(nodeStatus as HarnessNodeStatus)
    ? (nodeStatus as HarnessNodeStatus)
    : UNKNOWN_NODE_STATUS
}

function statusFromNodeStatus(nodeStatus: HarnessNodeStatus, label?: string): HarnessStatus {
  return {
    label: label?.trim() || DEFAULT_NODE_STATUS_LABELS[nodeStatus],
    uiKind: NODE_STATUS_UI_KIND[nodeStatus]
  }
}

function normalizeArtifactType(value: unknown): HarnessArtifactType {
  const artifactType = normalizeText(value)
  return HARNESS_ARTIFACT_TYPES.has(artifactType as HarnessArtifactType)
    ? (artifactType as HarnessArtifactType)
    : UNKNOWN_ARTIFACT_TYPE
}

function normalizeArtifactStatus(value: unknown): HarnessArtifactStatus {
  const artifactStatus = normalizeText(value)
  return HARNESS_ARTIFACT_STATUSES.has(artifactStatus as HarnessArtifactStatus)
    ? (artifactStatus as HarnessArtifactStatus)
    : UNKNOWN_ARTIFACT_STATUS
}

function normalizeEventStatus(value: unknown): HarnessEventStatus {
  const eventStatus = normalizeText(value)
  return HARNESS_EVENT_STATUSES.has(eventStatus as HarnessEventStatus)
    ? (eventStatus as HarnessEventStatus)
    : "unknown"
}

function statusFromArtifactStatus(
  artifactStatus: HarnessArtifactStatus,
  label?: string
): HarnessStatus {
  return {
    label: label?.trim() || DEFAULT_ARTIFACT_STATUS_LABELS[artifactStatus],
    uiKind: ARTIFACT_STATUS_UI_KIND[artifactStatus]
  }
}

function normalizeAdapterPath(project: HarnessProjectMetadata, value: unknown): string | null {
  return resolveProjectScopedPath(project, value)?.relativePath ?? null
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
  const currentNodeStatus = normalizeNodeStatus(value.currentNodeStatus)
  const currentNodeStatusLabel = normalizeText(value.currentNodeStatusLabel).trim()
  const currentNodeIndex = workflow.nodes.findIndex((node) => node.id === currentNodeId)
  const currentNodeDefinition = currentNodeIndex >= 0 ? workflow.nodes[currentNodeIndex] : undefined
  const isFinalNode = currentNodeIndex >= 0 && currentNodeIndex === workflow.nodes.length - 1
  // This is a feature-level summary status. Before the final node, the feature
  // is still considered active even when the current node's own state is done.
  const status = isFinalNode
    ? statusFromNodeStatus(currentNodeStatus, currentNodeStatusLabel)
    : { label: "进行中", uiKind: "active" as const }
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
    currentNodeStatus,
    ...(currentNodeStatusLabel ? { currentNodeStatusLabel } : {}),
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
  const nodeStatusValue = normalizeText(value.nodeStatus)
  if (!HARNESS_NODE_STATUSES.has(nodeStatusValue as HarnessNodeStatus)) return null
  const nodeStatus = nodeStatusValue as HarnessNodeStatus
  const nextAction = normalizeWorkflowNextAction(value.nextAction)
  return {
    nodeStatus,
    ...(nextAction ? { nextAction } : {})
  }
}

function normalizeWorkflowNextAction(value: unknown): HarnessWorkflowNextAction | undefined {
  if (!isObject(value)) return undefined
  const slashSkill = normalizeText(value.slashSkill).trim()
  const userMessage = normalizeText(value.userMessage).trim()
  const dialogTips = normalizeText(value.dialogTips).trim()
  const nextAction = {
    ...(slashSkill ? { slashSkill } : {}),
    ...(userMessage ? { userMessage } : {}),
    ...(dialogTips ? { dialogTips } : {})
  }
  return Object.keys(nextAction).length > 0 ? nextAction : undefined
}

function normalizeWorkflowArtifactDefinition(value: unknown): HarnessWorkflowArtifactDefinition | null {
  if (!isObject(value)) return null
  const artifactId = normalizeText(value.id)
  if (!artifactId) return null
  return {
    id: artifactId,
    required: typeof value.required === "boolean" ? value.required : false,
    artifactType: normalizeArtifactType(value.artifactType)
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
          .map((artifact) => normalizeWorkflowArtifactDefinition(artifact))
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

function workflowArtifactDefinitions(workflow: HarnessWorkflow): Map<string, Map<string, HarnessWorkflowArtifactDefinition>> {
  const byNode = new Map<string, Map<string, HarnessWorkflowArtifactDefinition>>()
  for (const node of workflow.nodes) {
    const artifacts = new Map<string, HarnessWorkflowArtifactDefinition>()
    for (const artifact of node.artifactDefinitions ?? []) {
      artifacts.set(artifact.id, artifact)
    }
    byNode.set(node.id, artifacts)
  }
  return byNode
}

function normalizeArtifact(
  project: HarnessProjectMetadata,
  value: unknown,
  definition?: HarnessWorkflowArtifactDefinition
): HarnessArtifact | null {
  if (!isObject(value)) return null
  const id = normalizeText(value.id)
  if (!id) return null
  const artifactLabel = normalizeText(value.artifactLabel).trim() || id
  const artifactStatus = normalizeArtifactStatus(value.artifactStatus)
  const artifactStatusLabel = normalizeText(value.artifactStatusLabel).trim()
  const path = normalizeAdapterPath(project, value.path)
  const paths = Array.isArray(value.paths)
    ? (value.paths as unknown[])
        .map((p) => normalizeAdapterPath(project, p))
        .filter((p): p is string => p !== null)
    : []
  return {
    id,
    artifactLabel,
    artifactType: definition?.artifactType ?? UNKNOWN_ARTIFACT_TYPE,
    path: paths.length > 0 ? null : path,
    required: definition?.required ?? false,
    artifactStatus,
    ...(artifactStatusLabel ? { artifactStatusLabel } : {}),
    status: statusFromArtifactStatus(artifactStatus, artifactStatusLabel),
    ...(Array.isArray(value.paths) ? { paths } : {})
  }
}

function normalizeHook(value: unknown): HarnessRunNode["hooks"][number] | null {
  if (!isObject(value)) return null
  const eventId = normalizeText(value.eventId)
  if (!eventId) return null
  return {
    ts: normalizeText(value.ts),
    source: normalizeText(value.source),
    sessionId: normalizeText(value.sessionId),
    pluginId: normalizeText(value.pluginId),
    featureId: normalizeText(value.featureId),
    eventId,
    eventStatus: normalizeEventStatus(value.eventStatus),
    message: normalizeText(value.message),
    nodeId: normalizeText(value.nodeId)
  }
}

function hookTimestampValue(hook: HarnessRunNode["hooks"][number]): number {
  const normalized = hook.ts.trim().replace(" ", "T")
  const value = Date.parse(normalized)
  return Number.isFinite(value) ? value : 0
}

function compareHooksByLatestFirst(a: HarnessHookLogEntry, b: HarnessHookLogEntry): number {
  const diff = hookTimestampValue(b.hook) - hookTimestampValue(a.hook)
  return diff !== 0 ? diff : b.hook.ts.localeCompare(a.hook.ts)
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
          nodeId: hook.nodeId,
          hook
        })
      } catch {
        // Malformed hook log lines should not break feature detail rendering.
      }
    }
  }

  return entries.sort(compareHooksByLatestFirst)
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
      const nodeStatus = normalizeNodeStatus(node?.nodeStatus)
      const nodeStatusLabel = normalizeText(node?.nodeStatusLabel).trim()
      return {
        id,
        label: nodeDefinition.label,
        ...(nodeDefinition.group ? { group: nodeDefinition.group } : {}),
        nodeStatus,
        ...(nodeStatusLabel ? { nodeStatusLabel } : {}),
        status: statusFromNodeStatus(nodeStatus, nodeStatusLabel),
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
  const harnessAdapter = isObject(value["harness-adapter"]) ? value["harness-adapter"] : null
  if (!harnessAdapter) return null
  const oldWorkspace = isObject(value.workspace) ? value.workspace : {}
  const lifecycle = isObject(value.lifecycle) ? value.lifecycle : {}
  const adapterId = normalizeText(harnessAdapter.id)
  const adapterName = normalizeText(harnessAdapter.name)
  if (!adapterId || !adapterName || harnessAdapter.type !== "plugin") return null
  const now = new Date().toISOString()

  return {
    projectId: value.projectId,
    name: value.name,
    description: normalizeText(value.description),
    projectCode: normalizeText(value.projectCode),
    systemId: normalizeText(value.systemId),
    systemName: normalizeText(value.systemName),
    workspacePath: normalizeText(value.workspacePath) || normalizeText(oldWorkspace.path),
    "harness-adapter": {
      id: adapterId,
      name: adapterName,
      version: normalizeText(harnessAdapter.version),
      type: "plugin"
    },
    lifecycle: {
      status: value.lifecycle && lifecycle.status === "archived" ? "archived" : "active",
      createAt: typeof lifecycle.createAt === "string" ? lifecycle.createAt : now,
      updateAt: typeof lifecycle.updateAt === "string" ? lifecycle.updateAt : undefined
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
  const plugin = findAdapterPlugin(project)
  return {
    projectId: project.projectId,
    name: project.name,
    description: project.description,
    projectCode: project.projectCode,
    systemId: project.systemId,
    systemName: project.systemName,
    workspacePath: project.workspacePath,
    harnessAdapter: {
      id: harnessAdapter.id,
      name: harnessAdapter.name,
      type: harnessAdapter.type
    },
    boardCompatibility: evaluateBoardPluginCompatibility(plugin, harnessAdapter.name || harnessAdapter.id),
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
    input.systemId,
    input.systemName,
    input.workspacePath
  ]
  if (required.some((value) => typeof value !== "string" || value.trim().length === 0)) {
    throw new Error("Project name, code, description, system and workspace are required")
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
    input.systemId,
    input.systemName,
    input.workspacePath
  ]
  if (required.some((value) => typeof value !== "string" || value.trim().length === 0)) {
    throw new Error("Project name, code, description, system and workspace are required")
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

function makeWatchRefs(slug?: string): HarnessWatchRef[] {
  const base = ".autobizdevops"
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
      systemId: project.systemId,
      systemName: project.systemName,
      workspacePath: project.workspacePath,
      projectRootPath: projectDirectoryPath(project)
    },
    adapterSnapshot: {
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

export function readHarnessFeatureMetadata(metadata: unknown): { projectId: string; slug: string } | null {
  if (!isObject(metadata) || !isObject(metadata.harnessFeature)) return null
  const projectId = normalizeText(metadata.harnessFeature.projectId).trim()
  const slug = normalizeText(metadata.harnessFeature.slug).trim()
  return projectId && slug ? { projectId, slug } : null
}

export interface HarnessFeatureAgentContext {
  systemPromptInject?: string
  pluginOutputDir?: string
  systemId?: string
  pluginRoot?: string
  pluginId?: string
  pluginName?: string
  pluginWorkspace?: string
  featureId?: string
  projectCode?: string
}

export function buildHarnessFeatureAgentContext(
  metadata: unknown
): HarnessFeatureAgentContext | null {
  const feature = readHarnessFeatureMetadata(metadata)
  if (!feature) return null

  const project = requireProject(feature.projectId)
  const cwd = adapterPluginDir(project)
  const adapter = project["harness-adapter"]
  const plugin = findAdapterPlugin(project)
  const systemPromptInject = readBoardConfigPlatformText(cwd, "system_prompt_inject")
  const pluginOutputDir = readBoardConfigPlatformText(cwd, "plugin_dir_hook")
  const systemId = normalizeText(project.systemId).trim()
  const render = (
    template: string | null,
    command: HarnessInspectCommandName
  ): string | undefined =>
    template
      ? replaceHarnessConfigPlaceholders(template, project, command, cwd, feature.slug).trim() ||
        undefined
      : undefined

  return {
    systemPromptInject: render(systemPromptInject, "run"),
    pluginOutputDir: render(pluginOutputDir, "run"),
    systemId: systemId || undefined,
    pluginRoot: cwd,
    pluginId: normalizeText(plugin?.id) || adapter.id,
    pluginName: normalizeText(plugin?.name) || adapter.name,
    pluginWorkspace: project.workspacePath,
    featureId: feature.slug,
    projectCode: project.projectCode
  }
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
    systemId: input.systemId.trim(),
    systemName: input.systemName.trim(),
    workspacePath: input.workspacePath.trim(),
    "harness-adapter": harnessAdapter,
    lifecycle: {
      status: "active",
      createAt: new Date().toISOString()
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
  const store = readProjectStore()
  const index = store.projects.findIndex((item) => item.projectId === projectId)
  if (index === -1) {
    throw new Error("Project not found")
  }

  validateProjectCodeUnique(input.projectCode, store, projectId)
  const existing = store.projects[index]
  const existingAdapter = existing["harness-adapter"]
  const harnessAdapter =
    existingAdapter.type === input.adapterType && existingAdapter.id === input.adapterId.trim()
      ? resolveHarnessAdapterSnapshot(existingAdapter)
      : resolveHarnessAdapter(input.adapterId, input.adapterType)
  const existingWorkspacePath = existing.workspacePath.trim()
  const requestedWorkspacePath = input.workspacePath.trim()
  if (requestedWorkspacePath !== existingWorkspacePath) {
    throw new Error("项目工作区路径不允许修改")
  }
  const newCode = input.projectCode.trim()
  const codeChanged = existing.projectCode !== newCode
  if (codeChanged) {
    const oldPath = resolve(existing.workspacePath, existing.projectCode)
    const newPath = resolve(existing.workspacePath, newCode)
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
    systemId: input.systemId.trim(),
    systemName: input.systemName.trim(),
    workspacePath: existing.workspacePath,
    "harness-adapter": harnessAdapter,
    lifecycle: {
      ...existing.lifecycle,
      updateAt: new Date().toISOString()
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
      status: "archived",
      updateAt: new Date().toISOString()
    }
  }

  store.projects[index] = archived
  writeProjectStore(store)
  return archived
}

export function getHarnessProjectDetail(projectId: string): HarnessProjectDetailViewModel {
  return getHarnessProjectDetails([projectId])[projectId]
}

function runInspectAdapterBatch(
  projects: HarnessProjectMetadata[],
  mode: "project",
  cwd: string
): Record<string, unknown> {
  const firstProject = projects[0]
  const configuredCommand = readBoardConfigInspectCommand(cwd, mode)
  if (!configuredCommand) {
    const configKey = HARNESS_INSPECT_COMMAND_CONFIG_KEYS[mode]
    throw new Error(`插件未配置 inspectCommands.${process.platform}.${configKey}，请检查插件设置`)
  }

  const projectCodes = projects.map((p) => p.projectCode)
  const { executable, args } = parseInspectCommand(
    configuredCommand, firstProject, mode, cwd, undefined, projectCodes
  )

  const cmdLine = [executable, ...args].join(" ")
  console.log(`[HarnessBoard] [project_status] Running ${projects.length} project(s): ${cmdLine}`)

  const stdoutBuffer = runHarnessInvocation({
    cwd,
    invocation: {
      executable,
      args
    }
  })

  const raw = decodeAdapterBuffer(stdoutBuffer).trim()
  console.log(`[HarnessBoard] [project_status] Result bytes: ${stdoutBuffer.length}`)
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

function makeProjectErrorDetail(
  project: HarnessProjectMetadata,
  label: string,
  error: string
): HarnessProjectDetailViewModel {
  return makeProjectDetailViewModel(project, {
    workflow: normalizeWorkflow(null),
    runs: [],
    watchRefs: makeWatchRefs(),
    projectState: { label, uiKind: "warning" },
    error
  })
}

function projectAdapterLoadedStatus(project: HarnessProjectMetadata): HarnessStatus {
  const adapterName = normalizeText(project["harness-adapter"].name) || "插件"
  return okStatus("inspected", `${adapterName} 已加载`)
}

export function getHarnessProjectDetails(
  projectIds: string[]
): Record<string, HarnessProjectDetailViewModel> {
  if (projectIds.length === 0) return {}

  const projects = projectIds.map((id) => requireProject(id))
  const result: Record<string, HarnessProjectDetailViewModel> = {}
  const groups = new Map<string, {
    cwd: string
    projects: HarnessProjectMetadata[]
  }>()

  for (const project of projects) {
    const plugin = findAdapterPlugin(project)
    const adapter = project["harness-adapter"]
    const compatibility = evaluateBoardPluginCompatibility(plugin, adapter.name || adapter.id)
    if (!compatibility.compatible) {
      result[project.projectId] = makeProjectErrorDetail(
        project,
        compatibility.label,
        compatibility.message || "项目使用的插件与当前 APP 不兼容。"
      )
      continue
    }
    if (!plugin) continue

    if (!existsSync(projectDirectoryPath(project))) {
      result[project.projectId] = makeProjectErrorDetail(
        project,
        "项目目录不存在",
        projectDirectoryMissingMessage(project)
      )
      continue
    }

    const key = `${plugin.path}\u0000${project.workspacePath}`
    const existing = groups.get(key)
    if (existing) {
      existing.projects.push(project)
    } else {
      groups.set(key, {
        cwd: plugin.path,
        projects: [project]
      })
    }
  }

  for (const group of groups.values()) {
    try {
      const snapshot = runInspectAdapterBatch(group.projects, "project", group.cwd)
      const workflow = normalizeWorkflow(snapshot.workflow)
      if (!isObject(snapshot.projects)) {
        throw new Error("Inspect adapter returned invalid batch JSON: projects is not an object")
      }
      const projectsDict = snapshot.projects as Record<string, unknown>

      for (const project of group.projects) {
        const projectData = projectsDict[project.projectCode]
        if (!isObject(projectData)) {
          result[project.projectId] = makeProjectErrorDetail(
            project,
            "Inspect 读取失败",
            `读取项目状态失败：Inspect adapter 未返回项目 ${project.projectCode} 的状态`
          )
          continue
        }

        const fallbackWatchRefs = makeWatchRefs()
        const runs = normalizeProjectRuns(projectData, workflow)
        result[project.projectId] = makeProjectDetailViewModel(project, {
          workflow,
          runs,
          watchRefs: normalizeWatchRefs(project, projectData.watchRefs, fallbackWatchRefs),
          projectState: projectAdapterLoadedStatus(project),
          error: null
        })
      }
    } catch (error) {
      for (const project of group.projects) {
        result[project.projectId] = makeProjectErrorDetail(
          project,
          "Inspect 读取失败",
          formatProjectDetailError(project, error)
        )
      }
    }
  }

  return result
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
      systemId: project.systemId,
      workspacePath: project.workspacePath,
      projectRootPath: projectDirectoryPath(project)
    },
    adapterSnapshot: {
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
      watchRefs: normalizeWatchRefs(project, run.watchRefs, makeWatchRefs(featureSlug)),
      currentNodeId,
      nodes: nodesWithHookLogs,
      unmatchedHooks
    },
    sessions: []
  }
}
