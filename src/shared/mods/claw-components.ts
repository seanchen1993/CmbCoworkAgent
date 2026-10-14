import { clawActionObject } from "./claw-actions"
import type { ModObject } from "./types"
import { isModObject } from "./v2/contracts"

export interface ClawComponentExport {
  id: string
  name: string
  description?: string
  kind: "module"
  entry: string
  dependsOn: string[]
  actionIds: string[]
  configSchema?: ModObject
}

export interface ClawComponentSelection {
  mode: "all" | "selected"
  ids: string[]
  config: Record<string, ModObject>
}

const validId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9][\w.-]{0,79}$/.test(value)

function ids(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 32 ||
    !value.every(validId) ||
    new Set(value).size !== value.length
  )
    throw Error("CLAW_COMPONENT_IDS_INVALID")
  return [...value]
}

/** Static author declarations. Reading this catalog never evaluates component code. */
export function parseClawComponentExports(value: unknown): ClawComponentExport[] {
  if (value === undefined) return []
  const raw = clawActionObject(value)
  if (raw.components === undefined && raw.componentsVersion === undefined) return []
  if (
    raw.componentsVersion !== 1 ||
    !Array.isArray(raw.components) ||
    raw.components.length === 0 ||
    raw.components.length > 32
  )
    throw Error("CLAW_COMPONENT_EXPORTS_INVALID")
  const seen = new Set<string>()
  const entries = raw.components.map((item): ClawComponentExport => {
    if (
      !isModObject(item) ||
      !validId(item.id) ||
      seen.has(item.id) ||
      item.kind !== "module" ||
      typeof item.name !== "string" ||
      !item.name.trim() ||
      item.name.length > 128 ||
      typeof item.entry !== "string" ||
      !item.entry ||
      item.entry.length > 512 ||
      // eslint-disable-next-line no-control-regex -- Untrusted manifest paths cannot contain controls.
      /[\\:\u0000-\u001f]/.test(item.entry) ||
      item.entry.startsWith("/") ||
      item.entry.split("/").some((part) => !part || part === "..") ||
      (item.description !== undefined &&
        (typeof item.description !== "string" || item.description.length > 2000))
    )
      throw Error("CLAW_COMPONENT_EXPORT_INVALID")
    seen.add(item.id)
    return {
      id: item.id,
      name: item.name,
      kind: "module",
      entry: item.entry,
      dependsOn: ids(item.dependsOn ?? []),
      actionIds: ids(item.actionIds ?? []),
      ...(item.description === undefined ? {} : { description: item.description }),
      ...(item.configSchema === undefined
        ? {}
        : { configSchema: clawActionObject(item.configSchema) })
    }
  })
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (id: string) => {
    if (visiting.has(id)) throw Error("CLAW_COMPONENT_DEPENDENCY_CYCLE")
    if (visited.has(id)) return
    const entry = entries.find((item) => item.id === id)
    if (!entry) throw Error("CLAW_COMPONENT_DEPENDENCY_MISSING")
    visiting.add(id)
    entry.dependsOn.forEach(visit)
    visiting.delete(id)
    visited.add(id)
  }
  entries.forEach((entry) => visit(entry.id))
  return entries
}

export function parseClawComponentSelection(value: unknown): ClawComponentSelection {
  const raw = clawActionObject(value)
  if (raw.mode !== "all" && raw.mode !== "selected") throw Error("CLAW_COMPONENT_SELECTION_INVALID")
  const selected = ids(raw.ids ?? [])
  if (raw.mode === "selected" && !selected.length) throw Error("CLAW_COMPONENT_SELECTION_EMPTY")
  const config = clawActionObject(raw.config ?? {})
  if (Object.keys(config).length > 32) throw Error("CLAW_COMPONENT_CONFIG_INVALID")
  const parsed: Record<string, ModObject> = Object.create(null)
  for (const [id, input] of Object.entries(config)) {
    if (!validId(id) || ["__proto__", "prototype", "constructor"].includes(id))
      throw Error("CLAW_COMPONENT_CONFIG_INVALID")
    parsed[id] = clawActionObject(input)
  }
  return { mode: raw.mode, ids: raw.mode === "all" ? [] : selected, config: parsed }
}

/** Resolve only explicitly selected IDs. Missing dependencies never silently grant execution. */
export function resolveClawComponents(
  entries: ClawComponentExport[],
  selection?: ClawComponentSelection
): ClawComponentExport[] {
  if (!entries.length) {
    if (selection) throw Error("CLAW_COMPONENTS_NOT_DECLARED")
    return []
  }
  const normalized = selection && parseClawComponentSelection(selection)
  const selected = new Set(
    normalized?.mode === "selected" ? normalized.ids : entries.map((entry) => entry.id)
  )
  for (const id of selected)
    if (!entries.some((entry) => entry.id === id)) throw Error("CLAW_COMPONENT_UNAVAILABLE")
  const result = entries.filter((entry) => selected.has(entry.id))
  for (const entry of result)
    for (const dependency of entry.dependsOn)
      if (!selected.has(dependency)) throw Error("CLAW_COMPONENT_DEPENDENCY_REQUIRED")
  for (const id of Object.keys(normalized?.config ?? {}))
    if (!selected.has(id)) throw Error("CLAW_COMPONENT_CONFIG_UNSELECTED")
  return result
}
