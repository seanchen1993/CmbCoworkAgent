import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { AIMessageChunk, HumanMessage } from "@langchain/core/messages"
import { ChatOpenAI } from "@langchain/openai"
import { describe, expect, it, vi } from "vitest"
import type { ProjectAgentRunEvent } from "../../../shared/project-agent-run"
import { streamProjectModel } from "./model-stream"
import { createProjectRunReporter } from "./run-progress"

describe("project Agent streaming transport", () => {
  it("requests real SSE and delivers answer text before the model response completes", async () => {
    let release!: () => void
    let sawFirst!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const first = new Promise<void>((resolve) => {
      sawFirst = resolve
    })
    let body: Record<string, unknown> = {}
    const server = createServer(async (request, response) => {
      let input = ""
      for await (const chunk of request) input += chunk.toString()
      body = JSON.parse(input)
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" })
      const send = (text: string, end = false) =>
        response.write(
          `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: "test-model", choices: [{ index: 0, delta: { content: text }, finish_reason: end ? "stop" : null }] })}\n\n`
        )
      send("先收到第一段。")
      await gate
      send("再收到第二段。", true)
      response.end("data: [DONE]\n\n")
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const events: ProjectAgentRunEvent[] = []
    try {
      const model = new ChatOpenAI({
        model: "test-model",
        apiKey: "local-test",
        configuration: { baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1` },
        maxRetries: 0,
        streamUsage: false
      })
      const invoke = vi.spyOn(model, "invoke")
      let finished = false
      const result = streamProjectModel(
        model,
        [new HumanMessage("分析")],
        new AbortController().signal,
        createProjectRunReporter((event) => {
          events.push(event)
          if (event.type === "text" && event.text.includes("第一段")) sawFirst()
        }),
        "模型分析",
        true
      ).then((value) => {
        finished = true
        return value
      })
      await first
      expect(body.stream).toBe(true)
      expect(finished).toBe(false)
      release()
      expect((await result).content).toBe("先收到第一段。再收到第二段。")
      expect(invoke).not.toHaveBeenCalled()
      expect(
        events
          .filter((event) => event.type === "text" && !event.reset)
          .map((event) => (event.type === "text" ? event.text : ""))
          .join("")
      ).toBe("先收到第一段。再收到第二段。")
    } finally {
      release()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }, 10000)
  it.each([true, false])(
    "assembles fragmented tool arguments (provider supplies ID: %s) without exposing reasoning",
    async (suppliesId) => {
      const events: ProjectAgentRunEvent[] = []
      const model = {
        stream: async () =>
          (async function* () {
            yield new AIMessageChunk({
              content: "",
              additional_kwargs: { reasoning_content: "private-reasoning" },
              tool_call_chunks: [
                {
                  ...(suppliesId ? { id: "call-1" } : {}),
                  name: "project_analysis",
                  args: '{"view":',
                  index: 0,
                  type: "tool_call_chunk"
                }
              ]
            })
            yield new AIMessageChunk({
              content: "",
              tool_call_chunks: [{ args: '"overview"}', index: 0, type: "tool_call_chunk" }]
            })
          })()
      }
      const result = await streamProjectModel(
        model,
        [],
        new AbortController().signal,
        createProjectRunReporter((event) => events.push(event)),
        "流式工具选择",
        true
      )
      expect(result.tool_calls).toEqual([
        {
          id: suppliesId ? "call-1" : "project-step-1-0",
          name: "project_analysis",
          args: { view: "overview" },
          type: "tool_call"
        }
      ])
      expect(JSON.stringify(events)).not.toContain("private-reasoning")
    }
  )
  it("never falls back to invoke on streaming failure and stops consuming after cancellation", async () => {
    const invoke = vi.fn()
    const failure = {
      invoke,
      stream: vi.fn(async () => {
        throw Object.assign(new Error("stream unsupported"), { status: 400 })
      })
    }
    await expect(
      streamProjectModel(
        failure,
        [],
        new AbortController().signal,
        createProjectRunReporter(),
        "流式请求"
      )
    ).rejects.toThrow("unsupported")
    expect(invoke).not.toHaveBeenCalled()
    const controller = new AbortController()
    const events: ProjectAgentRunEvent[] = []
    const partial = {
      stream: async () =>
        (async function* () {
          yield new AIMessageChunk("已接收")
          controller.abort()
          yield new AIMessageChunk("迟到文本")
        })()
    }
    await expect(
      streamProjectModel(
        partial,
        [],
        controller.signal,
        createProjectRunReporter((event) => events.push(event)),
        "取消",
        true
      )
    ).rejects.toThrow()
    expect(JSON.stringify(events)).toContain("已接收")
    expect(JSON.stringify(events)).not.toContain("迟到文本")
  })
})
