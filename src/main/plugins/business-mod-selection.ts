import { BUSINESS_MOD_ASSEMBLY, BUSINESS_MOD_MANIFEST } from "../../shared/business-mods"
import type { BusinessModCatalog } from "../../shared/business-mods"
import { businessModObject, parseBusinessModCatalog } from "./business-mod-manifest"
import { describeBusinessModAssemblyRuntime } from "./business-mod-assembly-adapter"
import { readAutobizSelectableCatalog } from "./business-adapters/autobiz-selection"
import { parseProjectRuntimeManifest } from "../../shared/project-runtime"
import { assertHostRuntimeSupported } from "../harness-board/project-runtime/host-validators"

/** Main-only policy from an admitted package, never a renderer's workflow snapshot. */
export interface BusinessModSelectionPolicy {
  templateId: "custom"
  nodes: Array<{ id: string; requires: string[]; optional?: string[]; missingInputs: string[] }>
}

export function businessModSelectionPolicy(
  catalog: BusinessModCatalog
): BusinessModSelectionPolicy {
  const modules = new Map(catalog.modules.map((mod) => [mod.id, mod]))
  const extensions = new Set(catalog.extensions?.map((extension) => extension.id))
  const producers = new Map<string, string>()
  const nodes = catalog.modules.map((mod) => {
    const id = String(mod.node.id)
    const requires = new Set<string>()
    const optional = new Set<string>()
    for (const dependency of mod.dependencies.required) {
      const producer = modules.get(dependency)
      if (producer) requires.add(String(producer.node.id))
      else if (!extensions.has(dependency)) throw Error(`业务依赖不存在：${dependency}`)
    }
    const artifacts = businessModObject(mod.node.artifacts ?? {})
    const missingInputs: string[] = []
    for (const raw of Array.isArray(artifacts.inputs) ? artifacts.inputs : []) {
      const input = businessModObject(raw)
      const path = String(input.path)
      const producer = producers.get(path)
      if (input.required === false) {
        if (producer) optional.add(producer)
      } else if (producer) requires.add(producer)
      else missingInputs.push(path)
    }
    for (const raw of Array.isArray(artifacts.outputs) ? artifacts.outputs : []) {
      const output = businessModObject(raw)
      producers.set(String(output.path), id)
    }
    return { id, requires: [...requires], optional: [...optional], missingInputs }
  })
  return { templateId: "custom", nodes }
}

/** Required inputs keep their original contract, including inputs with old degrade guidance. */
export function closeBusinessModSelection(
  policy: BusinessModSelectionPolicy,
  selected: string[],
  includeOptional = false
) {
  const known = new Map(policy.nodes.map((node) => [node.id, node]))
  if (!selected.length || selected.length > 32 || new Set(selected).size !== selected.length)
    throw Error("业务步骤选择无效")
  const included = new Set<string>(),
    visiting = new Set<string>()
  const visit = (id: string) => {
    if (included.has(id)) return
    if (visiting.has(id)) throw Error("业务步骤依赖存在循环")
    const node = known.get(id)
    if (!node) throw Error(`业务步骤不存在：${id}`)
    if (node.missingInputs.length)
      throw Error(`${id} 必需输入没有上游生产者：${node.missingInputs.join("、")}`)
    visiting.add(id)
    node.requires.forEach(visit)
    if (includeOptional) node.optional?.forEach(visit)
    visiting.delete(id)
    included.add(id)
  }
  selected.forEach(visit)
  const ordered = policy.nodes.filter((node) => included.has(node.id)).map((node) => node.id)
  const preceding = new Set<string>()
  for (const id of ordered) {
    if (known.get(id)!.requires.some((dependency) => !preceding.has(dependency)))
      throw Error(`业务步骤顺序与必需依赖冲突：${id}`)
    preceding.add(id)
  }
  return ordered
}

export function assertClosedBusinessModSelection(
  policy: BusinessModSelectionPolicy,
  selected: string[]
) {
  if (JSON.stringify(closeBusinessModSelection(policy, selected)) !== JSON.stringify(selected))
    throw Error("业务步骤尚未补齐必需依赖，请重新检查步骤后创建。")
}

/** Host routes stay in the Host state owner; legacy subsets retain their reviewed adapter. */
export function readBusinessModSelectionPolicy(snapshot: {
  files: readonly { path: string; bytes: Buffer }[]
}): BusinessModSelectionPolicy | undefined {
  if (!snapshot.files.some((file) => file.path === BUSINESS_MOD_ASSEMBLY)) return undefined
  const manifest = snapshot.files.find((file) => file.path === BUSINESS_MOD_MANIFEST)
  if (!manifest) throw Error("业务组装插件校验未通过，请重新检查来源。")
  const catalog = parseBusinessModCatalog(JSON.parse(manifest.bytes.toString("utf8")))
  if (catalog.kernel && describeBusinessModAssemblyRuntime(catalog.kernel).mode === "host") {
    const file = snapshot.files.find((file) => file.path === "devclaw.project-runtime.json")
    if (!file) throw Error("BUSINESS_MOD_HOST_RUNTIME_REQUIRED")
    const runtime = parseProjectRuntimeManifest(JSON.parse(file.bytes.toString("utf8")))
    assertHostRuntimeSupported(runtime)
    if (
      runtime.stages.length !== catalog.modules.length ||
      runtime.stages.some(
        (stage, index) =>
          stage.id !== catalog.modules[index].id ||
          stage.skill !== catalog.modules[index].skill.entry
      )
    )
      throw Error("BUSINESS_MOD_HOST_RUNTIME_CONFLICT")
    // Subset selection happens before assembly; legacy custom checkpoints must not be created.
    return undefined
  }
  const selectable = readAutobizSelectableCatalog(snapshot)
  return selectable ? businessModSelectionPolicy(selectable) : undefined
}
