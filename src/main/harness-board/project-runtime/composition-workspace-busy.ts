import { existsSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { isSameWorkspacePath } from "../../../shared/workspace-path"

/** Called under the composition admission mutex; bounded queries inspect original engine leases. */
export function assertOriginalProjectWorkspaceIdle(
  workspace: string, hostPath: string, legacyPath: string
): void {
  for (const [path, query] of [
    [hostPath, `SELECT json_extract(p.data,'$.workspace') AS workspace FROM host_operations o
      JOIN host_projects p ON p.id=o.project_id
      WHERE o.status IN ('prepared','started','cancel_requested','succeeded','unknown')`],
    [legacyPath, `SELECT json_extract(data,'$.workspace') AS workspace FROM legacy_operations
      WHERE status IN ('started','unknown')`]
  ]) {
    if (!existsSync(path)) continue
    const db = new DatabaseSync(path, { readOnly: true, timeout: 1000 })
    try {
      for (const row of db.prepare(query).iterate()) {
        if (typeof row.workspace !== "string") throw Error("COMPOSITION_EXISTING_RUN_INVALID")
        if (isSameWorkspacePath(row.workspace, workspace)) throw Error("COMPOSITION_WORKSPACE_BUSY")
      }
    } finally { db.close() }
  }
}
