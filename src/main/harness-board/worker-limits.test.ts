import { Worker } from "node:worker_threads"
import { describe, expect, it } from "vitest"
import {
  HARNESS_WORKER_RESOURCE_LIMITS,
  harnessWorkerOptions
} from "./worker-limits"

describe("Harness worker resource limits", () => {
  it("applies the shared heap and stack boundary to a real worker", async () => {
    const worker = new Worker("setInterval(() => undefined, 1000)", {
      eval: true,
      ...harnessWorkerOptions("harness-resource-limit-test")
    })
    try {
      expect(worker.resourceLimits).toMatchObject(HARNESS_WORKER_RESOURCE_LIMITS)
    } finally {
      await worker.terminate()
    }
  })
})
