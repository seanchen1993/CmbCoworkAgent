import { createServer, type Server } from "node:http"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  windows: [] as unknown[],
  send: vi.fn(),
  run: vi.fn<() => Promise<void>>()
}))

vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: () => mocks.windows } }))
vi.mock("../storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../storage")>()),
  getBuiltinRobotSettings: () => ({ enabled: false })
}))
vi.mock("./agent-bridge", () => ({
  apiGetThread: (id: string) => (id === "missing" ? null : { thread_id: id }),
  apiCreateThread: vi.fn(),
  apiGetThreadRuntime: vi.fn(),
  apiGetThreadMessages: vi.fn(),
  apiDecideThreadApproval: vi.fn(),
  apiCancelThread: (id: string) => cancelUserInputsForThread(id, "Cancelled") > 0,
  runApiAgentTurn: mocks.run
}))

import { createApiGatewayRequestHandler } from "./http-gateway"
import { createRequestUserInputTool } from "../agent/tools/user-input-tool"
import { forwardAgentStreamToSinks, hasAgentStreamSink } from "../agent/agent-stream-sinks"
import {
  cancelUserInputsForThread,
  getPendingUserInputForThread,
  requestUserInput,
  submitUserInputResponse
} from "../services/user-input"

const questions = [
  {
    id: "deploy_env",
    header: "环境",
    question: "部署到哪个环境？",
    options: [
      { label: "测试", description: "功能验证" },
      { label: "生产", description: "正式运行" }
    ]
  }
]

describe("HTTP user input", () => {
  let server: Server
  let origin: string
  const clients: AbortController[] = []

  beforeEach(async () => {
    mocks.send.mockClear()
    mocks.windows = []
    mocks.run.mockReset().mockResolvedValue(undefined)
    server = createServer(
      createApiGatewayRequestHandler({ enabled: true, host: "127.0.0.1", port: 0, token: "test" })
    )
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("No HTTP port")
    origin = `http://127.0.0.1:${address.port}`
  })

  afterEach(async () => {
    for (const client of clients.splice(0)) client.abort()
    cancelUserInputsForThread("thread-a", "Test cleanup")
    cancelUserInputsForThread("thread-b", "Test cleanup")
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  function post(path: string, body: unknown, token = "test") {
    return fetch(`${origin}/v1/threads/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body)
    })
  }

  function answer(requestId: string, body: unknown, threadId = "thread-a", token = "test") {
    return post(`${threadId}/user-input/${requestId}/response`, body, token)
  }

  async function openStream(format: string) {
    const client = new AbortController()
    clients.push(client)
    const response = await fetch(`${origin}/v1/threads/thread-a/messages?format=${format}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer test" },
      body: JSON.stringify({ message: "部署" }),
      signal: client.signal
    })
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let received = ""
    while (!received.includes("event: user_input_required\n")) {
      const part = await reader.read()
      if (part.done) throw new Error("Stream ended before the question")
      received += decoder.decode(part.value, { stream: true })
    }
    // The event may span several network reads.
    const start = received.indexOf("event: user_input_required\n")
    while (!received.slice(start).includes("\n\n")) {
      const part = await reader.read()
      if (part.done) throw new Error("Incomplete question event")
      received += decoder.decode(part.value, { stream: true })
    }
    const data = received.slice(start).split("\n")[1].slice("data: ".length)
    return { reader, event: JSON.parse(data), received }
  }

  it.each(["openai", "raw"])(
    "resumes the actual tool with identical HTTP and SSE results in %s format",
    async (format) => {
      // Simulate a desktop with no mounted question UI. It never acknowledges.
      mocks.windows = [
        { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: mocks.send } }
      ]
      mocks.run.mockImplementationOnce(async () => {
        const tool = createRequestUserInputTool({
          threadId: "thread-a",
          allowDeferredRenderer: false
        })
        const content = await tool.invoke({
          questions: questions.map((question) => ({
            ...question,
            options: [...question.options, { label: "Other", description: "自定义回答" }]
          })),
          autoResolutionMs: 30_000
        })
        forwardAgentStreamToSinks("thread-a", "agent:stream:thread-a", {
          type: "stream",
          mode: "messages",
          data: [
            { id: ["messages", "ToolMessage"], kwargs: { name: "request_user_input", content } },
            {}
          ]
        })
        forwardAgentStreamToSinks("thread-a", "agent:stream:thread-a", { type: "done" })
      })
      const { reader, event, received } = await openStream(format)
      expect(event).toEqual({
        thread_id: "thread-a",
        request_id: expect.any(String),
        questions,
        auto_resolution_ms: 30_000
      })
      const response = await answer(event.request_id, {
        answers: { deploy_env: { type: "option", optionIndex: 0, additionalText: "说明" } }
      })
      expect(response.status).toBe(200)
      const result = await response.json()
      expect(result).toEqual({
        status: "submitted",
        requestId: event.request_id,
        submittedAt: expect.stringMatching(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/),
        answers: {
          deploy_env: {
            type: "option",
            questionId: "deploy_env",
            optionIndex: 0,
            label: "测试",
            description: "功能验证",
            additionalText: "说明"
          }
        }
      })
      let rest = received
      const decoder = new TextDecoder()
      for (;;) {
        const part = await reader.read()
        if (part.done) break
        rest += decoder.decode(part.value, { stream: true })
      }
      const frames = rest.split("\n").filter((line) => line.startsWith("data: {"))
      const values = frames.map((line) => JSON.parse(line.slice(6)))
      const toolFrame = values.find((value) =>
        format === "openai" ? value.choices?.[0]?.delta?.role === "tool" : value.mode === "messages"
      )
      const content =
        format === "openai" ? toolFrame.choices[0].delta.content : toolFrame.data[0].kwargs.content
      expect(JSON.parse(content)).toEqual(result)
      expect(mocks.send).toHaveBeenCalledWith("userInput:cancel:thread-a", {
        requestId: event.request_id,
        reason: expect.any(String)
      })
      expect(hasAgentStreamSink("thread-a")).toBe(false)
      expect(getPendingUserInputForThread("thread-a")).toBeNull()
      expect((await answer(event.request_id, { answers: {} })).status).toBe(404)
    }
  )

  it("validates all answers without consuming the request and supports free text", async () => {
    const pending = requestUserInput({
      threadId: "thread-a",
      questions,
      allowDeferredRenderer: true
    })
    const requestId = getPendingUserInputForThread("thread-a")!.requestId
    const invalid = [
      { status: 400, body: { answers: [], extra: true } },
      { status: 400, body: { answers: { deploy_env: { type: "option", optionIndex: "0" } } } },
      {
        status: 400,
        body: { answers: { deploy_env: { type: "option", optionIndex: 0, label: "伪造" } } }
      },
      { status: 422, body: { answers: {} } },
      { status: 422, body: { answers: { unknown: { type: "other", text: "回答" } } } },
      { status: 422, body: { answers: { deploy_env: { type: "option", optionIndex: 3 } } } },
      { status: 422, body: { answers: { deploy_env: { type: "other", text: "  " } } } }
    ]
    for (const example of invalid) {
      expect((await answer(requestId, example.body)).status).toBe(example.status)
      expect(getPendingUserInputForThread("thread-a")?.requestId).toBe(requestId)
    }
    expect((await answer(requestId, { answers: {} }, "thread-a", "wrong")).status).toBe(401)
    expect((await answer(requestId, { answers: {} }, "thread-b")).status).toBe(404)
    expect((await answer(requestId, { answers: {} }, "missing")).status).toBe(404)
    const response = await answer(requestId, {
      answers: { deploy_env: { type: "other", text: "先出方案" } }
    })
    expect(response.status).toBe(200)
    const submitted = await pending
    expect((await response.json()).answers).toEqual(submitted.answers)
    expect(submitted.answers.deploy_env).toEqual({
      type: "other",
      questionId: "deploy_env",
      text: "先出方案"
    })
  })

  it("accepts only one concurrent answer, including a competing desktop answer", async () => {
    const pending = requestUserInput({
      threadId: "thread-a",
      questions,
      allowDeferredRenderer: true
    })
    const requestId = getPendingUserInputForThread("thread-a")!.requestId
    const body = { answers: { deploy_env: { type: "option", optionIndex: 1 } } }
    const responses = await Promise.all([answer(requestId, body), answer(requestId, body)])
    expect(responses.map((response) => response.status).sort()).toEqual([200, 404])
    await pending
    expect(submitUserInputResponse({ requestId, answers: {} })).toBe(false)
  })

  it("rejects malformed and oversized requests without consuming pending questions", async () => {
    const pending = requestUserInput({
      threadId: "thread-a",
      questions,
      allowDeferredRenderer: true
    })
    const requestId = getPendingUserInputForThread("thread-a")!.requestId
    for (const example of [
      { body: "{", status: 400, error: "invalid_json" },
      {
        body: JSON.stringify({ text: "x".repeat(1024 * 1024) }),
        status: 413,
        error: "payload_too_large"
      }
    ]) {
      const response = await fetch(
        `${origin}/v1/threads/thread-a/user-input/${requestId}/response`,
        {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer test" },
          body: example.body
        }
      )
      expect(response.status).toBe(example.status)
      expect(await response.json()).toMatchObject({ error: example.error })
      expect(getPendingUserInputForThread("thread-a")?.requestId).toBe(requestId)
    }
    submitUserInputResponse({ requestId, answers: {}, ignored: true })
    await pending
  })

  it("requires all questions and uses server-owned option text", async () => {
    const pending = requestUserInput({
      threadId: "thread-a",
      questions: [...questions, { ...questions[0], id: "confirm" }],
      allowDeferredRenderer: true
    })
    const requestId = getPendingUserInputForThread("thread-a")!.requestId
    expect(
      (await answer(requestId, { answers: { deploy_env: { type: "option", optionIndex: 0 } } }))
        .status
    ).toBe(422)
    const response = await answer(requestId, {
      answers: {
        deploy_env: { type: "option", optionIndex: 1 },
        confirm: { type: "other", text: "确认" }
      }
    })
    expect(response.status).toBe(200)
    expect((await pending).answers.deploy_env).toMatchObject({
      label: "生产",
      description: "正式运行"
    })
  })

  it("cancels pending questions when the SSE client disconnects", async () => {
    mocks.run.mockImplementationOnce(async () => {
      await requestUserInput({
        threadId: "thread-a",
        questions,
        allowDeferredRenderer: false
      }).catch(() => undefined)
    })
    const { reader, event } = await openStream("openai")
    await reader.cancel()
    await vi.waitFor(() => {
      expect(hasAgentStreamSink("thread-a")).toBe(false)
      expect(getPendingUserInputForThread("thread-a")).toBeNull()
    })
    expect((await answer(event.request_id, { answers: {} })).status).toBe(404)
  })
})
