import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { LocalSandbox } from "./local-sandbox"
import { ApprovalStore } from "./approval-store"
import { ToolOrchestrator } from "./tool-orchestrator"
import { AsyncRWLock } from "./async-lock"
import * as fileOperations from "./file-operation-lock"
import { runWorkflowEngine } from "./workflow/engine"
import { createWorkflowRunStore, generateWorkflowRunId, sha256Hex } from "./workflow/run-store"
import { validateWorkflowScript } from "./workflow/script"
import { withWorkflowResourceDeadline } from "./workflow/resource-deadline"
import type { WorkflowResourceDeadline } from "./workflow/types"

const roots: string[] = []
const releases: Array<() => void> = []
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cmb-sandbox-lock-"))
  roots.push(root)
  const file = join(root, "a.txt")
  await writeFile(file, "zero")
  const first = new LocalSandbox({ rootDir: root, runId: "first", windowsSandbox: "none" })
  const secondSignal = new AbortController().signal
  const second = new LocalSandbox({
    rootDir: root,
    runId: "second",
    windowsSandbox: "none",
    abortSignal: secondSignal
  })
  return { root, file, first, second, secondSignal }
}
function holdEdit(sandbox: LocalSandbox, truncate = false) {
  const target = sandbox as unknown as {
    writeFileEncoded: (file: string, content: string, encoding: string) => Promise<void>
  }
  const original = target.writeFileEncoded.bind(target)
  const entered = deferred()
  const release = deferred()
  releases.push(release.resolve)
  vi.spyOn(target, "writeFileEncoded").mockImplementationOnce(async (...args) => {
    if (truncate) await writeFile(args[0], "")
    entered.resolve()
    await release.promise
    await original(...args)
  })
  return { entered, release }
}
afterEach(async () => {
  releases.splice(0).forEach((release) => release())
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("sandbox resource concurrency", () => {
  it("rechecks the original deadline after an awaited file lock without changing the file", async () => {
    const { root, file } = await fixture()
    const startedAt = Date.now()
    const budget: WorkflowResourceDeadline = {
      budgetId: "batch-1", generation: 1,
      policy: { firstExecutionMs: 60_000, totalMs: 120_000, commandMs: 30_000 },
      startedAt, firstDeadlineAt: startedAt + 60_000, deadlineAt: startedAt + 120_000,
      status: "active", commands: []
    }
    await expect(withWorkflowResourceDeadline({
      identity: "original-owner", read: () => budget, save: async () => {}, assertCurrent: vi.fn()
    }, async () => {
      const sandbox = new LocalSandbox({ rootDir: root, windowsSandbox: "none" })
      await sandbox.read(file)
      const held = holdEdit(sandbox)
      const pending = sandbox.edit(file, "zero", "late")
      await held.entered.promise
      vi.spyOn(Date, "now").mockReturnValue(budget.firstDeadlineAt)
      held.release.resolve()
      await pending
    })).rejects.toThrow("EXPIRED")
    expect(await readFile(file, "utf8")).toBe("zero")
  })

  it("keeps isolated background process lifetimes out of file admission", async () => {
    const { root, file } = await fixture()
    const sandbox = new LocalSandbox({
      rootDir: root,
      runId: "background",
      windowsSandbox: "none",
      worktreeIsolation: {
        workspaceRoot: root,
        worktreeRoot: root,
        commonDir: join(root, ".git"),
        branch: "test-background"
      }
    })
    const entered = deferred()
    const release = deferred()
    releases.push(release.resolve)
    const target = sandbox as unknown as {
      executeRawUnserialized: () => Promise<{
        output: string
        exitCode: number
        truncated: boolean
      }>
    }
    vi.spyOn(target, "executeRawUnserialized").mockImplementation(async () => {
      entered.resolve()
      await release.promise
      return { output: "stopped", exitCode: 0, truncated: false }
    })
    const background = sandbox.executeRaw("npm run dev", "none", undefined, undefined, {
      background: true
    })
    await entered.promise
    try {
      expect(await sandbox.read(file)).toContain("zero")
    } finally {
      release.resolve()
      await background
    }
  })

  it("excludes another edit throughout a synchronous formatter hook", async () => {
    const { root, file, second, secondSignal } = await fixture()
    const ready = join(root, "ready")
    const gate = join(root, "release")
    const script = join(root, "formatter.cjs")
    await writeFile(
      script,
      `const fs = require("node:fs")
const { setTimeout } = require("node:timers/promises")
const [file, ready, gate] = process.argv.slice(2)
async function main() {
  const before = fs.readFileSync(file, "utf8")
  fs.writeFileSync(ready, "ready")
  while (!fs.existsSync(gate)) await setTimeout(10)
  fs.writeFileSync(file, before + "-formatted")
}
main().catch(() => process.exit(1))`
    )
    const first = new LocalSandbox({
      rootDir: root,
      runId: "formatter",
      windowsSandbox: "none",
      hooks: [
        {
          id: "formatter",
          event: "PostToolUse",
          matcher: "edit_file",
          enabled: true,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          command: `"${process.execPath}" "${script}" "${file}" "${ready}" "${gate}"`,
          timeout: 10_000
        }
      ]
    })
    const firstEdit = first.edit(file, "zero", "one")
    let secondEdit: ReturnType<LocalSandbox["edit"]> | undefined
    try {
      await vi.waitFor(() => expect(existsSync(ready)).toBe(true), { timeout: 8_000 })
      const queued = deferred()
      const original = secondSignal.addEventListener.bind(secondSignal)
      vi.spyOn(secondSignal, "addEventListener").mockImplementation((...args) => {
        original(...args)
        if (args[0] === "abort") queued.resolve()
      })
      secondEdit = second.edit(file, "one", "two")
      await queued.promise
      expect(await readFile(file, "utf8")).toBe("one")
    } finally {
      await writeFile(gate, "release")
      expect((await firstEdit).error).toBeUndefined()
    }
    expect((await secondEdit)?.error).toBeUndefined()
    expect(await readFile(file, "utf8")).toBe("two-formatted")
  }, 15_000)

  it("serializes same-file edits across sandbox instances while another file progresses", async () => {
    const { root, file, first, second } = await fixture()
    const hold = holdEdit(first)
    const firstEdit = first.edit(file, "zero", "one")
    await hold.entered.promise
    const next = second.edit(file, "one", "two")
    expect((await second.write(join(root, "b.txt"), "independent")).error).toBeUndefined()
    hold.release.resolve()
    expect((await firstEdit).error).toBeUndefined()
    expect((await next).error).toBeUndefined()
    expect(await readFile(file, "utf8")).toBe("two")
  })

  it("does not read a file while another instance is inside its edit critical section", async () => {
    const { root, file, first, second } = await fixture()
    const hold = holdEdit(first)
    const edit = first.edit(file, "zero", "updated")
    await hold.entered.promise
    const reading = second.read(file)
    await second.write(join(root, "b.txt"), "independent")
    hold.release.resolve()
    await edit
    expect(await reading).toContain("updated")
  })

  it("awaits approval before taking file resources and re-reads the approved target", async () => {
    const { file, first, second } = await fixture()
    const entered = deferred()
    const release = deferred()
    releases.push(release.resolve)
    first.setOrchestrator(
      new ToolOrchestrator(
        new ApprovalStore(),
        (command, mode, cwd) => first.executeRaw(command, mode, undefined, undefined, { cwd }),
        async () => {
          entered.resolve()
          await release.promise
          return { type: "approve", tool_call_id: "test" }
        },
        () => false
      )
    )
    const waiting = first.edit(file, "zero", "first")
    await entered.promise
    expect((await second.edit(file, "zero", "second")).error).toBeUndefined()
    release.resolve()
    expect((await waiting).error).toBeTruthy()
    expect(await readFile(file, "utf8")).toBe("second")
  })

  it("protects files against a hook-rewritten foreground command without Windows sandboxing", async () => {
    const { file, first, second } = await fixture()
    const hold = holdEdit(first)
    const edit = first.edit(file, "zero", "one")
    await hold.entered.promise
    const privateSandbox = second as unknown as {
      runPreToolUseHook: () => Promise<unknown>
      executeRawUnserialized: () => Promise<{
        output: string
        exitCode: number
        truncated: boolean
      }>
    }
    vi.spyOn(privateSandbox, "runPreToolUseHook").mockResolvedValue({
      updatedInput: { command: "node -e writeSomething()" }
    })
    const execute = vi
      .spyOn(privateSandbox, "executeRawUnserialized")
      .mockImplementation(async () => {
        expect(await readFile(file, "utf8")).toBe("one")
        return { output: "executed", exitCode: 0, truncated: false }
      })
    const queued = deferred()
    const original = fileOperations.withWorkspaceExecution
    vi.spyOn(fileOperations, "withWorkspaceExecution").mockImplementation(function observe<T>(
      workspace: string,
      access: "read" | "write",
      operation: () => Promise<T>,
      signal?: AbortSignal
    ) {
      const result = original(workspace, access, operation, signal)
      if (access === "write") queued.resolve()
      return result
    })
    const shell = second.execute("git status")
    await queued.promise
    expect(execute).not.toHaveBeenCalled()
    hold.release.resolve()
    await edit
    expect((await shell).exitCode).toBe(0)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(await readFile(file, "utf8")).toBe("one")
  })

  it.each(["read", "write"] as const)(
    "coordinates workflow %s with an active sandbox edit",
    async (access) => {
      const { root, file, first } = await fixture()
      const hold = holdEdit(first)
      const edit = first.edit(file, "zero", "one")
      await hold.entered.promise
      const script = `export const meta = { name: "files", description: "test" }
${access === "read" ? 'return await readFile("a.txt")' : 'await writeFile("a.txt", "script"); return "script"'}`
      const parsed = validateWorkflowScript(script)
      const now = new Date().toISOString()
      const store = createWorkflowRunStore({
        workspacePath: root,
        threadId: "file-test",
        initial: {
          version: 1,
          runId: generateWorkflowRunId(),
          threadId: "file-test",
          workflowName: "files",
          script,
          scriptSha256: sha256Hex(script),
          status: "running",
          phases: [],
          currentPhase: null,
          agents: [],
          worktrees: [],
          logs: [],
          journal: [],
          stats: {
            agentsTotal: 0,
            agentsCached: 0,
            agentsFailed: 0,
            outputTokens: 0,
            durationMs: 0
          },
          startedAt: now,
          updatedAt: now
        }
      })
      const controller = new AbortController()
      const queued = deferred()
      let operationStarted = false
      const original = AsyncRWLock.prototype[access]
      vi.spyOn(AsyncRWLock.prototype, access).mockImplementation(function observe<T>(
        this: AsyncRWLock,
        operation: () => Promise<T>,
        signal?: AbortSignal
      ) {
        const result = original.call(
          this,
          async () => {
            operationStarted = true
            return operation()
          },
          signal
        ) as Promise<T>
        queued.resolve()
        return result
      })
      const workflow = runWorkflowEngine({
        parsed,
        runStore: store,
        workspacePath: root,
        agentProfiles: [],
        signal: controller.signal,
        emit: () => {},
        subagentRunner: async () => {
          throw new Error("No model call expected")
        }
      })
      await queued.promise
      expect(operationStarted).toBe(false)
      hold.release.resolve()
      await edit
      const expected = access === "read" ? "one" : "script"
      expect(await workflow).toMatchObject({ status: "completed", result: expected })
      expect(await readFile(file, "utf8")).toBe(expected)
    }
  )

  it.each(["shell", "grep"] as const)("keeps %s out of a truncated file write", async (kind) => {
    const { file, first, second, secondSignal } = await fixture()
    const hold = holdEdit(first, true)
    const edit = first.edit(file, "zero", "one")
    await hold.entered.promise
    expect(await readFile(file, "utf8")).toBe("")
    const queued = deferred()
    const addListener = secondSignal.addEventListener.bind(secondSignal)
    vi.spyOn(secondSignal, "addEventListener").mockImplementation((...args) => {
      addListener(...args)
      if (args[0] === "abort") queued.resolve()
    })
    const target = second as unknown as {
      executeRawUnserialized: () => Promise<{
        output: string
        exitCode: number
        truncated: boolean
      }>
      ripgrepSearch: () => Promise<Record<string, Array<[number, string]>>>
    }
    const shellRead = vi.spyOn(target, "executeRawUnserialized").mockImplementation(async () => ({
      output: await readFile(file, "utf8"),
      exitCode: 0,
      truncated: false
    }))
    const grepRead = vi.spyOn(target, "ripgrepSearch").mockImplementation(async () => ({
      [file]: [[1, await readFile(file, "utf8")]]
    }))
    const reading = kind === "shell" ? second.execute("cat a.txt") : second.grepRaw("one", file)
    await queued.promise
    expect(shellRead).not.toHaveBeenCalled()
    expect(grepRead).not.toHaveBeenCalled()
    hold.release.resolve()
    expect((await edit).error).toBeUndefined()
    const result = await reading
    if (kind === "shell") expect(result).toMatchObject({ output: "one", exitCode: 0 })
    else expect(result).toEqual([{ path: file, line: 1, text: "one" }])
  })
})
