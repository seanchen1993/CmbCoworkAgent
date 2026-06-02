import { existsSync, readFileSync, statSync } from "fs"
import { isAbsolute, join, relative, resolve } from "path"
import micromatch from "micromatch"
import { getPlugins } from "../storage"
import { normalizePluginRelativePath, readPluginManifest } from "../plugins/manifest"
import type {
  BackgroundJobDefinition,
  BackgroundJobError,
  BackgroundJobsManifest,
  BackgroundJobScope,
  BackgroundModelJobRequest
} from "../../shared/plugin-model-jobs"
import { isSafeJobId, resolveWorkspacePath } from "./plugin-model-job-store"

export interface ResolvedBackgroundJobDefinition {
  pluginId: string
  pluginName: string
  pluginRoot: string
  definition: BackgroundJobDefinition
}

export interface ValidatedBackgroundJob {
  plugin: ResolvedBackgroundJobDefinition
  promptFile: string
  promptFileRequestPath: string
  inputFiles: string[]
  inputFileRequestPaths: string[]
  outputFiles: Array<{
    absolutePath: string
    relativePath: string
    mode: "create" | "overwrite" | "append"
    contentType?: string
  }>
  timeoutMs: number
  maxOutputTokens?: number
  modelId?: string
}

export class BackgroundJobValidationError extends Error {
  readonly code: string
  readonly details?: unknown

  constructor(code: string, message: string, details?: unknown) {
    super(message)
    this.name = "BackgroundJobValidationError"
    this.code = code
    this.details = details
  }

  toJobError(): BackgroundJobError {
    return { code: this.code, message: this.message, details: this.details }
  }
}

const DEFAULT_TIMEOUT_MS = 180_000
const MAX_TIMEOUT_MS = 10 * 60_000
const MAX_OUTPUT_TOKENS = 16_384
const MAX_PROMPT_FILE_BYTES = 512 * 1024
const MAX_INPUT_FILE_BYTES = 1024 * 1024
const MAX_TOTAL_INPUT_BYTES = 2 * 1024 * 1024

function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, "/")
}

function isInside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target))
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

function safeReadJson<T>(filePath: string): T | null {
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as T
  } catch (error) {
    console.warn("[PluginModelJobs] Failed to parse background jobs manifest", filePath, error)
    return null
  }
}

function normalizeScope(scope: unknown): BackgroundJobScope | null {
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) return null
  const obj = scope as Record<string, unknown>
  if (typeof obj.name !== "string" || !obj.name.trim()) return null
  if (typeof obj.root !== "string" || !obj.root.trim()) return null
  return {
    name: obj.name.trim(),
    root: obj.root.trim(),
    patterns: Array.isArray(obj.patterns)
      ? obj.patterns.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
      : undefined,
    risk: obj.risk === "low" || obj.risk === "medium" || obj.risk === "high" ? obj.risk : undefined,
    requiresApproval: typeof obj.requiresApproval === "boolean" ? obj.requiresApproval : undefined
  }
}

function normalizeJobDefinition(raw: unknown): BackgroundJobDefinition | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>
  if (typeof obj.type !== "string" || !obj.type.trim()) return null
  const defaults = obj.defaults && typeof obj.defaults === "object" && !Array.isArray(obj.defaults)
    ? obj.defaults as Record<string, unknown>
    : undefined
  return {
    type: obj.type.trim(),
    description: typeof obj.description === "string" ? obj.description : undefined,
    modelAccess: typeof obj.modelAccess === "boolean" ? obj.modelAccess : undefined,
    readScopes: Array.isArray(obj.readScopes)
      ? obj.readScopes.map(normalizeScope).filter(Boolean) as BackgroundJobScope[]
      : [],
    writeScopes: Array.isArray(obj.writeScopes)
      ? obj.writeScopes.map(normalizeScope).filter(Boolean) as BackgroundJobScope[]
      : [],
    defaults: defaults
      ? {
          timeoutMs: typeof defaults.timeoutMs === "number" ? defaults.timeoutMs : undefined,
          maxOutputTokens: typeof defaults.maxOutputTokens === "number" ? defaults.maxOutputTokens : undefined,
          modelId: typeof defaults.modelId === "string" ? defaults.modelId : undefined
        }
      : undefined
  }
}

function normalizeJobsManifest(raw: unknown): BackgroundJobsManifest | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>
  if (obj.schemaVersion !== 1 || !Array.isArray(obj.jobs)) return null
  const jobs = obj.jobs.map(normalizeJobDefinition).filter(Boolean) as BackgroundJobDefinition[]
  return { schemaVersion: 1, jobs }
}

export function loadBackgroundJobDefinitions(): ResolvedBackgroundJobDefinition[] {
  const result: ResolvedBackgroundJobDefinition[] = []
  for (const plugin of getPlugins().filter((item) => item.enabled)) {
    const manifest = readPluginManifest(plugin.path)?.manifest ?? null
    const declaredPath = normalizePluginRelativePath(manifest?.backgroundJobs)
    if (!declaredPath) continue
    const manifestPath = join(plugin.path, declaredPath)
    if (!existsSync(manifestPath)) continue
    const manifestJson = normalizeJobsManifest(safeReadJson<unknown>(manifestPath))
    if (!manifestJson) continue
    for (const definition of manifestJson.jobs) {
      result.push({
        pluginId: plugin.id,
        pluginName: plugin.name,
        pluginRoot: plugin.path,
        definition
      })
    }
  }
  return result
}

function findDefinition(pluginId: string, type: string): ResolvedBackgroundJobDefinition | null {
  return loadBackgroundJobDefinitions().find((item) => item.pluginId === pluginId && item.definition.type === type) ?? null
}

function resolveScopeRoot(workspace: string, scope: BackgroundJobScope): string | null {
  return resolveWorkspacePath(workspace, scope.root)
}

function pathMatchesScope(
  workspace: string,
  pathValue: string,
  scope: BackgroundJobScope
): { ok: boolean; absolutePath?: string; relativeToScope?: string } {
  const target = resolveWorkspacePath(workspace, pathValue)
  const scopeRoot = resolveScopeRoot(workspace, scope)
  if (!target || !scopeRoot || !isInside(scopeRoot, target)) return { ok: false }
  const relativeToScope = normalizeSlashes(relative(scopeRoot, target)) || ""
  const patterns = scope.patterns?.length ? scope.patterns : ["**/*"]
  const matchTarget = relativeToScope || "."
  const ok = micromatch.isMatch(matchTarget, patterns, { dot: true })
  return { ok, absolutePath: target, relativeToScope }
}

function assertReadablePath(workspace: string, pathValue: string, scopes: BackgroundJobScope[], label: string): string {
  for (const scope of scopes) {
    const match = pathMatchesScope(workspace, pathValue, scope)
    if (match.ok && match.absolutePath) return match.absolutePath
  }
  throw new BackgroundJobValidationError("READ_SCOPE_DENIED", `${label} 不在 readScopes 内`, { path: pathValue })
}

function assertWritablePath(workspace: string, pathValue: string, scopeName: string, scopes: BackgroundJobScope[]): string {
  const scope = scopes.find((item) => item.name === scopeName)
  if (!scope) {
    throw new BackgroundJobValidationError("WRITE_SCOPE_UNKNOWN", `未注册 writeScope: ${scopeName}`, {
      scope: scopeName,
      path: pathValue
    })
  }
  if (scope.risk && scope.risk !== "low") {
    throw new BackgroundJobValidationError("WRITE_SCOPE_REQUIRES_APPROVAL", `writeScope ${scopeName} 需要用户授权`, {
      scope: scopeName,
      risk: scope.risk
    })
  }
  if (scope.requiresApproval) {
    throw new BackgroundJobValidationError("WRITE_SCOPE_REQUIRES_APPROVAL", `writeScope ${scopeName} 需要用户授权`, {
      scope: scopeName
    })
  }
  const match = pathMatchesScope(workspace, pathValue, scope)
  if (!match.ok || !match.absolutePath) {
    throw new BackgroundJobValidationError("OUTPUT_SCOPE_DENIED", `输出路径不在 writeScope: ${scopeName} 内`, {
      path: pathValue,
      scope: scopeName
    })
  }
  return match.absolutePath
}

function normalizeTimeout(value: number | undefined, fallback: number | undefined): number {
  const candidate = typeof value === "number" && Number.isFinite(value) ? value : fallback
  if (typeof candidate !== "number" || !Number.isFinite(candidate)) return DEFAULT_TIMEOUT_MS
  return Math.max(1_000, Math.min(Math.floor(candidate), MAX_TIMEOUT_MS))
}

function normalizeMaxOutputTokens(value: number | undefined, fallback: number | undefined): number | undefined {
  const candidate = typeof value === "number" && Number.isFinite(value) ? value : fallback
  if (typeof candidate !== "number" || !Number.isFinite(candidate)) return undefined
  return Math.max(1, Math.min(Math.floor(candidate), MAX_OUTPUT_TOKENS))
}

function assertFileSize(filePath: string, maxBytes: number, label: string): number {
  const size = statSync(filePath).size
  if (size > maxBytes) {
    throw new BackgroundJobValidationError("INPUT_TOO_LARGE", `${label} 超过大小限制`, {
      path: filePath,
      size,
      maxBytes
    })
  }
  return size
}

function assertInputSizeLimits(promptFile: string, inputFiles: string[]): void {
  let totalBytes = assertFileSize(promptFile, MAX_PROMPT_FILE_BYTES, "promptFile")
  for (let index = 0; index < inputFiles.length; index++) {
    totalBytes += assertFileSize(inputFiles[index], MAX_INPUT_FILE_BYTES, `inputFiles[${index}]`)
    if (totalBytes > MAX_TOTAL_INPUT_BYTES) {
      throw new BackgroundJobValidationError("INPUT_TOO_LARGE", "后台任务输入总量超过大小限制", {
        size: totalBytes,
        maxBytes: MAX_TOTAL_INPUT_BYTES
      })
    }
  }
}

export function validateBackgroundJobRequest(request: BackgroundModelJobRequest): ValidatedBackgroundJob {
  if (!request || typeof request !== "object") {
    throw new BackgroundJobValidationError("INVALID_REQUEST", "job request 不是对象")
  }
  if (request.schemaVersion !== 1) throw new BackgroundJobValidationError("INVALID_SCHEMA_VERSION", "不支持的 job schemaVersion")
  if (typeof request.jobId !== "string" || !isSafeJobId(request.jobId)) throw new BackgroundJobValidationError("INVALID_JOB_ID", "jobId 格式无效")
  if (typeof request.pluginId !== "string" || !request.pluginId.trim()) throw new BackgroundJobValidationError("INVALID_PLUGIN_ID", "pluginId 不能为空")
  if (typeof request.type !== "string" || !request.type.trim()) throw new BackgroundJobValidationError("INVALID_JOB_TYPE", "type 不能为空")
  if (typeof request.workspace !== "string" || !request.workspace.trim() || !isAbsolute(request.workspace)) throw new BackgroundJobValidationError("INVALID_WORKSPACE", "workspace 必须是绝对路径")
  if (typeof request.promptFile !== "string" || !request.promptFile.trim()) throw new BackgroundJobValidationError("INVALID_PROMPT_FILE", "promptFile 不能为空")
  if (!Array.isArray(request.outputs) || request.outputs.length === 0) throw new BackgroundJobValidationError("INVALID_OUTPUTS", "outputs 不能为空")

  const plugin = findDefinition(request.pluginId, request.type)
  if (!plugin) throw new BackgroundJobValidationError("JOB_TYPE_NOT_REGISTERED", "插件未注册该后台任务类型", { pluginId: request.pluginId, type: request.type })
  if (!plugin.definition.modelAccess) throw new BackgroundJobValidationError("MODEL_ACCESS_DENIED", "该后台任务未声明 modelAccess")

  const readScopes = plugin.definition.readScopes ?? []
  const writeScopes = plugin.definition.writeScopes ?? []
  const promptFile = assertReadablePath(request.workspace, request.promptFile, readScopes, "promptFile")
  const inputFiles = (request.inputFiles ?? []).map((item, index) =>
    assertReadablePath(request.workspace, item, readScopes, `inputFiles[${index}]`)
  )
  assertInputSizeLimits(promptFile, inputFiles)
  const outputFiles = request.outputs.map((output) => {
    if (!output || typeof output.path !== "string" || !output.path.trim()) {
      throw new BackgroundJobValidationError("INVALID_OUTPUT_PATH", "output.path 不能为空")
    }
    if (typeof output.scope !== "string" || !output.scope.trim()) {
      throw new BackgroundJobValidationError("INVALID_OUTPUT_SCOPE", "output.scope 不能为空", { path: output.path })
    }
    const absolutePath = assertWritablePath(request.workspace, output.path, output.scope, writeScopes)
    return {
      absolutePath,
      relativePath: normalizeSlashes(relative(resolve(request.workspace), absolutePath)),
      mode: output.mode === "create" || output.mode === "append" || output.mode === "overwrite" ? output.mode : "overwrite",
      contentType: output.contentType
    }
  })

  return {
    plugin,
    promptFile,
    promptFileRequestPath: request.promptFile,
    inputFiles,
    inputFileRequestPaths: request.inputFiles ?? [],
    outputFiles,
    timeoutMs: normalizeTimeout(request.timeoutMs, plugin.definition.defaults?.timeoutMs),
    maxOutputTokens: normalizeMaxOutputTokens(request.maxOutputTokens, plugin.definition.defaults?.maxOutputTokens),
    modelId: request.modelId ?? plugin.definition.defaults?.modelId
  }
}
