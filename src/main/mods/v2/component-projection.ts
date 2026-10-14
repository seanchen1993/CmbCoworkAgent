import { createHash } from "node:crypto"
import {
  resolveClawComponents,
  type ClawComponentExport,
  type ClawComponentSelection
} from "../../../shared/mods/claw-components"
import type { ModJson, ModObject } from "../../../shared/mods/types"
import type { ClawActionExport } from "../../../shared/mods/claw-actions"
import type { CompiledFunctionPlugin } from "./loader"
import type { FunctionEnvironmentDeclaration } from "./environment-sdk"
import { validateRegisteredToolInput } from "./tool-schema"

export interface CompiledFunctionComponent {
  code: string
  globalName: string
  clients: Record<string, string>
  environment: FunctionEnvironmentDeclaration
}

export interface FunctionComponentProjection {
  code: string
  clients: Record<string, string>
  environment: FunctionEnvironmentDeclaration
  actions: ClawActionExport[]
  options: ModObject
  effectiveIds: string[]
  selectionDigest?: string
}

function ordered(entries: ClawComponentExport[]): ClawComponentExport[] {
  const result: ClawComponentExport[] = []
  const done = new Set<string>()
  const visit = (entry: ClawComponentExport) => {
    if (done.has(entry.id)) return
    // Declarations have already been checked for cycles and explicit dependency closure.
    for (const id of [...entry.dependsOn].sort()) visit(entries.find((item) => item.id === id)!)
    done.add(entry.id)
    result.push(entry)
  }
  for (const entry of [...entries].sort((a, b) => a.id.localeCompare(b.id))) visit(entry)
  return result
}

/** Only the chosen bundles are evaluated. There is no hidden package bootstrap. */
export function assembleFunctionComponents(
  entries: ClawComponentExport[],
  modules: Record<string, CompiledFunctionComponent>,
  config: Record<string, ModObject>
): string {
  const selected = ordered(entries)
  return (
    selected.map((entry) => modules[entry.id].code).join("\n") +
    "\nvar __cmbFunctionMod = { register: function(on, options) {\n" +
    selected
      .map((entry, index) => {
        const value = JSON.stringify(JSON.stringify(config[entry.id] ?? {}))
        return `var r${index} = ${modules[entry.id].globalName}.register(on, Object.assign({}, options, JSON.parse(${value}))); if (r${index} && typeof r${index}.then === "function") throw Error("MODS_ASYNC_REGISTER");`
      })
      .join("\n") +
    "\n} };\n"
  )
}

function canonical(value: ModJson): ModJson {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])])
    )
  return value
}

/** Project an approved immutable package snapshot without re-reading mutable source files. */
export function projectFunctionComponents(
  compiled: CompiledFunctionPlugin,
  selection?: ClawComponentSelection
): FunctionComponentProjection {
  const entries = resolveClawComponents(compiled.components ?? [], selection)
  const options = structuredClone(compiled.options)
  if (!compiled.components?.length)
    return {
      code: compiled.code,
      clients: compiled.clients,
      environment: compiled.environment,
      actions: compiled.actions ?? [],
      options,
      effectiveIds: []
    }
  const config = structuredClone(selection?.config ?? {})
  for (const entry of entries) {
    const value = config[entry.id] ?? {}
    if (compiled.userConfig && Object.keys(value).some((key) => Object.hasOwn(compiled.userConfig!, key)))
      throw Error(`MODS_USER_CONFIG_COMPONENT_CONFLICT: ${entry.name}`)
    if (entry.configSchema) {
      try {
        validateRegisteredToolInput(entry.configSchema, value)
      } catch {
        throw Error(`CLAW_COMPONENT_CONFIG_SCHEMA: ${entry.name}`)
      }
    } else if (Object.keys(value).length) {
      throw Error(`CLAW_COMPONENT_CONFIG_UNDECLARED: ${entry.name}`)
    }
  }
  const effective = ordered(entries)
  const effectiveIds = effective.map((entry) => entry.id)
  const modules = compiled.componentModules!
  const clients: Record<string, string> = Object.create(null)
  const read = new Set<string>()
  const write = new Set<string>()
  const actionIds = new Set(effective.flatMap((entry) => entry.actionIds))
  for (const entry of effective) {
    const module = modules[entry.id]
    Object.assign(clients, module.clients)
    module.environment.read.forEach((name) => read.add(name))
    module.environment.write.forEach((name) => write.add(name))
  }
  const selectionDigest = createHash("sha256")
    .update(
      JSON.stringify({
        digest: compiled.digest,
        ids: effectiveIds,
        config: canonical(Object.fromEntries(effectiveIds.map((id) => [id, config[id] ?? {}])))
      })
    )
    .digest("hex")
  return {
    code: assembleFunctionComponents(effective, modules, config),
    clients,
    environment: { read: [...read].sort(), write: [...write].sort() },
    actions: (compiled.actions ?? []).filter((action) => actionIds.has(action.id)),
    options,
    effectiveIds,
    selectionDigest
  }
}
