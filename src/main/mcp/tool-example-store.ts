import { createHash } from "crypto"
import { existsSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"
import { getOpenworkDir } from "../storage"
import type { McpCapabilityTool, McpInvocationResult } from "./capability-types"
import { getMcpErrorMessage, getUsefulMcpResultData } from "./result-utils"

const MCP_TOOL_EXAMPLES_VERSION = 2
const MAX_STRING_LENGTH = 32
const MAX_ARRAY_ITEMS = 2
const MAX_OBJECT_KEYS = 12
const MAX_DEPTH = 4

const OMITTED_BASE64 = "<base64 omitted>"
const OMITTED_BLOB = "<blob omitted>"
const OMITTED_FILE_TEXT = "<file text omitted>"

interface StoredMcpToolExampleEntry {
  schemaHash: string
  updatedAt: string
  resultExample: unknown
}

interface McpToolExamplesFile {
  version: number
  entries: Record<string, StoredMcpToolExampleEntry>
}

function getMcpToolExamplesPath(): string {
  return join(getOpenworkDir(), "mcp-tool-examples.json")
}

function createEmptyStore(): McpToolExamplesFile {
  return {
    version: MCP_TOOL_EXAMPLES_VERSION,
    entries: {}
  }
}

let storeCache: McpToolExamplesFile | null = null

function loadStore(): McpToolExamplesFile {
  if (storeCache) return storeCache

  const path = getMcpToolExamplesPath()
  if (!existsSync(path)) {
    storeCache = createEmptyStore()
    return storeCache
  }

  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown
    if (
      parsed &&
      typeof parsed === "object" &&
      (parsed as { version?: unknown }).version === MCP_TOOL_EXAMPLES_VERSION &&
      (parsed as { entries?: unknown }).entries &&
      typeof (parsed as { entries?: unknown }).entries === "object"
    ) {
      storeCache = {
        version: (parsed as { version: number }).version,
        entries: { ...((parsed as { entries: Record<string, StoredMcpToolExampleEntry> }).entries ?? {}) }
      }
      return storeCache
    }
  } catch (error) {
    console.warn("[MCP] failed to read stored tool examples:", error)
  }

  storeCache = createEmptyStore()
  return storeCache
}

function saveStore(store: McpToolExamplesFile): void {
  store.version = MCP_TOOL_EXAMPLES_VERSION
  writeFileSync(getMcpToolExamplesPath(), `${JSON.stringify(store, null, 2)}\n`)
}

function normalizeForHash(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeForHash(item))
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    return Object.fromEntries(
      Object.keys(record)
        .sort((left, right) => left.localeCompare(right))
        .map((key) => [key, normalizeForHash(record[key])])
    )
  }

  return value ?? null
}

export function getToolSchemaHash(tool: Pick<McpCapabilityTool, "inputSchema" | "outputSchema">): string {
  const payload = JSON.stringify(normalizeForHash({
    inputSchema: tool.inputSchema ?? null,
    outputSchema: tool.outputSchema ?? null
  }))

  return createHash("sha256").update(payload).digest("hex").slice(0, 16)
}

function truncateString(value: string): string {
  if (value.length <= MAX_STRING_LENGTH) return value
  return `${value.slice(0, MAX_STRING_LENGTH)}...(${value.length} chars)`
}

function looksLikeBase64(value: string): boolean {
  if (value.length < 128 || value.length % 4 !== 0) return false
  return /^[A-Za-z0-9+/=\s]+$/.test(value)
}

function sanitizeString(
  value: string,
  key: string | undefined,
  parentType: string | undefined
): string {
  const normalizedKey = key?.toLowerCase()

  if (normalizedKey === "blob") return OMITTED_BLOB
  if (normalizedKey === "data" && looksLikeBase64(value)) return OMITTED_BASE64
  if (normalizedKey === "text" && (parentType === "resource" || parentType === "file")) {
    return OMITTED_FILE_TEXT
  }
  if (looksLikeBase64(value)) return OMITTED_BASE64

  return truncateString(value)
}

function sanitizeValue(
  value: unknown,
  context: {
    depth: number
    key?: string
    parentType?: string
  }
): unknown {
  if (value == null || typeof value === "boolean" || typeof value === "number") {
    return value
  }

  if (typeof value === "string") {
    return sanitizeString(value, context.key, context.parentType)
  }

  if (context.depth >= MAX_DEPTH) {
    if (Array.isArray(value)) {
      return `<array truncated at depth ${MAX_DEPTH}>`
    }
    return `<object truncated at depth ${MAX_DEPTH}>`
  }

  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => sanitizeValue(item, { depth: context.depth + 1, parentType: context.parentType }))

    if (value.length > MAX_ARRAY_ITEMS) {
      items.push(`<${value.length - MAX_ARRAY_ITEMS} more items>`)
    }

    return items
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>
    const parentType =
      typeof record.type === "string"
        ? record.type
        : context.parentType

    const entries = Object.keys(record)
      .slice(0, MAX_OBJECT_KEYS)
      .map((key) => [
        key,
        sanitizeValue(record[key], {
          depth: context.depth + 1,
          key,
          parentType
        })
      ] as const)

    if (Object.keys(record).length > MAX_OBJECT_KEYS) {
      entries.push(["__truncated_keys__", `<${Object.keys(record).length - MAX_OBJECT_KEYS} more keys>`])
    }

    return Object.fromEntries(entries)
  }

  return String(value)
}

export function sanitizeMcpExampleValue(value: unknown): unknown {
  return sanitizeValue(value, { depth: 0 })
}

function buildResultExample(result: McpInvocationResult): unknown {
  if (result.isError) {
    return {
      ok: false,
      error: sanitizeValue(getMcpErrorMessage(result), { depth: 0, key: "error" })
    }
  }

  return {
    ok: true,
    data: sanitizeValue(getUsefulMcpResultData(result), { depth: 0, key: "data" })
  }
}

export function recordSuccessfulToolExample(
  tool: McpCapabilityTool,
  result: McpInvocationResult
): void {
  if (result.isError) return

  const store = loadStore()
  store.entries[tool.capabilityId] = {
    schemaHash: getToolSchemaHash(tool),
    updatedAt: new Date().toISOString(),
    resultExample: buildResultExample(result)
  }
  saveStore(store)
}

export function getStoredToolExample(
  tool: Pick<McpCapabilityTool, "capabilityId" | "inputSchema" | "outputSchema">
): StoredMcpToolExampleEntry | null {
  const store = loadStore()
  const entry = store.entries[tool.capabilityId]
  if (!entry) return null

  if (entry.schemaHash !== getToolSchemaHash(tool)) {
    return null
  }

  return entry
}
