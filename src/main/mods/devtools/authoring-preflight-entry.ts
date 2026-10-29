import { parentPort, workerData } from "node:worker_threads"
import { isAbsolute } from "node:path"
import { analyzeAuthoringPreview } from "./authoring-preflight"
import { authoringCompileDiagnostics } from "./authoring-compile-diagnostics"
import { authoringStructureCode } from "./authoring-structure-diagnostics"

/** Fixed application entry, never author-supplied Worker code or a user compiler plugin. */
async function main() {
  if (!parentPort || typeof workerData?.directory !== "string" || !isAbsolute(workerData.directory))
    throw Error("AUTHORING_PREFLIGHT_INPUT")
  const analysis = await analyzeAuthoringPreview(workerData.directory)
  const text = JSON.stringify(analysis)
  if (Buffer.byteLength(text, "utf8") > 2 * 1024 * 1024)
    throw Error("AUTHORING_PREFLIGHT_RESULT_LIMIT")
  parentPort.postMessage({ ok: true, text })
}
void main().catch((error) => {
  parentPort?.postMessage({
    ok: false,
    structureCode: error instanceof Error ? authoringStructureCode(error.message) : undefined,
    diagnostics:
      typeof workerData?.directory === "string"
        ? authoringCompileDiagnostics(error, workerData.directory)
        : []
  })
})
