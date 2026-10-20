import type { StageDebugFileChange } from "../../../shared/project-runtime/stage-debug"
import type { ProjectFileInventory } from "./bounded-project-files"

/** Pure content comparison. Does not inspect receipts, advance stages or change a business verdict. */
export function compareStageDebugFiles(
  before: ProjectFileInventory,
  after: ProjectFileInventory
): {
  files: StageDebugFileChange[]
  counts: { added: number; deleted: number; modified: number; unchanged: number }
} {
  const baseline = new Map(before.files.map((file) => [file.path, file]))
  const current = new Map(after.files.map((file) => [file.path, file]))
  const counts = { added: 0, deleted: 0, modified: 0, unchanged: 0 }
  const files: StageDebugFileChange[] = []
  for (const path of [...new Set([...baseline.keys(), ...current.keys()])].sort()) {
    const prior = baseline.get(path),
      next = current.get(path)
    if (prior?.digest === next?.digest) {
      counts.unchanged++
      continue
    }
    const change = !prior ? "added" : !next ? "deleted" : "modified"
    counts[change]++
    files.push({
      path,
      change,
      beforeSha256: prior?.digest ?? null,
      afterSha256: next?.digest ?? null,
      beforeBytes: prior?.bytes ?? null,
      afterBytes: next?.bytes ?? null,
      binary: !!(prior?.binary || next?.binary)
    })
  }
  return { counts, files }
}
