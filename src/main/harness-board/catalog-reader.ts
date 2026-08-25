import { existsSync, readFileSync, statSync } from "node:fs"
import { basename, isAbsolute, join, relative, resolve } from "node:path"
import { serialize } from "node:v8"
import type { PluginMetadata } from "../types"
import type {
  HarnessAdapterRegistryItem,
  HarnessBoardCatalogPageInput,
  HarnessBoardCatalogPageResult,
  HarnessBoardCompatibility,
  HarnessDeployUnitMapping,
  HarnessProjectCreatorMetadata,
  HarnessProjectListItem,
  HarnessProjectMetadata
} from "../../shared/harness-board-types"
import {
  HARNESS_CATALOG_DEFAULT_PAGE_SIZE,
  HARNESS_DIALOG_TIPS_MAX_RESPONSE_BYTES,
  HARNESS_LEAN_TOKEN_MAX_RESPONSE_BYTES,
  HARNESS_CATALOG_MAX_PAGE_SIZE,
  HARNESS_CATALOG_MAX_RESPONSE_BYTES,
  HARNESS_PROJECT_CONTEXT_MAX_PROJECTS,
  type HarnessProjectContextItem,
  type HarnessProjectContextResult,
  type HarnessDialogTipsResult,
  type HarnessLeanTokenResult
} from "./catalog-protocol"

const BOARD_CONFIG_REL_PATH = join("board_core", "board_config.json")
const APP_BOARD_API_VERSION = 1
const MAX_PROJECT_TEXT = 2_048
const MAX_REGISTRY_TEXT = 4_096
const MAX_CATALOG_STORE_BYTES = 128 * 1024 * 1024
const MAX_BOARD_CONFIG_BYTES = 1024 * 1024
const MAX_LEAN_TOKEN_STORE_BYTES = 64 * 1024
const MAX_LEAN_TOKEN_CHARS = 8 * 1024
const MAX_FEATURE_BINDING_STORE_BYTES = 2 * 1024 * 1024
const MAX_DEPLOY_UNIT_MAPPING_STORE_BYTES = 2 * 1024 * 1024
const MAX_FEATURE_BINDINGS = 4_096
const MAX_DEPLOY_UNIT_MAPPINGS = 512
const MAX_SELECTED_DEPLOY_UNIT_MAPPINGS = 64
const PROJECT_CONTEXT_COMMAND_KEYS = [
  "project_status",
  "feature_status",
  "skip_node",
  "knowledge_path"
] as const

interface FileCache<T> {
  signature: string
  value: T
}

let projectCache: FileCache<unknown[]> | null = null
let projectIndexCache: { rows: unknown[]; byId: Map<string, unknown> } | null = null
let pluginCache: FileCache<PluginMetadata[]> | null = null
let pluginIndexCache: {
  rows: PluginMetadata[]
  byId: Map<string, PluginMetadata>
  byName: Map<string, PluginMetadata>
} | null = null
const configCache = new Map<string, FileCache<BoardConfigSnapshot>>()
let featureBindingCache: FileCache<unknown[]> | null = null
let deployUnitMappingCache: FileCache<HarnessDeployUnitMapping[]> | null = null
let leanTokenCache: FileCache<string> | null = null

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function text(value: unknown, max = MAX_PROJECT_TEXT): string {
  return typeof value === "string" ? value.slice(0, max) : ""
}

function boundedConfigText(value: unknown, max: number, label: string): string {
  if (typeof value !== "string") return ""
  if (value.length > max) throw new Error(`${label} exceeded ${max} characters`)
  return value
}

function fileSignature(path: string): string {
  if (!existsSync(path)) return "missing"
  const stats = statSync(path)
  return `${stats.mtimeMs}:${stats.size}`
}

function assertFileWithin(path: string, maxBytes: number, label: string): void {
  if (!existsSync(path)) return
  const size = statSync(path).size
  if (size > maxBytes) throw new Error(`${label} exceeded ${maxBytes} bytes`)
}

function readJsonArray(path: string): unknown[] {
  if (!existsSync(path)) return []
  assertFileWithin(path, MAX_CATALOG_STORE_BYTES, "Harness plugin store")
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function readProjects(path: string): unknown[] {
  const signature = fileSignature(path)
  if (projectCache?.signature === signature) return projectCache.value
  assertFileWithin(path, MAX_CATALOG_STORE_BYTES, "Harness project store")
  let rows: unknown[] = []
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown
      rows = isRecord(parsed) && Array.isArray(parsed.projects) ? parsed.projects : []
    } catch {
      rows = []
    }
  }
  projectCache = { signature, value: rows }
  projectIndexCache = null
  return rows
}

function indexProjects(rows: unknown[]): ReadonlyMap<string, unknown> {
  if (projectIndexCache?.rows === rows) return projectIndexCache.byId
  const byId = new Map<string, unknown>()
  for (const row of rows) {
    if (!isRecord(row) || typeof row.projectId !== "string" || byId.has(row.projectId)) continue
    byId.set(row.projectId, row)
  }
  projectIndexCache = { rows, byId }
  return byId
}

function readPlugins(path: string): PluginMetadata[] {
  const signature = fileSignature(path)
  if (pluginCache?.signature === signature) return pluginCache.value
  const plugins = readJsonArray(path).filter(
    (row): row is PluginMetadata =>
      isRecord(row) &&
      typeof row.id === "string" &&
      typeof row.name === "string" &&
      typeof row.path === "string"
  )
  pluginCache = { signature, value: plugins }
  pluginIndexCache = null
  return plugins
}

function indexPlugins(plugins: PluginMetadata[]): {
  byId: ReadonlyMap<string, PluginMetadata>
  byName: ReadonlyMap<string, PluginMetadata>
} {
  if (pluginIndexCache?.rows === plugins) return pluginIndexCache
  const byId = new Map<string, PluginMetadata>()
  const byName = new Map<string, PluginMetadata>()
  for (const plugin of plugins) {
    if (!byId.has(plugin.id)) byId.set(plugin.id, plugin)
    if (!byName.has(plugin.name)) byName.set(plugin.name, plugin)
  }
  pluginIndexCache = { rows: plugins, byId, byName }
  return pluginIndexCache
}

function projectPluginMetadata(plugin: PluginMetadata): PluginMetadata {
  return {
    id: text(plugin.id, 512),
    name: text(plugin.name, 1_024),
    version: text(plugin.version, 512),
    description: text(plugin.description, MAX_REGISTRY_TEXT),
    ...(text(plugin.useScenario, 1_024) ? { useScenario: text(plugin.useScenario, 1_024) } : {}),
    author: text(plugin.author, 1_024),
    path: text(plugin.path, 8_192),
    enabled: plugin.enabled === true,
    skillCount: Number.isFinite(plugin.skillCount) ? Math.max(0, plugin.skillCount) : 0,
    mcpServerCount: Number.isFinite(plugin.mcpServerCount) ? Math.max(0, plugin.mcpServerCount) : 0,
    ...(Number.isFinite(plugin.hookCount) ? { hookCount: Math.max(0, plugin.hookCount!) } : {}),
    ...(text(plugin.hookPath, 2_048) ? { hookPath: text(plugin.hookPath, 2_048) } : {}),
    ...(plugin.origin === "market" || plugin.origin === "local" ? { origin: plugin.origin } : {}),
    createdAt: text(plugin.createdAt, 128),
    updatedAt: text(plugin.updatedAt, 128)
  }
}

function projectNextAction(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined
  const slashSkill = boundedConfigText(value.slashSkill, 2_048, "Harness slashSkill")
  const userMessage = boundedConfigText(value.userMessage, 4_096, "Harness userMessage")
  const dialogTips = boundedConfigText(value.dialogTips, 4_096, "Harness dialogTips")
  const preferredPlugin = isRecord(value.preferredPlugin)
    ? {
        ...(text(value.preferredPlugin.id, 512) ? { id: text(value.preferredPlugin.id, 512) } : {}),
        ...(text(value.preferredPlugin.name, 1_024)
          ? { name: text(value.preferredPlugin.name, 1_024) }
          : {})
      }
    : null
  const result = {
    ...(slashSkill ? { slashSkill } : {}),
    ...(userMessage ? { userMessage } : {}),
    ...(dialogTips ? { dialogTips } : {}),
    ...(preferredPlugin && Object.keys(preferredPlugin).length > 0 ? { preferredPlugin } : {})
  }
  return Object.keys(result).length > 0 ? result : undefined
}

function projectBoardConfigForDetails(
  config: Record<string, unknown> | null
): Record<string, unknown> | null {
  if (!config) return null
  const inspectCommands = isRecord(config.inspectCommands) ? config.inspectCommands : null
  const platform =
    inspectCommands && isRecord(inspectCommands[process.platform])
      ? inspectCommands[process.platform]
      : null
  const projectedPlatform: Record<string, string> = {}
  if (platform) {
    for (const key of PROJECT_CONTEXT_COMMAND_KEYS) {
      const command = boundedConfigText(platform[key], 8_192, `Harness board config ${key}`).trim()
      if (command) projectedPlatform[key] = command
    }
  }
  const knowledgeConfig = isRecord(config.knowledge_config) ? config.knowledge_config : null
  const nextAction = projectNextAction(knowledgeConfig?.nextAction)
  const apiVersion =
    typeof config.apiVersion === "number" || typeof config.apiVersion === "string"
      ? config.apiVersion
      : undefined
  return {
    ...(apiVersion !== undefined ? { apiVersion } : {}),
    inspectCommands: { [process.platform]: projectedPlatform },
    ...(knowledgeConfig
      ? {
          knowledge_config: {
            sync_type: text(knowledgeConfig.sync_type, 256),
            ...(nextAction ? { nextAction } : {})
          }
        }
      : {})
  }
}

interface BoardConfigSnapshot {
  value: Record<string, unknown> | null
  error: string | null
  exists: boolean
}

function readBoardConfig(pluginPath: string): BoardConfigSnapshot {
  const path = join(pluginPath, BOARD_CONFIG_REL_PATH)
  const signature = fileSignature(path)
  const cached = configCache.get(path)
  if (cached?.signature === signature) return cached.value
  if (signature === "missing") {
    const snapshot = { value: null, error: null, exists: false }
    configCache.set(path, { signature, value: snapshot })
    return snapshot
  }
  try {
    assertFileWithin(path, MAX_BOARD_CONFIG_BYTES, "Harness board config")
  } catch (error) {
    const snapshot = {
      value: null,
      error: error instanceof Error ? error.message : String(error),
      exists: true
    }
    configCache.set(path, { signature, value: snapshot })
    return snapshot
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown
    const value = isRecord(parsed) ? parsed : null
    const snapshot = { value, error: null, exists: true }
    configCache.set(path, { signature, value: snapshot })
    return snapshot
  } catch (error) {
    const snapshot = {
      value: null,
      error: error instanceof Error ? error.message.slice(0, 512) : "invalid json",
      exists: true
    }
    configCache.set(path, { signature, value: snapshot })
    return snapshot
  }
}

function compatibility(
  plugin: PluginMetadata | null,
  storedName: string
): HarnessBoardCompatibility {
  if (!plugin) {
    return {
      status: "missing-plugin",
      compatible: false,
      appApiVersion: APP_BOARD_API_VERSION,
      label: "插件未安装",
      message: `项目使用的插件未安装：${storedName || "插件"}`
    }
  }
  const config = readBoardConfig(plugin.path)
  if (!config.exists) {
    return {
      status: "missing-board-config",
      compatible: false,
      appApiVersion: APP_BOARD_API_VERSION,
      label: "插件与看板不兼容"
    }
  }
  if (config.error) {
    return {
      status: "invalid-board-config",
      compatible: false,
      appApiVersion: APP_BOARD_API_VERSION,
      label: "配置错误",
      message: config.error
    }
  }
  const apiVersion = Number(config.value?.apiVersion)
  if (!Number.isInteger(apiVersion) || apiVersion <= 0) {
    return {
      status: "invalid-api-version",
      compatible: false,
      appApiVersion: APP_BOARD_API_VERSION,
      label: "插件与客户端版本不兼容"
    }
  }
  if (apiVersion < APP_BOARD_API_VERSION) {
    return {
      status: "plugin-too-old",
      compatible: false,
      appApiVersion: APP_BOARD_API_VERSION,
      pluginApiVersion: apiVersion,
      label: "插件版本过低"
    }
  }
  if (apiVersion > APP_BOARD_API_VERSION) {
    return {
      status: "app-too-old",
      compatible: false,
      appApiVersion: APP_BOARD_API_VERSION,
      pluginApiVersion: apiVersion,
      label: "客户端版本过低"
    }
  }
  return {
    status: "compatible",
    compatible: true,
    appApiVersion: APP_BOARD_API_VERSION,
    pluginApiVersion: apiVersion,
    label: "兼容"
  }
}

function supportsSessionContext(plugin: PluginMetadata | null): boolean {
  if (!plugin) return false
  const config = readBoardConfig(plugin.path)
  if (config.error || !config.value) return false
  const commands = config.value.inspectCommands
  if (!isRecord(commands)) return false
  const platform = commands[process.platform]
  return isRecord(platform) && Boolean(text(platform.session_context_inject).trim())
}

function creator(value: unknown): HarnessProjectCreatorMetadata | undefined {
  if (!isRecord(value)) return undefined
  const result: HarnessProjectCreatorMetadata = {
    sapId: text(value.sapId, 256),
    ystId: text(value.ystId, 256),
    userName: text(value.userName, 256),
    orgName: text(value.orgName, 512),
    pathName: text(value.pathName, 1_024),
    upperOrgLv0: text(value.upperOrgLv0, 512),
    upperOrgLv1: text(value.upperOrgLv1, 512)
  }
  return Object.values(result).some(Boolean) ? result : undefined
}

function toProjectMetadata(value: unknown): HarnessProjectMetadata | null {
  if (!isRecord(value) || typeof value.projectId !== "string" || typeof value.name !== "string") {
    return null
  }
  const stored = isRecord(value["harness-adapter"]) ? value["harness-adapter"] : null
  if (!stored || stored.type !== "plugin") return null
  const adapterId = text(stored.id, 512).trim()
  const adapterName = text(stored.name, 512).trim()
  if (!adapterId || !adapterName) return null
  const oldWorkspace = isRecord(value.workspace) ? value.workspace : {}
  const lifecycle = isRecord(value.lifecycle) ? value.lifecycle : {}
  const projectCode = text(value.projectCode, 1_024)
  const projectCreator = creator(value.creator)
  return {
    projectId: text(value.projectId, 512),
    name: text(value.name, 2_048),
    description: text(value.description, 4_096),
    projectCode,
    projectFromLean: value.projectFromLean === true,
    projectDir: text(value.projectDir, 2_048) || projectCode,
    systemId: text(value.systemId, 2_048),
    systemName: text(value.systemName, 2_048),
    workspacePath: text(value.workspacePath, 4_096) || text(oldWorkspace.path, 4_096),
    ...(text(value.sessionWorkspacePath, 4_096)
      ? { sessionWorkspacePath: text(value.sessionWorkspacePath, 4_096) }
      : {}),
    ...(text(value.systemConstraintFirstLoadedAt, 128)
      ? { systemConstraintFirstLoadedAt: text(value.systemConstraintFirstLoadedAt, 128) }
      : {}),
    "harness-adapter": {
      id: adapterId,
      name: adapterName,
      version: text(stored.version, 512),
      type: "plugin"
    },
    ...(projectCreator ? { creator: projectCreator } : {}),
    lifecycle: {
      status: lifecycle.status === "archived" ? "archived" : "active",
      createAt: text(lifecycle.createAt, 128) || new Date().toISOString(),
      ...(text(lifecycle.updateAt, 128) ? { updateAt: text(lifecycle.updateAt, 128) } : {})
    }
  }
}

function isInsideDirectory(basePath: string, targetPath: string): boolean {
  const relativePath = relative(resolve(basePath), resolve(targetPath))
  return (
    relativePath === "" ||
    (Boolean(relativePath) && !relativePath.startsWith("..") && !isAbsolute(relativePath))
  )
}

function projectDirectoryExists(project: HarnessProjectMetadata): boolean {
  try {
    const workspacePath = resolve(project.workspacePath)
    const projectDir = project.projectDir.trim() || project.projectCode.trim()
    const projectPath = resolve(workspacePath, projectDir)
    if (
      projectPath === workspacePath ||
      basename(projectPath) !== projectDir ||
      !isInsideDirectory(workspacePath, projectPath)
    ) {
      return false
    }
    return existsSync(projectPath)
  } catch {
    return false
  }
}

function readLeanToken(path: string): string {
  const signature = fileSignature(path)
  if (leanTokenCache?.signature === signature) return leanTokenCache.value
  let leanToken = ""
  if (signature !== "missing") {
    assertFileWithin(path, MAX_LEAN_TOKEN_STORE_BYTES, "Harness Lean token store")
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown
      leanToken = isRecord(parsed) ? text(parsed.leanToken, MAX_LEAN_TOKEN_CHARS).trim() : ""
    } catch {
      leanToken = ""
    }
  }
  leanTokenCache = { signature, value: leanToken }
  return leanToken
}

export function readHarnessLeanToken(
  leanTokenStorePath: string,
  maxResponseBytes = HARNESS_LEAN_TOKEN_MAX_RESPONSE_BYTES,
  cancelFlag?: Int32Array
): HarnessLeanTokenResult {
  const startedAt = performance.now()
  const cancelledBeforeRead = isCancelled(cancelFlag)
  const leanToken = cancelledBeforeRead ? "" : readLeanToken(leanTokenStorePath)
  const cancelled = cancelledBeforeRead || isCancelled(cancelFlag)
  const result: HarnessLeanTokenResult = {
    leanToken: cancelled ? "" : leanToken,
    stats: {
      durationMs: Math.max(0, performance.now() - startedAt),
      responseBytes: 0,
      cancelled
    }
  }
  result.stats.responseBytes = serialize(result).byteLength
  const budget = Math.min(maxResponseBytes, HARNESS_LEAN_TOKEN_MAX_RESPONSE_BYTES)
  if (result.stats.responseBytes > budget) {
    throw new Error(`Harness Lean token result exceeded ${budget} bytes`)
  }
  return result
}

function readFeatureBindingRows(path: string): unknown[] {
  const signature = fileSignature(path)
  if (featureBindingCache?.signature === signature) return featureBindingCache.value
  let rows: unknown[] = []
  if (signature !== "missing") {
    try {
      assertFileWithin(path, MAX_FEATURE_BINDING_STORE_BYTES, "Harness feature binding store")
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown
      rows = isRecord(parsed) && Array.isArray(parsed.bindings)
        ? parsed.bindings.slice(0, MAX_FEATURE_BINDINGS)
        : []
    } catch {
      rows = []
    }
  }
  featureBindingCache = { signature, value: rows }
  return rows
}

function normalizeDeployUnitMapping(value: unknown): HarnessDeployUnitMapping | null {
  if (!isRecord(value)) return null
  const deployUnitIdMapping = text(value.deployUnitIdMapping, 512).trim()
  const deployUnitId = text(value.deployUnitId, 2_048).trim()
  const localRepoPath = text(value.localRepoPath, 8_192).trim()
  const description = text(value.description, 4_096).trim()
  if (!deployUnitIdMapping || !deployUnitId || !localRepoPath) return null
  return {
    deployUnitIdMapping,
    deployUnitId,
    localRepoPath,
    ...(description ? { description } : {})
  }
}

function normalizeDeployUnitMappingRows(
  value: unknown,
  maxMappings = MAX_DEPLOY_UNIT_MAPPINGS
): HarnessDeployUnitMapping[] {
  if (!Array.isArray(value)) return []
  const seenIds = new Set<string>()
  const seenMappings = new Set<string>()
  const result: HarnessDeployUnitMapping[] = []
  for (const row of value) {
    if (result.length >= Math.min(maxMappings, MAX_DEPLOY_UNIT_MAPPINGS)) break
    const mapping = normalizeDeployUnitMapping(row)
    if (
      !mapping ||
      seenIds.has(mapping.deployUnitId) ||
      seenMappings.has(mapping.deployUnitIdMapping)
    ) {
      continue
    }
    seenIds.add(mapping.deployUnitId)
    seenMappings.add(mapping.deployUnitIdMapping)
    result.push(mapping)
  }
  return result
}

function readDeployUnitMappings(path: string): HarnessDeployUnitMapping[] {
  const signature = fileSignature(path)
  if (deployUnitMappingCache?.signature === signature) return deployUnitMappingCache.value
  let mappings: HarnessDeployUnitMapping[] = []
  if (signature !== "missing") {
    try {
      assertFileWithin(
        path,
        MAX_DEPLOY_UNIT_MAPPING_STORE_BYTES,
        "Harness deploy unit mapping store"
      )
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown
      mappings = isRecord(parsed) ? normalizeDeployUnitMappingRows(parsed.mappings) : []
    } catch {
      mappings = []
    }
  }
  deployUnitMappingCache = { signature, value: mappings }
  return mappings
}

interface FeatureDeployUnitProjection {
  featureSlug: string
  featureBindingStorePath: string
  deployUnitMappingStorePath: string
}

function selectedFeatureDeployUnits(
  projectId: string,
  projection: FeatureDeployUnitProjection
): HarnessDeployUnitMapping[] {
  const featureSlug = text(projection.featureSlug, 2_048).trim()
  if (!featureSlug) return []
  let snapshots: HarnessDeployUnitMapping[] = []
  for (const row of readFeatureBindingRows(projection.featureBindingStorePath)) {
    if (!isRecord(row)) continue
    if (
      text(row.projectId, 512).trim() !== projectId ||
      text(row.featureId, 2_048).trim() !== featureSlug
    ) {
      continue
    }
    snapshots = normalizeDeployUnitMappingRows(
      row.selectedDeployUnitMappings,
      MAX_SELECTED_DEPLOY_UNIT_MAPPINGS
    )
    break
  }
  if (snapshots.length === 0) return []
  const configuredById = new Map(
    readDeployUnitMappings(projection.deployUnitMappingStorePath).map((mapping) => [
      mapping.deployUnitIdMapping,
      mapping
    ])
  )
  return snapshots.map(
    (snapshot) => configuredById.get(snapshot.deployUnitIdMapping) ?? snapshot
  )
}

export function readHarnessDialogTips(
  projectStorePath: string,
  pluginStorePath: string,
  leanTokenStorePath: string,
  projectId: string,
  slug: string,
  maxResponseBytes = HARNESS_DIALOG_TIPS_MAX_RESPONSE_BYTES,
  cancelFlag?: Int32Array
): HarnessDialogTipsResult {
  const startedAt = performance.now()
  const normalizedProjectId = text(projectId, 512).trim()
  const feature = text(slug, 2_048).trim()
  if (!normalizedProjectId || !feature) {
    return {
      tips: null,
      stats: { durationMs: 0, responseBytes: 0, cancelled: false }
    }
  }

  const rows = readProjects(projectStorePath)
  if (isCancelled(cancelFlag)) {
    return {
      tips: null,
      stats: {
        durationMs: Math.max(0, performance.now() - startedAt),
        responseBytes: 0,
        cancelled: true
      }
    }
  }
  const project = toProjectMetadata(indexProjects(rows).get(normalizedProjectId))
  if (!project) throw new Error("Project not found")

  const adapter = project["harness-adapter"]
  const { byId: pluginById, byName: pluginByName } = indexPlugins(readPlugins(pluginStorePath))
  const plugin = pluginById.get(adapter.id) ?? pluginByName.get(adapter.name) ?? null
  if (!plugin || isCancelled(cancelFlag)) {
    return {
      tips: null,
      stats: {
        durationMs: Math.max(0, performance.now() - startedAt),
        responseBytes: 0,
        cancelled: isCancelled(cancelFlag)
      }
    }
  }

  const boardConfig = readBoardConfig(plugin.path)
  const inspectCommands = isRecord(boardConfig.value?.inspectCommands)
    ? boardConfig.value.inspectCommands
    : null
  const platformValue = inspectCommands?.[process.platform]
  const platform = isRecord(platformValue) ? platformValue : null
  const template = platform
    ? boundedConfigText(platform.dialog_tips, 4_096, "Harness dialogTips").trim()
    : ""

  let tips: string | null = null
  if (template && !isCancelled(cancelFlag)) {
    const projectDir = project.projectDir.trim() || project.projectCode.trim()
    const replacements: Record<string, string> = {
      pluginWorkspace: project.workspacePath,
      project: projectDir,
      projectDir,
      projectCode: project.projectCode,
      leanToken: readLeanToken(leanTokenStorePath),
      feature,
      selectedDeployUnits: "",
      sessionWorkspacePath: "",
      pluginPath: plugin.path,
      mode: "run",
      workflowTemplate: "",
      workflowNodes: "",
      nodeId: ""
    }
    tips =
      template
        .replace(
          /\$\{(pluginWorkspace|project|projectDir|projectCode|leanToken|feature|selectedDeployUnits|sessionWorkspacePath|pluginPath|mode|workflowTemplate|workflowNodes|nodeId)\}/g,
          (_placeholder, key: string) => replacements[key] ?? ""
        )
        .trim() || null
  }

  const cancelled = isCancelled(cancelFlag)
  const result: HarnessDialogTipsResult = {
    tips: cancelled ? null : tips,
    stats: {
      durationMs: Math.max(0, performance.now() - startedAt),
      responseBytes: 0,
      cancelled
    }
  }
  result.stats.responseBytes = serialize(result).byteLength
  const budget = Math.min(maxResponseBytes, HARNESS_DIALOG_TIPS_MAX_RESPONSE_BYTES)
  if (result.stats.responseBytes > budget) {
    throw new Error(`Harness dialog tips result exceeded ${budget} bytes`)
  }
  return result
}

export function readHarnessProjectContexts(
  projectStorePath: string,
  pluginStorePath: string,
  projectIds: string[],
  maxResponseBytes = HARNESS_CATALOG_MAX_RESPONSE_BYTES,
  cancelFlag?: Int32Array,
  featureProjection?: FeatureDeployUnitProjection,
  leanTokenStorePath = ""
): HarnessProjectContextResult {
  const startedAt = performance.now()
  const ids = [...new Set(projectIds.map((id) => text(id, 512).trim()).filter(Boolean))]
  if (ids.length > HARNESS_PROJECT_CONTEXT_MAX_PROJECTS) {
    throw new Error(
      `Harness project context request exceeds ${HARNESS_PROJECT_CONTEXT_MAX_PROJECTS} projects`
    )
  }
  if (featureProjection && ids.length !== 1) {
    throw new Error("Harness feature deploy-unit projection requires exactly one project")
  }

  const rows = readProjects(projectStorePath)
  const byId = indexProjects(rows)
  const { byId: pluginById, byName: pluginByName } = indexPlugins(readPlugins(pluginStorePath))
  const projects: Record<string, HarnessProjectContextItem | null> = {}
  const leanToken = readLeanToken(leanTokenStorePath)

  for (const id of ids) {
    if (isCancelled(cancelFlag)) break
    const project = toProjectMetadata(byId.get(id))
    if (!project) {
      projects[id] = null
      continue
    }
    const adapter = project["harness-adapter"]
    const rawPlugin = pluginById.get(adapter.id) ?? pluginByName.get(adapter.name) ?? null
    const boardConfig = rawPlugin ? readBoardConfig(rawPlugin.path) : null
    const plugin = rawPlugin && boardConfig?.exists ? projectPluginMetadata(rawPlugin) : null
    projects[id] = {
      project,
      plugin,
      configSnapshot:
        plugin && boardConfig
          ? {
              value: projectBoardConfigForDetails(boardConfig.value),
              error: boardConfig.error
            }
          : null,
      projectDirectoryExists:
        project.lifecycle.status === "archived" || projectDirectoryExists(project),
      leanToken,
      ...(featureProjection
        ? { selectedDeployUnits: selectedFeatureDeployUnits(project.projectId, featureProjection) }
        : {})
    }
  }

  const cancelled = isCancelled(cancelFlag)
  const result: HarnessProjectContextResult = {
    projects,
    stats: {
      durationMs: Math.max(0, performance.now() - startedAt),
      responseBytes: 0,
      projectRows: Object.values(projects).filter(Boolean).length,
      cancelled
    }
  }
  result.stats.responseBytes = serialize(result).byteLength
  if (result.stats.responseBytes > Math.min(maxResponseBytes, HARNESS_CATALOG_MAX_RESPONSE_BYTES)) {
    throw new Error(`Harness project context result exceeded ${maxResponseBytes} bytes`)
  }
  return result
}

function projectLifecycle(row: Record<string, unknown>): "active" | "archived" {
  return isRecord(row.lifecycle) && row.lifecycle.status === "archived" ? "archived" : "active"
}

function projectMatches(
  row: unknown,
  query: string,
  projectId: string,
  projectIds: ReadonlySet<string>
): boolean {
  if (!isRecord(row) || typeof row.projectId !== "string" || typeof row.name !== "string") {
    return false
  }
  if (projectId && row.projectId !== projectId) return false
  if (projectIds.size > 0 && !projectIds.has(row.projectId)) return false
  if (!query) return true
  const adapter = isRecord(row["harness-adapter"]) ? row["harness-adapter"] : {}
  const fields = [
    row.name,
    row.description,
    row.projectCode,
    row.projectDir,
    row.systemId,
    row.systemName,
    adapter.id,
    adapter.name
  ]
  return fields.some((value) => text(value).toLocaleLowerCase().includes(query))
}

function toProjectListItem(
  value: unknown,
  pluginById: ReadonlyMap<string, PluginMetadata>,
  pluginByName: ReadonlyMap<string, PluginMetadata>
): HarnessProjectListItem | null {
  if (!isRecord(value) || typeof value.projectId !== "string" || typeof value.name !== "string") {
    return null
  }
  const stored = isRecord(value["harness-adapter"]) ? value["harness-adapter"] : null
  if (!stored || stored.type !== "plugin") return null
  const adapterId = text(stored.id, 512).trim()
  const adapterName = text(stored.name, 512).trim()
  if (!adapterId || !adapterName) return null
  const plugin = pluginById.get(adapterId) ?? pluginByName.get(adapterName) ?? null
  const boardCompatibility = compatibility(plugin, adapterName)
  const oldWorkspace = isRecord(value.workspace) ? value.workspace : {}
  const lifecycle = isRecord(value.lifecycle) ? value.lifecycle : {}
  const projectCreator = creator(value.creator)
  const projectCode = text(value.projectCode, 512)
  return {
    projectId: text(value.projectId, 512),
    name: text(value.name, 1_024),
    description: text(value.description),
    projectCode,
    projectFromLean: value.projectFromLean === true,
    projectDir: text(value.projectDir, 1_024) || projectCode,
    systemId: text(value.systemId, 1_024),
    systemName: text(value.systemName, 1_024),
    workspacePath: text(value.workspacePath) || text(oldWorkspace.path),
    ...(text(value.sessionWorkspacePath)
      ? { sessionWorkspacePath: text(value.sessionWorkspacePath) }
      : {}),
    ...(text(value.systemConstraintFirstLoadedAt, 128)
      ? { systemConstraintFirstLoadedAt: text(value.systemConstraintFirstLoadedAt, 128) }
      : {}),
    harnessAdapter: {
      id: plugin?.id ?? adapterId,
      name: plugin?.name ?? adapterName,
      type: "plugin"
    },
    ...(projectCreator ? { creator: projectCreator } : {}),
    boardCompatibility,
    supportsDeployUnits: boardCompatibility.compatible,
    supportsSessionContextInjection:
      boardCompatibility.compatible && supportsSessionContext(plugin),
    lifecycle: {
      status: projectLifecycle(value),
      createAt: text(lifecycle.createAt, 128) || new Date(0).toISOString(),
      ...(text(lifecycle.updateAt, 128) ? { updateAt: text(lifecycle.updateAt, 128) } : {})
    }
  }
}

function toRegistryItem(plugin: PluginMetadata): HarnessAdapterRegistryItem {
  const boardCompatibility = compatibility(plugin, plugin.name)
  const config = readBoardConfig(plugin.path)
  const commands = isRecord(config.value?.inspectCommands)
    ? config.value?.inspectCommands[process.platform]
    : null
  return {
    id: text(plugin.id, 512),
    name: text(plugin.name, 1_024),
    version: text(plugin.version, 256),
    type: "plugin",
    description: text(plugin.description, MAX_REGISTRY_TEXT),
    ...(text(plugin.useScenario, 512) ? { useScenario: text(plugin.useScenario, 512) } : {}),
    pullKnowledgeAvailable: isRecord(commands) && Boolean(text(commands.pull_knowledge).trim()),
    boardCompatibility
  }
}

function boundedLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) return HARNESS_CATALOG_DEFAULT_PAGE_SIZE
  return Math.min(HARNESS_CATALOG_MAX_PAGE_SIZE, Math.max(1, Math.trunc(value!)))
}

function isCancelled(cancelFlag?: Int32Array): boolean {
  return Boolean(cancelFlag && Atomics.load(cancelFlag, 0) !== 0)
}

export function readHarnessCatalogPage(
  projectStorePath: string,
  pluginStorePath: string,
  input: HarnessBoardCatalogPageInput,
  maxResponseBytes = HARNESS_CATALOG_MAX_RESPONSE_BYTES,
  cancelFlag?: Int32Array
): HarnessBoardCatalogPageResult {
  const startedAt = performance.now()
  const rawProjects = readProjects(projectStorePath)
  const plugins = readPlugins(pluginStorePath).filter((plugin) =>
    existsSync(join(plugin.path, BOARD_CONFIG_REL_PATH))
  )
  const pluginById = new Map(plugins.map((plugin) => [plugin.id, plugin]))
  const pluginByName = new Map(plugins.map((plugin) => [plugin.name, plugin]))
  const query = text(input.query).trim().toLocaleLowerCase()
  const projectId = text(input.projectId, 512).trim()
  const projectIds = new Set(
    (input.projectIds ?? [])
      .slice(0, 64)
      .map((value) => text(value, 512).trim())
      .filter(Boolean)
  )
  const projectLimit = boundedLimit(input.projectLimit)
  const registryLimit = boundedLimit(input.registryLimit)
  const projectOffset = Math.max(0, Math.trunc(input.projectCursor ?? 0))
  const registryOffset = Math.max(0, Math.trunc(input.registryCursor ?? 0))
  let activeProjects = 0
  let archivedProjects = 0
  let matchedProjects = 0

  for (let index = 0; index < rawProjects.length; index += 1) {
    if ((index & 127) === 0 && isCancelled(cancelFlag)) break
    const row = rawProjects[index]
    if (!isRecord(row)) continue
    if (projectLifecycle(row) === "archived") archivedProjects += 1
    else activeProjects += 1
    if (projectMatches(row, query, projectId, projectIds)) matchedProjects += 1
  }

  const projects: HarnessProjectListItem[] = []
  let nextProjectOffset = projectOffset
  if (input.includeProjects !== false && !isCancelled(cancelFlag)) {
    let seen = 0
    for (let index = 0; index < rawProjects.length && projects.length < projectLimit; index += 1) {
      if ((index & 31) === 0 && isCancelled(cancelFlag)) break
      const row = rawProjects[index]
      if (!projectMatches(row, query, projectId, projectIds)) continue
      if (seen < projectOffset) {
        seen += 1
        continue
      }
      const projected = toProjectListItem(row, pluginById, pluginByName)
      if (!projected) {
        seen += 1
        nextProjectOffset = seen
        continue
      }
      const candidate = { projects: [...projects, projected], registry: [] }
      if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > maxResponseBytes / 2) break
      projects.push(projected)
      seen += 1
      nextProjectOffset = seen
    }
  }

  const boardPlugins = plugins.filter((plugin) => {
    if (!query || input.includeProjects !== false) return true
    return [plugin.id, plugin.name, plugin.description, plugin.useScenario].some((value) =>
      text(value).toLocaleLowerCase().includes(query)
    )
  })
  const registry: HarnessAdapterRegistryItem[] = []
  if (input.includeRegistry !== false && !isCancelled(cancelFlag)) {
    for (
      let index = registryOffset;
      index < boardPlugins.length && registry.length < registryLimit;
      index += 1
    ) {
      if ((index & 15) === 0 && isCancelled(cancelFlag)) break
      const projected = toRegistryItem(boardPlugins[index])
      const candidate = { projects, registry: [...registry, projected] }
      if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > maxResponseBytes) break
      registry.push(projected)
    }
  }

  const cancelled = isCancelled(cancelFlag)
  const result: HarnessBoardCatalogPageResult = {
    projects,
    registry,
    projectNextCursor:
      input.includeProjects !== false && !cancelled && nextProjectOffset < matchedProjects
        ? nextProjectOffset
        : null,
    registryNextCursor:
      input.includeRegistry !== false &&
      !cancelled &&
      registryOffset + registry.length < boardPlugins.length
        ? registryOffset + registry.length
        : null,
    summary: {
      totalProjects: activeProjects + archivedProjects,
      matchedProjects,
      activeProjects,
      archivedProjects,
      totalRegistry: boardPlugins.length
    },
    stats: {
      durationMs: Math.max(0, performance.now() - startedAt),
      responseBytes: 0,
      projectRows: projects.length,
      registryRows: registry.length,
      cancelled
    }
  }
  result.stats.responseBytes = Buffer.byteLength(JSON.stringify(result), "utf8")
  return result
}

export function resetHarnessCatalogReaderCacheForTests(): void {
  projectCache = null
  projectIndexCache = null
  pluginCache = null
  pluginIndexCache = null
  configCache.clear()
  featureBindingCache = null
  deployUnitMappingCache = null
  leanTokenCache = null
}
