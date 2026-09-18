import { ModFunctionError } from "../../../shared/mods/v2/contracts"

/** Frozen Claude 2.1.273 pn/XPe/vcr spelling rules; names never grant provider authority. */
export function functionMcpNamePart(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9_-]/g, "_")
  return value.startsWith("claude.ai ")
    ? normalized.replace(/_+/g, "_").replace(/^_|_$/g, "")
    : normalized
}

export function functionMcpToolName(server: string, tool: string): string {
  return `mcp__${functionMcpNamePart(server)}__${tool}`
}

export function functionMcpToolCandidates(server: string, tool: string): ReadonlySet<string> {
  return new Set([
    functionMcpToolName(server, tool),
    `mcp__${server}__${tool}`,
    functionMcpToolName(server, functionMcpNamePart(tool))
  ])
}

export function assertFunctionMcpServerAvailable(
  plugin: string,
  configured: readonly string[]
): void {
  const name = functionMcpNamePart(plugin)
  if (configured.some((server) => functionMcpNamePart(server) === name))
    throw new ModFunctionError("MODS_MCP_SERVER_NAME_COLLISION")
}
