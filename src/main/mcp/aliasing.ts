import type {
  McpCapabilityAliasMaps,
  McpCapabilityTool,
  McpFallbackPolicy,
  McpSourceKind,
  McpSourceScope,
  McpToolVisibility
} from "./capability-types"

export interface McpCapabilitySeed {
  capabilityId: string
  providerKey: string
  providerDisplayName: string
  toolName: string
  description?: string
  inputSchema?: Record<string, unknown>
  outputSchema?: Record<string, unknown>
  visibility: McpToolVisibility
  sourceKind?: McpSourceKind
  scope?: McpSourceScope
  priority?: number
  pluginId?: string
  fallback?: McpFallbackPolicy
}

const RESERVED_HELPER_NAMES = new Set(["$call", "$meta"])
const MCP_TOOL_PREFIX = "mcp"

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

function toOptionalLowerCamelCase(value: string): string {
  const tokens = splitIntoTokens(value)
  if (tokens.length === 0) return ""

  const [first, ...rest] = tokens
  return ensureIdentifier([
    first.toLowerCase(),
    ...rest.map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
  ].join(""), "")
}

function toSnakeCase(value: string, fallback: string): string {
  const tokens = splitIntoTokens(value)
  if (tokens.length === 0) return fallback
  return ensureIdentifier(tokens.map((part) => part.toLowerCase()).join("_"), fallback)
}

function makeUniqueAlias(baseAlias: string, used: Set<string>, fallback: string): string {
  const sanitizedBase = ensureIdentifier(baseAlias, fallback)
  let candidate = sanitizedBase
  let suffix = 2

  while (used.has(candidate) || RESERVED_HELPER_NAMES.has(candidate)) {
    candidate = `${sanitizedBase}_${suffix}`
    suffix += 1
  }

  used.add(candidate)
  return candidate
}

function sourceRank(tool: Pick<McpCapabilityTool, "sourceKind">): number {
  return tool.sourceKind === "connector" ? 1 : 0
}

export function toMcpToolId(providerAlias: string, displayMethodAlias: string): string {
  const normalizedProviderAlias = providerAlias.trim()
    ? ensureIdentifier(providerAlias, "provider")
    : ""
  const normalizedMethodAlias = ensureIdentifier(displayMethodAlias, "tool")
  return normalizedProviderAlias
    ? `${MCP_TOOL_PREFIX}__${normalizedProviderAlias}__${normalizedMethodAlias}`
    : `${MCP_TOOL_PREFIX}__${normalizedMethodAlias}`
}

export function buildCapabilityAliases(seeds: McpCapabilitySeed[]): McpCapabilityTool[] {
  const providerAliasByKey = new Map<string, string>()
  const usedProviderAliases = new Set<string>()

  const uniqueProviders = Array.from(
    new Map(seeds.map((seed) => [seed.providerKey, seed.providerDisplayName])).entries()
  ).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))

  for (const [providerKey, providerDisplayName] of uniqueProviders) {
    const optionalAlias = toOptionalLowerCamelCase(providerDisplayName)
    if (!optionalAlias) {
      providerAliasByKey.set(providerKey, "")
      continue
    }

    providerAliasByKey.set(
      providerKey,
      makeUniqueAlias(optionalAlias, usedProviderAliases, optionalAlias)
    )
  }

  const toolsByProvider = new Map<string, McpCapabilitySeed[]>()
  for (const seed of seeds) {
    const bucket = toolsByProvider.get(seed.providerKey)
    if (bucket) {
      bucket.push(seed)
    } else {
      toolsByProvider.set(seed.providerKey, [seed])
    }
  }

  const resolved = new Map<string, McpCapabilityTool>()
  const usedToolIds = new Set<string>()

  for (const [providerKey, providerTools] of Array.from(toolsByProvider.entries()).sort(
    ([left], [right]) => left.localeCompare(right)
  )) {
    const providerAlias = providerAliasByKey.get(providerKey) ?? ""
    const usedDisplayAliases = new Set<string>()

    for (const seed of [...providerTools].sort((left, right) => {
      if (left.toolName === right.toolName) {
        return left.capabilityId.localeCompare(right.capabilityId)
      }
      return left.toolName.localeCompare(right.toolName)
    })) {
      const baseDisplayMethodAlias = makeUniqueAlias(
        toSnakeCase(seed.toolName, "tool"),
        usedDisplayAliases,
        "tool"
      )
      let displayMethodAlias = baseDisplayMethodAlias
      let toolId = toMcpToolId(providerAlias, displayMethodAlias)
      let suffix = 2

      while (usedToolIds.has(toolId)) {
        displayMethodAlias = `${baseDisplayMethodAlias}_${suffix}`
        toolId = toMcpToolId(providerAlias, displayMethodAlias)
        suffix += 1
      }

      usedToolIds.add(toolId)

      resolved.set(seed.capabilityId, {
        capabilityId: seed.capabilityId,
        toolId,
        canonicalToolId: toolId,
        providerKey: seed.providerKey,
        providerAlias,
        providerDisplayName: seed.providerDisplayName,
        toolName: seed.toolName,
        description: seed.description,
        inputSchema: seed.inputSchema,
        outputSchema: seed.outputSchema,
        visibility: seed.visibility,
        sourceKind: seed.sourceKind,
        scope: seed.scope,
        priority: seed.priority,
        pluginId: seed.pluginId,
        fallback: seed.fallback
      })
    }
  }

  return seeds
    .map((seed) => resolved.get(seed.capabilityId))
    .filter((tool): tool is McpCapabilityTool => Boolean(tool))
}

export function buildAliasMaps(tools: McpCapabilityTool[]): McpCapabilityAliasMaps {
  const maps: McpCapabilityAliasMaps = {
    capabilityById: new Map(),
    toolIds: new Map(),
    canonicalToolIds: new Map()
  }

  for (const tool of tools) {
    maps.capabilityById.set(tool.capabilityId, tool)
    maps.toolIds.set(tool.toolId, tool)
    if (tool.canonicalToolId) {
      maps.canonicalToolIds.set(tool.canonicalToolId, tool)
    }
  }

  return maps
}

export function buildScopedToolAliases(
  tools: McpCapabilityTool[],
  getEffectivePriority: (tool: McpCapabilityTool) => number
): McpCapabilityTool[] {
  const byToolName = new Map<string, McpCapabilityTool[]>()
  for (const tool of tools) {
    const bucket = byToolName.get(tool.toolName)
    if (bucket) {
      bucket.push(tool)
    } else {
      byToolName.set(tool.toolName, [tool])
    }
  }

  const orderedGroups = Array.from(byToolName.entries()).sort(
    ([leftName, leftGroup], [rightName, rightGroup]) => {
      const leftAlias = toSnakeCase(leftName, "tool")
      const rightAlias = toSnakeCase(rightName, "tool")
      const aliasCompare = leftAlias.localeCompare(rightAlias)
      if (aliasCompare !== 0) return aliasCompare
      const nameCompare = leftName.localeCompare(rightName)
      if (nameCompare !== 0) return nameCompare
      const leftFirstId =
        [...leftGroup].sort((left, right) =>
          left.capabilityId.localeCompare(right.capabilityId)
        )[0]?.capabilityId ?? ""
      const rightFirstId =
        [...rightGroup].sort((left, right) =>
          left.capabilityId.localeCompare(right.capabilityId)
        )[0]?.capabilityId ?? ""
      return leftFirstId.localeCompare(rightFirstId)
    }
  )

  const usedToolIds = new Set<string>()
  const result: McpCapabilityTool[] = []
  for (const [toolName, group] of orderedGroups) {
    const ranked = [...group].sort((left, right) => {
      const priorityCompare = getEffectivePriority(right) - getEffectivePriority(left)
      if (priorityCompare !== 0) return priorityCompare
      const sourceCompare = sourceRank(right) - sourceRank(left)
      if (sourceCompare !== 0) return sourceCompare
      return left.capabilityId.localeCompare(right.capabilityId)
    })

    const shortAliasTool = ranked.find(
      (tool) => tool.visibility === "eager" && tool.sourceKind === "connector"
    )
    const shortBase = toMcpToolId("", toSnakeCase(toolName, "tool"))
    for (const tool of ranked) {
      const canonicalToolId = tool.canonicalToolId ?? tool.toolId
      let nextToolId = canonicalToolId
      if (
        group.length > 1 &&
        shortAliasTool?.capabilityId === tool.capabilityId &&
        !usedToolIds.has(shortBase)
      ) {
        nextToolId = shortBase
      }
      let suffix = 2
      while (usedToolIds.has(nextToolId)) {
        nextToolId = `${canonicalToolId}_${suffix}`
        suffix += 1
      }
      usedToolIds.add(nextToolId)
      result.push({
        ...tool,
        canonicalToolId,
        toolId: nextToolId,
        priority: getEffectivePriority(tool)
      })
    }
  }

  return result.sort((left, right) => {
    const priorityCompare = (right.priority ?? 0) - (left.priority ?? 0)
    if (priorityCompare !== 0) return priorityCompare
    return left.toolId.localeCompare(right.toolId)
  })
}
