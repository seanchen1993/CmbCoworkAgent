import { AIMessage, HumanMessage } from "@langchain/core/messages"
import { expect, it, vi } from "vitest"
import {
  ContextUsageObservation,
  currentCompactedContextStart,
  contextUsageStartIndex,
  readContextResponseUsage,
  readLiveContextUsage,
  projectContextUsage,
  projectContextBreakdown,
  withCompactedContext
} from "./context-usage"

const response = (tokens: number) =>
  new AIMessage({
    content: "actual",
    usage_metadata: { input_tokens: tokens, output_tokens: 2, total_tokens: tokens + 2 }
  })

it("isolates in-flight compaction windows and expires inherited callbacks after settlement", async () => {
  let finish!: () => void
  const done = new Promise<void>((resolve) => {
    finish = resolve
  })
  let late!: Promise<number | undefined>
  await withCompactedContext(3, async () => {
    expect(currentCompactedContextStart()).toBe(3)
    await withCompactedContext(7, async () => {
      expect(currentCompactedContextStart()).toBe(7)
    })
    expect(currentCompactedContextStart()).toBe(3)
    late = done.then(() => currentCompactedContextStart())
  })
  finish()
  expect(await late).toBeUndefined()
  expect(currentCompactedContextStart()).toBeUndefined()
  const values = await Promise.all(
    [3, 7].map((start) =>
      withCompactedContext(start, async () => {
        await Promise.resolve()
        return currentCompactedContextStart()
      })
    )
  )
  expect(values).toEqual([3, 7])
  await expect(
    withCompactedContext(9, async () => {
      throw Error("failed")
    })
  ).rejects.toThrow("failed")
  expect(currentCompactedContextStart()).toBeUndefined()
})

it("reads cache-inclusive context from actual normalized and durable provider responses", () => {
  const message = new AIMessage({
    content: "answer",
    usage_metadata: {
      input_tokens: 100,
      output_tokens: 4,
      total_tokens: 104,
      input_token_details: { cache_read: 60, cache_creation: 10 }
    }
  })
  const expected = {
    input_tokens: 30,
    output_tokens: 4,
    cache_read_input_tokens: 60,
    cache_creation_input_tokens: 10
  }
  expect(readContextResponseUsage(message)).toEqual(expected)
  expect(readContextResponseUsage(JSON.parse(JSON.stringify(message)))).toEqual(expected)
  expect(readContextResponseUsage({ type: "ai", response_metadata: { usage: expected } })).toEqual(
    expected
  )
  expect(projectContextUsage(256, expected)).toEqual({ window: 256, tokens: 100, percent: 39 })
  expect(
    readContextResponseUsage(
      new HumanMessage({ content: "usage", additional_kwargs: { usage_metadata: expected } })
    )
  ).toBeUndefined()
})

it("uses the last valid response, not cumulative or high-water tokens", async () => {
  const messages = [response(800), response(150), new AIMessage("usage unavailable")]
  const usage = await readLiveContextUsage(messages, {}, new AbortController().signal, () => {})
  expect(projectContextUsage(1000, usage)).toEqual({ window: 1000, tokens: 150, percent: 15 })
  const stream = new ContextUsageObservation(0)
  for (const message of messages) stream.push(message)
  expect(stream.snapshot()).toEqual(usage)
  stream.snapshot()!.input_tokens = 999
  expect(stream.snapshot()!.input_tokens).toBe(150)
})

it("excludes retained old responses after compaction and treats unknown legacy boundaries as unknown", async () => {
  const signal = new AbortController().signal
  const state = { _summarizationEvent: { cutoffIndex: 1, usageStartIndex: 3 } }
  const messages = [new HumanMessage("old"), response(800), new HumanMessage("kept")]
  expect(await readLiveContextUsage(messages, state, signal, () => {})).toBeUndefined()
  messages.push(response(50))
  expect(
    projectContextUsage(1000, await readLiveContextUsage(messages, state, signal, () => {}))
  ).toEqual({ window: 1000, tokens: 50, percent: 5 })
  expect(contextUsageStartIndex({ _summarizationEvent: { cutoffIndex: 1 } })).toBeUndefined()
  expect(
    await readLiveContextUsage(messages, { _summarizationEvent: {} }, signal, () => {})
  ).toBeUndefined()
})

it("omits unavailable and zero readings, clamps percentages and rejects invalid counters", () => {
  expect(projectContextUsage(1000)).toEqual({ window: 1000 })
  expect(projectContextUsage(1000, readContextResponseUsage(response(0)))).toEqual({ window: 1000 })
  expect(projectContextUsage(100, readContextResponseUsage(response(500)))).toEqual({
    window: 100,
    tokens: 500,
    percent: 100
  })
  for (const value of [-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    expect(readContextResponseUsage(response(value))).toBeUndefined()
    expect(() => projectContextUsage(value)).toThrow("CONTEXT_WINDOW_UNAVAILABLE")
  }
  expect(() => projectContextUsage(0)).toThrow("CONTEXT_WINDOW_UNAVAILABLE")
})

it("projects system, tools, messages, provider usage and a bounded grid without inventing dynamic sections", () => {
  const result = projectContextBreakdown({
    detail: "full",
    columns: 60,
    model: "actual-model",
    window: 1_000,
    systemMessage: "system instructions",
    tools: [{ name: "inspect", description: "Inspect a file", input_schema: {} }],
    messages: [
      new HumanMessage("read this"),
      new AIMessage({
        content: [{ type: "tool_use", id: "call-1", name: "inspect", input: {} }],
        usage_metadata: { input_tokens: 100, output_tokens: 4, total_tokens: 104 }
      })
    ],
    apiUsage: {
      input_tokens: 100,
      output_tokens: 4,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0
    }
  })
  expect(result.model).toBe("actual-model")
  expect(result.apiUsage?.input_tokens).toBe(100)
  expect(result.categories.map((category) => category.name)).toEqual(
    expect.arrayContaining(["System prompt", "System tools", "Messages", "Free space"])
  )
  expect(result.categories.some((category) => category.name === "MCP tools")).toBe(false)
  expect(result.messageBreakdown.toolCallTokens).toBeGreaterThan(0)
  expect(result.gridRows).toHaveLength(5)
  expect(result.gridRows[0]).toHaveLength(5)
})

it("keeps summary breakdowns cheap while full breakdowns use the detailed estimator", () => {
  const input = {
    columns: 80,
    model: "actual-model",
    window: 100_000,
    systemMessage: "system instructions ".repeat(40),
    tools: [{ name: "inspect", description: "Inspect a file ".repeat(40), input_schema: {} }],
    messages: [new HumanMessage("message payload ".repeat(40)), new AIMessage("assistant")]
  } as const
  const summary = projectContextBreakdown({ ...input, detail: "summary" })
  const full = projectContextBreakdown({ ...input, detail: "full" })
  expect(summary.totalTokens).not.toBe(full.totalTokens)
  expect(summary.estimated).toBe(true)
  expect(full.estimated).toBe(true)
})

it("attributes dynamic MCP, memory, skills and agent tools to separate context categories", () => {
  const result = projectContextBreakdown({
    detail: "full", model: "actual-model", window: 10_000,
    tools: ["mcp__search", "memory_write", "skill_loader", "task_agent"].map((name) => ({ name, description: name })),
    messages: []
  })
  expect(result.categories.map((category) => category.name)).toEqual(
    expect.arrayContaining(["MCP tools", "Memory", "Skills", "Agents"])
  )
})

it("returns the latest dynamic context breakdown lists with host supplied metadata", () => {
  const result = projectContextBreakdown({
    detail: "full",
    model: "actual-model",
    window: 10_000,
    tools: [{ name: "mcp__search", description: "search" }, { name: "task_agent", description: "agent" }],
    messages: [],
    contextSources: {
      memoryFiles: [{ path: "/workspace/MEMORY.md", type: "project", tokens: 12 }],
      agents: [{ agentType: "Explore", source: "built-in", tokens: 8 }],
      autoCompactThreshold: 8000,
      isAutoCompactEnabled: false
    }
  })
  expect(result.memoryFiles).toEqual([{ path: "/workspace/MEMORY.md", type: "project", tokens: 12 }])
  expect(result.mcpTools[0]).toMatchObject({ name: "mcp__search", isLoaded: true })
  expect(result.agents).toEqual(expect.arrayContaining([expect.objectContaining({ agentType: "Explore" }), expect.objectContaining({ agentType: "task_agent" })]))
  expect(result.autoCompactThreshold).toBe(8000)
  expect(result.isAutoCompactEnabled).toBe(false)
})

it("yields long scans and invalidates a revoked or cancelled in-flight read", async () => {
  const messages = Array.from({ length: 1000 }, () => new HumanMessage("no usage"))
  const controller = new AbortController()
  const current = vi.fn(() => {
    if (current.mock.calls.length > 1) throw Error("scope expired")
  })
  await expect(readLiveContextUsage(messages, {}, controller.signal, current)).rejects.toThrow(
    "scope expired"
  )
  controller.abort(Error("cancelled"))
  await expect(readLiveContextUsage(messages, {}, controller.signal, () => {})).rejects.toThrow(
    "cancelled"
  )
})
