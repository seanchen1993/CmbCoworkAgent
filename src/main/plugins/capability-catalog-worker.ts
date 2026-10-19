import { parentPort } from "node:worker_threads"
import { readNativeCapabilityCatalog } from "./capability-catalog"

const port = parentPort
if (!port) throw Error("CAPABILITY_CATALOG_WORKER_REQUIRED")
let reading = false
port.on(
  "message",
  async (request: {
    id: number
    plugin: Parameters<typeof readNativeCapabilityCatalog>[0]
    context: Parameters<typeof readNativeCapabilityCatalog>[1]
  }) => {
    if (reading) {
      port.postMessage({ id: request.id, error: "COMPOSITION_CATALOG_BUSY" })
      return
    }
    reading = true
    try {
      const result = await readNativeCapabilityCatalog(request.plugin, request.context)
      port.postMessage({ id: request.id, result })
    } catch {
      port.postMessage({ id: request.id, error: "COMPOSITION_CATALOG_BUSY" })
    } finally {
      reading = false
    }
  }
)
