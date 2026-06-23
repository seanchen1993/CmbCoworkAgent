import { mkdtemp, rm } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { describe, expect, it } from "vitest"
import {
  CoordinatorWorkerManager,
  type CoordinatorWorkerSnapshot
} from "./agent/coordinator-worker-manager"

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for worker notification")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe("coordinator worker attention source", () => {
  it("emits a terminal notification without a renderer subscription", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "coordinator-attention-"))
    const notifications: CoordinatorWorkerSnapshot[] = []
    try {
      const manager = new CoordinatorWorkerManager({
        onTerminalNotification: (worker) => notifications.push(worker)
      })
      const worker = manager.startWorker({
        parentThreadId: "thread-background",
        workspacePath: workspace,
        role: "implementer",
        description: "Background task",
        prompt: "Finish in background",
        runner: async () => ({ summary: "done" })
      })

      await manager.waitForWorkers("thread-background", {
        workerId: worker.worker_id,
        timeoutMs: 1_000,
        pollIntervalMs: 10
      })
      await waitFor(() => notifications.length === 1)

      expect(notifications[0].status).toBe("completed")
      expect(notifications[0].parent_thread_id).toBe("thread-background")
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })
})
