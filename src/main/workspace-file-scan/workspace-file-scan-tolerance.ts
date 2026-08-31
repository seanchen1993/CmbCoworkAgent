import { promises as fs, type Dir, type Dirent, type Stats } from "node:fs"
import type { WorkspaceFileScanEntry } from "../../shared/workspace-file-scan"

const SKIPPABLE_ENTRY_ERROR_CODES = new Set(["ENOENT", "ENOTDIR", "EACCES", "EPERM"])

function isSkippableEntryError(error: unknown): boolean {
  return (
    error instanceof Error &&
    typeof (error as NodeJS.ErrnoException).code === "string" &&
    SKIPPABLE_ENTRY_ERROR_CODES.has((error as NodeJS.ErrnoException).code!)
  )
}

type OpenDirectory = (fullPath: string) => Promise<Dir>
type ReadDirectoryEntry = () => Promise<Dirent | null>
type StatFile = (fullPath: string) => Promise<Stats>

/**
 * A child directory can disappear or become unreadable while a live workspace
 * is being traversed. Skip only those isolated child failures; opening the
 * workspace root remains authoritative and must still fail the whole scan.
 */
export async function openWorkspaceFileScanDirectory(
  fullPath: string,
  isWorkspaceRoot: boolean,
  openDirectory: OpenDirectory = (candidate) => fs.opendir(candidate, { bufferSize: 128 })
): Promise<Dir | null> {
  try {
    return await openDirectory(fullPath)
  } catch (error) {
    if (!isWorkspaceRoot && isSkippableEntryError(error)) return null
    throw error
  }
}

/**
 * A directory can disappear or lose access after opendir succeeds. Treat those
 * bounded races as end-of-frame so candidates already collected from this page
 * are still projected; unexpected filesystem failures remain authoritative.
 */
export async function readWorkspaceFileScanDirectoryEntry(
  readEntry: ReadDirectoryEntry
): Promise<Dirent | null> {
  try {
    return await readEntry()
  } catch (error) {
    if (isSkippableEntryError(error)) return null
    throw error
  }
}

/** Project one file without allowing a volatile sibling to abort the page. */
export async function statWorkspaceFileScanCandidate(
  fullPath: string,
  relativePath: string,
  statFile: StatFile = fs.stat
): Promise<WorkspaceFileScanEntry | null> {
  try {
    const stat = await statFile(fullPath)
    return {
      path: `/${relativePath}`,
      is_dir: false,
      size: stat.size,
      modified_at: stat.mtime.toISOString()
    }
  } catch (error) {
    if (isSkippableEntryError(error)) return null
    throw error
  }
}
