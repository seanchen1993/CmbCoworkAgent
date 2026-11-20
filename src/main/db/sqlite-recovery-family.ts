import { existsSync, statSync, type BigIntStats } from "node:fs"
import { basename } from "node:path"

export const SQLITE_RECOVERY_SUFFIXES = ["", ".flush.tmp", ".tmp", ".bak", ".bak.tmp"]
const SQLITE_RECOVERY_FILES = SQLITE_RECOVERY_SUFFIXES.flatMap((suffix) => [suffix, `${suffix}-wal`])
export const EMPTY_SQLITE_RECOVERY_FAMILY_KEY = JSON.stringify(SQLITE_RECOVERY_FILES.map(() => null))

function sqliteRecoveryFileIdentity(file: BigIntStats | undefined, wal: boolean) {
  if (!file || (wal && file.size === 0n)) return null
  return [String(file.dev), String(file.ino), String(file.size), String(file.mtimeNs), String(file.ctimeNs)]
}

export function hasSqliteRecoverySidecar(path: string): boolean {
  return SQLITE_RECOVERY_SUFFIXES.some((suffix) => suffix && existsSync(path + suffix))
}

/** A bounded file-family snapshot. Empty WAL files can be created by readers. */
export function sqliteRecoveryFamilyKey(path: string, directorySnapshot?: ReadonlySet<string>): string {
  const name = directorySnapshot ? basename(path).toLowerCase() : ""
  return JSON.stringify(
    SQLITE_RECOVERY_FILES.map((suffix) => {
      if (directorySnapshot && !directorySnapshot.has(name + suffix)) return null
      const info = statSync(path + suffix, { bigint: true, throwIfNoEntry: false })
      return sqliteRecoveryFileIdentity(info, suffix.endsWith("-wal"))
    })
  )
}
