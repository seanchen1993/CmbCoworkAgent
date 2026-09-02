import { parentPort } from "node:worker_threads"
import {
  readHarnessCatalogPage,
  readHarnessDialogTips,
  readHarnessLeanToken,
  readHarnessProjectContexts
} from "./catalog-reader"
import type { HarnessCatalogWorkerRequest, HarnessCatalogWorkerResponse } from "./catalog-protocol"

const workerPort = parentPort
if (!workerPort) throw new Error("Harness catalog worker requires a parent port")

workerPort.on("message", (request: HarnessCatalogWorkerRequest) => {
  if (request.type === "shutdown") {
    workerPort.postMessage({ type: "shutdown-complete" } satisfies HarnessCatalogWorkerResponse)
    return
  }
  try {
    if (request.type === "read-dialog-tips") {
      const result = readHarnessDialogTips(
        request.projectStorePath,
        request.pluginStorePath,
        request.leanTokenStorePath,
        request.projectId,
        request.slug,
        request.maxResponseBytes,
        new Int32Array(request.cancelBuffer)
      )
      workerPort.postMessage({
        type: "read-dialog-tips-result",
        requestId: request.requestId,
        ok: true,
        result
      } satisfies HarnessCatalogWorkerResponse)
      return
    }
    if (request.type === "read-lean-token") {
      const result = readHarnessLeanToken(
        request.leanTokenStorePath,
        request.maxResponseBytes,
        new Int32Array(request.cancelBuffer)
      )
      workerPort.postMessage({
        type: "read-lean-token-result",
        requestId: request.requestId,
        ok: true,
        result
      } satisfies HarnessCatalogWorkerResponse)
      return
    }
    if (request.type === "read-project-contexts") {
      const result = readHarnessProjectContexts(
        request.projectStorePath,
        request.pluginStorePath,
        request.projectIds,
        request.maxResponseBytes,
        new Int32Array(request.cancelBuffer),
        request.featureSlug &&
          request.featureBindingStorePath &&
          request.deployUnitMappingStorePath
          ? {
              featureSlug: request.featureSlug,
              featureBindingStorePath: request.featureBindingStorePath,
              deployUnitMappingStorePath: request.deployUnitMappingStorePath
            }
          : undefined,
        request.leanTokenStorePath
      )
      workerPort.postMessage({
        type: "read-project-contexts-result",
        requestId: request.requestId,
        ok: true,
        result
      } satisfies HarnessCatalogWorkerResponse)
      return
    }
    const result = readHarnessCatalogPage(
      request.projectStorePath,
      request.pluginStorePath,
      request.input,
      request.maxResponseBytes,
      new Int32Array(request.cancelBuffer)
    )
    workerPort.postMessage({
      type: "read-page-result",
      requestId: request.requestId,
      ok: true,
      result
    } satisfies HarnessCatalogWorkerResponse)
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error(String(error))
    const code = (normalized as Error & { code?: unknown }).code
    workerPort.postMessage({
      type:
        request.type === "read-dialog-tips"
          ? "read-dialog-tips-result"
          : request.type === "read-lean-token"
          ? "read-lean-token-result"
          : request.type === "read-project-contexts"
          ? "read-project-contexts-result"
          : "read-page-result",
      requestId: request.requestId,
      ok: false,
      error: {
        message: normalized.message,
        ...(normalized.stack ? { stack: normalized.stack } : {}),
        ...(typeof code === "string" ? { code } : {})
      }
    } satisfies HarnessCatalogWorkerResponse)
  }
})
