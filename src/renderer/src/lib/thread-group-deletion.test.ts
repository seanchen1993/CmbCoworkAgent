import { describe, expect, it, vi } from "vitest"

import {
  cleanupDeletedThreadIfResident,
  deleteThreadGroupSequentially,
  hasRunningThreadForDeletion,
  runBestEffortCommittedDeletionCleanups
} from "./thread-group-deletion"

describe("thread group deletion", () => {
  it("attempts every item, reports progress, and retries only failed items", async () => {
    const onProgress = vi.fn()
    const cleanupThread = vi.fn()
    const deleteThread = vi.fn(async (id: string) => {
      if (id !== "b") throw new Error(`blocked: ${id}`)
    })
    const result = await deleteThreadGroupSequentially(["a", "b", "c", "d"], {
      deleteThread,
      cleanupThread,
      markRead: () => undefined,
      onProgress
    })
    expect(deleteThread.mock.calls.flat()).toEqual(["a", "b", "c", "d"])
    expect(result).toMatchObject({
      deletedIds: ["b"],
      remainingIds: ["a", "c", "d"],
      failedId: "a"
    })
    expect(cleanupThread.mock.calls.flat()).toEqual(["b"])
    expect(onProgress).toHaveBeenNthCalledWith(1, {
      completed: 0,
      total: 4,
      deleted: 0,
      skipped: 0
    })
    expect(onProgress).toHaveBeenLastCalledWith({ completed: 4, total: 4, deleted: 1, skipped: 3 })
    deleteThread.mockImplementation(async () => undefined)
    deleteThread.mockClear()
    const retry = await deleteThreadGroupSequentially(result.remainingIds, {
      deleteThread,
      cleanupThread,
      markRead: () => undefined
    })
    expect(deleteThread.mock.calls.flat()).toEqual(["a", "c", "d"])
    expect(retry.remainingIds).toEqual([])
  })

  it("yields to the event loop even when every deletion fails", async () => {
    vi.useFakeTimers()
    try {
      const deleteThread = vi.fn(async () => {
        throw new Error("busy")
      })
      const pending = deleteThreadGroupSequentially(["a", "b", "c"], {
        deleteThread,
        cleanupThread: vi.fn(),
        markRead: vi.fn()
      })
      await Promise.resolve()
      expect(deleteThread).toHaveBeenCalledTimes(1)
      await vi.runAllTimersAsync()
      expect((await pending).remainingIds).toEqual(["a", "b", "c"])
    } finally {
      vi.useRealTimers()
    }
  })

  it("bounds progress updates for a large fast batch and always reports final counts", async () => {
    vi.useFakeTimers()
    try {
      const onProgress = vi.fn()
      const pending = deleteThreadGroupSequentially(
        Array.from({ length: 200 }, (_, index) => `thread-${index}`),
        {
          deleteThread: async () => undefined,
          cleanupThread: vi.fn(),
          markRead: vi.fn(),
          onProgress
        }
      )
      await vi.runAllTimersAsync()
      expect((await pending).deletedIds).toHaveLength(200)
      expect(onProgress.mock.calls.length).toBeLessThan(10)
      expect(onProgress).toHaveBeenLastCalledWith({
        completed: 200,
        total: 200,
        deleted: 200,
        skipped: 0
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it("does not reopen a committed backend deletion when renderer cleanup fails", () => {
    const first = vi.fn(() => {
      throw new Error("localStorage unavailable")
    })
    const second = vi.fn(() => {
      throw new Error("cache cleanup failed")
    })
    const onError = vi.fn()

    expect(() =>
      runBestEffortCommittedDeletionCleanups(
        [
          { label: "queue", run: first },
          { label: "cache", run: second }
        ],
        onError
      )
    ).not.toThrow()
    expect(first).toHaveBeenCalledOnce()
    expect(second).toHaveBeenCalledOnce()
    expect(onError).toHaveBeenCalledTimes(2)
  })

  it("does not run resident cleanup for an unloaded durable group", () => {
    const cleanupThread = vi.fn()
    const threadStates = { loaded: { workflowRunning: false } }
    for (let index = 0; index < 1_000; index += 1) {
      cleanupDeletedThreadIfResident(`unloaded-${index}`, threadStates, cleanupThread)
    }
    cleanupDeletedThreadIfResident("loaded", threadStates, cleanupThread)

    expect(cleanupThread).toHaveBeenCalledOnce()
    expect(cleanupThread).toHaveBeenCalledWith("loaded")
  })

  it("recognizes both lightweight summaries and legacy full thread states", () => {
    expect(
      hasRunningThreadForDeletion(
        ["summary-worker"],
        { "summary-worker": { hasRunningCoordinatorWorker: true } },
        {}
      )
    ).toBe(true)
    expect(
      hasRunningThreadForDeletion(
        ["summary-workflow"],
        { "summary-workflow": { workflowRunning: true } },
        {}
      )
    ).toBe(true)
    expect(
      hasRunningThreadForDeletion(
        ["legacy"],
        {
          legacy: {
            coordinatorWorkers: [{ status: "running" }],
            workflowRun: { status: "running" }
          }
        },
        {}
      )
    ).toBe(true)
  })

  it("recognizes stream and scheduled-task activity while leaving idle groups deletable", () => {
    expect(hasRunningThreadForDeletion(["stream"], {}, { stream: true })).toBe(true)
    expect(
      hasRunningThreadForDeletion(["scheduled"], { scheduled: { scheduledTaskLoading: true } }, {})
    ).toBe(true)
    expect(
      hasRunningThreadForDeletion(
        ["idle"],
        { idle: { hasRunningCoordinatorWorker: false, workflowRunning: false } },
        { idle: false }
      )
    ).toBe(false)
  })

  it("reports completed and remaining ids without cleaning up the failed thread", async () => {
    const deleteThread = vi.fn(async (threadId: string) => {
      if (threadId === "b") throw new Error("busy")
    })
    const cleanupThread = vi.fn()
    const markRead = vi.fn()

    const result = await deleteThreadGroupSequentially(["a", "b", "c"], {
      deleteThread,
      cleanupThread,
      markRead
    })

    expect(result).toMatchObject({
      deletedIds: ["a", "c"],
      remainingIds: ["b"],
      failedId: "b"
    })
    expect(deleteThread.mock.calls.map(([threadId]) => threadId)).toEqual(["a", "b", "c"])
    expect(cleanupThread).toHaveBeenCalledTimes(2)
    expect(cleanupThread).toHaveBeenCalledWith("a")
    expect(markRead).toHaveBeenCalledTimes(2)
  })

  it("deduplicates ids and preserves sequential deletion order", async () => {
    const order: string[] = []
    const result = await deleteThreadGroupSequentially(["a", "a", "b"], {
      deleteThread: async (threadId) => {
        order.push(`delete:${threadId}`)
      },
      cleanupThread: (threadId) => order.push(`cleanup:${threadId}`),
      markRead: (threadId) => order.push(`read:${threadId}`)
    })

    expect(result).toEqual({ deletedIds: ["a", "b"], remainingIds: [] })
    expect(order).toEqual(["delete:a", "cleanup:a", "read:a", "delete:b", "cleanup:b", "read:b"])
  })

  it("keeps committed deletions successful when local cleanup callbacks fail", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const deleteThread = vi.fn<(threadId: string) => Promise<void>>(async () => undefined)
    const cleanupThread = vi.fn((threadId: string) => {
      if (threadId === "a") throw new Error("cleanup failed")
    })
    const markRead = vi.fn((threadId: string) => {
      if (threadId === "b") throw new Error("storage unavailable")
    })

    try {
      const result = await deleteThreadGroupSequentially(["a", "b", "c"], {
        deleteThread,
        cleanupThread,
        markRead
      })

      expect(result).toEqual({ deletedIds: ["a", "b", "c"], remainingIds: [] })
      expect(deleteThread.mock.calls.map(([threadId]) => threadId)).toEqual(["a", "b", "c"])
      expect(cleanupThread.mock.calls.map(([threadId]) => threadId)).toEqual(["a", "b", "c"])
      expect(markRead.mock.calls.map(([threadId]) => threadId)).toEqual(["a", "b", "c"])
      expect(warning).toHaveBeenCalledTimes(2)
    } finally {
      warning.mockRestore()
    }
  })
})
