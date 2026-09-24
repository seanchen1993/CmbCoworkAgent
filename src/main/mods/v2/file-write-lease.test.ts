import { randomUUID } from "node:crypto"
import { expect, it } from "vitest"
import { claimLocalThreadRunLease, releaseLocalThreadRunLease } from "../../agent/thread-run-lease"
import {
  functionExecutionScope,
  withFunctionExecution,
  withFunctionWriteLease
} from "./execution-context"

it.each(["release", "handoff", "same-id-reacquire"])(
  "rejects a captured write scope after %s",
  async (action) => {
    const threadId = randomUUID()
    const scope = {
      workspace: "/project",
      threadId,
      turnId: "turn",
      leased: true,
      immediate: false,
      userInitiated: true
    }
    claimLocalThreadRunLease({ threadId, owner: "mods", runId: "original", acquiredAt: "before" })
    try {
      await withFunctionExecution(scope, async () => {
        await expect(
          withFunctionWriteLease(scope.workspace, threadId, async () => {
            if (action === "release") releaseLocalThreadRunLease(threadId, "mods", "original")
            else if (action === "handoff")
              claimLocalThreadRunLease({
                threadId,
                owner: "mods",
                runId: "replacement",
                handoffFromRunId: "original"
              })
            else {
              releaseLocalThreadRunLease(threadId, "mods", "original")
              claimLocalThreadRunLease({
                threadId,
                owner: "mods",
                runId: "original",
                acquiredAt: "before"
              })
            }
            await Promise.resolve()
            functionExecutionScope(scope.workspace, threadId)
          })
        ).rejects.toThrow("MODS_FS_WRITE_LEASE")
        await expect(
          withFunctionExecution(scope, () =>
            withFunctionWriteLease(scope.workspace, threadId, async () => {})
          )
        ).rejects.toThrow("MODS_FS_WRITE_LEASE")
      })
    } finally {
      releaseLocalThreadRunLease(threadId, "mods", "original")
      releaseLocalThreadRunLease(threadId, "mods", "replacement")
    }
  }
)

it("does not treat the logical leased flag as physical write authority", async () => {
  const threadId = randomUUID()
  await withFunctionExecution(
    { workspace: "/project", threadId, leased: true, immediate: false, userInitiated: true },
    async () => {
      await expect(withFunctionWriteLease("/project", threadId, async () => {})).rejects.toThrow(
        "MODS_FS_WRITE_LEASE"
      )
    }
  )
})

it("does not lend a captured lease to a nested different thread or workspace", async () => {
  const threadId = randomUUID()
  const scope = {
    workspace: "/project",
    threadId,
    leased: true,
    immediate: false,
    userInitiated: true
  }
  claimLocalThreadRunLease({ threadId, owner: "mods", runId: "original" })
  try {
    await withFunctionExecution(scope, async () => {
      for (const nested of [
        { ...scope, threadId: randomUUID() },
        { ...scope, workspace: "/other" }
      ])
        await expect(
          withFunctionExecution(nested, () =>
            withFunctionWriteLease(nested.workspace, nested.threadId, async () => {})
          )
        ).rejects.toThrow("MODS_FS_WRITE_LEASE")
    })
  } finally {
    releaseLocalThreadRunLease(threadId, "mods", "original")
  }
})

it("does not refresh a completed user scope from its detached continuation", async () => {
  const threadId = randomUUID()
  const scope = {
    workspace: "/project",
    threadId,
    leased: true,
    immediate: false,
    userInitiated: true
  }
  claimLocalThreadRunLease({ threadId, owner: "mods", runId: "original" })
  let resume!: () => void
  let late!: Promise<void>
  try {
    await withFunctionExecution(scope, async () => {
      late = new Promise<void>((resolve) => {
        resume = resolve
      }).then(() =>
        withFunctionExecution(scope, () =>
          withFunctionWriteLease(scope.workspace, threadId, async () => {})
        )
      )
    })
    const rejected = expect(late).rejects.toThrow("MODS_FS_WRITE_LEASE")
    resume()
    await rejected
  } finally {
    releaseLocalThreadRunLease(threadId, "mods", "original")
  }
})
