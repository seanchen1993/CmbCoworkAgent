import type { ModJson, ModObject } from "../../../shared/mods/types"
import { isModObject, ModFunctionError } from "../../../shared/mods/v2/contracts"
import { encodeModJson, parseModJson } from "../../../shared/mods/validation"
import type { McpCapabilityTool } from "../../mcp/capability-types"
import { projectModResult } from "../publication"
import { validateFunctionToolResult } from "./tool-sdk"

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

/** Exact names from the active scoped catalog, never split a guest name into provider authority. */
export function resolveFunctionMcpToolName(
  tools: readonly McpCapabilityTool[],
  name: string
): McpCapabilityTool {
  const matches = tools.filter((tool) => tool.toolId === name || tool.canonicalToolId === name)
  if (!matches.length) throw new ModFunctionError("MODS_MCP_TOOL_UNAVAILABLE")
  if (matches.length !== 1) throw new ModFunctionError("MODS_MCP_TOOL_AMBIGUOUS")
  return structuredClone(matches[0])
}

export type FunctionMcpToolDispatch = (
  input: ModObject,
  signal: AbortSignal,
  core: (input: ModObject, signal: AbortSignal) => Promise<ModObject>
) => Promise<ModObject>

export function functionMcpToolResult(value: ModObject): ModObject {
  validateFunctionMcpResult(value)
  return {
    result: value.content,
    text: (value.content as ModObject[])
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n"),
    ...(value.isError === true ? { isError: true } : {})
  }
}

/** A synthetic engine tool result has the same text projection as its model-facing message. */
export function functionRegisteredMcpResult(answer: ModObject): ModObject {
  validateFunctionToolResult(answer)
  if (typeof answer.deny === "string")
    throw new ModFunctionError("MODS_OPERATION_DENIED", answer.deny)
  if (answer.ref !== undefined) throw new ModFunctionError("MODS_TOOL_RESULT_REF")
  const value = {
    content: Array.isArray(answer.result)
      ? answer.result
      : [{ type: "text", text: projectModResult(answer.result).text }],
    isError: answer.isError === true
  }
  validateFunctionMcpResult(value)
  return value
}

/** Refs preserve protected host blocks/schema output within one MCP SDK dispatch only. */
export class FunctionMcpToolResults {
  private readonly values: ModObject[] = []

  add(value: ModObject): ModObject {
    const ref = this.values.push(value) - 1
    return { ...functionMcpToolResult(value), ref }
  }

  resolve(answer: ModObject): ModObject {
    if (typeof answer.deny === "string")
      throw new ModFunctionError("MODS_OPERATION_DENIED", answer.deny)
    if (answer.ref !== undefined) {
      if (!Number.isSafeInteger(answer.ref) || !this.values[Number(answer.ref)])
        throw new ModFunctionError("MODS_TOOL_RESULT_REF")
      return this.values[Number(answer.ref)]
    }
    const value = {
      ...functionRegisteredMcpResult(answer),
      isError: answer.isError === true || this.values.at(-1)?.isError === true
    }
    validateFunctionMcpResult(value)
    return value
  }
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
