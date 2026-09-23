import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it, vi } from "vitest"
import { LocalSandbox } from "./local-sandbox"
import {
  createCompletionRuntimeCancellation,
  createCompletionToolBudgetMiddleware
} from "./mods-model-boundary"
import { CompletionBudget, withCompletionBudget } from "../mods/v2/completion-budget"

it("cancels a real native repair process through the runtime's shared signal", async () => {
  const root = await mkdtemp(join(tmpdir(), "mods-budget-process-"))
  const script = join(root, "wait.cjs")
  const pidFile = join(root, "pid.txt")
  const parent = new AbortController()
  const cancellation = createCompletionRuntimeCancellation(parent.signal)
  const shell = LocalSandbox as unknown as {
    _cachedResolvedShell: string | null
    _resolvedShellPromise: unknown
  }
  const old = { shell: shell._cachedResolvedShell, promise: shell._resolvedShellPromise }
  shell._cachedResolvedShell = process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe"
  shell._resolvedShellPromise = null
  const sandbox = new LocalSandbox({
    rootDir: root,
    runId: "budget-process",
    windowsSandbox: "none",
    abortSignal: cancellation.signal
  })
  try {
    await writeFile(
      script,
      "require('node:fs').writeFileSync(process.argv[2],String(process.pid));setInterval(()=>{},1000)"
    )
    const budget = new CompletionBudget(1000, 1500)
    const middleware = createCompletionToolBudgetMiddleware(cancellation)
    await expect(
      withCompletionBudget(budget, () =>
        Promise.resolve(
          middleware.wrapToolCall!(
            {
              runtime: { signal: parent.signal },
              toolCall: { name: "execute", args: {}, id: "execute" }
            } as never,
            async () => {
              await sandbox.executeRaw(
                `"${process.execPath}" "${script}" "${pidFile}"`,
                "none",
                30000
              )
              return {} as never
            }
          )
        )
      )
    ).rejects.toThrow(/TIMEOUT|abort/i)
    expect(cancellation.signal.aborted).toBe(true)
    expect(parent.signal.aborted).toBe(false)
    const pid = Number(await readFile(pidFile, "utf8"))
    await vi.waitFor(
      () => {
        expect(() => process.kill(pid, 0)).toThrow()
      },
      { timeout: 5000 }
    )
    expect(createCompletionRuntimeCancellation(parent.signal).signal.aborted).toBe(false)
  } finally {
    parent.abort()
    shell._cachedResolvedShell = old.shell
    shell._resolvedShellPromise = old.promise
    await rm(root, { recursive: true, force: true })
  }
}, 20000)

it("adds no deadline timer when no repair budget is active and removes completed listeners", async () => {
  const parent = new AbortController()
  const scoped = new AbortController()
  const cancellation = createCompletionRuntimeCancellation(parent.signal)
  const run = vi.fn(async () => "ok")
  const timeout = vi.spyOn(AbortSignal, "timeout")
  try {
    expect(await cancellation.run(scoped.signal, run)).toBe("ok")
    expect(timeout).not.toHaveBeenCalled()
    await withCompletionBudget(new CompletionBudget(1000, 1000), () =>
      cancellation.run(scoped.signal, run)
    )
    scoped.abort()
    expect(cancellation.signal.aborted).toBe(false)
    parent.abort()
    expect(cancellation.signal.aborted).toBe(true)
  } finally {
    timeout.mockRestore()
  }
})
