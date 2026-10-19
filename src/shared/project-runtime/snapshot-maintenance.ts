export const snapshotGroups = ["host", "legacy", "composition", "capabilities"] as const
export type SnapshotGroup = (typeof snapshotGroups)[number]

export interface SnapshotMaintenanceGroup {
  id: SnapshotGroup
  published: number
  protected: number
  candidates: number
  blockers: string[]
}

export interface SnapshotMaintenancePreview {
  previewId: string
  groups: SnapshotMaintenanceGroup[]
}

export interface SnapshotMaintenanceResult {
  removed: number
  remaining: number
  blockers: string[]
}

/** Native maintenance only. No renderer-supplied path or digest can authorize deletion. */
export interface SnapshotMaintenanceApi {
  previewSnapshotMaintenance(): Promise<SnapshotMaintenancePreview>
  collectSnapshotGarbage(previewId: string): Promise<SnapshotMaintenanceResult>
}
