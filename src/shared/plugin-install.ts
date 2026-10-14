/** Legacy booleans retain their existing install and enablement semantics. */
export type PluginInstallMode = boolean | "capabilities"

export interface PluginInstallResult {
  success: boolean
  pluginName?: string
  pluginId?: string
  kind?: "modules" | "plugin"
  enabled?: boolean
  error?: string
}

export function isPluginInstallMode(value: unknown): value is PluginInstallMode | undefined {
  return value === undefined || typeof value === "boolean" || value === "capabilities"
}
