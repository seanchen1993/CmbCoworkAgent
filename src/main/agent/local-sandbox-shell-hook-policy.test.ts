import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { HookHaltError } from "../hooks/halt"
import type { HookConfig } from "../hooks/types"
import { FailureFuseHaltError } from "./failure-fuse"
import { LocalSandbox, type LocalSandboxOptions } from "./local-sandbox"
import { createShellTaskMonitorTools } from "./shell-monitor-tool"

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

describe("shell monitor hook policy", () => {
  it("matches each tool name in configured order and applies each hook exactly once", async () => {
    const hooks = (["PreToolUse", "PostToolUse"] as const).flatMap((event) =>
      [
        ["legacy", "^task_output$"],
        ["new", "^monitor$"],
        ["both", "^(monitor|task_output)$"],
        ["broad", "*"]
      ].map(([name, matcher]) => {
        const id = `${event}-${name}`
        return httpHook({ id, event, matcher, url: `https://hooks.invalid/${id}` })
      })
    )
    const onHookResult = vi.fn()
    let hooksEnabled = false
    const { sandbox, finish } = await fixture({
      hookResolver: () => (hooksEnabled ? hooks : []),
      onHookResult
    })
    const started = await sandbox.executeBackground("echo probe")
    const taskId = started.match(/\bid: (\w+)/)?.[1] ?? ""
    expect(taskId).not.toBe("")
    finish()
    await sandbox.waitForTaskOutput(taskId)

    const calls: Array<{
      id: string
      tool: string
      input: { task_id: string; block?: boolean; timeout?: number }
    }> = []
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      const id = new URL(url).pathname.slice(1)
      const { tool_name, tool_input } = JSON.parse(String(init.body))
      calls.push({ id, tool: tool_name, input: tool_input })
      if (id === "PreToolUse-legacy") return respond({ updatedInput: { task_id: taskId } })
      if (id === "PreToolUse-new") return respond({ updatedInput: { block: true, timeout: 10 } })
      if (id === "PreToolUse-both") return respond({ updatedInput: { timeout: 20 } })
      return respond({ additionalContext: id })
    })
    hooksEnabled = true

    const [monitor, taskOutput] = createShellTaskMonitorTools(sandbox)
    const input = { task_id: "placeholder", block: false }
    const monitorOutput = await monitor.invoke(input)
    expect(monitorOutput).toMatch(/^shell\n\[Command succeeded with exit code 0/)
    expect(monitorOutput.split("\n\n").at(-1)).toBe(
      "[Hook context]\nPostToolUse-legacy\nPostToolUse-new\nPostToolUse-both\nPostToolUse-broad"
    )
    expect(calls).toEqual([
      { id: "PreToolUse-legacy", tool: "task_output", input },
      { id: "PreToolUse-new", tool: "monitor", input },
      { id: "PreToolUse-both", tool: "monitor", input },
      { id: "PreToolUse-broad", tool: "monitor", input },
      ...["legacy", "new", "both", "broad"].map((name) => ({
        id: `PostToolUse-${name}`,
        tool: name === "legacy" ? "task_output" : "monitor",
        input: { task_id: taskId, block: true, timeout: 20 }
      }))
    ])
    expect(onHookResult.mock.calls.map(([, hook]) => hook.id)).toEqual(calls.map(({ id }) => id))
    onHookResult.mockClear()
    calls.length = 0

    const legacyOutput = await taskOutput.invoke(input)
    expect(legacyOutput).toMatch(/^shell\n\[Command succeeded with exit code 0/)
    expect(legacyOutput.split("\n\n").at(-1)).toBe(
      "[Hook context]\nPostToolUse-legacy\nPostToolUse-both\nPostToolUse-broad"
    )
    expect(calls).toEqual([
      ...["legacy", "both", "broad"].map((name) => ({
        id: `PreToolUse-${name}`,
        tool: "task_output",
        input
      })),
      ...["legacy", "both", "broad"].map((name) => ({
        id: `PostToolUse-${name}`,
        tool: "task_output",
        input: { task_id: taskId, block: false, timeout: 20 }
      }))
    ])
    expect(onHookResult.mock.calls.map(([, hook]) => hook.id)).toEqual(calls.map(({ id }) => id))
  })

  it("honors a legacy input condition and a monitor-specific block or halt", async () => {
    const hooks = [
      httpHook({
        id: "monitor-pre",
        event: "PreToolUse",
        matcher: "^monitor$",
        url: "https://hooks.invalid/pre"
      }),
      httpHook({
        matcher: "*",
        if: "task_output(*)",
        url: "https://hooks.invalid/legacy-post"
      }),
      httpHook({
        id: "monitor-post",
        matcher: "^monitor$",
        url: "https://hooks.invalid/post"
      })
    ]
    const { sandbox } = await fixture({ hooks })
    const [monitor] = createShellTaskMonitorTools(sandbox)
    let block = true
    const fetchHook = vi.fn(async (url: string, init: RequestInit) => {
      const { tool_name } = JSON.parse(String(init.body))
      if (url.endsWith("/pre") && block) {
        return respond({ decision: "block", reason: `blocked ${tool_name}` })
      }
      return respond(
        url.endsWith("/post")
          ? { continue: false, stopReason: `halted ${tool_name}` }
          : { additionalContext: tool_name }
      )
    })
    vi.stubGlobal("fetch", fetchHook)

    await expect(monitor.invoke({ task_id: "missing" })).resolves.toBe(
      "[Hook blocked] blocked monitor"
    )
    expect(fetchHook).toHaveBeenCalledTimes(1)

    block = false
    await expect(monitor.invoke({ task_id: "missing" })).rejects.toMatchObject({
      name: "HookHaltError",
      message: "halted monitor"
    })
    expect(
      fetchHook.mock.calls.map(([url, init]) => [
        new URL(url).pathname,
        JSON.parse(String(init.body)).tool_name
      ])
    ).toEqual([
      ["/pre", "monitor"],
      ["/pre", "monitor"],
      ["/legacy-post", "task_output"],
      ["/post", "monitor"]
    ])
  })
})

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
