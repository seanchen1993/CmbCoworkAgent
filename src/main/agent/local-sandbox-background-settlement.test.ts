import { describe, expect, it, vi } from "vitest"
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
    const execution = createDeferred<{
      output: string
      exitCode: number | null
      truncated: boolean
    }>()
    const termination = createDeferred<void>()
    const sandbox = new LocalSandbox({
      rootDir: process.cwd(),
      runId: threadId,
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
})
