import { parentPort } from "node:worker_threads"
import {
  readSkillPluginCatalogPage,
  resolveSkillPreview,
  SkillPluginCatalogCancelledError,
  SkillPluginCatalogCursorExpiredError
} from "./reader"
import type {
  SkillPluginCatalogWorkerRequest,
  SkillPluginCatalogWorkerResponse
} from "./protocol"

const workerPort = parentPort
if (!workerPort) throw new Error("Skill/plugin catalog worker requires a parent port")

workerPort.on("message", (request: SkillPluginCatalogWorkerRequest) => {
  if (request.type === "shutdown") {
    workerPort.postMessage({ type: "shutdown-complete" } satisfies SkillPluginCatalogWorkerResponse)
    return
  }
  try {
    if (request.type === "resolve-preview") {
      const resolution = resolveSkillPreview(
        request.source,
        request.input,
        new Int32Array(request.cancelBuffer)
      )
      workerPort.postMessage({
        type: "resolve-preview-result",
        requestId: request.requestId,
        ok: true,
        resolution
      } satisfies SkillPluginCatalogWorkerResponse)
      return
    }
    const page = readSkillPluginCatalogPage(
      request.source,
      request.input,
      new Int32Array(request.cancelBuffer)
    )
    workerPort.postMessage({
      type: "read-page-result",
      requestId: request.requestId,
      ok: true,
      page
    } satisfies SkillPluginCatalogWorkerResponse)
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error(String(error))
    const code =
      error instanceof SkillPluginCatalogCancelledError ||
      error instanceof SkillPluginCatalogCursorExpiredError
        ? error.code
        : "SKILL_PLUGIN_CATALOG_FAILED"
    workerPort.postMessage({
      type: request.type === "resolve-preview" ? "resolve-preview-result" : "read-page-result",
      requestId: request.requestId,
      ok: false,
      error: {
        code,
        message: normalized.message,
        ...(normalized.stack ? { stack: normalized.stack } : {})
      }
    } satisfies SkillPluginCatalogWorkerResponse)
  }
})
