import { isDevelopmentThreadMetadata } from "../../shared/mods/development-scope"
import type { ThreadIncarnationSnapshot } from "../../shared/thread-incarnation"
import { getDb, getOpenDatabaseFile, getThreadRuntimeScope } from "../db"
import type { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { sqliteRecoveryFamilyKey } from "../db/sqlite-recovery-family"
import { getModsManager } from "../mods/manager"
import type { StockLegacyTranscriptHostSource } from "./runtime-projection-client"
import { legacyReservationProject } from "./legacy-stock-transcript-authority"
import { CHECKPOINT_RUNTIME_PROJECTION_CANCELLED } from "./runtime-projection-protocol"

function readStockLegacyScope(rawMetadata: string | null, resumeProjectReservation = false) {
  try {
    const metadata = JSON.parse(rawMetadata ?? "{}") as Record<string, unknown>
    const workspace = typeof metadata?.workspacePath === "string" ? metadata.workspacePath : ""
    const project = resumeProjectReservation ? legacyReservationProject(metadata) : undefined
    if (!project && !isDevelopmentThreadMetadata(metadata)) return undefined
    const manager = getModsManager()
    return manager?.protects(workspace) ? undefined : { workspace, manager, project }
  } catch {
    return undefined
  }
}

/** Page hydration can request a stock timing audit only under the ordinary Main policy. */
export function canAuditStockLegacyTimes(threadId: string): boolean {
  try {
    const row = getThreadRuntimeScope(threadId)
    return row !== null && readStockLegacyScope(row.metadata) !== undefined
  } catch {
    return false
  }
}

/** Keep the thread mutation lock or the current physical run lease through Worker settlement. */
export function captureStockLegacyTranscriptSource(input: {
  database: NativeSqliteAdapter
  checkpointPath: string
  threadId: string
  incarnation: ThreadIncarnationSnapshot
  resumeProjectReservation?: boolean
  assertCurrent(): void
}): StockLegacyTranscriptHostSource | undefined {
  const { database, checkpointPath, threadId, incarnation, assertCurrent } = input
  const readScope = () => {
    try {
      const row = getThreadRuntimeScope(threadId)
      return row ? readStockLegacyScope(row.metadata, input.resumeProjectReservation) : undefined
    } catch {
      return undefined
    }
  }
  assertCurrent()
  const messageDatabaseFile = getOpenDatabaseFile(database)
  const scope = messageDatabaseFile && readScope()
  if (!messageDatabaseFile || !scope) return undefined
  const projectCheckpointId = scope.project && database.exec(`SELECT checkpoint_id
    FROM legacy_checkpoint_transcript_migrations WHERE thread_id=? AND status='reserving'
      AND scoped_order=1 AND json_valid(ordinal_reservation)`, [threadId])[0]?.values[0]?.[0]
  if (scope.project && (typeof projectCheckpointId !== "string" || !projectCheckpointId)) return undefined
  const projectReservation = scope.project && typeof projectCheckpointId === "string"
    ? Object.freeze({ ...scope.project, checkpointId: projectCheckpointId }) : undefined
  return {
    authority: { messageDatabaseFile, checkpointFamilyKey: sqliteRecoveryFamilyKey(checkpointPath),
      incarnation, workspace: scope.workspace, ...(projectReservation && { projectReservation }) },
    assertCurrent() {
      assertCurrent()
      // The Worker migrates persisted stock data. Renderer delivery still has to
      // pass the live Main output policy of the same workspace and manager.
      const current = readScope()
      if (getDb() !== database || !current || current.workspace !== scope.workspace ||
        current.manager !== scope.manager || current.project?.projectId !== scope.project?.projectId ||
        current.project?.kind !== scope.project?.kind) {
        throw Object.assign(Error("Legacy transcript policy or source changed"), {
          name: CHECKPOINT_RUNTIME_PROJECTION_CANCELLED
        })
      }
    }
  }
}
