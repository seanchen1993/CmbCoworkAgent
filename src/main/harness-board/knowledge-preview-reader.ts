import {
  existsSync,
  opendirSync,
  readFileSync,
  realpathSync,
  statSync,
  type Dirent
} from "node:fs"
import { basename, isAbsolute, join, relative, resolve } from "node:path"
import { serialize } from "node:v8"
import type { HarnessKnowledgePreviewResult } from "../../shared/harness-board-types"
import type { PluginMetadata } from "../types"
import {
  HARNESS_KNOWLEDGE_PREVIEW_MAX_DEPTH,
  HARNESS_KNOWLEDGE_PREVIEW_MAX_DIRENTS,
  HARNESS_KNOWLEDGE_PREVIEW_MAX_DIRECTORIES,
  HARNESS_KNOWLEDGE_PREVIEW_MAX_DIRECTORY_ENTRIES,
  HARNESS_KNOWLEDGE_PREVIEW_MAX_FILES,
  type HarnessKnowledgePreviewSource
} from "./knowledge-preview-protocol"

const BOARD_CONFIG_REL_PATH = join("board_core", "board_config.json")
const APP_BOARD_API_VERSION = 1
const MAX_PLUGIN_STORE_BYTES = 8 * 1024 * 1024
const MAX_BOARD_CONFIG_BYTES = 1024 * 1024
const MAX_LEAN_TOKEN_STORE_BYTES = 64 * 1024
const MAX_TEXT = 8_192

interface KnowledgeBoardConfig {
  apiVersion?: unknown
  inspectCommands?: unknown
}

interface PendingDirectory {
  fullPath: string
  relativePath: string
  depth: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function boundedText(value: unknown, max = MAX_TEXT): string {
  return typeof value === "string" ? value.slice(0, max) : ""
}

function throwIfCancelled(cancelFlag?: Int32Array): void {
  if (cancelFlag && Atomics.load(cancelFlag, 0) !== 0) {
    throw new DOMException("Harness knowledge preview was superseded", "AbortError")
  }
}

function readBoundedJson(path: string, maxBytes: number, label: string): unknown {
  if (!existsSync(path)) return null
  const stats = statSync(path)
  if (!stats.isFile()) return null
  if (stats.size > maxBytes) throw new Error(`${label} exceeded ${maxBytes} bytes`)
  return JSON.parse(readFileSync(path, "utf8")) as unknown
}

function readPlugins(path: string): PluginMetadata[] {
  const parsed = readBoundedJson(path, MAX_PLUGIN_STORE_BYTES, "Harness plugin store")
  if (!Array.isArray(parsed)) return []
  return parsed
    .slice(0, 10_000)
    .filter(
      (row): row is PluginMetadata =>
        isRecord(row) &&
        typeof row.id === "string" &&
        typeof row.name === "string" &&
        typeof row.path === "string"
    )
}

function readBoardConfig(pluginPath: string): KnowledgeBoardConfig | null {
  const parsed = readBoundedJson(
    join(pluginPath, BOARD_CONFIG_REL_PATH),
    MAX_BOARD_CONFIG_BYTES,
    "Harness board config"
  )
  return isRecord(parsed) ? parsed : null
}

function readLeanToken(path: string): string {
  try {
    const parsed = readBoundedJson(path, MAX_LEAN_TOKEN_STORE_BYTES, "Harness lean token store")
    return isRecord(parsed) ? boundedText(parsed.leanToken, MAX_TEXT).trim() : ""
  } catch {
    return ""
  }
}

function adapterMatches(plugin: PluginMetadata, adapterId: string): boolean {
  return plugin.id === adapterId || plugin.name === adapterId || basename(plugin.path) === adapterId
}

function isPathInside(parent: string, child: string): boolean {
  const relativePath = relative(parent, child)
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !isAbsolute(relativePath))
  )
}

function knowledgePathTemplate(config: KnowledgeBoardConfig | null): string {
  if (!config || !isRecord(config.inspectCommands)) return ""
  const platform = config.inspectCommands[process.platform]
  if (!isRecord(platform)) return ""
  return boundedText(platform.knowledge_path).trim()
}

function resolveKnowledgePath(
  template: string,
  plugin: PluginMetadata,
  source: HarnessKnowledgePreviewSource
): string {
  const replacements: Record<string, string> = {
    pluginWorkspace: source.openworkDir,
    project: "project-constraints",
    projectDir: "project-constraints",
    projectCode: plugin.id,
    leanToken: readLeanToken(source.leanTokenStorePath),
    feature: "",
    selectedDeployUnits: "",
    sessionWorkspacePath: "",
    pluginPath: plugin.path,
    mode: "pullKnowledge",
    workflowTemplate: "",
    workflowNodes: "",
    nodeId: ""
  }
  const replaced = template.replace(
    /\$\{(pluginWorkspace|project|projectDir|projectCode|leanToken|feature|selectedDeployUnits|sessionWorkspacePath|pluginPath|mode|workflowTemplate|workflowNodes|nodeId)\}/g,
    (_placeholder, key: string) => replacements[key] ?? ""
  )
  return isAbsolute(replaced) ? resolve(replaced) : resolve(plugin.path, replaced)
}

function formatError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.slice(0, 1_024)
}

function entryOrder(left: Dirent, right: Dirent): number {
  if (left.isDirectory() && !right.isDirectory()) return -1
  if (!left.isDirectory() && right.isDirectory()) return 1
  return left.name.localeCompare(right.name)
}

function appendError(existing: string | undefined, next: string): string {
  return existing ? `${existing}；${next}`.slice(0, 4_096) : next.slice(0, 4_096)
}

function boundResponse(
  result: HarnessKnowledgePreviewResult,
  maxResponseBytes: number
): HarnessKnowledgePreviewResult {
  const budget = Math.max(64 * 1024, maxResponseBytes)
  if (serialize(result).byteLength <= budget) return result

  let low = 0
  let high = result.files.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    const candidate = {
      ...result,
      files: result.files.slice(0, middle),
      error: appendError(result.error, "知识库文件较多，预览结果已按传输预算截断")
    }
    if (serialize(candidate).byteLength <= budget) low = middle
    else high = middle - 1
  }
  return {
    ...result,
    files: result.files.slice(0, low),
    error: appendError(result.error, "知识库文件较多，预览结果已按传输预算截断")
  }
}

function scanKnowledgeFiles(
  rootPath: string,
  cancelFlag?: Int32Array
): Pick<HarnessKnowledgePreviewResult, "files" | "error"> {
  const files: HarnessKnowledgePreviewResult["files"] = []
  const pending: PendingDirectory[] = [{ fullPath: rootPath, relativePath: "", depth: 0 }]
  let pendingIndex = 0
  let scannedDirectories = 0
  let scannedDirents = 0
  let error: string | undefined
  let truncated = false

  while (pendingIndex < pending.length && files.length < HARNESS_KNOWLEDGE_PREVIEW_MAX_FILES) {
    throwIfCancelled(cancelFlag)
    if (scannedDirectories >= HARNESS_KNOWLEDGE_PREVIEW_MAX_DIRECTORIES) {
      truncated = true
      break
    }
    const directory = pending[pendingIndex++]!
    scannedDirectories += 1
    const entries: Dirent[] = []
    let handle: ReturnType<typeof opendirSync> | null = null
    try {
      handle = opendirSync(directory.fullPath)
      let entriesRead = 0
      while (
        entriesRead < HARNESS_KNOWLEDGE_PREVIEW_MAX_DIRECTORY_ENTRIES &&
        scannedDirents < HARNESS_KNOWLEDGE_PREVIEW_MAX_DIRENTS
      ) {
        throwIfCancelled(cancelFlag)
        const entry = handle.readSync()
        if (!entry) break
        entriesRead += 1
        scannedDirents += 1
        if (entry.name.startsWith(".") || (entry.isDirectory() && entry.name === "node_modules")) {
          continue
        }
        entries.push(entry)
      }
      if (
        entriesRead >= HARNESS_KNOWLEDGE_PREVIEW_MAX_DIRECTORY_ENTRIES ||
        scannedDirents >= HARNESS_KNOWLEDGE_PREVIEW_MAX_DIRENTS
      ) {
        truncated = true
      }
    } catch (scanError) {
      error = appendError(
        error,
        `${directory.fullPath}: ${formatError(scanError)}`
      )
      continue
    } finally {
      try {
        handle?.closeSync()
      } catch {
        // The directory can already be closed after reaching EOF.
      }
    }

    entries.sort(entryOrder)
    for (const entry of entries) {
      throwIfCancelled(cancelFlag)
      if (files.length >= HARNESS_KNOWLEDGE_PREVIEW_MAX_FILES) {
        truncated = true
        break
      }
      const relativePath = directory.relativePath
        ? `${directory.relativePath}/${entry.name}`
        : entry.name
      if (relativePath.length > MAX_TEXT) {
        truncated = true
        continue
      }
      const fullPath = join(directory.fullPath, entry.name)
      if (entry.isDirectory()) {
        files.push({ path: `/${relativePath}`, is_dir: true })
        if (directory.depth < HARNESS_KNOWLEDGE_PREVIEW_MAX_DEPTH) {
          pending.push({
            fullPath,
            relativePath,
            depth: directory.depth + 1
          })
        } else {
          truncated = true
        }
        continue
      }

      try {
        const stats = statSync(fullPath)
        if (!stats.isFile()) continue
        files.push({
          path: `/${relativePath}`,
          is_dir: false,
          size: stats.size,
          modified_at: stats.mtime.toISOString()
        })
      } catch (statError) {
        error = appendError(error, `${fullPath}: ${formatError(statError)}`)
      }
    }
  }

  if (pendingIndex < pending.length || files.length >= HARNESS_KNOWLEDGE_PREVIEW_MAX_FILES) {
    truncated = true
  }
  if (truncated) {
    error = appendError(error, "知识库文件较多，仅显示有界预览；请缩小知识目录后重试")
  }
  return { files, ...(error ? { error } : {}) }
}

export function readHarnessKnowledgePreview(
  adapterId: string,
  source: HarnessKnowledgePreviewSource,
  maxResponseBytes: number,
  cancelFlag?: Int32Array
): HarnessKnowledgePreviewResult {
  throwIfCancelled(cancelFlag)
  const normalizedAdapterId = boundedText(adapterId, 512).trim()
  const plugin = readPlugins(source.pluginStorePath).find(
    (candidate) => adapterMatches(candidate, normalizedAdapterId)
  )
  if (!plugin) throw new Error("插件未安装或不支持项目模式")

  throwIfCancelled(cancelFlag)
  const config = readBoardConfig(plugin.path)
  if (!config) throw new Error("插件未提供项目看板配置")
  const apiVersion = Number(config.apiVersion)
  if (!Number.isInteger(apiVersion) || apiVersion !== APP_BOARD_API_VERSION) {
    throw new Error("插件与当前客户端的项目看板 API 版本不兼容")
  }

  const resultBase = {
    adapterId: boundedText(plugin.id, 512),
    adapterName: boundedText(plugin.name, 1_024)
  }
  const template = knowledgePathTemplate(config)
  if (!template) {
    return { ...resultBase, configured: false, exists: false, files: [] }
  }

  const knowledgePath = resolveKnowledgePath(template, plugin, source)
  const pluginRoot = resolve(plugin.path)
  if (!isPathInside(pluginRoot, knowledgePath)) {
    return {
      ...resultBase,
      configured: true,
      exists: false,
      files: [],
      error: "外部 knowledge_path 未经用户授权；请将知识目录放在插件目录内"
    }
  }
  throwIfCancelled(cancelFlag)
  if (!existsSync(knowledgePath)) {
    return {
      ...resultBase,
      configured: true,
      exists: false,
      path: knowledgePath,
      files: []
    }
  }

  try {
    const [realPluginRoot, realKnowledgePath] = [
      realpathSync(pluginRoot),
      realpathSync(knowledgePath)
    ]
    if (!isPathInside(realPluginRoot, realKnowledgePath)) {
      return {
        ...resultBase,
        configured: true,
        exists: false,
        files: [],
        error: "knowledge_path 的符号链接目标超出插件目录"
      }
    }
    const stats = statSync(knowledgePath)
    if (!stats.isDirectory()) {
      return {
        ...resultBase,
        configured: true,
        exists: false,
        path: knowledgePath,
        files: [],
        error: "knowledge_path 不是目录"
      }
    }
  } catch (error) {
    return {
      ...resultBase,
      configured: true,
      exists: false,
      path: knowledgePath,
      files: [],
      error: `无法读取 knowledge_path：${formatError(error)}`
    }
  }

  const scanned = scanKnowledgeFiles(knowledgePath, cancelFlag)
  throwIfCancelled(cancelFlag)
  return boundResponse(
    {
      ...resultBase,
      configured: true,
      exists: true,
      path: knowledgePath,
      files: scanned.files,
      ...(scanned.error ? { error: scanned.error } : {})
    },
    maxResponseBytes
  )
}
