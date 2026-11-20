import { visitLatestCheckpointMessages } from "../../checkpointer/runtime-projection-store"
import { countFunctionSessionTurns, FunctionSessionTranscriptWindow } from "./session-transcript"

/** Called only in the checkpoint worker; raw history never crosses the process boundary. */
export function readFunctionSessionCheckpoint(
  databasePath: string,
  threadId: string,
  checkpointNs: string,
  cancellationBuffer?: SharedArrayBuffer,
  projection: "messages" | "turns" = "messages"
) {
  const window = new FunctionSessionTranscriptWindow()
  let turns = 0
  const snapshot = visitLatestCheckpointMessages(
    databasePath,
    threadId,
    checkpointNs,
    (message) => {
      if (projection === "turns") turns += countFunctionSessionTurns([message])
      else window.push(message)
    },
    { cancellationBuffer }
  )
  return snapshot
    ? { ...snapshot, ...(projection === "turns" ? { turns } : window.finish()) }
    : null
}
