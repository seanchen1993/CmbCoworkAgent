import { parentPort } from "node:worker_threads"
import { WORKSPACE_FILE_PREVIEW_CANCELLED } from "../../shared/workspace-file-preview"
import type {
  WorkspaceFilePreviewWorkerRequest,
  WorkspaceFilePreviewWorkerResponse
} from "./protocol"
import { readPreviewTextPage, resolvePreviewFile } from "./reader"

if (!parentPort) throw new Error("Workspace file preview worker requires parentPort")

function serializeError(error: unknown): { code: string; message: string; stack?: string } {
  if (error instanceof Error) {
    return {
      code: error.name || "WORKSPACE_FILE_PREVIEW_ERROR",
      message: error.message,
      stack: error.stack
    }
  }
  return { code: "WORKSPACE_FILE_PREVIEW_ERROR", message: String(error) }
}

parentPort.on("message", (request: WorkspaceFilePreviewWorkerRequest) => {
  if (request.type === "shutdown") {
    parentPort?.postMessage({ type: "shutdown-complete" } satisfies WorkspaceFilePreviewWorkerResponse)
    return
  }

  void (async () => {
    const cancellation = new Int32Array(request.cancellationBuffer)
    try {
      if (request.type === "read-text") {
        const page = await readPreviewTextPage(
          request.source,
          request.workspacePath,
          request.offset,
          cancellation
        )
        parentPort?.postMessage({
          type: "read-text-result",
          requestId: request.requestId,
          ok: true,
          ...page
        } satisfies WorkspaceFilePreviewWorkerResponse)
        return
      }

      const inspected = await resolvePreviewFile(
        request.source,
        request.workspacePath,
        cancellation
      )
      parentPort?.postMessage({
        type: "inspect-result",
        requestId: request.requestId,
        ok: true,
        ...inspected
      } satisfies WorkspaceFilePreviewWorkerResponse)
    } catch (error) {
      const responseType = request.type === "read-text" ? "read-text-result" : "inspect-result"
      const serialized = serializeError(error)
      if (Atomics.load(cancellation, 0) !== 0) {
        serialized.code = WORKSPACE_FILE_PREVIEW_CANCELLED
      }
      parentPort?.postMessage({
        type: responseType,
        requestId: request.requestId,
        ok: false,
        error: serialized
      } satisfies WorkspaceFilePreviewWorkerResponse)
    }
  })()
})
