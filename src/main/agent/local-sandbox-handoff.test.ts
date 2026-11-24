import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ApprovalStore } from "./approval-store"
import { FailureFuseHaltError } from "./failure-fuse"
import { LocalSandbox } from "./local-sandbox"
import { ToolOrchestrator } from "./tool-orchestrator"
import type { ApprovalDecision, ApprovalRequest } from "../types"
import { HookHaltError } from "../hooks/halt"
import type { HookEvent } from "../hooks/types"

const windowsGitBash = path.join(
  process.env.ProgramFiles ?? "C:/Program Files",
  "Git",
  "bin",
  "bash.exe"
)

const workspaces: { root: string; sandbox: LocalSandbox }[] = []

async function fixture(hookTurnId?: string) {
  const root = await mkdtemp(path.join(tmpdir(), "cmb-shell-handoff-"))
  const sandbox = new LocalSandbox({
    rootDir: root,
    runId: root,
    hookTurnId,
    windowsSandbox: "none"
  })
  workspaces.push({ root, sandbox })
  return { root, sandbox }
}

afterEach(async () => {
  for (const { root, sandbox } of workspaces.splice(0)) {
    await LocalSandbox.cancelBackgroundTasksAndWait(sandbox.runId)
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

describe("LocalSandbox execute handoff", () => {
  it("moves one real process to monitoring, retains workspace exclusion and returns final output", async () => {
    const { root, sandbox } = await fixture()
    await writeFile(
      path.join(root, "handoff.cjs"),
      [
        'const fs = require("node:fs")',
        'fs.appendFileSync("launches", process.pid + "\\n")',
        'console.log("phase-before")',
        "const keepAlive = setInterval(() => {",
        '  if (!fs.existsSync("release")) return',
        "  clearInterval(keepAlive)",
        '  console.log("phase-after", process.pid)',
        "}, 25)",
        ""
      ].join("\n")
    )

    const originTurn = new AbortController()
    const ownerId = "worker-tool-call"
    const command = await sandbox.executeForTool("node handoff.cjs", undefined, {
      ownerId,
      signal: originTurn.signal,
      backgroundAfterMs: 150
    })
    expect(command.status).toBe("background")
    if (command.status !== "background") throw new Error(command.result.output)
    const { taskId } = command
    expect(command.output).toContain(taskId)
    expect(LocalSandbox.hasActiveBackgroundTasks(sandbox.runId)).toBe(true)
    expect(sandbox.getTaskOutput(taskId)).toBeNull()
    expect(sandbox.getTaskOutput(taskId, ownerId)).toMatchObject({ completed: false })
    await expect(sandbox.waitForTaskOutput(taskId, { ownerId: "other-worker" })).resolves.toEqual({
      status: "missing"
    })
    const foreign = new LocalSandbox({
      rootDir: root,
      runId: "other-thread",
      windowsSandbox: "none"
    })
    expect(foreign.getTaskOutput(taskId, ownerId)).toBeNull()

    await vi.waitFor(
      () => expect(sandbox.getTaskOutput(taskId, ownerId)?.partialOutput).toContain("phase-before"),
      { timeout: 10_000 }
    )
    const firstLaunch = (await readFile(path.join(root, "launches"), "utf8")).trim()
    const terminal = sandbox.waitForTaskOutput(taskId, { ownerId, timeoutMs: 15_000 })
    originTurn.abort()

    let successorDone = false
    const successor = sandbox.execute("node --version").then((response) => {
      successorDone = true
      return response
    })
    await delay(120)
    expect(successorDone).toBe(false)
    expect(sandbox.getTaskOutput(taskId, ownerId)?.completed).toBe(false)
    await writeFile(path.join(root, "release"), "")
    const result = await terminal
    expect(result).toMatchObject({ status: "completed", result: { exitCode: 0 } })
    if (!("result" in result)) throw new Error(result.status)
    expect(result.result.output).toContain("phase-before")
    expect(result.result.output).toContain("phase-after " + firstLaunch)
    expect((await readFile(path.join(root, "launches"), "utf8")).trim()).toBe(firstLaunch)
    await expect(successor).resolves.toMatchObject({ exitCode: 0 })
    await vi.waitFor(() => expect(LocalSandbox.hasActiveBackgroundTasks(sandbox.runId)).toBe(false))
  }, 30_000)

  it("keeps short native commands synchronous and preserves exit code, Unicode and arguments", async () => {
    const { root, sandbox } = await fixture()
    await writeFile(
      path.join(root, "short probe.cjs"),
      ['console.log("中文", process.argv[2])', "process.exitCode = 29", ""].join("\n")
    )
    const shellCommand = 'node "short probe.cjs" "a b"'
    const foreground = await sandbox.execute(shellCommand)
    const treatment = await sandbox.executeForTool(shellCommand, undefined, {
      backgroundAfterMs: 10_000
    })
    expect(foreground).toMatchObject({ exitCode: 29 })
    expect(foreground.output).toContain("中文 a b")
    expect(treatment).toEqual({ status: "completed", result: foreground })
    expect(LocalSandbox.hasActiveBackgroundTasks(sandbox.runId)).toBe(false)
  }, 30_000)

  it.skipIf(process.platform !== "win32")(
    "keeps explicit child breakaway available until handoff",
    async () => {
      const { root, sandbox } = await fixture()
      await writeFile(
        path.join(root, "BreakawayProbe.cs"),
        `using System;
using System.Runtime.InteropServices;
using System.Text;
public static class BreakawayProbe {
    [StructLayout(LayoutKind.Sequential)]
    struct StartupInfo {
        public int Size;
        public IntPtr Reserved, Desktop, Title;
        public uint X, Y, XSize, YSize, XChars, YChars, Fill, Flags;
        public ushort ShowWindow, ReservedCount;
        public IntPtr ReservedPointer, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct ProcessInformation {
        public IntPtr Process, Thread;
        public uint ProcessId, ThreadId;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcess(string executable, StringBuilder commandLine,
        IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags,
        IntPtr environment, string cwd, ref StartupInfo start, out ProcessInformation child);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
    public static int Run() {
        var executable = Environment.GetEnvironmentVariable("ComSpec");
        var start = new StartupInfo { Size = Marshal.SizeOf(typeof(StartupInfo)) };
        ProcessInformation child;
        const uint CreateBreakawayFromJob = 0x01000000;
        const uint CreateNoWindow = 0x08000000;
        if (!CreateProcess(executable, new StringBuilder("cmd.exe /d /c exit 0"),
            IntPtr.Zero, IntPtr.Zero, false, CreateBreakawayFromJob | CreateNoWindow,
            IntPtr.Zero, null, ref start, out child)) return Marshal.GetLastWin32Error();
        WaitForSingleObject(child.Process, 5000);
        CloseHandle(child.Thread);
        CloseHandle(child.Process);
        return 0;
    }
}
`
      )
      await writeFile(
        path.join(root, "probe.ps1"),
        [
          'Add-Type -Path "BreakawayProbe.cs" -ErrorAction Stop',
          'while (!(Test-Path -LiteralPath "release-breakaway")) { Start-Sleep -Milliseconds 25 }',
          "$code = [BreakawayProbe]::Run()",
          'Write-Output "Breakaway result: $code"',
          "exit $code"
        ].join("\n")
      )
      const release = path.join(root, "release-breakaway")
      const command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File probe.ps1"
      await writeFile(release, "")
      await expect(
        sandbox.executeForTool(command, undefined, { backgroundAfterMs: 60_000 })
      ).resolves.toMatchObject({
        status: "completed",
        result: { exitCode: 0, output: expect.stringContaining("Breakaway result: 0") }
      })

      await unlink(release)
      const task = await sandbox.executeForTool(command, undefined, { backgroundAfterMs: 100 })
      if (task.status !== "background") throw new Error(task.result.output)
      await writeFile(release, "")
      await expect(
        sandbox.waitForTaskOutput(task.taskId, { timeoutMs: 15_000 })
      ).resolves.toMatchObject({
        status: "completed",
        result: { exitCode: 5, output: expect.stringContaining("Breakaway result: 5") }
      })
    },
    30_000
  )

  it.skipIf(process.platform !== "win32" || !existsSync(windowsGitBash))(
    "preserves a short Git Bash command's deliberately detached child",
    async () => {
      const { root, sandbox } = await fixture()
      const shell = vi
        .spyOn(LocalSandbox as unknown as { resolveShell: () => Promise<string> }, "resolveShell")
        .mockResolvedValue(windowsGitBash)
      try {
        await writeFile(
          path.join(root, "detached.cjs"),
          [
            'const fs = require("node:fs")',
            "setTimeout(() => fs.writeFileSync(process.argv[2], String(process.pid)), 600)"
          ].join("\n")
        )
        const detached = (marker: string) =>
          "node detached.cjs " + marker + " </dev/null >/dev/null 2>&1 & echo started"
        const baseline = await sandbox.execute(detached("baseline-ready"))
        expect(baseline).toMatchObject({ exitCode: 0, output: "started\n" })
        const automatic = await sandbox.executeForTool(detached("auto-ready"), undefined, {
          backgroundAfterMs: 60_000
        })
        expect(automatic).toEqual({ status: "completed", result: baseline })
        await vi.waitFor(
          async () => {
            for (const marker of ["baseline-ready", "auto-ready"]) {
              const pid = Number(await readFile(path.join(root, marker), "utf8"))
              expect(Number.isSafeInteger(pid) && pid > 0).toBe(true)
              // Windows keeps the fixture cwd busy while the detached child is still exiting.
              expect(() => process.kill(pid, 0)).toThrow("ESRCH")
            }
          },
          { timeout: 10_000 }
        )
      } finally {
        shell.mockRestore()
      }
    },
    30_000
  )

  it.skipIf(process.platform !== "win32" || !existsSync(windowsGitBash))(
    "settles a promoted Git Bash task only after reaping a redirected child of the exited shell",
    async () => {
      const { root, sandbox } = await fixture()
      const shell = vi
        .spyOn(LocalSandbox as unknown as { resolveShell: () => Promise<string> }, "resolveShell")
        .mockResolvedValue(windowsGitBash)
      try {
        await writeFile(
          path.join(root, "detached.cjs"),
          [
            'const fs = require("node:fs")',
            'fs.writeFileSync("child-pid", String(process.pid))',
            'setTimeout(() => fs.writeFileSync("late-write", "still running"), 1800)'
          ].join("\n")
        )
        const shellCommand =
          "sleep 1; node detached.cjs </dev/null >/dev/null 2>&1 & " +
          "while [ ! -f child-pid ]; do sleep 0.05; done; echo started"
        const task = await sandbox.executeForTool(shellCommand, undefined, {
          backgroundAfterMs: 80
        })
        if (task.status !== "background") throw new Error(task.result.output)

        await expect(
          sandbox.waitForTaskOutput(task.taskId, { timeoutMs: 10_000 })
        ).resolves.toMatchObject({
          status: "completed",
          result: { exitCode: 0, output: "started\n" }
        })
        await expect(LocalSandbox.cancelBackgroundTasksWithin(sandbox.runId, 1000)).resolves.toBe(
          true
        )
        const pid = Number(await readFile(path.join(root, "child-pid"), "utf8"))
        expect(Number.isSafeInteger(pid) && pid > 0).toBe(true)
        expect(() => process.kill(pid, 0)).toThrow("ESRCH")
        expect(existsSync(path.join(root, "late-write"))).toBe(false)
      } finally {
        shell.mockRestore()
      }
    },
    30_000
  )

  it("stops the native runner's whole process tree after handoff", async () => {
    const { root, sandbox } = await fixture()
    await writeFile(
      path.join(root, "child.cjs"),
      [
        'const fs = require("node:fs")',
        'setInterval(() => fs.appendFileSync("ticks", "x"), 25)'
      ].join("\n")
    )
    await writeFile(
      path.join(root, "parent.cjs"),
      [
        'const { spawn } = require("node:child_process")',
        'spawn(process.execPath, ["child.cjs"], { stdio: "ignore" })',
        "setInterval(() => {}, 200)"
      ].join("\n")
    )
    const command = await sandbox.executeForTool("node parent.cjs", undefined, {
      backgroundAfterMs: 80
    })
    if (command.status !== "background") throw new Error("expected process handoff")
    const marker = path.join(root, "ticks")
    await vi.waitFor(
      async () => {
        expect(await readFile(marker, "utf8")).toMatch(/xx/)
      },
      { timeout: 10_000 }
    )

    const terminal = sandbox.waitForTaskOutput(command.taskId)
    await LocalSandbox.cancelBackgroundTasksAndWait(sandbox.runId)
    await expect(terminal).resolves.toMatchObject({
      status: "completed",
      result: { exitCode: 130 }
    })
    const ticksAtCleanup = await readFile(marker, "utf8")
    await delay(200)
    expect(await readFile(marker, "utf8")).toBe(ticksAtCleanup)
    expect(LocalSandbox.hasActiveBackgroundTasks(sandbox.runId)).toBe(false)
  }, 30_000)

  it("waits for approval beyond the foreground threshold without spawning or handing off", async () => {
    const { sandbox } = await fixture()
    let answer!: (decision: ApprovalDecision) => void
    const approve = vi.fn(
      () =>
        new Promise<ApprovalDecision>((resolve) => {
          answer = resolve
        })
    )
    const original = vi.fn()
    sandbox.setOrchestrator(
      new ToolOrchestrator(new ApprovalStore(), original, approve, () => false)
    )
    const execute = vi.spyOn(sandbox, "executeRaw")
    let done = false
    const command = sandbox
      .executeForTool("cmb-test-unknown-program", undefined, {
        backgroundAfterMs: 30
      })
      .then((result) => {
        done = true
        return result
      })

    await vi.waitFor(() => expect(approve).toHaveBeenCalledOnce(), { timeout: 10_000 })
    try {
      await delay(120)
      expect(done).toBe(false)
      expect(LocalSandbox.hasActiveBackgroundTasks(sandbox.runId)).toBe(false)
      expect(execute).not.toHaveBeenCalled()
    } finally {
      answer({ type: "reject", tool_call_id: "approval-test" })
    }
    await expect(command).resolves.toMatchObject({ status: "completed", result: { exitCode: 1 } })
    expect(original).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
  }, 20_000)

  it.each([
    { command: 'git commit -m "probe" -- note.txt', operation: "git_commit", result: "提交" },
    { command: "git push", operation: "git_push", result: "推送" }
  ])(
    "cancels a pending explicit background $operation approval",
    async ({ command, operation, result }) => {
      const { root, sandbox } = await fixture()
      execFileSync("git", ["init", "--quiet", root])
      await writeFile(path.join(root, "note.txt"), "test")
      const caller = new AbortController()
      const approval = deferred<ApprovalDecision>()
      const approve = vi.fn((request: ApprovalRequest, signal?: AbortSignal) => {
        signal?.addEventListener(
          "abort",
          () => approval.resolve({ type: "reject", tool_call_id: request.id }),
          { once: true }
        )
        return approval.promise
      })
      const rawExecute = vi.fn()
      sandbox.setOrchestrator(new ToolOrchestrator(new ApprovalStore(), rawExecute, approve))

      const pending = sandbox.executeBackground(command, undefined, undefined, caller.signal)
      try {
        await vi.waitFor(() => expect(approve).toHaveBeenCalledOnce(), { timeout: 10_000 })
        expect(approve.mock.calls[0][0].operation).toBe(operation)
        expect(LocalSandbox.cancelDetachedBackgroundTasks(sandbox.runId)).toBe(true)
        await expect(LocalSandbox.cancelBackgroundTasksWithin(sandbox.runId, 1_000)).resolves.toBe(
          true
        )
        await expect(pending).resolves.toContain("用户取消了本次" + result)
        expect(caller.signal.aborted).toBe(false)
        expect(LocalSandbox.hasActiveBackgroundTasks(sandbox.runId)).toBe(false)
        expect(rawExecute).not.toHaveBeenCalled()
      } finally {
        approval.resolve({ type: "reject", tool_call_id: "cleanup" })
        await pending
      }
    },
    20_000
  )

  it("does not retry a capped sandbox result or spawn after cancellation during bypass approval", async () => {
    let answer!: (decision: ApprovalDecision) => void
    const approve = vi.fn(
      () =>
        new Promise<ApprovalDecision>((resolve) => {
          answer = resolve
        })
    )
    const rawExecute = vi.fn()
    const orchestrator = new ToolOrchestrator(new ApprovalStore(), vi.fn(), approve, () => true)
    const controller = new AbortController()
    const execution = { rawExecute, signal: controller.signal }
    const capped = {
      exitCode: 124,
      output: "Permission denied",
      truncated: false,
      capReached: true
    }
    const failed = { exitCode: 1, output: "Permission denied", truncated: false }

    await expect(
      orchestrator.maybeRetryOutsideSandbox(
        "node probe.cjs",
        process.cwd(),
        "unelevated",
        capped,
        "posix",
        execution
      )
    ).resolves.toBe(capped)
    expect(approve).not.toHaveBeenCalled()
    const retry = orchestrator.maybeRetryOutsideSandbox(
      "node probe.cjs",
      process.cwd(),
      "unelevated",
      failed,
      "posix",
      execution
    )
    expect(approve).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "execute" }),
      controller.signal
    )
    controller.abort()
    answer({ type: "approve", tool_call_id: "stale-approval" })
    await expect(retry).resolves.toBe(failed)
    expect(rawExecute).not.toHaveBeenCalled()
  })
  it.each([
    new HookHaltError({ hookEvent: "PostToolUse", fallbackReason: "review halted" }),
    new FailureFuseHaltError({
      action: "halt",
      fingerprint: "shell-test",
      count: 3,
      threshold: 3,
      reason: "review halted"
    })
  ])(
    "keeps late $name in its originating turn and records the reason for the next turn",
    async (halt) => {
      const { root, sandbox } = await fixture("hook-turn-1")
      const hook = vi
        .spyOn(sandbox as unknown as { runHooks: (event: HookEvent) => Promise<null> }, "runHooks")
        .mockImplementation(async (event) => {
          if (event === "PostToolUse") throw halt
          return null
        })

      await expect(
        sandbox.executeForTool("node --version", undefined, {
          backgroundAfterMs: 60_000
        })
      ).rejects.toBe(halt)
      hook.mockClear()

      await writeFile(
        path.join(root, "late-hook.cjs"),
        [
          'const fs = require("node:fs")',
          "const timer = setInterval(() => {",
          '  if (fs.existsSync("release")) clearInterval(timer)',
          "}, 25)"
        ].join("\n")
      )
      const command = await sandbox.executeForTool("node late-hook.cjs", undefined, {
        backgroundAfterMs: 80
      })
      if (command.status !== "background") throw new Error("expected process handoff")
      const originalRead = sandbox.waitForTaskOutput(command.taskId)
      await writeFile(path.join(root, "release"), "")
      await expect(originalRead).rejects.toBe(halt)
      expect(() => sandbox.getTaskOutput(command.taskId)).toThrow(halt)
      expect(hook.mock.calls.map(([event]) => event)).toEqual(["PreToolUse", "PostToolUse"])

      const successor = new LocalSandbox({
        rootDir: root,
        runId: sandbox.runId,
        hookTurnId: "hook-turn-2",
        windowsSandbox: "none"
      })
      await expect(successor.waitForTaskOutput(command.taskId)).resolves.toMatchObject({
        status: "completed",
        result: { completed: true, exitCode: 1, stopReason: "review halted" }
      })
    },
    30_000
  )

  it("prevents a stopped explicit task from starting an approved bypass retry", async () => {
    const { sandbox } = await fixture()
    const answer = deferred<ApprovalDecision>()
    const approve = vi.fn(() => answer.promise)
    const defaultRaw = vi.fn()
    const orchestrator = new ToolOrchestrator(new ApprovalStore(), defaultRaw, approve, () => true)
    const retry = orchestrator.maybeRetryOutsideSandbox.bind(orchestrator)
    // Simulate the sandbox denial while keeping this test independent of Windows sandbox setup.
    vi.spyOn(orchestrator, "maybeRetryOutsideSandbox").mockImplementation(
      (command, cwd, _mode, result, syntax, execution) =>
        retry(command, cwd, "unelevated", result, syntax, execution)
    )
    sandbox.setOrchestrator(orchestrator)
    const raw = vi.spyOn(sandbox, "executeRaw").mockResolvedValue({
      output: "Permission denied",
      exitCode: 1,
      truncated: false
    })
    const started = await sandbox.executeBackground("node --version")
    const taskId = started.match(/id:\s*([a-f0-9]+)/)?.[1]
    try {
      expect(taskId).toBeTruthy()
      await vi.waitFor(() => expect(approve).toHaveBeenCalledOnce())
      const taskSignal = raw.mock.calls[0]?.[3]
      expect(taskSignal).toBeInstanceOf(AbortSignal)
      const pending = sandbox.waitForTaskOutput(taskId!)
      LocalSandbox.cancelBackgroundTasks(sandbox.runId)
      await expect(pending).resolves.toMatchObject({
        status: "completed",
        result: { exitCode: 130 }
      })
      expect(approve).toHaveBeenCalledWith(
        expect.objectContaining({ operation: "execute" }),
        taskSignal
      )
      expect(taskSignal?.aborted).toBe(true)
    } finally {
      answer.resolve({ type: "approve", tool_call_id: "late-approval" })
      await LocalSandbox.cancelBackgroundTasksAndWait(sandbox.runId)
    }
    expect(defaultRaw).not.toHaveBeenCalled()
    expect(raw).toHaveBeenCalledOnce()
  })

  it.skipIf(process.platform !== "win32")(
    "reaps descendants of a short bypass retry for an already handed-off Windows task",
    async () => {
      const { root, sandbox } = await fixture()
      await writeFile(
        path.join(root, "retry-child.cjs"),
        [
          'const fs = require("node:fs")',
          'fs.writeFileSync("retry-child-pid", String(process.pid))',
          "const timer = setInterval(() => {",
          '  if (fs.existsSync("stop-retry-child")) process.exit(0)',
          "}, 25)",
          "setTimeout(() => clearInterval(timer), 10_000)"
        ].join("\n")
      )
      await writeFile(
        path.join(root, "retry.cjs"),
        [
          'const fs = require("node:fs")',
          'const { spawn } = require("node:child_process")',
          'spawn(process.execPath, ["retry-child.cjs"], { stdio: "ignore" }).unref()',
          "const timer = setInterval(() => {",
          '  if (fs.existsSync("retry-child-pid")) clearInterval(timer)',
          "}, 25)"
        ].join("\n")
      )

      const approve = vi.fn(async (request: ApprovalRequest) => ({
        type: "approve" as const,
        tool_call_id: request.id
      }))
      const orchestrator = new ToolOrchestrator(new ApprovalStore(), vi.fn(), approve, () => true)
      const retry = orchestrator.maybeRetryOutsideSandbox.bind(orchestrator)
      vi.spyOn(orchestrator, "maybeRetryOutsideSandbox").mockImplementation(
        (command, cwd, _mode, result, syntax, execution) =>
          retry(command, cwd, "unelevated", result, syntax, execution)
      )
      sandbox.setOrchestrator(orchestrator)

      const firstExit = deferred<void>()
      const attempts = vi
        .spyOn(sandbox, "executeRaw")
        .mockImplementationOnce(async (_command, _mode, _timeout, _signal, options) => {
          const onExit = options?.handoff?.onSpawn()
          try {
            await firstExit.promise
            return { output: "Permission denied", exitCode: 1, truncated: false }
          } finally {
            onExit?.()
          }
        })
      let childPid: number | undefined
      try {
        const task = await sandbox.executeForTool("node retry.cjs", undefined, {
          backgroundAfterMs: 100
        })
        if (task.status !== "background") throw new Error(task.result.output)
        firstExit.resolve()
        await expect(
          sandbox.waitForTaskOutput(task.taskId, { timeoutMs: 15_000 })
        ).resolves.toMatchObject({ status: "completed", result: { exitCode: 0 } })
        expect(approve).toHaveBeenCalledOnce()
        expect(attempts).toHaveBeenCalledTimes(2)
        childPid = Number(await readFile(path.join(root, "retry-child-pid"), "utf8"))
        expect(Number.isSafeInteger(childPid) && childPid > 0).toBe(true)
        expect(() => process.kill(childPid!, 0)).toThrow("ESRCH")
      } finally {
        firstExit.resolve()
        if (childPid) {
          await writeFile(path.join(root, "stop-retry-child"), "")
          await vi.waitFor(() => expect(() => process.kill(childPid!, 0)).toThrow("ESRCH"))
        }
      }
    },
    30_000
  )

  it("uses the remaining soft process budget across attempts and skips time between spawns", async () => {
    const { sandbox } = await fixture()
    await LocalSandbox.ensureShellReady("none")
    const failed = { output: "sandbox failed", exitCode: 1, truncated: false }
    const success = { output: "retry complete", exitCode: 0, truncated: false }
    const spawned = [deferred<() => void>(), deferred<() => void>()]
    const finished = [deferred<typeof failed>(), deferred<typeof success>()]
    const retryApproved = deferred<void>()
    const retryPending = deferred<void>()
    const orchestrator = new ToolOrchestrator(new ApprovalStore(), vi.fn(), vi.fn(), () => true)
    vi.spyOn(orchestrator, "execute").mockImplementation(
      async (command, _cwd, _mode, _syntax, _outsideSyntax, execution) => {
        if (!execution) throw new Error("expected per-execution runner")
        await execution.rawExecute(command, "unelevated")
        retryPending.resolve()
        await retryApproved.promise
        return execution.rawExecute(command, "none")
      }
    )
    sandbox.setOrchestrator(orchestrator)
    const attempt = vi.spyOn(sandbox, "executeRaw")
    for (const index of [0, 1]) {
      attempt.mockImplementationOnce((_command, _mode, _timeout, _signal, options) => {
        const onExit = options?.handoff?.onSpawn()
        if (!onExit) throw new Error("expected process timer")
        spawned[index].resolve(onExit)
        return finished[index].promise
      })
    }

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] })
    try {
      let returned = false
      const executing = sandbox
        .executeForTool("node --version", undefined, {
          backgroundAfterMs: 60
        })
        .then((result) => {
          returned = true
          return result
        })
      const firstExit = await spawned[0].promise
      await vi.advanceTimersByTimeAsync(40)
      firstExit()
      finished[0].resolve(failed)
      await retryPending.promise
      await vi.advanceTimersByTimeAsync(200)
      expect(returned).toBe(false)

      retryApproved.resolve()
      const secondExit = await spawned[1].promise
      await vi.advanceTimersByTimeAsync(19)
      expect(returned).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      const handoff = await executing
      if (handoff.status !== "background") throw new Error("expected cumulative handoff")
      const terminal = sandbox.waitForTaskOutput(handoff.taskId)
      secondExit()
      finished[1].resolve(success)
      await expect(terminal).resolves.toMatchObject({
        status: "completed",
        result: { output: "retry complete", exitCode: 0 }
      })
      expect(attempt).toHaveBeenCalledTimes(2)
    } finally {
      retryApproved.resolve()
      finished[0].resolve(failed)
      finished[1].resolve(success)
      await LocalSandbox.cancelBackgroundTasksAndWait(sandbox.runId)
      vi.useRealTimers()
    }
  }, 20_000)
})
