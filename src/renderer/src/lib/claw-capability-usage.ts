import type { ClawCapability } from "../../../shared/mods/claw"
import type { ClawComponentExport } from "../../../shared/mods/claw-components"
import {
  isCapabilityUsageAllowed,
  type CapabilityUsageContext
} from "../../../shared/mods/capability-usage"
import type { FunctionPluginStatus } from "../../../shared/mods/v2/commands"

/** Include an entry only when its entire required closure is usable in this context. */
export function usableClawComponents(
  entries: readonly ClawComponentExport[],
  context: CapabilityUsageContext
): ClawComponentExport[] {
  const allowed = (entry: ClawComponentExport, seen: Set<string>): boolean => {
    if (seen.has(entry.id) || !isCapabilityUsageAllowed(entry.usage, context)) return false
    const next = new Set(seen).add(entry.id)
    return entry.dependsOn.every((id) => {
      const dependency = entries.find((item) => item.id === id)
      return !!dependency && allowed(dependency, next)
    })
  }
  return entries.filter((entry) => allowed(entry, new Set()))
}

export function hasUsableClawComponents(
  source: FunctionPluginStatus,
  context: CapabilityUsageContext
) {
  return !source.components?.length || usableClawComponents(source.components, context).length > 0
}

/** New choices are explicit; later package changes cannot silently expand them. */
export function newClawCapability(
  source: FunctionPluginStatus,
  context: CapabilityUsageContext
): ClawCapability {
  const entries = usableClawComponents(source.components ?? [], context)
  if (source.components?.length && !entries.length) throw Error("此插件没有适用于当前场景的功能。")
  return {
    pluginId: source.pluginId,
    name: source.name,
    digest: source.digest!,
    ...(source.components?.length
      ? {
          components: {
            mode: "selected" as const,
            ids: entries.map((entry) => entry.id),
            config: {}
          }
        }
      : {})
  }
}
