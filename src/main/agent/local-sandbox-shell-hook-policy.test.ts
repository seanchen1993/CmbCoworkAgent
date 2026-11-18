import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { HookHaltError } from "../hooks/halt"
import type { HookConfig } from "../hooks/types"
import { FailureFuseHaltError } from "./failure-fuse"
import { LocalSandbox, type LocalSandboxOptions } from "./local-sandbox"

const cleanup: Array<() => Promise<void>> = []

beforeEach(() => vi.stubEnv("CMB_AGENT_FAIL_FAST", "0"))

afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

function httpHook(options: Partial<HookConfig> = {}): HookConfig {
  return {
    id: "shell-post-hook",
    enabled: true,
    event: "PostToolUse",
    type: "http",
    matcher: "execute",
    url: "https://hooks.invalid/post",
    createdAt: "",
    updatedAt: "",
    ...options
  }
}

async function fixture(options: Partial<LocalSandboxOptions> = {}, isolateWorktree = false) {
  const root = await mkdtemp(path.join(tmpdir(), "cmb-shell-hook-policy-"))
  const sandbox = new LocalSandbox({
    rootDir: root,
    runId: root,
    hookTurnId: "test-turn",
    windowsSandbox: "none",
    ...(isolateWorktree && {
      worktreeIsolation: {
        workspaceRoot: root,
        worktreeRoot: root,
        commonDir: path.join(root, ".git"),
        branch: "fixture"
      }
    }),
    ...options
  })
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<{ exitCode: number; output: string; truncated: boolean }>()
  const finish = (exitCode = 0) => release.resolve({ exitCode, output: "shell", truncated: false })
  const raw = vi
    .spyOn(sandbox, "executeRaw")
    .mockImplementation(async (_cmd, _mode, _ms, _signal, opts) => {
      const stop = opts?.handoff?.onSpawn()
      entered.resolve()
      try {
        return await release.promise
      } finally {
        stop?.()
      }
    })
  cleanup.push(async () => {
    finish()
    await LocalSandbox.cancelBackgroundTasksAndWait(sandbox.runId)
    await rm(root, { recursive: true, force: true, maxRetries: 5 })
  })
  const execute = (command = "echo probe") =>
    sandbox.executeForTool(command, undefined, { backgroundAfterMs: 1 })
  return { sandbox, raw, entered: entered.promise, execute, finish }
}

function respond(data: unknown): Response {
  return new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } })
}

describe("shell auto-handoff hook policy", () => {
  it("uses the post-PreToolUse command to match synchronous hooks", async () => {
    const hook = httpHook({ if: "execute(echo rewritten)" })
    const pre = httpHook({ id: "pre", event: "PreToolUse", url: "https://hooks.invalid/pre" })
    const fetchHook = vi.fn(async (url: string) =>
      url.endsWith("/pre")
        ? respond({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              updatedInput: { command: "echo rewritten" }
            }
          })
        : respond({ continue: false, stopReason: "post-hook halted" })
    )
    vi.stubGlobal("fetch", fetchHook)
    const { raw, entered, execute, finish } = await fixture({ hooks: [pre, hook] })
    const execution = execute()
    const rejected = expect(execution).rejects.toBeInstanceOf(HookHaltError)
    await entered
    expect(raw.mock.calls[0][0]).toBe("echo rewritten")
    expect(raw.mock.calls[0][2]).toBeUndefined()
    expect(raw.mock.calls[0][4]?.handoff).toBeUndefined()
    finish()
    await rejected
    expect(fetchHook).toHaveBeenCalledTimes(2)
  })

  it("lets unmatched hooks and ordinary async execute hooks hand off", async () => {
    const onHookResult = vi.fn()
    const fetchHook = vi.fn(async () => respond({ continue: false }))
    vi.stubGlobal("fetch", fetchHook)
    const { sandbox, execute, finish } = await fixture({
      hooks: [
        httpHook({ id: "file-hook", matcher: "read_file" }),
        httpHook({ id: "other-command", if: "execute(git *)" }),
        httpHook({ id: "async-hook", async: true }),
        httpHook({ id: "failure-notification", event: "PostToolUseFailure" })
      ],
      onHookResult
    })
    const task = await execute()
    if (task.status !== "background") throw new Error("Expected automatic handoff")
    finish(37)
    await expect(sandbox.waitForTaskOutput(task.taskId)).resolves.toMatchObject({
      status: "completed",
      result: { exitCode: 37, output: "shell" }
    })
    await vi.waitFor(() => {
      expect(onHookResult).toHaveBeenCalledWith(
        "PostToolUse",
        expect.objectContaining({ id: "async-hook" }),
        expect.objectContaining({ asyncStatus: "completed" })
      )
      expect(onHookResult).toHaveBeenCalledWith(
        "PostToolUseFailure",
        expect.objectContaining({ id: "failure-notification" }),
        expect.anything()
      )
    })
    expect(fetchHook).toHaveBeenCalledTimes(2)
  })

  it("freezes the configured hooks and FailureFuse mode through automatic completion", async () => {
    const hook = httpHook({ async: true })
    const hooks = [hook]
    const fetchHook = vi.fn(async () =>
      respond({ continue: false, stopReason: "configured later" })
    )
    vi.stubGlobal("fetch", fetchHook)
    const { sandbox, execute, raw, finish } = await fixture({ hooks: () => hooks })
    const task = await execute()
    if (task.status !== "background") throw new Error("Expected automatic handoff")
    hook.async = false
    hooks.push(httpHook({ id: "newly-enabled", url: "https://hooks.invalid/new" }))
    vi.stubEnv("CMB_AGENT_FAIL_FAST", "1")
    finish(29)
    await expect(sandbox.waitForTaskOutput(task.taskId)).resolves.toMatchObject({
      status: "completed",
      result: { exitCode: 29 }
    })
    expect(fetchHook).toHaveBeenCalledOnce()

    vi.stubEnv("CMB_AGENT_FAIL_FAST", "0")
    await expect(execute()).rejects.toMatchObject({ message: "configured later" })
    expect(raw.mock.calls[1][4]?.handoff).toBeUndefined()
    expect(fetchHook).toHaveBeenCalledTimes(3)
  })

  it("preserves a debug FailureFuse halt without configured hooks", async () => {
    vi.stubEnv("CMB_AGENT_FAIL_FAST", "1")
    const { raw, entered, execute, finish } = await fixture()
    const execution = execute()
    const rejected = expect(execution).rejects.toBeInstanceOf(FailureFuseHaltError)
    await entered
    expect(raw.mock.calls[0][4]?.handoff).toBeUndefined()
    finish(37)
    await rejected
  })

  it("keeps async hooks with static result overrides in the foreground", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => respond({}))
    )
    const { raw, entered, execute, finish } = await fixture({
      hooks: [httpHook({ async: true, forcedOutcome: "always-halt", forcedReason: "static halt" })]
    })
    const execution = execute()
    const rejected = expect(execution).rejects.toMatchObject({ message: "static halt" })
    await entered
    expect(raw.mock.calls[0][4]?.handoff).toBeUndefined()
    finish()
    await rejected
  })

  it("runs async workspace hooks in the foreground when the worktree requires it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => respond({ continue: false, stopReason: "workspace halt" }))
    )
    const { raw, entered, execute, finish } = await fixture(
      { hooks: [httpHook({ async: true, hookSourceType: "workspace" })] },
      true
    )
    const execution = execute()
    const rejected = expect(execution).rejects.toMatchObject({ message: "workspace halt" })
    await entered
    expect(raw.mock.calls[0][4]?.handoff).toBeUndefined()
    finish()
    await rejected
  })
})
