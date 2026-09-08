import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { CoordinatorWorkerManager } from "./coordinator-worker-manager"

const tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

describe("coordinator worker history restore cancellation", () => {
  it("commits no partial rows and fully restores pending notifications on re-entry", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "coordinator-restore-cancel-"))
    tempRoots.push(workspacePath)
    const threadId = "thread-cancel-restore-history"
    const workersDir = join(
      workspacePath,
      ".cmbdevclaw",
      "coordinator",
      threadId,
      "workers"
    )
    await mkdir(workersDir, { recursive: true })

    const createdAt = "2026-04-29T00:00:00.000Z"
    const restoreEntries = await Promise.all(
      Array.from({ length: 32 }, async (_, index) => {
        const workerId = `implementer-${10_000 + index}-1`
        await writeFile(
          join(workersDir, `${workerId}.json`),
          JSON.stringify({
            worker_id: workerId,
            worker_thread_id: `${threadId}__worker__${workerId}`,
            parent_thread_id: threadId,
            role: "implementer",
            description: `Historical worker ${index}`,
            status: "completed",
            turns: 1,
            created_at: createdAt,
            updated_at: createdAt,
            finished_at: createdAt,
            notification_acknowledged: false,
            tool_call_count: 0,
            last_event: "Worker completed."
          }),
          "utf8"
        )
        return {
          worker_id: workerId,
          status: "completed",
          notification_acknowledged: false,
          recency: 10_000 + index
        }
      })
    )
    await writeFile(
      join(workersDir, ".restore-index-v1.json"),
      JSON.stringify({
        version: 1,
        complete: true,
        overflow: false,
        entries: restoreEntries
      }),
      "utf8"
    )

    const manager = new CoordinatorWorkerManager()
    const controller = new AbortController()
    const abortedGetter = Object.getOwnPropertyDescriptor(
      AbortSignal.prototype,
      "aborted"
    )?.get
    expect(abortedGetter).toBeTypeOf("function")
    let abortChecks = 0
    let checksAtAbort = 0
    Object.defineProperty(controller.signal, "aborted", {
      configurable: true,
      get: () => {
        abortChecks += 1
        if (abortChecks === 40) {
          checksAtAbort = abortChecks
          controller.abort(new DOMException("Superseded by another thread.", "AbortError"))
        }
        return abortedGetter?.call(controller.signal) as boolean
      }
    })
    const restore = manager.restoreWorkersForThread({
      parentThreadId: threadId,
      workspacePath,
      mode: "full",
      signal: controller.signal
    })

    await expect(restore).rejects.toMatchObject({ name: "AbortError" })
    expect(checksAtAbort).toBe(40)
    expect(manager.readWorkers(threadId)).toHaveLength(0)

    const [recent, active] = await Promise.all([
      manager.restoreWorkersForThread({
        parentThreadId: threadId,
        workspacePath,
        mode: "recent"
      }),
      manager.restoreWorkersForThread({
        parentThreadId: threadId,
        workspacePath,
        mode: "active"
      })
    ])
    expect(recent).toHaveLength(32)
    expect(active).toHaveLength(32)
    const notifications = manager.drainNotifications(threadId)
    expect(notifications).toHaveLength(32)
    expect(
      new Set(
        notifications.map(
          (notification) => notification.match(/<task-id>([^<]+)<\/task-id>/)?.[1]
        )
      ).size
    ).toBe(32)
  })
})
