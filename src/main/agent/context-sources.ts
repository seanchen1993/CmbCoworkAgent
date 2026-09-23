import type { FunctionSessionContextSources } from "../../shared/mods/v2/session"
import type { McpCapabilityTool } from "../mcp/capability-types"

export interface FunctionSessionContextSourceInput {
  memorySources?: readonly string[]
  skillSources?: readonly string[]
  pluginSkillSources?: readonly { sourceDir: string; pluginName?: string }[]
  mcpTools?: readonly Pick<McpCapabilityTool, "toolId" | "toolName" | "providerAlias">[]
  agents?: readonly { name: string; source: string; description: string }[]
  autoCompactThreshold?: number
  isAutoCompactEnabled?: boolean
}

export interface FunctionSessionContextRequest {
  state: Record<string, unknown>
  tools?: readonly unknown[]
}

export type FunctionSessionContextSourceResolver = (
  request: FunctionSessionContextRequest
) => FunctionSessionContextSources

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function pathKey(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "")
  return process.platform === "win32" ? normalized.toLowerCase() : normalized
}

function isInside(file: string, source: string): boolean {
  return pathKey(file).startsWith(`${pathKey(source)}/`)
}

/**
 * Read the exact memory/skill state already loaded by the production middleware.
 * Source allowlists are the main agent's enabled sources, not the global catalog.
 * No filesystem reads, MCP discovery, or guesses from tool name substrings occur here.
 * Counts estimate visible metadata; full skill bodies and child system prompts are not loaded.
 */
export function buildFunctionSessionContextSources(
  input: FunctionSessionContextSourceInput,
  request: FunctionSessionContextRequest
): FunctionSessionContextSources {
  const memoryContents = record(request.state.memoryContents)
  const memoryFiles = (input.memorySources ?? []).flatMap((path) => {
    const content = memoryContents?.[path]
    return typeof content === "string" && content.length > 0
      ? [{ path, type: "memory", tokens: estimateTokens(content) }]
      : []
  })
  const tools = new Map<string, Record<string, unknown>>()
  for (const tool of request.tools ?? []) {
    const raw = record(tool)
    const name = raw?.name ?? record(raw?.function)?.name
    if (raw && typeof name === "string") tools.set(name, raw)
  }
  const mcpTools = (input.mcpTools ?? []).map((tool) => ({
    name: tool.toolId,
    serverName: tool.providerAlias,
    tokens: tools.has(tool.toolId) ? estimateMetadataTokens(tools.get(tool.toolId)) : 0,
    isLoaded: tools.has(tool.toolId)
  }))
  const agents = (tools.has("task") ? (input.agents ?? []) : []).map((agent) => ({
    agentType: agent.name,
    source: agent.source,
    tokens: estimateTokens(`${agent.name}: ${agent.description}`)
  }))
  const skillFrontmatter = (
    Array.isArray(request.state.skillsMetadata) ? request.state.skillsMetadata : []
  ).flatMap((value) => {
    const skill = record(value)
    if (
      typeof skill?.name !== "string" ||
      typeof skill.path !== "string" ||
      typeof skill.description !== "string" ||
      !input.skillSources?.some((source) => isInside(String(skill.path), source))
    )
      return []
    const plugin = input.pluginSkillSources?.find((source) =>
      isInside(String(skill.path), source.sourceDir)
    )
    return [
      {
        name: skill.name,
        source: skill.path,
        ...(plugin?.pluginName ? { pluginName: plugin.pluginName } : {}),
        tokens: estimateMetadataTokens(skill)
      }
    ]
  })
  return {
    memoryFiles,
    mcpTools,
    agents,
    ...(input.skillSources?.length
      ? {
          skills: {
            totalSkills: skillFrontmatter.length,
            includedSkills: skillFrontmatter.length,
            tokens: skillFrontmatter.reduce((sum, skill) => sum + skill.tokens, 0),
            skillFrontmatter
          }
        }
      : {}),
    ...(input.autoCompactThreshold !== undefined
      ? { autoCompactThreshold: input.autoCompactThreshold }
      : {}),
    isAutoCompactEnabled: input.isAutoCompactEnabled ?? true
  }
}

function estimateTokens(value: string): number {
  return Math.ceil(value.length / 4)
}

function estimateMetadataTokens(value: unknown): number {
  try {
    return estimateTokens(JSON.stringify(value) ?? "")
  } catch {
    // Unknown provider serialization must not turn an observational read into
    // a model failure or fabricate a token estimate.
    return 0
  }
}
