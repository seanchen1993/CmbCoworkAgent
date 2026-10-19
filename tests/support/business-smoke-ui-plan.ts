import assert from "node:assert/strict"
import type { BusinessModCatalog, BusinessModInspection } from "../../src/shared/business-mods"

export interface BusinessSmokeUiSource {
  metadata: { name: string }
  manifest: BusinessModCatalog
  inspection: BusinessModInspection
}

/** Test selection only: actual ZIP declarations must match the original native inspection. */
export function businessSmokeUiPlan(sources: BusinessSmokeUiSource[]) {
  assert(sources.length >= 2, "At least two actual selected packages are required")
  assert.equal(
    new Set(sources.map((source) => source.metadata.name)).size,
    sources.length,
    "Duplicate installed source names"
  )
  const installed = sources.map((source) => ({
    name: source.metadata.name,
    business: source.manifest.modules.length,
    extensions: source.manifest.extensions?.length ?? 0
  }))
  const primary = sources.find((source) => source.manifest.modules.length === 2) ?? sources[0]
  const warehouse = sources.find((source) =>
    source.manifest.modules.some((mod) => mod.id === "warehouse.quality")
  )
  const chosen = [primary, ...(warehouse && warehouse !== primary ? [warehouse] : [])]
  const assemblies = chosen.map((source) => {
    const declared = [...source.manifest.modules, ...(source.manifest.extensions ?? [])]
    const ids = declared.map((mod) => mod.id)
    assert.equal(
      new Set(ids.map((id) => id.toLowerCase())).size,
      ids.length,
      "Duplicate module identity"
    )
    assert.equal(source.inspection.sourceName, source.metadata.name, "Foreign native inspection")
    assert.deepEqual(
      source.inspection.mods.map((mod) => mod.id),
      ids,
      "Inspection/ZIP identities differ"
    )
    const byId = new Map(declared.map((mod) => [mod.id, mod]))
    for (const mod of declared) {
      assert(Array.isArray(mod.dependencies.required), "Missing required dependency declaration")
      const inspected = source.inspection.mods.find((item) => item.id === mod.id)!
      assert.deepEqual(inspected.dependsOn, mod.dependencies.required, "Native dependency mismatch")
    }
    const visited = new Set<string>(),
      visiting = new Set<string>(),
      ordered: string[] = []
    const visit = (id: string) => {
      if (visited.has(id)) return
      assert(!visiting.has(id), `Cyclic required dependency: ${id}`)
      const mod = byId.get(id)
      assert(mod, `Missing required dependency or unknown selected module: ${id}`)
      visiting.add(id)
      for (const dependency of mod.dependencies.required) visit(dependency)
      visiting.delete(id)
      visited.add(id)
      ordered.push(id)
    }
    assert(
      source.manifest.modules.length >= 2,
      "The manual UI assembly requires two real business steps"
    )
    for (const mod of [
      ...source.manifest.modules.slice(0, 2),
      ...(source.manifest.extensions ?? [])
    ])
      visit(mod.id)
    const selected = new Set(visited)
    const businessIds = new Set(source.manifest.modules.map((mod) => mod.id))
    return {
      name: source.metadata.name,
      all: source.inspection.mods,
      selected: source.inspection.mods.filter((mod) => selected.has(mod.id)),
      steps: ordered
        .filter((id) => selected.has(id) && businessIds.has(id))
        .map((id) => byId.get(id)!),
      extensions: (source.manifest.extensions ?? []).filter((mod) => selected.has(mod.id))
    }
  })
  return { installed, assemblies }
}
