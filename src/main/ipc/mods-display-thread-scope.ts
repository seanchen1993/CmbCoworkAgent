import { ModError } from "../mods/errors"
import {
  captureThreadIncarnation,
  matchesThreadIncarnation,
  type ThreadIncarnationRow
} from "../services/thread-incarnation"

/** A direct desktop display fence. All predicates in one check use one fresh SQLite row.
 * Native children use their parent association protocol in the caller instead.
 */
export function captureDirectDisplayScope<D extends object>(
  workspace: string,
  threadId: string,
  host: {
    database(): D
    read(id: string): ThreadIncarnationRow | null
    canonical(path: string): string
    isChild(id: string): boolean
  }
) {
  const database = host.database()
  const read = () => {
    if (typeof threadId !== "string" || threadId.length > 200)
      throw new ModError("MODS_THREAD_INVALID")
    if (host.database() !== database || host.isChild(threadId))
      throw new ModError("MODS_CALL_SCOPE_CHANGED")
    const row = host.read(threadId)
    if (!row) throw new ModError("MODS_CALL_SCOPE_CHANGED")
    const metadata = typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata
    if (typeof metadata?.workspacePath !== "string") throw new ModError("MODS_WORKSPACE_REQUIRED")
    if (
      metadata.remoteState === "historical" ||
      (metadata.targetKind === "inbox" && metadata.remoteReadOnly === true)
    )
      throw new ModError("MODS_THREAD_READ_ONLY")
    if (host.canonical(metadata.workspacePath) !== workspace)
      throw new ModError("MODS_CALL_SCOPE_CHANGED")
    return row
  }
  const incarnation = captureThreadIncarnation(read())
  return {
    database,
    workspace,
    threadId,
    incarnation,
    assertCurrent() {
      if (!matchesThreadIncarnation(read(), incarnation))
        throw new ModError("MODS_CALL_SCOPE_CHANGED")
    }
  }
}
