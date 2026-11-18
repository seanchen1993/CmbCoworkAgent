import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { HookHaltError } from "../hooks/halt"
import type { HookConfig } from "../hooks/types"
import { FailureFuseHaltError } from "./failure-fuse"
import { withWorkspaceExecution } from "./file-operation-lock"
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
  const release = Promise.withResolvers<{
    exitCode: number | null
    output: string
    truncated: boolean
  }>()
  const finish = (exitCode: number | null = 0, output = "shell") =>
    release.resolve({ exitCode, output, truncated: false })
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
  return { root, sandbox, raw, entered: entered.promise, execute, finish }
}

function respond(data: unknown): Response {
  return new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } })
}

describe("shell monitor hook policy", () => {
  it.each(["PreToolUse", "PostToolUse"] as const)(
    "defers legacy %s command hooks while an automatically handed-off process owns the workspace",
    async (event) => {
      const hook: HookConfig = {
        id: "workspace-hook",
        enabled: true,
        event,
        type: "command",
        matcher: "^task_output$",
        command: "echo hook-ready",
        createdAt: "",
        updatedAt: ""
      }
      const onHookResult = vi.fn()
      const { root, sandbox, raw } = await fixture({ hooks: [hook], onHookResult })
      raw.mockRestore()
      await writeFile(
        path.join(root, "running.cjs"),
        [
          'const { existsSync } = require("node:fs")',
          'console.log("process-ready")',
          'const timer = setInterval(() => { if (existsSync("release")) clearInterval(timer) }, 20)'
        ].join("\n")
      )
      const task = await sandbox.executeForTool("node running.cjs", undefined, {
        backgroundAfterMs: 100
      })
      if (task.status !== "background") throw new Error(task.result.output)
      const [monitor, taskOutput] = createShellTaskMonitorTools(sandbox)
      const input = { task_id: task.taskId }
      try {
        await vi.waitFor(
          () => expect(sandbox.getTaskOutput(task.taskId)?.partialOutput).toContain("process-ready"),
          { timeout: 10_000 }
        )
        const results = await Promise.race([
          Promise.all([
            monitor.invoke({ ...input, block: false }),
            monitor.invoke({ ...input, block: true, timeout: 0 }),
            taskOutput.invoke({ ...input, timeout: 0 }),
            monitor.invoke({ ...input, timeout: 100 })
          ]),
          delay(2000, "monitor waited for the shell to exit")
        ])
        expect(results).toEqual(
          ["not_ready", "timeout", "timeout", "timeout"].map((retrieval_status) =>
            JSON.stringify({ retrieval_status, reason: "workspace_hook_busy" })
          )
        )
        expect(onHookResult).not.toHaveBeenCalled()
      } finally {
        await writeFile(path.join(root, "release"), "")
        await sandbox.waitForTaskOutput(task.taskId)
      }
      expect(onHookResult).not.toHaveBeenCalled()
      await expect(monitor.invoke({ ...input, block: false })).resolves.toContain(
        "[Command succeeded with exit code 0"
      )
      expect(onHookResult).toHaveBeenCalledExactlyOnceWith(event, hook, expect.anything())
    },
    25_000
  )

  it.each([37, null, 0])("reports terminal exit %s to the failure hook", async (exitCode) => {
    const hook = httpHook({ event: "PostToolUseFailure", matcher: "^monitor$" })
    const onHookResult = vi.fn()
    const fetchHook = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () =>
      respond({})
    )
    vi.stubGlobal("fetch", fetchHook)
    const { sandbox, finish } = await fixture({ hooks: [hook], onHookResult })
    const started = await sandbox.executeBackground("echo probe")
    const taskId = started.match(/\bid: (\w+)/)?.[1] ?? ""
    expect(taskId).not.toBe("")
    const outputMarker =
      exitCode === 0 ? "[Command failed with exit code 9]" : "[Command succeeded with exit code 0]"
    finish(exitCode, `${outputMarker}\nshell output`)

    const [monitor] = createShellTaskMonitorTools(sandbox)
    const result = await monitor.invoke({ task_id: taskId })
    const status = exitCode === 0 ? "succeeded" : "failed"
    expect(result).toContain(`[Command ${status} with exit code ${exitCode}, elapsed: `)

    if (exitCode === 0) {
      expect(fetchHook).not.toHaveBeenCalled()
      return
    }
    await vi.waitFor(() => {
      expect(onHookResult).toHaveBeenCalledWith("PostToolUseFailure", hook, expect.anything())
    })
    expect(fetchHook).toHaveBeenCalledOnce()
    const [, { body }] = fetchHook.mock.calls[0]
    expect(JSON.parse(String(body))).toMatchObject({
      tool_name: "monitor",
      tool_response: {
        failure_kind: "exit-nonzero",
        error: expect.stringContaining(`[Command failed with exit code ${exitCode}, elapsed: `)
      }
    })
  })

  it("keeps a detached command failure hook queued beyond a snapshot's deadline", async () => {
    const hook = httpHook({
      event: "PostToolUseFailure",
      matcher: "^task_output$",
      type: "command",
      command: "echo failure-reported"
    })
    const onHookResult = vi.fn()
    const { root, sandbox, finish } = await fixture({ hooks: [hook], onHookResult })
    const started = await sandbox.executeBackground("echo probe")
    const taskId = started.match(/\bid: (\w+)/)?.[1] ?? ""
    expect(taskId).not.toBe("")
    finish(1)
    await sandbox.waitForTaskOutput(taskId)

    const [monitor] = createShellTaskMonitorTools(sandbox)
    await withWorkspaceExecution(root, "write", async () => {
      await expect(monitor.invoke({ task_id: taskId, block: false })).resolves.toContain(
        "[Command failed with exit code 1"
      )
      await delay(100)
      expect(onHookResult).not.toHaveBeenCalled()
    })
    await vi.waitFor(() => {
      expect(onHookResult).toHaveBeenCalledWith("PostToolUseFailure", hook, expect.anything())
    })
  })

  it("reports Stop Shell as an interruption to current and later turns in fail-fast mode", async () => {
    vi.stubEnv("CMB_AGENT_FAIL_FAST", "1")
    const hook = httpHook({ event: "PostToolUseFailure", matcher: "^(monitor|task_output)$" })
    const fetchHook = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () =>
      respond({})
    )
    vi.stubGlobal("fetch", fetchHook)
    const { root, sandbox, raw } = await fixture({ hooks: [hook] })
    raw.mockRestore()
    await writeFile(
      path.join(root, "wait.cjs"),
      'console.log("shell-ready")\nsetInterval(() => {}, 1000)\n'
    )
    const started = await sandbox.executeBackground("node wait.cjs")
    const taskId = started.match(/\bid: (\w+)/)?.[1] ?? ""
    expect(taskId).not.toBe("")
    await vi.waitFor(
      () => expect(sandbox.getTaskOutput(taskId)?.partialOutput).toContain("shell-ready"),
      { timeout: 10_000 }
    )

    const [monitor] = createShellTaskMonitorTools(sandbox)
    const waitForOutput = vi.spyOn(sandbox, "waitForTaskOutput")
    const terminal = expect(monitor.invoke({ task_id: taskId })).resolves.toMatch(
      /^Task cancelled by user\.\n\[Command failed with exit code 130, elapsed: \d+s\]$/
    )
    await vi.waitFor(() => expect(waitForOutput).toHaveBeenCalledOnce())
    expect(LocalSandbox.cancelDetachedBackgroundTasks(sandbox.runId)).toBe(true)
    await terminal

    const laterTurn = new LocalSandbox({
      rootDir: root,
      runId: sandbox.runId,
      hookTurnId: "later-turn",
      windowsSandbox: "none",
      hooks: [hook]
    })
    const [, taskOutput] = createShellTaskMonitorTools(laterTurn)
    await expect(taskOutput.invoke({ task_id: taskId, block: false })).resolves.toContain(
      "[Command failed with exit code 130,"
    )

    await vi.waitFor(() => expect(fetchHook).toHaveBeenCalledTimes(2))
    const responses = fetchHook.mock.calls.map(([, { body }]) => JSON.parse(String(body)))
    for (const response of responses) {
      expect(response).toMatchObject({
        tool_name: "task_output",
        tool_response: { failure_kind: "abort", is_interrupt: true, is_timeout: false }
      })
    }
  }, 20_000)

  it("still treats a natural exit 130 as a failure even with identical output", async () => {
    vi.stubEnv("CMB_AGENT_FAIL_FAST", "1")
    const hook = httpHook({ event: "PostToolUseFailure", matcher: "^monitor$" })
    const fetchHook = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () =>
      respond({})
    )
    vi.stubGlobal("fetch", fetchHook)
    const { root, sandbox, raw } = await fixture({ hooks: [hook] })
    raw.mockRestore()
    await writeFile(
      path.join(root, "exit.cjs"),
      'process.stdout.write("Task cancelled by user.")\nprocess.exitCode = 130\n'
    )
    const started = await sandbox.executeBackground("node exit.cjs")
    const taskId = started.match(/\bid: (\w+)/)?.[1] ?? ""
    expect(taskId).not.toBe("")

    const [monitor] = createShellTaskMonitorTools(sandbox)
    await expect(monitor.invoke({ task_id: taskId })).rejects.toBeInstanceOf(FailureFuseHaltError)
    await vi.waitFor(() => expect(fetchHook).toHaveBeenCalledOnce())
    const [, { body }] = fetchHook.mock.calls[0]
    expect(JSON.parse(String(body))).toMatchObject({
      tool_name: "monitor",
      tool_response: {
        failure_kind: "exit-nonzero",
        error: expect.stringMatching(
          /^Task cancelled by user\.\n\[Command failed with exit code 130,/
        ),
        is_interrupt: false
      }
    })
  }, 20_000)

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
      { id: "PreToolUse-both", tool: "task_output", input },
      { id: "PreToolUse-broad", tool: "task_output", input },
      ...["legacy", "new", "both", "broad"].map((name) => ({
        id: `PostToolUse-${name}`,
        tool: name === "new" ? "monitor" : "task_output",
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

  it.each(["*", undefined])("keeps the legacy output policy for matcher %s", async (matcher) => {
    const hook = httpHook({ event: "PreToolUse", matcher })
    const { sandbox, finish } = await fixture({ hooks: [hook] })
    const fetchHook = vi.fn(async (_url: string, init: RequestInit) => {
      const payload = JSON.parse(String(init.body))
      return respond(
        payload.tool_name === "task_output"
          ? { decision: "block", reason: "Task output access denied" }
          : { decision: "approve" }
      )
    })
    vi.stubGlobal("fetch", fetchHook)

    const started = await sandbox.executeBackground("echo probe")
    const taskId = started.match(/\bid: (\w+)/)?.[1] ?? ""
    expect(taskId).not.toBe("")
    finish()
    await sandbox.waitForTaskOutput(taskId)
    fetchHook.mockClear()

    const tools = createShellTaskMonitorTools(sandbox)
    for (const tool of tools) {
      await expect(tool.invoke({ task_id: taskId })).resolves.toBe(
        "[Hook blocked] Task output access denied"
      )
    }
    expect(
      fetchHook.mock.calls.map(([, init]) => JSON.parse(String(init.body)).tool_name)
    ).toEqual(["task_output", "task_output"])
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
        matcher: "*",
        if: "monitor(*)",
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
