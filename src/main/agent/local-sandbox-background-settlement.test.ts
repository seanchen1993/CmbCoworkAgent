import { EventEmitter } from "node:events"
import { describe, expect, it, vi } from "vitest"

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>(
    "node:child_process"
  )
  return { ...actual, spawn: spawnMock }
})

import { LocalSandbox } from "./local-sandbox"

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
    const dir = process.cwd()
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
    const dir = process.cwd()
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
