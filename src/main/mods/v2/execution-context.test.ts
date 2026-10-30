import { randomUUID } from "node:crypto"
import { afterEach, expect, it, vi } from "vitest"
import { ModCommandQueue } from "../command-queue"
import type { ModCommandJob } from "../../../shared/mods/types"
import { claimLocalThreadRunLease, releaseLocalThreadRunLease } from "../../agent/thread-run-lease"
import {
  scheduleFunctionTool,
  withFunctionExecution,
  functionExecutionAgent,
  functionExecutionScope,
  assertFunctionPublicationScope,
  recordFunctionCancellationReceipt,
  withFreshFunctionExecution
} from "./execution-context"
import { scheduleFunctionCommand } from "./command-scheduler"
import { functionCallIdentity, runFunctionHostCall } from "./host-call"
import { ModRuntimeAuthorities } from "../runtime-instance"

const cleanups: Array<() => void> = []

it("limits cancellation receipts to their live publication scope, never a new SDK authority", async () => {
  const f = fixture()
  const registry = new ModRuntimeAuthorities()
  cleanups.push(() => registry.close())
  const instance = registry.create({ ...f.scope, turnId: "cancelled" })
  let resume!: () => void
  let late!: Promise<void>
  await withFunctionExecution({ ...f.scope, runtimeAuthority: instance.authority }, async () => {
    recordFunctionCancellationReceipt()
    instance.release()
    expect(() => assertFunctionPublicationScope(f.scope.workspace, f.threadId)).not.toThrow()
    expect(() => assertFunctionPublicationScope("/other", f.threadId)).toThrow(
      "MODS_CALL_SCOPE_CHANGED"
    )
    expect(() => assertFunctionPublicationScope(f.scope.workspace, "other")).toThrow(
      "MODS_CALL_SCOPE_CHANGED"
    )
    expect(() => functionExecutionScope(f.scope.workspace, f.threadId)).toThrow(
      "MODS_RUNTIME_INSTANCE_EXPIRED"
    )
    await expect(
      withFreshFunctionExecution({ ...f.scope, runtimeAuthority: instance.authority }, async () =>
        assertFunctionPublicationScope(f.scope.workspace, f.threadId)
      )
    ).rejects.toThrow("MODS_RUNTIME_INSTANCE_EXPIRED")
    late = new Promise<void>((resolve) => {
      resume = resolve
    }).then(() => {
      expect(() => assertFunctionPublicationScope(f.scope.workspace, f.threadId)).toThrow(
        "MODS_CALL_SCOPE_EXPIRED"
      )
    })
  })
  resume()
  await late
})
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
    delayed = gate.then(() => {
      expect(() => functionExecutionAgent()).toThrow("MODS_CALL_SCOPE_EXPIRED")
      return f.call("host:write_file")
    })
  })
  const rejection = expect(delayed).rejects.toThrow("MODS_CALL_SCOPE_EXPIRED")
  continueLater()
  await rejection
})

it.each(["tool", "command"])(
  "preserves agent and turn when a queued %s starts in another async context",
  async (kind) => {
    const f = fixture()
    const grant = {
      workspace: f.scope.workspace,
      modId: "function:probe",
      digest: "snapshot",
      epoch: 1,
      enabled: true
    }
    claimLocalThreadRunLease({ threadId: f.threadId, owner: "desktop", runId: "model" })
    const run = vi.fn(async () => {
      expect(functionExecutionScope(f.scope.workspace, f.threadId)?.runtimeAuthority).toBe(
        instance.authority
      )
      expect(functionExecutionScope(f.scope.workspace, f.threadId)).toMatchObject({
        agentId: "worker",
        turnId: "worker-turn",
        userInitiated: false,
        leased: true
      })
      expect(
        functionCallIdentity(f.scope.workspace, f.threadId, grant, {
          origin: "mod",
          fallbackTurnId: "fallback"
        }).parentCallId
      ).toBe("actual-parent")
      return { result: "done" }
    })
    const scope = { ...f.scope, agentId: "worker", turnId: "worker-turn", userInitiated: false }
    const instance = new ModRuntimeAuthorities().create(scope)
    cleanups.push(instance.release)
    const pending = withFunctionExecution({ ...scope, runtimeAuthority: instance.authority }, () =>
      runFunctionHostCall({
        store: { settle: () => {}, blockPublication: () => {} },
        identity: {
          ...functionCallIdentity(f.scope.workspace, f.threadId, grant, {
            origin: "mod",
            fallbackTurnId: "fallback"
          }),
          callId: "actual-parent"
        },
        assertLive: () => {},
        admit: async () => {},
        claim: () => {},
        status: () => "succeeded",
        publish: async (value) => value,
        invoke: () =>
          kind === "tool"
            ? f.call("host:read_file", run)
            : scheduleFunctionCommand(
                f.queue,
                f.scope.workspace,
                f.threadId,
                { name: "probe", description: "Probe", plugin: "probe" },
                new AbortController().signal,
                run
              )
      })
    )
    await expect.poll(() => [...f.jobs.values()][0]?.state).toBe("queued")
    releaseLocalThreadRunLease(f.threadId, "desktop", "model")
    await pending
    expect(run).toHaveBeenCalledOnce()
  }
)

it("does not renew an abandoned caller's write authority when its queued job finally starts", async () => {
  const f = fixture()
  claimLocalThreadRunLease({ threadId: f.threadId, owner: "desktop", runId: "model" })
  const run = vi.fn(async () => ({ result: "done" }))
  let pending!: Promise<unknown>
  await withFunctionExecution(f.scope, async () => {
    pending = f.call("host:write_file", run)
  })
  const rejected = expect(pending).rejects.toThrow("MODS_CALL_SCOPE_EXPIRED")
  releaseLocalThreadRunLease(f.threadId, "desktop", "model")
  await rejected
  expect(run).not.toHaveBeenCalled()
})

it("rejects queued SDK work if its runtime is replaced before the lease becomes available", async () => {
  const f = fixture(),
    registry = new ModRuntimeAuthorities()
  const scope = { ...f.scope, turnId: "turn" }
  const instance = registry.create(scope)
  cleanups.push(() => registry.close())
  claimLocalThreadRunLease({ threadId: f.threadId, owner: "desktop", runId: "model" })
  const run = vi.fn(async () => ({ result: "must not run" }))
  const pending = withFunctionExecution({ ...scope, runtimeAuthority: instance.authority }, () =>
    f.call("host:read_file", run)
  )
  const rejected = expect(pending).rejects.toThrow("MODS_RUNTIME_INSTANCE_EXPIRED")
  await expect.poll(() => [...f.jobs.values()][0]?.state).toBe("queued")
  registry.create(scope)
  releaseLocalThreadRunLease(f.threadId, "desktop", "model")
  await rejected
  expect(run).not.toHaveBeenCalled()
})
