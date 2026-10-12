import { afterEach, expect, it } from "vitest"
import { createServer, type IncomingHttpHeaders } from "node:http"
import { createServer as createSecureServer } from "node:https"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getGlobalDispatcher } from "undici"
import { installBotNetwork } from "./network"
import { botProxyFixture } from "./test-http-proxy"
import { ManagedMcpCapabilityService } from "../mcp/capability-core"

const cleanup: (() => void | Promise<unknown>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function fixture(hold = false) {
  const received: IncomingHttpHeaders[] = []
  const server = createServer((request, response) => {
    received.push(request.headers)
    response.writeHead(200, { "content-type": "text/event-stream" })
    response.write("data: FIRST\n\n")
    if (!hold) response.end("data: [DONE]\n\n")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  cleanup.push(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  const port = (server.address() as { port: number }).port
  const proxy = await botProxyFixture(
    port,
    "Basic " + Buffer.from("proxy:fixture").toString("base64")
  )
  cleanup.push(() => proxy.close())
  const network = await installBotNetwork({
    HTTP_PROXY: `http://proxy:fixture@127.0.0.1:${proxy.port}`
  })
  cleanup.push(() => network!.close())
  return { port, proxy, received, network: network! }
}

it("streams through the configured proxy without forwarding proxy credentials to the origin", async () => {
  const previous = getGlobalDispatcher()
  const f = await fixture()
  const response = await fetch(`http://model.proxy-fixture.invalid:${f.port}/v1`, {
    headers: { authorization: "Bearer model-fixture" },
    signal: AbortSignal.timeout(3000)
  })
  expect(await response.text()).toBe("data: FIRST\n\ndata: [DONE]\n\n")
  expect(f.proxy.tunnels).toHaveLength(1)
  expect(f.proxy.tunnels[0].headers.authorization).toBeUndefined()
  expect(f.received).toHaveLength(1)
  expect(f.received[0].authorization).toBe("Bearer model-fixture")
  expect(f.received[0]["proxy-authorization"]).toBeUndefined()
  await f.network.close()
  await f.network.close()
  expect(getGlobalDispatcher()).toBe(previous)
})

it("keeps loopback control requests direct even when the proxy has no bypass list", async () => {
  const f = await fixture()
  const response = await fetch(`http://127.0.0.1:${f.port}/screen`, {
    headers: { authorization: "Bearer local-control-fixture" },
    signal: AbortSignal.timeout(3000)
  })
  await response.text()
  expect(f.proxy.tunnels).toHaveLength(0)
  expect(f.received[0].authorization).toBe("Bearer local-control-fixture")
})

it("cancels an active proxied stream without replaying the request", async () => {
  const f = await fixture(true)
  const controller = new AbortController()
  const response = await fetch(`http://model.proxy-fixture.invalid:${f.port}/stream`, {
    signal: controller.signal
  })
  const reader = response.body!.getReader()
  expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: FIRST\n\n")
  controller.abort()
  await expect(reader.read()).rejects.toThrow()
  expect(f.received).toHaveLength(1)
})

it("does not bypass a proxy that rejects authentication", async () => {
  const f = await fixture()
  await f.network.close()
  const network = await installBotNetwork({ HTTP_PROXY: `http://127.0.0.1:${f.proxy.port}` })
  cleanup.push(() => network!.close())
  await expect(
    fetch(`http://model.proxy-fixture.invalid:${f.port}/private`, {
      headers: { authorization: "Bearer must-not-reach-origin" },
      signal: AbortSignal.timeout(3000)
    })
  ).rejects.toThrow()
  expect(f.proxy.tunnels).toHaveLength(1)
  expect(f.received).toHaveLength(0)
})

it("honors lowercase precedence and the no-proxy wildcard", async () => {
  const f = await fixture()
  await f.network.close()
  const network = await installBotNetwork({
    http_proxy: `http://proxy:fixture@127.0.0.1:${f.proxy.port}`,
    HTTP_PROXY: "invalid-uppercase-must-be-ignored",
    no_proxy: "*",
    NO_PROXY: "ignored.invalid"
  })
  cleanup.push(() => network!.close())
  const response = await fetch(`http://127.0.0.1:${f.port}/direct`)
  await response.text()
  await expect(
    fetch("http://must-stay-direct.invalid", { signal: AbortSignal.timeout(3000) })
  ).rejects.toThrow()
  expect(f.proxy.tunnels).toHaveLength(0)
  expect(f.received).toHaveLength(1)
})

it("does not change the dispatcher when proxy configuration is absent or explicitly empty", async () => {
  const previous = getGlobalDispatcher()
  expect(await installBotNetwork({})).toBeUndefined()
  expect(await installBotNetwork({ http_proxy: "", HTTP_PROXY: "ignored" })).toBeUndefined()
  expect(getGlobalDispatcher()).toBe(previous)
})

it("uses the existing MCP HTTP client through the same proxy for discovery and a tool result", async () => {
  const methods: string[] = [],
    headers: IncomingHttpHeaders[] = []
  const server = createServer(async (request, response) => {
    if (request.method !== "POST") {
      response.writeHead(405).end()
      return
    }
    const parts: Buffer[] = []
    for await (const part of request) parts.push(part)
    const body = JSON.parse(Buffer.concat(parts).toString())
    methods.push(body.method)
    headers.push(request.headers)
    if (body.id === undefined) {
      response.writeHead(202).end()
      return
    }
    const result =
      body.method === "initialize"
        ? {
            protocolVersion: body.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "Proxy fixture", version: "1" }
          }
        : body.method === "tools/list"
          ? {
              tools: [
                {
                  name: "echo",
                  description: "Return fixture evidence",
                  inputSchema: { type: "object", properties: {} }
                }
              ]
            }
          : { content: [{ type: "text", text: "PROXIED_CONNECTOR_COMPLETE" }] }
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  cleanup.push(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  const port = (server.address() as { port: number }).port
  const proxy = await botProxyFixture(
    port,
    "Basic " + Buffer.from("proxy:fixture").toString("base64")
  )
  cleanup.push(() => proxy.close())
  const network = await installBotNetwork({
    HTTP_PROXY: `http://proxy:fixture@127.0.0.1:${proxy.port}`
  })
  cleanup.push(() => network!.close())
  const service = new ManagedMcpCapabilityService({
    strictConnections: true,
    readSources: () => [
      {
        kind: "connector",
        providerKey: "fixture",
        providerDisplayName: "Proxy fixture",
        visibility: "eager",
        priority: 100,
        scope: "global",
        serverConfig: {
          transport: "http",
          url: `http://connector.proxy-fixture.invalid:${port}/mcp`,
          headers: { Authorization: "Bearer connector-fixture" }
        }
      }
    ]
  })
  cleanup.push(() => service.close())
  const [tool] = await service.listTools()
  expect((await service.invoke(tool.toolId, {})).text).toContain("PROXIED_CONNECTOR_COMPLETE")
  expect(methods).toContain("initialize")
  expect(methods.filter((method) => method === "tools/call")).toHaveLength(1)
  expect(proxy.tunnels.length).toBeGreaterThan(0)
  expect(proxy.tunnels.every((tunnel) => !tunnel.headers.authorization)).toBe(true)
  expect(
    headers.every(
      (header) =>
        header.authorization === "Bearer connector-fixture" && !header["proxy-authorization"]
    )
  ).toBe(true)
}, 10_000)

it.each([
  "invalid-secret-value",
  "http://user:private%ZZ@proxy",
  "socks5://user:private@proxy:1080",
  "https://proxy/path?credential=private"
])("rejects invalid proxy configuration without exposing credentials (%#)", async (value) => {
  const previous = getGlobalDispatcher()
  await expect(installBotNetwork({ HTTPS_PROXY: value })).rejects.toMatchObject({
    code: "proxy_configuration",
    message: "Bot 后台代理地址无效，请检查 HTTP_PROXY / HTTPS_PROXY；支持 HTTP 或 HTTPS 代理"
  })
  expect(getGlobalDispatcher()).toBe(previous)
})

it.skipIf(spawnSync("openssl", ["version"], { stdio: "ignore" }).status !== 0)(
  "rejects an untrusted origin certificate through an HTTPS tunnel",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "bot-proxy-tls-"))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const key = join(root, "key.pem"),
      cert = join(root, "cert.pem")
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-subj",
        "/CN=model.proxy-fixture.invalid",
        "-keyout",
        key,
        "-out",
        cert
      ],
      { stdio: "ignore", timeout: 10_000 }
    )
    let requests = 0
    const server = createSecureServer(
      { key: await readFile(key), cert: await readFile(cert) },
      (_request, response) => {
        requests++
        response.end("must not accept")
      }
    )
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    cleanup.push(async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    })
    const port = (server.address() as { port: number }).port
    const proxy = await botProxyFixture(port)
    cleanup.push(() => proxy.close())
    const network = await installBotNetwork({ HTTPS_PROXY: `http://127.0.0.1:${proxy.port}` })
    cleanup.push(() => network!.close())
    await expect(
      fetch(`https://model.proxy-fixture.invalid:${port}`, { signal: AbortSignal.timeout(3000) })
    ).rejects.toMatchObject({
      cause: { code: "DEPTH_ZERO_SELF_SIGNED_CERT" }
    })
    expect(proxy.tunnels).toHaveLength(1)
    expect(requests).toBe(0)
  }
)
