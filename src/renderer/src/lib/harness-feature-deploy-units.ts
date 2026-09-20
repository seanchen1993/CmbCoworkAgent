import type {
  HarnessDeployUnitConfig,
  HarnessDeployUnitMapping
} from "../../../shared/harness-board-types"

/** Existing feature drafts own their IDs and values, even when a catalog unit is recreated. */
export function buildFeatureDeployUnitRows(
  catalog: HarnessDeployUnitConfig[],
  snapshots: HarnessDeployUnitMapping[]
): HarnessDeployUnitMapping[] {
  const snapshotIds = new Set(snapshots.map((item) => item.deployUnitIdMapping))
  const rows = new Map<string, HarnessDeployUnitMapping>()
  for (const item of catalog) {
    if (snapshotIds.has(item.deployUnitIdMapping)) continue
    rows.set(item.deployUnitId.trim(), {
      deployUnitIdMapping: item.deployUnitIdMapping,
      deployUnitId: item.deployUnitId,
      description: item.description,
      localRepoPath: item.repositoryPaths[0]?.localRepoPath ?? ""
    })
  }
  for (const snapshot of snapshots) rows.set(snapshot.deployUnitId.trim(), snapshot)
  return [...rows.values()]
}
