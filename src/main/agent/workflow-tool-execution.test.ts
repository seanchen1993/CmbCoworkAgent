import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages"
import { MemorySaver } from "@langchain/langgraph"
import { afterEach, describe, expect, it, vi } from "vitest"
import { LocalSandbox } from "./local-sandbox"
import { createDeepAgent, getModelInstance } from "./runtime"
import { WORKFLOW_SUBAGENT_BASE_PROMPT } from "./workflow/prompts"
import { runWorkflowSubagent, type WorkflowSubagentDeps } from "./workflow/subagent"

afterEach(() => vi.restoreAllMocks())

describe("workflow leaf tool execution", () => {
  it.each([
    { enableThinking: false, interleavedThinking: false },
    { enableThinking: true, interleavedThinking: false },
    { enableThinking: true, interleavedThinking: true }
  ])("executes role-less streamed calls with model settings %j", async (settings) => {
    const requests: Array<Record<string, unknown>> = []
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)))
      const deltas =
        requests.length === 1
          ? [
              { content: "Checking the cleanup script." },
              {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_cleanup",
                    type: "function",
                    function: { name: "execute", arguments: '{"command":"echo cleanup"}' }
                  }
                ]
              }
            ]
          : [{ content: "cleanup verified" }]
      const finishReason = requests.length === 1 ? "tool_calls" : "stop"
      const events = [...deltas, {}].map((delta, index) => ({
        id: `reply-${requests.length}`,
        object: "chat.completion.chunk",
        created: 1,
        model: "test-model",
        choices: [{ index: 0, delta, finish_reason: index === deltas.length ? finishReason : null }]
      }))
      return new Response(
        events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } }
      )
    })
    const backend = new LocalSandbox({ rootDir: process.cwd(), windowsSandbox: "none" })
    const execute = vi.spyOn(backend, "execute").mockResolvedValue({
      output: "cleanup finished",
      exitCode: 0,
      truncated: false
    })
    const model = getModelInstance(
      {
        id: "test",
        model: "test-model",
        baseUrl: "https://example.test/v1",
        apiKey: "test-key",
        ...settings
      },
      undefined,
      1
    )
    const agent = createDeepAgent({
      model,
      backend,
      systemPrompt: WORKFLOW_SUBAGENT_BASE_PROMPT,
      mainSubagentsEnabled: false,
      mainTodosEnabled: false,
      includeGeneralPurposeSubagent: false,
      summarizationTrigger: { type: "messages", value: 200 }
    })
    let messages: BaseMessage[] = []
    const stream = await agent.stream(
      { messages: [new HumanMessage("Run the cleanup script")] },
      {
        streamMode: ["values", "messages"],
        recursionLimit: 12
      }
    )
    for await (const [mode, value] of stream) {
      if (mode === "values") messages = value.messages
    }
    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute.mock.calls[0][0]).toBe("echo cleanup")
    expect(
      messages.some(
        (message) =>
          ToolMessage.isInstance(message) &&
          message.tool_call_id === "call_cleanup" &&
          String(message.content).includes("cleanup finished")
      )
    ).toBe(true)
    expect(messages.at(-1)).toMatchObject({ content: "cleanup verified" })
    expect(AIMessage.isInstance(messages.at(-1))).toBe(true)
    expect(requests).toHaveLength(2)
    for (const request of requests) {
      const tools = request.tools as Array<{ function: { name: string; description: string } }>
      const executeTool = tools.find((entry) => entry.function.name === "execute")
      expect(executeTool).toBeDefined()
      expect(executeTool!.function.description).not.toContain("isolated sandbox environment")
      const system = (request.messages as Array<{ role: string; content: unknown }>).find(
        (message) => message.role === "system"
      )
      expect(JSON.stringify(system?.content)).not.toContain("sandboxed environment")
      expect(JSON.stringify(system?.content)).toContain("## Execute Tool")
    }
  })
})

const cleanupSchema = {
  type: "object",
  properties: {
    success: { type: "boolean" },
    cleanedBatchIds: { type: "array", items: { type: "string" } },
    errors: { type: "array", items: { type: "string" } }
  },
  required: ["success", "cleanedBatchIds", "errors"],
  additionalProperties: false
}

type ModelSettings = { enableThinking: boolean; interleavedThinking: boolean }

async function runStructuredCleanup(
  options: {
    settings?: ModelSettings
    exitCode?: number
    textOnlyTurn?: number
    analysisOnly?: boolean
  } = {}
) {
  const { exitCode = 0, analysisOnly = false, textOnlyTurn } = options
  const structured = {
    success: exitCode === 0,
    cleanedBatchIds: exitCode === 0 ? ["batch-1"] : [],
    errors: exitCode === 0 ? [] : ["cleanup failed: permission denied"]
  }
  const requests: Array<Record<string, unknown>> = []
  const command = 'python "C:/plugins/cleanup.py" --workspace "D:/project"'
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
    const request = JSON.parse(String(init?.body))
    requests.push(request)
    const completed = request.messages.some(
      (message: { role: string; tool_call_id?: string }) =>
        message.role === "tool" && message.tool_call_id === "call_execute"
    )
    const isTextTurn = requests.length === textOnlyTurn
    const name = completed || analysisOnly ? "structured_output" : "execute"
    const args = name === "execute" ? { command } : structured
    // Leading text and role-less tool fragments reproduce the gateway pattern
    // through the actual workflow runner, including its structured-output stop.
    const deltas = isTextTurn
      ? [{ content: completed ? "Cleanup finished." : "I will check the cleanup script." }]
      : [
          { content: "" },
          {
            tool_calls: [
              {
                index: 0,
                id: `call_${name}`,
                type: "function",
                function: { name, arguments: JSON.stringify(args).slice(0, 8) }
              }
            ]
          },
          { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args).slice(8) } }] }
        ]
    const events = [...deltas, {}].map((delta, index) => ({
      id: `reply-${requests.length}`,
      object: "chat.completion.chunk",
      created: 1,
      model: "test-model",
      choices: [
        {
          index: 0,
          delta,
          finish_reason: index === deltas.length ? (isTextTurn ? "stop" : "tool_calls") : null
        }
      ]
    }))
    return new Response(
      events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } }
    )
  })
  const backend = new LocalSandbox({ rootDir: process.cwd(), windowsSandbox: "none" })
  const execute = vi.spyOn(backend, "execute").mockResolvedValue({
    output: JSON.stringify(structured),
    exitCode,
    truncated: false
  })
  const model = getModelInstance(
    {
      id: "test",
      model: "test-model",
      baseUrl: "https://example.test/v1",
      apiKey: "test-key",
      enableThinking: false,
      interleavedThinking: false,
      ...options.settings
    },
    undefined,
    1
  )
  const createRuntime = vi.fn<WorkflowSubagentDeps["createRuntime"]>(async (runtimeOptions) => {
    const agent = createDeepAgent({
      model,
      backend,
      checkpointer: new MemorySaver(),
      systemPrompt: runtimeOptions.extraSystemPrompt,
      tools: runtimeOptions.additionalTools,
      mainSubagentsEnabled: false,
      mainTodosEnabled: false,
      includeGeneralPurposeSubagent: false,
      summarizationTrigger: { type: "messages", value: 200 }
    })
    return {
      stream: (input, config) => agent.stream(input, config as Parameters<typeof agent.stream>[1])
    }
  })
  const result = await runWorkflowSubagent(
    {
      parentThreadId: "cleanup-parent",
      cleanupThread: async () => undefined,
      isRetryableApiError: () => false,
      createRuntime
    },
    {
      prompt: analysisOnly
        ? `Return this supplied result: ${JSON.stringify(structured)}`
        : `Run ${command} and return its actual result.`,
      schema: cleanupSchema,
      agentIndex: 0,
      label: "cleanup-regression",
      runId: "wf_cleanup_regression",
      signal: new AbortController().signal
    }
  )
  return { result, structured, execute, requests, createRuntime, command }
}

describe("workflow structured cleanup execution", () => {
  for (const settings of [
    { enableThinking: false, interleavedThinking: false },
    { enableThinking: true, interleavedThinking: false },
    { enableThinking: true, interleavedThinking: true }
  ]) {
    it.each([0, 1])(
      `returns the actual exit %i result without retries with ${JSON.stringify(settings)}`,
      async (exitCode) => {
        const run = await runStructuredCleanup({ settings, exitCode })
        expect(run.result.structured).toEqual(run.structured)
        expect(run.execute).toHaveBeenCalledTimes(1)
        expect(run.execute.mock.calls[0][0]).toBe(run.command)
        expect(run.createRuntime).toHaveBeenCalledTimes(1)
        expect(run.requests).toHaveLength(2)
        const messages = run.requests[1].messages as Array<Record<string, unknown>>
        expect(messages.find((message) => message.tool_call_id === "call_execute")).toMatchObject({
          role: "tool",
          content: expect.stringContaining(JSON.stringify(run.structured))
        })
      }
    )
  }

  it("allows a supplied result without requiring shell execution or another model turn", async () => {
    const run = await runStructuredCleanup({ analysisOnly: true, exitCode: 1 })
    expect(run.result.structured).toEqual(run.structured)
    expect(run.execute).not.toHaveBeenCalled()
    expect(run.createRuntime).toHaveBeenCalledTimes(1)
    expect(run.requests).toHaveLength(1)
  })

  it.each([1, 2])(
    "preserves execution and results when turn %i needs the existing nudge",
    async (textOnlyTurn) => {
      const run = await runStructuredCleanup({ textOnlyTurn })
      expect(run.result.structured).toEqual(run.structured)
      expect(run.execute).toHaveBeenCalledTimes(1)
      expect(run.createRuntime).toHaveBeenCalledTimes(1)
      expect(run.requests).toHaveLength(3)
      const messages = run.requests[textOnlyTurn].messages as Array<Record<string, unknown>>
      expect(messages.at(-1)).toMatchObject({
        role: "user",
        content: expect.stringContaining("structured_output")
      })
    }
  )
})
