import { tmpdir } from "node:os"
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { LocalSandbox, readOnlyShellExecutionContext } from "./local-sandbox"
import { ApprovalStore } from "./approval-store"
import { ToolOrchestrator } from "./tool-orchestrator"
import type { ExecuteResponse } from "deepagents"
import type { ApprovalDecision } from "../types"

function deferred<T>() {
  let resolve!: (value: T) => void
  return {
    promise: new Promise<T>((done) => {
      resolve = done
    }),
    resolve: (value: T) => resolve(value)
  }
}
const result = { output: "DONE", exitCode: 0, truncated: false }
const threads: string[] = []
afterEach(async () => {
  for (const id of threads.splice(0)) await LocalSandbox.cancelBackgroundTasksAndWait(id)
  vi.restoreAllMocks()
})

function fixture(accepted = vi.fn()) {
  const controller = new AbortController(),
    raw = deferred<ExecuteResponse>(),
    entered = deferred<void>()
  const settled = vi.fn(),
    release = vi.fn(),
    post = vi.fn(async () => null)
  const id = `handoff-${crypto.randomUUID()}`
  threads.push(id)
  const sandbox = new LocalSandbox({
    rootDir: tmpdir(),
    runId: id,
    windowsSandbox: "none",
    abortSignal: controller.signal,
    backgroundCommandLifecycle: { accepted, settled }
  })
  Reflect.set(sandbox, "runPreToolUseHook", async () => null)
  Reflect.set(sandbox, "runHooks", post)
  Reflect.set(sandbox, "requestHumanGateForExecute", async () => ({ release }))
  let signal!: AbortSignal
  let options!: { onData(text: string): void; onTermination(value: Promise<void>): void }
  const execute = vi.fn(async (_command, _mode, _timeout, abort, _cwd, rawOptions) => {
    signal = abort
    options = rawOptions
    entered.resolve()
    return raw.promise
  })
  Reflect.set(sandbox, "executeRawUnserialized", execute)
  return {
    sandbox,
    controller,
    raw,
    entered,
    accepted,
    settled,
    release,
    post,
    execute,
    signal: () => signal,
    options: () => options
  }
}

describe("Bot foreground command handoff", () => {
  it("keeps one original command alive, then publishes after hooks and physical termination", async () => {
    const f = fixture(),
      termination = deferred<void>(),
      hook = deferred<null>()
    f.post.mockImplementation(() => hook.promise)
    const running = f.sandbox.execute("echo handoff")
    await f.entered.promise
    f.options().onData("partial")
    f.options().onTermination(termination.promise)
    expect(LocalSandbox.yieldForegroundCommands(new AbortController().signal)).toBe(0)
    expect(LocalSandbox.yieldForegroundCommands(f.controller.signal)).toBe(1)
    expect(LocalSandbox.yieldForegroundCommands(f.controller.signal)).toBe(0)
    const response = await running
    expect(response.exitCode).toBeNull()
    expect(response.output).toContain("was not restarted")
    const id = f.accepted.mock.calls[0][0].id
    expect(f.sandbox.getTaskOutput(id)?.partialOutput).toBe("partial")
    f.controller.abort() // the completed model turn no longer owns the transferred process
    expect(f.signal().aborted).toBe(false)
    f.raw.resolve(result)
    await vi.waitFor(() => expect(f.post).toHaveBeenCalledOnce())
    expect(f.settled).not.toHaveBeenCalled()
    expect(f.release).not.toHaveBeenCalled()
    hook.resolve(null)
    await Promise.resolve()
    expect(f.settled).not.toHaveBeenCalled()
    termination.resolve()
    await vi.waitFor(() => expect(f.settled).toHaveBeenCalledOnce())
    expect(f.execute).toHaveBeenCalledOnce()
    expect(f.release).toHaveBeenCalledOnce()
    expect(f.settled).toHaveBeenCalledWith(
      expect.objectContaining({ id, output: "DONE", cancelled: false })
    )
  })

  it("retains the ordinary foreground result and cancellation when not handed off", async () => {
    const f = fixture()
    const running = f.sandbox.execute("echo attached")
    await f.entered.promise
    f.controller.abort()
    expect(f.signal().aborted).toBe(true)
    expect(LocalSandbox.yieldForegroundCommands(f.controller.signal)).toBe(0)
    f.raw.resolve(result)
    expect(await running).toEqual(result)
    expect(f.accepted).not.toHaveBeenCalled()
    expect(f.settled).not.toHaveBeenCalled()
    expect(f.release).toHaveBeenCalledOnce()
  })

  it("publishes the terminal receipt even if human gate cleanup fails", async () => {
    const f = fixture()
    f.release.mockImplementation(() => {
      throw new Error("lease cleanup failed")
    })
    const running = f.sandbox.execute("echo cleanup")
    await f.entered.promise
    expect(LocalSandbox.yieldForegroundCommands(f.controller.signal)).toBe(1)
    await running
    f.raw.resolve(result)
    await vi.waitFor(() => expect(f.settled).toHaveBeenCalledOnce())
    expect(f.settled).toHaveBeenCalledWith(expect.objectContaining({ exitCode: 0 }))
    expect(f.release).toHaveBeenCalledOnce()
  })

  it("keeps waiting if durable ownership cannot be saved", async () => {
    const f = fixture(
      vi.fn(() => {
        throw new Error("storage unavailable")
      })
    )
    const running = f.sandbox.execute("echo attached")
    await f.entered.promise
    expect(LocalSandbox.yieldForegroundCommands(f.controller.signal)).toBe(0)
    expect(f.signal().aborted).toBe(false)
    f.raw.resolve(result)
    expect(await running).toEqual(result)
    expect(f.settled).not.toHaveBeenCalled()
  })

  it("explicit background stop cancels the same process and waits for its result", async () => {
    const f = fixture()
    const running = f.sandbox.execute("echo cancel")
    await f.entered.promise
    expect(LocalSandbox.yieldForegroundCommands(f.controller.signal)).toBe(1)
    await running
    const stopping = LocalSandbox.cancelBackgroundTasksAndWait(f.accepted.mock.calls[0][0].threadId)
    expect(f.signal().aborted).toBe(true)
    f.raw.resolve({ ...result, exitCode: 130 })
    await stopping
    expect(f.settled).toHaveBeenCalledWith(
      expect.objectContaining({ cancelled: true, exitCode: 130 })
    )
  })

  it("does not transfer an unapproved command or retry through a completed caller", async () => {
    const f = fixture(),
      approval = deferred<ApprovalDecision>()
    const requestApproval = vi.fn(() => approval.promise)
    f.sandbox.setOrchestrator(
      new ToolOrchestrator(
        new ApprovalStore(),
        (command, mode, cwd) => f.sandbox.executeRaw(command, mode, undefined, undefined, { cwd }),
        requestApproval,
        () => false
      )
    )
    const running = f.sandbox.execute("node handoff.js")
    await vi.waitFor(() => expect(requestApproval).toHaveBeenCalledOnce())
    expect(LocalSandbox.yieldForegroundCommands(f.controller.signal)).toBe(0)
    expect(f.execute).not.toHaveBeenCalled()
    approval.resolve({ type: "approve", tool_call_id: "test" })
    await f.entered.promise
    expect(LocalSandbox.yieldForegroundCommands(f.controller.signal)).toBe(1)
    await running
    f.raw.resolve({ output: "Permission denied", exitCode: 1, truncated: false })
    await vi.waitFor(() => expect(f.settled).toHaveBeenCalledOnce())
    expect(requestApproval).toHaveBeenCalledOnce()
    expect(f.execute).toHaveBeenCalledOnce()
    expect(f.settled).toHaveBeenCalledWith(expect.objectContaining({ exitCode: 1 }))
  })

  it("does not register a handoff for the original desktop runtime", async () => {
    const f = fixture()
    Reflect.set(f.sandbox, "backgroundCommandLifecycle", undefined)
    const running = f.sandbox.execute("echo ordinary")
    await f.entered.promise
    expect(LocalSandbox.yieldForegroundCommands(f.controller.signal)).toBe(0)
    f.raw.resolve(result)
    expect(await running).toEqual(result)
    expect(f.release).toHaveBeenCalledOnce()
  })

  it("does not transfer the shared read-only subagent's command into the main Bot outbox", async () => {
    const f = fixture()
    const running = readOnlyShellExecutionContext.run(true, () => f.sandbox.execute("pwd"))
    await f.entered.promise
    expect(LocalSandbox.yieldForegroundCommands(f.controller.signal)).toBe(0)
    f.raw.resolve(result)
    expect(await running).toEqual(result)
    expect(f.accepted).not.toHaveBeenCalled()
  })

  it.each([false, true])(
    "preserves a real native process across handoff (stop=%s)",
    async (stop) => {
      const root = mkdtempSync(join(tmpdir(), "bot-native-handoff-"))
      const id = `native-handoff-${crypto.randomUUID()}`,
        controller = new AbortController()
      const accepted = vi.fn(),
        done = deferred<void>(),
        settled = vi.fn(() => done.resolve())
      const sandbox = new LocalSandbox({
        rootDir: root,
        runId: id,
        windowsSandbox: "none",
        abortSignal: controller.signal,
        backgroundCommandLifecycle: { accepted, settled }
      })
      const script = join(root, "job.cjs"),
        starts = join(root, "starts.txt")
      writeFileSync(
        script,
        "const fs=require('node:fs');fs.appendFileSync('starts.txt',process.pid+'\\n');console.log('STARTED');setTimeout(()=>{fs.writeFileSync('result.txt','FINISHED');console.log('FINISHED')},1500)"
      )
      threads.push(id)
      try {
        const running = sandbox.execute(`"${process.execPath}" "${script}"`)
        await vi.waitFor(() => expect(existsSync(starts)).toBe(true))
        const pid = Number(readFileSync(starts, "utf8").trim())
        expect(() => process.kill(pid, 0)).not.toThrow()
        expect(LocalSandbox.yieldForegroundCommands(controller.signal)).toBe(1)
        expect((await running).exitCode).toBeNull()
        expect(existsSync(join(root, "result.txt"))).toBe(false)
        expect(() => process.kill(pid, 0)).not.toThrow()
        if (stop) await LocalSandbox.cancelBackgroundTasksAndWait(id)
        await done.promise
        expect(readFileSync(starts, "utf8")).toBe(`${pid}\n`)
        if (stop) {
          expect(existsSync(join(root, "result.txt"))).toBe(false)
          expect(settled).toHaveBeenCalledWith(expect.objectContaining({ cancelled: true }))
        } else {
          expect(readFileSync(join(root, "result.txt"), "utf8")).toBe("FINISHED")
          expect(settled).toHaveBeenCalledWith(
            expect.objectContaining({ exitCode: 0, output: expect.stringContaining("FINISHED") })
          )
        }
        expect(accepted).toHaveBeenCalledOnce()
        expect(() => process.kill(pid, 0)).toThrow()
      } finally {
        controller.abort()
        await LocalSandbox.cancelBackgroundTasksAndWait(id)
        rmSync(root, { recursive: true, force: true })
      }
    },
    15_000
  )
})
