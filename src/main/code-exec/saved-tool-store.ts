import { createHash } from "crypto"
import { existsSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"
import { getOpenworkDir } from "../storage"
import { CODE_EXEC_DEFAULT_TIMEOUT_MS } from "./constants"

const SAVED_CODE_EXEC_TOOLS_VERSION = 1
const SAVED_TOOL_PREFIX = "saved__"
const DEFAULT_TIMEOUT_MS = CODE_EXEC_DEFAULT_TIMEOUT_MS
const SAVED_TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]+$/

export interface SavedCodeExecTool {
  toolId: string
  enabled: boolean
  description: string
  inputSchema: Record<string, unknown>
  code: string
  timeoutMs: number
  createdAt: string
  updatedAt: string
  codeHash: string
  dependencies: string[]
  lastPreviewParams?: Record<string, unknown>
}

export interface SavedCodeExecToolDraft {
  toolId: string
  description: string
  inputSchema: Record<string, unknown>
  code: string
  timeoutMs: number
  codeHash: string
  dependencies: string[]
  lastPreviewParams?: Record<string, unknown>
}

interface SavedCodeExecToolsFile {
  version: number
  entries: SavedCodeExecTool[]
}

interface SavedCodeExecToolIdOptions {
  toolName: string
  codeHash: string
}

interface SavedToolQueryOptions {
  includeDisabled?: boolean
}

function getSavedCodeExecToolsPath(): string {
  return join(getOpenworkDir(), "code-exec-tools.json")
}

function createEmptyStore(): SavedCodeExecToolsFile {
  return {
    version: SAVED_CODE_EXEC_TOOLS_VERSION,
    entries: []
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

let storeCache: SavedCodeExecToolsFile | null = null

function loadStore(): SavedCodeExecToolsFile {
  if (storeCache) return storeCache

  const path = getSavedCodeExecToolsPath()
  if (!existsSync(path)) {
    storeCache = createEmptyStore()
    return storeCache
  }

  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown
    if (
      parsed &&
      typeof parsed === "object" &&
      (parsed as { version?: unknown }).version === SAVED_CODE_EXEC_TOOLS_VERSION &&
      Array.isArray((parsed as { entries?: unknown }).entries)
    ) {
      storeCache = {
        version: SAVED_CODE_EXEC_TOOLS_VERSION,
        entries: ((parsed as { entries: SavedCodeExecTool[] }).entries ?? [])
          .filter((entry) => {
            return Boolean(entry && typeof entry === "object" && typeof entry.toolId === "string")
          })
          .map((entry) => {
            const timeoutMs = Number.isInteger(entry.timeoutMs) ? entry.timeoutMs : DEFAULT_TIMEOUT_MS
            const code = typeof entry.code === "string" ? entry.code : ""

            return {
              toolId: entry.toolId,
              enabled: entry.enabled !== false,
              description: typeof entry.description === "string" ? entry.description : "",
              inputSchema: isRecord(entry.inputSchema) ? entry.inputSchema : {},
              code,
              timeoutMs,
              createdAt: typeof entry.createdAt === "string" ? entry.createdAt : "",
              updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : "",
              codeHash:
                typeof entry.codeHash === "string"
                  ? entry.codeHash
                  : computeSavedCodeExecToolHash(code, timeoutMs),
              dependencies: Array.isArray(entry.dependencies)
                ? entry.dependencies.filter((dependency): dependency is string => typeof dependency === "string")
                : [],
              lastPreviewParams: isRecord(entry.lastPreviewParams) ? entry.lastPreviewParams : undefined
            }
          })
      }

      return storeCache
    }
  } catch (error) {
    console.warn("[code_exec] failed to read saved tools:", error)
  }

  storeCache = createEmptyStore()
  return storeCache
}

function saveStore(store: SavedCodeExecToolsFile): void {
  store.version = SAVED_CODE_EXEC_TOOLS_VERSION
  writeFileSync(getSavedCodeExecToolsPath(), `${JSON.stringify(store, null, 2)}\n`)
}

export function computeSavedCodeExecToolHash(code: string, timeoutMs?: number): string {
  return createHash("sha256")
    .update(JSON.stringify({
      code,
      timeoutMs: timeoutMs ?? DEFAULT_TIMEOUT_MS
    }))
    .digest("hex")
}

function splitIntoTokens(value: string): string[] {
  const normalized = value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()

  return normalized
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean)
}

function ensureIdentifier(value: string, fallback: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9_]/g, "")
  const base = cleaned || fallback
  return /^[0-9]/.test(base) ? `_${base}` : base
}

function toSnakeCase(value: string, fallback: string): string {
  const tokens = splitIntoTokens(value)
  if (tokens.length === 0) return fallback
  return ensureIdentifier(tokens.map((part) => part.toLowerCase()).join("_"), fallback)
}

function inferSchema(value: unknown, depth = 0): Record<string, unknown> {
  if (depth >= 4) {
    return {}
  }

  if (value === null) {
    return { type: "null" }
  }

  switch (typeof value) {
    case "string":
      return { type: "string" }
    case "number":
      return { type: Number.isInteger(value) ? "integer" : "number" }
    case "boolean":
      return { type: "boolean" }
    case "object":
      break
    default:
      return {}
  }

  if (Array.isArray(value)) {
    const firstDefined = value.find((item) => item !== undefined)
    return firstDefined === undefined
      ? { type: "array" }
      : { type: "array", items: inferSchema(firstDefined, depth + 1) }
  }

  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  return {
    type: "object",
    properties: Object.fromEntries(keys.map((key) => [key, inferSchema(record[key], depth + 1)])),
    ...(keys.length > 0 ? { required: keys } : {})
  }
}

export function inferSavedCodeExecSchema(value: unknown): Record<string, unknown> {
  return inferSchema(value)
}

export function parseCodeExecDependencies(code: string): string[] {
  const matches = new Set<string>()
  const pattern = /mcp\.\$call\s*\(\s*(['"])([^"'\\]+)\1/g
  let match: RegExpExecArray | null

  while ((match = pattern.exec(code)) !== null) {
    matches.add(match[2])
  }

  return Array.from(matches)
}

function ensureUniqueToolId(baseSlug: string, store: SavedCodeExecToolsFile, codeHash: string): string {
  const existingByHash = store.entries.find((entry) => entry.codeHash === codeHash)
  if (existingByHash) return existingByHash.toolId

  const base = `${SAVED_TOOL_PREFIX}${ensureIdentifier(baseSlug, "workflow")}`
  let candidate = base
  let suffix = 2

  while (store.entries.some((entry) => entry.toolId === candidate)) {
    candidate = `${base}_${suffix}`
    suffix += 1
  }

  return candidate
}

export function getSavedCodeExecToolName(toolId: string): string {
  const normalized = toolId.replace(/^saved__?/i, "").trim()
  return normalized || toolId
}

export function validateSavedCodeExecToolName(toolName: string): string | null {
  const normalized = toolName.replace(/^saved__?/i, "").trim()

  if (!normalized) {
    return "tool_name 不能为空"
  }

  if (!SAVED_TOOL_NAME_PATTERN.test(normalized)) {
    return "tool_name 仅支持英文、数字、下划线(_)和短横线(-)，不能包含中文、空格或其他符号"
  }

  return null
}

export function resolveSavedCodeExecToolId(
  toolName: string,
  options?: { currentToolId?: string }
): string {
  const validationError = validateSavedCodeExecToolName(toolName)
  if (validationError) {
    throw new Error(validationError)
  }

  const store = loadStore()
  const normalizedToolName = toolName.replace(/^saved__?/i, "").trim()
  const baseSlug = toSnakeCase(normalizedToolName, "workflow")
  const candidate = `${SAVED_TOOL_PREFIX}${ensureIdentifier(baseSlug, "workflow")}`

  const conflict = store.entries.find(
    (entry) => entry.toolId === candidate && entry.toolId !== options?.currentToolId
  )
  if (conflict) {
    throw new Error(`工具 ID 已存在: ${candidate}`)
  }

  return candidate
}

export function parseCodeExecOutputValue(output: string): unknown {
  const trimmed = output.trim()
  if (!trimmed) return ""

  try {
    return JSON.parse(trimmed)
  } catch {
    return output
  }
}

function buildSavedCodeExecToolId(
  store: SavedCodeExecToolsFile,
  input: SavedCodeExecToolIdOptions
): string {
  const validationError = validateSavedCodeExecToolName(input.toolName)
  if (validationError) {
    throw new Error(validationError)
  }

  const normalizedToolName = input.toolName.replace(/^saved__?/i, "").trim()
  const baseSlug = toSnakeCase(normalizedToolName, "workflow")
  return ensureUniqueToolId(baseSlug, store, input.codeHash)
}

export function buildSavedCodeExecToolDraft(input: {
  toolName: string
  description: string
  inputSchema: Record<string, unknown>
  code: string
  timeoutMs?: number
  dependencies: string[]
  lastPreviewParams?: Record<string, unknown>
}): SavedCodeExecToolDraft {
  const store = loadStore()
  const codeHash = computeSavedCodeExecToolHash(input.code, input.timeoutMs)

  return {
    toolId: buildSavedCodeExecToolId(store, {
      toolName: input.toolName,
      codeHash
    }),
    description: input.description,
    inputSchema: input.inputSchema,
    code: input.code,
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    codeHash,
    dependencies: input.dependencies,
    lastPreviewParams: input.lastPreviewParams
  }
}

export function persistSavedCodeExecTool(draft: SavedCodeExecToolDraft): SavedCodeExecTool {
  const store = loadStore()
  const existingByHash = store.entries.find((entry) => entry.codeHash === draft.codeHash)
  if (existingByHash) {
    return existingByHash
  }

  const now = new Date().toISOString()
  const nextEntry: SavedCodeExecTool = {
    toolId: draft.toolId,
    enabled: false,
    description: draft.description,
    inputSchema: draft.inputSchema,
    code: draft.code,
    timeoutMs: draft.timeoutMs,
    createdAt: now,
    updatedAt: now,
    codeHash: draft.codeHash,
    dependencies: draft.dependencies,
    lastPreviewParams: draft.lastPreviewParams
  }

  store.entries.push(nextEntry)

  saveStore(store)
  return nextEntry
}

export function listSavedCodeExecTools(options?: SavedToolQueryOptions): SavedCodeExecTool[] {
  return [...loadStore().entries]
    .filter((entry) => options?.includeDisabled === true || entry.enabled !== false)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
}

export function getSavedCodeExecTool(idOrAlias: string, options?: SavedToolQueryOptions): SavedCodeExecTool | null {
  const normalized = idOrAlias.trim()
  if (!normalized) return null
  return listSavedCodeExecTools(options).find((entry) => entry.toolId === normalized) ?? null
}

export function getSavedCodeExecToolForCode(
  code: string,
  timeoutMs?: number,
  options?: SavedToolQueryOptions
): SavedCodeExecTool | null {
  const codeHash = computeSavedCodeExecToolHash(code, timeoutMs)
  return listSavedCodeExecTools(options).find((entry) => entry.codeHash === codeHash) ?? null
}

export function hasSavedCodeExecToolForCode(code: string, timeoutMs?: number): boolean {
  const codeHash = computeSavedCodeExecToolHash(code, timeoutMs)

  return loadStore().entries.some((entry) => entry.codeHash === codeHash)
}

export function replaceSavedCodeExecTool(
  currentToolId: string,
  nextEntry: SavedCodeExecTool
): SavedCodeExecTool {
  const store = loadStore()
  const index = store.entries.findIndex((entry) => entry.toolId === currentToolId)
  if (index < 0) {
    throw new Error(`工具不存在: ${currentToolId}`)
  }

  const toolIdConflict = store.entries.find(
    (entry, entryIndex) => entryIndex !== index && entry.toolId === nextEntry.toolId
  )
  if (toolIdConflict) {
    throw new Error(`工具 ID 已存在: ${nextEntry.toolId}`)
  }

  const codeHashConflict = store.entries.find(
    (entry, entryIndex) => entryIndex !== index && entry.codeHash === nextEntry.codeHash
  )
  if (codeHashConflict) {
    throw new Error(`已有相同代码的工具: ${codeHashConflict.toolId}`)
  }

  store.entries[index] = nextEntry
  saveStore(store)
  return nextEntry
}

export function deleteSavedCodeExecTool(toolId: string): void {
  const store = loadStore()
  const nextEntries = store.entries.filter((entry) => entry.toolId !== toolId)
  if (nextEntries.length === store.entries.length) return

  store.entries = nextEntries
  saveStore(store)
}

export function setSavedCodeExecToolEnabled(toolId: string, enabled: boolean): SavedCodeExecTool {
  const store = loadStore()
  const index = store.entries.findIndex((entry) => entry.toolId === toolId)
  if (index < 0) {
    throw new Error(`工具不存在: ${toolId}`)
  }

  const current = store.entries[index]
  const nextEntry: SavedCodeExecTool = {
    ...current,
    enabled,
    updatedAt: new Date().toISOString()
  }
  store.entries[index] = nextEntry
  saveStore(store)
  return nextEntry
}

export function setSavedCodeExecToolLastPreviewParams(
  toolId: string,
  params: Record<string, unknown>
): SavedCodeExecTool {
  const store = loadStore()
  const index = store.entries.findIndex((entry) => entry.toolId === toolId)
  if (index < 0) {
    throw new Error(`工具不存在: ${toolId}`)
  }

  const current = store.entries[index]
  const nextEntry: SavedCodeExecTool = {
    ...current,
    lastPreviewParams: params
  }
  store.entries[index] = nextEntry
  saveStore(store)
  return nextEntry
}
