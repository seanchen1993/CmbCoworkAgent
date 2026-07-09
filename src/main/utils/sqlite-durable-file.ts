import type initSqlJs from "sql.js"
import { type Database as SqlJsDatabase } from "sql.js"
import { existsSync, readFileSync, renameSync, statSync, unlinkSync } from "fs"
import { mkdir, open, rename, stat } from "fs/promises"
import { dirname } from "path"

type SqlJsModule = Awaited<ReturnType<typeof initSqlJs>>

export interface OpenRecoveredSqliteResult {
  database: SqlJsDatabase | null
  sourcePath: string | null
  recovered: boolean
}

interface Candidate {
  path: string
  suffix: string
  mtimeMs: number
}

const RECOVERY_SUFFIXES = ["", ".flush.tmp", ".tmp", ".bak", ".bak.tmp"]

/** Every fixed-suffix variant a durable sqlite file can leave on disk: the
 * recovery candidates plus the transient `.recovery.tmp` used while restoring.
 * Deleting a durable db MUST remove all of these — removing only the live file
 * lets openRecoveredSqliteDatabase resurrect the old contents from `.bak`
 * (that resurrection is exactly the workflow-resume thread-collision bug).
 * Timestamped `.corrupt.<ts>` / `.bak.<ts>` quarantine files are intentionally
 * NOT listed: they are never recovery candidates, and are kept for forensics. */
const DURABLE_FILE_SUFFIXES = [...RECOVERY_SUFFIXES, ".recovery.tmp"]

// Deletion order: sidecars FIRST, live file LAST. If the process crashes between
// unlinks, the leftover state is "live present, some sidecars gone" — safe, the
// data is still current — rather than "live gone, .bak present", which the
// recovery path would resurrect.
const DELETE_ORDER = [...DURABLE_FILE_SUFFIXES.filter((suffix) => suffix !== ""), ""]

// Longest-suffix-first so `.bak.tmp` matches before `.tmp`.
const VARIANT_MATCH_ORDER = [...DURABLE_FILE_SUFFIXES].sort((a, b) => b.length - a.length)

/** Quarantine archives (`<db>.corrupt.<ts>` from archiveInvalidLiveFile,
 * `<db>.bak.<ts>` from the oversized-DB backup in sqljs-saver). They are never
 * recovery candidates, but they can hold a full checkpoint transcript — thread
 * deletion must remove them too: "delete" means the data is gone, not merely
 * unrecoverable. */
const QUARANTINE_RE = /\.sqlite\.(?:corrupt|bak)\.\d+$/

/** If `filename` is a quarantine archive of a durable sqlite file, return the
 * base name (without `.sqlite.corrupt.<ts>` / `.sqlite.bak.<ts>`); else null. */
export function sqliteQuarantineVariantBase(filename: string): string | null {
  const match = QUARANTINE_RE.exec(filename)
  if (!match || match.index === 0) return null
  return filename.slice(0, match.index)
}

/** If `filename` is `<base>.sqlite` or one of its durable sidecar variants,
 * return `<base>`; otherwise null. Lets directory sweeps recognise leftovers
 * (e.g. a `.bak` whose live file is already gone) without duplicating the
 * suffix list at every call site. */
export function sqliteDurableVariantBase(filename: string): string | null {
  for (const suffix of VARIANT_MATCH_ORDER) {
    const full = `.sqlite${suffix}`
    if (filename.endsWith(full)) {
      const base = filename.slice(0, -full.length)
      return base.length > 0 ? base : null
    }
  }
  return null
}

/** Delete a durable sqlite file AND all its sidecar variants. Returns true if
 * the live file existed. ENOENT is tolerated per-variant so concurrent
 * cleanups (subagent self-clean vs. thread deletion) can race safely. */
export function deleteSqliteDurableFileSync(dbPath: string): boolean {
  let removedLive = false
  for (const suffix of DELETE_ORDER) {
    try {
      unlinkSync(`${dbPath}${suffix}`)
      if (suffix === "") removedLive = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }
  return removedLive
}

async function writeFileDurable(filePath: string, data: Buffer): Promise<void> {
  const handle = await open(filePath, "w")
  try {
    await handle.writeFile(data)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

function isIntegrityOk(database: SqlJsDatabase): boolean {
  const result = database.exec("PRAGMA integrity_check")
  return result[0]?.values[0]?.[0] === "ok"
}

function tryOpenCandidate(SQL: SqlJsModule, candidate: Candidate): SqlJsDatabase | null {
  try {
    const database = new SQL.Database(readFileSync(candidate.path))
    if (!isIntegrityOk(database)) {
      database.close()
      return null
    }
    return database
  } catch {
    return null
  }
}

async function getCandidates(dbPath: string, maxBytes?: number): Promise<Candidate[]> {
  const candidates = await Promise.all(
    RECOVERY_SUFFIXES.map(async (suffix): Promise<Candidate | null> => {
      const path = `${dbPath}${suffix}`
      try {
        const stats = await stat(path)
        if (!stats.isFile() || stats.size <= 0) return null
        if (maxBytes && stats.size > maxBytes) return null
        return { path, suffix, mtimeMs: stats.mtimeMs }
      } catch {
        return null
      }
    })
  )

  return candidates
    .filter((candidate): candidate is Candidate => candidate !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
}

function chooseRecoveryCandidate(
  validCandidates: Array<{ candidate: Candidate; database: SqlJsDatabase }>,
  liveCandidate?: Candidate
): { candidate: Candidate; database: SqlJsDatabase } {
  const live = validCandidates.find((entry) => entry.candidate.suffix === "")
  if (live) {
    const newerTemp = validCandidates
      .filter(
        (entry) =>
          (entry.candidate.suffix === ".tmp" || entry.candidate.suffix === ".flush.tmp") &&
          entry.candidate.mtimeMs > (liveCandidate?.mtimeMs ?? live.candidate.mtimeMs)
      )
      .sort((a, b) => b.candidate.mtimeMs - a.candidate.mtimeMs)[0]
    return newerTemp ?? live
  }

  return [...validCandidates].sort((a, b) => b.candidate.mtimeMs - a.candidate.mtimeMs)[0]
}

function archiveInvalidLiveFile(dbPath: string, label: string): void {
  if (!existsSync(dbPath)) return
  const archivePath = `${dbPath}.corrupt.${Date.now()}`
  try {
    renameSync(dbPath, archivePath)
    console.warn(`[${label}] Archived invalid database: ${archivePath}`)
  } catch (error) {
    console.warn(`[${label}] Failed to archive invalid database:`, error)
  }
}

export async function persistSqliteSnapshot(
  dbPath: string,
  data: Buffer,
  label: string,
  options: { tmpSuffix?: string } = {}
): Promise<void> {
  await mkdir(dirname(dbPath), { recursive: true })

  const tmp = `${dbPath}${options.tmpSuffix ?? ".tmp"}`
  await writeFileDurable(tmp, data)
  await rename(tmp, dbPath)

  try {
    const bakTmp = `${dbPath}.bak.tmp`
    await writeFileDurable(bakTmp, data)
    await rename(bakTmp, `${dbPath}.bak`)
  } catch (error) {
    console.warn(`[${label}] Failed to update database backup:`, error)
  }
}

export async function openRecoveredSqliteDatabase(
  SQL: SqlJsModule,
  dbPath: string,
  label: string,
  options: { maxBytes?: number } = {}
): Promise<OpenRecoveredSqliteResult> {
  await mkdir(dirname(dbPath), { recursive: true })

  const rawCandidates = await getCandidates(dbPath, options.maxBytes)
  if (rawCandidates.length === 0) {
    return { database: null, sourcePath: null, recovered: false }
  }

  const liveCandidate = rawCandidates.find((candidate) => candidate.path === dbPath)
  let liveIsHealthy = false
  const validCandidates: Array<{ candidate: Candidate; database: SqlJsDatabase }> = []

  for (const candidate of rawCandidates) {
    const database = tryOpenCandidate(SQL, candidate)
    if (!database) continue
    if (candidate.path === dbPath) liveIsHealthy = true
    validCandidates.push({ candidate, database })
  }

  if (validCandidates.length === 0) {
    archiveInvalidLiveFile(dbPath, label)
    return { database: null, sourcePath: null, recovered: false }
  }

  const selected = chooseRecoveryCandidate(validCandidates, liveCandidate)
  const selectedCandidate = selected.candidate
  const selectedDatabase = selected.database
  for (const extra of validCandidates) {
    if (extra === selected) continue
    extra.database.close()
  }

  if (selectedCandidate.path !== dbPath) {
    if (liveCandidate && !liveIsHealthy) {
      archiveInvalidLiveFile(dbPath, label)
    }
    await persistSqliteSnapshot(dbPath, Buffer.from(readFileSync(selectedCandidate.path)), label, {
      tmpSuffix: ".recovery.tmp"
    })
    console.warn(`[${label}] Recovered database from: ${selectedCandidate.path}`)
  }

  return {
    database: selectedDatabase,
    sourcePath: selectedCandidate.path,
    recovered: selectedCandidate.path !== dbPath
  }
}

export function sqliteFileSize(path: string): number | null {
  try {
    return statSync(path).size
  } catch {
    return null
  }
}
