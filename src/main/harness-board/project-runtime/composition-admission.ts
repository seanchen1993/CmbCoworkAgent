import { closeSync, lstatSync, mkdirSync, openSync, realpathSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { runtimeDigest, runtimeDirectory } from "./safe-files"

/** Keep the persisted path as well as its current physical target. */
export function compositionWorkspaceKeys(workspace: string): [string] | [string, string] {
  const lexical = resolve(workspace)
  let physical = lexical
  try {
    physical = realpathSync(lexical)
  } catch (error) {
    // Keep the original validation for absent ordinary directories.
    const code = (error as NodeJS.ErrnoException).code
    if (code !== "ENOENT" && code !== "ENOTDIR") throw error
  }
  const key = (path: string) => process.platform === "win32" ? path.toLowerCase() : path
  const original = key(lexical), actual = key(physical)
  return original === actual ? [original] : [original, actual]
}

export function compositionWorkspaceKey(workspace: string): string {
  const keys = compositionWorkspaceKeys(workspace)
  return keys[1] ?? keys[0]
}

export function compositionDatabaseIdentity(path: string): string {
  const stat = lstatSync(path, { bigint: true })
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n)
    throw Error("COMPOSITION_STORAGE_INVALID")
  return `${stat.dev}:${stat.ino}`
}

export function existingCompositionDatabaseIdentity(path: string): string | undefined {
  try {
    return compositionDatabaseIdentity(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

/**
 * The original composition store remains the owner ledger. These empty SQLite files use the OS
 * rollback-journal locks as workspace-local admission locks. Never unlink a lock file: two
 * connections could otherwise hold locks on different files at the same path. Closing the
 * connection or exiting the process releases its lock.
 */
export function acquireCompositionAdmission(
  databasePath: string,
  key: string,
  mode: "reader" | "writer"
): () => void {
  const directory = join(runtimeDirectory(dirname(databasePath)), "admission")
  mkdirSync(directory, { recursive: true })
  runtimeDirectory(directory)
  const path = join(directory, runtimeDigest(key) + ".sqlite")
  if (!existingCompositionDatabaseIdentity(path)) {
    try {
      closeSync(openSync(path, "wx", 0o600))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    }
  }
  const identity = compositionDatabaseIdentity(path)
  const db = new DatabaseSync(path, { timeout: 0 })
  try {
    if (mode === "writer") db.exec("BEGIN EXCLUSIVE")
    else {
      db.exec("BEGIN")
      // BEGIN alone is deferred; reading the schema acquires and retains a SHARED lock.
      db.prepare("SELECT name FROM sqlite_master LIMIT 1").get()
    }
    if (compositionDatabaseIdentity(path) !== identity ||
      db.prepare("PRAGMA journal_mode").get()?.journal_mode !== "delete")
      throw Error("COMPOSITION_ADMISSION_SCOPE_CHANGED")
  } catch (error) {
    db.close()
    if (error instanceof Error && "errcode" in error && typeof error.errcode === "number") {
      const code = error.errcode & 0xff
      if (code === 5 || code === 6)
        throw Error("COMPOSITION_WORKSPACE_BUSY", { cause: error })
    }
    throw error
  }
  let open = true
  return () => {
    if (!open) return
    open = false
    db.close()
  }
}
