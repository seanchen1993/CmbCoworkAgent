import { execFileSync } from "node:child_process"
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { TraceContext } from "./trace/types"

vi.mock("../services/adoption-tracker", async () => {
  const actual = await vi.importActual<typeof import("../services/adoption-tracker")>(
    "../services/adoption-tracker"
  )
  return {
    ...actual,
    recordGen: vi.fn(),
    recordShellEdit: vi.fn(async () => undefined),
    recordShellFileOps: vi.fn()
  }
})
import { recordGen, recordShellEdit } from "../services/adoption-tracker"
import { LocalSandbox, executeTraceContext } from "./local-sandbox"

const roots: string[] = []
async function fixture(enabled = true) {
  const raw = await mkdtemp(path.join(tmpdir(), "sandbox-shell-capture-"))
  roots.push(raw)
  const root = await realpath(raw)
  for (const args of [
    ["init", "-q"],
    ["config", "user.name", "Test"],
    ["config", "user.email", "test@example.invalid"]
  ])
    execFileSync("git", ["-C", root, ...args])
  await writeFile(path.join(root, "a.ts"), "const a = 1\n")
  execFileSync("git", ["-C", root, "add", "."])
  execFileSync("git", ["-C", root, "commit", "-qm", "seed"])
  const mutation = vi.fn()
  const sandbox = new LocalSandbox({
    rootDir: root,
    runId: "shell-thread",
    windowsSandbox: "none",
    shellFileTelemetry: enabled,
    onFileMutation: mutation
  })
  return { root, sandbox, mutation }
}
beforeEach(() => {
  vi.mocked(recordGen).mockClear()
  vi.mocked(recordShellEdit).mockClear()
})
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })))
})

// These integration commands use Unix printf/cp/sleep. The pure profiler
// tests cover Windows paths; native Windows execution needs a Windows runner.
describe.skipIf(process.platform === "win32")("LocalSandbox Shell generation pipeline", () => {
  it("captures a real foreground command with raw pre/post content and mutation notification", async () => {
    const { root, sandbox, mutation } = await fixture()
    const response = await sandbox.execute("printf 'const a = 2\\n' > a.ts")
    expect(response.exitCode).toBe(0)
    expect(mutation).toHaveBeenCalledWith(path.join(root, "a.ts"), "shell")
    expect(recordShellEdit).toHaveBeenCalledTimes(1)
    const input = vi.mocked(recordShellEdit).mock.calls[0][0]
    expect(input.threadId).toBe("shell-thread")
    expect(input.beforeContent.toString()).toBe("const a = 1\n")
    expect(input.afterContent.toString()).toBe("const a = 2\n")
    expect(await input.harnessStagePromise).toBeUndefined()
  })

  it("leaves standard mode unchanged", async () => {
    const { sandbox, mutation } = await fixture(false)
    expect((await sandbox.execute("printf 'changed\\n' > a.ts")).exitCode).toBe(0)
    expect(recordShellEdit).not.toHaveBeenCalled()
    expect(mutation).not.toHaveBeenCalled()
  })

  it("attributes copies but does not report them as model-generated code", async () => {
    const { root, sandbox, mutation } = await fixture()
    expect((await sandbox.execute("cp a.ts copied.ts")).exitCode).toBe(0)
    expect(mutation).toHaveBeenCalledWith(path.join(root, "copied.ts"), "shell")
    expect(recordShellEdit).not.toHaveBeenCalled()
  })

  it("still captures partial mutations from commands that fail", async () => {
    const { sandbox, mutation } = await fixture()
    expect((await sandbox.execute("printf 'partial\\n' > a.ts; false")).exitCode).not.toBe(0)
    expect(recordShellEdit).toHaveBeenCalledTimes(1)
    expect(mutation).toHaveBeenCalledTimes(1)
  })

  it("does not capture a read-only command or a raw hook invocation", async () => {
    const { sandbox, mutation } = await fixture()
    await sandbox.execute("cat a.ts")
    // Hooks call executeRaw directly, without the foreground-agent ALS flag.
    const raw = sandbox as unknown as { executeRaw(command: string): Promise<{ exitCode: number }> }
    expect((await raw.executeRaw("printf 'hook\\n' > a.ts")).exitCode).toBe(0)
    expect(recordShellEdit).not.toHaveBeenCalled()
    expect(mutation).not.toHaveBeenCalled()
  })

  it("keeps shared Task backend generation attributed to the invoking child", async () => {
    const { sandbox } = await fixture()
    const child: TraceContext = {
      traceId: "child-trace",
      threadId: "shell-thread__task_child",
      rootNodeId: "trace:child-trace",
      observabilitySchemaVersion: 1,
      traceKind: "subagent",
      executionMode: "normal",
      rootTraceId: "root",
      rootThreadId: "shell-thread",
      subagentKind: "task",
      subagentRunId: "child"
    }
    await executeTraceContext.run(child, () => sandbox.execute("printf 'child edit\\n' > a.ts"))
    expect(vi.mocked(recordShellEdit).mock.calls[0][0].threadId).toBe(child.threadId)
  })

  it("deduplicates file-tool edits against an overlapping Shell window", async () => {
    const { root, sandbox } = await fixture()
    const fileTools = new LocalSandbox({
      rootDir: root,
      runId: "file-tool-thread",
      windowsSandbox: "none"
    })
    const command = sandbox.execute(
      "printf ready > started.flag; sleep 0.2; printf 'file tool\\n' > new.ts"
    )
    await vi.waitFor(async () =>
      expect(await readFile(path.join(root, "started.flag"), "utf8")).toBe("ready")
    )
    expect((await fileTools.write(path.join(root, "new.ts"), "file tool\n")).error).toBeUndefined()
    await command
    expect(recordGen).toHaveBeenCalledTimes(1)
    expect(recordShellEdit).not.toHaveBeenCalled()
  })
})
