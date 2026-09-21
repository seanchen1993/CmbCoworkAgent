import type {
  HarnessDeployUnitConfig,
  HarnessDeployUnitMapping
} from "../../../shared/harness-board-types"

/** Preserve catalog order while feature drafts own their IDs and values. */
export function buildFeatureDeployUnitRows(
  catalog: HarnessDeployUnitConfig[],
  snapshots: HarnessDeployUnitMapping[]
): HarnessDeployUnitMapping[] {
  const snapshotsById = new Map(snapshots.map((item) => [item.deployUnitIdMapping, item]))
  const snapshotsByUnit = new Map(snapshots.map((item) => [item.deployUnitId.trim(), item]))
  const consumedSnapshots = new Set<HarnessDeployUnitMapping>()
  const rows = catalog.map((item) => {
    const snapshot =
      snapshotsById.get(item.deployUnitIdMapping) ?? snapshotsByUnit.get(item.deployUnitId.trim())
    if (snapshot) {
      consumedSnapshots.add(snapshot)
      return snapshot
    }
    return {
      deployUnitIdMapping: item.deployUnitIdMapping,
      deployUnitId: item.deployUnitId,
      description: item.description,
      localRepoPath: item.repositoryPaths[0]?.localRepoPath ?? ""
    }
  })
  for (const snapshot of snapshots) {
    if (!consumedSnapshots.has(snapshot)) rows.push(snapshot)
  }
  return rows
}
