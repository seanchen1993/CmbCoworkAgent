import {
  parseThreadDirectoryChange,
  type ThreadDirectoryChangeKind
} from "../../shared/thread-directory-change"
import { captureThreadIncarnation, type ThreadIncarnationRow } from "./thread-incarnation"

/** Capture native row facts before deletion, and notify only after the original commit succeeds.
 * Failure to form a complete hint must fall back to the existing unscoped notification.
 */
export function captureThreadDirectoryChange(
  threadId: string,
  kind: ThreadDirectoryChangeKind,
  row: ThreadIncarnationRow | null | undefined
) {
  if (!row) return undefined
  try {
    const metadata = row.metadata === null ? undefined : JSON.parse(row.metadata)
    if (metadata !== undefined &&
      (!metadata || typeof metadata !== "object" || Array.isArray(metadata))) return undefined
    const incarnation = captureThreadIncarnation(row)
    return parseThreadDirectoryChange({
      threadId,
      kind,
      workspacePath: metadata?.workspacePath,
      incarnation: { token: incarnation.token, legacyCreatedAt: incarnation.legacyCreatedAt }
    })
  } catch {
    return undefined
  }
}
