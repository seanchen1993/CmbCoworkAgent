import {
  isCapabilityUsageAllowed,
  parseCapabilityUsage,
  type CapabilityUsage
} from "./mods/capability-usage"

export interface PluginCapability {
  id: string
  title: string
  kind: "skill" | "flow"
  usage: CapabilityUsage
  entry: string
  dependsOn: string[]
  /** Required hook IDs are assertions; omission/empty never removes original hooks. */
  requiredHooks?: string[]
  requiredMcpServers?: string[]
  inputs?: Array<{ id: string; title: string; path: string; required: boolean }>
}

export interface PluginCapabilities {
  apiVersion: "devclaw.capabilities/v1"
  capabilities: PluginCapability[]
}

export const PLUGIN_CAPABILITIES_MAX_BYTES = 65536
const invalid = (detail: string): never => {
  throw Error(`PLUGIN_CAPABILITIES_${detail}`)
}
const validId = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[a-zA-Z0-9][\w.-]{0,79}$/.test(value) &&
  !["__proto__", "prototype", "constructor"].includes(value)

function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("OBJECT_INVALID")
  const result = value as Record<string, unknown>
  if (Object.keys(result).some((key) => !keys.includes(key))) invalid("KEY_INVALID")
  return result
}

/** Portable package-relative paths only. The host must verify realpath and actual entry type. */
function entryPath(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 512 ||
    // eslint-disable-next-line no-control-regex -- Reject untrusted path control characters.
    /[\\:%<>"|?*\u0000-\u001f\u007f]/.test(value) ||
    value
      .split("/")
      .some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          part.trim() !== part ||
          /[. ]$/.test(part) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
      )
  )
    invalid("ENTRY_INVALID")
  return value as string
}

/** Static declarations are compatibility claims, never execution authorization. */
export function parsePluginCapabilities(value: unknown): PluginCapabilities | undefined {
  if (value === undefined) return undefined
  const raw = record(value, ["apiVersion", "capabilities"])
  if (
    raw.apiVersion !== "devclaw.capabilities/v1" ||
    !Array.isArray(raw.capabilities) ||
    raw.capabilities.length === 0 ||
    raw.capabilities.length > 64
  )
    invalid("MANIFEST_INVALID")
  const seen = new Set<string>()
  const capabilities = (raw.capabilities as unknown[]).map((value): PluginCapability => {
    const item = record(value, [
      "id",
      "title",
      "kind",
      "usage",
      "entry",
      "dependsOn",
      "requiredHooks",
      "requiredMcpServers",
      "inputs"
    ])
    if (
      !validId(item.id) ||
      seen.has(item.id) ||
      typeof item.title !== "string" ||
      !item.title.trim() ||
      item.title.length > 128 ||
      (item.kind !== "skill" && item.kind !== "flow") ||
      item.usage === undefined
    )
      invalid("CAPABILITY_INVALID")
    const id = item.id as string
    seen.add(id)
    const usage = parseCapabilityUsage(item.usage)
    if (item.kind === "flow" && usage !== "project") invalid("FLOW_USAGE_INVALID")
    const dependencies = item.dependsOn === undefined ? [] : item.dependsOn
    if (
      !Array.isArray(dependencies) ||
      dependencies.length > 64 ||
      !dependencies.every(validId) ||
      new Set(dependencies).size !== dependencies.length
    )
      invalid("DEPENDENCIES_INVALID")
    const requirements: Pick<PluginCapability, "requiredHooks" | "requiredMcpServers"> = {}
    for (const key of ["requiredHooks", "requiredMcpServers"] as const) {
      const entries = item[key]
      if (entries === undefined) continue
      if (
        !Array.isArray(entries) ||
        entries.length > 64 ||
        new Set(entries).size !== entries.length ||
        !entries.every(
          (value) => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,159}$/.test(value)
        )
      )
        invalid("REQUIREMENTS_INVALID")
      requirements[key] = [...(entries as string[])]
    }
    let inputs: PluginCapability["inputs"]
    if (item.inputs !== undefined) {
      if (item.kind !== "flow" || !Array.isArray(item.inputs) || item.inputs.length > 32)
        invalid("INPUTS_INVALID")
      const inputIds = new Set<string>()
      const inputPaths = new Set<string>()
      inputs = (item.inputs as unknown[]).map((value) => {
        const input = record(value, ["id", "title", "path", "required"])
        if (
          !validId(input.id) ||
          inputIds.has(input.id) ||
          typeof input.title !== "string" ||
          !input.title.trim() ||
          input.title.length > 128 ||
          typeof input.required !== "boolean"
        )
          invalid("INPUTS_INVALID")
        const path = entryPath(input.path)
        if (inputPaths.has(path.toLowerCase())) invalid("INPUTS_INVALID")
        inputIds.add(input.id as string)
        inputPaths.add(path.toLowerCase())
        return {
          id: input.id as string,
          title: input.title as string,
          path,
          required: input.required as boolean
        }
      })
    }
    return {
      ...(inputs ? { inputs } : {}),
      ...requirements,
      id,
      title: item.title as string,
      kind: item.kind as "skill" | "flow",
      usage,
      entry: entryPath(item.entry),
      dependsOn: [...(dependencies as string[])]
    }
  })
  const byId = new Map(capabilities.map((item) => [item.id, item]))
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (item: PluginCapability): void => {
    if (visiting.has(item.id)) invalid("DEPENDENCY_CYCLE")
    if (visited.has(item.id)) return
    visiting.add(item.id)
    for (const id of item.dependsOn) {
      const dependency = byId.get(id)
      if (!dependency) invalid("DEPENDENCY_MISSING")
      for (const context of ["chat", "project"] as const)
        if (
          isCapabilityUsageAllowed(item.usage, context) &&
          !isCapabilityUsageAllowed(dependency!.usage, context)
        )
          invalid("DEPENDENCY_USAGE_INVALID")
      visit(dependency!)
    }
    visiting.delete(item.id)
    visited.add(item.id)
  }
  capabilities.forEach(visit)
  const parsed = { apiVersion: "devclaw.capabilities/v1" as const, capabilities }
  if (new TextEncoder().encode(JSON.stringify(parsed)).length > PLUGIN_CAPABILITIES_MAX_BYTES)
    invalid("SIZE_LIMIT")
  return parsed
}

export function parsePluginCapabilitiesJson(text: string): PluginCapabilities {
  if (
    typeof text !== "string" ||
    text.length > PLUGIN_CAPABILITIES_MAX_BYTES ||
    new TextEncoder().encode(text).length > PLUGIN_CAPABILITIES_MAX_BYTES
  )
    invalid("SIZE_LIMIT")
  return parsePluginCapabilities(JSON.parse(text)) ?? invalid("MANIFEST_INVALID")
}
