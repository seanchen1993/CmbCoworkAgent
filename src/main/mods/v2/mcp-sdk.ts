import type { ModJson, ModObject } from "../../../shared/mods/types"
import { isModObject, ModFunctionError } from "../../../shared/mods/v2/contracts"
import { encodeModJson, parseModJson } from "../../../shared/mods/validation"
import type { McpCapabilityTool } from "../../mcp/capability-types"

/** SDK arguments are data, never a connection, credential or executable supplied by a guest. */
export function functionMcpInput(input: ModObject): ModObject {
  if (
    typeof input.server !== "string" ||
    !input.server.trim() ||
    input.server.length > 256 ||
    typeof input.tool !== "string" ||
    !input.tool.trim() ||
    input.tool.length > 256 ||
    !isModObject(input.args) ||
    encodeModJson(input.args).length > 16000 ||
    Object.keys(input).some((key) => !["server", "tool", "args"].includes(key))
  )
    throw new ModFunctionError("MODS_MCP_ARGUMENTS")
  return parseModJson(encodeModJson(input)) as ModObject
}

/** Match actual provider identities, not the mcp__ prefix also used by registered tools. */
export function resolveFunctionMcpTool(
  tools: readonly McpCapabilityTool[],
  server: string,
  name: string
): McpCapabilityTool {
  // A provider can advertise hundreds of tools. Normalize each distinct server name once,
  // without caching authority or allowing a previous discovery snapshot to survive a reload.
  const names = new Map<string, boolean>()
  const matchesServer = (value: string): boolean => {
    let matches = names.get(value)
    if (matches === undefined) {
      matches = value === server || value.replace(/[^a-zA-Z0-9_-]/g, "_") === server
      names.set(value, matches)
    }
    return matches
  }
  const providers = new Set(
    tools
      .filter(
        (tool) => matchesServer(tool.providerAlias) || matchesServer(tool.providerDisplayName)
      )
      .map((tool) => tool.providerKey)
  )
  if (providers.size > 1) throw new ModFunctionError("MODS_MCP_SERVER_AMBIGUOUS")
  const matches = tools.filter((tool) => providers.has(tool.providerKey) && tool.toolName === name)
  if (!matches.length) throw new ModFunctionError("MODS_MCP_TOOL_UNAVAILABLE")
  if (matches.length !== 1) throw new ModFunctionError("MODS_MCP_TOOL_AMBIGUOUS")
  return JSON.parse(JSON.stringify(matches[0])) as McpCapabilityTool
}

export function functionMcpToolFingerprint(tool: McpCapabilityTool): string {
  return encodeModJson({
    capabilityId: tool.capabilityId,
    providerKey: tool.providerKey,
    toolName: tool.toolName,
    connectionGeneration: tool.connectionGeneration ?? null,
    inputSchema: tool.inputSchema ?? {}
  })
}

export function validateFunctionMcpResult(value: ModJson): asserts value is ModObject {
  if (
    !isModObject(value) ||
    !Array.isArray(value.content) ||
    value.content.some((block) => !isModObject(block) || typeof block.type !== "string") ||
    typeof value.isError !== "boolean"
  )
    throw new ModFunctionError("MODS_MCP_RESULT")
  encodeModJson(value)
}

/** Use protected raw MCP blocks, never the lossy LangChain/UI content projection. */
export function functionMcpResult(value: unknown): ModObject {
  if (!isModObject(value) || !isModObject(value.raw) || !Array.isArray(value.raw.content))
    throw new ModFunctionError("MODS_MCP_RESULT")
  const result: ModObject = {
    content: value.raw.content,
    isError: value.isError === true || value.raw.isError === true,
    ...(value.raw.structuredContent === undefined
      ? {}
      : {
          structuredContent: value.raw.structuredContent
        })
  }
  validateFunctionMcpResult(result)
  return result
}
