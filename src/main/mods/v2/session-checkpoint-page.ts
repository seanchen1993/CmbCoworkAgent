import { Buffer } from "node:buffer"
import type {
  FunctionSessionMessagePage,
  FunctionSessionPageInput
} from "../../../shared/mods/v2/session"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import { encodeModJson } from "../../../shared/mods/validation"
import { visitLatestCheckpointMessages } from "../../checkpointer/runtime-projection-store"
import { projectFunctionSessionMessage } from "./session-transcript"

const PAGE_BYTES = 256 * 1024 - 4096

/** Worker-only projection: raw history stays in the worker, only this window crosses to main. */
export function readFunctionSessionCheckpointPage(
  databasePath: string,
  threadId: string,
  checkpointNs: string,
  page: FunctionSessionPageInput,
  cancellationBuffer?: SharedArrayBuffer
): FunctionSessionMessagePage | null {
  if (
    !Number.isSafeInteger(page.offset) ||
    page.offset < 0 ||
    page.offset > 100000 ||
    !Number.isSafeInteger(page.limit) ||
    page.limit < 1 ||
    page.limit > 100 ||
    (page.checkpointId !== undefined &&
      (typeof page.checkpointId !== "string" ||
        !page.checkpointId ||
        page.checkpointId.length > 512))
  )
    throw new ModFunctionError("MODS_AGENT_PAGE_ARGUMENTS")
  const messages: FunctionSessionMessagePage["messages"] = []
  let next = page.offset
  let bytes = 0
  let skippedMessages = 0
  let full = false
  const skip = (index: number) => {
    if (full) return
    skippedMessages++
    next = index + 1
  }
  const snapshot = visitLatestCheckpointMessages(
    databasePath,
    threadId,
    checkpointNs,
    (raw, index) => {
      if (full) return
      try {
        const message = projectFunctionSessionMessage(raw)
        if (!message) {
          next = index + 1
          return
        }
        const json = encodeModJson(message)
        const size = Buffer.byteLength(json)
        if (size > PAGE_BYTES) {
          skip(index)
          return
        }
        if (bytes + size + 1 > PAGE_BYTES) {
          full = true
          return
        }
        messages.push(JSON.parse(json))
        bytes += size + 1
        next = index + 1
      } catch (error) {
        if (!(error instanceof ModFunctionError)) throw error
        // An exact message that cannot fit/validate is explicitly omitted, never summarized.
        skip(index)
      }
    },
    {
      cancellationBuffer,
      messageRange: { start: page.offset, end: Math.min(100000, page.offset + page.limit) },
      onOversizedMessage: skip
    }
  )
  if (!snapshot) return null
  if (
    page.offset > snapshot.messageCount ||
    (page.checkpointId !== undefined && page.checkpointId !== snapshot.checkpointId)
  )
    throw new ModFunctionError("MODS_AGENT_CURSOR_CHANGED")
  return {
    ...snapshot,
    messages,
    offset: page.offset,
    ...(next < snapshot.messageCount ? { nextOffset: next } : {}),
    skippedMessages,
    partial: skippedMessages > 0
  }
}
