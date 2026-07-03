import { execFileSync } from "child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "fs"
import type { Dirent } from "fs"
import { basename, isAbsolute, join, relative, resolve } from "path"
import * as chardet from "jschardet"
import * as iconv from "iconv-lite"
import { v4 as uuid } from "uuid"
import { getOpenworkDir, getPlugins, getUserInfo } from "../storage"
import { deriveUpperOrgLevelsFromPath } from "../org-levels"
import type { PluginMetadata } from "../types"
import { normalizeHarnessAgentmdLoadStatus } from "../../shared/harness-board-types"
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
  HarnessFeatureDeployUnitBinding,
  HarnessFeatureStatus,
  HarnessAgentmdLoadStatusItem,
  HarnessNodeStatus,
  HarnessProjectCreateInput,
  HarnessProjectConstraintSyncResult,
  HarnessProjectCreatorMetadata,
  HarnessProjectDetailViewModel,
  HarnessProjectListItem,
  HarnessProjectMetadata,
  HarnessProjectMetadataUpdateInput,
  HarnessRunDetailViewModel,
  HarnessRunNode,
  HarnessSessionContextInjectionSource,
  HarnessDeployUnitMapping,
  HarnessSkipNodeInput,
  HarnessSkipNodeResult,
  HarnessFeatureSummary,
  HarnessKnowledgePreviewResult,
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

interface HarnessDeployUnitMappingStoreFile {
  version: 1
  mappings: HarnessDeployUnitMapping[]
}

interface HarnessFeatureDeployUnitBindingRecord extends HarnessFeatureDeployUnitBinding {
  createdAt: string
  updatedAt?: string
}

interface HarnessFeatureDeployUnitBindingStoreFile {
  version: 1
  bindings: HarnessFeatureDeployUnitBindingRecord[]
}

type HarnessHookLogRef = HarnessRunDetailViewModel["run"]["hookLogRefs"][number]
type HarnessInspectCommandName =
  | "project"
  | "run"
  | "createProject"
  | "createFeature"
  | "dynamicWorkflow"
  | "skipNode"
  | "sessionContext"
  | "pullKnowledge"
type HarnessInspectCommandConfigKey =
  | "project_status"
  | "feature_status"
  | "create_project"
  | "create_feature"
  | "dynamic_workflow"
  | "skip_node"
  | "session_context_inject"
  | "pull_knowledge"
type HarnessPlatformConfigKey =
  | HarnessInspectCommandConfigKey
  | "system_prompt_inject"
  | "plugin_dir_hook"
  | "dialog_tips"
  | "knowledge_path"

const HARNESS_INSPECT_COMMAND_CONFIG_KEYS: Record<
  HarnessInspectCommandName,
  HarnessInspectCommandConfigKey
> = {
  project: "project_status",
  run: "feature_status",
  createProject: "create_project",
  createFeature: "create_feature",
  dynamicWorkflow: "dynamic_workflow",
  skipNode: "skip_node",
  sessionContext: "session_context_inject",
  pullKnowledge: "pull_knowledge"
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
  selectedDeployUnitsJson?: string
  sessionWorkspacePath?: string
  projectDirs?: string[]
  workflowTemplate?: string
  workflowNodes?: string
  nodeId?: string
}

const HARNESS_BOARD_FILE = join(getOpenworkDir(), "harness-board-projects.json")
const HARNESS_DEPLOY_UNIT_MAPPING_FILE = join(getOpenworkDir(), "harness-deployUnitId-mapping.json")
const HARNESS_FEATURE_DEPLOY_UNIT_BINDING_FILE = join(getOpenworkDir(), "harness-board-features.json")

const HARNESS_ADAPTER_TIMEOUT_MS = 15_000
const HARNESS_ADAPTER_MAX_BUFFER = 10 * 1024 * 1024
const HARNESS_SESSION_CONTEXT_MAX_CHARS = 60_000
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

const HARNESS_SESSION_CONTEXT_INJECTION_SOURCES = new Set<HarnessSessionContextInjectionSource>([
  "cmbdevclaw",
  "plugin"
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

function emptyDeployUnitMappingStore(): HarnessDeployUnitMappingStoreFile {
  return {
    version: 1,
    mappings: []
  }
}

function emptyFeatureDeployUnitBindingStore(): HarnessFeatureDeployUnitBindingStoreFile {
  return {
    version: 1,
    bindings: []
  }
}

function formatGmt8Timestamp(date = new Date()): string {
  const gmt8Date = new Date(date.getTime() + 8 * 60 * 60 * 1000)
  const pad = (value: number): string => String(value).padStart(2, "0")
  return [
    gmt8Date.getUTCFullYear(),
    pad(gmt8Date.getUTCMonth() + 1),
    pad(gmt8Date.getUTCDate())
  ].join("-") + " " + [
    pad(gmt8Date.getUTCHours()),
    pad(gmt8Date.getUTCMinutes()),
    pad(gmt8Date.getUTCSeconds())
  ].join(":")
}

function isGmt8Timestamp(value: string | undefined): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
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

function hasPullKnowledgeCommand(plugin: PluginMetadata): boolean {
  try {
    return readBoardConfigInspectCommand(plugin.path, "pullKnowledge") !== null
  } catch {
    return false
  }
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
    pullKnowledgeAvailable: hasPullKnowledgeCommand(plugin),
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

function resolveHarnessAdapter(
  adapterId: string,
  adapterType: HarnessAdapterType
): HarnessAdapterSnapshot {
  if (adapterType !== "plugin") {
    throw new Error(`Unsupported harness adapter type: ${adapterType}`)
  }
  const plugin = getPlugins().find(
    (item) => pluginHasBoardConfig(item) && pluginMatchesAdapterId(item, adapterId)
  )
  if (!plugin) {
    throw new Error(
      "Selected plugin is not installed or does not provide board_core/board_config.json"
    )
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
    throw new Error(
      "Selected plugin is not installed or does not provide board_core/board_config.json"
    )
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
    throw new Error(
      compatibility.message ||
        `Harness adapter plugin not compatible: ${adapter.name || adapter.id}`
    )
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
  if (!value) return '""'
  return /^[A-Za-z0-9_/:=.,@%+-]+$/.test(value) ? value : (JSON.stringify(value) ?? '""')
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
    mode === "createProject" || mode === "createFeature" || mode === "sessionContext"
      ? "full"
      : "summary"
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
  console.log(
    `[HarnessBoard] [${options.configKey}] Running${detail}: ${formatHarnessCommand(configured.invocation)}`
  )
  console.log(`[HarnessBoard] [${options.configKey}] CWD: ${configured.cwd}`)
}

function logHarnessInvocationSuccess(
  stdoutBuffer: Buffer,
  options: HarnessInvocationLogOptions
): void {
  if (options.successResult === "none") return
  if (options.successResult === "full") {
    console.log(
      `[HarnessBoard] [${options.configKey}] Result:\n${formatHarnessLogOutput(stdoutBuffer)}`
    )
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
  console.error(
    `[HarnessBoard] [${options.configKey}] Command: ${formatHarnessCommand(configured.invocation)}`
  )
  console.error(`[HarnessBoard] [${options.configKey}] CWD: ${configured.cwd}`)
  console.error(
    `[HarnessBoard] [${options.configKey}] stdout:\n${formatHarnessLogOutput(maybeError.stdout)}`
  )
  console.error(
    `[HarnessBoard] [${options.configKey}] stderr:\n${formatHarnessLogOutput(maybeError.stderr)}`
  )
}

function logHarnessStatusResultFailure(
  configured: ConfiguredHarnessInvocation,
  configKey: HarnessInspectCommandConfigKey,
  stdoutBuffer: Buffer,
  errorMessage: string
): void {
  console.error(`[HarnessBoard] [${configKey}] Failed after command completed: ${errorMessage}`)
  console.error(
    `[HarnessBoard] [${configKey}] Command: ${formatHarnessCommand(configured.invocation)}`
  )
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
    selectedDeployUnits: options.selectedDeployUnitsJson ?? "",
    sessionWorkspacePath: options.sessionWorkspacePath ?? "",
    pluginPath: cwd,
    mode,
    workflowTemplate: options.workflowTemplate ?? "",
    workflowNodes: options.workflowNodes ?? "",
    nodeId: options.nodeId ?? ""
  }
  return value.replace(
    /\$\{(pluginWorkspace|project|projectDir|projectCode|feature|selectedDeployUnits|sessionWorkspacePath|pluginPath|mode|workflowTemplate|workflowNodes|nodeId)\}/g,
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
  const optionalCommandArgs: Array<{
    key: keyof Pick<
      HarnessCommandParseOptions,
      "workflowTemplate" | "workflowNodes" | "selectedDeployUnitsJson"
    >
    placeholder: string
    flag: string
  }> = [
    { key: "workflowTemplate", placeholder: "${workflowTemplate}", flag: "--workflow-template" },
    { key: "workflowNodes", placeholder: "${workflowNodes}", flag: "--workflow-nodes" },
    {
      key: "selectedDeployUnitsJson",
      placeholder: "${selectedDeployUnits}",
      flag: "--selected-deployUnit"
    }
  ]
  const tokens = tokenizeInspectCommand(command.trim())
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if ((token === "${projectCodes...}" || token === "${projectDirs...}") && options.projectDirs) {
      args.push(...options.projectDirs)
      continue
    }
    const optionalArg = optionalCommandArgs.find((item) => !options[item.key] && (
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

function readBoardConfigInspectCommand(
  cwd: string,
  mode: HarnessInspectCommandName
): string | null {
  return readBoardConfigPlatformText(cwd, HARNESS_INSPECT_COMMAND_CONFIG_KEYS[mode])
}

function boardConfigPublicAgentmdDeployUnits(cwd: string): string[] {
  const parsed = readBoardConfig(cwd)
  return parsed ? uniqueStringsInOrder(parsed.supported_deploy_units) : []
}

function boardConfigSupportsSessionContextInjection(cwd: string): boolean {
  return readBoardConfigInspectCommand(cwd, "sessionContext") !== null
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
  return (
    relativePath === "" ||
    (!!relativePath && !relativePath.startsWith("..") && !isAbsolute(relativePath))
  )
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

function resolveDeployUnitMappingSnapshots(
  snapshots: HarnessDeployUnitMapping[]
): HarnessDeployUnitMapping[] {
  const mappingsById = new Map(
    readDeployUnitMappingStore().mappings.map((mapping) => [mapping.deployUnitIdMapping, mapping])
  )
  return snapshots.map((snapshot) => mappingsById.get(snapshot.deployUnitIdMapping) ?? snapshot)
}

function resolveFeatureDeployUnitMappings(
  projectId: string,
  featureId: string
): HarnessDeployUnitMapping[] {
  const binding = findFeatureDeployUnitBinding(projectId, featureId)
  return binding ? resolveDeployUnitMappingSnapshots(binding.selectedDeployUnitMappings) : []
}

function getHarnessSelectedDeployUnitsCommandOptions(
  project: HarnessProjectMetadata,
  featureId: string,
  selectedDeployUnits?: HarnessDeployUnitMapping[]
): Pick<HarnessCommandParseOptions, "selectedDeployUnitsJson"> {
  const resolvedDeployUnits =
    selectedDeployUnits ??
    resolveFeatureDeployUnitMappings(project.projectId, featureId)
  if (resolvedDeployUnits.length === 0) return {}
  return {
    selectedDeployUnitsJson: JSON.stringify(resolvedDeployUnits)
  }
}

function formatMarkdownInlineCode(value: string): string {
  return value.replace(/`/g, "\\`")
}

function formatMarkdownTableCell(value: string): string {
  return value.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim()
}

function resolveHarnessAdditionalWorkspaceRootMappings(
  projectId: string,
  featureId: string,
  _workspacePath: string
): HarnessDeployUnitMapping[] {
  const seen = new Set<string>()
  const mappings: HarnessDeployUnitMapping[] = []
  for (const mapping of resolveFeatureDeployUnitMappings(projectId, featureId)) {
    const localRepoPath = normalizeText(mapping.localRepoPath).trim()
    if (!localRepoPath || !isAbsolute(localRepoPath)) continue

    const normalizedPath = resolve(localRepoPath)
    if (seen.has(normalizedPath)) continue
    seen.add(normalizedPath)
    const description = normalizeText(mapping.description).trim()
    mappings.push({
      deployUnitIdMapping: mapping.deployUnitIdMapping,
      deployUnitId: normalizeText(mapping.deployUnitId).trim(),
      localRepoPath,
      ...(description ? { description } : {})
    })
  }
  return mappings
}

function buildHarnessAdditionalWorkspaceRootsPrompt(
  mappings: HarnessDeployUnitMapping[]
): string | undefined {
  if (mappings.length === 0) return undefined

  return [
    "## Multi-Repository Workspaces",
    "",
    "The repositories listed below are first-class working repositories for this session, equivalent to the `workspace root`. You may use these paths directly as working directories and read or edit files under them whenever they are relevant to the task.",
    "",
    "| repo description | deployUnit | repo path |",
    "| --- | --- | --- |",
    ...mappings.map((mapping) => {
      const description = formatMarkdownTableCell(normalizeText(mapping.description).trim())
      const deployUnitId = formatMarkdownTableCell(normalizeText(mapping.deployUnitId).trim())
      const localRepoPath = formatMarkdownTableCell(
        `\`${formatMarkdownInlineCode(normalizeText(mapping.localRepoPath).trim())}\``
      )
      return `| ${description} | ${deployUnitId} | ${localRepoPath} |`
    })
  ].join("\n")
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

function hasConfiguredHarnessInvocation(
  project: HarnessProjectMetadata,
  mode: HarnessInspectCommandName
): boolean {
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
    logHarnessStatusResultFailure(
      invocation,
      configKey,
      stdoutBuffer,
      "Inspect adapter returned empty output"
    )
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
    logHarnessStatusResultFailure(
      configured,
      configKey,
      stdoutBuffer,
      "Inspect adapter returned empty output"
    )
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

function normalizeDynamicWorkflowConfigSnapshot(
  value: unknown
): HarnessDynamicWorkflowConfig | null {
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

function statusFromFeatureStatus(
  featureStatus: HarnessFeatureStatus,
  label?: string
): HarnessStatus {
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
  const featureStatus =
    explicitFeatureStatus ??
    deriveFeatureStatusFromCurrentNode(currentNodeStatus, currentNodeIndex, workflow.nodes.length)
  const featureStatusLabel = explicitFeatureStatus
    ? normalizeText(value.featureStatusLabel).trim()
    : ""
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

function normalizeWorkflowArtifactDefinition(
  value: unknown
): HarnessWorkflowArtifactDefinition | null {
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

function workflowArtifactDefinitions(
  workflow: HarnessWorkflow
): Map<string, Map<string, HarnessWorkflowArtifactDefinition>> {
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
              return normalizeArtifact(
                project,
                artifact,
                artifactId ? definitions?.get(artifactId) : undefined
              )
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
    projectFromLean: value.projectFromLean === true,
    projectDir,
    systemId: normalizeText(value.systemId),
    systemName: normalizeText(value.systemName),
    workspacePath: normalizeText(value.workspacePath) || normalizeText(oldWorkspace.path),
    sessionWorkspacePath: normalizeText(value.sessionWorkspacePath) || undefined,
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

function createUniqueDeployUnitMappingId(seenIds: Set<string>): string {
  let id = uuid()
  while (seenIds.has(id)) {
    id = uuid()
  }
  return id
}

function normalizeDeployUnitMappings(
  value: unknown,
  options: { assignMissingOrDuplicateMappingId?: boolean } = {}
): HarnessDeployUnitMapping[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const seenIds = new Set<string>()
  const mappings: HarnessDeployUnitMapping[] = []
  for (const item of value) {
    if (!isObject(item)) continue
    const deployUnitId = normalizeText(item.deployUnitId).trim()
    const localRepoPath = normalizeText(item.localRepoPath).trim()
    const description = normalizeText(item.description).trim()
    if (!deployUnitId || !localRepoPath || seen.has(deployUnitId)) continue

    let deployUnitIdMapping = normalizeText(item.deployUnitIdMapping).trim()
    if (!deployUnitIdMapping || seenIds.has(deployUnitIdMapping)) {
      if (!options.assignMissingOrDuplicateMappingId) continue
      deployUnitIdMapping = createUniqueDeployUnitMappingId(seenIds)
    }

    seen.add(deployUnitId)
    seenIds.add(deployUnitIdMapping)
    mappings.push({
      deployUnitIdMapping,
      deployUnitId,
      localRepoPath,
      ...(description ? { description } : {})
    })
  }
  return mappings
}

function normalizeDeployUnitMappingsForSave(value: unknown): HarnessDeployUnitMapping[] {
  return normalizeDeployUnitMappings(value, { assignMissingOrDuplicateMappingId: true })
}

function normalizeSessionContextInjectionSource(
  value: unknown
): HarnessSessionContextInjectionSource {
  const source = normalizeText(value).trim()
  return HARNESS_SESSION_CONTEXT_INJECTION_SOURCES.has(
    source as HarnessSessionContextInjectionSource
  )
    ? (source as HarnessSessionContextInjectionSource)
    : "cmbdevclaw"
}

function normalizeFeatureDeployUnitBinding(
  value: unknown
): HarnessFeatureDeployUnitBindingRecord | null {
  if (!isObject(value)) return null
  const projectId = normalizeText(value.projectId).trim()
  const featureId = normalizeText(value.featureId).trim()
  const selectedDeployUnitMappings = normalizeDeployUnitMappings(value.selectedDeployUnitMappings)
  if (!projectId || !featureId) return null
  return {
    projectId,
    featureId,
    selectedDeployUnitMappings,
    sessionContextInjectionSource: normalizeSessionContextInjectionSource(
      value.sessionContextInjectionSource
    ),
    createdAt: normalizeText(value.createdAt).trim() || formatGmt8Timestamp(),
    updatedAt: normalizeText(value.updatedAt).trim() || undefined
  }
}

function normalizeFeatureDeployUnitBindings(
  value: unknown
): HarnessFeatureDeployUnitBindingRecord[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const bindings: HarnessFeatureDeployUnitBindingRecord[] = []
  for (const item of value) {
    const binding = normalizeFeatureDeployUnitBinding(item)
    if (!binding) continue
    const key = featureDeployUnitBindingKey(binding.projectId, binding.featureId)
    if (seen.has(key)) continue
    seen.add(key)
    bindings.push(binding)
  }
  return bindings
}

function getCurrentProjectCreator(): HarnessProjectCreatorMetadata | undefined {
  const userInfo = getUserInfo()
  const orgLevels = deriveUpperOrgLevelsFromPath(userInfo?.pathName)
  const creator = normalizeProjectCreator({
    sapId: userInfo?.sapId,
    ystId: userInfo?.ystId,
    userName: userInfo?.userName,
    orgName: userInfo?.orgName,
    pathName: userInfo?.pathName,
    upperOrgLv0: orgLevels.upperOrgLv0,
    upperOrgLv1: orgLevels.upperOrgLv1
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

function readDeployUnitMappingStore(): HarnessDeployUnitMappingStoreFile {
  getOpenworkDir()
  if (!existsSync(HARNESS_DEPLOY_UNIT_MAPPING_FILE)) return emptyDeployUnitMappingStore()
  try {
    const parsed = JSON.parse(readFileSync(HARNESS_DEPLOY_UNIT_MAPPING_FILE, "utf-8")) as unknown
    if (!isObject(parsed)) return emptyDeployUnitMappingStore()
    return {
      version: 1,
      mappings: normalizeDeployUnitMappings(parsed.mappings)
    }
  } catch {
    return emptyDeployUnitMappingStore()
  }
}

function writeDeployUnitMappingStore(store: HarnessDeployUnitMappingStoreFile): void {
  getOpenworkDir()
  writeFileSync(HARNESS_DEPLOY_UNIT_MAPPING_FILE, `${JSON.stringify(store, null, 2)}\n`)
}

function featureDeployUnitBindingKey(projectId: string, featureId: string): string {
  return `${projectId}\0${featureId}`
}

function readFeatureDeployUnitBindingStore(): HarnessFeatureDeployUnitBindingStoreFile {
  getOpenworkDir()
  if (!existsSync(HARNESS_FEATURE_DEPLOY_UNIT_BINDING_FILE)) {
    return emptyFeatureDeployUnitBindingStore()
  }
  try {
    const parsed = JSON.parse(
      readFileSync(HARNESS_FEATURE_DEPLOY_UNIT_BINDING_FILE, "utf-8")
    ) as unknown
    if (!isObject(parsed)) return emptyFeatureDeployUnitBindingStore()
    return {
      version: 1,
      bindings: normalizeFeatureDeployUnitBindings(parsed.bindings)
    }
  } catch {
    return emptyFeatureDeployUnitBindingStore()
  }
}

function writeFeatureDeployUnitBindingStore(
  store: HarnessFeatureDeployUnitBindingStoreFile
): void {
  getOpenworkDir()
  writeFileSync(HARNESS_FEATURE_DEPLOY_UNIT_BINDING_FILE, `${JSON.stringify(store, null, 2)}\n`)
}

function findFeatureDeployUnitBinding(
  projectId: string,
  featureId: string
): HarnessFeatureDeployUnitBindingRecord | null {
  const key = featureDeployUnitBindingKey(projectId, featureId)
  return (
    readFeatureDeployUnitBindingStore().bindings.find(
      (binding) => featureDeployUnitBindingKey(binding.projectId, binding.featureId) === key
    ) ?? null
  )
}

function saveFeatureDeployUnitBinding(
  projectId: string,
  featureId: string,
  selectedDeployUnitMappings: HarnessDeployUnitMapping[],
  sessionContextInjectionSource: HarnessSessionContextInjectionSource
): HarnessFeatureDeployUnitBindingRecord {
  const store = readFeatureDeployUnitBindingStore()
  const key = featureDeployUnitBindingKey(projectId, featureId)
  const now = formatGmt8Timestamp()
  const existingIndex = store.bindings.findIndex(
    (binding) => featureDeployUnitBindingKey(binding.projectId, binding.featureId) === key
  )
  const existing = existingIndex >= 0 ? store.bindings[existingIndex] : null
  const binding: HarnessFeatureDeployUnitBindingRecord = {
    projectId,
    featureId,
    selectedDeployUnitMappings,
    sessionContextInjectionSource,
    createdAt:
      existing?.createdAt && isGmt8Timestamp(existing.createdAt) ? existing.createdAt : now,
    updatedAt: now
  }
  if (existingIndex >= 0) {
    store.bindings[existingIndex] = binding
  } else {
    store.bindings.unshift(binding)
  }
  writeFeatureDeployUnitBindingStore(store)
  return binding
}

export function listHarnessDeployUnitMappings(): HarnessDeployUnitMapping[] {
  return readDeployUnitMappingStore().mappings
}

export function saveHarnessDeployUnitMappings(
  mappings: HarnessDeployUnitMapping[]
): HarnessDeployUnitMapping[] {
  const normalized = normalizeDeployUnitMappingsForSave(mappings)
  writeDeployUnitMappingStore({
    version: 1,
    mappings: normalized
  })
  return normalized
}

function toListItem(project: HarnessProjectMetadata): HarnessProjectListItem {
  const harnessAdapter = project["harness-adapter"]
  const plugin = findAdapterPlugin(project)
  const boardCompatibility = evaluateBoardPluginCompatibility(
    plugin,
    harnessAdapter.name || harnessAdapter.id
  )
  const supportsDeployUnits = boardCompatibility.compatible
  const supportsSessionContextInjection =
    boardCompatibility.compatible && plugin
      ? boardConfigSupportsSessionContextInjection(plugin.path)
      : false
  return {
    projectId: project.projectId,
    name: project.name,
    description: project.description,
    projectCode: project.projectCode,
    projectFromLean: project.projectFromLean,
    projectDir: projectDirectoryName(project),
    systemId: project.systemId,
    systemName: project.systemName,
    workspacePath: project.workspacePath,
    sessionWorkspacePath: project.sessionWorkspacePath,
    harnessAdapter: {
      id: harnessAdapter.id,
      name: harnessAdapter.name,
      type: harnessAdapter.type
    },
    creator: project.creator,
    boardCompatibility,
    supportsDeployUnits,
    supportsSessionContextInjection,
    lifecycle: {
      status: project.lifecycle.status,
      updateAt: project.lifecycle.updateAt
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

function validateProjectCodeUnique(
  code: string,
  store: HarnessProjectStoreFile,
  excludeProjectId?: string
): void {
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

function resolveFeatureSelectedDeployUnits(
  input: HarnessFeatureCreateInput,
  _project: HarnessProjectMetadata
): HarnessDeployUnitMapping[] {
  if (!Array.isArray(input.selectedDeployUnits)) return []

  const selected = normalizeDeployUnitMappings(input.selectedDeployUnits)
  if (selected.length === 0) {
    throw new Error("请至少选择一个发布单元")
  }

  const configuredMappings = readDeployUnitMappingStore().mappings
  const configuredById = new Map(
    configuredMappings.map((mapping) => [mapping.deployUnitIdMapping, mapping])
  )
  const resolved: HarnessDeployUnitMapping[] = []

  for (const item of selected) {
    const configured = configuredById.get(item.deployUnitIdMapping)
    const resolvedMapping = configured ?? item
    const deployUnitId = resolvedMapping.deployUnitId.trim()
    const localRepoPath = resolvedMapping.localRepoPath.trim()
    if (!isAbsolute(localRepoPath)) {
      throw new Error(`发布单元 ${deployUnitId} 的代码库路径必须是绝对路径`)
    }
    if (!existsSync(localRepoPath)) {
      throw new Error(`发布单元 ${deployUnitId} 的代码库路径不存在：${localRepoPath}`)
    }
    const description = resolvedMapping.description?.trim() || ""
    resolved.push({
      deployUnitIdMapping: resolvedMapping.deployUnitIdMapping,
      deployUnitId,
      localRepoPath,
      ...(description ? { description } : {})
    })
  }

  return resolved
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

function validateSkipNodeInput(input: HarnessSkipNodeInput): {
  projectId: string
  slug: string
  nodeId: string
} {
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
    : [{ path: `${base}/STATE.md`, purpose: "run-list" }]
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
      sessionWorkspacePath: project.sessionWorkspacePath,
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

export function readHarnessFeatureMetadata(
  metadata: unknown
): { projectId: string; slug: string } | null {
  if (!isObject(metadata) || !isObject(metadata.harnessFeature)) return null
  const projectId = normalizeText(metadata.harnessFeature.projectId).trim()
  const slug = normalizeText(metadata.harnessFeature.slug).trim()
  return projectId && slug ? { projectId, slug } : null
}

export interface HarnessFeatureAgentContext {
  systemPromptInject?: string
  enableAgentsPrompt?: boolean
  harnessAgentsPrompt?: string
  additionalAgentsWorkspacePaths?: string[]
  additionalAgentsWorkspaceMappings?: HarnessDeployUnitMapping[]
  sessionContextInjectWarning?: string
  agentmdLoadStatus?: HarnessAgentmdLoadStatusItem[]
  pluginOutputDir?: string
  systemId?: string
  pluginRoot?: string
  pluginId?: string
  pluginName?: string
  pluginWorkspace?: string
  featureId?: string
  /** Harness project stable id (= properties.harnessProjectId on events). Exposed to hooks as HARNESS_PROJECT_ID. */
  harnessProjectId?: string
  /** Bound adapter name (= properties.harnessAdapterName on events). Exposed to hooks as HARNESS_ADAPTER_NAME. */
  harnessAdapterName?: string
  /** Bound adapter version (= properties.harnessAdapterVersion on events). Exposed to hooks as HARNESS_ADAPTER_VERSION. */
  harnessAdapterVersion?: string
  projectCode?: string
  projectDir?: string
}

export interface HarnessFeatureAgentContextOptions {
  workspacePath?: string
}

function isHarnessSessionContextOk(value: unknown): boolean {
  return value === true
}

interface HarnessSessionContextInjectResult {
  prompt?: string
  warning?: string
  agentmdLoadStatus?: HarnessAgentmdLoadStatusItem[]
}

function formatSessionContextInjectWarning(detail: string): string {
  return detail
    ? `插件 AGENTS.md 注入失败：${detail}，已回退到 CMBDevClaw AGENTS.md`
    : "插件 AGENTS.md 注入失败，已回退到 CMBDevClaw AGENTS.md"
}

function readHarnessFeatureSessionContextAgentPrompt(
  project: HarnessProjectMetadata,
  featureId: string,
  options: { sessionWorkspacePath?: string } = {}
): HarnessSessionContextInjectResult {
  if (!hasConfiguredHarnessInvocation(project, "sessionContext")) {
    const configKey = HARNESS_INSPECT_COMMAND_CONFIG_KEYS.sessionContext
    const detail = `插件未配置 inspectCommands.${process.platform}.${configKey}`
    console.warn("[HarnessBoard] session_context_inject missing, fallback to CMBDevClaw AGENTS.md:", {
      projectId: project.projectId,
      featureId,
      configKey
    })
    return { warning: formatSessionContextInjectWarning(detail) }
  }

  try {
    const configured = buildConfiguredHarnessInvocation(project, "sessionContext", {
      feature: featureId,
      ...getHarnessSelectedDeployUnitsCommandOptions(project, featureId),
      sessionWorkspacePath: options.sessionWorkspacePath
    })
    const result = runHarnessJsonInvocation(configured, "sessionContext")
    const message = normalizeText(result.message).trim()
    if (!isHarnessSessionContextOk(result.ok)) {
      console.warn("[HarnessBoard] session_context_inject returned not ok, fallback to CMBDevClaw AGENTS.md:", {
        projectId: project.projectId,
        featureId,
        message
      })
      return { warning: formatSessionContextInjectWarning(message) }
    }
    const agentmdLoadStatus = normalizeHarnessAgentmdLoadStatus(result.agentmdLoadStatus)
    const sessionContext = normalizeText(result.sessionContext).trim()
    if (!sessionContext) {
      const detail = message || "sessionContext 为空"
      console.warn("[HarnessBoard] session_context_inject returned empty sessionContext, fallback to CMBDevClaw AGENTS.md:", {
        projectId: project.projectId,
        featureId,
        message
      })
      return { warning: formatSessionContextInjectWarning(detail) }
    }
    if (sessionContext.length > HARNESS_SESSION_CONTEXT_MAX_CHARS) {
      console.warn("[HarnessBoard] session_context_inject sessionContext truncated:", {
        chars: sessionContext.length,
        maxChars: HARNESS_SESSION_CONTEXT_MAX_CHARS
      })
      return {
        prompt: sessionContext.slice(0, HARNESS_SESSION_CONTEXT_MAX_CHARS),
        agentmdLoadStatus
      }
    }
    return { prompt: sessionContext, agentmdLoadStatus }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    console.error("[HarnessBoard] session_context_inject failed, fallback to CMBDevClaw AGENTS.md:", {
      projectId: project.projectId,
      featureId,
      error
    })
    return { warning: formatSessionContextInjectWarning(detail) }
  }
}

export function buildHarnessFeatureAgentContext(
  metadata: unknown,
  options: HarnessFeatureAgentContextOptions = {}
): HarnessFeatureAgentContext | null {
  const feature = readHarnessFeatureMetadata(metadata)
  if (!feature) return null

  const project = requireProject(feature.projectId)
  const cwd = adapterPluginDir(project)
  const adapter = project["harness-adapter"]
  // 与事件侧一致：用 adapter 快照（可经 plugin 解析）作为暴露给 hook 的 adapter 名/版本，
  // 保证外部按此上报后落进与原生事件相同的 harnessAdapterName/Version 聚合桶。
  const adapterSnapshot = getHarnessProjectAdapterSnapshot(feature.projectId)
  const plugin = findAdapterPlugin(project)
  const staticSystemPromptInject = readBoardConfigPlatformText(cwd, "system_prompt_inject")
  const pluginOutputDir = readBoardConfigPlatformText(cwd, "plugin_dir_hook")
  const systemId = normalizeText(project.systemId).trim()
  const featureBinding = findFeatureDeployUnitBinding(project.projectId, feature.slug)
  const sessionContextInjectionSource =
    featureBinding?.sessionContextInjectionSource ?? "cmbdevclaw"
  const usePluginAgentsPrompt = sessionContextInjectionSource === "plugin"
  const sessionWorkspacePath = normalizeText(options.workspacePath).trim() || project.workspacePath
  const render = (
    template: string | null,
    command: HarnessInspectCommandName
  ): string | undefined =>
    template
      ? replaceHarnessConfigPlaceholders(template, project, command, cwd, {
          feature: feature.slug,
          sessionWorkspacePath
        }).trim() || undefined
      : undefined
  const renderedStaticPrompt = render(staticSystemPromptInject, "run")
  const sessionContextInjectResult = usePluginAgentsPrompt
    ? readHarnessFeatureSessionContextAgentPrompt(project, feature.slug, { sessionWorkspacePath })
    : undefined
  const harnessAgentsPrompt = sessionContextInjectResult?.prompt
  const pluginPromptLoaded = Boolean(harnessAgentsPrompt?.trim())
  const additionalWorkspaceRootMappings = resolveHarnessAdditionalWorkspaceRootMappings(
    project.projectId,
    feature.slug,
    sessionWorkspacePath
  )
  const additionalWorkspaceRoots = additionalWorkspaceRootMappings.map(
    (mapping) => mapping.localRepoPath
  )
  const additionalWorkspaceRootsPrompt = pluginPromptLoaded
    ? undefined
    : buildHarnessAdditionalWorkspaceRootsPrompt(additionalWorkspaceRootMappings)
  const systemPromptInject =
    [renderedStaticPrompt, additionalWorkspaceRootsPrompt].filter(Boolean).join("\n\n") ||
    undefined

  return {
    systemPromptInject,
    enableAgentsPrompt: !pluginPromptLoaded,
    ...(harnessAgentsPrompt ? { harnessAgentsPrompt } : {}),
    ...(!pluginPromptLoaded && additionalWorkspaceRoots.length > 0
      ? {
          additionalAgentsWorkspacePaths: additionalWorkspaceRoots,
          additionalAgentsWorkspaceMappings: additionalWorkspaceRootMappings
        }
      : {}),
    ...(sessionContextInjectResult?.warning
      ? { sessionContextInjectWarning: sessionContextInjectResult.warning }
      : {}),
    ...(sessionContextInjectResult?.agentmdLoadStatus
      ? { agentmdLoadStatus: sessionContextInjectResult.agentmdLoadStatus }
      : {}),
    pluginOutputDir: render(pluginOutputDir, "run"),
    systemId: systemId || undefined,
    pluginRoot: cwd,
    pluginId: normalizeText(plugin?.id) || adapter.id,
    pluginName: normalizeText(plugin?.name) || adapter.name,
    pluginWorkspace: project.workspacePath,
    featureId: feature.slug,
    harnessProjectId: feature.projectId,
    harnessAdapterName: normalizeText(adapterSnapshot?.name).trim() || undefined,
    harnessAdapterVersion: normalizeText(adapterSnapshot?.version).trim() || undefined,
    projectCode: project.projectCode,
    projectDir: projectDirectoryName(project)
  }
}

/**
 * Best-effort resolve the current stage of a feature for per-turn attribution:
 * its human-readable name (`group-label`, e.g. "Dev-代码实现") plus the node's
 * status at this moment as a stable enum label (进行中/已完成/未开始/...). Within a
 * plugin the (group, label) pair is unique, so the name is a stable bucket key
 * and no raw node id is reported. Mirrors the cheap head of getHarnessRunDetail
 * (run inspect → current node + workflow) without building the full view model.
 * Returns null on any failure (missing project, adapter error, no current node,
 * unlabeled node) so it never blocks a conversation. `status` is null when the
 * node status cannot be resolved (so an "unknown" bucket is never reported).
 */
export function resolveHarnessFeatureCurrentStage(
  projectId: string,
  slug: string
): { name: string; status: string | null } | null {
  try {
    const normalizedProjectId = normalizeText(projectId).trim()
    const normalizedSlug = normalizeText(slug).trim()
    if (!normalizedProjectId || !normalizedSlug) return null
    const project = requireProject(normalizedProjectId)
    const snapshot = runInspectAdapter(project, "run", normalizedSlug)
    const run = isObject(snapshot.run) ? snapshot.run : {}
    const currentNodeId = normalizeText(run.currentNodeId).trim()
    if (!currentNodeId) return null
    const workflow = normalizeWorkflow(snapshot.workflow)
    const node = workflow.nodes.find((n) => n.id === currentNodeId)
    const label = normalizeText(node?.label).trim()
    if (!label) return null
    const group = normalizeText(node?.group).trim()
    const name = group ? `${group}-${label}` : label

    // Status of the current node *at this turn*, as a stable enum label. The run
    // nodes array (plugin-provided) carries per-node nodeStatus; fall back to the
    // run-level currentNodeStatus. Use the default label map so buckets stay
    // stable regardless of any plugin-custom status label. "unknown" → null so we
    // never report a noise bucket.
    const runNode = Array.isArray(run.nodes)
      ? run.nodes.find(
          (n): n is Record<string, unknown> =>
            isObject(n) && normalizeText(n.id).trim() === currentNodeId
        )
      : undefined
    const rawStatus = runNode?.nodeStatus ?? run.currentNodeStatus
    const nodeStatus = normalizeNodeStatus(rawStatus)
    const status =
      nodeStatus === UNKNOWN_NODE_STATUS ? null : DEFAULT_NODE_STATUS_LABELS[nodeStatus]

    return { name, status }
  } catch {
    return null
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

export function getHarnessProjectPublicAgentmdDeployUnits(projectId: string): string[] {
  const project = requireProject(projectId)
  const plugin = findAdapterPlugin(project)
  if (!plugin) return []
  const boardCompatibility = evaluateBoardPluginCompatibility(
    plugin,
    project["harness-adapter"].name || project["harness-adapter"].id
  )
  if (!boardCompatibility.compatible) return []
  return boardConfigPublicAgentmdDeployUnits(plugin.path)
}

export function getHarnessLocalAgentmdDeployUnitMappings(
  mappings: HarnessDeployUnitMapping[]
): string[] {
  return normalizeDeployUnitMappings(mappings)
    .filter((mapping) => {
      const localRepoPath = mapping.localRepoPath.trim()
      return isAbsolute(localRepoPath) && existsSync(join(localRepoPath, "AGENTS.md"))
    })
    .map((mapping) => mapping.deployUnitIdMapping)
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
    projectFromLean: input.projectFromLean === true,
    projectDir: input.projectDir.trim(),
    systemId: input.systemId.trim(),
    systemName: input.systemName.trim(),
    workspacePath: input.workspacePath.trim(),
    sessionWorkspacePath: input.sessionWorkspacePath?.trim() || undefined,
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
  const selectedDeployUnits = resolveFeatureSelectedDeployUnits(input, project)
  const sessionContextInjectionSource = normalizeSessionContextInjectionSource(
    input.sessionContextInjectionSource
  )

  if (!existsSync(workspacePath)) {
    throw new Error(projectDirectoryMissingMessage(project))
  }
  const selectedDeployUnitsOptions = getHarnessSelectedDeployUnitsCommandOptions(
    project,
    feature,
    selectedDeployUnits
  )

  try {
    const configured = buildConfiguredHarnessInvocation(project, "createFeature", {
      feature,
      ...workflowOptions,
      ...selectedDeployUnitsOptions
    })
    runHarnessInvocation(configured, harnessCommandLogOptions("createFeature"))
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error)
    if (raw.includes("已存在")) {
      throw new Error("该特性在当前项目路径下已存在")
    }
    throw new Error(`创建特性失败：${raw}`)
  }

  saveFeatureDeployUnitBinding(
    project.projectId,
    feature,
    selectedDeployUnits,
    sessionContextInjectionSource
  )

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
    projectFromLean: input.projectFromLean === true,
    projectDir: existingProjectDir,
    systemId: input.systemId.trim(),
    systemName: input.systemName.trim(),
    workspacePath: existing.workspacePath,
    sessionWorkspacePath: input.sessionWorkspacePath?.trim() || undefined,
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

function findCompatibleKnowledgePlugin(adapterId: string): {
  plugin: PluginMetadata
  adapter: HarnessAdapterRegistryItem
} {
  const normalizedAdapterId = normalizeText(adapterId).trim()
  const plugin = getPlugins().find(
    (item) => pluginHasBoardConfig(item) && pluginMatchesAdapterId(item, normalizedAdapterId)
  )
  if (!plugin) {
    throw new Error("插件未安装或不支持项目模式")
  }

  const adapter = pluginToHarnessAdapter(plugin)
  if (!adapter.boardCompatibility.compatible) {
    throw new Error(adapter.boardCompatibility.message || adapter.boardCompatibility.label)
  }

  return { plugin, adapter }
}

function createKnowledgeCommandProject(
  plugin: PluginMetadata,
  adapter: HarnessAdapterRegistryItem
): HarnessProjectMetadata {
  return {
    projectId: "__project_constraints__",
    name: adapter.name,
    description: adapter.description,
    projectCode: adapter.id,
    projectFromLean: false,
    projectDir: "project-constraints",
    systemId: "",
    systemName: "",
    workspacePath: getOpenworkDir(),
    "harness-adapter": pluginToHarnessAdapterSnapshot(plugin),
    lifecycle: {
      status: "active",
      createAt: ""
    }
  }
}

function resolveHarnessKnowledgePath(plugin: PluginMetadata, adapter: HarnessAdapterRegistryItem): string | null {
  const rawPath = readBoardConfigPlatformText(plugin.path, "knowledge_path")
  if (!rawPath) return null

  const replaced = replaceHarnessConfigPlaceholders(
    rawPath,
    createKnowledgeCommandProject(plugin, adapter),
    "pullKnowledge",
    plugin.path
  ).trim()
  if (!replaced) return null

  return isAbsolute(replaced) ? resolve(replaced) : resolve(plugin.path, replaced)
}

interface KnowledgeFileScanResult {
  files: HarnessKnowledgePreviewResult["files"]
  error?: string
}

function formatKnowledgeFileError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function scanKnowledgeFiles(rootPath: string): KnowledgeFileScanResult {
  const files: HarnessKnowledgePreviewResult["files"] = []
  const errors: string[] = []
  const maxEntries = 2000
  const ignoredDirs = new Set(["node_modules"])

  function shouldSkipEntry(entry: Dirent): boolean {
    return entry.name.startsWith(".") || (entry.isDirectory() && ignoredDirs.has(entry.name))
  }

  function recordError(path: string, error: unknown): void {
    errors.push(`${path}: ${formatKnowledgeFileError(error)}`)
  }

  function readDir(dirPath: string, relativePath = ""): void {
    if (files.length >= maxEntries) return

    let entries: Dirent[]
    try {
      entries = readdirSync(dirPath, { withFileTypes: true })
        .filter((entry) => !shouldSkipEntry(entry))
        .sort((left, right) => {
          if (left.isDirectory() && !right.isDirectory()) return -1
          if (!left.isDirectory() && right.isDirectory()) return 1
          return left.name.localeCompare(right.name)
        })
    } catch (error) {
      recordError(dirPath, error)
      return
    }

    for (const entry of entries) {
      if (files.length >= maxEntries) return

      const entryRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name
      const fullPath = join(dirPath, entry.name)

      if (entry.isDirectory()) {
        files.push({
          path: `/${entryRelativePath}`,
          is_dir: true
        })
        readDir(fullPath, entryRelativePath)
        continue
      }

      let stat: ReturnType<typeof statSync>
      try {
        stat = statSync(fullPath)
      } catch (error) {
        recordError(fullPath, error)
        continue
      }
      if (!stat.isFile()) continue
      files.push({
        path: `/${entryRelativePath}`,
        is_dir: false,
        size: stat.size,
        modified_at: stat.mtime.toISOString()
      })
    }
  }

  readDir(rootPath)
  const error = errors.length > 0
    ? `部分知识库文件读取失败：${errors.slice(0, 3).join("；")}${errors.length > 3 ? ` 等 ${errors.length} 个错误` : ""}`
    : undefined
  return { files, ...(error ? { error } : {}) }
}

export function getHarnessKnowledgePreview(adapterId: string): HarnessKnowledgePreviewResult {
  const { plugin, adapter } = findCompatibleKnowledgePlugin(adapterId)
  const knowledgePath = resolveHarnessKnowledgePath(plugin, adapter)

  if (!knowledgePath) {
    return {
      adapterId: adapter.id,
      adapterName: adapter.name,
      configured: false,
      exists: false,
      files: []
    }
  }

  if (!existsSync(knowledgePath)) {
    return {
      adapterId: adapter.id,
      adapterName: adapter.name,
      configured: true,
      exists: false,
      path: knowledgePath,
      files: []
    }
  }

  let stat: ReturnType<typeof statSync>
  try {
    stat = statSync(knowledgePath)
  } catch (error) {
    return {
      adapterId: adapter.id,
      adapterName: adapter.name,
      configured: true,
      exists: false,
      path: knowledgePath,
      files: [],
      error: `无法读取 knowledge_path：${formatKnowledgeFileError(error)}`
    }
  }
  if (!stat.isDirectory()) {
    return {
      adapterId: adapter.id,
      adapterName: adapter.name,
      configured: true,
      exists: false,
      path: knowledgePath,
      files: [],
      error: "knowledge_path 不是目录"
    }
  }

  const scanResult = scanKnowledgeFiles(knowledgePath)
  return {
    adapterId: adapter.id,
    adapterName: adapter.name,
    configured: true,
    exists: true,
    path: knowledgePath,
    files: scanResult.files,
    ...(scanResult.error ? { error: scanResult.error } : {})
  }
}

export function syncHarnessProjectConstraints(adapterId: string): HarnessProjectConstraintSyncResult {
  const { plugin, adapter } = findCompatibleKnowledgePlugin(adapterId)
  const configuredCommand = readBoardConfigInspectCommand(plugin.path, "pullKnowledge")
  if (!configuredCommand) {
    throw new Error(`插件未配置 inspectCommands.${process.platform}.pull_knowledge，请检查插件设置`)
  }

  const commandProject = createKnowledgeCommandProject(plugin, adapter)
  const configured: ConfiguredHarnessInvocation = {
    cwd: plugin.path,
    invocation: parseInspectCommand(configuredCommand, commandProject, "pullKnowledge", plugin.path)
  }

  const stdoutBuffer = runHarnessInvocation(configured, harnessCommandLogOptions("pullKnowledge", adapter.name))
  const raw = decodeAdapterBuffer(stdoutBuffer).trim()
  let message = ""
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    throw new Error("公共系统约束同步返回格式异常")
  }
  if (!isObject(parsed) || typeof parsed.ok !== "boolean") {
    throw new Error("公共系统约束同步返回格式异常")
  }
  message = normalizeText(parsed.message).trim()
  const outputPath = normalizeText(parsed.path).trim()
  if (!parsed.ok) {
    throw new Error(message || "公共系统约束同步失败")
  }
  return {
    adapterId: adapter.id,
    adapterName: adapter.name,
    ...(message ? { message } : {}),
    ...(outputPath ? { path: outputPath } : {})
  }
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
  const { executable, args } = parseInspectCommand(configuredCommand, firstProject, mode, cwd, {
    projectDirs
  })

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
    logHarnessStatusResultFailure(
      configured,
      configKey,
      stdoutBuffer,
      "Inspect adapter returned empty output"
    )
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
  const groups = new Map<
    string,
    {
      cwd: string
      projects: HarnessProjectMetadata[]
    }
  >()

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
  const currentNodeStatus =
    nodes.find((node) => node.id === currentNodeId)?.nodeStatus ?? UNKNOWN_NODE_STATUS
  const explicitFeatureStatus = normalizeFeatureStatus(run.featureStatus)
  const featureStatus =
    explicitFeatureStatus ??
    deriveFeatureStatusFromCurrentNode(currentNodeStatus, currentNodeIndex, workflow.nodes.length)
  const featureStatusLabel = explicitFeatureStatus
    ? normalizeText(run.featureStatusLabel).trim()
    : ""
  const overallStatus = statusFromFeatureStatus(featureStatus, featureStatusLabel)
  const hookLogRefs = normalizeHookLogRefs(project, run.hookLogRefs)
  const hookLogEntries = readHookLogRefs(project, hookLogRefs)
  const { nodes: nodesWithHookLogs, unmatchedHooks } = applyHookLogEntries(nodes, hookLogEntries)
  const skipNodeAvailable = hasConfiguredHarnessInvocation(project, "skipNode")
  const selectedDeployUnits = resolveFeatureDeployUnitMappings(project.projectId, slug)
  return {
    project: {
      projectId: project.projectId,
      name: project.name,
      projectCode: project.projectCode,
      projectDir: projectDirectoryName(project),
      systemId: project.systemId,
      workspacePath: project.workspacePath,
      sessionWorkspacePath: project.sessionWorkspacePath,
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
      selectedDeployUnits,
      hookLogRefs,
      watchRefs: normalizeWatchRefs(project, run.watchRefs, makeWatchRefs(featureSlug)),
      currentNodeId,
      nodes: nodesWithHookLogs,
      unmatchedHooks
    },
    sessions: []
  }
}
