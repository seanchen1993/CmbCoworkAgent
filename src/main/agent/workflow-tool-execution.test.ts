import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages"
import { afterEach, describe, expect, it, vi } from "vitest"

import { LocalSandbox } from "./local-sandbox"
import { foregroundCommandEvidence } from "./foreground-command-evidence"
import { createDeepAgent, getModelInstance } from "./runtime"
import { WORKFLOW_SUBAGENT_BASE_PROMPT } from "./workflow/prompts"

afterEach(() => vi.restoreAllMocks())

describe("workflow leaf tool execution", () => {
  it.each(["normal", "test failure", "ordinary thread", "hook rewrite", "hook block"] as const)(
    "records only the exact opted-in process exit (%s)", async mode => {
      const threadId = `foreground-${mode}`
      const sandbox = new LocalSandbox({ rootDir: process.cwd(), runId: threadId, windowsSandbox: "none" })
      const preHook = mode === "hook rewrite" ? { updatedInput: { command: "echo HOOK_REPLACED" } }
        : mode === "hook block" ? { blocked: true, stdout: "PRIVATE_HOOK_DIAGNOSTIC" } : null
      Reflect.set(sandbox, "runPreToolUseHook", async () => preHook)
      const command = mode === "test failure" ? "echo sandbox-test-failed; exit 7" : "echo EXACT_CHECK"
      const model = getModelInstance({ id: "test", model: "test-model", baseUrl: "https://example.test/v1", apiKey: "test" }, undefined, 1)
      let turns = 0
      vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
        const tool = turns++ === 0
        const delta = tool ? { tool_calls: [{ index: 0, id: "exact-exec", type: "function",
          function: { name: "execute", arguments: JSON.stringify({ command }) } }] } : { content: "Done" }
        const chunks = [delta, {}].map((part, index) => ({ id: `reply-${turns}`,
          object: "chat.completion.chunk", created: 1, model: "test-model", choices: [{ index: 0, delta: part,
            finish_reason: index === 0 ? null : tool ? "tool_calls" : "stop" }] }))
        return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } })
      })
      const agent = createDeepAgent({ threadId, model, backend: sandbox,
        mainSubagentsEnabled: false, mainTodosEnabled: false, includeGeneralPurposeSubagent: false })
      const record = vi.fn()
      const run = async () => {
        let messages: BaseMessage[] = []
        const stream = await agent.stream({ messages: [new HumanMessage("Check once")] },
          { streamMode: ["values", "messages"], recursionLimit: 12 })
        for await (const [mode, value] of stream) if (mode === "values") messages = value.messages
        return messages
      }
      const messages = mode === "ordinary thread" ? await run() : await foregroundCommandEvidence.run({
        threadId, begin: callId => evidence => record(callId, evidence)
      }, run)
      const tool = messages.find(message => ToolMessage.isInstance(message) && message.tool_call_id === "exact-exec")
      const expectedText = mode === "test failure" ? "sandbox-test-failed" : "EXACT_CHECK"
      expect(String(tool?.content)).toContain(mode === "hook rewrite" ? "HOOK_REPLACED"
        : mode === "hook block" ? "PRIVATE_HOOK_DIAGNOSTIC" : expectedText)
      if (mode === "normal" || mode === "test failure") {
        expect(record).toHaveBeenCalledExactlyOnceWith("exact-exec", {
          command, directory: ".", output: expect.stringContaining(expectedText), exitCode: mode === "test failure" ? 7 : 0,
          truncated: false
        })
      } else expect(record).not.toHaveBeenCalled()
    }
  )

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
  })
})
