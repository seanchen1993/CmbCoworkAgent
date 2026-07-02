import type {
  McpConnectorConfig,
  McpConnectorUpsert,
  McpImportConfigRequest,
  McpImportConflictStrategy,
  McpImportPreviewConnector,
  McpImportPreviewResult
} from "../types"

export interface ParsedMcpImportConnector {
  sourceName: string
  connector: McpConnectorUpsert
  hasHeaders: boolean
  hasEnv: boolean
}

export interface ParsedMcpImportResult {
  connectors: ParsedMcpImportConnector[]
  errors: string[]
}

export type McpImportOperation =
  | {
      action: "create"
      connector: McpConnectorUpsert
      originalName: string
    }
  | {
      action: "update"
      connector: McpConnectorUpsert & { id: string }
      originalName: string
    }
  | {
      action: "skip"
      name: string
      reason: string
    }

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function normalizeStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined
  const result: Record<string, string> = {}
  for (const [key, entryValue] of Object.entries(value)) {
    if (typeof entryValue === "string") {
      result[key] = entryValue
    }
  }
  return Object.keys(result).length > 0 ? result : undefined
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === "string")
}

function normalizeTransport(value: unknown): "sse" | "streamable-http" | undefined {
  if (value === "sse") return "sse"
  if (value === "streamable-http" || value === "http") {
    return "streamable-http"
  }
  return undefined
}

function normalizeReconnect(
  value: unknown
): NonNullable<McpConnectorUpsert["advanced"]>["reconnect"] {
  if (!isRecord(value)) return undefined
  const enabled = typeof value.enabled === "boolean" ? value.enabled : undefined
  const maxAttempts =
    typeof value.maxAttempts === "number" && Number.isFinite(value.maxAttempts)
      ? value.maxAttempts
      : undefined
  const delayMs =
    typeof value.delayMs === "number" && Number.isFinite(value.delayMs) ? value.delayMs : undefined
  if (enabled === undefined && maxAttempts === undefined && delayMs === undefined) return undefined
  return { enabled, maxAttempts, delayMs }
}

function hasServerShape(value: Record<string, unknown>): boolean {
  return (
    typeof value.url === "string" ||
    typeof value.command === "string" ||
    (Array.isArray(value.command) && value.command.every((item) => typeof item === "string")) ||
    value.type === "stdio" ||
    value.type === "local" ||
    value.type === "remote" ||
    value.type === "sse" ||
    value.type === "http" ||
    value.type === "streamable-http"
  )
}

function extractServerEntries(
  root: Record<string, unknown>
): Array<[string, Record<string, unknown>]> {
  const mcpServers = isRecord(root.mcpServers) ? root.mcpServers : undefined
  if (mcpServers) {
    return Object.entries(mcpServers).filter((entry): entry is [string, Record<string, unknown>] =>
      isRecord(entry[1])
    )
  }

  const mcp = isRecord(root.mcp) ? root.mcp : undefined
  const nestedServers = mcp && isRecord(mcp.servers) ? mcp.servers : undefined
  if (nestedServers) {
    return Object.entries(nestedServers).filter(
      (entry): entry is [string, Record<string, unknown>] => isRecord(entry[1])
    )
  }

  const servers = isRecord(root.servers) ? root.servers : undefined
  if (servers) {
    return Object.entries(servers).filter((entry): entry is [string, Record<string, unknown>] =>
      isRecord(entry[1])
    )
  }

  if (hasServerShape(root)) {
    const name = typeof root.name === "string" && root.name.trim() ? root.name.trim() : "mcp"
    return [[name, root]]
  }

  return Object.entries(root).filter((entry): entry is [string, Record<string, unknown>] =>
    isRecord(entry[1])
  )
}

function normalizeConnector(
  sourceName: string,
  entry: Record<string, unknown>,
  autoEnable: boolean
): ParsedMcpImportConnector | string {
  const rawCommand = entry.command
  const commandArray =
    Array.isArray(rawCommand) &&
    rawCommand.every((item): item is string => typeof item === "string")
      ? rawCommand
      : null
  const command =
    typeof rawCommand === "string"
      ? rawCommand.trim()
      : commandArray && commandArray.length > 0
        ? commandArray[0].trim()
        : ""
  const commandArgs = commandArray ? commandArray.slice(1) : []
  const args = [...commandArgs, ...normalizeStringArray(entry.args)]
  const url = typeof entry.url === "string" ? entry.url.trim() : ""

  const typeTransport = normalizeTransport(entry.type)
  const explicitKind =
    entry.kind === "stdio" || entry.type === "stdio" || entry.type === "local"
      ? "stdio"
      : entry.kind === "remote" || entry.type === "remote" || typeTransport
        ? "remote"
        : undefined
  const kind = explicitKind ?? (command ? "stdio" : url ? "remote" : undefined)

  if (kind === "stdio" && !command) {
    return `跳过 ${sourceName}: stdio MCP 缺少 command`
  }
  if (kind === "remote" && !url) {
    return `跳过 ${sourceName}: remote MCP 缺少 url`
  }
  if (!kind) {
    return `跳过 ${sourceName}: 缺少 command 或 url`
  }

  const advancedEntry = isRecord(entry.advanced) ? entry.advanced : {}
  const headers = {
    ...(normalizeStringRecord(entry.headers) ?? {}),
    ...(normalizeStringRecord(advancedEntry.headers) ?? {})
  }
  const hasHeaders = Object.keys(headers).length > 0
  const transport =
    normalizeTransport(entry.transport) ??
    normalizeTransport(advancedEntry.transport) ??
    typeTransport
  const reconnect = normalizeReconnect(advancedEntry.reconnect ?? entry.reconnect)
  const env = {
    ...(normalizeStringRecord(entry.env) ?? {}),
    ...(normalizeStringRecord(entry.environment) ?? {})
  }
  const hasEnv = Object.keys(env).length > 0
  const name =
    typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : sourceName.trim()

  if (!name) {
    return `跳过 ${sourceName}: 名称不能为空`
  }

  if (kind === "stdio") {
    return {
      sourceName,
      hasHeaders: false,
      hasEnv,
      connector: {
        name,
        kind: "stdio",
        command,
        args,
        env: hasEnv ? env : undefined,
        enabled: autoEnable,
        lazyLoad: typeof entry.lazyLoad === "boolean" ? entry.lazyLoad : false
      }
    }
  }

  const advanced: McpConnectorUpsert["advanced"] = {}
  if (hasHeaders) advanced.headers = headers
  if (transport) advanced.transport = transport
  if (reconnect) advanced.reconnect = reconnect

  return {
    sourceName,
    hasHeaders,
    hasEnv: false,
    connector: {
      name,
      kind: "remote",
      url,
      advanced: Object.keys(advanced).length > 0 ? advanced : undefined,
      enabled: autoEnable,
      lazyLoad: typeof entry.lazyLoad === "boolean" ? entry.lazyLoad : false
    }
  }
}

export function parseMcpImportConfig(params: McpImportConfigRequest): ParsedMcpImportResult {
  const errors: string[] = []
  const rawJson = params.rawJson.trim()
  if (!rawJson) {
    return { connectors: [], errors: ["请粘贴 MCP JSON 配置"] }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(rawJson) as unknown
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { connectors: [], errors: [`JSON 格式无效: ${message}`] }
  }

  if (!isRecord(parsed)) {
    return { connectors: [], errors: ["MCP JSON 必须是对象"] }
  }

  const autoEnable = params.autoEnable ?? true
  const connectors: ParsedMcpImportConnector[] = []
  for (const [sourceName, entry] of extractServerEntries(parsed)) {
    const normalized = normalizeConnector(sourceName, entry, autoEnable)
    if (typeof normalized === "string") {
      errors.push(normalized)
    } else {
      connectors.push(normalized)
    }
  }

  if (connectors.length === 0 && errors.length === 0) {
    errors.push("未找到有效的 MCP server 配置")
  }

  return { connectors, errors }
}

function nameKey(name: string): string {
  return name.trim().toLowerCase()
}

function findExistingByName(
  connectors: McpConnectorConfig[],
  name: string
): McpConnectorConfig | undefined {
  const key = nameKey(name)
  return connectors.find((connector) => nameKey(connector.name) === key)
}

function makeUniqueName(baseName: string, reserved: Set<string>): string {
  const trimmedBase = baseName.trim() || "mcp"
  if (!reserved.has(nameKey(trimmedBase))) return trimmedBase
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${trimmedBase} ${suffix}`
    if (!reserved.has(nameKey(candidate))) return candidate
  }
  return `${trimmedBase} ${Date.now()}`
}

export function previewMcpImportConfig(
  params: McpImportConfigRequest,
  existingConnectors: McpConnectorConfig[]
): McpImportPreviewResult {
  const parsed = parseMcpImportConfig(params)
  const seen = new Set<string>()
  const connectors: McpImportPreviewConnector[] = parsed.connectors.map((item) => {
    const existing = findExistingByName(existingConnectors, item.connector.name)
    const key = nameKey(item.connector.name)
    const duplicate = seen.has(key)
    seen.add(key)

    return {
      name: item.connector.name,
      sourceName: item.sourceName,
      kind: item.connector.kind ?? (item.connector.command ? "stdio" : "remote"),
      url: item.connector.url,
      command: item.connector.command,
      args: item.connector.args,
      hasHeaders: item.hasHeaders,
      hasEnv: item.hasEnv,
      enabled: item.connector.enabled ?? true,
      lazyLoad: item.connector.lazyLoad ?? false,
      conflict: existing ? "existing" : duplicate ? "duplicate" : undefined,
      existingId: existing?.id
    }
  })

  return { connectors, errors: parsed.errors }
}

export function buildMcpImportOperations(params: {
  parsed: ParsedMcpImportConnector[]
  existingConnectors: McpConnectorConfig[]
  conflictStrategy?: McpImportConflictStrategy
}): McpImportOperation[] {
  const strategy = params.conflictStrategy ?? "rename"
  const initialByName = new Map<string, McpConnectorConfig>()
  for (const connector of params.existingConnectors) {
    initialByName.set(nameKey(connector.name), connector)
  }

  const reserved = new Set(initialByName.keys())
  const updatedExistingIds = new Set<string>()
  const operations: McpImportOperation[] = []

  for (const item of params.parsed) {
    const key = nameKey(item.connector.name)
    const existing = initialByName.get(key)

    if (existing && !updatedExistingIds.has(existing.id)) {
      if (strategy === "skip") {
        operations.push({
          action: "skip",
          name: item.connector.name,
          reason: "已存在同名 MCP 连接器"
        })
        continue
      }
      if (strategy === "update") {
        operations.push({
          action: "update",
          originalName: item.connector.name,
          connector: { ...item.connector, id: existing.id }
        })
        updatedExistingIds.add(existing.id)
        reserved.add(key)
        continue
      }
    }

    if (reserved.has(key)) {
      if (strategy === "skip") {
        operations.push({
          action: "skip",
          name: item.connector.name,
          reason: "导入内容中存在重复名称"
        })
        continue
      }

      const name = makeUniqueName(item.connector.name, reserved)
      reserved.add(nameKey(name))
      operations.push({
        action: "create",
        originalName: item.connector.name,
        connector: { ...item.connector, name }
      })
      continue
    }

    reserved.add(key)
    operations.push({
      action: "create",
      originalName: item.connector.name,
      connector: item.connector
    })
  }

  return operations
}
