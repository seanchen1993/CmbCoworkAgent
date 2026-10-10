import { createServer, type Server } from "http"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const bridge = vi.hoisted(() => {
  const consumed = new Set<string>()
  return {
    consumed,
    apiCreateThread: vi.fn(),
    apiCancelThread: vi.fn(),
    runApiAgentTurn: vi.fn<() => Promise<void>>(),
    apiGetThread: vi.fn((threadId: string) =>
      threadId === "thread-a" || threadId === "thread-b"
        ? { thread_id: threadId, status: "idle" }
        : null
    ),
    apiGetThreadRuntime: vi.fn(() => ({ state: "finished" })),
    apiDecideThreadApproval: vi.fn(
      (threadId: string, approvalId: string, action: "approve" | "reject") => {
        if (approvalId === "foreign") {
          return {
            accepted: false as const,
            status: 409,
            error: "approval_thread_mismatch",
            message: "审批不属于指定会话"
          }
        }
        if (consumed.has(approvalId)) {
          return {
            accepted: false as const,
            status: 404,
            error: "approval_not_found",
            message: "审批不存在、已处理或已失效"
          }
        }
        consumed.add(approvalId)
        return {
          accepted: true as const,
          thread_id: threadId,
          approval_id: approvalId,
          action
        }
      }
    )
  }
})

vi.mock("./agent-bridge", () => ({
  apiCreateThread: bridge.apiCreateThread,
  apiGetThread: bridge.apiGetThread,
  apiGetThreadRuntime: bridge.apiGetThreadRuntime,
  apiGetThreadMessages: vi.fn(),
  apiCancelThread: bridge.apiCancelThread,
  apiDecideThreadApproval: bridge.apiDecideThreadApproval,
  runApiAgentTurn: bridge.runApiAgentTurn
}))

import { createApiGatewayRequestHandler } from "./http-gateway"
import { forwardAgentStreamToSinks, hasAgentStreamSink } from "../agent/agent-stream-sinks"
import { WorkspaceValidationError } from "../services/workspace-validation"
import type { ApiGatewayConfig } from "./config"

const config = (token = ""): ApiGatewayConfig => ({
  enabled: true,
  host: "127.0.0.1",
  port: 0,
  token
})

describe("HTTP message SSE lifecycle", () => {
  let server: Server | null = null
  let origin = ""
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const clients = new Set<AbortController>()

  beforeEach(async () => {
    bridge.apiCancelThread.mockReset()
    bridge.runApiAgentTurn.mockReset().mockResolvedValue(undefined)
    const listening = await listen()
    server = listening.server
    origin = listening.origin
  })

  afterEach(async () => {
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
    for (const client of clients) client.abort()
    clients.clear()
    server?.closeAllConnections()
    if (server) await close(server)
    server = null
  })

  function later(callback: () => void): void {
    timers.add(setTimeout(callback, 30))
  }

  function emit(payload: unknown): void {
    forwardAgentStreamToSinks("thread-a", "agent:stream:thread-a", payload)
  }

  function send(format: "openai" | "raw"): Promise<Response> {
    const client = new AbortController()
    clients.add(client)
    const deadline = setTimeout(() => client.abort(), 2000)
    timers.add(deadline)
    return fetch(`${origin}/v1/threads/thread-a/messages?format=${format}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({ message: "hello" }),
      signal: client.signal
    })
  }

  it.each([
    { format: "openai" as const, lateRequestClose: false },
    { format: "raw" as const, lateRequestClose: false },
    { format: "openai" as const, lateRequestClose: true },
    { format: "raw" as const, lateRequestClose: true }
  ])(
    "keeps $format open after POST completion (late request close: $lateRequestClose)",
    async ({ format, lateRequestClose }) => {
      if (lateRequestClose) {
        // Request completion may be observed after the route's await resumes.
        // It must not be confused with disconnecting the still-open response.
        server!.on("request", (request) => {
          request.on("end", () => queueMicrotask(() => request.emit("close")))
        })
      }
      bridge.runApiAgentTurn.mockImplementationOnce(async () => {
        later(() => {
          emit({
            type: "stream",
            mode: "messages",
            data: [
              {
                id: ["langchain_core", "messages", "AIMessageChunk"],
                kwargs: { content: "delayed answer" }
              },
              { ls_model_name: "test-model" }
            ]
          })
          emit({ type: "done" })
        })
      })

      const response = await send(format)
      const body = await response.text()
      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toContain("text/event-stream")
      expect(body).toContain("delayed answer")
      expect(body).toContain(format === "openai" ? "data: [DONE]" : '"type":"done"')
      expect(bridge.apiCancelThread).not.toHaveBeenCalled()
      expect(hasAgentStreamSink("thread-a")).toBe(false)
    }
  )

  it.each(["openai", "raw"] as const)(
    "streams delayed startup failures in %s format",
    async (format) => {
      bridge.runApiAgentTurn.mockImplementationOnce(
        () => new Promise((_resolve, reject) => later(() => reject(new Error("model unavailable"))))
      )

      const response = await send(format)
      const body = await response.text()
      expect(body).toContain("model unavailable")
      expect(body).toContain(format === "openai" ? "data: [DONE]" : '"type":"error"')
      expect(bridge.apiCancelThread).not.toHaveBeenCalled()
      expect(hasAgentStreamSink("thread-a")).toBe(false)
    }
  )

  it.each(["openai", "raw"] as const)(
    "reports the %s stream deadline and cancels a stalled turn",
    async (format) => {
      const realSetTimeout = globalThis.setTimeout
      const deadline = vi
        .spyOn(globalThis, "setTimeout")
        .mockImplementation((callback, delay, ...args) =>
          realSetTimeout(callback, delay === 15 * 60 * 1000 ? 30 : delay, ...args)
        )
      try {
        const response = await send(format)
        const body = await response.text()
        expect(body).toContain("Agent turn timed out after 15 minutes")
        expect(body).toContain(format === "openai" ? "data: [DONE]" : '"type":"error"')
        expect(bridge.apiCancelThread).toHaveBeenCalledExactlyOnceWith("thread-a")
        expect(hasAgentStreamSink("thread-a")).toBe(false)
      } finally {
        deadline.mockRestore()
      }
    }
  )

  it.each(["openai", "raw"] as const)(
    "opens %s immediately and cancels exactly once when the client disconnects",
    async (format) => {
      const response = await send(format)
      const reader = response.body!.getReader()
      const first = await reader.read()
      expect(first.done).toBe(false)
      expect(hasAgentStreamSink("thread-a")).toBe(true)
      expect(bridge.apiCancelThread).not.toHaveBeenCalled()

      await reader.cancel()
      await vi.waitFor(() => {
        expect(bridge.apiCancelThread).toHaveBeenCalledExactlyOnceWith("thread-a")
        expect(hasAgentStreamSink("thread-a")).toBe(false)
      })
      expect(() => emit({ type: "done" })).not.toThrow()
    }
  )
})

async function listen(token = ""): Promise<{ server: Server; origin: string }> {
  const server = createServer(createApiGatewayRequestHandler(config(token)))
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("ephemeral HTTP port unavailable")
  return { server, origin: `http://127.0.0.1:${address.port}` }
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  )
}

describe("HTTP approval route", () => {
  let server: Server | null = null
  let origin = ""

  beforeEach(() => {
    bridge.consumed.clear()
    bridge.apiDecideThreadApproval.mockClear()
    bridge.apiGetThreadRuntime.mockClear()
  })

  afterEach(async () => {
    if (server) await close(server)
    server = null
  })

  async function start(token = ""): Promise<void> {
    const listening = await listen(token)
    server = listening.server
    origin = listening.origin
  }

  const decide = (
    threadId: string,
    approvalId: string,
    init: RequestInit = {}
  ): Promise<Response> =>
    fetch(`${origin}/v1/threads/${threadId}/approvals/${approvalId}/decision`, {
      method: "POST",
      headers: { "content-type": "application/json", ...init.headers },
      body: JSON.stringify({ action: "approve" }),
      ...init
    })

  it("enforces a configured token before reaching approval logic", async () => {
    await start("secret")
    expect((await decide("thread-a", "auth-missing")).status).toBe(401)
    expect(
      (await decide("thread-a", "auth-wrong", { headers: { authorization: "Bearer wrong" } }))
        .status
    ).toBe(401)
    expect(bridge.apiDecideThreadApproval).not.toHaveBeenCalled()

    const response = await decide("thread-a", "auth-ok", {
      headers: { authorization: "Bearer secret" }
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ accepted: true, approval_id: "auth-ok" })
  })

  it("returns 409 for a cross-thread approval id", async () => {
    await start()
    const response = await decide("thread-a", "foreign")
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: "approval_thread_mismatch" })
  })

  it("accepts exactly one of two concurrent decisions", async () => {
    await start()
    const responses = await Promise.all([decide("thread-a", "once"), decide("thread-a", "once")])
    expect(responses.map((response) => response.status).sort()).toEqual([200, 404])
    const duplicate = responses.find((response) => response.status === 404)
    expect(duplicate).toBeDefined()
    expect(await duplicate!.json()).toMatchObject({ error: "approval_not_found" })
  })

  it("returns structured errors for malformed and oversized JSON", async () => {
    await start()
    const malformed = await fetch(`${origin}/v1/threads/thread-a/approvals/malformed/decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{"
    })
    expect(malformed.status).toBe(400)
    expect(await malformed.json()).toMatchObject({ error: "invalid_json" })

    const oversized = await fetch(`${origin}/v1/threads/thread-a/approvals/large/decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "approve", padding: "x".repeat(1024 * 1024) })
    })
    expect(oversized.status).toBe(413)
    expect(await oversized.json()).toMatchObject({ error: "payload_too_large" })

    const oversizedMessage = await fetch(`${origin}/v1/threads/thread-a/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "x".repeat(1024 * 1024) })
    })
    expect(oversizedMessage.status).toBe(413)
    expect(await oversizedMessage.json()).toMatchObject({ error: "payload_too_large" })

    const malformedMessage = await fetch(`${origin}/v1/threads/thread-a/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{"
    })
    expect(malformedMessage.status).toBe(400)
    expect(await malformedMessage.json()).toMatchObject({ error: "invalid_json" })
  })

  it("does not expose unexpected server error messages", async () => {
    await start()
    bridge.apiGetThreadRuntime.mockImplementationOnce(() => {
      throw new Error("database failed at /Users/private/internal.sqlite")
    })
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const response = await fetch(`${origin}/v1/threads/thread-a`)
      expect(response.status).toBe(500)
      expect(await response.json()).toEqual({ error: "internal_error" })
    } finally {
      consoleError.mockRestore()
    }
  })

  it.each([
    { workspacePath: "/Users/demo/project" },
    { metadata: { workspacePath: "/Users/demo/project" } }
  ])("returns 400 when thread creation rejects a workspace: %j", async (body) => {
    await start()
    bridge.apiCreateThread.mockRejectedValueOnce(
      new WorkspaceValidationError("/Users/demo/project", "不存在或不可访问")
    )
    const response = await fetch(`${origin}/v1/threads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: "invalid_workspace_path",
      message: expect.stringContaining("/Users/demo/project")
    })
    expect(bridge.apiCreateThread).toHaveBeenLastCalledWith({
      workspacePath: "/Users/demo/project"
    })
  })
})
