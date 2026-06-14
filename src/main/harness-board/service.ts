import { execFileSync } from "child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { basename, isAbsolute, join, relative, resolve } from "path"
import * as chardet from "jschardet"
import * as iconv from "iconv-lite"
import { v4 as uuid } from "uuid"
import { getOpenworkDir, getPlugins, getUserInfo } from "../storage"
import type { PluginMetadata } from "../types"
import type {
  HarnessAdapterRegistryItem,
  HarnessAdapterSnapshot,
  HarnessAdapterType,
  HarnessArtifact,
  HarnessArtifactStatus,
  HarnessArtifactType,
  HarnessBoardCompatibility,
  HarnessDynamicWorkflowConfig,
  HarnessDynamicWorkflowNode,
  HarnessDynamicWorkflowTemplate,
  HarnessEventStatus,
  HarnessFeatureCreateInput,
  HarnessFeatureCreateResult,
  HarnessFeatureStatus,
  HarnessNodeStatus,
  HarnessProjectCreateInput,
  HarnessProjectCreatorMetadata,
  HarnessProjectDetailViewModel,
  HarnessProjectListItem,
  HarnessProjectMetadata,
  HarnessProjectMetadataUpdateInput,
  HarnessRunDetailViewModel,
  HarnessRunNode,
  HarnessSkipNodeInput,
  HarnessSkipNodeResult,
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
type HarnessInspectCommandName =
  | "project"
  | "run"
  | "createProject"
  | "createFeature"
  | "dynamicWorkflow"
  | "skipNode"
type HarnessInspectCommandConfigKey =
  | "project_status"
  | "feature_status"
  | "create_project"
  | "create_feature"
  | "dynamic_workflow"
  | "skip_node"
type HarnessPlatformConfigKey =
  | HarnessInspectCommandConfigKey
  | "system_prompt_inject"
  | "plugin_dir_hook"
  | "dialog_tips"

const HARNESS_INSPECT_COMMAND_CONFIG_KEYS: Record<HarnessInspectCommandName, HarnessInspectCommandConfigKey> = {
  project: "project_status",
  run: "feature_status",
  createProject: "create_project",
  createFeature: "create_feature",
  dynamicWorkflow: "dynamic_workflow",
  skipNode: "skip_node"
}

interface ConfiguredHarnessInvocation {
  cwd: string
  invocation: {
    executable: string
    args: string[]
  }
}

type HarnessInvocationSuccessLogMode = "full" | "summary" | "none"

interface HarnessInvocationLogOptions {
  configKey: HarnessInspectCommandConfigKey
  detail?: string
  successResult?: HarnessInvocationSuccessLogMode
}

interface HarnessHookLogEntry {
  nodeId: string
  hook: HarnessRunNode["hooks"][number]
}

interface HarnessCommandParseOptions {
  feature?: string
  projectDirs?: string[]
  workflowTemplate?: string
  workflowNodes?: string
  nodeId?: string
}

const HARNESS_BOARD_FILE = join(getOpenworkDir(), "harness-board-projects.json")

const HARNESS_ADAPTER_TIMEOUT_MS = 15_000
const HARNESS_ADAPTER_MAX_BUFFER = 10 * 1024 * 1024
const CHARDET_CONFIDENCE_THRESHOLD = 0.8
const CHARDET_SAMPLE_BYTES = 8_192
const HARNESS_NAME_PATTERN = /^[\u4e00-\u9fffA-Za-z0-9_-]+$/u
const HARNESS_NAME_RULE_MESSAGE = "仅支持中文、英文字母、数字、-、_，不允许空格"
const CUSTOM_WORKFLOW_TEMPLATE_ID = "custom"

const HARNESS_NODE_STATUSES = new Set<HarnessNodeStatus>([
  "not_started",
  "in_progress",
  "done",
  "blocked",
  "warning",
  "error",
  "skipped",
  "archived",
  "unknown"
])

const HARNESS_FEATURE_STATUSES = new Set<HarnessFeatureStatus>([
  "not_started",
  "in_progress",
  "done",
  "blocked",
  "warning",
  "error",
  "skipped",
  "archived",
  "unknown"
])

const DEFAULT_NODE_STATUS_LABELS: Record<HarnessNodeStatus, string> = {
  not_started: "未开始",
  in_progress: "进行中",
  done: "已完成",
  blocked: "阻断",
  warning: "警告",
  error: "错误",
  skipped: "跳过",
  archived: "已归档",
  unknown: "未知"
}

const DEFAULT_FEATURE_STATUS_LABELS: Record<HarnessFeatureStatus, string> = {
  not_started: "未开始",
  in_progress: "进行中",
  done: "已完成",
  blocked: "阻断",
  warning: "警告",
  error: "错误",
  skipped: "跳过",
  archived: "已归档",
  unknown: "未知"
}

const NODE_STATUS_UI_KIND: Record<HarnessNodeStatus, HarnessStatus["uiKind"]> = {
  not_started: "pending",
  in_progress: "active",
  done: "done",
  blocked: "blocked",
  warning: "warning",
  error: "error",
  skipped: "skipped",
  archived: "archived",
  unknown: "unknown"
}

const FEATURE_STATUS_UI_KIND: Record<HarnessFeatureStatus, HarnessStatus["uiKind"]> = {
  not_started: "pending",
  in_progress: "active",
  done: "done",
  blocked: "blocked",
  warning: "warning",
  error: "error",
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
  const useScenario = normalizeText(plugin.useScenario)
  return {
    id,
    name: normalizeText(plugin.name) || id,
    version: normalizeText(plugin.version),
    type: "plugin",
    description: normalizeText(plugin.description),
    ...(useScenario ? { useScenario } : {}),
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

function formatHarnessCommandToken(value: string): string {
  if (!value) return "\"\""
  return /^[A-Za-z0-9_/:=.,@%+-]+$/.test(value) ? value : (JSON.stringify(value) ?? "\"\"")
}

function formatHarnessCommand(invocation: ConfiguredHarnessInvocation["invocation"]): string {
  return [invocation.executable, ...invocation.args].map(formatHarnessCommandToken).join(" ")
}

function formatHarnessLogOutput(value: unknown): string {
  const output = toTrimmedOutput(value)
  return output || "(empty)"
}

function harnessCommandLogOptions(
  mode: HarnessInspectCommandName,
  detail?: string
): HarnessInvocationLogOptions {
  const configKey = HARNESS_INSPECT_COMMAND_CONFIG_KEYS[mode]
  const successResult: HarnessInvocationSuccessLogMode =
    mode === "createProject" || mode === "createFeature" ? "full" : "summary"
  return {
    configKey,
    ...(detail ? { detail } : {}),
    successResult
  }
}

function logHarnessInvocationStart(
  configured: ConfiguredHarnessInvocation,
  options: HarnessInvocationLogOptions
): void {
  const detail = options.detail ? ` ${options.detail}` : ""
  console.log(`[HarnessBoard] [${options.configKey}] Running${detail}: ${formatHarnessCommand(configured.invocation)}`)
  console.log(`[HarnessBoard] [${options.configKey}] CWD: ${configured.cwd}`)
}

function logHarnessInvocationSuccess(
  stdoutBuffer: Buffer,
  options: HarnessInvocationLogOptions
): void {
  if (options.successResult === "none") return
  if (options.successResult === "full") {
    console.log(`[HarnessBoard] [${options.configKey}] Result:\n${formatHarnessLogOutput(stdoutBuffer)}`)
    return
  }
  console.log(`[HarnessBoard] [${options.configKey}] success`)
}

function logHarnessInvocationFailure(
  configured: ConfiguredHarnessInvocation,
  options: HarnessInvocationLogOptions,
  error: unknown
): void {
  const maybeError = error as { stdout?: unknown; stderr?: unknown }
  console.error(`[HarnessBoard] [${options.configKey}] Failed: ${formatAdapterError(error)}`)
  console.error(`[HarnessBoard] [${options.configKey}] Command: ${formatHarnessCommand(configured.invocation)}`)
  console.error(`[HarnessBoard] [${options.configKey}] CWD: ${configured.cwd}`)
  console.error(`[HarnessBoard] [${options.configKey}] stdout:\n${formatHarnessLogOutput(maybeError.stdout)}`)
  console.error(`[HarnessBoard] [${options.configKey}] stderr:\n${formatHarnessLogOutput(maybeError.stderr)}`)
}

function logHarnessStatusResultFailure(
  configured: ConfiguredHarnessInvocation,
  configKey: HarnessInspectCommandConfigKey,
  stdoutBuffer: Buffer,
  errorMessage: string
): void {
  console.error(`[HarnessBoard] [${configKey}] Failed after command completed: ${errorMessage}`)
  console.error(`[HarnessBoard] [${configKey}] Command: ${formatHarnessCommand(configured.invocation)}`)
  console.error(`[HarnessBoard] [${configKey}] CWD: ${configured.cwd}`)
  console.error(`[HarnessBoard] [${configKey}] Result:\n${formatHarnessLogOutput(stdoutBuffer)}`)
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
  options: HarnessCommandParseOptions = {}
): string {
  const projectDir = projectDirectoryName(project)
  const replacements: Record<string, string> = {
    pluginWorkspace: project.workspacePath,
    project: projectDir,
    projectDir,
    projectCode: project.projectCode,
    feature: options.feature ?? "",
    pluginPath: cwd,
    mode,
    workflowTemplate: options.workflowTemplate ?? "",
    workflowNodes: options.workflowNodes ?? "",
    nodeId: options.nodeId ?? ""
  }
  return value.replace(
    /\$\{(pluginWorkspace|project|projectDir|projectCode|feature|pluginPath|mode|workflowTemplate|workflowNodes|nodeId)\}/g,
    (_, key: string) => replacements[key] ?? ""
  )
}

function parseInspectCommand(
  command: string,
  project: HarnessProjectMetadata,
  mode: HarnessInspectCommandName,
  cwd: string,
  options: HarnessCommandParseOptions = {}
): { executable: string; args: string[] } {
  const args: string[] = []
  const optionalWorkflowArgs: Array<{
    key: keyof Pick<HarnessCommandParseOptions, "workflowTemplate" | "workflowNodes">
    placeholder: string
    flag: string
  }> = [
    { key: "workflowTemplate", placeholder: "${workflowTemplate}", flag: "--workflow-template" },
    { key: "workflowNodes", placeholder: "${workflowNodes}", flag: "--workflow-nodes" }
  ]
  const tokens = tokenizeInspectCommand(command.trim())
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if ((token === "${projectCodes...}" || token === "${projectDirs...}") && options.projectDirs) {
      args.push(...options.projectDirs)
      continue
    }
    const optionalArg = optionalWorkflowArgs.find((item) => !options[item.key] && (
      token === item.placeholder ||
      token === `${item.flag}=${item.placeholder}` ||
      (token === item.flag && tokens[index + 1] === item.placeholder)
    ))
    if (optionalArg) {
      if (token === optionalArg.flag) index += 1
      continue
    }
    args.push(replaceHarnessConfigPlaceholders(token, project, mode, cwd, options))
  }
  const [executable, ...restArgs] = args
  if (!executable) {
    throw new Error("Inspect adapter command is empty")
  }
  return { executable, args: restArgs }
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

function projectDirectoryName(project: Pick<HarnessProjectMetadata, "projectDir" | "projectCode">): string {
  return normalizeText(project.projectDir).trim() || normalizeText(project.projectCode).trim()
}

function projectDirectoryPath(project: HarnessProjectMetadata): string {
  const workspacePath = resolve(project.workspacePath)
  const projectDir = projectDirectoryName(project)
  const projectPath = resolve(workspacePath, projectDir)
  if (
    projectPath === workspacePath ||
    basename(projectPath) !== projectDir ||
    !isInsideDirectory(workspacePath, projectPath)
  ) {
    throw new Error(`Project dir resolves outside workspace: ${projectDir}`)
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
  return `请确认项目「${project.projectCode}」的工作区「${project.workspacePath}」下存在项目文件夹「${projectDirectoryName(project)}」。`
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
  options: HarnessCommandParseOptions = {}
): ConfiguredHarnessInvocation | null {
  const cwd = adapterPluginDir(project)
  const configuredCommand = readBoardConfigInspectCommand(cwd, mode)
  if (!configuredCommand) return null

  return {
    cwd,
    invocation: parseInspectCommand(configuredCommand, project, mode, cwd, options)
  }
}

function buildConfiguredHarnessInvocation(
  project: HarnessProjectMetadata,
  mode: HarnessInspectCommandName,
  options: HarnessCommandParseOptions = {}
): ConfiguredHarnessInvocation {
  const configured = buildOptionalConfiguredHarnessInvocation(project, mode, options)
  if (!configured) {
    const configKey = HARNESS_INSPECT_COMMAND_CONFIG_KEYS[mode]
    throw new Error(`插件未配置 inspectCommands.${process.platform}.${configKey}，请检查插件设置`)
  }
  return configured
}

function hasConfiguredHarnessInvocation(project: HarnessProjectMetadata, mode: HarnessInspectCommandName): boolean {
  return readBoardConfigInspectCommand(adapterPluginDir(project), mode) !== null
}

function runHarnessInvocation(
  configured: ConfiguredHarnessInvocation,
  logOptions?: HarnessInvocationLogOptions
): Buffer {
  const { cwd, invocation } = configured
  if (logOptions) logHarnessInvocationStart(configured, logOptions)
  try {
    const stdoutBuffer = execFileSync(invocation.executable, invocation.args, {
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
    if (logOptions) logHarnessInvocationSuccess(stdoutBuffer, logOptions)
    return stdoutBuffer
  } catch (error) {
    if (logOptions) logHarnessInvocationFailure(configured, logOptions, error)
    throw new Error(formatAdapterError(error))
  }
}

function runInspectAdapter(
  project: HarnessProjectMetadata,
  mode: "project" | "run",
  feature?: string
): Record<string, unknown> {
  const invocation = buildConfiguredHarnessInvocation(project, mode, { feature })
  const configKey = HARNESS_INSPECT_COMMAND_CONFIG_KEYS[mode]
  const stdoutBuffer = runHarnessInvocation(invocation, harnessCommandLogOptions(mode))

  const raw = decodeAdapterBuffer(stdoutBuffer).trim()

  if (!raw) {
    logHarnessStatusResultFailure(invocation, configKey, stdoutBuffer, "Inspect adapter returned empty output")
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
    logHarnessStatusResultFailure(
      invocation,
      configKey,
      stdoutBuffer,
      `Inspect adapter returned invalid JSON: ${message}`
    )
    throw new Error(`Inspect adapter returned invalid JSON: ${message}`)
  }
}

function runHarnessJsonInvocation(
  configured: ConfiguredHarnessInvocation,
  mode: HarnessInspectCommandName
): Record<string, unknown> {
  const configKey = HARNESS_INSPECT_COMMAND_CONFIG_KEYS[mode]
  const stdoutBuffer = runHarnessInvocation(configured, harnessCommandLogOptions(mode))
  const raw = decodeAdapterBuffer(stdoutBuffer).trim()

  if (!raw) {
    logHarnessStatusResultFailure(configured, configKey, stdoutBuffer, "Inspect adapter returned empty output")
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
    logHarnessStatusResultFailure(
      configured,
      configKey,
      stdoutBuffer,
      `Inspect adapter returned invalid JSON: ${message}`
    )
    throw new Error(`Inspect adapter returned invalid JSON: ${message}`)
  }
}

function assertSkipNodeInvocationResult(
  configured: ConfiguredHarnessInvocation,
  stdoutBuffer: Buffer
): void {
  const raw = decodeAdapterBuffer(stdoutBuffer).trim()
  if (!raw) return

  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return
  }

  if (!isObject(parsed) || parsed.ok !== false) return

  const message = normalizeText(parsed.message).trim() || "插件返回跳过节点失败"
  logHarnessStatusResultFailure(configured, "skip_node", stdoutBuffer, message)
  throw new Error(message)
}

function uniqueStringsInOrder(values: unknown): string[] {
  if (!Array.isArray(values)) return []
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const normalized = normalizeText(value).trim()
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    result.push(normalized)
  }
  return result
}

function normalizeDynamicWorkflowTemplate(value: unknown): HarnessDynamicWorkflowTemplate | null {
  if (!isObject(value)) return null
  const id = normalizeText(value.id).trim()
  if (!id) return null
  const templateType = normalizeText(value.templateType).trim()
  const label = normalizeText(value.label).trim() || id
  const description = normalizeText(value.description).trim()
  return {
    id,
    templateType,
    label,
    description,
    nodes: uniqueStringsInOrder(value.nodes),
    requiredNodes: uniqueStringsInOrder(value.requiredNodes)
  }
}

function normalizeDynamicWorkflowNode(value: unknown): HarnessDynamicWorkflowNode | null {
  if (!isObject(value)) return null
  const id = normalizeText(value.id).trim()
  if (!id) return null
  const group = normalizeText(value.group).trim()
  return {
    id,
    label: normalizeText(value.label).trim() || id,
    ...(group ? { group } : {}),
    description: normalizeText(value.description).trim()
  }
}

function normalizeDynamicWorkflowTemplateList(value: unknown): HarnessDynamicWorkflowTemplate[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const templates: HarnessDynamicWorkflowTemplate[] = []
  for (const item of value) {
    const template = normalizeDynamicWorkflowTemplate(item)
    if (!template || seen.has(template.id)) continue
    seen.add(template.id)
    templates.push(template)
  }
  return templates
}

function normalizeDynamicWorkflowNodeList(value: unknown): HarnessDynamicWorkflowNode[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const nodes: HarnessDynamicWorkflowNode[] = []
  for (const item of value) {
    const node = normalizeDynamicWorkflowNode(item)
    if (!node || seen.has(node.id)) continue
    seen.add(node.id)
    nodes.push(node)
  }
  return nodes
}

function normalizeDynamicWorkflowConfigSnapshot(value: unknown): HarnessDynamicWorkflowConfig | null {
  if (!isObject(value)) return null
  const templates = normalizeDynamicWorkflowTemplateList(value.templates)
  const nodes = normalizeDynamicWorkflowNodeList(value.nodes)
  return templates.length > 0 ? { templates, nodes } : null
}

function getHarnessDynamicWorkflowConfigForProject(
  project: HarnessProjectMetadata
): HarnessDynamicWorkflowConfig | null {
  try {
    const invocation = buildOptionalConfiguredHarnessInvocation(project, "dynamicWorkflow")
    if (!invocation) return null

    const response = runHarnessJsonInvocation(invocation, "dynamicWorkflow")
    if (response.ok !== true) return null
    return normalizeDynamicWorkflowConfigSnapshot(response)
  } catch (error) {
    console.warn("[HarnessBoard] Dynamic workflow config unavailable:", formatAdapterError(error))
    return null
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

function normalizeFeatureStatus(value: unknown): HarnessFeatureStatus | null {
  const featureStatus = normalizeText(value)
  return HARNESS_FEATURE_STATUSES.has(featureStatus as HarnessFeatureStatus)
    ? (featureStatus as HarnessFeatureStatus)
    : null
}

function statusFromNodeStatus(nodeStatus: HarnessNodeStatus, label?: string): HarnessStatus {
  return {
    label: label?.trim() || DEFAULT_NODE_STATUS_LABELS[nodeStatus],
    uiKind: NODE_STATUS_UI_KIND[nodeStatus]
  }
}

function statusFromFeatureStatus(featureStatus: HarnessFeatureStatus, label?: string): HarnessStatus {
  return {
    label: label?.trim() || DEFAULT_FEATURE_STATUS_LABELS[featureStatus],
    uiKind: FEATURE_STATUS_UI_KIND[featureStatus]
  }
}

function deriveFeatureStatusFromCurrentNode(
  currentNodeStatus: HarnessNodeStatus,
  currentNodeIndex: number,
  workflowNodeCount: number
): HarnessFeatureStatus {
  if (currentNodeStatus !== "done") return currentNodeStatus
  if (currentNodeIndex >= 0 && currentNodeIndex < workflowNodeCount - 1) return "in_progress"
  return "done"
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

function workflowFromNodeIds(workflow: HarnessWorkflow, nodeIds: string[]): HarnessWorkflow {
  if (nodeIds.length === 0) return workflow
  const nodesById = new Map(workflow.nodes.map((node) => [node.id, node]))
  const nodes = nodeIds
    .map((nodeId) => nodesById.get(nodeId))
    .filter((node): node is HarnessWorkflow["nodes"][number] => Boolean(node))
  return { ...workflow, nodes }
}

function normalizeProjectRun(
  value: unknown,
  defaultWorkflow: HarnessWorkflow
): HarnessFeatureSummary | null {
  if (!isObject(value)) return null
  const slug = normalizeText(value.featureId) || normalizeText(value.featureName)
  if (!slug) return null

  const nodeIds = uniqueStringsInOrder(value.nodeIds)
  const workflow = workflowFromNodeIds(defaultWorkflow, nodeIds)
  const currentNodeId = normalizeText(value.currentNodeId) || "unknown"
  const currentNodeStatus = normalizeNodeStatus(value.currentNodeStatus)
  const currentNodeStatusLabel = normalizeText(value.currentNodeStatusLabel).trim()
  const currentNodeIndex = workflow.nodes.findIndex((node) => node.id === currentNodeId)
  const currentNodeDefinition = currentNodeIndex >= 0 ? workflow.nodes[currentNodeIndex] : undefined
  const explicitFeatureStatus = normalizeFeatureStatus(value.featureStatus)
  const featureStatus = explicitFeatureStatus ?? deriveFeatureStatusFromCurrentNode(
    currentNodeStatus,
    currentNodeIndex,
    workflow.nodes.length
  )
  const featureStatusLabel = explicitFeatureStatus ? normalizeText(value.featureStatusLabel).trim() : ""
  const status = statusFromFeatureStatus(featureStatus, featureStatusLabel)
  const currentNodeLabel = currentNodeDefinition?.label ?? currentNodeId
  const summaryText = currentNodeLabel ? `${currentNodeLabel} · ${status.label}` : status.label

  return {
    id: slug,
    kind: "feature",
    slug,
    title: normalizeText(value.featureName) || slug,
    location: status.uiKind === "archived" ? "archived" : "active",
    featureStatus,
    ...(featureStatusLabel ? { featureStatusLabel } : {}),
    overallStatus: status,
    nodeIds,
    currentNodeId,
    currentNodeStatus,
    ...(currentNodeStatusLabel ? { currentNodeStatusLabel } : {}),
    summary: {
      text: summaryText,
      updatedAt: ""
    }
  }
}

function normalizeProjectRuns(
  snapshot: Record<string, unknown>,
  workflow: HarnessWorkflow
): HarnessFeatureSummary[] {
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
  const creator = normalizeProjectCreator(value.creator)
  const adapterId = normalizeText(harnessAdapter.id)
  const adapterName = normalizeText(harnessAdapter.name)
  const projectCode = normalizeText(value.projectCode)
  const projectDir = normalizeText(value.projectDir) || projectCode
  if (!adapterId || !adapterName || harnessAdapter.type !== "plugin") return null
  const now = new Date().toISOString()

  return {
    projectId: value.projectId,
    name: value.name,
    description: normalizeText(value.description),
    projectCode,
    projectDir,
    systemId: normalizeText(value.systemId),
    systemName: normalizeText(value.systemName),
    workspacePath: normalizeText(value.workspacePath) || normalizeText(oldWorkspace.path),
    "harness-adapter": {
      id: adapterId,
      name: adapterName,
      version: normalizeText(harnessAdapter.version),
      type: "plugin"
    },
    ...(creator ? { creator } : {}),
    lifecycle: {
      status: value.lifecycle && lifecycle.status === "archived" ? "archived" : "active",
      createAt: typeof lifecycle.createAt === "string" ? lifecycle.createAt : now,
      updateAt: typeof lifecycle.updateAt === "string" ? lifecycle.updateAt : undefined
    }
  }
}

function deriveCreatorOrgLevels(
  pathName?: string
): Pick<HarnessProjectCreatorMetadata, "upperOrgLv0" | "upperOrgLv1"> {
  const parts =
    typeof pathName === "string"
      ? pathName
          .split("/")
          .map((part) => part.trim())
          .filter(Boolean)
      : []
  const itDeptIndex = parts.findIndex((part) => part.includes("信息技术部"))
  if (itDeptIndex < 0) return {}

  const lowerParts = parts.slice(itDeptIndex + 1)
  const startsWithTeam = lowerParts[0]?.includes("团队") ?? false
  return startsWithTeam
    ? { upperOrgLv0: lowerParts[2] ?? "", upperOrgLv1: lowerParts[1] ?? "" }
    : { upperOrgLv0: lowerParts[3] ?? "", upperOrgLv1: lowerParts[2] ?? "" }
}

function normalizeProjectCreator(value: unknown): HarnessProjectCreatorMetadata | null {
  if (!isObject(value)) return null
  const creator: HarnessProjectCreatorMetadata = {
    sapId: normalizeText(value.sapId),
    ystId: normalizeText(value.ystId),
    userName: normalizeText(value.userName),
    orgName: normalizeText(value.orgName),
    pathName: normalizeText(value.pathName),
    upperOrgLv0: normalizeText(value.upperOrgLv0),
    upperOrgLv1: normalizeText(value.upperOrgLv1)
  }
  return Object.values(creator).some((item) => item.trim()) ? creator : null
}

function getCurrentProjectCreator(): HarnessProjectCreatorMetadata | undefined {
  const userInfo = getUserInfo()
  const creator = normalizeProjectCreator({
    sapId: userInfo?.sapId,
    ystId: userInfo?.ystId,
    userName: userInfo?.userName,
    orgName: userInfo?.orgName,
    pathName: userInfo?.pathName,
    ...deriveCreatorOrgLevels(userInfo?.pathName)
  })
  return creator ?? undefined
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
    projectDir: projectDirectoryName(project),
    systemId: project.systemId,
    systemName: project.systemName,
    workspacePath: project.workspacePath,
    harnessAdapter: {
      id: harnessAdapter.id,
      name: harnessAdapter.name,
      type: harnessAdapter.type
    },
    creator: project.creator,
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
    input.projectDir,
    input.description,
    input.systemId,
    input.systemName,
    input.workspacePath
  ]
  if (required.some((value) => typeof value !== "string" || value.trim().length === 0)) {
    throw new Error("Project name, code, description, system and workspace are required")
  }
  validateHarnessName(input.projectCode, "项目编号")
  validateHarnessName(input.projectDir, "项目文件夹")
}

function validateProjectMetadataInput(input: HarnessProjectMetadataUpdateInput): void {
  const required = [
    input.adapterId,
    input.adapterType,
    input.name,
    input.projectCode,
    input.projectDir,
    input.description,
    input.systemId,
    input.systemName,
    input.workspacePath
  ]
  if (required.some((value) => typeof value !== "string" || value.trim().length === 0)) {
    throw new Error("Project name, code, description, system and workspace are required")
  }
  validateHarnessName(input.projectCode, "项目编号")
  validateHarnessName(input.projectDir, "项目文件夹")
}

function validateHarnessName(value: unknown, label: string): void {
  if (!HARNESS_NAME_PATTERN.test(normalizeText(value))) {
    throw new Error(`${label}${HARNESS_NAME_RULE_MESSAGE}`)
  }
}

function validateProjectCodeUnique(code: string, store: HarnessProjectStoreFile, excludeProjectId?: string): void {
  const trimmed = code.trim()
  const duplicate = store.projects.find(
    (item) =>
      item.lifecycle.status !== "archived" &&
      item.projectCode === trimmed &&
      item.projectId !== excludeProjectId
  )
  if (duplicate) {
    throw new Error(`已有项目使用项目编号：${trimmed} ，请更换`)
  }
}

function validateProjectDirUnique(
  projectDir: string,
  workspacePath: string,
  store: HarnessProjectStoreFile,
  excludeProjectId?: string
): void {
  const trimmedProjectDir = projectDir.trim()
  const resolvedWorkspacePath = resolve(workspacePath)
  const duplicate = store.projects.find(
    (item) =>
      resolve(item.workspacePath) === resolvedWorkspacePath &&
      projectDirectoryName(item) === trimmedProjectDir &&
      item.projectId !== excludeProjectId
  )
  if (duplicate) {
    throw new Error(`项目根路径下已有文件夹：${trimmedProjectDir}`)
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

function normalizeFeatureWorkflowTemplate(value: unknown): string {
  const workflowTemplate = normalizeText(value).trim()
  if (workflowTemplate.includes("\0")) {
    throw new Error("Workflow template contains invalid characters")
  }
  return workflowTemplate
}

function normalizeFeatureWorkflowNodeIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const nodes: string[] = []
  for (const item of value) {
    const nodeId = normalizeText(item).trim()
    if (!nodeId) continue
    if (nodeId.includes("\0")) {
      throw new Error("Workflow node contains invalid characters")
    }
    if (seen.has(nodeId)) continue
    seen.add(nodeId)
    nodes.push(nodeId)
  }
  return nodes
}

function validateSkipNodeInput(input: HarnessSkipNodeInput): { projectId: string; slug: string; nodeId: string } {
  const projectId = normalizeText(input.projectId).trim()
  const slug = normalizeText(input.slug).trim()
  const nodeId = normalizeText(input.nodeId).trim()
  if (!projectId || !slug || !nodeId) {
    throw new Error("Project, feature and node are required")
  }
  if (slug.includes("\0") || nodeId.includes("\0")) {
    throw new Error("Skip node input contains invalid characters")
  }
  return { projectId, slug, nodeId }
}

function buildFeatureWorkflowCommandOptions(
  input: HarnessFeatureCreateInput
): Pick<HarnessCommandParseOptions, "workflowTemplate" | "workflowNodes"> {
  const workflowTemplate = normalizeFeatureWorkflowTemplate(input.workflowTemplate)
  if (!workflowTemplate) return {}

  const config = normalizeDynamicWorkflowConfigSnapshot(input.workflowConfig)
  if (!config) {
    throw new Error("动态工作流配置已失效，请重新打开创建特性弹窗")
  }

  const customTemplate = config.templates.find((template) => template.id === workflowTemplate)
  if (!customTemplate) {
    throw new Error("所选工作流模板不存在，请重新选择")
  }

  if (customTemplate.templateType !== CUSTOM_WORKFLOW_TEMPLATE_ID) {
    return { workflowTemplate }
  }

  const selectedNodeIds = new Set(normalizeFeatureWorkflowNodeIds(input.workflowNodes))
  const requiredNodeIds = customTemplate.requiredNodes
  const missingRequiredNode = requiredNodeIds.find((nodeId) => !selectedNodeIds.has(nodeId))
  if (missingRequiredNode) {
    throw new Error(`自定义流程缺少必选节点：${missingRequiredNode}`)
  }

  const orderedNodeIds = config.nodes
    .filter((node) => selectedNodeIds.has(node.id))
    .map((node) => node.id)
  if (orderedNodeIds.length !== selectedNodeIds.size) {
    throw new Error("自定义流程包含未知节点")
  }

  return {
    workflowTemplate,
    workflowNodes: JSON.stringify(orderedNodeIds)
  }
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
      projectDir: projectDirectoryName(project),
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
    runHarnessInvocation(configured, harnessCommandLogOptions("createProject"))
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error)
    if (raw.includes("已存在")) {
      throw new Error("该项目文件夹已在所选工作区存在")
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
      ? replaceHarnessConfigPlaceholders(template, project, command, cwd, { feature: feature.slug }).trim() ||
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

  return replaceHarnessConfigPlaceholders(template, project, "run", cwd, { feature }).trim() || null
}

export function listHarnessProjects(): HarnessProjectListItem[] {
  return readProjectStore().projects.map(toListItem)
}

/**
 * Returns the harness adapter (plugin) bound to a project, including its version.
 * Prefers the currently-installed plugin's version; falls back to the version
 * stored in project metadata when the plugin can't be resolved (e.g. uninstalled).
 * Returns null when the project does not exist.
 */
export function getHarnessProjectAdapterSnapshot(projectId: string): HarnessAdapterSnapshot | null {
  const project = readProjectStore().projects.find((item) => item.projectId === projectId)
  if (!project) return null
  const stored = project["harness-adapter"]
  try {
    const plugin = findPluginForAdapterSnapshot(stored)
    if (plugin) return pluginToHarnessAdapterSnapshot(plugin)
  } catch {
    // fall through to the stored metadata snapshot below
  }
  return {
    id: normalizeText(stored.id),
    name: normalizeText(stored.name),
    version: normalizeText(stored.version),
    type: stored.type
  }
}

export function createHarnessProject(input: HarnessProjectCreateInput): HarnessProjectMetadata {
  validateCreateInput(input)
  const store = readProjectStore()
  validateProjectCodeUnique(input.projectCode, store)
  validateProjectDirUnique(input.projectDir, input.workspacePath, store)
  const harnessAdapter = resolveHarnessAdapter(input.adapterId, input.adapterType)
  const project: HarnessProjectMetadata = {
    projectId: uuid(),
    name: input.name.trim(),
    description: input.description.trim(),
    projectCode: input.projectCode.trim(),
    projectDir: input.projectDir.trim(),
    systemId: input.systemId.trim(),
    systemName: input.systemName.trim(),
    workspacePath: input.workspacePath.trim(),
    "harness-adapter": harnessAdapter,
    creator: getCurrentProjectCreator(),
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
  const workflowOptions = buildFeatureWorkflowCommandOptions(input)

  if (!existsSync(workspacePath)) {
    throw new Error(projectDirectoryMissingMessage(project))
  }

  try {
    const configured = buildConfiguredHarnessInvocation(project, "createFeature", {
      feature,
      ...workflowOptions
    })
    runHarnessInvocation(configured, harnessCommandLogOptions("createFeature"))
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

export function skipHarnessRunNode(input: HarnessSkipNodeInput): HarnessSkipNodeResult {
  const { projectId, slug, nodeId } = validateSkipNodeInput(input)
  const project = requireProject(projectId)
  const workspacePath = projectDirectoryPath(project)

  if (!existsSync(workspacePath)) {
    throw new Error(projectDirectoryMissingMessage(project))
  }

  try {
    const configured = buildConfiguredHarnessInvocation(project, "skipNode", {
      feature: slug,
      nodeId
    })
    const logOptions = { ...harnessCommandLogOptions("skipNode"), successResult: "none" as const }
    const stdoutBuffer = runHarnessInvocation(configured, logOptions)
    assertSkipNodeInvocationResult(configured, stdoutBuffer)
    logHarnessInvocationSuccess(stdoutBuffer, harnessCommandLogOptions("skipNode"))
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error)
    throw new Error(`跳过节点失败：${raw}`)
  }

  return {
    projectId,
    slug,
    nodeId
  }
}

export function getHarnessDynamicWorkflowConfig(
  projectId: string
): HarnessDynamicWorkflowConfig | null {
  const project = requireProject(projectId)
  return getHarnessDynamicWorkflowConfigForProject(project)
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
  const existingProjectDir = projectDirectoryName(existing)
  const requestedProjectDir = input.projectDir.trim()
  if (requestedProjectDir !== existingProjectDir) {
    throw new Error("项目文件夹不允许修改")
  }
  const updated: HarnessProjectMetadata = {
    ...existing,
    name: input.name.trim(),
    description: input.description.trim(),
    projectCode: input.projectCode.trim(),
    projectDir: existingProjectDir,
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

export function deleteHarnessProject(projectId: string): HarnessProjectMetadata {
  const store = readProjectStore()
  const index = store.projects.findIndex((item) => item.projectId === projectId)
  if (index === -1) {
    throw new Error("Project not found")
  }

  const [deleted] = store.projects.splice(index, 1)
  writeProjectStore(store)
  return deleted
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

  const projectDirs = projects.map((project) => projectDirectoryName(project))
  const { executable, args } = parseInspectCommand(
    configuredCommand, firstProject, mode, cwd, { projectDirs }
  )

  const configured: ConfiguredHarnessInvocation = {
    cwd,
    invocation: {
      executable,
      args
    }
  }
  const configKey = HARNESS_INSPECT_COMMAND_CONFIG_KEYS[mode]
  const stdoutBuffer = runHarnessInvocation(
    configured,
    harnessCommandLogOptions(mode, `${projects.length} project(s)`)
  )

  const raw = decodeAdapterBuffer(stdoutBuffer).trim()
  if (!raw) {
    logHarnessStatusResultFailure(configured, configKey, stdoutBuffer, "Inspect adapter returned empty output")
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
    logHarnessStatusResultFailure(
      configured,
      configKey,
      stdoutBuffer,
      `Inspect adapter returned invalid JSON: ${message}`
    )
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

function makeArchivedProjectDetail(project: HarnessProjectMetadata): HarnessProjectDetailViewModel {
  return makeProjectDetailViewModel(project, {
    workflow: normalizeWorkflow(null),
    runs: [],
    watchRefs: [],
    projectState: { label: "已归档", uiKind: "archived" },
    error: null
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
    if (project.lifecycle.status === "archived") {
      result[project.projectId] = makeArchivedProjectDetail(project)
      continue
    }

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
        const projectDir = projectDirectoryName(project)
        const projectData = projectsDict[projectDir]
        if (!isObject(projectData)) {
          result[project.projectId] = makeProjectErrorDetail(
            project,
            "Inspect 读取失败",
            `读取项目状态失败：Inspect adapter 未返回项目文件夹 ${projectDir} 的状态`
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
  const currentNodeIndex = workflow.nodes.findIndex((node) => node.id === currentNodeId)
  const currentNodeStatus = nodes.find((node) => node.id === currentNodeId)?.nodeStatus ?? UNKNOWN_NODE_STATUS
  const explicitFeatureStatus = normalizeFeatureStatus(run.featureStatus)
  const featureStatus = explicitFeatureStatus ?? deriveFeatureStatusFromCurrentNode(
    currentNodeStatus,
    currentNodeIndex,
    workflow.nodes.length
  )
  const featureStatusLabel = explicitFeatureStatus ? normalizeText(run.featureStatusLabel).trim() : ""
  const overallStatus = statusFromFeatureStatus(featureStatus, featureStatusLabel)
  const hookLogRefs = normalizeHookLogRefs(project, run.hookLogRefs)
  const hookLogEntries = readHookLogRefs(project, hookLogRefs)
  const { nodes: nodesWithHookLogs, unmatchedHooks } = applyHookLogEntries(nodes, hookLogEntries)
  const skipNodeAvailable = hasConfiguredHarnessInvocation(project, "skipNode")
  return {
    project: {
      projectId: project.projectId,
      name: project.name,
      projectCode: project.projectCode,
      projectDir: projectDirectoryName(project),
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
      featureStatus,
      ...(featureStatusLabel ? { featureStatusLabel } : {}),
      overallStatus,
      skipNodeAvailable,
      hookLogRefs,
      watchRefs: normalizeWatchRefs(project, run.watchRefs, makeWatchRefs(featureSlug)),
      currentNodeId,
      nodes: nodesWithHookLogs,
      unmatchedHooks
    },
    sessions: []
  }
}
