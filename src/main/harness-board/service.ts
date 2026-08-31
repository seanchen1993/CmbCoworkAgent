import { spawn, type ChildProcess } from "child_process"
import { access, mkdir } from "node:fs/promises"
import { basename, isAbsolute, join, relative, resolve } from "path"
import { serialize } from "node:v8"
import * as chardet from "jschardet"
import * as iconv from "iconv-lite"
import { v4 as uuid } from "uuid"
import { getOpenworkDir, getPlugins, getUserInfo } from "../storage"
import { deriveUpperOrgLevelsFromPath } from "../org-levels"
import type { PluginMetadata } from "../types"
import type { HarnessConfigReadSnapshot } from "./service-read-snapshot"
import { normalizeHarnessAgentmdLoadStatus } from "../../shared/harness-board-types"
import {
  cancelHarnessAdapterDetailScope,
  HarnessAdapterDetailWorkerResultError,
  parseHarnessAdapterDetailBatchInWorker,
  parseHarnessAdapterRunInWorker
} from "./adapter-detail-client"
import {
  HARNESS_ADAPTER_DETAIL_MAX_INPUT_BYTES,
  HARNESS_ADAPTER_DETAIL_MAX_IPC_BYTES,
  HARNESS_ADAPTER_DETAIL_MAX_PROJECTS_PER_BATCH,
  type HarnessAdapterDetailBatchResult,
  type HarnessAdapterRunProjection
} from "./adapter-detail-protocol"
import {
  cancelHarnessCatalogScope,
  readHarnessCatalogPageInWorker,
  readHarnessDialogTipsInWorker,
  readHarnessLeanTokenInWorker,
  readHarnessProjectContextsInWorker
} from "./catalog-client"
import type {
  HarnessProjectContextItem,
  HarnessProjectContextConfigSnapshot
} from "./catalog-protocol"
import { HARNESS_PROJECT_CONTEXT_MAX_PROJECTS } from "./catalog-protocol"
import {
  readHarnessJsonFileBounded,
  withHarnessStoreMutation,
  writeHarnessJsonFileAtomic
} from "./async-json-store"
import {
  assertHarnessProjectFieldBudgets,
  HARNESS_PROJECT_DESCRIPTION_MAX_CHARS,
  HARNESS_PROJECT_PATH_MAX_CHARS,
  HARNESS_PROJECT_STORE_MAX_BYTES,
  HARNESS_PROJECT_STORE_MAX_PROJECTS,
  HARNESS_PROJECT_TEXT_MAX_CHARS
} from "./store-limits"
import type {
  HarnessAdapterRegistryItem,
  HarnessAdapterSnapshot,
  HarnessAdapterType,
  HarnessArtifactType,
  HarnessBoardCompatibility,
  HarnessDynamicWorkflowConfig,
  HarnessDynamicWorkflowNode,
  HarnessDynamicWorkflowTemplate,
  HarnessFeatureCreateInput,
  HarnessFeatureCreateResult,
  HarnessFeatureDeployUnitUpdateInput,
  HarnessFeatureDeployUnitBinding,
  HarnessAgentmdLoadStatusItem,
  HarnessNodeStatus,
  HarnessProjectCreateInput,
  HarnessProjectConstraintSyncResult,
  HarnessProjectCreatorMetadata,
  HarnessProjectDetailViewModel,
  HarnessProjectListItem,
  HarnessProjectMetadata,
  HarnessProjectMetadataUpdateInput,
  HarnessProjectModeSubagentConfig,
  HarnessRequestUserInputConfig,
  HarnessRunDetailViewModel,
  HarnessSessionContextInjectionSource,
  HarnessDeployUnitMapping,
  HarnessLeanTokenConfig,
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

interface HarnessDeployUnitMappingStoreFile {
  version: 1
  mappings: HarnessDeployUnitMapping[]
}

interface HarnessLeanTokenStoreFile {
  leanToken: string
}

interface HarnessFeatureDeployUnitBindingRecord extends HarnessFeatureDeployUnitBinding {
  createdAt: string
  updatedAt?: string
}

interface HarnessFeatureDeployUnitBindingStoreFile {
  version: 1
  bindings: HarnessFeatureDeployUnitBindingRecord[]
}

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

class HarnessInvocationSemaphore {
  private active = 0
  private readonly waiting: Array<() => void> = []

  constructor(private readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active += 1
    } else {
      await new Promise<void>((resolvePromise) => {
        this.waiting.push(resolvePromise)
      })
    }

    let released = false
    return () => {
      if (released) return
      released = true
      const next = this.waiting.shift()
      if (next) {
        next()
      } else {
        this.active -= 1
      }
    }
  }
}

interface HarnessCommandParseOptions {
  leanToken?: string
  feature?: string
  selectedDeployUnitsJson?: string
  sessionWorkspacePath?: string
  projectDirs?: string[]
  workflowTemplate?: string
  workflowNodes?: string
  nodeId?: string
  preserveMissingPlaceholders?: boolean
}

const HARNESS_BOARD_FILE = join(getOpenworkDir(), "harness-board-projects.json")
const HARNESS_DEPLOY_UNIT_MAPPING_FILE = join(getOpenworkDir(), "harness-deployUnitId-mapping.json")
const HARNESS_FEATURE_DEPLOY_UNIT_BINDING_FILE = join(getOpenworkDir(), "harness-board-features.json")
const HARNESS_LEAN_TOKEN_FILE = join(getOpenworkDir(), "leanstar-config.json")

const HARNESS_ADAPTER_TIMEOUT_MS = 15_000
const HARNESS_PULL_KNOWLEDGE_TIMEOUT_MS = 45_000
const HARNESS_ADAPTER_MAX_BUFFER = HARNESS_ADAPTER_DETAIL_MAX_INPUT_BYTES
const HARNESS_INVOCATION_MAX_CONCURRENCY = 2
const HARNESS_SESSION_CONTEXT_MAX_CHARS = 60_000
const CHARDET_CONFIDENCE_THRESHOLD = 0.8
const CHARDET_SAMPLE_BYTES = 8_192
const HARNESS_LOG_OUTPUT_PREVIEW_BYTES = 16 * 1024
const HARNESS_DEPLOY_UNIT_MAPPING_MAX_ENTRIES = 512
const HARNESS_DEPLOY_UNIT_MAPPING_MAX_BYTES = 2 * 1024 * 1024
const HARNESS_FEATURE_BINDING_MAX_ENTRIES = 4_096
const HARNESS_FEATURE_BINDING_MAX_BYTES = 2 * 1024 * 1024
const HARNESS_FEATURE_ID_MAX_CHARS = 2_048
const HARNESS_LEAN_TOKEN_MAX_BYTES = 64 * 1024
const HARNESS_LEAN_TOKEN_MAX_CHARS = 8 * 1024
const HARNESS_BOARD_CONFIG_MAX_BYTES = 1024 * 1024
const HARNESS_NAME_PATTERN = /^[\u4e00-\u9fffA-Za-z0-9_-]+$/u
const HARNESS_NAME_RULE_MESSAGE = "仅支持中文、英文字母、数字、-、_，不允许空格"
const CUSTOM_WORKFLOW_TEMPLATE_ID = "custom"

const harnessInvocationSemaphore = new HarnessInvocationSemaphore(
  HARNESS_INVOCATION_MAX_CONCURRENCY
)
let harnessDetailRequestSequence = 0
const harnessDetailAbortByScope = new Map<string, AbortController>()

function makeHarnessDetailScope(prefix: string): string {
  harnessDetailRequestSequence += 1
  return `${prefix}:${harnessDetailRequestSequence}`
}

function beginHarnessDetailRequest(scope: string): {
  signal: AbortSignal
  finish: () => void
} {
  cancelHarnessDetailRequestScope(scope)
  const controller = new AbortController()
  harnessDetailAbortByScope.set(scope, controller)
  return {
    signal: controller.signal,
    finish: () => {
      if (harnessDetailAbortByScope.get(scope) === controller) {
        harnessDetailAbortByScope.delete(scope)
      }
    }
  }
}

export function cancelHarnessDetailRequestScope(scope: string): void {
  harnessDetailAbortByScope.get(scope)?.abort()
  harnessDetailAbortByScope.delete(scope)
  cancelHarnessCatalogScope(`${scope}:context`)
  cancelHarnessAdapterDetailScope(`${scope}:adapter`)
}

function throwIfHarnessDetailCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw harnessDetailCancelledError()
}

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

function emptyLeanTokenStore(): HarnessLeanTokenStoreFile {
  return {
    leanToken: ""
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

type HarnessBoardConfigReadSnapshot = HarnessConfigReadSnapshot<Record<string, unknown>>
function evaluateBoardPluginCompatibility(
  plugin: PluginMetadata | null,
  pluginName: string,
  configSnapshot?: HarnessBoardConfigReadSnapshot
): HarnessBoardCompatibility {
  const displayName = plugin?.name || pluginName || "插件"
  if (!plugin) {
    return makeBoardCompatibility(
      "missing-plugin",
      "插件未安装",
      `项目使用的插件未安装：${displayName}`
    )
  }

  if (!configSnapshot) {
    return makeBoardCompatibility(
      "missing-board-config",
      "插件与看板不兼容",
      `插件「${displayName}」未提供看板能力，请安装兼容版本插件。`
    )
  }

  let config: Record<string, unknown> | null
  if (configSnapshot) {
    if (configSnapshot.error) {
      const message = configSnapshot.error.message
      return makeBoardCompatibility(
        "invalid-board-config",
        "配置错误",
        `插件「${displayName}」的 ${BOARD_CONFIG_REL_PATH} 配置错误：${message}`
      )
    }
    config = configSnapshot.value
  } else {
    return makeBoardCompatibility(
      "invalid-board-config",
      "配置错误",
      `插件「${displayName}」的 ${BOARD_CONFIG_REL_PATH} 尚未完成异步读取`
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
  const plugins = getPlugins()
  const adapterId = normalizeText(adapter.id).trim()
  if (adapterId) {
    const plugin = plugins.find((item) => pluginAdapterId(item) === adapterId)
    if (plugin) return plugin
  }

  const adapterName = normalizeText(adapter.name).trim()
  if (adapterName) {
    const plugin = plugins.find((item) => item.name === adapterName)
    if (plugin) return plugin
  }

  return null
}

function readBoardConfigPlatformTextFromValue(
  parsed: Record<string, unknown> | null,
  key: HarnessPlatformConfigKey
): string | null {
  if (!parsed || !isObject(parsed.inspectCommands)) return null
  const platformCommands = parsed.inspectCommands[process.platform]
  if (!isObject(platformCommands)) return null
  const command = normalizeText(platformCommands[key]).trim()
  return command || null
}

function hasPullKnowledgeCommand(
  _plugin: PluginMetadata,
  configSnapshot?: HarnessBoardConfigReadSnapshot
): boolean {
  if (configSnapshot) {
    return (
      !configSnapshot.error &&
      readBoardConfigPlatformTextFromValue(configSnapshot.value, "pull_knowledge") !== null
    )
  }
  return false
}

function pluginToHarnessAdapter(
  plugin: PluginMetadata,
  configSnapshot?: HarnessBoardConfigReadSnapshot
): HarnessAdapterRegistryItem {
  const id = pluginAdapterId(plugin)
  const useScenario = normalizeText(plugin.useScenario)
  return {
    id,
    name: normalizeText(plugin.name) || id,
    version: normalizeText(plugin.version),
    type: "plugin",
    description: normalizeText(plugin.description),
    ...(useScenario ? { useScenario } : {}),
    pullKnowledgeAvailable: hasPullKnowledgeCommand(plugin, configSnapshot),
    boardCompatibility: evaluateBoardPluginCompatibility(
      plugin,
      normalizeText(plugin.name) || id,
      configSnapshot
    )
  }
}

function pluginToHarnessAdapterSnapshot(
  plugin: PluginMetadata,
  configSnapshot?: HarnessBoardConfigReadSnapshot
): HarnessAdapterSnapshot {
  const adapter = pluginToHarnessAdapter(plugin, configSnapshot)
  return {
    id: adapter.id,
    name: adapter.name,
    version: adapter.version,
    type: adapter.type
  }
}

export async function listHarnessAdapters(): Promise<HarnessAdapterRegistryItem[]> {
  const scope = makeHarnessDetailScope("harness-adapter-list")
  const registry: HarnessAdapterRegistryItem[] = []
  let cursor: number | undefined
  for (let page = 0; page < 64; page += 1) {
    const result = await readHarnessCatalogPageInWorker(
      {
        includeProjects: false,
        registryLimit: 64,
        ...(cursor === undefined ? {} : { registryCursor: cursor })
      },
      scope
    )
    registry.push(...result.registry)
    if (result.registryNextCursor === null) return registry
    cursor = result.registryNextCursor
  }
  throw new Error("Harness adapter list exceeded the configured page budget")
}

/**
 * Builds the project-mode catalog from one plugin/config snapshot. The renderer needs both
 * projections at the same time; serving them through separate IPC calls would otherwise read
 * plugins.json and every board_config.json twice during one mode switch.
 */
export async function getHarnessBoardCatalog(): Promise<{
  projects: HarnessProjectListItem[]
  registry: HarnessAdapterRegistryItem[]
}> {
  const [projects, registry] = await Promise.all([
    listHarnessProjects(),
    listHarnessAdapters()
  ])
  return { projects, registry }
}

async function resolveHarnessAdapter(
  adapterId: string,
  adapterType: HarnessAdapterType
): Promise<HarnessAdapterSnapshot> {
  if (adapterType !== "plugin") {
    throw new Error(`Unsupported harness adapter type: ${adapterType}`)
  }
  const plugin = getPlugins().find((item) => pluginMatchesAdapterId(item, adapterId))
  if (!plugin) {
    throw new Error(
      "Selected plugin is not installed or does not provide board_core/board_config.json"
    )
  }
  const config = await readBoardConfig(plugin.path)
  if (!config) {
    throw new Error(
      "Selected plugin is not installed or does not provide board_core/board_config.json"
    )
  }
  const configSnapshot = { value: config, error: null }
  const compatibility = evaluateBoardPluginCompatibility(plugin, plugin.name, configSnapshot)
  if (!compatibility.compatible) {
    throw new Error(compatibility.message || "Selected plugin is not compatible with current APP")
  }
  return pluginToHarnessAdapterSnapshot(plugin, configSnapshot)
}

async function resolveHarnessAdapterSnapshot(
  adapter: HarnessAdapterSnapshot
): Promise<HarnessAdapterSnapshot> {
  const plugin = findPluginForAdapterSnapshot(adapter)
  if (!plugin) {
    throw new Error(
      "Selected plugin is not installed or does not provide board_core/board_config.json"
    )
  }
  const config = await readBoardConfig(plugin.path)
  if (!config) {
    throw new Error(
      "Selected plugin is not installed or does not provide board_core/board_config.json"
    )
  }
  const snapshot = { value: config, error: null }
  const compatibility = evaluateBoardPluginCompatibility(plugin, plugin.name, snapshot)
  if (!compatibility.compatible) {
    throw new Error(compatibility.message || "Selected plugin is not compatible with current APP")
  }
  return pluginToHarnessAdapterSnapshot(plugin, snapshot)
}

function adapterPluginDir(project: HarnessProjectMetadata): string {
  const adapter = project["harness-adapter"]
  if (adapter.type !== "plugin") {
    throw new Error(`Unsupported harness adapter type: ${adapter.type}`)
  }

  const plugin = findAdapterPlugin(project)
  if (!plugin) {
    throw new Error(`Harness adapter plugin not found: ${adapter.name || adapter.id}`)
  }
  return plugin.path
}

function findAdapterPlugin(project: HarnessProjectMetadata): PluginMetadata | null {
  const adapter = project["harness-adapter"]
  return findPluginForAdapterSnapshot(adapter)
}

function toTrimmedOutput(value: unknown): string {
  if (Buffer.isBuffer(value)) {
    const truncated = value.byteLength > HARNESS_LOG_OUTPUT_PREVIEW_BYTES
    const preview = truncated ? value.subarray(0, HARNESS_LOG_OUTPUT_PREVIEW_BYTES) : value
    const output = decodeAdapterBuffer(preview).trim()
    return truncated ? `${output}\n…(truncated)` : output
  }
  if (typeof value !== "string") return ""
  const truncated = value.length > HARNESS_LOG_OUTPUT_PREVIEW_BYTES
  const output = (truncated ? value.slice(0, HARNESS_LOG_OUTPUT_PREVIEW_BYTES) : value).trim()
  return truncated ? `${output}\n…(truncated)` : output
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
  const leanToken = options.leanToken ?? ""
  const replacements: Record<string, string | undefined> = {
    pluginWorkspace: project.workspacePath,
    project: projectDir,
    projectDir,
    projectCode: project.projectCode,
    leanToken,
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
    /\$\{(pluginWorkspace|project|projectDir|projectCode|leanToken|feature|selectedDeployUnits|sessionWorkspacePath|pluginPath|mode|workflowTemplate|workflowNodes|nodeId)\}/g,
    (placeholder: string, key: string) => {
      const replacement = replacements[key]
      if (replacement) return replacement
      return options.preserveMissingPlaceholders ? placeholder : ""
    }
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

async function readBoardConfig(cwd: string): Promise<Record<string, unknown> | null> {
  const configPath = join(cwd, BOARD_CONFIG_REL_PATH)
  try {
    const parsed = await readHarnessJsonFileBounded(
      configPath,
      HARNESS_BOARD_CONFIG_MAX_BYTES,
      "Harness board config"
    )
    return isObject(parsed) ? parsed : null
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Invalid board_config.json: ${message}`)
  }
}

async function readBoardConfigPlatformText(
  cwd: string,
  key: HarnessPlatformConfigKey
): Promise<string | null> {
  return readBoardConfigPlatformTextFromValue(await readBoardConfig(cwd), key)
}

async function readBoardConfigInspectCommand(
  cwd: string,
  mode: HarnessInspectCommandName
): Promise<string | null> {
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
  return (
    relativePath === "" ||
    (!!relativePath && !relativePath.startsWith("..") && !isAbsolute(relativePath))
  )
}

function projectDirectoryMissingMessage(project: HarnessProjectMetadata): string {
  return `请确认项目「${project.projectCode}」的工作区「${project.workspacePath}」下存在项目文件夹「${projectDirectoryName(project)}」。`
}

async function resolveDeployUnitMappingSnapshots(
  snapshots: HarnessDeployUnitMapping[]
): Promise<HarnessDeployUnitMapping[]> {
  const mappingsById = new Map(
    (await readDeployUnitMappingStore()).mappings.map((mapping) => [
      mapping.deployUnitIdMapping,
      mapping
    ])
  )
  return snapshots.map((snapshot) => mappingsById.get(snapshot.deployUnitIdMapping) ?? snapshot)
}

async function resolveFeatureDeployUnitMappings(
  projectId: string,
  featureId: string
): Promise<HarnessDeployUnitMapping[]> {
  const binding = await findFeatureDeployUnitBinding(projectId, featureId)
  return binding ? await resolveDeployUnitMappingSnapshots(binding.selectedDeployUnitMappings) : []
}

async function getHarnessSelectedDeployUnitsCommandOptions(
  project: HarnessProjectMetadata,
  featureId: string,
  selectedDeployUnits?: HarnessDeployUnitMapping[]
): Promise<Pick<HarnessCommandParseOptions, "selectedDeployUnitsJson">> {
  const resolvedDeployUnits =
    selectedDeployUnits ??
    await resolveFeatureDeployUnitMappings(project.projectId, featureId)
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

async function resolveHarnessAdditionalWorkspaceRootMappings(
  projectId: string,
  featureId: string,
  resolvedMappings?: HarnessDeployUnitMapping[]
): Promise<HarnessDeployUnitMapping[]> {
  const seen = new Set<string>()
  const mappings: HarnessDeployUnitMapping[] = []
  for (const mapping of resolvedMappings ?? await resolveFeatureDeployUnitMappings(projectId, featureId)) {
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

async function buildOptionalConfiguredHarnessInvocation(
  project: HarnessProjectMetadata,
  mode: HarnessInspectCommandName,
  options: HarnessCommandParseOptions = {}
): Promise<ConfiguredHarnessInvocation | null> {
  const cwd = adapterPluginDir(project)
  const config = await readBoardConfig(cwd)
  const compatibility = evaluateBoardPluginCompatibility(
    findAdapterPlugin(project),
    project["harness-adapter"].name || project["harness-adapter"].id,
    { value: config, error: null }
  )
  if (!compatibility.compatible) {
    throw new Error(compatibility.message || compatibility.label)
  }
  const configuredCommand = readBoardConfigPlatformTextFromValue(
    config,
    HARNESS_INSPECT_COMMAND_CONFIG_KEYS[mode]
  )
  if (!configuredCommand) return null
  const leanToken = options.leanToken ?? (await readLeanTokenStore()).leanToken

  return {
    cwd,
    invocation: parseInspectCommand(configuredCommand, project, mode, cwd, {
      ...options,
      leanToken
    })
  }
}

async function buildConfiguredHarnessInvocation(
  project: HarnessProjectMetadata,
  mode: HarnessInspectCommandName,
  options: HarnessCommandParseOptions = {}
): Promise<ConfiguredHarnessInvocation> {
  const configured = await buildOptionalConfiguredHarnessInvocation(project, mode, options)
  if (!configured) {
    const configKey = HARNESS_INSPECT_COMMAND_CONFIG_KEYS[mode]
    throw new Error(`插件未配置 inspectCommands.${process.platform}.${configKey}，请检查插件设置`)
  }
  return configured
}

function createHarnessInvocationError(
  message: string,
  details: {
    status?: number
    signal?: string
    stdout?: Buffer
    stderr?: Buffer
  } = {}
): Error {
  const error = new Error(message) as Error & {
    status?: number
    signal?: string
    stdout?: Buffer
    stderr?: Buffer
  }
  if (typeof details.status === "number") error.status = details.status
  if (details.signal) error.signal = details.signal
  if (details.stdout) error.stdout = details.stdout
  if (details.stderr) error.stderr = details.stderr
  return error
}

function killHarnessInvocationProcess(child: ChildProcess): void {
  if (process.platform === "win32" && child.pid) {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true
    })
    killer.once("error", () => {
      child.kill()
    })
    return
  }
  child.kill("SIGTERM")
}

function harnessDetailCancelledError(): Error {
  const error = new Error("Harness detail request was superseded")
  error.name = "AbortError"
  return error
}

async function runHarnessInvocationAsync(
  configured: ConfiguredHarnessInvocation,
  logOptions: HarnessInvocationLogOptions | undefined,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<Buffer> {
  const release = await harnessInvocationSemaphore.acquire()

  try {
    if (signal?.aborted) throw harnessDetailCancelledError()
    const { cwd, invocation } = configured
    if (logOptions) logHarnessInvocationStart(configured, logOptions)
    const stdoutBuffer = await new Promise<Buffer>((resolvePromise, rejectPromise) => {
      const child = spawn(invocation.executable, invocation.args, {
        cwd,
        env: {
          ...process.env,
          PYTHONIOENCODING: "utf-8",
          PYTHONUTF8: "1"
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      })

      const stdoutChunks: Buffer[] = []
      const stderrChunks: Buffer[] = []
      let stdoutLength = 0
      let stderrLength = 0
      let settled = false
      let timedOut = false
      let exceededMaxBuffer = false
      let aborted = false

      const timer = setTimeout(() => {
        timedOut = true
        killHarnessInvocationProcess(child)
      }, timeoutMs)

      const settle = (callback: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener("abort", handleAbort)
        callback()
      }

      const handleAbort = (): void => {
        if (settled || aborted) return
        aborted = true
        killHarnessInvocationProcess(child)
      }
      signal?.addEventListener("abort", handleAbort, { once: true })
      if (signal?.aborted) handleAbort()

      const appendChunk = (chunks: Buffer[], chunk: Buffer, currentLength: number): number => {
        const nextLength = currentLength + chunk.length
        chunks.push(chunk)
        if (nextLength > HARNESS_ADAPTER_MAX_BUFFER && !exceededMaxBuffer) {
          exceededMaxBuffer = true
          killHarnessInvocationProcess(child)
        }
        return nextLength
      }

      child.stdout.on("data", (chunk: Buffer) => {
        stdoutLength = appendChunk(stdoutChunks, chunk, stdoutLength)
      })
      child.stderr.on("data", (chunk: Buffer) => {
        stderrLength = appendChunk(stderrChunks, chunk, stderrLength)
      })
      child.once("error", (error) => {
        const stdout = Buffer.concat(stdoutChunks, stdoutLength)
        const stderr = Buffer.concat(stderrChunks, stderrLength)
        settle(() => {
          rejectPromise(createHarnessInvocationError(error.message, { stdout, stderr }))
        })
      })
      child.once("close", (code, signal) => {
        const stdout = Buffer.concat(stdoutChunks, stdoutLength)
        const stderr = Buffer.concat(stderrChunks, stderrLength)
        settle(() => {
          if (aborted) {
            rejectPromise(harnessDetailCancelledError())
            return
          }
          if (timedOut) {
            rejectPromise(
              createHarnessInvocationError(
                `Harness adapter timed out after ${Math.round(timeoutMs / 1000)}s`,
                { signal: "timeout", stdout, stderr }
              )
            )
            return
          }
          if (exceededMaxBuffer) {
            rejectPromise(
              createHarnessInvocationError("Harness adapter stdout/stderr exceeded maxBuffer", {
                signal: "maxBuffer",
                stdout,
                stderr
              })
            )
            return
          }
          if (code === 0) {
            resolvePromise(stdout)
            return
          }
          rejectPromise(
            createHarnessInvocationError(`Harness adapter exited with code ${code ?? "unknown"}`, {
              ...(typeof code === "number" ? { status: code } : {}),
              ...(signal ? { signal } : {}),
              stdout,
              stderr
            })
          )
        })
      })
    })
    if (logOptions) logHarnessInvocationSuccess(stdoutBuffer, logOptions)
    return stdoutBuffer
  } catch (error) {
    if (logOptions) logHarnessInvocationFailure(configured, logOptions, error)
    throw new Error(formatAdapterError(error))
  } finally {
    release()
  }
}

async function runInspectAdapter(
  project: HarnessProjectMetadata,
  mode: "project" | "run",
  feature?: string
): Promise<Record<string, unknown>> {
  const invocation = await buildConfiguredHarnessInvocation(project, mode, { feature })
  const configKey = HARNESS_INSPECT_COMMAND_CONFIG_KEYS[mode]
  const stdoutBuffer = await runHarnessInvocationAsync(
    invocation,
    harnessCommandLogOptions(mode),
    HARNESS_ADAPTER_TIMEOUT_MS
  )

  return parseInspectAdapterOutput(invocation, configKey, stdoutBuffer)
}

function parseInspectAdapterOutput(
  invocation: ConfiguredHarnessInvocation,
  configKey: HarnessInspectCommandConfigKey,
  stdoutBuffer: Buffer
): Record<string, unknown> {
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

async function runHarnessJsonInvocation(
  configured: ConfiguredHarnessInvocation,
  mode: HarnessInspectCommandName
): Promise<Record<string, unknown>> {
  const configKey = HARNESS_INSPECT_COMMAND_CONFIG_KEYS[mode]
  const stdoutBuffer = await runHarnessInvocationAsync(
    configured,
    harnessCommandLogOptions(mode),
    HARNESS_ADAPTER_TIMEOUT_MS
  )
  return parseInspectAdapterOutput(configured, configKey, stdoutBuffer)
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

async function getHarnessDynamicWorkflowConfigForProject(
  project: HarnessProjectMetadata
): Promise<HarnessDynamicWorkflowConfig | null> {
  try {
    const invocation = await buildOptionalConfiguredHarnessInvocation(project, "dynamicWorkflow")
    if (!invocation) return null

    const response = await runHarnessJsonInvocation(invocation, "dynamicWorkflow")
    if (response.ok !== true) return null
    return normalizeDynamicWorkflowConfigSnapshot(response)
  } catch (error) {
    console.warn("[HarnessBoard] Dynamic workflow config unavailable:", formatAdapterError(error))
    return null
  }
}

const UNKNOWN_NODE_STATUS: HarnessNodeStatus = "unknown"
const UNKNOWN_ARTIFACT_TYPE: HarnessArtifactType = "unknown"

function normalizeNodeStatus(value: unknown): HarnessNodeStatus {
  const nodeStatus = normalizeText(value)
  return HARNESS_NODE_STATUSES.has(nodeStatus as HarnessNodeStatus)
    ? (nodeStatus as HarnessNodeStatus)
    : UNKNOWN_NODE_STATUS
}

function normalizeArtifactType(value: unknown): HarnessArtifactType {
  const artifactType = normalizeText(value)
  return HARNESS_ARTIFACT_TYPES.has(artifactType as HarnessArtifactType)
    ? (artifactType as HarnessArtifactType)
    : UNKNOWN_ARTIFACT_TYPE
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

function resolveHarnessDialogTipsTemplate(
  template: string,
  project: HarnessProjectMetadata,
  mode: HarnessInspectCommandName,
  cwd: string,
  options: HarnessCommandParseOptions = {}
): string | undefined {
  return replaceHarnessConfigPlaceholders(template, project, mode, cwd, options).trim() || undefined
}

function resolveHarnessNextActionTemplate(
  value: unknown,
  project: HarnessProjectMetadata,
  mode: HarnessInspectCommandName,
  cwd: string,
  options: HarnessCommandParseOptions = {},
  config: { replaceUserMessagePlaceholders?: boolean } = {}
): HarnessWorkflowNextAction | undefined {
  const nextAction = normalizeWorkflowNextAction(value)
  if (!nextAction) return undefined

  const userMessage =
    nextAction.userMessage && config.replaceUserMessagePlaceholders
      ? replaceHarnessConfigPlaceholders(nextAction.userMessage, project, mode, cwd, options).trim()
      : nextAction.userMessage
  const dialogTips = nextAction.dialogTips
    ? resolveHarnessDialogTipsTemplate(nextAction.dialogTips, project, mode, cwd, options)
    : undefined
  const resolved = {
    ...(nextAction.slashSkill ? { slashSkill: nextAction.slashSkill } : {}),
    ...(userMessage ? { userMessage } : {}),
    ...(dialogTips ? { dialogTips } : {})
  }
  return Object.keys(resolved).length > 0 ? resolved : undefined
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

function normalizeProject(value: unknown): HarnessProjectMetadata | null {
  if (!isObject(value)) return null
  if (typeof value.projectId !== "string" || typeof value.name !== "string") return null
  const harnessAdapter = isObject(value["harness-adapter"]) ? value["harness-adapter"] : null
  if (!harnessAdapter) return null
  assertHarnessProjectFieldBudgets(value)
  const oldWorkspace = isObject(value.workspace) ? value.workspace : {}
  const lifecycle = isObject(value.lifecycle) ? value.lifecycle : {}
  const creator = normalizeProjectCreator(value.creator)
  const adapterId = normalizeText(harnessAdapter.id).slice(0, HARNESS_PROJECT_TEXT_MAX_CHARS)
  const adapterName = normalizeText(harnessAdapter.name).slice(0, HARNESS_PROJECT_TEXT_MAX_CHARS)
  const projectCode = normalizeText(value.projectCode).slice(0, HARNESS_PROJECT_TEXT_MAX_CHARS)
  const projectDir =
    normalizeText(value.projectDir).slice(0, HARNESS_PROJECT_TEXT_MAX_CHARS) || projectCode
  const systemConstraintFirstLoadedAt = normalizeText(value.systemConstraintFirstLoadedAt)
    .trim()
    .slice(0, 128)
  if (!adapterId || !adapterName || harnessAdapter.type !== "plugin") return null
  const now = new Date().toISOString()

  return {
    projectId: value.projectId.slice(0, HARNESS_PROJECT_TEXT_MAX_CHARS),
    name: value.name.slice(0, HARNESS_PROJECT_TEXT_MAX_CHARS),
    description: normalizeText(value.description).slice(0, HARNESS_PROJECT_DESCRIPTION_MAX_CHARS),
    projectCode,
    projectFromLean: value.projectFromLean === true,
    projectDir,
    systemId: normalizeText(value.systemId).slice(0, HARNESS_PROJECT_TEXT_MAX_CHARS),
    systemName: normalizeText(value.systemName).slice(0, HARNESS_PROJECT_TEXT_MAX_CHARS),
    workspacePath: (
      normalizeText(value.workspacePath) || normalizeText(oldWorkspace.path)
    ).slice(0, HARNESS_PROJECT_PATH_MAX_CHARS),
    sessionWorkspacePath:
      normalizeText(value.sessionWorkspacePath).slice(0, HARNESS_PROJECT_PATH_MAX_CHARS) ||
      undefined,
    ...(systemConstraintFirstLoadedAt ? { systemConstraintFirstLoadedAt } : {}),
    "harness-adapter": {
      id: adapterId,
      name: adapterName,
      version: normalizeText(harnessAdapter.version).slice(0, HARNESS_PROJECT_TEXT_MAX_CHARS),
      type: "plugin"
    },
    ...(creator ? { creator } : {}),
    lifecycle: {
      status: value.lifecycle && lifecycle.status === "archived" ? "archived" : "active",
      createAt: typeof lifecycle.createAt === "string" ? lifecycle.createAt.slice(0, 128) : now,
      updateAt: typeof lifecycle.updateAt === "string" ? lifecycle.updateAt.slice(0, 128) : undefined
    }
  }
}

function normalizeProjectCreator(value: unknown): HarnessProjectCreatorMetadata | null {
  if (!isObject(value)) return null
  const creator: HarnessProjectCreatorMetadata = {
    sapId: normalizeText(value.sapId).slice(0, HARNESS_PROJECT_TEXT_MAX_CHARS),
    ystId: normalizeText(value.ystId).slice(0, HARNESS_PROJECT_TEXT_MAX_CHARS),
    userName: normalizeText(value.userName).slice(0, HARNESS_PROJECT_TEXT_MAX_CHARS),
    orgName: normalizeText(value.orgName).slice(0, HARNESS_PROJECT_TEXT_MAX_CHARS),
    pathName: normalizeText(value.pathName).slice(0, HARNESS_PROJECT_PATH_MAX_CHARS),
    upperOrgLv0: normalizeText(value.upperOrgLv0).slice(0, HARNESS_PROJECT_TEXT_MAX_CHARS),
    upperOrgLv1: normalizeText(value.upperOrgLv1).slice(0, HARNESS_PROJECT_TEXT_MAX_CHARS)
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
    if (mappings.length >= HARNESS_DEPLOY_UNIT_MAPPING_MAX_ENTRIES) break
    if (!isObject(item)) continue
    const deployUnitId = normalizeText(item.deployUnitId).trim().slice(0, 2_048)
    const localRepoPath = normalizeText(item.localRepoPath).trim().slice(0, 8_192)
    const description = normalizeText(item.description).trim().slice(0, 4_096)
    if (!deployUnitId || !localRepoPath || seen.has(deployUnitId)) continue

    let deployUnitIdMapping = normalizeText(item.deployUnitIdMapping).trim().slice(0, 512)
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
  assertFeatureBindingKeyBudgets(projectId, featureId)
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
  if (value.length > HARNESS_FEATURE_BINDING_MAX_ENTRIES) {
    throw new Error(`特性发布单元绑定超过 ${HARNESS_FEATURE_BINDING_MAX_ENTRIES} 条上限`)
  }
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

function normalizeProjectStore(value: unknown): HarnessProjectStoreFile {
  if (!isObject(value)) throw new Error("Harness project store 顶层格式无效")
  if ("projects" in value && !Array.isArray(value.projects)) {
    throw new Error("Harness project store projects 字段格式无效")
  }
  const rows = Array.isArray(value.projects) ? value.projects : []
  if (rows.length > HARNESS_PROJECT_STORE_MAX_PROJECTS) {
    throw new Error(`项目数量超过 ${HARNESS_PROJECT_STORE_MAX_PROJECTS} 条上限`)
  }
  return {
    version: 1,
    projects: rows
      .map((item) => normalizeProject(item))
      .filter((item): item is HarnessProjectMetadata => item !== null)
  }
}

function assertFeatureBindingKeyBudgets(projectId: string, featureId: string): void {
  if (projectId.length > HARNESS_PROJECT_TEXT_MAX_CHARS) {
    throw new Error(`特性绑定项目 ID 超过 ${HARNESS_PROJECT_TEXT_MAX_CHARS} 字符上限`)
  }
  if (featureId.length > HARNESS_FEATURE_ID_MAX_CHARS) {
    throw new Error(`特性名称超过 ${HARNESS_FEATURE_ID_MAX_CHARS} 字符上限`)
  }
}

async function readProjectStore(): Promise<HarnessProjectStoreFile> {
  const parsed = await readHarnessJsonFileBounded(
    HARNESS_BOARD_FILE,
    HARNESS_PROJECT_STORE_MAX_BYTES,
    "Harness project store"
  )
  return parsed === null ? emptyProjectStore() : normalizeProjectStore(parsed)
}

async function mutateProjectStore<T>(
  mutator: (store: HarnessProjectStoreFile) => Promise<T> | T
): Promise<T> {
  return withHarnessStoreMutation(HARNESS_BOARD_FILE, async () => {
    const store = await readProjectStore()
    const result = await mutator(store)
    if (store.projects.length > HARNESS_PROJECT_STORE_MAX_PROJECTS) {
      throw new Error(`项目数量超过 ${HARNESS_PROJECT_STORE_MAX_PROJECTS} 条上限`)
    }
    for (const project of store.projects) normalizeProject(project)
    await writeHarnessJsonFileAtomic(
      HARNESS_BOARD_FILE,
      store,
      HARNESS_PROJECT_STORE_MAX_BYTES,
      "Harness project store"
    )
    return result
  })
}

function normalizeDeployUnitMappingStore(value: unknown): HarnessDeployUnitMappingStoreFile {
  if (!isObject(value)) return emptyDeployUnitMappingStore()
  return { version: 1, mappings: normalizeDeployUnitMappings(value.mappings) }
}

async function readDeployUnitMappingStore(): Promise<HarnessDeployUnitMappingStoreFile> {
  const parsed = await readHarnessJsonFileBounded(
    HARNESS_DEPLOY_UNIT_MAPPING_FILE,
    HARNESS_DEPLOY_UNIT_MAPPING_MAX_BYTES,
    "Harness deploy unit mapping store"
  )
  return parsed === null ? emptyDeployUnitMappingStore() : normalizeDeployUnitMappingStore(parsed)
}

function normalizeLeanTokenStore(value: unknown): HarnessLeanTokenStoreFile {
  if (!isObject(value)) return emptyLeanTokenStore()
  const leanToken = normalizeText(value.leanToken).trim()
  if (leanToken.length > HARNESS_LEAN_TOKEN_MAX_CHARS) {
    throw new Error(`Lean token 超过 ${HARNESS_LEAN_TOKEN_MAX_CHARS} 字符上限`)
  }
  return { leanToken }
}

async function readLeanTokenStore(): Promise<HarnessLeanTokenStoreFile> {
  const parsed = await readHarnessJsonFileBounded(
    HARNESS_LEAN_TOKEN_FILE,
    HARNESS_LEAN_TOKEN_MAX_BYTES,
    "Harness lean token store"
  )
  return parsed === null ? emptyLeanTokenStore() : normalizeLeanTokenStore(parsed)
}

function featureDeployUnitBindingKey(projectId: string, featureId: string): string {
  return `${projectId}\0${featureId}`
}

function normalizeFeatureDeployUnitBindingStore(
  value: unknown
): HarnessFeatureDeployUnitBindingStoreFile {
  if (!isObject(value)) throw new Error("Harness feature binding store 顶层格式无效")
  if ("bindings" in value && !Array.isArray(value.bindings)) {
    throw new Error("Harness feature binding store bindings 字段格式无效")
  }
  return { version: 1, bindings: normalizeFeatureDeployUnitBindings(value.bindings) }
}

async function readFeatureDeployUnitBindingStore(): Promise<HarnessFeatureDeployUnitBindingStoreFile> {
  const parsed = await readHarnessJsonFileBounded(
    HARNESS_FEATURE_DEPLOY_UNIT_BINDING_FILE,
    HARNESS_FEATURE_BINDING_MAX_BYTES,
    "Harness feature binding store"
  )
  return parsed === null
    ? emptyFeatureDeployUnitBindingStore()
    : normalizeFeatureDeployUnitBindingStore(parsed)
}

async function findFeatureDeployUnitBinding(
  projectId: string,
  featureId: string
): Promise<HarnessFeatureDeployUnitBindingRecord | null> {
  const key = featureDeployUnitBindingKey(projectId, featureId)
  return (
    (await readFeatureDeployUnitBindingStore()).bindings.find(
      (binding) => featureDeployUnitBindingKey(binding.projectId, binding.featureId) === key
    ) ?? null
  )
}

async function saveFeatureDeployUnitBinding(
  projectId: string,
  featureId: string,
  selectedDeployUnitMappings: HarnessDeployUnitMapping[],
  sessionContextInjectionSource: HarnessSessionContextInjectionSource
): Promise<HarnessFeatureDeployUnitBindingRecord> {
  assertFeatureBindingKeyBudgets(projectId, featureId)
  return withHarnessStoreMutation(HARNESS_FEATURE_DEPLOY_UNIT_BINDING_FILE, async () => {
    const store = await readFeatureDeployUnitBindingStore()
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
    if (existingIndex >= 0) store.bindings[existingIndex] = binding
    else {
      if (store.bindings.length >= HARNESS_FEATURE_BINDING_MAX_ENTRIES) {
        throw new Error(`特性发布单元绑定最多支持 ${HARNESS_FEATURE_BINDING_MAX_ENTRIES} 条`)
      }
      store.bindings.unshift(binding)
    }
    await writeHarnessJsonFileAtomic(
      HARNESS_FEATURE_DEPLOY_UNIT_BINDING_FILE,
      store,
      HARNESS_FEATURE_BINDING_MAX_BYTES,
      "Harness feature binding store"
    )
    return binding
  })
}

async function updateFeatureDeployUnitBinding(
  projectId: string,
  featureId: string,
  selectedDeployUnitMappings: HarnessDeployUnitMapping[]
): Promise<HarnessFeatureDeployUnitBindingRecord> {
  assertFeatureBindingKeyBudgets(projectId, featureId)
  return withHarnessStoreMutation(HARNESS_FEATURE_DEPLOY_UNIT_BINDING_FILE, async () => {
    const store = await readFeatureDeployUnitBindingStore()
    const key = featureDeployUnitBindingKey(projectId, featureId)
    const existingIndex = store.bindings.findIndex(
      (binding) => featureDeployUnitBindingKey(binding.projectId, binding.featureId) === key
    )
    if (existingIndex < 0) throw new Error("未找到该特性的发布单元绑定记录")
    const binding: HarnessFeatureDeployUnitBindingRecord = {
      ...store.bindings[existingIndex],
      selectedDeployUnitMappings,
      updatedAt: formatGmt8Timestamp()
    }
    store.bindings[existingIndex] = binding
    await writeHarnessJsonFileAtomic(
      HARNESS_FEATURE_DEPLOY_UNIT_BINDING_FILE,
      store,
      HARNESS_FEATURE_BINDING_MAX_BYTES,
      "Harness feature binding store"
    )
    return binding
  })
}

export async function listHarnessDeployUnitMappings(): Promise<HarnessDeployUnitMapping[]> {
  return (await readDeployUnitMappingStore()).mappings
}

export async function saveHarnessDeployUnitMappings(
  mappings: HarnessDeployUnitMapping[]
): Promise<HarnessDeployUnitMapping[]> {
  if (mappings.length > HARNESS_DEPLOY_UNIT_MAPPING_MAX_ENTRIES) {
    throw new Error(`发布单元最多支持 ${HARNESS_DEPLOY_UNIT_MAPPING_MAX_ENTRIES} 条`)
  }
  const normalized = normalizeDeployUnitMappingsForSave(mappings)
  await withHarnessStoreMutation(HARNESS_DEPLOY_UNIT_MAPPING_FILE, async () => {
    await writeHarnessJsonFileAtomic(
      HARNESS_DEPLOY_UNIT_MAPPING_FILE,
      { version: 1, mappings: normalized },
      HARNESS_DEPLOY_UNIT_MAPPING_MAX_BYTES,
      "Harness deploy unit mapping store"
    )
  })
  return normalized
}

export async function getHarnessLeanTokenConfig(
  options: { scope?: string } = {}
): Promise<HarnessLeanTokenConfig> {
  const result = await readHarnessLeanTokenInWorker(
    options.scope ?? makeHarnessDetailScope("harness-lean-token")
  )
  return { leanToken: result.leanToken }
}

export async function saveHarnessLeanTokenConfig(
  input: HarnessLeanTokenConfig
): Promise<HarnessLeanTokenConfig> {
  const normalized = normalizeLeanTokenStore(input)
  await withHarnessStoreMutation(HARNESS_LEAN_TOKEN_FILE, async () => {
    await writeHarnessJsonFileAtomic(
      HARNESS_LEAN_TOKEN_FILE,
      normalized,
      HARNESS_LEAN_TOKEN_MAX_BYTES,
      "Harness lean token store"
    )
  })
  return normalized
}

async function readProjectContextInWorker(
  projectId: string,
  purpose: string
): Promise<HarnessProjectContextItem | null> {
  const result = await readHarnessProjectContextsInWorker(
    [projectId],
    makeHarnessDetailScope(purpose)
  )
  return result.projects[projectId] ?? null
}

async function requireProject(projectId: string): Promise<HarnessProjectMetadata> {
  const context = await readProjectContextInWorker(projectId, "harness-project-read")
  if (!context) throw new Error("Project not found")
  return context.project
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

async function resolveFeatureSelectedDeployUnits(
  selectedDeployUnits: HarnessDeployUnitMapping[] | undefined,
  options: { allowEmpty?: boolean } = {}
): Promise<HarnessDeployUnitMapping[]> {
  if (!Array.isArray(selectedDeployUnits)) return []

  const selected = normalizeDeployUnitMappings(selectedDeployUnits)
  if (selected.length === 0 && !(options.allowEmpty && selectedDeployUnits.length === 0)) {
    throw new Error("请至少选择一个发布单元")
  }

  const configuredMappings = (await readDeployUnitMappingStore()).mappings
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
    const description = resolvedMapping.description?.trim() || ""
    resolved.push({
      deployUnitIdMapping: resolvedMapping.deployUnitIdMapping,
      deployUnitId,
      localRepoPath,
      ...(description ? { description } : {})
    })
  }

  for (let offset = 0; offset < resolved.length; offset += 16) {
    const batch = resolved.slice(offset, offset + 16)
    const exists = await Promise.all(
      batch.map(async (mapping) => {
        try {
          await access(mapping.localRepoPath)
          return true
        } catch {
          return false
        }
      })
    )
    const missingIndex = exists.findIndex((value) => !value)
    if (missingIndex >= 0) {
      const missing = batch[missingIndex]
      throw new Error(
        `发布单元 ${missing.deployUnitId} 的代码库路径不存在：${missing.localRepoPath}`
      )
    }
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

function resolveProjectKnowledgePath(
  project: HarnessProjectMetadata,
  cwd: string,
  config: Record<string, unknown> | null,
  options: HarnessCommandParseOptions = {}
): string | null {
  const rawPath = readBoardConfigPlatformTextFromValue(config, "knowledge_path")
  if (!rawPath) return null

  const replaced = replaceHarnessConfigPlaceholders(
    rawPath,
    project,
    "pullKnowledge",
    cwd,
    options
  ).trim()
  if (!replaced) return null

  return isAbsolute(replaced) ? resolve(replaced) : resolve(cwd, replaced)
}

interface HarnessProjectConfigContext {
  plugin: PluginMetadata | null
  configSnapshot?: HarnessBoardConfigReadSnapshot
  leanToken: string
}

function buildConfiguredHarnessInvocationFromContext(
  project: HarnessProjectMetadata,
  context: HarnessProjectConfigContext,
  mode: HarnessInspectCommandName,
  options: HarnessCommandParseOptions = {}
): ConfiguredHarnessInvocation {
  const adapter = project["harness-adapter"]
  const compatibility = evaluateBoardPluginCompatibility(
    context.plugin,
    adapter.name || adapter.id,
    context.configSnapshot
  )
  if (!compatibility.compatible || !context.plugin) {
    throw new Error(compatibility.message || compatibility.label)
  }
  const config = context.configSnapshot
  if (!config || config.error) {
    throw config?.error ?? new Error("Harness board config unavailable")
  }
  const configKey = HARNESS_INSPECT_COMMAND_CONFIG_KEYS[mode]
  const command = readBoardConfigPlatformTextFromValue(config.value, configKey)
  if (!command) {
    throw new Error(`插件未配置 inspectCommands.${process.platform}.${configKey}，请检查插件设置`)
  }
  const cwd = context.plugin.path
  return {
    cwd,
    invocation: parseInspectCommand(command, project, mode, cwd, {
      ...options,
      leanToken: context.leanToken
    })
  }
}

function hasConfiguredHarnessInvocationInContext(
  context: HarnessProjectConfigContext,
  mode: HarnessInspectCommandName
): boolean {
  const config = context.configSnapshot
  return Boolean(
    context.plugin &&
      config &&
      !config.error &&
      readBoardConfigPlatformTextFromValue(
        config.value,
        HARNESS_INSPECT_COMMAND_CONFIG_KEYS[mode]
      )
  )
}

async function runInspectAdapterBufferFromContext(
  project: HarnessProjectMetadata,
  context: HarnessProjectConfigContext,
  mode: "run",
  feature: string,
  signal?: AbortSignal
): Promise<{ buffer: Buffer; configured: ConfiguredHarnessInvocation }> {
  const configured = buildConfiguredHarnessInvocationFromContext(project, context, mode, {
    feature
  })
  const buffer = await runHarnessInvocationAsync(
    configured,
    harnessCommandLogOptions(mode),
    HARNESS_ADAPTER_TIMEOUT_MS,
    signal
  )
  return { buffer, configured }
}

function projectConfigContextFromWorker(
  item: HarnessProjectContextItem
): HarnessProjectConfigContext {
  const snapshot: HarnessProjectContextConfigSnapshot | null = item.configSnapshot
  return {
    plugin: item.plugin,
    leanToken: item.leanToken ?? "",
    ...(snapshot
      ? {
          configSnapshot: {
            value: snapshot.value,
            error: snapshot.error ? new Error(snapshot.error) : null
          }
        }
      : {})
  }
}

function resolveSystemConstraintUpdateConfig(
  project: HarnessProjectMetadata,
  context?: HarnessProjectConfigContext
): HarnessProjectDetailViewModel["systemConstraintUpdate"] | undefined {
  try {
    if (!context?.plugin || context.configSnapshot?.error) return undefined
    const cwd = context.plugin.path
    const config = context.configSnapshot?.value ?? null
    const knowledgeConfig = config?.knowledge_config
    if (!isObject(knowledgeConfig)) return undefined

    const syncType = normalizeText(knowledgeConfig.sync_type).trim()
    if (syncType !== "invoke_session") return undefined

    const nextAction =
      resolveHarnessNextActionTemplate(
        knowledgeConfig.nextAction,
        project,
        "pullKnowledge",
        cwd,
        {
          preserveMissingPlaceholders: true,
          leanToken: context.leanToken
        },
        { replaceUserMessagePlaceholders: true }
      ) ?? {}

    const knowledgePath = resolveProjectKnowledgePath(project, cwd, config, {
      leanToken: context.leanToken
    })
    return {
      syncType: "invoke_session",
      nextAction,
      ...(knowledgePath ? { knowledgePath } : {})
    }
  } catch (error) {
    console.warn("[HarnessBoard] Failed to resolve system constraint update config:", {
      projectId: project.projectId,
      error
    })
    return undefined
  }
}

function makeProjectDetailViewModel(
  project: HarnessProjectMetadata,
  data: {
    workflow: HarnessWorkflow
    runs: HarnessFeatureSummary[]
    watchRefs: HarnessWatchRef[]
    projectState: HarnessStatus
    error: string | null
  },
  context?: HarnessProjectConfigContext
): HarnessProjectDetailViewModel {
  const systemConstraintUpdate = resolveSystemConstraintUpdateConfig(project, context)

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
    ...(systemConstraintUpdate ? { systemConstraintUpdate } : {}),
    watchRefs: data.watchRefs,
    loading: false,
    error: data.error
  }
}

async function initializeHarnessProject(project: HarnessProjectMetadata): Promise<void> {
  try {
    const projectPath = projectDirectoryPath(project)
    try {
      await access(projectPath)
      throw new Error(`项目目录已存在：${projectPath}`)
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("项目目录已存在")) throw error
    }

    const configured = await buildConfiguredHarnessInvocation(project, "createProject")

    await mkdir(projectPath, { recursive: true })
    await runHarnessInvocationAsync(
      configured,
      harnessCommandLogOptions("createProject"),
      HARNESS_ADAPTER_TIMEOUT_MS
    )
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
  agentConfig?: HarnessAgentConfig
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
  /** Resolve tool policy from the plugin while a project feature session is created. */
  requestUserInputConfigSource?: "plugin" | "session_snapshot"
}

function isHarnessSessionContextOk(value: unknown): boolean {
  return value === true
}

export type HarnessRuntimeAgentMode = "solo" | "multi" | "agent_team"

export interface HarnessAgentConfig {
  agentMode?: HarnessRuntimeAgentMode
  subagentConfig?: HarnessProjectModeSubagentConfig
  toolConfig?: {
    requestUserInput?: HarnessRequestUserInputConfig
  }
}

export const DEFAULT_HARNESS_REQUEST_USER_INPUT_CONFIG: HarnessRequestUserInputConfig = {
  allowAutoResolution: false,
  autoResolutionType: "select_first"
}

const REQUEST_USER_INPUT_TIMEOUT_MIN_MS = 30_000
const REQUEST_USER_INPUT_TIMEOUT_MAX_MS = 240_000
const REQUEST_USER_INPUT_TIMEOUT_MESSAGE_MAX_CHARS = 1_000

function normalizeHarnessRequestUserInputConfig(
  value: unknown
): HarnessRequestUserInputConfig | undefined {
  if (!isObject(value)) return undefined

  if (value.allowAutoResolution !== true) {
    return { ...DEFAULT_HARNESS_REQUEST_USER_INPUT_CONFIG }
  }

  const defaultTimeoutMs =
    typeof value.defaultTimeoutMs === "number" &&
    Number.isInteger(value.defaultTimeoutMs) &&
    value.defaultTimeoutMs >= REQUEST_USER_INPUT_TIMEOUT_MIN_MS &&
    value.defaultTimeoutMs <= REQUEST_USER_INPUT_TIMEOUT_MAX_MS
      ? value.defaultTimeoutMs
      : undefined
  const userMessage = normalizeText(value.userMessage).trim()
  const autoResolutionType = value.autoResolutionType === "user_message" && userMessage
    ? "user_message"
    : "select_first"

  return {
    allowAutoResolution: true,
    ...(defaultTimeoutMs !== undefined ? { defaultTimeoutMs } : {}),
    autoResolutionType,
    ...(autoResolutionType === "user_message"
      ? { userMessage: userMessage.slice(0, REQUEST_USER_INPUT_TIMEOUT_MESSAGE_MAX_CHARS) }
      : {})
  }
}

function resolveHarnessRequestUserInputConfig(value: unknown): HarnessRequestUserInputConfig {
  const normalized = normalizeHarnessRequestUserInputConfig(value)
  return normalized ?? { ...DEFAULT_HARNESS_REQUEST_USER_INPUT_CONFIG }
}

function normalizeHarnessAgentConfig(value: unknown): HarnessAgentConfig | undefined {
  if (!isObject(value)) return undefined

  const agentMode =
    value.agentMode === "solo" ||
    value.agentMode === "multi" ||
    value.agentMode === "agent_team"
      ? value.agentMode
      : undefined
  const normalizeStringList = (input: unknown): string[] => {
    if (!Array.isArray(input)) return []
    return [
      ...new Set(
        input
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.trim())
          .filter(Boolean)
      )
    ]
  }
  const subagentConfig = isObject(value.subagentConfig)
    ? {
        disabledBuiltinSubagents: normalizeStringList(
          value.subagentConfig.disabledBuiltinSubagents
        ),
        customSubagentFiles: normalizeStringList(value.subagentConfig.customSubagentFiles)
      }
    : undefined

  const requestUserInputConfig = isObject(value.toolConfig)
    ? normalizeHarnessRequestUserInputConfig(value.toolConfig.requestUserInput)
    : undefined

  if (!agentMode && !subagentConfig && !requestUserInputConfig) return undefined
  return {
    ...(agentMode ? { agentMode } : {}),
    ...(subagentConfig ? { subagentConfig } : {}),
    ...(requestUserInputConfig
      ? { toolConfig: { requestUserInput: requestUserInputConfig } }
      : {})
  }
}

interface HarnessSessionContextInjectResult {
  prompt?: string
  warning?: string
  agentmdLoadStatus?: HarnessAgentmdLoadStatusItem[]
  agentConfig?: HarnessAgentConfig
}

function formatSessionContextInjectWarning(detail: string): string {
  return detail
    ? `插件 AGENTS.md 注入失败：${detail}，已回退到 CMBDevClaw AGENTS.md`
    : "插件 AGENTS.md 注入失败，已回退到 CMBDevClaw AGENTS.md"
}

async function readHarnessFeatureSessionContextAgentPrompt(
  project: HarnessProjectMetadata,
  featureId: string,
  context: HarnessProjectConfigContext,
  options: {
    sessionWorkspacePath?: string
    selectedDeployUnits?: HarnessDeployUnitMapping[]
  } = {}
): Promise<HarnessSessionContextInjectResult> {
  if (!hasConfiguredHarnessInvocationInContext(context, "sessionContext")) {
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
    const configured = buildConfiguredHarnessInvocationFromContext(
      project,
      context,
      "sessionContext",
      {
      feature: featureId,
      ...(await getHarnessSelectedDeployUnitsCommandOptions(
        project,
        featureId,
        options.selectedDeployUnits
      )),
      sessionWorkspacePath: options.sessionWorkspacePath
      }
    )
    const result = await runHarnessJsonInvocation(configured, "sessionContext")
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
    const agentConfig = normalizeHarnessAgentConfig(result.agentConfig)
    if (!sessionContext) {
      return {
        agentmdLoadStatus,
        ...(agentConfig ? { agentConfig } : {})
      }
    }
    if (sessionContext.length > HARNESS_SESSION_CONTEXT_MAX_CHARS) {
      console.warn("[HarnessBoard] session_context_inject sessionContext truncated:", {
        chars: sessionContext.length,
        maxChars: HARNESS_SESSION_CONTEXT_MAX_CHARS
      })
      return {
        prompt: sessionContext.slice(0, HARNESS_SESSION_CONTEXT_MAX_CHARS),
        agentmdLoadStatus,
        ...(agentConfig ? { agentConfig } : {})
      }
    }
    return {
      prompt: sessionContext,
      agentmdLoadStatus,
      ...(agentConfig ? { agentConfig } : {})
    }
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

export async function buildHarnessFeatureAgentContext(
  metadata: unknown,
  options: HarnessFeatureAgentContextOptions = {}
): Promise<HarnessFeatureAgentContext | null> {
  const feature = readHarnessFeatureMetadata(metadata)
  if (!feature) return null

  const scope = makeHarnessDetailScope("harness-feature-agent-context")
  const contexts = await readHarnessProjectContextsInWorker(
    [feature.projectId],
    `${scope}:context`,
    { featureSlug: feature.slug }
  )
  const workerContext = contexts.projects[feature.projectId]
  if (!workerContext) throw new Error("Project not found")
  const project = workerContext.project
  const context = projectConfigContextFromWorker(workerContext)
  const plugin = context.plugin
  if (!plugin || !context.configSnapshot || context.configSnapshot.error) {
    throw context.configSnapshot?.error ?? new Error("Harness board config unavailable")
  }
  const cwd = plugin.path
  const adapter = project["harness-adapter"]
  // 与事件侧一致：用 adapter 快照（可经 plugin 解析）作为暴露给 hook 的 adapter 名/版本，
  // 保证外部按此上报后落进与原生事件相同的 harnessAdapterName/Version 聚合桶。
  const adapterSnapshot = pluginToHarnessAdapterSnapshot(plugin, context.configSnapshot)
  const staticSystemPromptInject = readBoardConfigPlatformTextFromValue(
    context.configSnapshot.value,
    "system_prompt_inject"
  )
  const pluginOutputDir = readBoardConfigPlatformTextFromValue(
    context.configSnapshot.value,
    "plugin_dir_hook"
  )
  const systemId = normalizeText(project.systemId).trim()
  const sessionContextInjectionSource =
    workerContext.sessionContextInjectionSource ?? "cmbdevclaw"
  const usePluginAgentsPrompt = sessionContextInjectionSource === "plugin"
  const sessionWorkspacePath = normalizeText(options.workspacePath).trim() || project.workspacePath
  const render = (
    template: string | null,
    command: HarnessInspectCommandName
  ): string | undefined =>
    template
      ? replaceHarnessConfigPlaceholders(template, project, command, cwd, {
          feature: feature.slug,
          sessionWorkspacePath,
          leanToken: context.leanToken
        }).trim() || undefined
      : undefined
  const renderedStaticPrompt = render(staticSystemPromptInject, "run")
  const sessionContextInjectResult = usePluginAgentsPrompt
    ? await readHarnessFeatureSessionContextAgentPrompt(project, feature.slug, context, {
        sessionWorkspacePath,
        selectedDeployUnits: workerContext.selectedDeployUnits
      })
    : undefined
  const pluginAgentConfig = sessionContextInjectResult?.agentConfig
  const persistedToolConfig = isObject(metadata) && isObject(metadata.harnessFeature)
    ? metadata.harnessFeature.requestUserInputConfig
    : undefined
  const requestUserInputConfig =
    options.requestUserInputConfigSource === "plugin"
      ? resolveHarnessRequestUserInputConfig(pluginAgentConfig?.toolConfig?.requestUserInput)
      : resolveHarnessRequestUserInputConfig(persistedToolConfig)
  const agentConfig: HarnessAgentConfig = {
    ...(pluginAgentConfig ?? {}),
    toolConfig: { requestUserInput: requestUserInputConfig }
  }
  const harnessAgentsPrompt = sessionContextInjectResult?.prompt
  const pluginPromptLoaded = Boolean(harnessAgentsPrompt?.trim())
  const additionalWorkspaceRootMappings = await resolveHarnessAdditionalWorkspaceRootMappings(
    project.projectId,
    feature.slug,
    workerContext.selectedDeployUnits
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
    ...(agentConfig ? { agentConfig } : {}),
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
    pluginId: normalizeText(plugin.id) || adapter.id,
    pluginName: normalizeText(plugin.name) || adapter.name,
    pluginWorkspace: project.workspacePath,
    featureId: feature.slug,
    harnessProjectId: feature.projectId,
    harnessAdapterName: normalizeText(adapterSnapshot.name).trim() || undefined,
    harnessAdapterVersion: normalizeText(adapterSnapshot.version).trim() || undefined,
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
export async function resolveHarnessFeatureCurrentStage(
  projectId: string,
  slug: string
): Promise<{ name: string; status: string | null } | null> {
  try {
    const normalizedProjectId = normalizeText(projectId).trim()
    const normalizedSlug = normalizeText(slug).trim()
    if (!normalizedProjectId || !normalizedSlug) return null
    const project = await requireProject(normalizedProjectId)
    const snapshot = await runInspectAdapter(project, "run", normalizedSlug)
    return resolveCurrentStageFromSnapshot(snapshot)
  } catch {
    return null
  }
}

function resolveCurrentStageFromSnapshot(
  snapshot: Record<string, unknown>
): { name: string; status: string | null } | null {
  const run = isObject(snapshot.run) ? snapshot.run : {}
  const currentNodeId = normalizeText(run.currentNodeId).trim()
  if (!currentNodeId) return null
  const workflow = normalizeWorkflow(snapshot.workflow)
  const runNode = Array.isArray(run.nodes)
    ? run.nodes.find(
        (n): n is Record<string, unknown> =>
          isObject(n) && normalizeText(n.id).trim() === currentNodeId
      )
    : undefined
  return resolveCurrentStageFromWorkflow(
    workflow,
    currentNodeId,
    runNode?.nodeStatus ?? run.currentNodeStatus
  )
}

function resolveCurrentStageFromWorkflow(
  workflow: HarnessWorkflow,
  currentNodeId: string,
  rawStatus: unknown
): { name: string; status: string | null } | null {
  const node = workflow.nodes.find((item) => item.id === currentNodeId)
  const label = normalizeText(node?.label).trim()
  if (!label) return null
  const group = normalizeText(node?.group).trim()
  const name = group ? `${group}-${label}` : label
  const nodeStatus = normalizeNodeStatus(rawStatus)
  const status =
    nodeStatus === UNKNOWN_NODE_STATUS ? null : DEFAULT_NODE_STATUS_LABELS[nodeStatus]

  return { name, status }
}

/** Reuse a Feature-page run refresh as an authoritative attribution snapshot. */
export function resolveHarnessRunDetailCurrentStage(
  detail: HarnessRunDetailViewModel
): { name: string; status: string | null } | null {
  const currentNodeId = normalizeText(detail.run.currentNodeId).trim()
  if (!currentNodeId) return null
  const currentNode = detail.run.nodes.find((node) => node.id === currentNodeId)
  return resolveCurrentStageFromWorkflow(detail.workflow, currentNodeId, currentNode?.nodeStatus)
}

export async function buildHarnessFeatureDialogTips(
  projectId: string,
  slug: string,
  options: { scope?: string } = {}
): Promise<string | null> {
  const normalizedProjectId = typeof projectId === "string" ? projectId.slice(0, 512).trim() : ""
  const feature = typeof slug === "string" ? slug.slice(0, 2_048).trim() : ""
  if (!normalizedProjectId || !feature) return null
  const result = await readHarnessDialogTipsInWorker(
    normalizedProjectId,
    feature,
    options.scope ?? "harness-dialog-tips:default"
  )
  return result.tips
}

export async function listHarnessProjects(): Promise<HarnessProjectListItem[]> {
  const scope = makeHarnessDetailScope("harness-project-list")
  const projects: HarnessProjectListItem[] = []
  let cursor: number | undefined
  for (let page = 0; page < 32; page += 1) {
    const result = await readHarnessCatalogPageInWorker(
      {
        includeRegistry: false,
        projectLimit: 64,
        ...(cursor === undefined ? {} : { projectCursor: cursor })
      },
      scope
    )
    projects.push(...result.projects)
    if (result.projectNextCursor === null) return projects
    cursor = result.projectNextCursor
  }
  throw new Error("Harness project list exceeded the configured page budget")
}

export async function getHarnessProjectPublicAgentmdDeployUnits(
  projectId: string
): Promise<string[]> {
  const context = await readProjectContextInWorker(projectId, "harness-public-agentmd")
  if (!context) throw new Error("Project not found")
  const configContext = projectConfigContextFromWorker(context)
  if (!configContext.plugin || configContext.configSnapshot?.error) return []
  const boardCompatibility = evaluateBoardPluginCompatibility(
    configContext.plugin,
    context.project["harness-adapter"].name || context.project["harness-adapter"].id,
    configContext.configSnapshot
  )
  if (!boardCompatibility.compatible) return []
  return uniqueStringsInOrder(configContext.configSnapshot?.value?.supported_deploy_units)
}

export async function getHarnessLocalAgentmdDeployUnitMappings(
  mappings: HarnessDeployUnitMapping[]
): Promise<string[]> {
  const normalized = normalizeDeployUnitMappings(mappings).filter((mapping) =>
    isAbsolute(mapping.localRepoPath.trim())
  )
  const present: string[] = []
  for (let offset = 0; offset < normalized.length; offset += 16) {
    const batch = normalized.slice(offset, offset + 16)
    const results = await Promise.all(
      batch.map(async (mapping) => {
        try {
          await access(join(mapping.localRepoPath.trim(), "AGENTS.md"))
          return mapping.deployUnitIdMapping
        } catch {
          return null
        }
      })
    )
    present.push(...results.filter((value): value is string => value !== null))
  }
  return present
}

/**
 * Returns the harness adapter (plugin) bound to a project, including its version.
 * Prefers the currently-installed plugin's version; falls back to the version
 * stored in project metadata when the plugin can't be resolved (e.g. uninstalled).
 * Returns null when the project does not exist.
 */
export async function getHarnessProjectAdapterSnapshot(
  projectId: string
): Promise<HarnessAdapterSnapshot | null> {
  const context = await readProjectContextInWorker(projectId, "harness-adapter-snapshot")
  if (!context) return null
  const project = context.project
  const stored = project["harness-adapter"]
  if (context.plugin) {
    return {
      id: context.plugin.id,
      name: context.plugin.name,
      version: context.plugin.version,
      type: "plugin"
    }
  }
  return {
    id: normalizeText(stored.id),
    name: normalizeText(stored.name),
    version: normalizeText(stored.version),
    type: stored.type
  }
}

export async function createHarnessProject(
  input: HarnessProjectCreateInput
): Promise<HarnessProjectMetadata> {
  validateCreateInput(input)
  const store = await readProjectStore()
  validateProjectCodeUnique(input.projectCode, store)
  validateProjectDirUnique(input.projectDir, input.workspacePath, store)
  const harnessAdapter = await resolveHarnessAdapter(input.adapterId, input.adapterType)
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
  normalizeProject(project)

  await initializeHarnessProject(project)
  await mutateProjectStore((latest) => {
    validateProjectCodeUnique(input.projectCode, latest)
    validateProjectDirUnique(input.projectDir, input.workspacePath, latest)
    latest.projects.unshift(project)
  })
  return project
}

export async function createHarnessFeature(
  input: HarnessFeatureCreateInput
): Promise<HarnessFeatureCreateResult> {
  validateFeatureCreateInput(input)
  const project = await requireProject(input.projectId)
  const feature = input.feature.trim()
  const workspacePath = projectDirectoryPath(project)
  const workflowOptions = buildFeatureWorkflowCommandOptions(input)
  const selectedDeployUnits = await resolveFeatureSelectedDeployUnits(input.selectedDeployUnits)
  const sessionContextInjectionSource = normalizeSessionContextInjectionSource(
    input.sessionContextInjectionSource
  )

  try {
    await access(workspacePath)
  } catch {
    throw new Error(projectDirectoryMissingMessage(project))
  }
  const selectedDeployUnitsOptions = await getHarnessSelectedDeployUnitsCommandOptions(
    project,
    feature,
    selectedDeployUnits
  )

  try {
    const configured = await buildConfiguredHarnessInvocation(project, "createFeature", {
      feature,
      ...workflowOptions,
      ...selectedDeployUnitsOptions
    })
    await runHarnessInvocationAsync(
      configured,
      harnessCommandLogOptions("createFeature"),
      HARNESS_ADAPTER_TIMEOUT_MS
    )
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error)
    if (raw.includes("已存在")) {
      throw new Error("该特性在当前项目路径下已存在")
    }
    throw new Error(`创建特性失败：${raw}`)
  }

  await saveFeatureDeployUnitBinding(
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

export async function updateHarnessFeatureDeployUnits(
  input: HarnessFeatureDeployUnitUpdateInput
): Promise<HarnessFeatureDeployUnitBinding> {
  const projectId = normalizeText(input.projectId).trim()
  const featureId = normalizeText(input.featureId).trim()
  if (!projectId || !featureId) {
    throw new Error("Project and feature are required")
  }
  validateHarnessName(featureId, "特性名称")
  await requireProject(projectId)

  const selectedDeployUnits = await resolveFeatureSelectedDeployUnits(input.selectedDeployUnits, {
    allowEmpty: true
  })
  return updateFeatureDeployUnitBinding(projectId, featureId, selectedDeployUnits)
}

export async function skipHarnessRunNode(
  input: HarnessSkipNodeInput
): Promise<HarnessSkipNodeResult> {
  const { projectId, slug, nodeId } = validateSkipNodeInput(input)
  const project = await requireProject(projectId)
  const workspacePath = projectDirectoryPath(project)

  try {
    await access(workspacePath)
  } catch {
    throw new Error(projectDirectoryMissingMessage(project))
  }

  try {
    const configured = await buildConfiguredHarnessInvocation(project, "skipNode", {
      feature: slug,
      nodeId
    })
    const logOptions = { ...harnessCommandLogOptions("skipNode"), successResult: "none" as const }
    const stdoutBuffer = await runHarnessInvocationAsync(
      configured,
      logOptions,
      HARNESS_ADAPTER_TIMEOUT_MS
    )
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

export async function getHarnessDynamicWorkflowConfig(
  projectId: string
): Promise<HarnessDynamicWorkflowConfig | null> {
  const project = await requireProject(projectId)
  return getHarnessDynamicWorkflowConfigForProject(project)
}

/**
 * Persist the first observed feature-session run whose complete system-constraint
 * set loaded successfully. The marker is monotonic and deliberately does not
 * touch lifecycle.updateAt, so telemetry does not reorder the project list.
 * Returns true only when the project was changed for the first time.
 */
export async function markHarnessProjectSystemConstraintsLoaded(
  projectId: string,
  loadedAt = new Date().toISOString()
): Promise<boolean> {
  const id = normalizeText(projectId).trim()
  if (!id) return false

  return mutateProjectStore((store) => {
    const index = store.projects.findIndex((item) => item.projectId === id)
    if (index === -1 || store.projects[index].systemConstraintFirstLoadedAt) return false
    const parsedLoadedAt = new Date(loadedAt)
    const firstLoadedAt = Number.isNaN(parsedLoadedAt.getTime())
      ? new Date().toISOString()
      : parsedLoadedAt.toISOString()
    store.projects[index] = {
      ...store.projects[index],
      systemConstraintFirstLoadedAt: firstLoadedAt
    }
    return true
  })
}

export async function updateHarnessProjectMetadata(
  projectId: string,
  input: HarnessProjectMetadataUpdateInput
): Promise<HarnessProjectMetadata> {
  validateProjectMetadataInput(input)
  return mutateProjectStore(async (store) => {
    const index = store.projects.findIndex((item) => item.projectId === projectId)
    if (index === -1) throw new Error("Project not found")
    validateProjectCodeUnique(input.projectCode, store, projectId)
    const existing = store.projects[index]
    const existingAdapter = existing["harness-adapter"]
    const harnessAdapter =
      existingAdapter.type === input.adapterType && existingAdapter.id === input.adapterId.trim()
        ? await resolveHarnessAdapterSnapshot(existingAdapter)
        : await resolveHarnessAdapter(input.adapterId, input.adapterType)
    if (input.workspacePath.trim() !== existing.workspacePath.trim()) {
      throw new Error("项目工作区路径不允许修改")
    }
    const existingProjectDir = projectDirectoryName(existing)
    if (input.projectDir.trim() !== existingProjectDir) {
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
      lifecycle: { ...existing.lifecycle, updateAt: new Date().toISOString() }
    }
    store.projects[index] = updated
    return updated
  })
}

export async function archiveHarnessProject(projectId: string): Promise<HarnessProjectMetadata> {
  return mutateProjectStore((store) => {
    const index = store.projects.findIndex((item) => item.projectId === projectId)
    if (index === -1) throw new Error("Project not found")
    const archived: HarnessProjectMetadata = {
      ...store.projects[index],
      lifecycle: {
        ...store.projects[index].lifecycle,
        status: "archived",
        updateAt: new Date().toISOString()
      }
    }
    store.projects[index] = archived
    return archived
  })
}

export async function deleteHarnessProject(projectId: string): Promise<HarnessProjectMetadata> {
  return mutateProjectStore((store) => {
    const index = store.projects.findIndex((item) => item.projectId === projectId)
    if (index === -1) throw new Error("Project not found")
    const [deleted] = store.projects.splice(index, 1)
    return deleted
  })
}

async function findCompatibleKnowledgePlugin(adapterId: string): Promise<{
  plugin: PluginMetadata
  adapter: HarnessAdapterRegistryItem
}> {
  const normalizedAdapterId = normalizeText(adapterId).trim()
  const plugin = getPlugins().find((item) => pluginMatchesAdapterId(item, normalizedAdapterId))
  if (!plugin) {
    throw new Error("插件未安装或不支持项目模式")
  }

  const config = await readBoardConfig(plugin.path)
  if (!config) throw new Error("插件未安装或不支持项目模式")
  const adapter = pluginToHarnessAdapter(plugin, { value: config, error: null })
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

export async function syncHarnessProjectConstraints(
  adapterId: string
): Promise<HarnessProjectConstraintSyncResult> {
  const { plugin, adapter } = await findCompatibleKnowledgePlugin(adapterId)
  const configuredCommand = await readBoardConfigInspectCommand(plugin.path, "pullKnowledge")
  if (!configuredCommand) {
    throw new Error(`插件未配置 inspectCommands.${process.platform}.pull_knowledge，请检查插件设置`)
  }

  const commandProject = createKnowledgeCommandProject(plugin, adapter)
  const configured: ConfiguredHarnessInvocation = {
    cwd: plugin.path,
    invocation: parseInspectCommand(configuredCommand, commandProject, "pullKnowledge", plugin.path, {
      leanToken: (await readLeanTokenStore()).leanToken
    })
  }

  const stdoutBuffer = await runHarnessInvocationAsync(
    configured,
    harnessCommandLogOptions("pullKnowledge", adapter.name),
    HARNESS_PULL_KNOWLEDGE_TIMEOUT_MS
  )
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

export async function getHarnessProjectDetail(
  projectId: string,
  options: { scope?: string; maxResponseBytes?: number } = {}
): Promise<HarnessProjectDetailViewModel> {
  return (await getHarnessProjectDetails([projectId], options))[projectId]
}

async function runInspectAdapterBatch(
  projects: HarnessProjectMetadata[],
  mode: "project",
  cwd: string,
  configSnapshot?: HarnessBoardConfigReadSnapshot,
  leanToken = "",
  adapterScope?: string,
  signal?: AbortSignal
): Promise<HarnessAdapterDetailBatchResult> {
  const firstProject = projects[0]
  const configuredCommand = configSnapshot
    ? readBoardConfigPlatformTextFromValue(
        configSnapshot.error ? null : configSnapshot.value,
        HARNESS_INSPECT_COMMAND_CONFIG_KEYS[mode]
      )
    : await readBoardConfigInspectCommand(cwd, mode)
  if (!configuredCommand) {
    const configKey = HARNESS_INSPECT_COMMAND_CONFIG_KEYS[mode]
    throw new Error(`插件未配置 inspectCommands.${process.platform}.${configKey}，请检查插件设置`)
  }

  const projectDirs = projects.map((project) => projectDirectoryName(project))
  const { executable, args } = parseInspectCommand(configuredCommand, firstProject, mode, cwd, {
    projectDirs,
    leanToken
  })

  const configured: ConfiguredHarnessInvocation = {
    cwd,
    invocation: {
      executable,
      args
    }
  }
  const configKey = HARNESS_INSPECT_COMMAND_CONFIG_KEYS[mode]
  const stdoutBuffer = await runHarnessInvocationAsync(
    configured,
    harnessCommandLogOptions(mode, `${projects.length} project(s)`),
    HARNESS_ADAPTER_TIMEOUT_MS,
    signal
  )

  try {
    return await parseHarnessAdapterDetailBatchInWorker(
      stdoutBuffer,
      projects.map((project) => ({
        project,
        projectDir: projectDirectoryName(project),
        fallbackWatchRefs: makeWatchRefs()
      })),
      adapterScope
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[HarnessBoard] [${configKey}] Failed after command completed: ${message}`)
    console.error(
      `[HarnessBoard] [${configKey}] Command: ${formatHarnessCommand(configured.invocation)}`
    )
    console.error(`[HarnessBoard] [${configKey}] CWD: ${configured.cwd}`)
    if (error instanceof HarnessAdapterDetailWorkerResultError && error.preview) {
      console.error(`[HarnessBoard] [${configKey}] Result preview:\n${error.preview}`)
    }
    throw error
  }
}

function makeProjectErrorDetail(
  project: HarnessProjectMetadata,
  label: string,
  error: string,
  context?: HarnessProjectConfigContext
): HarnessProjectDetailViewModel {
  return makeProjectDetailViewModel(project, {
    workflow: normalizeWorkflow(null),
    runs: [],
    watchRefs: makeWatchRefs(),
    projectState: { label, uiKind: "warning" },
    error
  }, context)
}

function makeArchivedProjectDetail(
  project: HarnessProjectMetadata,
  context?: HarnessProjectConfigContext
): HarnessProjectDetailViewModel {
  return makeProjectDetailViewModel(project, {
    workflow: normalizeWorkflow(null),
    runs: [],
    watchRefs: [],
    projectState: { label: "已归档", uiKind: "archived" },
    error: null
  }, context)
}

function projectAdapterLoadedStatus(project: HarnessProjectMetadata): HarnessStatus {
  const adapterName = normalizeText(project["harness-adapter"].name) || "插件"
  return okStatus("inspected", `${adapterName} 已加载`)
}

export async function getHarnessProjectDetails(
  projectIds: string[],
  options: { scope?: string; maxResponseBytes?: number } = {}
): Promise<Record<string, HarnessProjectDetailViewModel>> {
  const scope = options.scope ?? makeHarnessDetailScope("harness-project-details")
  const request = beginHarnessDetailRequest(scope)
  try {
    return await loadHarnessProjectDetails(
      projectIds,
      scope,
      request.signal,
      options.maxResponseBytes
    )
  } finally {
    request.finish()
  }
}

async function loadHarnessProjectDetails(
  projectIds: string[],
  scope: string,
  signal: AbortSignal,
  maxResponseBytes?: number
): Promise<Record<string, HarnessProjectDetailViewModel>> {
  if (projectIds.length === 0) return {}

  const contextById: Record<string, HarnessProjectContextItem | null> = {}
  for (
    let offset = 0;
    offset < projectIds.length;
    offset += HARNESS_PROJECT_CONTEXT_MAX_PROJECTS
  ) {
    const contextResult = await readHarnessProjectContextsInWorker(
      projectIds.slice(offset, offset + HARNESS_PROJECT_CONTEXT_MAX_PROJECTS),
      `${scope}:context`
    )
    Object.assign(contextById, contextResult.projects)
    throwIfHarnessDetailCancelled(signal)
  }
  const projects = projectIds.map((id) => {
    const context = contextById[id]
    if (!context) throw new Error("Project not found")
    return context.project
  })
  const result: Record<string, HarnessProjectDetailViewModel> = {}
  const configContextByProjectId = new Map<string, HarnessProjectConfigContext>()
  const projectDirectoryExistsById = new Map<string, boolean>()
  const groups = new Map<
    string,
    {
      cwd: string
      projects: HarnessProjectMetadata[]
      configSnapshot?: HarnessBoardConfigReadSnapshot
      leanToken: string
    }
  >()

  for (const project of projects) {
    throwIfHarnessDetailCancelled(signal)
    const workerContext = contextById[project.projectId]
    if (!workerContext) throw new Error("Project not found")
    const configContext = projectConfigContextFromWorker(workerContext)
    const { plugin, configSnapshot } = configContext
    configContextByProjectId.set(project.projectId, configContext)
    projectDirectoryExistsById.set(
      project.projectId,
      workerContext.projectDirectoryExists
    )
    if (project.lifecycle.status === "archived") {
      result[project.projectId] = makeArchivedProjectDetail(project, configContext)
      continue
    }

    const adapter = project["harness-adapter"]
    const compatibility = evaluateBoardPluginCompatibility(
      plugin,
      adapter.name || adapter.id,
      configSnapshot
    )
    if (!compatibility.compatible) {
      result[project.projectId] = makeProjectErrorDetail(
        project,
        compatibility.label,
        compatibility.message || "项目使用的插件与当前 APP 不兼容。",
        configContext
      )
      continue
    }
    if (!plugin) continue

    if (!projectDirectoryExistsById.get(project.projectId)) {
      result[project.projectId] = makeProjectErrorDetail(
        project,
        "项目目录不存在",
        projectDirectoryMissingMessage(project),
        configContext
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
        projects: [project],
        configSnapshot,
        leanToken: configContext.leanToken
      })
    }
  }

  for (const group of groups.values()) {
    throwIfHarnessDetailCancelled(signal)
    for (
      let offset = 0;
      offset < group.projects.length;
      offset += HARNESS_ADAPTER_DETAIL_MAX_PROJECTS_PER_BATCH
    ) {
      const batch = group.projects.slice(
        offset,
        offset + HARNESS_ADAPTER_DETAIL_MAX_PROJECTS_PER_BATCH
      )
      try {
        const snapshot = await runInspectAdapterBatch(
          batch,
          "project",
          group.cwd,
          group.configSnapshot,
          group.leanToken,
          `${scope}:adapter`,
          signal
        )
        throwIfHarnessDetailCancelled(signal)
        const workflow = snapshot.workflow

        for (const project of batch) {
          const projectDir = projectDirectoryName(project)
          const projectData = snapshot.projects[projectDir]
          if (!projectData) {
            result[project.projectId] = makeProjectErrorDetail(
              project,
              "Inspect 读取失败",
              `读取项目状态失败：Inspect adapter 未返回项目文件夹 ${projectDir} 的状态`,
              configContextByProjectId.get(project.projectId)
            )
            continue
          }

          result[project.projectId] = makeProjectDetailViewModel(project, {
            workflow,
            runs: projectData.runs,
            watchRefs: projectData.watchRefs,
            projectState: projectAdapterLoadedStatus(project),
            error: null
          }, configContextByProjectId.get(project.projectId))
        }
      } catch (error) {
        if (signal.aborted) throw harnessDetailCancelledError()
        for (const project of batch) {
          result[project.projectId] = makeProjectErrorDetail(
            project,
            "Inspect 读取失败",
            formatProjectDetailError(project, error),
            configContextByProjectId.get(project.projectId)
          )
        }
      }
    }
  }

  const responseBytes = maxResponseBytes === undefined ? 0 : serialize(result).byteLength
  if (maxResponseBytes !== undefined && responseBytes > maxResponseBytes) {
    throw new Error(
      `Harness project details exceeded IPC limit (${maxResponseBytes} bytes)`
    )
  }
  return result
}

export async function getHarnessRunDetail(
  projectId: string,
  slug: string,
  options: { scope?: string } = {}
): Promise<HarnessRunDetailViewModel> {
  const scope = options.scope ?? makeHarnessDetailScope("harness-run-detail")
  const request = beginHarnessDetailRequest(scope)
  try {
    return await loadHarnessRunDetail(projectId, slug, scope, request.signal)
  } finally {
    request.finish()
  }
}

async function loadHarnessRunDetail(
  projectId: string,
  slug: string,
  scope: string,
  signal: AbortSignal
): Promise<HarnessRunDetailViewModel> {
  const contexts = await readHarnessProjectContextsInWorker(
    [projectId],
    `${scope}:context`,
    { featureSlug: slug }
  )
  throwIfHarnessDetailCancelled(signal)
  const workerContext = contexts.projects[projectId]
  if (!workerContext) throw new Error("Project not found")
  const project = workerContext.project
  const context = projectConfigContextFromWorker(workerContext)
  const { buffer, configured } = await runInspectAdapterBufferFromContext(
    project,
    context,
    "run",
    slug,
    signal
  )
  throwIfHarnessDetailCancelled(signal)
  let projection: HarnessAdapterRunProjection
  try {
    projection = await parseHarnessAdapterRunInWorker(
      buffer,
      project,
      slug,
      `${scope}:adapter`
    )
    throwIfHarnessDetailCancelled(signal)
  } catch (error) {
    if (signal.aborted) throw harnessDetailCancelledError()
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[HarnessBoard] [feature_status] Failed after command completed: ${message}`)
    console.error(
      `[HarnessBoard] [feature_status] Command: ${formatHarnessCommand(configured.invocation)}`
    )
    console.error(`[HarnessBoard] [feature_status] CWD: ${configured.cwd}`)
    if (error instanceof HarnessAdapterDetailWorkerResultError && error.preview) {
      console.error(`[HarnessBoard] [feature_status] Result preview:\n${error.preview}`)
    }
    throw error
  }
  const skipNodeAvailable = hasConfiguredHarnessInvocationInContext(context, "skipNode")
  const selectedDeployUnits = workerContext.selectedDeployUnits ?? []
  const detail: HarnessRunDetailViewModel = {
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
    workflow: projection.workflow,
    run: {
      ...projection.run,
      source: {
        label: project["harness-adapter"].name
      },
      skipNodeAvailable,
      selectedDeployUnits
    },
    sessions: []
  }
  const responseBytes = serialize(detail).byteLength
  if (responseBytes > HARNESS_ADAPTER_DETAIL_MAX_IPC_BYTES) {
    throw new Error(
      `Harness run detail exceeded IPC limit (${HARNESS_ADAPTER_DETAIL_MAX_IPC_BYTES} bytes)`
    )
  }
  return detail
}
