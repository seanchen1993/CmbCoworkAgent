import { randomUUID } from "node:crypto"
import type { WorkspaceFileScanEntry } from "../../shared/workspace-file-scan"
import {
  WORKSPACE_FILE_SCAN_PAGE_MAX_BYTES,
  WORKSPACE_FILE_SCAN_PAGE_MAX_ENTRIES
} from "../../shared/workspace-file-scan"
import { WorkspaceFileScanSession } from "./client"

interface OwnedScan {
  ownerId: number
  workspacePath: string
  session: WorkspaceFileScanSession
  directories: Set<string>
}

export interface WorkspaceFileScanManagerPage {
  files: WorkspaceFileScanEntry[]
  done: boolean
  truncated: boolean
  continuation?: string
  workspacePath: string
  directories?: Set<string>
}

const scans = new Map<string, OwnedScan>()
const scanIdsByOwner = new Map<number, Set<string>>()
const MAX_ACTIVE_SCANS_PER_OWNER = 4
const MAX_ACTIVE_SCANS_GLOBAL = 12

function removeOwnedScan(scanId: string): OwnedScan | undefined {
  const scan = scans.get(scanId)
  if (!scan) return undefined
  scans.delete(scanId)
  const owned = scanIdsByOwner.get(scan.ownerId)
  owned?.delete(scanId)
  if (owned?.size === 0) scanIdsByOwner.delete(scan.ownerId)
  return scan
}

export async function openWorkspaceFileScan(
  ownerId: number,
  workspacePath: string
): Promise<{ scanId: string; workspacePath: string }> {
  const evicted: OwnedScan[] = []
  const ownedBeforeOpen = scanIdsByOwner.get(ownerId)
  while ((ownedBeforeOpen?.size ?? 0) >= MAX_ACTIVE_SCANS_PER_OWNER) {
    const oldestScanId = ownedBeforeOpen?.values().next().value
    if (typeof oldestScanId !== "string") break
    const removed = removeOwnedScan(oldestScanId)
    if (removed) evicted.push(removed)
  }
  while (scans.size >= MAX_ACTIVE_SCANS_GLOBAL) {
    const oldestScanId = scans.keys().next().value
    if (typeof oldestScanId !== "string") break
    const removed = removeOwnedScan(oldestScanId)
    if (removed) evicted.push(removed)
  }

  const scanId = randomUUID()
  const session = new WorkspaceFileScanSession(scanId, workspacePath)
  const scan: OwnedScan = {
    ownerId,
    workspacePath,
    session,
    directories: new Set<string>()
  }
  scans.set(scanId, scan)
  const owned = scanIdsByOwner.get(ownerId) ?? new Set<string>()
  owned.add(scanId)
  scanIdsByOwner.set(ownerId, owned)
  try {
    await Promise.all(evicted.map((item) => item.session.close().catch(() => undefined)))
    await session.open()
    return { scanId, workspacePath }
  } catch (error) {
    removeOwnedScan(scanId)
    await session.close()
    throw error
  }
}

export async function readWorkspaceFileScanPage(
  ownerId: number,
  scanId: string,
  continuation?: string
): Promise<WorkspaceFileScanManagerPage> {
  const scan = scans.get(scanId)
  if (!scan || scan.ownerId !== ownerId) throw new Error("Workspace file scan is not available")
  try {
    const page = await scan.session.next(
      WORKSPACE_FILE_SCAN_PAGE_MAX_ENTRIES,
      WORKSPACE_FILE_SCAN_PAGE_MAX_BYTES,
      continuation
    )
    for (const file of page.files) {
      if (file.is_dir) scan.directories.add(file.path.replace(/^\/+/, ""))
    }
    if (!page.done) {
      return {
        ...page,
        workspacePath: scan.workspacePath,
        // Transfer the live Set as soon as the first bounded segment pauses.
        // Continued pages mutate the same Set, so watcher snapshots stay
        // current without a main-thread clone or full directory walk.
        ...(page.truncated ? { directories: scan.directories } : {})
      }
    }
    removeOwnedScan(scanId)
    await scan.session.close()
    return {
      ...page,
      workspacePath: scan.workspacePath,
      directories: scan.directories
    }
  } catch (error) {
    removeOwnedScan(scanId)
    await scan.session.close()
    throw error
  }
}

export async function cancelWorkspaceFileScan(ownerId: number, scanId: string): Promise<void> {
  const scan = scans.get(scanId)
  if (!scan || scan.ownerId !== ownerId) return
  removeOwnedScan(scanId)
  await scan.session.close()
}

export async function cancelWorkspaceFileScansForOwner(ownerId: number): Promise<void> {
  const scanIds = [...(scanIdsByOwner.get(ownerId) ?? [])]
  await Promise.all(scanIds.map((scanId) => cancelWorkspaceFileScan(ownerId, scanId)))
}

export async function closeAllWorkspaceFileScans(): Promise<void> {
  const active = [...scans.values()]
  scans.clear()
  scanIdsByOwner.clear()
  await Promise.all(active.map((scan) => scan.session.close()))
}

export function getActiveWorkspaceFileScanCountForTests(): number {
  return scans.size
}
