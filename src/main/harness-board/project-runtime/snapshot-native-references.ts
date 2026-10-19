import type { NativeSqliteAdapter } from "../../db/native-sqlite-adapter"
import { snapshotDigestsInRecord } from "./snapshot-reference-audit"
import type { SnapshotReferenceAudit } from "./snapshot-retention"

/** Read the complete native ledger, including archived/remote chats; never UI list pagination. */
export function auditNativeSnapshotReferences(db: NativeSqliteAdapter): SnapshotReferenceAudit {
  const digests = new Set<string>()
  try {
    const statement = db.prepare("SELECT metadata,thread_values FROM threads")
    try {
      while (statement.step()) {
        const row = statement.getAsObject()
        for (const text of [row.metadata, row.thread_values]) {
          if (text === null || text === undefined || text === "") continue
          if (typeof text !== "string" || Buffer.byteLength(text) > 16 * 1024 * 1024)
            throw Error("SNAPSHOT_NATIVE_REFERENCE_INVALID")
          const value: unknown = JSON.parse(text)
          if (!value || typeof value !== "object" || Array.isArray(value))
            throw Error("SNAPSHOT_NATIVE_REFERENCE_INVALID")
          const found = snapshotDigestsInRecord(value)
          for (const digest of found) digests.add(digest)
          for (const [key, field] of Object.entries(value)) {
            if (
              /^(project_?host|project_?runtime|pluginSourceSnapshot)$/i.test(key) &&
              field !== null &&
              !snapshotDigestsInRecord(field).size
            )
              throw Error("SNAPSHOT_NATIVE_REFERENCE_FORMAT_UNKNOWN")
          }
        }
      }
    } finally {
      statement.free()
    }
    return { complete: true, digests, blockers: [] }
  } catch {
    return { complete: false, digests, blockers: ["SNAPSHOT_NATIVE_REFERENCE_AUDIT_INCOMPLETE"] }
  }
}
