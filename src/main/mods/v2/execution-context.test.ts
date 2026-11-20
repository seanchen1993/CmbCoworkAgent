import { randomUUID } from "node:crypto"
import { afterEach, expect, it, vi } from "vitest"
import { ModCommandQueue } from "../command-queue"
import type { ModCommandJob } from "../../../shared/mods/types"
import { claimLocalThreadRunLease, releaseLocalThreadRunLease } from "../../agent/thread-run-lease"
import {
  scheduleFunctionTool,
  withFunctionExecution,
  functionExecutionAgent
} from "./execution-context"

const cleanups: Array<() => void> = []
afterEach(() => cleanups.splice(0).forEach((fn) => fn()))
function fixture() {
  const jobs = new Map<string, ModCommandJob>(),
    threadId = randomUUID()
  const queue = new ModCommandQueue(
    {
      jobs: () => [...jobs.values()],
      saveJob: (job) => {
        jobs.set(job.id, structuredClone(job))
      }
    },
    () => {}
  )
  cleanups.push(() => {
    queue.close()
    releaseLocalThreadRunLease(threadId, "desktop", "model")
  })
  const scope = {
    workspace: "/project",
    threadId,
    leased: false,
    immediate: false,
    userInitiated: true
  }
  const signal = new AbortController().signal
  const call = (tool: string, run = vi.fn(async () => ({ result: "done" })), abort = signal) =>
    scheduleFunctionTool(queue, "/project", threadId, tool, abort, run)
  return { jobs, queue, scope, threadId, call }
}

it("retains the active agent across async callbacks and isolates concurrent scopes", async () => {
  const f = fixture()
  expect(functionExecutionAgent()).toBe("main")
  await Promise.all(
    ["worker-a", "worker-b"].map((agentId) =>
      withFunctionExecution({ ...f.scope, agentId }, async () => {
        await Promise.resolve()
        expect(functionExecutionAgent()).toBe(agentId)
      })
    )
  )
  expect(functionExecutionAgent()).toBe("main")
})

it("queues a pane tool behind the model and cancels it before execution", async () => {
  const f = fixture(),
    controller = new AbortController()
  const run = vi.fn(async () => ({ result: "done" }))
  claimLocalThreadRunLease({ threadId: f.threadId, owner: "desktop", runId: "model" })
  const pending = withFunctionExecution(f.scope, () =>
    f.call("host:write_file", run, controller.signal)
  )
  const rejection = expect(pending).rejects.toThrow()
  await expect.poll(() => [...f.jobs.values()][0]?.state).toBe("queued")
  controller.abort()
  await rejection
  expect(run).not.toHaveBeenCalled()
  expect([...f.jobs.values()][0].state).toBe("cancelled")
})

it("reuses a command lease and rejects writes in immediate or non-user dispatch", async () => {
  const f = fixture(),
    run = vi.fn(async () => ({ result: "done" }))
  await withFunctionExecution({ ...f.scope, leased: true }, () => f.call("host:write_file", run))
  expect(f.jobs.size).toBe(0)
  expect(run).toHaveBeenCalledOnce()
  await expect(
    withFunctionExecution({ ...f.scope, immediate: true }, () => f.call("host:write_file", run))
  ).rejects.toThrow("MODS_WRITE_REQUIRES_USER_ACTION")
  await expect(f.call("host:write_file", run)).rejects.toThrow("MODS_WRITE_REQUIRES_USER_ACTION")
  expect(run).toHaveBeenCalledOnce()
})

it("permits immediate reads with a held model lease but cannot retain authority after scope ends", async () => {
  const f = fixture()
  claimLocalThreadRunLease({ threadId: f.threadId, owner: "desktop", runId: "model" })
  await withFunctionExecution({ ...f.scope, immediate: true }, () => f.call("host:read_file"))
  expect(f.jobs.size).toBe(0)
  let continueLater!: () => void
  let delayed!: Promise<unknown>
  await withFunctionExecution({ ...f.scope, leased: true }, async () => {
    const gate = new Promise<void>((r) => {
      continueLater = r
    })
    delayed = gate.then(() => f.call("host:write_file"))
  })
  const rejection = expect(delayed).rejects.toThrow("MODS_WRITE_REQUIRES_USER_ACTION")
  continueLater()
  await rejection
})
