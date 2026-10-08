import { parentPort } from "node:worker_threads"
import { shellEditLineFragments } from "./adoption-lines"

parentPort?.on(
  "message",
  (input: { id: number; before: Uint8Array | string; after: Uint8Array | string }) => {
    try {
      const before = typeof input.before === "string" ? input.before : Buffer.from(input.before)
      const after = typeof input.after === "string" ? input.after : Buffer.from(input.after)
      parentPort?.postMessage({ id: input.id, result: shellEditLineFragments(before, after) })
    } catch (error) {
      parentPort?.postMessage({
        id: input.id,
        error: error instanceof Error ? error.message : "Diff failed"
      })
    }
  }
)
