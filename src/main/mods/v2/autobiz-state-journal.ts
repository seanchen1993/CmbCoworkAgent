import { createHash } from "node:crypto"
import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { getCmbCoworkAgentDataRoot } from "../../app-data-root"

export interface AutobizCommitEvidence {
  before: [string, string]
  after: [string, string]
  identities: [string, string]
  beforeContent: [string, string]
  afterContent: [string, string]
}

function contains(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path === "" || (!path.startsWith("..") && !isAbsolute(path))
}

/** A host-owned database, never a receipt or path supplied by a plugin/workspace. */
export class AutobizStateJournal {
  private readonly db: DatabaseSync
  readonly root: string
  readonly workspace: string
  readonly operationId: string

  constructor(
    workspace: string,
    private readonly identity: string,
    key: string,
    readOnly = false
  ) {
    if (process.platform !== "win32") throw Error("AUTOBIZ_COMMIT_PLATFORM_UNSUPPORTED")
    this.workspace = realpathSync(workspace).toLowerCase()
    const configured = resolve(getCmbCoworkAgentDataRoot())
    if (contains(this.workspace, configured.toLowerCase())) throw Error("AUTOBIZ_JOURNAL_UNTRUSTED")
    // Reject junctions in the host store's existing ancestry instead of following
    // a workspace-controlled link into a forged database.
    for (let path = configured; ; path = dirname(path)) {
      if (existsSync(path) && lstatSync(path).isSymbolicLink())
        throw Error("AUTOBIZ_JOURNAL_UNTRUSTED")
      if (dirname(path) === path) break
    }
    this.root = join(configured, "mods", "autobiz-commits")
    if (readOnly) {
      if (!existsSync(this.root)) throw Error("AUTOBIZ_RECOVERY_MISSING")
    } else mkdirSync(this.root, { recursive: true })
    for (const path of [join(configured, "mods"), this.root])
      if (lstatSync(path).isSymbolicLink()) throw Error("AUTOBIZ_JOURNAL_UNTRUSTED")
    const file = join(this.root, "journal.sqlite")
    if (readOnly && !existsSync(file)) throw Error("AUTOBIZ_RECOVERY_MISSING")
    if (existsSync(file) && lstatSync(file).isSymbolicLink())
      throw Error("AUTOBIZ_JOURNAL_UNTRUSTED")
    this.operationId = createHash("sha256")
      .update(this.workspace)
      .update("\0")
      .update(key)
      .digest("hex")
    this.db = new DatabaseSync(file, { timeout: 1000, readOnly })
    try {
      if (!readOnly)
        this.db.exec(`
      PRAGMA journal_mode = DELETE;
      PRAGMA synchronous = EXTRA;
      CREATE TABLE IF NOT EXISTS commits (
        operation_id TEXT PRIMARY KEY, workspace TEXT NOT NULL, identity TEXT NOT NULL,
        status TEXT NOT NULL, evidence TEXT NOT NULL, at INTEGER NOT NULL
      );
    `)
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  receipt(): AutobizCommitEvidence | undefined {
    const unresolved = this.db
      .prepare(
        "SELECT operation_id FROM commits WHERE workspace = ? AND status != 'committed' LIMIT 1"
      )
      .get(this.workspace)
    if (unresolved) throw Error(`AUTOBIZ_COMMIT_UNKNOWN:${unresolved.operation_id}`)
    const row = this.db
      .prepare("SELECT * FROM commits WHERE operation_id = ?")
      .get(this.operationId)
    if (!row) return undefined
    if (row.identity !== this.identity) throw Error("AUTOBIZ_RECEIPT_MISMATCH")
    return JSON.parse(String(row.evidence)) as AutobizCommitEvidence
  }

  /** Scoped diagnostics only: does not resolve pending/unknown commits or expose content. */
  inspect(operationId: string): {
    status: "pending" | "unknown" | "committed"
    before: [string, string]
    after: [string, string]
  } {
    if (!/^[a-f0-9]{64}$/.test(operationId)) throw Error("AUTOBIZ_RECOVERY_ID")
    const row = this.db
      .prepare("SELECT status, evidence FROM commits WHERE workspace = ? AND operation_id = ?")
      .get(this.workspace, operationId)
    if (!row) throw Error("AUTOBIZ_RECOVERY_MISSING")
    if (!["pending", "unknown", "committed"].includes(String(row.status)))
      throw Error("AUTOBIZ_RECOVERY_CORRUPT")
    const evidence = JSON.parse(String(row.evidence)) as AutobizCommitEvidence
    for (const hashes of [evidence?.before, evidence?.after])
      if (
        !Array.isArray(hashes) ||
        hashes.length !== 2 ||
        hashes.some((hash) => typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash))
      )
        throw Error("AUTOBIZ_RECOVERY_CORRUPT")
    return {
      status: row.status as "pending" | "unknown" | "committed",
      before: evidence.before,
      after: evidence.after
    }
  }

  begin(evidence: AutobizCommitEvidence): void {
    this.db.exec("BEGIN IMMEDIATE")
    try {
      if (this.receipt()) throw Error("AUTOBIZ_RECEIPT_RACE")
      this.db
        .prepare("INSERT INTO commits VALUES (?, ?, ?, 'pending', ?, ?)")
        .run(this.operationId, this.workspace, this.identity, JSON.stringify(evidence), Date.now())
      this.db.exec("COMMIT")
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    }
  }

  commit(): void {
    const result = this.db
      .prepare(
        "UPDATE commits SET status = 'committed' WHERE operation_id = ? AND status = 'pending'"
      )
      .run(this.operationId)
    if (result.changes !== 1) throw Error("AUTOBIZ_COMMIT_UNKNOWN")
  }

  unknown(): void {
    this.db
      .prepare("UPDATE commits SET status = 'unknown' WHERE operation_id = ?")
      .run(this.operationId)
  }

  close(): void {
    this.db.close()
  }
}
