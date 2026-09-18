import type { McpCapabilityTool } from "./capability-types"
import { buildScopedToolAliases } from "./aliasing"
import { extractPluginIdFromProviderKey } from "../hooks/scope"

/** One metadata projection for actual invocation, discovery and non-executing permission probes. */
export function scopedMcpTools(
  tools: readonly McpCapabilityTool[],
  activePluginIds: ReadonlySet<string>
): McpCapabilityTool[] {
  return buildScopedToolAliases(
    tools.map((tool) => {
      const pluginId = extractPluginIdFromProviderKey(tool.providerKey)
      return tool.scope === "plugin-active" &&
        pluginId &&
        !activePluginIds.has(pluginId.toLowerCase())
        ? { ...tool, visibility: "lazy" as const }
        : { ...tool }
    }),
    (tool) => tool.priority ?? (tool.sourceKind === "connector" ? 100 : 50)
  )
}
