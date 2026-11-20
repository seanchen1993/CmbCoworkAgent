import { EventEmitter } from "node:events"
import type { ChildProcess } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process")
  return { ...actual, spawn: spawnMock }
})

import { LocalSandbox } from "./local-sandbox"
import { claimLocalThreadRunLease, releaseLocalThreadRunLease } from "./thread-run-lease"

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

interface ExecuteRawTestOptions {
  background?: boolean
  cwd?: string
  waitForProcessTree?: boolean
  onTermination?: (termination: Promise<void>) => void
  onData?: (text: string) => void
}

interface BackgroundTaskForTest {
  completion?: Promise<void>
  termination?: Promise<void>
}

interface PendingBackgroundStartForTest {
  abortController: AbortController
  settled: Promise<void>
}

interface LocalSandboxLifecycleForTest {
  applicationShutdownStarted: boolean
  pendingBackgroundTaskStarts: Set<PendingBackgroundStartForTest>
  activeProcesses: Set<ChildProcess>
  activeProcessTerminations: WeakMap<
    ChildProcess,
    { promise: Promise<void>; waitForProcessTree: boolean }
  >
}

interface FakeChildProcess extends EventEmitter {
  kill: ReturnType<typeof vi.fn>
}

function createFakeChildProcess(): FakeChildProcess {
  const process = new EventEmitter() as FakeChildProcess
  process.kill = vi.fn(() => true)
  return process
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve
  })
  return { promise, resolve }
}

function getBackgroundTasks(): Map<string, BackgroundTaskForTest> {
  return (
    LocalSandbox as unknown as {
      backgroundTasks: Map<string, BackgroundTaskForTest>
    }
  ).backgroundTasks
}

function getLifecycleState(): LocalSandboxLifecycleForTest {
  return LocalSandbox as unknown as LocalSandboxLifecycleForTest
}

afterEach(() => {
  const lifecycle = getLifecycleState()
  lifecycle.applicationShutdownStarted = false
  lifecycle.pendingBackgroundTaskStarts.clear()
  lifecycle.activeProcesses.clear()
})

describe("LocalSandbox background-task settlement", () => {
  it("keeps a cancelled task active until execution and physical termination both settle", async () => {
    const threadId = `background-settlement-${Date.now()}-${Math.random()}`
    const physicalRunToken = `${threadId}:physical-run`
    const execution = createDeferred<{
      output: string
      exitCode: number | null
      truncated: boolean
    }>()
    const termination = createDeferred<void>()
    const sandbox = new LocalSandbox({
      rootDir: process.cwd(),
      runId: threadId,
      aclOwnerId: physicalRunToken,
      windowsSandbox: "none"
    })
    const executeRaw = vi.fn(
      async (
        _command: string,
        _sandboxModeOverride?: string,
        _timeoutMs?: number,
        overrideAbortSignal?: AbortSignal,
        options?: ExecuteRawTestOptions
      ) => {
        overrideAbortSignal?.addEventListener(
          "abort",
          () => options?.onTermination?.(termination.promise),
          { once: true }
        )
        return execution.promise
      }
    )
    Reflect.set(sandbox, "executeRaw", executeRaw)

    let taskId: string | undefined
    try {
      const started = await sandbox.executeBackground("echo background-settlement-test")
      taskId = started.match(/id:\s*([a-f0-9]+)/i)?.[1]
      expect(taskId).toBeTruthy()
      expect(sandbox.runId).toBe(threadId)
      expect(sandbox.aclOwnerId).toBe(physicalRunToken)
      expect(executeRaw.mock.calls[0]?.[4]).toMatchObject({
        background: true,
        waitForProcessTree: true
      })
      expect(LocalSandbox.hasActiveBackgroundTasks(threadId)).toBe(true)

      LocalSandbox.cancelBackgroundTasks(threadId)

      const visibleResult = sandbox.getTaskOutput(taskId!)
      expect(visibleResult).toMatchObject({ completed: true, exitCode: 130 })
      expect(LocalSandbox.hasActiveBackgroundTasks(threadId)).toBe(true)

      const task = getBackgroundTasks().get(taskId!)
      expect(task?.completion).toBeInstanceOf(Promise)
      expect(task?.termination).toBe(termination.promise)

      let waitResolved = false
      const deletionFence = LocalSandbox.cancelBackgroundTasksAndWait(threadId).then(() => {
        waitResolved = true
      })

      execution.resolve({ output: "cancelled", exitCode: 130, truncated: false })
      await Promise.resolve()
      await Promise.resolve()
      expect(waitResolved).toBe(false)
      expect(LocalSandbox.hasActiveBackgroundTasks(threadId)).toBe(true)

      termination.resolve()
      await deletionFence
      expect(LocalSandbox.hasActiveBackgroundTasks(threadId)).toBe(false)
      expect(sandbox.getTaskOutput(taskId!)).toMatchObject({ completed: true, exitCode: 130 })
    } finally {
      if (taskId) getBackgroundTasks().delete(taskId)
      execution.resolve({ output: "cancelled", exitCode: 130, truncated: false })
      termination.resolve()
    }
  })

  it.skipIf(process.platform !== "win32")(
    "retains the physical run ACL until its handed-off process tree settles",
    async () => {
      const threadId = "handoff-acl-thread"
      const aclOwnerId = "handoff-acl-physical-run"
      const aclState = LocalSandbox as unknown as {
        _runAclDirs: Map<string, Set<string>>
        revokeSandboxWriteAcl: (dir: string, path: string) => Promise<void>
      }
      const execution = createDeferred<{ output: string; exitCode: number; truncated: boolean }>()
      const termination = createDeferred<void>()
      const sandbox = new LocalSandbox({
        rootDir: process.cwd(),
        runId: threadId,
        aclOwnerId,
        windowsSandbox: "none"
      })
      const revoke = vi.spyOn(aclState, "revokeSandboxWriteAcl").mockResolvedValue(undefined)
      aclState._runAclDirs.set(aclOwnerId, new Set(["test-owned-dir"]))
      aclState._runAclDirs.set("different-run", new Set(["other-dir"]))
      const raw = vi
        .spyOn(sandbox, "executeRaw")
        .mockImplementation(async (_command, _mode, _timeout, signal, options) => {
          options?.handoff?.onSpawn()
          signal?.addEventListener("abort", () => options?.onTermination?.(termination.promise), {
            once: true
          })
          return execution.promise
        })

      try {
        const handedOff = await sandbox.executeForTool("node --version", undefined, {
          backgroundAfterMs: 10
        })
        if (handedOff.status !== "background") throw new Error("expected shell handoff")
        const release = LocalSandbox.revokeGrantedAclsForRun(aclOwnerId)
        await LocalSandbox.revokeGrantedAclsForRun("different-run")
        expect(revoke).toHaveBeenCalledExactlyOnceWith("other-dir", "other-dir")

        LocalSandbox.cancelBackgroundTasks(threadId)
        execution.resolve({ output: "cancelled", exitCode: 130, truncated: false })
        await vi.waitFor(() => expect(sandbox.getTaskOutput(handedOff.taskId)?.exitCode).toBe(130))
        expect(revoke).toHaveBeenCalledTimes(1)

        termination.resolve()
        await release
        expect(revoke).toHaveBeenLastCalledWith("test-owned-dir", "test-owned-dir")
        expect(LocalSandbox.hasActiveBackgroundTasks(threadId)).toBe(false)
      } finally {
        execution.resolve({ output: "cancelled", exitCode: 130, truncated: false })
        termination.resolve()
        await LocalSandbox.cancelBackgroundTasksAndWait(threadId)
        raw.mockRestore()
        revoke.mockRestore()
        aclState._runAclDirs.delete(aclOwnerId)
        aclState._runAclDirs.delete("different-run")
      }
    }
  )

  it("cancels only the scoped owner's pending shell before registration", async () => {
    const sandbox = new LocalSandbox({
      rootDir: process.cwd(),
      runId: "pending-shell-owner",
      windowsSandbox: "none"
    })
    const hook = createDeferred<null>()
    const signals = new Map<string, AbortSignal>()
    vi.spyOn(sandbox, "runPreToolUseHookForTool").mockImplementation((_tool, args, signal) => {
      signals.set(String(args.command), signal!)
      return hook.promise
    })
    const raw = vi.spyOn(sandbox, "executeRaw").mockResolvedValue({
      output: "finished",
      exitCode: 0,
      truncated: false
    })

    const own = sandbox.executeBackground("echo own", undefined, "owner-a")
    const other = sandbox.executeBackground("echo other", undefined, "owner-b")
    const cancelled = LocalSandbox.cancelOwnedBackgroundTasksAndWait(sandbox.runId, "owner-a")
    expect(signals.get("echo own")?.aborted).toBe(true)
    expect(signals.get("echo other")?.aborted).toBe(false)
    hook.resolve(null)

    await cancelled
    await expect(own).resolves.toContain("cancelled before it started")
    await expect(other).resolves.toContain("Background task started")
    await vi.waitFor(() => expect(LocalSandbox.hasActiveBackgroundTasks(sandbox.runId)).toBe(false))
    expect(raw).toHaveBeenCalledTimes(1)
    expect(raw.mock.calls[0][0]).toBe("echo other")
  })

  it("keeps the foreground pending invocation alive when stopping detached shell", async () => {
    const sandbox = new LocalSandbox({
      rootDir: process.cwd(),
      runId: "detached-shell-stop",
      windowsSandbox: "none"
    })
    const hooks = createDeferred<null>()
    const signals = new Map<string, AbortSignal>()
    Reflect.set(
      sandbox,
      "runPreToolUseHook",
      (_name: string, args: { command: string }, signal: AbortSignal) => {
        signals.set(args.command, signal)
        return hooks.promise
      }
    )
    const raw = vi.spyOn(sandbox, "executeRaw").mockResolvedValue({
      output: "foreground",
      exitCode: 0,
      truncated: false
    })

    const foreground = sandbox.executeForTool("echo foreground", undefined, {
      backgroundAfterMs: 60_000
    })
    expect(LocalSandbox.hasActiveBackgroundTasks(sandbox.runId)).toBe(false)
    const background = sandbox.executeBackground("echo background")
    expect(LocalSandbox.cancelDetachedBackgroundTasks(sandbox.runId)).toBe(true)
    expect(signals.get("echo background")?.aborted).toBe(true)
    expect(signals.get("echo foreground")?.aborted).toBe(false)
    hooks.resolve(null)

    await expect(background).resolves.toContain("cancelled before it started")
    await expect(foreground).resolves.toMatchObject({
      status: "completed",
      result: { exitCode: 0 }
    })
    expect(raw).toHaveBeenCalledTimes(1)
    expect(raw.mock.calls[0][0]).toBe("echo foreground")
  })

  it.each(["dedicated", "foreground"] as const)("scopes %s Stop to desktop shells", async (stop) => {
    const threadId = "shared-shell-stop-ownership"
    const sandbox = new LocalSandbox({
      rootDir: process.cwd(),
      runId: threadId,
      windowsSandbox: "none"
    })
    const externalHook = createDeferred<null>()
    const desktopExecution = createDeferred<{ output: string; exitCode: number; truncated: boolean }>()
    const externalExecution = createDeferred<{ output: string; exitCode: number; truncated: boolean }>()
    let externalSignal: AbortSignal | undefined
    vi.spyOn(sandbox, "runPreToolUseHookForTool").mockImplementation(async (_tool, args, signal) => {
      if (args.command !== "echo external") return null
      externalSignal = signal
      return externalHook.promise
    })
    const raw = vi.spyOn(sandbox, "executeRaw").mockImplementation((command) =>
      command === "echo external" ? externalExecution.promise : desktopExecution.promise
    )
    const changes = vi.fn()
    const unsubscribe = LocalSandbox.onBackgroundShellChange(changes)
    const desktopOnly = { threadRunOwner: "desktop" } as const

    try {
      expect(
        claimLocalThreadRunLease({ threadId, owner: "desktop", runId: "one" }).acquired
      ).toBe(true)
      const desktopStarted = await sandbox.executeBackground("echo desktop")
      const desktopTask = desktopStarted.match(/id:\s*([a-f0-9]+)/i)?.[1]
      expect(desktopTask).toBeTruthy()
      await vi.waitFor(() => expect(raw).toHaveBeenCalledOnce())
      releaseLocalThreadRunLease(threadId, "desktop", "one")
      expect(claimLocalThreadRunLease({ threadId, owner: "im", runId: "two" }).acquired).toBe(true)

      const externalPending = sandbox.executeBackground("echo external")
      await vi.waitFor(() => expect(externalSignal).toBeDefined())
      if (stop === "dedicated") {
        expect(LocalSandbox.cancelDetachedBackgroundTasks(threadId)).toBe(true)
      } else {
        LocalSandbox.cancelBackgroundTasks(threadId, desktopOnly)
      }
      expect(sandbox.getTaskOutput(desktopTask!)).toMatchObject({ exitCode: 130 })
      expect(externalSignal?.aborted).toBe(false)

      // The source must survive even if the lease changes during a pending approval.
      releaseLocalThreadRunLease(threadId, "im", "two")
      externalHook.resolve(null)
      const externalStarted = await externalPending
      const externalTask = externalStarted.match(/id:\s*([a-f0-9]+)/i)?.[1]
      expect(externalTask).toBeTruthy()
      expect(
        claimLocalThreadRunLease({ threadId, owner: "desktop", runId: "one" }).acquired
      ).toBe(true)
      desktopExecution.resolve({ output: "finished", exitCode: 0, truncated: false })
      await vi.waitFor(() =>
        expect(LocalSandbox.hasActiveBackgroundTasks(threadId, desktopOnly)).toBe(false)
      )
      expect(LocalSandbox.hasActiveBackgroundTasks(threadId)).toBe(true)
      expect(LocalSandbox.cancelDetachedBackgroundTasks(threadId)).toBe(false)
      LocalSandbox.cancelBackgroundTasks(threadId, desktopOnly)
      expect(externalSignal?.aborted).toBe(false)
      expect(sandbox.getTaskOutput(externalTask!)).toMatchObject({ completed: false })
      externalExecution.resolve({ output: "finished", exitCode: 0, truncated: false })
      await expect(sandbox.waitForTaskOutput(externalTask!)).resolves.toMatchObject({
        status: "completed",
        result: { exitCode: 0 }
      })
      expect(changes.mock.calls).toEqual([
        [{ threadId, active: true }],
        [{ threadId, active: false }]
      ])
    } finally {
      releaseLocalThreadRunLease(threadId, "desktop", "one")
      releaseLocalThreadRunLease(threadId, "im", "two")
      unsubscribe()
      externalHook.resolve(null)
      desktopExecution.resolve({ output: "finished", exitCode: 0, truncated: false })
      externalExecution.resolve({ output: "finished", exitCode: 0, truncated: false })
      await LocalSandbox.cancelBackgroundTasksAndWait(threadId)
    }
  })

  it("aborts before registration and disconnects the caller signal once registered", async () => {
    const sandbox = new LocalSandbox({
      rootDir: process.cwd(),
      runId: "background-caller-signal",
      windowsSandbox: "none"
    })
    const caller = new AbortController()
    const hook = createDeferred<null>()
    vi.spyOn(sandbox, "runPreToolUseHookForTool").mockReturnValueOnce(hook.promise)
    const execution = createDeferred<{ output: string; exitCode: number; truncated: boolean }>()
    const raw = vi.spyOn(sandbox, "executeRaw").mockReturnValue(execution.promise)
    const changes = vi.fn()
    const unsubscribe = LocalSandbox.onBackgroundShellChange(changes)

    try {
      const pending = sandbox.executeBackground("echo before", undefined, undefined, caller.signal)
      caller.abort()
      hook.resolve(null)
      await expect(pending).resolves.toContain("cancelled before it started")
      expect(raw).not.toHaveBeenCalled()
      expect(changes.mock.calls).toEqual([
        [{ threadId: sandbox.runId, active: true }],
        [{ threadId: sandbox.runId, active: false }]
      ])

      changes.mockClear()
      const owner = new AbortController()
      await expect(
        sandbox.executeBackground("echo after", undefined, undefined, owner.signal)
      ).resolves.toContain("Background task started")
      const [, , , processSignal, options] = raw.mock.calls[0]
      owner.abort()
      expect(processSignal?.aborted).toBe(false)
      options?.onData?.("first")
      options?.onData?.("second")
      expect(changes.mock.calls).toEqual([[{ threadId: sandbox.runId, active: true }]])

      execution.resolve({ output: "finished", exitCode: 0, truncated: false })
      await vi.waitFor(() => expect(changes).toHaveBeenCalledTimes(2))
      expect(changes).toHaveBeenLastCalledWith({ threadId: sandbox.runId, active: false })
    } finally {
      unsubscribe()
      execution.resolve({ output: "finished", exitCode: 0, truncated: false })
      await LocalSandbox.cancelBackgroundTasksAndWait(sandbox.runId)
    }
  })

  it("bounds idle thread cleanup and blocks late starts during deletion", async () => {
    const sandbox = new LocalSandbox({
      rootDir: process.cwd(),
      runId: "idle-shell-delete",
      windowsSandbox: "none"
    })
    const hook = createDeferred<null>()
    vi.spyOn(sandbox, "runPreToolUseHookForTool").mockReturnValueOnce(hook.promise)
    const raw = vi.spyOn(sandbox, "executeRaw").mockResolvedValue({
      output: "finished",
      exitCode: 0,
      truncated: false
    })
    const pending = sandbox.executeBackground("echo pending")
    const release = LocalSandbox.blockNewBackgroundTasks(sandbox.runId)

    try {
      await expect(LocalSandbox.cancelBackgroundTasksWithin(sandbox.runId, 10)).resolves.toBe(false)
      await expect(sandbox.executeBackground("echo late")).resolves.toContain("cancelled before")
      expect(LocalSandbox.hasActiveBackgroundTasks(sandbox.runId)).toBe(true)
      hook.resolve(null)
      await expect(pending).resolves.toContain("cancelled before")
      await expect(LocalSandbox.cancelBackgroundTasksWithin(sandbox.runId, 10)).resolves.toBe(true)
      expect(raw).not.toHaveBeenCalled()
    } finally {
      release()
      hook.resolve(null)
    }
    await expect(sandbox.executeBackground("echo retry")).resolves.toContain(
      "Background task started"
    )
    await vi.waitFor(() => expect(LocalSandbox.hasActiveBackgroundTasks(sandbox.runId)).toBe(false))
    expect(raw).toHaveBeenCalledTimes(1)
  })

  it("fences pending and registered child shells by their recorded parent during deletion", async () => {
    const parent = "shell-deletion-parent"
    const scope = { includeChildRuns: true }
    const pendingChild = new LocalSandbox({
      rootDir: process.cwd(),
      runId: "pending-child",
      shellParentThreadId: parent,
      windowsSandbox: "none"
    })
    const registeredChild = new LocalSandbox({
      rootDir: process.cwd(),
      runId: "registered-child",
      shellParentThreadId: parent,
      windowsSandbox: "none"
    })
    const unrelated = new LocalSandbox({
      rootDir: process.cwd(),
      runId: `${parent}__worker__unrelated`,
      shellParentThreadId: "another-parent",
      windowsSandbox: "none"
    })
    const hook = createDeferred<null>()
    const physicalExit = createDeferred<void>()
    const unrelatedExit = createDeferred<{ output: string; exitCode: number; truncated: boolean }>()
    vi.spyOn(pendingChild, "runPreToolUseHookForTool").mockReturnValueOnce(hook.promise)
    const pendingRaw = vi.spyOn(pendingChild, "executeRaw")
    const unrelatedRaw = vi.spyOn(unrelated, "executeRaw").mockReturnValue(unrelatedExit.promise)
    const onAbort = vi.fn()
    vi.spyOn(registeredChild, "executeRaw").mockImplementation(
      (_command, _mode, _timeout, signal, options) =>
        new Promise((resolve) => {
          options?.handoff?.onSpawn()
          signal?.addEventListener("abort", () => {
            onAbort()
            options?.onTermination?.(physicalExit.promise)
            resolve({ output: "aborted", exitCode: 130, truncated: false })
          })
        })
    )

    const pending = pendingChild.executeBackground("echo pending")
    let unblock: (() => void) | undefined
    try {
      expect(LocalSandbox.hasActiveBackgroundTasks(parent, scope)).toBe(true)
      const handedOff = await registeredChild.executeForTool("echo promoted", undefined, {
        backgroundAfterMs: 1
      })
      if (handedOff.status !== "background") throw new Error("Expected a shell handoff")

      expect(LocalSandbox.hasActiveBackgroundTasks(parent)).toBe(false)
      expect(LocalSandbox.hasActiveBackgroundTasks(parent, scope)).toBe(true)
      expect(LocalSandbox.cancelDetachedBackgroundTasks(parent)).toBe(false)
      LocalSandbox.cancelBackgroundTasks(parent)
      expect(onAbort).not.toHaveBeenCalled()

      unblock = LocalSandbox.blockNewBackgroundTasks(parent)
      await expect(unrelated.executeBackground("echo unrelated")).resolves.toContain(
        "Background task started"
      )
      expect(unrelatedRaw).toHaveBeenCalledOnce()
      await expect(LocalSandbox.cancelBackgroundTasksWithin(parent, 10, scope)).resolves.toBe(false)
      expect(onAbort).toHaveBeenCalledOnce()
      expect(unrelatedRaw.mock.calls[0][3]?.aborted).toBe(false)
      expect(registeredChild.getTaskOutput(handedOff.taskId)?.exitCode).toBe(130)
      await expect(pendingChild.executeBackground("echo late")).resolves.toContain("cancelled before")
      await expect(registeredChild.executeForTool("echo late", undefined, {})).resolves.toMatchObject({
        status: "completed",
        result: { exitCode: 130 }
      })
      hook.resolve(null)
      await expect(pending).resolves.toContain("cancelled before")
      expect(pendingRaw).not.toHaveBeenCalled()
      expect(LocalSandbox.hasActiveBackgroundTasks(parent, scope)).toBe(true)
      await expect(LocalSandbox.cancelBackgroundTasksWithin(parent, 10, scope)).resolves.toBe(false)

      physicalExit.resolve()
      await expect(LocalSandbox.cancelBackgroundTasksWithin(parent, 100, scope)).resolves.toBe(true)
      expect(LocalSandbox.hasActiveBackgroundTasks(parent, scope)).toBe(false)
    } finally {
      unblock?.()
      hook.resolve(null)
      physicalExit.resolve()
      unrelatedExit.resolve({ output: "unrelated", exitCode: 0, truncated: false })
      await LocalSandbox.cancelBackgroundTasksWithin(parent, 100, scope)
      await LocalSandbox.cancelBackgroundTasksAndWait(unrelated.runId)
    }
  })

  it.each([
    { promoted: true, isolated: false },
    { promoted: false, isolated: false },
    { promoted: true, isolated: true },
    { promoted: false, isolated: true }
  ])(
    "settles POSIX descendants on successful close after promotion (promoted=$promoted, isolated=$isolated)",
    async ({ promoted, isolated }) => {
      const root = process.cwd()
      const sandbox = new LocalSandbox({
        rootDir: root,
        runId: "posix-worktree-close",
        windowsSandbox: "none",
        ...(isolated && {
          worktreeIsolation: {
            workspaceRoot: root,
            worktreeRoot: root,
            commonDir: join(root, ".git"),
            branch: "test"
          }
        })
      })
      const child = Object.assign(createFakeChildProcess(), {
        pid: 41,
        stdout: new EventEmitter(),
        stderr: new EventEmitter()
      })
      spawnMock.mockReturnValueOnce(child)
      const termination = createDeferred<void>()
      const lifecycle = LocalSandbox as unknown as {
        terminateProcessTree: (
          child: ChildProcess,
          exited: () => boolean,
          waitForProcessTree: boolean
        ) => Promise<void>
      }
      const kill = vi.spyOn(lifecycle, "terminateProcessTree").mockReturnValue(termination.promise)
      const execution = (
        sandbox as unknown as {
          executeOnce: (
            command: string,
            shell: string,
            windows: boolean,
            timeout: number,
            signal: undefined,
            cwd: string,
            options: {
              handoff: { onSpawn: () => undefined; isPromoted: () => boolean }
              waitForProcessTree: boolean
            }
          ) => Promise<{ exitCode: number }>
        }
      ).executeOnce("echo example", "/bin/bash", false, 1_000, undefined, root, {
        handoff: { onSpawn: () => undefined, isPromoted: () => promoted },
        waitForProcessTree: true
      })

      try {
        child.emit("spawn")
        child.emit("close", 0, null)
        if (promoted) {
          expect(kill).toHaveBeenCalledExactlyOnceWith(child, expect.any(Function), true)
          const completed = vi.fn()
          void execution.then(completed)
          await Promise.resolve()
          expect(completed).not.toHaveBeenCalled()
        } else {
          expect(kill).not.toHaveBeenCalled()
          await expect(execution).resolves.toMatchObject({ exitCode: 0 })
        }
        termination.resolve()
        await expect(execution).resolves.toMatchObject({ exitCode: 0 })
      } finally {
        termination.resolve()
        kill.mockRestore()
      }
    }
  )

  it("tracks and cancels a background execute before it can reach process spawn", async () => {
    const preToolUse = createDeferred<undefined>()
    const sandbox = new LocalSandbox({
      rootDir: process.cwd(),
      runId: `background-pre-spawn-${Date.now()}-${Math.random()}`,
      windowsSandbox: "none"
    })
    const executeRaw = vi.fn()
    Reflect.set(
      sandbox,
      "runPreToolUseHookForTool",
      vi.fn(() => preToolUse.promise)
    )
    Reflect.set(sandbox, "executeRaw", executeRaw)

    const started = sandbox.executeBackground("echo must-not-spawn")
    expect(LocalSandbox.hasActiveProcesses()).toBe(false)
    expect(LocalSandbox.hasActiveExecutionTasks()).toBe(true)

    const shutdown = LocalSandbox.cancelAllBackgroundTasksAndWait(1_000)
    preToolUse.resolve(undefined)

    await expect(started).resolves.toContain("application is shutting down")
    await expect(shutdown).resolves.toBe(true)
    expect(executeRaw).not.toHaveBeenCalled()
    expect(LocalSandbox.hasActiveExecutionTasks()).toBe(false)
  })

  it("bounds shutdown when a pre-spawn hook does not settle", async () => {
    const preToolUse = createDeferred<undefined>()
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const sandbox = new LocalSandbox({
      rootDir: process.cwd(),
      runId: `background-pre-spawn-timeout-${Date.now()}-${Math.random()}`,
      windowsSandbox: "none"
    })
    Reflect.set(
      sandbox,
      "runPreToolUseHookForTool",
      vi.fn(() => preToolUse.promise)
    )
    Reflect.set(sandbox, "executeRaw", vi.fn())

    const started = sandbox.executeBackground("echo delayed-hook")
    await expect(LocalSandbox.cancelAllBackgroundTasksAndWait(20)).resolves.toBe(false)
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining("Timed out waiting for 1 pending start(s)")
    )

    preToolUse.resolve(undefined)
    await expect(started).resolves.toContain("application is shutting down")
    warning.mockRestore()
  })

  it("waits for a tracked physical process-tree termination promise", async () => {
    const termination = createDeferred<void>()
    const lifecycle = getLifecycleState()
    const process = createFakeChildProcess() as unknown as ChildProcess
    lifecycle.activeProcesses.add(process)
    lifecycle.activeProcessTerminations.set(process, {
      promise: termination.promise,
      waitForProcessTree: true
    })

    let settled = false
    const shutdown = LocalSandbox.killAllAndWait(1_000).then((value) => {
      settled = true
      return value
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    termination.resolve()
    await expect(shutdown).resolves.toBe(true)
  })

  it("serializes a predecessor revoke before a successor grant for the same directory", async () => {
    const aclClass = LocalSandbox as unknown as {
      queueAclOsOperation: (key: string, operation: () => Promise<void>) => Promise<void>
      _aclOsOperationTails: Map<string, Promise<void>>
    }
    const key = `acl-serialization-${Date.now()}-${Math.random()}`
    const predecessorRevoke = createDeferred<void>()
    const events: string[] = []

    const revoke = aclClass.queueAclOsOperation(key, async () => {
      events.push("revoke-start")
      await predecessorRevoke.promise
      events.push("revoke-finish")
    })
    await Promise.resolve()

    const grant = aclClass.queueAclOsOperation(key, async () => {
      events.push("grant")
    })
    await Promise.resolve()
    expect(events).toEqual(["revoke-start"])

    predecessorRevoke.resolve()
    await Promise.all([revoke, grant])
    await Promise.resolve()
    expect(events).toEqual(["revoke-start", "revoke-finish", "grant"])
    expect(aclClass._aclOsOperationTails.has(key)).toBe(false)
  })

  it("waits for the first owner's delayed OS grant before releasing a second owner", async () => {
    const aclClass = LocalSandbox as unknown as {
      grantSandboxWriteAcl: (dir: string, runId: string) => Promise<void>
      _grantedAclRefCount: Map<string, number>
      _runAclDirs: Map<string, Set<string>>
      _aclOsOperationTails: Map<string, Promise<void>>
    }
    const dir = mkdtempSync(join(tmpdir(), "acl-delayed-revoke-"))
    const firstRun = `acl-first-grant-${Date.now()}-${Math.random()}`
    const secondRun = `acl-second-grant-${Date.now()}-${Math.random()}`
    const spawned: Array<{ args: string[]; process: FakeChildProcess }> = []
    spawnMock.mockImplementation((_command: string, args: string[]) => {
      const process = createFakeChildProcess()
      spawned.push({ args, process })
      return process
    })

    let aclKey: string | undefined
    try {
      const firstGrant = aclClass.grantSandboxWriteAcl(dir, firstRun)
      await vi.waitFor(() => expect(spawned).toHaveLength(1))
      expect(spawned[0].args).toContain("/grant")

      let secondGrantSettled = false
      const secondGrant = aclClass.grantSandboxWriteAcl(dir, secondRun).then(() => {
        secondGrantSettled = true
      })
      await Promise.resolve()
      await Promise.resolve()
      expect(spawned).toHaveLength(1)
      expect(secondGrantSettled).toBe(false)

      spawned[0].process.emit("exit", 0)
      await Promise.all([firstGrant, secondGrant])
      expect(secondGrantSettled).toBe(true)
      aclKey = [...(aclClass._runAclDirs.get(firstRun) ?? [])][0]
      expect(aclKey).toBeTruthy()
      expect(aclClass._grantedAclRefCount.get(aclKey!)).toBe(2)
      expect(aclClass._runAclDirs.get(secondRun)?.has(aclKey!)).toBe(true)
      expect(aclClass._aclOsOperationTails.has(aclKey!)).toBe(false)
    } finally {
      if (aclKey) {
        aclClass._grantedAclRefCount.delete(aclKey)
        aclClass._aclOsOperationTails.delete(aclKey)
      }
      aclClass._runAclDirs.delete(firstRun)
      aclClass._runAclDirs.delete(secondRun)
      spawnMock.mockReset()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("keeps the successor granted when a real predecessor revoke is delayed", async () => {
    const aclClass = LocalSandbox as unknown as {
      grantSandboxWriteAcl: (dir: string, runId: string) => Promise<void>
      revokeGrantedAclsForRun: (runId: string) => Promise<void>
      _grantedAclRefCount: Map<string, number>
      _runAclDirs: Map<string, Set<string>>
      _aclOsOperationTails: Map<string, Promise<void>>
    }
    const dir = mkdtempSync(join(tmpdir(), "acl-delayed-revoke-"))
    const predecessorRun = `acl-predecessor-${Date.now()}-${Math.random()}`
    const successorRun = `acl-successor-${Date.now()}-${Math.random()}`
    const spawned: Array<{ args: string[]; process: FakeChildProcess }> = []
    spawnMock.mockImplementation((_command: string, args: string[]) => {
      const process = createFakeChildProcess()
      spawned.push({ args, process })
      return process
    })

    let aclKey: string | undefined
    try {
      const initialGrant = aclClass.grantSandboxWriteAcl(dir, predecessorRun)
      await vi.waitFor(() => expect(spawned).toHaveLength(1))
      expect(spawned[0].args).toContain("/grant")
      spawned[0].process.emit("exit", 0)
      await initialGrant
      aclKey = [...(aclClass._runAclDirs.get(predecessorRun) ?? [])][0]
      expect(aclKey).toBeTruthy()
      expect(aclClass._grantedAclRefCount.get(aclKey!)).toBe(1)

      const delayedRevoke = aclClass.revokeGrantedAclsForRun(predecessorRun)
      await vi.waitFor(() => expect(spawned).toHaveLength(2))
      expect(spawned[1].args).toContain("/remove:g")

      const successorGrant = aclClass.grantSandboxWriteAcl(dir, successorRun)
      await Promise.resolve()
      await Promise.resolve()
      expect(spawned).toHaveLength(2)

      spawned[1].process.emit("exit", 0)
      await delayedRevoke
      await vi.waitFor(() => expect(spawned).toHaveLength(3))
      expect(spawned[2].args).toContain("/grant")
      spawned[2].process.emit("exit", 0)
      await successorGrant

      expect(aclClass._grantedAclRefCount.get(aclKey!)).toBe(1)
      expect(aclClass._runAclDirs.get(successorRun)?.has(aclKey!)).toBe(true)
      expect(aclClass._aclOsOperationTails.has(aclKey!)).toBe(false)
    } finally {
      if (aclKey) {
        aclClass._grantedAclRefCount.delete(aclKey)
        aclClass._aclOsOperationTails.delete(aclKey)
      }
      aclClass._runAclDirs.delete(predecessorRun)
      aclClass._runAclDirs.delete(successorRun)
      spawnMock.mockReset()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("continues an ACL operation chain after a predecessor failure", async () => {
    const aclClass = LocalSandbox as unknown as {
      queueAclOsOperation: (key: string, operation: () => Promise<void>) => Promise<void>
      _aclOsOperationTails: Map<string, Promise<void>>
    }
    const key = `acl-failure-${Date.now()}-${Math.random()}`
    const events: string[] = []
    const failed = aclClass
      .queueAclOsOperation(key, async () => {
        events.push("failed-predecessor")
        throw new Error("simulated icacls failure")
      })
      .catch((error) => error)
    const successor = aclClass.queueAclOsOperation(key, async () => {
      events.push("successor")
    })

    expect(await failed).toBeInstanceOf(Error)
    await successor
    await Promise.resolve()
    expect(events).toEqual(["failed-predecessor", "successor"])
    expect(aclClass._aclOsOperationTails.has(key)).toBe(false)
  })
})
