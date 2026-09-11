import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AIMessage, SystemMessage, ToolMessage } from "@langchain/core/messages"
import {
  createAgent,
  createMiddleware,
  FakeToolCallingModel,
  MiddlewareError,
  ToolInvocationError,
  tool
} from "langchain"
import { z } from "zod"
import {
  ACTION_STATIONARITY_BLOCKING_POLL_HALT_THRESHOLD,
  ACTION_STATIONARITY_HALT_THRESHOLD,
  ACTION_STATIONARITY_NUDGE_THRESHOLD,
  ActionStationarityHaltError,
  actionStationaritySignature,
  areAgentLoopGuardsEnabled,
  clearActionStationarityState,
  clearActionStationarityTurn,
  createActionStationarityMiddleware,
  getActionStationarityHaltError
} from "./action-stationarity"

const TEST_OWNER_KEY = "cmb_subagent_owner_tool_call_id"

function toolResponse(name = "read_file", args: Record<string, unknown> = { file_path: "a.ts" }) {
  return new AIMessage({
    content: "",
    tool_calls: [{ id: `call-${Math.random()}`, name, args }]
  })
}

function request(
  threadId: string | undefined,
  systemMessage = new SystemMessage("base"),
  ownerId?: string
) {
  return {
    messages: [],
    systemMessage,
    runtime: {
      configurable: {
        ...(threadId ? { thread_id: threadId } : {}),
        ...(ownerId ? { [TEST_OWNER_KEY]: ownerId } : {})
      }
    }
  }
}

async function callMiddleware(
  middleware: ReturnType<typeof createActionStationarityMiddleware>,
  threadId: string | undefined,
  response: AIMessage,
  seenSystemPrompts?: string[],
  ownerId?: string
): Promise<AIMessage> {
  if (!middleware.wrapModelCall) throw new Error("missing wrapModelCall")
  return (await middleware.wrapModelCall(
    request(threadId, undefined, ownerId) as never,
    async (modelRequest) => {
      const systemMessage = (modelRequest as { systemMessage: SystemMessage }).systemMessage
      seenSystemPrompts?.push(String(systemMessage.content))
      return response
    }
  )) as AIMessage
}

describe("action stationarity", () => {
  beforeEach(() => clearActionStationarityState())
  afterEach(() => vi.restoreAllMocks())

  it("keeps guards enabled by default and supports an emergency disable switch", () => {
    expect(areAgentLoopGuardsEnabled(undefined)).toBe(true)
    for (const value of ["0", "false", "FALSE", "off", "no"]) {
      expect(areAgentLoopGuardsEnabled(value)).toBe(false)
    }
    expect(areAgentLoopGuardsEnabled("1")).toBe(true)
  })

  it("uses the whole ordered tool batch and canonical object keys for its signature", () => {
    const first = actionStationaritySignature([
      { name: "read_file", args: { limit: 10, file_path: "a.ts" } },
      { name: "grep", args: { pattern: "TODO" } }
    ])
    const same = actionStationaritySignature([
      { name: "read_file", args: { file_path: "a.ts", limit: 10 } },
      { name: "grep", args: { pattern: "TODO" } }
    ])
    const reordered = actionStationaritySignature([
      { name: "grep", args: { pattern: "TODO" } },
      { name: "read_file", args: { file_path: "a.ts", limit: 10 } }
    ])

    expect(first).toEqual(same)
    expect(first?.fingerprint).not.toBe(reordered?.fingerprint)
  })

  it("injects one nudge after eight identical calls and halts before the sixteenth executes", async () => {
    const middleware = createActionStationarityMiddleware()
    const prompts: string[] = []

    for (let i = 1; i <= ACTION_STATIONARITY_NUDGE_THRESHOLD; i += 1) {
      await callMiddleware(middleware, "thread-a", toolResponse(), prompts)
    }
    expect(prompts.at(-1)).toBe("base")

    await callMiddleware(middleware, "thread-a", toolResponse(), prompts)
    expect(prompts.at(-1)).toContain("base\n\n## Repeated Tool Call Guard")

    for (
      let i = ACTION_STATIONARITY_NUDGE_THRESHOLD + 2;
      i < ACTION_STATIONARITY_HALT_THRESHOLD;
      i += 1
    ) {
      await callMiddleware(middleware, "thread-a", toolResponse(), prompts)
    }

    await expect(
      callMiddleware(middleware, "thread-a", toolResponse(), prompts)
    ).rejects.toMatchObject({
      name: "ActionStationarityHaltError",
      decision: {
        action: "halt",
        count: ACTION_STATIONARITY_HALT_THRESHOLD,
        toolName: "read_file"
      }
    })
  })

  it("gives legitimate blocking task_output polling a higher halt threshold", async () => {
    const cases = [
      { task_id: "background-1" },
      { task_id: "background-2", block: true },
      { task_id: "background-3", timeout: 1000 },
      { task_id: "background-4", timeout: 600_000 }
    ]

    for (const [caseIndex, args] of cases.entries()) {
      const middleware = createActionStationarityMiddleware()
      const response = toolResponse("task_output", args)
      const prompts: string[] = []
      for (let index = 0; index < ACTION_STATIONARITY_HALT_THRESHOLD + 4; index += 1) {
        await expect(
          callMiddleware(middleware, `blocking-task-output-${caseIndex}`, response, prompts)
        ).resolves.toBeInstanceOf(AIMessage)
      }
      expect(prompts).toContainEqual(expect.stringContaining("阻塞式后台任务轮询"))
    }
  })

  it("eventually halts repeated blocking task_output polling", async () => {
    const middleware = createActionStationarityMiddleware()
    const response = toolResponse("task_output", { task_id: "background-1", timeout: 30_000 })

    for (let index = 1; index < ACTION_STATIONARITY_BLOCKING_POLL_HALT_THRESHOLD; index += 1) {
      await callMiddleware(middleware, "blocking-task-output-hard-limit", response)
    }

    await expect(
      callMiddleware(middleware, "blocking-task-output-hard-limit", response)
    ).rejects.toMatchObject({
      decision: {
        action: "halt",
        count: ACTION_STATIONARITY_BLOCKING_POLL_HALT_THRESHOLD,
        threshold: ACTION_STATIONARITY_BLOCKING_POLL_HALT_THRESHOLD,
        toolName: "task_output"
      }
    })
  })

  it("still halts fast or invalid task_output polling", async () => {
    const cases = [
      { task_id: "background-1", block: false },
      { task_id: "background-2", timeout: 0 },
      { task_id: "background-3", timeout: -1 },
      { task_id: "background-4", timeout: 600_001 },
      { task_id: "background-5", timeout: null },
      { task_id: "background-6", block: null },
      { task_id: "background-7", block: "false" },
      { task_id: "background-8", timeout: 1 },
      { task_id: "background-9", timeout: 100 },
      { task_id: "background-10", timeout: 999 }
    ]

    for (const [caseIndex, args] of cases.entries()) {
      const middleware = createActionStationarityMiddleware()
      const response = toolResponse("task_output", args)
      const threadId = `fast-task-output-${caseIndex}`
      for (let index = 1; index < ACTION_STATIONARITY_HALT_THRESHOLD; index += 1) {
        await callMiddleware(middleware, threadId, response)
      }
      await expect(callMiddleware(middleware, threadId, response)).rejects.toMatchObject({
        decision: {
          action: "halt",
          count: ACTION_STATIONARITY_HALT_THRESHOLD,
          toolName: "task_output"
        }
      })
    }
  })

  it("resets after a different call or a final response", async () => {
    const middleware = createActionStationarityMiddleware()
    for (let i = 0; i < ACTION_STATIONARITY_NUDGE_THRESHOLD - 1; i += 1) {
      await callMiddleware(middleware, "thread-a", toolResponse())
    }
    await callMiddleware(middleware, "thread-a", toolResponse("grep", { pattern: "x" }))
    await callMiddleware(middleware, "thread-a", new AIMessage("done"))

    const prompts: string[] = []
    await callMiddleware(middleware, "thread-a", toolResponse(), prompts)
    expect(prompts.at(-1)).toBe("base")
  })

  it("isolates concurrent task subagents that share a parent thread", async () => {
    const middleware = createActionStationarityMiddleware({
      turnId: "turn-a",
      ownerConfigKey: TEST_OWNER_KEY,
      requireOwner: true
    })
    for (let i = 0; i < ACTION_STATIONARITY_NUDGE_THRESHOLD; i += 1) {
      await callMiddleware(middleware, "parent-thread", toolResponse(), undefined, "task-a")
      await callMiddleware(middleware, "parent-thread", toolResponse(), undefined, "task-b")
    }

    const promptsA: string[] = []
    const promptsB: string[] = []
    await callMiddleware(middleware, "parent-thread", toolResponse(), promptsA, "task-a")
    await callMiddleware(middleware, "parent-thread", toolResponse(), promptsB, "task-b")
    expect(promptsA.at(-1)).toContain("Repeated Tool Call Guard")
    expect(promptsB.at(-1)).toContain("Repeated Tool Call Guard")
  })

  it("does not track an id-less task subagent when an owner is required", async () => {
    const middleware = createActionStationarityMiddleware({
      turnId: "turn-a",
      ownerConfigKey: TEST_OWNER_KEY,
      requireOwner: true
    })

    for (let i = 0; i < ACTION_STATIONARITY_HALT_THRESHOLD * 2; i += 1) {
      await expect(
        callMiddleware(middleware, "parent-thread", toolResponse())
      ).resolves.toBeInstanceOf(AIMessage)
    }
  })

  it("continues counting when the same logical turn rebuilds its middleware", async () => {
    const firstRuntime = createActionStationarityMiddleware({ turnId: "turn-a" })
    for (let i = 1; i < ACTION_STATIONARITY_HALT_THRESHOLD; i += 1) {
      await callMiddleware(firstRuntime, "thread-a", toolResponse())
    }

    const resumedRuntime = createActionStationarityMiddleware({ turnId: "turn-a" })
    await expect(callMiddleware(resumedRuntime, "thread-a", toolResponse())).rejects.toMatchObject({
      decision: { count: ACTION_STATIONARITY_HALT_THRESHOLD }
    })
  })

  it("keeps an explicit logical turn across a long approval wait and capacity pressure", async () => {
    let now = Date.parse("2026-08-02T00:00:00.000Z")
    vi.spyOn(Date, "now").mockImplementation(() => now)
    const firstRuntime = createActionStationarityMiddleware({ turnId: "turn-a" })
    for (let index = 0; index < ACTION_STATIONARITY_NUDGE_THRESHOLD; index += 1) {
      await callMiddleware(firstRuntime, "thread-a", toolResponse())
    }

    now += 11 * 60 * 1000
    const anonymousRuntime = createActionStationarityMiddleware()
    for (let index = 0; index < 1100; index += 1) {
      await callMiddleware(anonymousRuntime, `anonymous-thread-${index}`, toolResponse())
    }

    const resumedRuntime = createActionStationarityMiddleware({ turnId: "turn-a" })
    const prompts: string[] = []
    await callMiddleware(resumedRuntime, "thread-a", toolResponse(), prompts)
    expect(prompts.at(-1)).toContain("Repeated Tool Call Guard")
  })

  it("keeps a turn-id-only runtime instance-local and eligible for TTL cleanup", async () => {
    let now = Date.parse("2026-08-02T00:00:00.000Z")
    vi.spyOn(Date, "now").mockImplementation(() => now)
    const firstRuntime = createActionStationarityMiddleware({ turnId: "turn-a" })
    for (let index = 0; index < ACTION_STATIONARITY_NUDGE_THRESHOLD; index += 1) {
      await callMiddleware(firstRuntime, undefined, toolResponse())
    }

    const rebuiltRuntime = createActionStationarityMiddleware({ turnId: "turn-a" })
    const rebuiltPrompts: string[] = []
    await callMiddleware(rebuiltRuntime, undefined, toolResponse(), rebuiltPrompts)
    expect(rebuiltPrompts.at(-1)).toBe("base")

    now += 11 * 60 * 1000
    const expiredPrompts: string[] = []
    await callMiddleware(firstRuntime, undefined, toolResponse(), expiredPrompts)
    expect(expiredPrompts.at(-1)).toBe("base")
  })

  it("still expires anonymous instance-local state after the fallback TTL", async () => {
    let now = Date.parse("2026-08-02T00:00:00.000Z")
    vi.spyOn(Date, "now").mockImplementation(() => now)
    const middleware = createActionStationarityMiddleware()
    for (let index = 0; index < ACTION_STATIONARITY_NUDGE_THRESHOLD; index += 1) {
      await callMiddleware(middleware, "thread-a", toolResponse())
    }

    now += 11 * 60 * 1000
    const prompts: string[] = []
    await callMiddleware(middleware, "thread-a", toolResponse(), prompts)
    expect(prompts.at(-1)).toBe("base")
  })

  it("does not inherit counters across logical turns or unidentified runtime instances", async () => {
    const firstTurn = createActionStationarityMiddleware({ turnId: "turn-a" })
    for (let i = 1; i < ACTION_STATIONARITY_HALT_THRESHOLD; i += 1) {
      await callMiddleware(firstTurn, "thread-a", toolResponse())
    }

    const nextTurn = createActionStationarityMiddleware({ turnId: "turn-b" })
    await expect(callMiddleware(nextTurn, "thread-a", toolResponse())).resolves.toBeInstanceOf(
      AIMessage
    )

    const unidentifiedA = createActionStationarityMiddleware()
    const unidentifiedB = createActionStationarityMiddleware()
    for (let i = 1; i < ACTION_STATIONARITY_HALT_THRESHOLD; i += 1) {
      await callMiddleware(unidentifiedA, undefined, toolResponse())
    }
    await expect(callMiddleware(unidentifiedB, undefined, toolResponse())).resolves.toBeInstanceOf(
      AIMessage
    )
  })

  it("clears all parent and child scopes when a logical turn ends", async () => {
    const parent = createActionStationarityMiddleware({ turnId: "turn-a" })
    const child = createActionStationarityMiddleware({ turnId: "turn-a" })
    for (let i = 1; i < ACTION_STATIONARITY_HALT_THRESHOLD; i += 1) {
      await callMiddleware(parent, "thread-a", toolResponse())
      await callMiddleware(child, "thread-a__wf_run_a0", toolResponse())
    }

    clearActionStationarityTurn("thread-a", "turn-a")

    const resumedParent = createActionStationarityMiddleware({ turnId: "turn-a" })
    const resumedChild = createActionStationarityMiddleware({ turnId: "turn-a" })
    await expect(callMiddleware(resumedParent, "thread-a", toolResponse())).resolves.toBeInstanceOf(
      AIMessage
    )
    await expect(
      callMiddleware(resumedChild, "thread-a__wf_run_a0", toolResponse())
    ).resolves.toBeInstanceOf(AIMessage)
  })

  it("does not clear a detached background runtime with its own lifecycle", async () => {
    const backgroundTurnId = "thread-a__worker__implementer-1:turn:1"
    const background = createActionStationarityMiddleware({ turnId: backgroundTurnId })
    for (let i = 0; i < ACTION_STATIONARITY_NUDGE_THRESHOLD; i += 1) {
      await callMiddleware(background, "thread-a__worker__implementer-1", toolResponse())
    }

    clearActionStationarityTurn("thread-a", "foreground-turn")

    const prompts: string[] = []
    await callMiddleware(background, "thread-a__worker__implementer-1", toolResponse(), prompts)
    expect(prompts.at(-1)).toContain("Repeated Tool Call Guard")

    clearActionStationarityTurn("thread-a__worker__implementer-1", backgroundTurnId)
  })

  it("does not let a cleared in-flight request halt or delete a replacement state", async () => {
    const oldRuntime = createActionStationarityMiddleware({ turnId: "turn-a" })
    if (!oldRuntime.wrapModelCall) throw new Error("missing wrapModelCall")

    for (let index = 1; index < ACTION_STATIONARITY_HALT_THRESHOLD; index += 1) {
      await callMiddleware(oldRuntime, "thread-a", toolResponse())
    }

    let resolveOld: ((response: AIMessage) => void) | undefined
    const oldCall = oldRuntime.wrapModelCall(
      request("thread-a") as never,
      () =>
        new Promise<AIMessage>((resolve) => {
          resolveOld = resolve
        })
    )
    await Promise.resolve()

    clearActionStationarityTurn("thread-a", "turn-a")
    const replacementRuntime = createActionStationarityMiddleware({ turnId: "turn-a" })
    for (let index = 0; index < ACTION_STATIONARITY_NUDGE_THRESHOLD; index += 1) {
      await callMiddleware(replacementRuntime, "thread-a", toolResponse())
    }

    if (!resolveOld) throw new Error("old model request did not start")
    resolveOld(toolResponse())
    await expect(oldCall).resolves.toBeInstanceOf(AIMessage)

    const prompts: string[] = []
    await callMiddleware(replacementRuntime, "thread-a", toolResponse(), prompts)
    expect(prompts.at(-1)).toContain("Repeated Tool Call Guard")
  })

  it("fully hashes large strings and skips collections or nesting beyond the budget", () => {
    let nested: unknown = "leaf"
    for (let depth = 0; depth < 5000; depth += 1) nested = { value: nested }

    const largeTextA = `${"a".repeat(50_000)}A${"a".repeat(50_000)}`
    const largeTextB = `${"a".repeat(50_000)}B${"a".repeat(50_000)}`
    const largeA = actionStationaritySignature([{ name: "tool", args: { text: largeTextA } }])
    const largeB = actionStationaritySignature([{ name: "tool", args: { text: largeTextB } }])
    const oversizedArray = actionStationaritySignature([
      { name: "tool", args: { items: Array.from({ length: 41 }, (_, index) => index) } }
    ])
    const oversizedObject = actionStationaritySignature([
      {
        name: "tool",
        args: Object.fromEntries(Array.from({ length: 41 }, (_, index) => [`key-${index}`, index]))
      }
    ])
    const oversizedBatch = actionStationaritySignature(
      Array.from({ length: 129 }, () => ({ name: "tool", args: {} }))
    )
    const oversizedString = actionStationaritySignature([
      { name: "tool", args: { text: "x".repeat(1024 * 1024 + 1) } }
    ])
    const exactLimitString = actionStationaritySignature([
      { name: "tool", args: { text: "x".repeat(1024 * 1024) } }
    ])
    const oversizedUtf8String = actionStationaritySignature([
      { name: "tool", args: { text: "你".repeat(Math.floor((1024 * 1024) / 3) + 1) } }
    ])
    const oversizedBatchBytes = actionStationaritySignature([
      {
        name: "tool",
        args: Object.fromEntries(
          Array.from({ length: 5 }, (_, index) => [`part-${index}`, "x".repeat(900_000)])
        )
      }
    ])

    expect(actionStationaritySignature([{ name: "tool", args: nested }])).toBeNull()
    expect(largeA?.fingerprint).not.toBe(largeB?.fingerprint)
    expect(oversizedArray).toBeNull()
    expect(oversizedObject).toBeNull()
    expect(oversizedBatch).toBeNull()
    expect(oversizedString).toBeNull()
    expect(exactLimitString).not.toBeNull()
    expect(oversizedUtf8String).toBeNull()
    expect(oversizedBatchBytes).toBeNull()
  })

  it("does not evict a scope while its model request is in flight", async () => {
    const middleware = createActionStationarityMiddleware({ turnId: "turn-active" })
    if (!middleware.wrapModelCall) throw new Error("missing wrapModelCall")

    let resolveActive: ((response: AIMessage) => void) | undefined
    const activeCall = middleware.wrapModelCall(
      request("thread-active") as never,
      () =>
        new Promise<AIMessage>((resolve) => {
          resolveActive = resolve
        })
    )
    await Promise.resolve()

    for (let index = 0; index < 1100; index += 1) {
      await callMiddleware(middleware, `thread-${index}`, toolResponse())
    }

    if (!resolveActive) throw new Error("active model request did not start")
    resolveActive(toolResponse())
    await activeCall

    for (let index = 1; index < ACTION_STATIONARITY_NUDGE_THRESHOLD; index += 1) {
      await callMiddleware(middleware, "thread-active", toolResponse())
    }
    const prompts: string[] = []
    await callMiddleware(middleware, "thread-active", toolResponse(), prompts)
    expect(prompts.at(-1)).toContain("Repeated Tool Call Guard")
  })

  it("unwraps a halt error wrapped by LangChain middleware", () => {
    const halt = new ActionStationarityHaltError({
      action: "halt",
      fingerprint: "abc",
      count: 16,
      threshold: 16,
      reason: "repeated",
      toolName: "read_file"
    })
    const wrapped = MiddlewareError.wrap(halt, "actionStationarity")
    expect(getActionStationarityHaltError(wrapped)).toBe(halt)
  })

  it("unwraps a subagent halt nested in ToolInvocationError", () => {
    const halt = new ActionStationarityHaltError({
      action: "halt",
      fingerprint: "abc",
      count: 16,
      threshold: 16,
      reason: "repeated",
      toolName: "read_file"
    })
    const wrapped = MiddlewareError.wrap(halt, "actionStationarity")
    const taskFailure = new ToolInvocationError(wrapped, {
      id: "task-call",
      name: "task",
      args: { description: "run child agent" },
      type: "tool_call"
    })

    expect(getActionStationarityHaltError(taskFailure)).toBe(halt)
  })

  it("propagates a child-agent halt through a real parent task ToolNode", async () => {
    const readFileTool = tool(({ file_path }) => `read ${file_path}`, {
      name: "read_file",
      description: "Read a file in the child agent",
      schema: z.object({ file_path: z.string() })
    })
    const childCalls = Array.from({ length: ACTION_STATIONARITY_HALT_THRESHOLD }, (_, index) => [
      {
        id: `child-call-${index}`,
        name: "read_file",
        args: { file_path: "a.ts" }
      }
    ])
    const childAgent = createAgent({
      model: new FakeToolCallingModel({ toolCalls: childCalls }),
      tools: [readFileTool],
      middleware: [createActionStationarityMiddleware({ turnId: "child-turn" })]
    })
    const taskTool = tool(
      async () => {
        await childAgent.invoke(
          { messages: [{ role: "user", content: "read the file" }] },
          { configurable: { thread_id: "child-thread" }, recursionLimit: 100 }
        )
        return "child completed"
      },
      {
        name: "task",
        description: "Run a child agent",
        schema: z.object({ description: z.string() })
      }
    )
    const parentToolRecovery = createMiddleware({
      name: "parentToolRecovery",
      wrapToolCall: async (toolRequest, handler) => {
        try {
          return await handler(toolRequest)
        } catch (error) {
          if (getActionStationarityHaltError(error)) throw error
          return new ToolMessage({
            content: "recoverable tool error",
            tool_call_id: toolRequest.toolCall.id ?? "task-call",
            status: "error"
          })
        }
      }
    })
    const parentAgent = createAgent({
      model: new FakeToolCallingModel({
        toolCalls: [
          [
            {
              id: "task-call",
              name: "task",
              args: { description: "run child agent" }
            }
          ],
          []
        ]
      }),
      tools: [taskTool],
      middleware: [parentToolRecovery]
    })

    let thrown: unknown
    try {
      await parentAgent.invoke(
        { messages: [{ role: "user", content: "delegate the work" }] },
        { configurable: { thread_id: "parent-thread" }, recursionLimit: 150 }
      )
    } catch (error) {
      thrown = error
    }

    expect(getActionStationarityHaltError(thrown)?.decision).toMatchObject({
      action: "halt",
      count: ACTION_STATIONARITY_HALT_THRESHOLD,
      toolName: "read_file"
    })
  })

  it("halts repeated calls through a real LangChain agent middleware chain", async () => {
    const readFileTool = tool(({ file_path }) => `read ${file_path}`, {
      name: "read_file",
      description: "Read a file for the stationarity integration test",
      schema: z.object({ file_path: z.string() })
    })
    const repeatedCalls = Array.from({ length: ACTION_STATIONARITY_HALT_THRESHOLD }, (_, index) => [
      {
        id: `call-${index}`,
        name: "read_file",
        args: { file_path: "a.ts" }
      }
    ])
    const agent = createAgent({
      model: new FakeToolCallingModel({ toolCalls: repeatedCalls }),
      tools: [readFileTool],
      systemPrompt: "base",
      middleware: [createActionStationarityMiddleware({ turnId: "integration-turn" })]
    })

    let thrown: unknown
    try {
      await agent.invoke(
        { messages: [{ role: "user", content: "read the file" }] },
        { configurable: { thread_id: "integration-thread" }, recursionLimit: 100 }
      )
    } catch (error) {
      thrown = error
    }

    expect(getActionStationarityHaltError(thrown)?.decision).toMatchObject({
      action: "halt",
      count: ACTION_STATIONARITY_HALT_THRESHOLD,
      toolName: "read_file"
    })
  })
})
