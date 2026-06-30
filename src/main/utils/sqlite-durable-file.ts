import type initSqlJs from "sql.js"
import { type Database as SqlJsDatabase } from "sql.js"
import { existsSync, readFileSync, renameSync, statSync } from "fs"
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
