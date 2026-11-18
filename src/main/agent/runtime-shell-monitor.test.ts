import { execFileSync } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { BaseChatModel } from "@langchain/core/language_models/chat_models"
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages"
import type { ChatResult } from "@langchain/core/outputs"
import { tool } from "langchain"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"
import type { HookConfig } from "../hooks/types"
import type { ApprovalDecision, ApprovalRequest } from "../types"
import { ApprovalStore } from "./approval-store"
import { LocalSandbox, type LocalSandboxOptions } from "./local-sandbox"
import { getShellTaskOwnerId, SHELL_TASK_OWNER_CONFIG_KEY } from "./shell-monitor-tool"
import {
  cleanupChildRuntimeResources,
  createDeepAgent,
  createGradedToolConcurrencyMiddleware,
  createRuntimeToolDenylistMiddleware,
  wrapTaskToolWithOwnerMetadata
} from "./runtime"
import { ToolOrchestrator } from "./tool-orchestrator"

function testTool(name: string) {
  return tool(() => "", { name, description: name, schema: z.object({}) })
}

class ReplayModel extends BaseChatModel {
  constructor(private readonly reply: (messages: BaseMessage[]) => AIMessage) {
    super({})
  }

  _llmType(): string {
    return "shell-monitor-replay"
  }

  bindTools(tools: unknown[]): this {
    void tools
    return this
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const message = this.reply(messages)
    return { generations: [{ text: String(message.content), message }] }
  }
}

function requestTool(name: string, args: Record<string, unknown>): AIMessage {
  return requestTools([[name, args]])
}

function requestTools(calls: Array<[string, Record<string, unknown>]>): AIMessage {
  return new AIMessage({
    content: "",
    tool_calls: calls.map(([name, args]) => ({
      id: "call-" + name,
      type: "tool_call",
      name,
      args
    })),
    response_metadata: { finish_reason: "tool_calls" }
  })
}

const cleanup: Array<() => Promise<void>> = []

async function fixture(options: Partial<LocalSandboxOptions> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "cmb-runtime-shell-"))
  const sandbox = new LocalSandbox({
    rootDir: root,
    runId: root,
    windowsSandbox: "none",
    ...options
  })
  const physicalExit = Promise.withResolvers<void>()
  cleanup.push(async () => {
    physicalExit.resolve()
    await LocalSandbox.cancelBackgroundTasksAndWait(sandbox.runId)
    await rm(root, { recursive: true, force: true, maxRetries: 5 })
  })
  return { sandbox, physicalExit }
}

function watchTaskTermination(sandbox: LocalSandbox, physicalExit: Promise<void>) {
  const cancelled = vi.fn()
  vi.spyOn(sandbox, "executeRaw").mockImplementation(
    (command, _mode, _timeout, signal, opts) =>
      new Promise((resolve) => {
        signal?.addEventListener(
          "abort",
          () => {
            opts?.onTermination?.(physicalExit)
            cancelled(command)
            resolve({ output: "aborted", exitCode: 130, truncated: false })
          },
          { once: true }
        )
      })
  )
  return cancelled
}

beforeEach(() => vi.stubEnv("CMB_AGENT_FAIL_FAST", "0"))

afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe("shell monitor runtime dispatch", () => {
  it("waits for a child's physical shell exit before releasing runtime resources", async () => {
    const { sandbox, physicalExit } = await fixture({ shellParentThreadId: "parent" })
    const cancelled = watchTaskTermination(sandbox, physicalExit.promise)
    const revoke = vi.spyOn(LocalSandbox, "revokeGrantedAclsForRun").mockResolvedValue()
    try {
      await sandbox.executeBackground("echo child")

      const release = cleanupChildRuntimeResources(sandbox.runId)
      expect(cancelled).toHaveBeenCalledExactlyOnceWith("echo child")
      await vi.waitFor(() => expect(LocalSandbox.hasActiveBackgroundTasks(sandbox.runId)).toBe(true))
      expect(revoke).not.toHaveBeenCalled()

      physicalExit.resolve()
      await expect(release).resolves.toEqual([
        { status: "fulfilled", value: undefined },
        { status: "fulfilled", value: undefined }
      ])
      expect(revoke).toHaveBeenCalledExactlyOnceWith(sandbox.runId)
    } finally {
      revoke.mockRestore()
    }
  })

  it("preserves execute for a backend without shell task monitoring capabilities", async () => {
    const model = new ReplayModel((messages) => {
      const last = messages.at(-1)
      if (last?._getType() !== "tool") return requestTool("execute", { command: "echo probe" })
      expect(last.content).toBe("probe output\n[Command succeeded with exit code 0]")
      return new AIMessage({ content: "Finished", response_metadata: { finish_reason: "stop" } })
    })
    const bound = vi.spyOn(model, "bindTools")
    const execute = vi.fn(async () => ({ output: "probe output", exitCode: 0, truncated: false }))
    const agent = createDeepAgent({
      model,
      backend: { id: "legacy-sandbox", execute },
      mainTodosEnabled: false,
      mainSubagentsEnabled: false
    })
    await agent.invoke({ messages: [new HumanMessage("Run this probe")] })
    expect(execute).toHaveBeenCalledExactlyOnceWith("echo probe")
    const visibleTools = bound.mock.calls.flatMap(([tools]) => tools)
    expect(visibleTools).toContainEqual(expect.objectContaining({ name: "execute" }))
    expect(visibleTools).not.toContainEqual(expect.objectContaining({ name: "monitor" }))
    expect(visibleTools).not.toContainEqual(expect.objectContaining({ name: "task_output" }))
  })

  it.each([
    { mode: "explicit foreground", requestedBackground: false, runtime: {} },
    { mode: "managed session", requestedBackground: true, runtime: { managedExecution: true } },
    {
      mode: "monitor denied",
      requestedBackground: true,
      runtime: { mainBlockedToolNames: ["task_output"] }
    }
  ])(
    "returns the foreground result and current hooks in $mode",
    async ({ requestedBackground, runtime }) => {
      const postHooks: HookConfig[] = []
      const { sandbox, physicalExit } = await fixture({
        hookResolver: (event) => (event === "PostToolUse" ? postHooks : [])
      })
      const fetchHook = vi.fn(async () => Response.json({ additionalContext: "current policy" }))
      vi.stubGlobal("fetch", fetchHook)
      const rawEntered = Promise.withResolvers<void>()
      const raw = vi.spyOn(sandbox, "executeRaw").mockImplementation(async () => {
        rawEntered.resolve()
        await physicalExit.promise
        return { output: "probe finished", exitCode: 0, truncated: false }
      })
      const agent = createDeepAgent({
        ...runtime,
        model: new ReplayModel((messages) =>
          messages.at(-1)?._getType() === "tool"
            ? new AIMessage({ content: "Finished", response_metadata: { finish_reason: "stop" } })
            : requestTool("execute", {
                command: "echo probe",
                run_in_background: requestedBackground
              })
        ),
        backend: sandbox,
        mainTodosEnabled: false,
        mainSubagentsEnabled: false
      })
      const caller = new AbortController()
      const run = agent.invoke(
        { messages: [new HumanMessage("Run this probe")] },
        {
          signal: caller.signal
        }
      )
      try {
        await Promise.race([rawEntered.promise, run])
        expect(raw.mock.calls[0]?.[2]).toBeUndefined()
        expect(raw.mock.calls[0]?.[3]).toBeInstanceOf(AbortSignal)
        expect(raw.mock.calls[0]?.[4]).toMatchObject({ waitForProcessTree: true })
        expect(raw.mock.calls[0]?.[4]?.handoff).toBeUndefined()
        expect(LocalSandbox.hasActiveBackgroundTasks(sandbox.runId)).toBe(false)
        postHooks.push({
          id: "late-foreground-hook",
          enabled: true,
          event: "PostToolUse",
          matcher: "execute",
          type: "http",
          url: "https://hooks.invalid/current-policy",
          createdAt: "",
          updatedAt: ""
        })
      } finally {
        physicalExit.resolve()
      }
      const result = await run
      const output = result.messages.find((message: BaseMessage) => message._getType() === "tool")
      expect(output?.content).toBe(
        "probe finished\n\n[Hook context]\ncurrent policy\n[Command succeeded with exit code 0]"
      )
      expect(fetchHook).toHaveBeenCalledOnce()
    }
  )

  it("keeps a synchronous shell Hook halt in the originating graph turn", async () => {
    const { sandbox, physicalExit } = await fixture({
      hooks: [
        {
          id: "execute-stop",
          event: "PostToolUse",
          matcher: "execute",
          enabled: true,
          type: "http",
          url: "https://hooks.invalid/stop",
          createdAt: "",
          updatedAt: ""
        }
      ]
    })
    const fetchHook = vi.fn(async () =>
      Response.json({ continue: false, stopReason: "application hook stopped the turn" })
    )
    vi.stubGlobal("fetch", fetchHook)
    const rawEntered = Promise.withResolvers<void>()
    vi.spyOn(sandbox, "executeRaw").mockImplementation(async (_cmd, _mode, _ms, _signal, opts) => {
      const stop = opts?.handoff?.onSpawn()
      rawEntered.resolve()
      try {
        await physicalExit.promise
        return { output: "probe finished", exitCode: 0, truncated: false }
      } finally {
        stop?.()
      }
    })
    const executeForTool = sandbox.executeForTool.bind(sandbox)
    vi.spyOn(sandbox, "executeForTool").mockImplementation((command, cwd, options) =>
      executeForTool(command, cwd, { ...options, backgroundAfterMs: 1 })
    )

    const followingTool = vi.fn(() => "must not run")
    const modelReply = vi.fn((messages: BaseMessage[]) =>
      messages.at(-1)?._getType() === "tool"
        ? requestTool("later_tool", {})
        : requestTool("execute", { command: "echo probe" })
    )
    const agent = createDeepAgent({
      model: new ReplayModel(modelReply),
      backend: sandbox,
      mainTodosEnabled: false,
      mainSubagentsEnabled: false,
      tools: [tool(followingTool, { name: "later_tool", schema: z.object({}) })]
    })
    const run = agent.invoke({ messages: [new HumanMessage("Run this probe")] })
    const halted = expect(run).rejects.toMatchObject({
      name: "HookHaltError",
      message: "application hook stopped the turn"
    })
    await rawEntered.promise
    await delay(20)
    physicalExit.resolve()
    await halted
    expect(modelReply).toHaveBeenCalledOnce()
    expect(followingTool).not.toHaveBeenCalled()
    expect(fetchHook).toHaveBeenCalledOnce()
  })

  it("fences physical cleanup of a completed Solo invocation before the parent resumes", async () => {
    const { sandbox, physicalExit } = await fixture()
    const cancelled = watchTaskTermination(sandbox, physicalExit.promise)
    await sandbox.executeBackground("echo parent")
    await sandbox.executeBackground("echo sibling", undefined, "sibling-owner")

    const parentResumed = vi.fn()
    const agent = createDeepAgent({
      backend: sandbox,
      mainTodosEnabled: false,
      model: new ReplayModel((messages) => {
        const child = messages.some((message) => message.content === "Run in child")
        if (messages.at(-1)?._getType() !== "tool") {
          return child
            ? requestTool("execute", { command: "echo child", run_in_background: true })
            : requestTool("task", { description: "Run in child", subagent_type: "general-purpose" })
        }
        if (!child) parentResumed()
        return new AIMessage({ content: "Finished", response_metadata: { finish_reason: "stop" } })
      })
    })
    const run = agent.invoke({ messages: [new HumanMessage("Start a Solo task")] })
    void run.catch(() => {})
    try {
      await vi.waitFor(() => expect(cancelled.mock.calls).toEqual([["echo child"]]))
      expect(parentResumed).not.toHaveBeenCalled()
      expect(LocalSandbox.hasActiveBackgroundTasks(sandbox.runId)).toBe(true)
    } finally {
      physicalExit.resolve()
    }
    await run
    expect(parentResumed).toHaveBeenCalledOnce()
    expect(cancelled.mock.calls).toEqual([["echo child"]])
  })

  it.each([{}, { run_in_background: false }])(
    "cancels Solo Git approval for %j",
    async (input) => {
      const parent = new AbortController()
      const { sandbox } = await fixture({
        abortSignal: parent.signal,
        hooks: [
          {
            id: "monitor-stop",
            event: "PreToolUse",
            matcher: "monitor",
            enabled: true,
            type: "http",
            url: "https://hooks.invalid/stop",
            createdAt: "",
            updatedAt: ""
          }
        ]
      })
      vi.stubEnv("GIT_CONFIG_GLOBAL", path.join(sandbox.runId, "empty-git-config"))
      vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1")
      execFileSync("git", ["init", "--quiet", sandbox.runId])

      const approvalRequested = Promise.withResolvers<void>()
      const approval = Promise.withResolvers<ApprovalDecision>()
      const approvalCancelled = vi.fn()
      const requestApproval = vi.fn((request: ApprovalRequest, signal = parent.signal) => {
        approvalRequested.resolve()
        signal.addEventListener(
          "abort",
          () => {
            approvalCancelled()
            approval.resolve({ type: "reject", tool_call_id: request.id })
          },
          { once: true }
        )
        return approval.promise
      })
      vi.stubGlobal("fetch", async () => {
        await approvalRequested.promise
        return Response.json({ continue: false, stopReason: "monitor hook stopped the Solo task" })
      })
      const raw = vi.spyOn(sandbox, "executeRaw")
      sandbox.setOrchestrator(
        new ToolOrchestrator(
          new ApprovalStore(),
          (command, mode, cwd) => sandbox.executeRaw(command, mode, undefined, undefined, { cwd }),
          requestApproval
        )
      )

      const agent = createDeepAgent({
        backend: sandbox,
        mainTodosEnabled: false,
        model: new ReplayModel((messages) => {
          const last = messages.at(-1)
          if (last?.content === "Check in child") {
            return requestTools([
              ["execute", { command: "git push", ...input }],
              ["monitor", { task_id: "probe-id" }]
            ])
          }
          return requestTool("task", {
            description: "Check in child",
            subagent_type: "general-purpose"
          })
        })
      })
      const run = agent.invoke(
        { messages: [new HumanMessage("Start a Solo task")] },
        {
          signal: parent.signal
        }
      )
      const outcome = run.catch((error: unknown) => error)
      try {
        await vi.waitFor(() => expect(approvalCancelled).toHaveBeenCalledOnce(), { timeout: 3_000 })
        expect(await outcome).toMatchObject({
          name: "HookHaltError",
          message: "monitor hook stopped the Solo task"
        })
        expect(requestApproval).toHaveBeenCalledWith(
          expect.objectContaining({ operation: "git_push" }),
          expect.any(AbortSignal)
        )
        expect(parent.signal.aborted).toBe(false)
        expect(raw).not.toHaveBeenCalled()
      } finally {
        approvalRequested.resolve()
        approval.resolve({ type: "reject", tool_call_id: "cleanup" })
        parent.abort()
        await outcome
      }
    },
    10_000
  )

  it("waits for physical termination when cancelling a Git command that stays in the foreground", async () => {
    const { sandbox, physicalExit } = await fixture()
    const aborted = { output: "cancelled", exitCode: 130, truncated: false }
    const rawResult = Promise.withResolvers<typeof aborted>()
    const rawEntered = Promise.withResolvers<void>()
    const raw = vi
      .spyOn(sandbox, "executeRaw")
      .mockImplementation((_command, _mode, _timeout, signal, options) => {
        signal?.addEventListener(
          "abort",
          () => {
            options?.onTermination?.(physicalExit.promise)
            rawResult.resolve(aborted)
          },
          { once: true }
        )
        rawEntered.resolve()
        return rawResult.promise
      })
    const caller = new AbortController()
    const settled = vi.fn()
    const run = sandbox
      .executeForTool("git push", undefined, {
        backgroundAfterMs: 1,
        signal: caller.signal
      })
      .finally(settled)
    try {
      await rawEntered.promise
      expect(raw.mock.calls[0]?.[4]).toMatchObject({ waitForProcessTree: true })
      expect(raw.mock.calls[0]?.[4]?.handoff).toBeUndefined()
      caller.abort()
      await rawResult.promise
      await expect(LocalSandbox.cancelBackgroundTasksWithin(sandbox.runId, 10)).resolves.toBe(false)
      expect(settled).not.toHaveBeenCalled()
    } finally {
      rawResult.resolve(aborted)
      physicalExit.resolve()
      await run
    }
    await expect(run).resolves.toEqual({ status: "completed", result: aborted })
    await expect(LocalSandbox.cancelBackgroundTasksWithin(sandbox.runId, 10)).resolves.toBe(true)
  })

  it.each(["error", "abort"] as const)(
    "cleans up the invocation owner and waits for physical termination after %s",
    async (outcome) => {
      const { sandbox, physicalExit } = await fixture()
      const cancelled = watchTaskTermination(sandbox, physicalExit.promise)
      const started = Promise.withResolvers<void>()
      const abort = new AbortController()
      const error =
        outcome === "error"
          ? new Error("task failure")
          : new DOMException("cancelled", "AbortError")
      const delegate = tool(
        async (_input, config) => {
          const owner = getShellTaskOwnerId(config)
          if (!owner) throw new Error("Expected a private shell owner")
          await sandbox.executeBackground("echo child", undefined, owner, config?.signal)
          started.resolve()
          if (outcome === "error") throw error
          await delay(30_000, undefined, { signal: config?.signal })
        },
        { name: "task", description: "Task fixture", schema: z.object({}) }
      )
      const task = wrapTaskToolWithOwnerMetadata(delegate, undefined, undefined, (owner) =>
        LocalSandbox.cancelOwnedBackgroundTasksAndWait(sandbox.runId, owner)
      )
      const settled = vi.fn()
      const result = task.invoke({}, { signal: abort.signal }).finally(settled)
      void result.catch(() => {})
      try {
        await started.promise
        if (outcome === "abort") abort.abort(error)
        await vi.waitFor(() => expect(cancelled.mock.calls).toEqual([["echo child"]]))
        expect(settled).not.toHaveBeenCalled()
      } finally {
        physicalExit.resolve()
      }
      await expect(result).rejects.toBe(error)
    }
  )

  it("assigns private shell owners to distinct Task invocations with reused or missing IDs", async () => {
    const owners: Array<string | undefined> = []
    const metadata: Array<unknown> = []
    const delegatedTask = tool(
      (_input, config) => {
        owners.push(getShellTaskOwnerId(config))
        metadata.push(config?.metadata?.[SHELL_TASK_OWNER_CONFIG_KEY])
        return "ok"
      },
      { name: "task", description: "Task fixture", schema: z.object({}) }
    )
    const task = wrapTaskToolWithOwnerMetadata(delegatedTask)
    const reused = { type: "tool_call" as const, id: "reused", name: "task", args: {} }
    await task.invoke(reused)
    await task.invoke(reused)
    await task.invoke({})
    await task.invoke({})

    expect(owners).toEqual(Array(4).fill(expect.any(String)))
    expect(new Set(owners).size).toBe(4)
    expect(owners).not.toContain("reused")
    expect(metadata).toEqual(Array(4).fill(undefined))
  })

  it.each(["monitor", "task_output"])(
    "lets an exclusive tool progress while the built-in %s is waiting",
    async (name) => {
      const monitor = testTool(name)
      const exclusive = testTool("code_exec")
      const waiting = Promise.withResolvers<ToolMessage>()
      const entered = Promise.withResolvers<void>()
      const output = new ToolMessage({ content: "done", tool_call_id: "test" })
      const middleware = createGradedToolConcurrencyMiddleware(
        name + "-dispatch",
        new WeakSet([monitor])
      )
      const invoke = middleware.wrapToolCall!
      const request = (instance: typeof monitor) =>
        ({
          tool: instance,
          toolCall: { id: "test", name: instance.name, args: {} },
          state: { messages: [] },
          runtime: { signal: AbortSignal.timeout(1_000) }
        }) as unknown as Parameters<typeof invoke>[0]
      const pendingMonitor = invoke(request(monitor), async () => {
        entered.resolve()
        return waiting.promise
      })
      await entered.promise
      try {
        await expect(invoke(request(exclusive), () => output)).resolves.toBe(output)
      } finally {
        waiting.resolve(output)
        await pendingMonitor
      }
    }
  )

  it("keeps an unregistered tool with a monitor name under the tool lock", async () => {
    const builtin = testTool("monitor")
    const other = testTool("monitor")
    const output = new ToolMessage({ content: "done", tool_call_id: "test" })
    const waiting = Promise.withResolvers<ToolMessage>()
    const entered = Promise.withResolvers<void>()
    const middleware = createGradedToolConcurrencyMiddleware(
      "non-builtin-monitor-dispatch",
      new WeakSet([builtin])
    )
    const invoke = middleware.wrapToolCall!
    const request = (instance: typeof builtin) =>
      ({
        tool: instance,
        toolCall: { id: "test", name: instance.name, args: {} },
        state: { messages: [] },
        runtime: { signal: AbortSignal.timeout(1_000) }
      }) as unknown as Parameters<typeof invoke>[0]
    const exclusive = invoke(request(testTool("code_exec")), async () => {
      entered.resolve()
      return waiting.promise
    })
    await entered.promise
    const handler = vi.fn(() => output)
    const queued = invoke(request(other), handler)
    try {
      await Promise.resolve()
      expect(handler).not.toHaveBeenCalled()
    } finally {
      waiting.resolve(output)
      await exclusive
      await queued
    }
    expect(handler).toHaveBeenCalledOnce()
  })

  it.each(["monitor", "task_output"])(
    "hides and rejects both monitor aliases when %s is denied",
    async (denied) => {
      const middleware = createRuntimeToolDenylistMiddleware([denied])
      const handleTool = vi.fn()
      const invoke = middleware.wrapToolCall!
      for (const name of ["monitor", "task_output"]) {
        const request = { toolCall: { id: "monitor-call", name, args: {} } }
        const result = await invoke(request as Parameters<typeof invoke>[0], handleTool)
        expect(result).toMatchObject({ name, status: "error" })
      }
      expect(handleTool).not.toHaveBeenCalled()

      const tools = [testTool("monitor"), testTool("task_output"), testTool("execute")]
      const handleModel = vi.fn()
      const invokeModel = middleware.wrapModelCall!
      await invokeModel({ tools } as unknown as Parameters<typeof invokeModel>[0], handleModel)
      expect(handleModel.mock.calls[0][0].tools).toEqual([tools[2]])
    }
  )
})
