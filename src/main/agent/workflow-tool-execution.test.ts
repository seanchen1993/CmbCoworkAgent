import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages"
import { afterEach, describe, expect, it, vi } from "vitest"
import { LocalSandbox } from "./local-sandbox"
import { createDeepAgent, getModelInstance } from "./runtime"
import { WORKFLOW_SUBAGENT_BASE_PROMPT } from "./workflow/prompts"

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
