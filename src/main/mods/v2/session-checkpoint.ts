import { visitLatestCheckpointMessages } from "../../checkpointer/runtime-projection-store"
import { countFunctionSessionTurns, FunctionSessionTranscriptWindow } from "./session-transcript"
import { ContextUsageObservation } from "../../agent/context-usage"
import type { FunctionSessionCheckpoint } from "../../../shared/mods/v2/session"

/** Called only in the checkpoint worker; raw history never crosses the process boundary. */
export function readFunctionSessionCheckpoint(
  databasePath: string,
  threadId: string,
  checkpointNs: string,
  cancellationBuffer?: SharedArrayBuffer,
  projection: "messages" | "turns" | "usage" = "messages"
): FunctionSessionCheckpoint | null {
  const window = new FunctionSessionTranscriptWindow()
  let turns = 0
  let usage: ContextUsageObservation | undefined
  const snapshot = visitLatestCheckpointMessages(
    databasePath,
    threadId,
    checkpointNs,
    (message) => {
      if (projection === "usage") usage?.push(message)
      else if (projection === "turns") turns += countFunctionSessionTurns([message])
      else window.push(message)
    },
    {
      cancellationBuffer,
      onContextUsageStart:
        projection === "usage"
          ? (startIndex) => {
              usage = new ContextUsageObservation(startIndex)
            }
          : undefined
    }
  )
  return snapshot
    ? {
        ...snapshot,
        ...(projection === "usage"
          ? { usage: usage?.snapshot() }
          : projection === "turns"
            ? { turns }
            : window.finish())
      }
    : null
}
