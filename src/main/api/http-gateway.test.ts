import { createServer, type Server } from "http"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const bridge = vi.hoisted(() => {
  const consumed = new Set<string>()
  return {
    consumed,
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
  apiCreateThread: vi.fn(),
  apiGetThread: bridge.apiGetThread,
  apiGetThreadRuntime: bridge.apiGetThreadRuntime,
  apiGetThreadMessages: vi.fn(),
  apiCancelThread: vi.fn(),
  apiDecideThreadApproval: bridge.apiDecideThreadApproval,
  runApiAgentTurn: vi.fn()
}))

import { createApiGatewayRequestHandler } from "./http-gateway"
import type { ApiGatewayConfig } from "./config"

const config = (token = ""): ApiGatewayConfig => ({
  enabled: true,
  host: "127.0.0.1",
  port: 0,
  token
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
    const responses = await Promise.all([
      decide("thread-a", "once"),
      decide("thread-a", "once")
    ])
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
})
