import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
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
import { recordGen, recordShellEdit, recordShellFileOps } from "../services/adoption-tracker"
import { LocalSandbox, executeTraceContext } from "./local-sandbox"
import { ApprovalStore } from "./approval-store"
import { ToolOrchestrator } from "./tool-orchestrator"

const roots: string[] = []
async function fixture(enabled = true, windowsSandbox: "none" | "unelevated" = "none") {
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
    windowsSandbox,
    shellFileTelemetry: enabled,
    onFileMutation: mutation
  })
  return { root, sandbox, mutation }
}
beforeEach(() => {
  vi.mocked(recordGen).mockClear()
  vi.mocked(recordShellEdit).mockClear()
  vi.mocked(recordShellFileOps).mockClear()
})
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })))
})

// These integration commands use Unix printf/cp/sleep. The pure profiler
// tests cover Windows paths; native Windows execution needs a Windows runner.
describe.skipIf(process.platform === "win32")("LocalSandbox Shell generation pipeline", () => {
  function installOrchestrator(sandbox: LocalSandbox, yolo: boolean, approve = true) {
    const approval = vi.fn(async () => ({
      type: approve ? ("approve" as const) : ("reject" as const),
      tool_call_id: "test"
    }))
    sandbox.setOrchestrator(
      new ToolOrchestrator(
        new ApprovalStore(),
        (command, mode, cwd) => sandbox.executeRaw(command, mode, undefined, undefined, { cwd }),
        approval,
        () => yolo
      )
    )
    return approval
  }

  it.each([true, false])(
    "captures through the production Orchestrator branch (YOLO=%s)",
    async (yolo) => {
      const { sandbox, root, mutation } = await fixture()
      installOrchestrator(sandbox, yolo)
      const response = await sandbox.execute(
        'for i in $(seq 1 100); do echo "$i"; done > hello100.html && echo "count=$(wc -l < hello100.html)"'
      )
      expect(response.exitCode).toBe(0)
      expect(response.output).toContain("100")
      expect(mutation).toHaveBeenCalledWith(path.join(root, "hello100.html"), "shell")
      expect(recordShellEdit).toHaveBeenCalledTimes(1)
      const input = vi.mocked(recordShellEdit).mock.calls[0][0]
      expect(input.afterContent.toString().trim().split("\n")).toHaveLength(100)
      expect(input.beforeContent.toString()).toBe("")
    }
  )

  it("never captures a rejected command or leaks its source into a later raw Hook", async () => {
    const { sandbox, mutation } = await fixture()
    const approval = installOrchestrator(sandbox, false, false)
    const response = await sandbox.execute("custom-risky-command")
    expect(approval).toHaveBeenCalledTimes(1)
    expect(response.exitCode).not.toBe(0)
    await sandbox.executeRaw("printf 'hook\\n' > a.ts", "none")
    expect(mutation).not.toHaveBeenCalled()
    expect(recordShellEdit).not.toHaveBeenCalled()
  })

  it.each([true, false])(
    "uses execute.cwd for mutations and legacy move tracking (Orchestrator=%s)",
    async (orchestrated) => {
      const { root, sandbox, mutation } = await fixture()
      const cwd = path.join(root, "nested")
      await mkdir(cwd)
      await writeFile(path.join(cwd, "source.ts"), "nested source\n")
      if (orchestrated) installOrchestrator(sandbox, true)
      expect((await sandbox.execute("mv source.ts moved.ts", cwd)).exitCode).toBe(0)
      expect(recordShellFileOps).toHaveBeenCalledWith("mv source.ts moved.ts", cwd, 0)
      expect(mutation).toHaveBeenCalledWith(path.join(cwd, "moved.ts"), "shell")
      expect(recordShellEdit).not.toHaveBeenCalled()
    }
  )

  it("captures each approved retry separately, after the actual raw attempt", async () => {
    const { sandbox } = await fixture(true, "unelevated")
    const modes: (string | undefined)[] = []
    sandbox.setOrchestrator(
      new ToolOrchestrator(
        new ApprovalStore(),
        async (command, mode, cwd) => {
          modes.push(mode)
          const result = await sandbox.executeRaw(command, mode, undefined, undefined, { cwd })
          // Simulate the sandbox reporting a denial after a partial write. Actual
          // shell writes/snapshots still run; native Windows sandbox is not mocked
          // as verified by this POSIX regression.
          return modes.length === 1
            ? { ...result, output: "Permission denied", exitCode: 1 }
            : result
        },
        async (request) => ({ type: "approve", tool_call_id: request.tool_call.id }),
        () => true
      )
    )
    const response = await sandbox.execute(
      "if [ -f retry.flag ]; then printf 'const a = 3\\n' > a.ts; else printf 'const a = 2\\n' > a.ts; touch retry.flag; fi"
    )
    expect(response.exitCode).toBe(0)
    expect(modes).toEqual(["unelevated", "none"])
    const edits = vi.mocked(recordShellEdit).mock.calls.map(([input]) => input)
    expect(edits).toHaveLength(2)
    expect(edits[0].beforeContent.toString()).toBe("const a = 1\n")
    expect(edits[1].beforeContent.toString()).toBe("const a = 2\n")
    expect(edits[1].afterContent.toString()).toBe("const a = 3\n")
  })

  it("does not capture detached background tasks through the production approval path", async () => {
    const { sandbox } = await fixture()
    installOrchestrator(sandbox, true)
    await sandbox.executeBackground("printf 'background\\n' > a.ts")
    await vi.waitFor(() =>
      expect(LocalSandbox.hasActiveBackgroundTasks("shell-thread")).toBe(false)
    )
    expect(recordShellEdit).not.toHaveBeenCalled()
  })

  it("observes the post-Hook command but does not count Hook-side writes", async () => {
    const { root } = await fixture()
    const rewritten = "printf 'agent edit\\n' > b.ts"
    const hookScript = `require('fs').writeFileSync('a.ts', 'hook edit\\n'); process.stdout.write(JSON.stringify({ updatedInput: { command: ${JSON.stringify(rewritten)} } }))`
    const sandbox = new LocalSandbox({
      rootDir: root,
      runId: "hook-rewrite",
      windowsSandbox: "none",
      shellFileTelemetry: true,
      hooks: [
        {
          id: "rewrite",
          enabled: true,
          type: "command",
          event: "PreToolUse",
          matcher: "execute",
          createdAt: "2026-10-08T00:00:00.000Z",
          updatedAt: "2026-10-08T00:00:00.000Z",
          command: `node -e ${JSON.stringify(hookScript)}`
        }
      ]
    })
    installOrchestrator(sandbox, true)
    expect((await sandbox.execute("cat a.ts")).exitCode).toBe(0)
    expect(await readFile(path.join(root, "a.ts"), "utf8")).toBe("hook edit\n")
    expect(recordShellEdit).toHaveBeenCalledTimes(1)
    expect(vi.mocked(recordShellEdit).mock.calls[0][0].filePath).toBe(path.join(root, "b.ts"))
  })

  it.each([
    'target=a.ts; printf "const a = 2\\n" > "$target"',
    'printf "const a = 2\\n" > a.ts 2>&1',
    'printf "const a = 2\\n" &> a.ts',
    "bash -c 'printf \"const a = 2\\n\"' > a.ts",
    'echo "<<EOF"\nprintf "const a = 2\\n" > a.ts'
  ])("captures real structural writes through Orchestrator: %s", async (command) => {
    const { sandbox } = await fixture()
    installOrchestrator(sandbox, true)
    expect((await sandbox.execute(command)).exitCode).toBe(0)
    expect(recordShellEdit).toHaveBeenCalledTimes(1)
  })

  it("distinguishes template pipelines from model output through Orchestrator", async () => {
    const { sandbox, mutation } = await fixture()
    installOrchestrator(sandbox, true)
    expect((await sandbox.execute("cat a.ts | tee copied.ts")).exitCode).toBe(0)
    expect(mutation).toHaveBeenCalled()
    expect(recordShellEdit).not.toHaveBeenCalled()
    expect((await sandbox.execute("printf 'model\\n' | tee created.ts")).exitCode).toBe(0)
    expect(recordShellEdit).toHaveBeenCalledTimes(1)
  })
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
    installOrchestrator(sandbox, true)
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
    installOrchestrator(sandbox, true)
    expect((await sandbox.execute("printf 'partial\\n' > a.ts; false")).exitCode).not.toBe(0)
    expect(recordShellEdit).toHaveBeenCalledTimes(1)
    expect(mutation).toHaveBeenCalledTimes(1)
  })

  it("does not capture a read-only command or a raw hook invocation", async () => {
    const { sandbox, mutation } = await fixture()
    installOrchestrator(sandbox, true)
    await sandbox.execute("cat a.ts")
    // Hooks call executeRaw directly, without the foreground-agent ALS flag.
    const raw = sandbox as unknown as { executeRaw(command: string): Promise<{ exitCode: number }> }
    expect((await raw.executeRaw("printf 'hook\\n' > a.ts")).exitCode).toBe(0)
    expect(recordShellEdit).not.toHaveBeenCalled()
    expect(mutation).not.toHaveBeenCalled()
  })

  it("keeps shared Task backend generation attributed to the invoking child", async () => {
    const { sandbox } = await fixture()
    installOrchestrator(sandbox, true)
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
    installOrchestrator(sandbox, true)
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
