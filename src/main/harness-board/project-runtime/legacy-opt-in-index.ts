import { lstatSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { hostRecord, hostText } from "./host-state-protocol"

export function legacyIndexFilePresent(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false }) !== undefined
}

/** The index contains only project IDs and opt-in generations. Unknown is never empty. */
export class LegacyOptInIndex {
  constructor(private readonly path: string) {}

  exists(): boolean {
    return legacyIndexFilePresent(this.path)
  }

  read(): ReadonlyMap<string, string> | undefined {
    try {
      if (!lstatSync(this.path, { throwIfNoEntry: false })?.isFile()) return undefined
      const db = new DatabaseSync(this.path, { readOnly: true, timeout: 0 })
      try {
        const row = db.prepare("SELECT data FROM opt_in_index WHERE id=1").get()
        const data = hostRecord(JSON.parse(String(row?.data)), ["version", "projects"])
        if (data.version !== 1 || !Array.isArray(data.projects)) return undefined
        const projects = new Map<string, string>()
        for (const entry of data.projects) {
          if (!Array.isArray(entry) || entry.length !== 2) return undefined
          const id = hostText(entry[0])
          if (projects.has(id)) return undefined
          projects.set(id, hostText(entry[1], 64))
        }
        return projects
      } finally {
        db.close()
      }
    } catch {
      return undefined
    }
  }

  /** Called under the original ledger's write lock, except before a new ledger exists. */
  write(projects: ReadonlyMap<string, string>): void {
    const file = lstatSync(this.path, { throwIfNoEntry: false })
    if (file && !file.isFile()) throw Error("PROJECT_LEGACY_OPT_IN_INDEX_UNAVAILABLE")
    const db = new DatabaseSync(this.path, { timeout: 1000 })
    try {
      db.exec("PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS opt_in_index (id INTEGER PRIMARY KEY, data TEXT NOT NULL)")
      db.prepare(`INSERT INTO opt_in_index VALUES (1, ?)
        ON CONFLICT(id) DO UPDATE SET data=excluded.data WHERE opt_in_index.data<>excluded.data`)
        .run(JSON.stringify({ version: 1, projects: [...projects].sort(([a], [b]) => a.localeCompare(b)) }))
    } finally {
      db.close()
    }
  }
}
