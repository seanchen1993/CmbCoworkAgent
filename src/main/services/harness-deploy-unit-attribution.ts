import { isAbsolute, relative, resolve, sep } from "node:path"
import type { HarnessFeatureDeployUnitBinding } from "../../shared/harness-board-types"

export interface HarnessDeployUnitSnapshot {
  /** Local-only paths used to attribute a changed file; never serialize this object to telemetry. */
  mappings: Array<{ deployUnitId: string; localRepoPath: string }>
  ids: string[]
  sessionId?: string
}

export function snapshotHarnessDeployUnits(
  binding: HarnessFeatureDeployUnitBinding | null
): HarnessDeployUnitSnapshot | null {
  if (!binding) return null
  const mappings = binding.selectedDeployUnitMappings
    .filter((m) => m.deployUnitId.trim() && isAbsolute(m.localRepoPath))
    .map((m) => ({ deployUnitId: m.deployUnitId.trim(), localRepoPath: resolve(m.localRepoPath) }))
  const ids = [
    ...new Set(binding.selectedDeployUnitMappings.map((m) => m.deployUnitId.trim()).filter(Boolean))
  ].sort()
  const configured =
    binding.sessionWorkspace?.source === "deployUnit"
      ? binding.sessionWorkspace.deployUnitId.trim()
      : undefined
  return {
    mappings,
    ids,
    ...(configured && ids.includes(configured) ? { sessionId: configured } : {})
  }
}

export async function loadHarnessDeployUnitSnapshot(
  projectId: string,
  featureSlug: string
): Promise<HarnessDeployUnitSnapshot | null> {
  try {
    const { getHarnessFeatureBinding } = await import("../harness-board/service")
    return snapshotHarnessDeployUnits(await getHarnessFeatureBinding(projectId, featureSlug))
  } catch {
    return null
  }
}

/** The most specific configured repository wins. Ambiguous mappings remain unassigned. */
export function resolveCodeDeployUnit(
  snapshot: HarnessDeployUnitSnapshot | null | undefined,
  filePath: string
): string | undefined {
  if (!snapshot || !isAbsolute(filePath)) return undefined
  const candidates = snapshot.mappings
    .filter((mapping) => {
      const path = relative(mapping.localRepoPath, resolve(filePath))
      return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path)
    })
    .sort((a, b) => b.localRepoPath.length - a.localRepoPath.length)
  const nearest = candidates[0]
  if (!nearest) return undefined
  const ids = new Set(
    candidates
      .filter((m) => m.localRepoPath.length === nearest.localRepoPath.length)
      .map((m) => m.deployUnitId)
  )
  return ids.size === 1 ? nearest.deployUnitId : undefined
}

/** A feature can bind several units; these IDs describe scope, not a per-unit allocation. */
export function harnessDeployUnitTelemetry(
  snapshot: HarnessDeployUnitSnapshot | null | undefined
): { harnessDeployUnitIds?: string[]; harnessSessionDeployUnitId?: string } {
  return snapshot
    ? {
        harnessDeployUnitIds: [...snapshot.ids],
        ...(snapshot.sessionId ? { harnessSessionDeployUnitId: snapshot.sessionId } : {})
      }
    : {}
}

export function parseStoredDeployUnitIds(value: string | null | undefined): string[] | undefined {
  if (!value) return undefined
  try {
    const ids: unknown = JSON.parse(value)
    return Array.isArray(ids) && ids.every((id) => typeof id === "string" && id.trim())
      ? [...new Set((ids as string[]).map((id) => id.trim()))].sort()
      : undefined
  } catch {
    return undefined
  }
}
