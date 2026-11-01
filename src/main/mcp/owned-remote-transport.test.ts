import { afterEach, expect, it, vi } from "vitest"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import type { CapabilitySource } from "./capability-service"
import { createOwnedMcpTransport, type OwnedMcpTransport } from "./owned-transport"

type Rpc = { id?: string | number; method: string; params?: Record<string, unknown> }
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})

async function fixture(
  kind: "http" | "sse",
  options: {
    hold?: "initialize" | "tools/call" | "endpoint"
    status?: number
    endpoint?: string
    redirect?: string
  } = {}
) {
  const requests: Array<{ path: string; method: string; authorization?: string; rpc?: Rpc }> = []
  const responses = new Set<ServerResponse>()
  let stream: ServerResponse | undefined
  let heldClosed = false
  const server = createServer((req, res) => {
    responses.add(res)
    res.once("close", () => {
      responses.delete(res)
    })
    const request = {
      path: req.url ?? "",
      method: req.method ?? "",
      authorization: req.headers.authorization
    } as (typeof requests)[number]
    requests.push(request)
    if (options.redirect) {
      res.writeHead(307, { Location: options.redirect })
      res.end()
      return
    }
    if (options.status) {
      res.writeHead(options.status)
      res.end("secret-server-error")
      return
    }
    if (req.method === "GET") {
      if (kind === "http") {
        res.writeHead(405)
        res.end()
        return
      }
      stream = res
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" })
      res.flushHeaders()
      if (options.hold === "endpoint") {
        res.once("close", () => {
          heldClosed = true
        })
      } else
        res.write(`event: endpoint\ndata: ${options.endpoint ?? "/messages?session=host-only"}\n\n`)
      return
    }
    void readRpc(req)
      .then((rpc) => {
        request.rpc = rpc
        if (rpc.method === options.hold) {
          res.once("close", () => {
            heldClosed = true
          })
          return
        }
        if (rpc.id === undefined) {
          res.writeHead(202)
          res.end()
          return
        }
        const result =
          rpc.method === "initialize"
            ? {
                protocolVersion: "2024-11-05",
                capabilities: { tools: {} },
                serverInfo: { name: "owned-remote-fixture", version: "1" }
              }
            : rpc.method === "tools/list"
              ? { tools: [{ name: "echo", inputSchema: { type: "object" } }] }
              : { content: [{ type: "text", text: JSON.stringify(rpc.params?.arguments) }] }
        const reply = JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result })
        if (kind === "sse") {
          res.writeHead(202)
          res.end()
          stream?.write(`event: message\ndata: ${reply}\n\n`)
        } else {
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Mcp-Session-Id": "host-session"
          })
          res.end(reply)
        }
      })
      .catch(() => {
        res.destroy()
      })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  cleanups.push(async () => {
    for (const response of responses) response.destroy()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/${kind === "sse" ? "sse" : "mcp"}`
  const source: CapabilitySource = {
    kind: "connector",
    providerKey: "selected-remote",
    providerDisplayName: "Selected remote",
    visibility: "eager",
    priority: 100,
    scope: "global",
    serverConfig: { transport: kind, url, headers: { Authorization: "host-only-token" } }
  }
  return { source, requests, heldClosed: () => heldClosed, active: () => responses.size }
}

async function readRpc(request: IncomingMessage): Promise<Rpc> {
  let text = ""
  for await (const part of request) text += String(part)
  return JSON.parse(text)
}

function transport(source: CapabilitySource): OwnedMcpTransport {
  const value = createOwnedMcpTransport(source)
  cleanups.push(async () => {
    expect(await value.close()).toBe(true)
  })
  return value
}
const signal = () => new AbortController().signal

it.each(["http", "sse"] as const)(
  "performs a real %s initialize/list/call with host auth and closes local streams",
  async (kind) => {
    const f = await fixture(kind)
    const owned = transport(f.source)
    expect(await owned.initialize(signal())).toMatchObject([{ name: "echo" }])
    expect(await owned.call("echo", { text: "hello" }, signal())).toMatchObject({
      content: [{ type: "text", text: '{"text":"hello"}' }]
    })
    expect(f.requests.filter((request) => request.rpc?.method === "tools/call")).toHaveLength(1)
    expect(f.requests.every((request) => request.authorization === "host-only-token")).toBe(true)
    expect(await owned.close()).toBe(true)
    expect(owned.isClosed?.()).toBe(true)
    await vi.waitFor(() => expect(f.active()).toBe(0))
  }
)

it.each(["http", "sse"] as const)(
  "aborts a held %s initialization and confirms the actual local response closed",
  async (kind) => {
    const f = await fixture(kind, { hold: kind === "sse" ? "endpoint" : "initialize" })
    const owned = transport(f.source)
    const controller = new AbortController()
    const pending = owned.initialize(controller.signal)
    const rejected = expect(pending).rejects.toThrow()
    await vi.waitFor(() =>
      expect(
        kind === "sse"
          ? f.requests.length
          : f.requests.filter((request) => request.rpc?.method === "initialize").length
      ).toBe(1)
    )
    controller.abort()
    await rejected
    expect(await owned.close()).toBe(true)
    await vi.waitFor(() => expect(f.heldClosed()).toBe(true))
  }
)

it("bounds SSE start before the SDK initialize request timer can begin", async () => {
  const f = await fixture("sse", { hold: "endpoint" })
  const timers = vi.spyOn(globalThis, "setTimeout")
  try {
    const owned = transport(f.source)
    const pending = owned.initialize(signal())
    const rejected = expect(pending).rejects.toThrow("MODS_MCP_CONNECT_FAILED")
    await vi.waitFor(() => expect(f.requests).toHaveLength(1))
    const expire = timers.mock.calls.find(([, duration]) => duration === 30_000)?.[0]
    expect(typeof expire).toBe("function")
    if (typeof expire === "function") expire()
    await rejected
    expect(await owned.close()).toBe(true)
    await vi.waitFor(() => expect(f.heldClosed()).toBe(true))
  } finally {
    timers.mockRestore()
  }
})

it.each(["http", "sse"] as const)(
  "cancels a held %s tool request without replay and retires the connection",
  async (kind) => {
    const f = await fixture(kind, { hold: "tools/call" })
    const owned = transport(f.source)
    await owned.initialize(signal())
    const controller = new AbortController()
    const pending = owned.call("echo", {}, controller.signal)
    const rejected = expect(pending).rejects.toThrow("CANCELLED")
    await vi.waitFor(() =>
      expect(f.requests.filter((request) => request.rpc?.method === "tools/call")).toHaveLength(1)
    )
    controller.abort()
    await rejected
    expect(owned.isClosed?.()).toBe(true)
    await vi.waitFor(() => expect(f.heldClosed()).toBe(true))
    await expect(owned.call("echo", {}, signal())).rejects.toThrow("EXPIRED")
    expect(f.requests.filter((request) => request.rpc?.method === "tools/call")).toHaveLength(1)
  }
)

it.each(["http", "sse"] as const)(
  "fails %s authentication without OAuth, fallback or exposing server text",
  async (kind) => {
    const f = await fixture(kind, { status: 401 })
    const owned = transport(f.source)
    await expect(owned.initialize(signal())).rejects.toThrow("MODS_MCP_CONNECT_FAILED")
    expect(await owned.close()).toBe(true)
    expect(f.requests).toHaveLength(1)
  }
)

it("blocks redirects and SSE endpoints outside the selected origin before sending auth", async () => {
  const other = await fixture("http")
  const redirected = await fixture("http", { redirect: String(other.source.serverConfig.url) })
  const first = transport(redirected.source)
  await expect(first.initialize(signal())).rejects.toThrow()
  expect(await first.close()).toBe(true)
  const sse = await fixture("sse", { endpoint: String(other.source.serverConfig.url) })
  const second = transport(sse.source)
  await expect(second.initialize(signal())).rejects.toThrow()
  expect(await second.close()).toBe(true)
  expect(other.requests).toEqual([])
})

it("supports the existing host URL default and rejects unsupported protocols", async () => {
  const f = await fixture("http")
  delete f.source.serverConfig.transport
  const owned = transport(f.source)
  expect(await owned.initialize(signal())).toHaveLength(1)
  for (const url of ["file:///tmp/mcp", "https://user:secret@selected.test/mcp"])
    expect(() =>
      createOwnedMcpTransport({ ...f.source, serverConfig: { transport: "http", url } })
    ).toThrow("TRANSPORT_POLICY")
})
