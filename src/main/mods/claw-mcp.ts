import { createHash } from "node:crypto"
import type { ClawSourceEntry, ClawSourceSelection } from "../../shared/mods/claw"
import type { McpCapabilityService, McpCapabilityTool } from "../mcp/capability-types"
import { mcpConnectRefusal } from "../mcp/capability-types"
import { readConfiguredClawMcpSources } from "../mcp/capability-service"
import { ModError } from "./errors"

export function readClawMcpSources(): ClawSourceEntry[] {
  return readConfiguredClawMcpSources()
}

/** A borrowed service: this restricts invocation, not the global connection pool. */
export function restrictClawMcpService(
  service: McpCapabilityService,
  selection: ClawSourceSelection | undefined,
  readSources: () => ClawSourceEntry[] = readClawMcpSources
): McpCapabilityService {
  if (!selection || selection.mode === "all") return service
  const selected = structuredClone(selection.items)
  const ids = new Set(selected.map((item) => item.id))
  const selectionKey = createHash("sha256").update(JSON.stringify(selected)).digest("hex")
  const assertSelection = (): void => {
    if (!selected.length) return
    const current = new Map(readSources().map((item) => [item.id, item]))
    for (const item of selected) {
      if (current.get(item.id)?.digest !== item.digest)
        throw new ModError("CLAW_MCP_SOURCE_CHANGED")
    }
  }
  const project = (tools: readonly McpCapabilityTool[]) =>
    structuredClone(tools.filter((tool) => ids.has(tool.providerKey)))
  const listTools = async (): Promise<McpCapabilityTool[]> => {
    assertSelection()
    if (!selected.length) return []
    const tools = await service.listTools()
    assertSelection()
    return project(tools)
  }
  const getTool = async (id: string): Promise<McpCapabilityTool | null> => {
    const matches = (await listTools()).filter(
      (tool) => tool.capabilityId === id || tool.toolId === id || tool.canonicalToolId === id
    )
    if (matches.length > 1) throw new ModError("CLAW_MCP_TOOL_AMBIGUOUS")
    return matches[0] ?? null
  }
  return {
    configuredServerNames: () => {
      assertSelection()
      return selected.map((item) => item.name)
    },
    listTools,
    peekTools: () => {
      assertSelection()
      if (!selected.length) return []
      const tools = service.peekTools?.()
      assertSelection()
      return tools ? project(tools) : null
    },
    getSnapshot: async () => {
      assertSelection()
      if (!selected.length) return { fingerprint: selectionKey, tools: [] }
      const snapshot = service.getSnapshot
        ? await service.getSnapshot()
        : { fingerprint: "", tools: await service.listTools() }
      assertSelection()
      return {
        fingerprint: createHash("sha256")
          .update(`${selectionKey}:${snapshot.fingerprint}`)
          .digest("hex"),
        tools: project(snapshot.tools)
      }
    },
    getTool,
    connectPluginServer: async (owner, server, signal, callerAssertCurrent) => {
      const assertCurrent = () => {
        signal.throwIfAborted()
        callerAssertCurrent()
        assertSelection()
      }
      assertCurrent()
      if (!ids.has(`plugin:${owner.pluginId}/${server}`))
        return { value: mcpConnectRefusal("policy"), assertCurrent }
      if (!service.connectPluginServer)
        return { value: mcpConnectRefusal("failed"), assertCurrent }
      const result = await service.connectPluginServer(owner, server, signal, assertCurrent)
      assertCurrent()
      result.assertCurrent()
      return {
        value: result.value,
        assertCurrent: () => {
          assertCurrent()
          result.assertCurrent()
        }
      }
    },
    invoke: async (id, args, callerAssertCurrent) => {
      const tool = await getTool(id)
      if (!tool) throw new ModError("CLAW_MCP_TOOL_NOT_SELECTED")
      const assertCurrent = () => {
        callerAssertCurrent?.()
        assertSelection()
        if (service.peekTools) {
          const current = service
            .peekTools()
            ?.find((entry) => entry.capabilityId === tool.capabilityId)
          if (
            !current ||
            current.providerKey !== tool.providerKey ||
            current.toolName !== tool.toolName ||
            current.connectionGeneration !== tool.connectionGeneration
          )
            throw new ModError("CLAW_MCP_CONNECTION_CHANGED")
        }
      }
      assertCurrent()
      const result = await service.invoke(tool.capabilityId, args, assertCurrent)
      assertCurrent()
      return result
    },
    // Runtime views do not own the shared connection pool. Application shutdown does.
    invalidate: async () => {},
    close: async () => {}
  }
}
