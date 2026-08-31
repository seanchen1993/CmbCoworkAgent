import { describe, expect, it } from "vitest"

import {
  enqueueHarnessSidebarProjectLookups,
  HARNESS_SIDEBAR_PROJECT_LOOKUP_BATCH_SIZE,
  takeHarnessSidebarProjectLookupBatch
} from "./harness-sidebar-project-lookup"

describe("Harness sidebar project lookup queue", () => {
  it("drains more than 64 project ids in bounded batches and accepts later loadMore ids", () => {
    const known = new Set<string>()
    const resolved = new Set<string>()
    const pending = new Set<string>()
    const queue = new Set<string>()
    const requested: string[] = []

    const drain = (): void => {
      while (queue.size > 0) {
        const batch = takeHarnessSidebarProjectLookupBatch(queue)
        expect(batch.length).toBeLessThanOrEqual(HARNESS_SIDEBAR_PROJECT_LOOKUP_BATCH_SIZE)
        requested.push(...batch)
        for (const projectId of batch) {
          pending.delete(projectId)
          resolved.add(projectId)
        }
      }
    }

    const firstDirectoryPage = Array.from({ length: 130 }, (_, index) => `project-${index}`)
    enqueueHarnessSidebarProjectLookups(
      firstDirectoryPage,
      known,
      resolved,
      pending,
      queue
    )
    // An effect rerun while the first request is pending must not enqueue duplicates.
    enqueueHarnessSidebarProjectLookups(
      firstDirectoryPage,
      known,
      resolved,
      pending,
      queue
    )
    drain()

    const loadMorePage = Array.from({ length: 70 }, (_, index) => `project-${130 + index}`)
    enqueueHarnessSidebarProjectLookups(loadMorePage, known, resolved, pending, queue)
    drain()

    expect(requested).toHaveLength(200)
    expect(new Set(requested).size).toBe(200)
    expect(resolved).toEqual(new Set([...firstDirectoryPage, ...loadMorePage]))
    expect(pending.size).toBe(0)
    expect(queue.size).toBe(0)
  })
})
