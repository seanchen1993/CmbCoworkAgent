import {
  parseThreadTranscriptSourceScope,
  type ThreadTranscriptSourceScope
} from "../../shared/thread-transcript-source-scope"
import type { ThreadIncarnation } from "../services/thread-incarnation"
import type { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import {
  THREAD_RUNTIME_SCOPE_EXPRESSION,
  THREAD_RUNTIME_SCOPE_INDEX
} from "../db/thread-runtime-scope-query"

interface DisplayRead {
  readonly database: Pick<NativeSqliteAdapter, "prepareReadOne">
  readonly row: { thread_id: string }
  readonly incarnation: ThreadIncarnation
  assertCurrent(): void
}

/** Only the workspace scalar crosses SQLite. Never parse or clone a whole metadata body on Main. */
export function captureThreadTranscriptSourceScope(
  threadId: string,
  read: DisplayRead
): ThreadTranscriptSourceScope | undefined {
  read.assertCurrent()
  if (read.row.thread_id !== threadId) throw Error("MODS_CONVERSATION_THREAD_CHANGED")
  const metadata = THREAD_RUNTIME_SCOPE_EXPRESSION
  const row = read.database.prepareReadOne(`SELECT CASE WHEN json_valid(${metadata})
    THEN CASE WHEN json_type(${metadata},'$.workspacePath')='text'
      THEN json_extract(${metadata},'$.workspacePath') END END AS workspacePath
    FROM threads INDEXED BY ${THREAD_RUNTIME_SCOPE_INDEX} WHERE thread_id=? LIMIT 1`)([threadId])
  if (!row) throw Error("MODS_CONVERSATION_THREAD_CHANGED")
  const workspacePath =
    typeof row.workspacePath === "string" && row.workspacePath.trim()
      ? row.workspacePath
      : undefined
  const source = parseThreadTranscriptSourceScope({
    threadId,
    incarnation: {
      token: read.incarnation.token,
      legacyCreatedAt: read.incarnation.legacyCreatedAt
    },
    ...(workspacePath === undefined ? {} : { workspacePath })
  })
  read.assertCurrent()
  return source
}
