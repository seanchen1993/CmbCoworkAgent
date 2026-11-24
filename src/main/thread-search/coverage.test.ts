import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { withThreadRunMutationLock } from "../ipc/thread-run-mutation-lock"
import { CHECKPOINT_RUNTIME_PROJECTION_RESUME_REQUIRED } from "../checkpointer/runtime-projection-protocol"
import {
  cancelSearchBackfill,
  registerSearchBackfillBusyCheck,
  scheduleSearchBackfill,
  stopSearchBackfill
} from "./coverage"

const bootstrap = vi.hoisted(() => vi.fn())
const close = vi.hoisted(() => vi.fn())
const backfillState = vi.hoisted(() => vi.fn())
const recordCoverage = vi.hoisted(() => vi.fn())
vi.mock("../checkpointer/runtime-projection-client", () => ({
  CheckpointRuntimeProjectionClient: class {
    bootstrapLegacyTranscript = bootstrap
    close = close
  },
  isCheckpointRuntimeProjectionCancelled: () => false
}))
vi.mock("../storage", () => ({
  getThreadCheckpointPath: (id: string) => id,
  getDbPath: () => "db"
}))
vi.mock("../db", () => ({
  getDb: () => ({
    prepare: () => ({
      bind: () => {},
      step: () => true,
      free: () => {},
      getAsObject: backfillState
    }),
    run: recordCoverage
  })
}))

function queue(threadId: string) {
  scheduleSearchBackfill({
    threadId,
    sourceKey: "source",
    incarnation: { token: null, legacyCreatedAt: 1 }
  })
}

describe("search backfill scheduling", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    bootstrap.mockReset()
    bootstrap.mockResolvedValue({ stats: { totalMessages: 0 } })
    backfillState.mockReset()
    recordCoverage.mockReset()
    backfillState.mockReturnValue({ created_at: 1, status: "idle" })
    close.mockReset()
    close.mockResolvedValue(undefined)
    registerSearchBackfillBusyCheck((id) => id === "busy")
  })

  afterEach(async () => {
    await stopSearchBackfill()
    vi.useRealTimers()
  })

  it("allows an idle conversation to run while a busy conversation waits to retry", async () => {
    queue("busy")
    queue("idle")
    await vi.advanceTimersByTimeAsync(251)
    expect(bootstrap).toHaveBeenCalledTimes(1)
    expect(bootstrap.mock.calls[0][0]).toBe("idle")
  })

  it("keeps queued history when a normal mutation takes the lock", async () => {
    queue("idle")
    await withThreadRunMutationLock("idle", async () => {})
    await vi.advanceTimersByTimeAsync(251)
    expect(bootstrap).toHaveBeenCalledTimes(1)
  })

  it("treats completion as proof for the audited legacy checkpoint source only", async () => {
    backfillState.mockReturnValue({ created_at: 1, status: "idle", migration_status: "complete",
      migration_source_key: "old" })
    queue("changed")
    await vi.advanceTimersByTimeAsync(251)
    expect(bootstrap).toHaveBeenCalledTimes(1)
    backfillState.mockReturnValue({ created_at: 1, status: "idle", migration_status: "complete",
      migration_source_key: "source", migration_search_projection_state: "complete" })
    queue("verified")
    await vi.advanceTimersByTimeAsync(251)
    expect(bootstrap).toHaveBeenCalledTimes(1)
  })

  it("audits projection loss for an older copy and records the worker's partial result", async () => {
    backfillState.mockReturnValue({ created_at: 1, status: "idle", migration_status: "complete",
      migration_source_key: "source", migration_search_projection_state: null })
    bootstrap.mockResolvedValue({ stats: { checkpointId: "source", searchProjectionState: "truncated" } })
    queue("old-copy")
    await vi.advanceTimersByTimeAsync(251)
    expect(bootstrap).toHaveBeenCalledTimes(1)
    expect(recordCoverage.mock.calls[0]?.[1]?.[4]).toBe("projection-truncated")
  })

  it("records an absent root as unavailable while an interrupted copy is recorded", async () => {
    backfillState.mockReturnValue({ created_at: 1, status: "idle", migration_status: "migrating" })
    bootstrap.mockResolvedValue({ stats: { checkpointId: null, totalMessages: 0 } })
    queue("interrupted")
    await vi.advanceTimersByTimeAsync(251)
    expect(recordCoverage.mock.calls[0]?.[1]?.[4]).toBe("failed")
  })

  it("retries an interrupted backfill after a normal mutation releases the lock", async () => {
    const failed = new Error("cancelled")
    bootstrap.mockImplementationOnce((...request) => new Promise((_resolve, reject) => {
      request[5].signal.addEventListener("abort", () => reject(failed), { once: true })
    }))
    queue("idle")
    await vi.advanceTimersByTimeAsync(251)
    await withThreadRunMutationLock("idle", async () => {})
    expect(bootstrap).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(5001)
    expect(bootstrap).toHaveBeenCalledTimes(2)
  })

  it("retains pending coverage while another slice finishes a committed reservation", async () => {
    const pause = new Error("resume committed ordinals")
    pause.name = CHECKPOINT_RUNTIME_PROJECTION_RESUME_REQUIRED
    backfillState.mockReturnValue({ created_at: 1, status: "idle", migration_status: "reserving" })
    bootstrap.mockRejectedValueOnce(pause)
    bootstrap.mockResolvedValueOnce({ stats: { checkpointId: "checkpoint", searchProjectionState: "complete" } })
    queue("wide-history")
    await vi.advanceTimersByTimeAsync(251)
    expect(bootstrap).toHaveBeenCalledTimes(1)
    expect(recordCoverage).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(5001)
    expect(bootstrap).toHaveBeenCalledTimes(2)
    expect(recordCoverage.mock.calls[0]?.[1]?.[4]).toBe("verified")
  })

  it("does not queue behind another conversation's held mutation lock", async () => {
    const { promise, resolve } = Promise.withResolvers<void>()
    const held = withThreadRunMutationLock("held", () => promise)
    try {
      queue("held")
      queue("idle")
      await vi.advanceTimersByTimeAsync(251)
      expect(bootstrap).toHaveBeenCalledTimes(1)
      expect(bootstrap.mock.calls[0][0]).toBe("idle")
    } finally {
      resolve()
      await held
    }
  })

  it("terminates an unresponsive worker before allowing foreground recovery", async () => {
    const work = Promise.withResolvers<never>()
    const terminated = Promise.withResolvers<void>()
    bootstrap.mockReturnValue(work.promise)
    close.mockImplementation(() => {
      work.reject(new Error("worker being terminated"))
      return terminated.promise
    })
    queue("idle")
    await vi.advanceTimersByTimeAsync(251)
    let finished = false
    const preempted = cancelSearchBackfill("idle").then(() => {
      finished = true
    })
    try {
      await vi.advanceTimersByTimeAsync(301)
      expect(close).toHaveBeenCalledTimes(1)
      expect(finished).toBe(false)
    } finally {
      terminated.resolve()
      await preempted
    }
    expect(finished).toBe(true)
  })

  it("deduplicates an in-flight source and lets a foreground opener await cancellation", async () => {
    const { promise, resolve } = Promise.withResolvers<{ stats: { totalMessages: number } }>()
    bootstrap.mockReturnValue(promise)
    queue("idle")
    await vi.advanceTimersByTimeAsync(251)
    expect(bootstrap).toHaveBeenCalledTimes(1)
    queue("idle")
    let released = false
    const preempted = cancelSearchBackfill("idle").then(() => {
      released = true
    })
    try {
      await Promise.resolve()
      expect(bootstrap.mock.calls[0][5].signal.aborted).toBe(true)
      expect(released).toBe(false)
    } finally {
      resolve({ stats: { totalMessages: 0 } })
      await preempted
    }
    await vi.advanceTimersByTimeAsync(500)
    expect(bootstrap).toHaveBeenCalledTimes(1)
  })
})
