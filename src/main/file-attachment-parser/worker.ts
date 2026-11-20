import { parentPort } from "node:worker_threads"
import { parseFileBytes } from "../file-parser"
import {
  FILE_ATTACHMENT_PARSE_CANCELLED,
  FILE_ATTACHMENT_PARSE_MAX_RESPONSE_BYTES,
  type FileAttachmentParserWorkerRequest,
  type FileAttachmentParserWorkerResponse
} from "./protocol"

if (!parentPort) throw new Error("File attachment parser worker requires parentPort")

function cancelledError(): Error {
  const error = new Error("File attachment parsing was cancelled")
  error.name = FILE_ATTACHMENT_PARSE_CANCELLED
  return error
}

function throwIfCancelled(cancellation: Int32Array): void {
  if (Atomics.load(cancellation, 0) !== 0) throw cancelledError()
}

function serializeError(error: unknown): { code: string; message: string; stack?: string } {
  if (error instanceof Error) {
    return { code: error.name || "FILE_ATTACHMENT_PARSE_ERROR", message: error.message }
  }
  return { code: "FILE_ATTACHMENT_PARSE_ERROR", message: String(error) }
}

parentPort.on("message", (request: FileAttachmentParserWorkerRequest) => {
  if (request.type === "shutdown") {
    parentPort?.postMessage({
      type: "shutdown-complete"
    } satisfies FileAttachmentParserWorkerResponse)
    return
  }

  void (async () => {
    const cancellation = new Int32Array(request.cancellationBuffer)
    try {
      throwIfCancelled(cancellation)
      const attachment = await parseFileBytes(
        request.source.fileName,
        request.source.bytes,
        request.maxLength
      )
      throwIfCancelled(cancellation)
      if (Buffer.byteLength(JSON.stringify(attachment), "utf8") > FILE_ATTACHMENT_PARSE_MAX_RESPONSE_BYTES) {
        throw new Error("Parsed attachment response exceeds the IPC budget")
      }
      parentPort?.postMessage({
        type: "parse-result",
        requestId: request.requestId,
        ok: true,
        attachment
      } satisfies FileAttachmentParserWorkerResponse)
    } catch (error) {
      const serialized = serializeError(error)
      if (Atomics.load(cancellation, 0) !== 0) serialized.code = FILE_ATTACHMENT_PARSE_CANCELLED
      parentPort?.postMessage({
        type: "parse-result",
        requestId: request.requestId,
        ok: false,
        error: serialized
      } satisfies FileAttachmentParserWorkerResponse)
    }
  })()
})
