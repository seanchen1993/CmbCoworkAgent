import { join } from "node:path"
import type { PluginMetadata } from "../types"
import type { PluginStartUseReport } from "../../shared/plugin-start-use"
import { parseMcpJsonFile, parsePluginHooks } from "../storage"

/** Existing native parsers only. Call inside the start-use snapshot/identity fence. */
export function readPluginChatIntegrations(
  plugin: PluginMetadata
): NonNullable<NonNullable<PluginStartUseReport["chat"]>["integrations"]> {
  return {
    hookCount: parsePluginHooks(plugin).length,
    mcpServerNames: Object.keys(parseMcpJsonFile(join(plugin.path, ".mcp.json")) ?? {})
  }
}
