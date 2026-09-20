import { ModError } from "./errors"
import type { ApprovedMod } from "./engine"

/** Stable topological order. Unknown dependencies and cycles invalidate the snapshot. */
export function orderApprovedMods(mods: ApprovedMod[]): ApprovedMod[] {
  const byId = new Map(mods.map((mod) => [mod.compiled.manifest.id, mod]))
  const edges = new Map(mods.map((mod) => [mod.compiled.manifest.id, new Set<string>()]))
  for (const mod of mods) {
    const manifest = mod.compiled.manifest
    for (const [before, after] of [
      ...(manifest.before ?? []).map((id) => [manifest.id, id]),
      ...(manifest.after ?? []).map((id) => [id, manifest.id])
    ]) {
      if (!byId.has(before) || !byId.has(after)) throw new ModError("MODS_ORDER_UNKNOWN")
      edges.get(before)!.add(after)
    }
  }
  const remaining = new Set(byId.keys())
  const result: ApprovedMod[] = []
  while (remaining.size) {
    const next = [...remaining].find(
      (id) => ![...remaining].some((source) => edges.get(source)!.has(id))
    )
    if (!next) throw new ModError("MODS_ORDER_CYCLE")
    result.push(byId.get(next)!)
    remaining.delete(next)
  }
  return result
}
