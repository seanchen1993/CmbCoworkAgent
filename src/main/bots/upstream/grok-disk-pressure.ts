import { stat, statfs } from "node:fs/promises"

export const GIB = 1024 ** 3
export const DISK_PRESSURE_HEARTBEAT_MS = 5 * 60_000
export const DISK_PRESSURE_THRESHOLDS = {
  softAvailableBytes: 8 * GIB,
  softAvailableRatio: 0.15,
  hardAvailableBytes: 2 * GIB,
  hardAvailableRatio: 0.05,
  softRecoveryBytes: 10 * GIB,
  softRecoveryRatio: 0.2,
  hardRecoveryBytes: 3 * GIB,
  hardRecoveryRatio: 0.08
} as const

export type DiskPressureLevel = "healthy" | "soft" | "hard"
export interface DiskVolumeSnapshot {
  readonly volume: string
  readonly deviceId: string
  readonly totalBytes: number
  readonly availableBytes: number
}
export interface DiskVolumeSample {
  readonly snapshots: readonly DiskVolumeSnapshot[]
  readonly complete: boolean
}
interface DiskPressureState {
  readonly level: DiskPressureLevel
  readonly lastReportedAtMs: number
}

export function aggregateDiskPressureLevel(
  states: ReadonlyMap<string, DiskPressureState>
): DiskPressureLevel {
  const values = [...states.values()]
  return values.some((state) => state.level === "hard")
    ? "hard"
    : values.some((state) => state.level === "soft")
      ? "soft"
      : "healthy"
}
export function classifyDiskPressure(
  snapshot: Pick<DiskVolumeSnapshot, "totalBytes" | "availableBytes">,
  previous: DiskPressureLevel = "healthy"
): DiskPressureLevel {
  if (snapshot.totalBytes <= 0) return "healthy"
  const ratio = snapshot.availableBytes / snapshot.totalBytes
  if (
    snapshot.availableBytes <= DISK_PRESSURE_THRESHOLDS.hardAvailableBytes ||
    ratio <= DISK_PRESSURE_THRESHOLDS.hardAvailableRatio
  )
    return "hard"
  if (
    previous === "hard" &&
    (snapshot.availableBytes <= DISK_PRESSURE_THRESHOLDS.hardRecoveryBytes ||
      ratio <= DISK_PRESSURE_THRESHOLDS.hardRecoveryRatio)
  )
    return "hard"
  if (
    snapshot.availableBytes <= DISK_PRESSURE_THRESHOLDS.softAvailableBytes ||
    ratio <= DISK_PRESSURE_THRESHOLDS.softAvailableRatio
  )
    return "soft"
  if (
    previous === "soft" &&
    (snapshot.availableBytes <= DISK_PRESSURE_THRESHOLDS.softRecoveryBytes ||
      ratio <= DISK_PRESSURE_THRESHOLDS.softRecoveryRatio)
  )
    return "soft"
  return "healthy"
}
export async function readDiskVolumeSnapshots(
  roots: readonly { readonly volume: string; readonly path: string }[]
): Promise<DiskVolumeSample> {
  const snapshots: DiskVolumeSnapshot[] = [],
    seenDevices = new Set<string>()
  let complete = true
  for (const root of roots) {
    try {
      const [pathStat, fs] = await Promise.all([
        stat(root.path, { bigint: true }),
        statfs(root.path, { bigint: true })
      ])
      const deviceId = String(pathStat.dev)
      if (seenDevices.has(deviceId)) continue
      seenDevices.add(deviceId)
      snapshots.push({
        volume: root.volume,
        deviceId,
        totalBytes: Number(fs.blocks * fs.bsize),
        availableBytes: Number(fs.bavail * fs.bsize)
      })
    } catch {
      complete = false
    }
  }
  return { snapshots, complete }
}
