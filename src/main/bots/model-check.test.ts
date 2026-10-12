import { randomBytes, randomUUID } from "node:crypto"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { createServer, type ServerResponse } from "node:http"
import { createServer as createSecureServer } from "node:https"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import { BotModelChecks } from "./model-check"
import { botModelCheckImages } from "./model-check-images"
import { writeBotModelSnapshot, type BotModelSnapshot } from "./model-config"
import { testModelRequest, type TestModelRequest } from "./test-model-protocol"
import { BotHost } from "./host"
import { BotStore } from "./store"
import { BotRpcServer } from "./rpc"
import { BotTransportClient } from "./transport-client"

const cleanup: (() => Promise<unknown> | void)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
const input = (kind: "text" | "tools" | "vision" = "text") => ({
  nonce: randomUUID(),
  modelRef: null,
  kind
})
function reply(
  body: TestModelRequest,
  response: ServerResponse,
  wrong = false,
  reasoning = false,
  finishReason?: string,
  refusal?: string
) {
  const content = body.messages[0]?.content
  const marker = typeof content === "string" ? content.match(/[a-f0-9-]{36}/)?.[0] : undefined
  const colors = Array.isArray(content)
    ? content
        .filter((p) => p.type === "image_url")
        .map(
          (p) =>
            Object.entries(botModelCheckImages).find(
              ([, bytes]) => p.image_url?.url === `data:image/png;base64,${bytes}`
            )?.[0]
        )
    : []
  const tools = body.tools.length > 0
  const delta = tools
    ? {
        ...(refusal ? { refusal } : {}),
        tool_calls: [
          {
            index: 0,
            id: "probe",
            type: "function",
            function: {
              name: "cmb_capability_check",
              arguments: JSON.stringify({ marker: wrong ? "wrong" : marker })
            }
          }
        ]
      }
    : {
        ...(reasoning ? { reasoning_content: "PRIVATE_MODEL_CHECK_REASONING" } : {}),
        ...(refusal ? { refusal } : {}),
        // Some compatible providers still send an inline prefix when the
        // text-only probe requests thinking off. Exercise those actual bytes;
        // a reasoning_content field alone would already pass the old probe.
        content:
          (reasoning ? "<think>PRIVATE_MODEL_CHECK_REASONING</think>" : "") +
          (wrong ? "incorrect response" : (marker ?? colors.join(",")))
      }
  response.writeHead(200, { "Content-Type": "text/event-stream" })
  response.end(
    `data: ${JSON.stringify({ id: "probe", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", ...delta }, finish_reason: finishReason ?? (tools ? "tool_calls" : "stop") }] })}\n\ndata: [DONE]\n\n`
  )
}
async function fixture(
  handle: (body: TestModelRequest, response: ServerResponse) => void | Promise<void> = reply
) {
  const root = await mkdtemp(join(tmpdir(), "cmb-model-check-"))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const requests: TestModelRequest[] = []
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(chunk)
      const body = testModelRequest.parse(JSON.parse(Buffer.concat(chunks).toString()))
      requests.push(body)
      await handle(body, response)
    } catch {
      response.writeHead(500).end()
    }
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  cleanup.push(
    () =>
      new Promise<void>((resolve, reject) => {
        if (!server.listening) return resolve()
        server.closeAllConnections()
        server.close((error) => (error ? reject(error) : resolve()))
      })
  )
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Missing fixture address")
  const modelFile = join(root, "models.json")
  const config: BotModelSnapshot = {
    version: 1,
    defaultRef: "fixture",
    models: [
      {
        ref: "fixture",
        id: "fixture",
        name: "本地测试模型",
        model: "fixture-model",
        apiKey: "test-credential-do-not-return",
        baseUrl: `http://127.0.0.1:${address.port}/v1`
      }
    ]
  }
  await writeBotModelSnapshot(modelFile, config)
  const checks = new BotModelChecks(modelFile),
    client = new AbortController()
  cleanup.push(() => checks.close())
  return { root, checks, client, config, modelFile, requests, server }
}

it.each(["text", "tools", "vision"] as const)(
  "checks %s through the actual configured model protocol and caches the original receipt",
  async (kind) => {
    const f = await fixture(),
      request = input(kind)
    const result = await f.checks.check(request, f.client.signal)
    expect(result).toMatchObject({
      kind,
      status: "passed",
      modelRef: "fixture",
      model: "fixture-model"
    })
    expect(result.configuration).toMatch(/^[a-f0-9-]{36}$/)
    expect(JSON.stringify(result)).not.toContain("test-credential")
    expect(await f.checks.check(request, f.client.signal)).toEqual(result)
    expect(f.requests).toHaveLength(1)
    if (kind === "vision") {
      const content = f.requests[0].messages[0].content
      expect(Array.isArray(content) && content.filter((p) => p.type === "image_url")).toHaveLength(
        6
      )
    }
    if (kind === "tools") expect(f.requests[0].tools).toHaveLength(1)
  }
)

it.each(["text", "tools", "vision"] as const)(
  "does not pass %s simply because the endpoint returns HTTP 200",
  async (kind) => {
    const f = await fixture((body, response) => reply(body, response, true))
    expect(await f.checks.check(input(kind), f.client.signal)).toMatchObject({ status: "failed" })
  }
)

it.each(["auth", "oversize", "malformed", "redirect"])(
  "contains %s responses without returning upstream secrets or following redirects",
  async (mode) => {
    const f = await fixture((_body, response) => {
      if (mode === "auth") response.writeHead(401).end("test-credential-do-not-return")
      if (mode === "oversize") response.end("x".repeat(128 * 1024 + 1))
      if (mode === "malformed") response.end("test-credential-do-not-return")
      if (mode === "redirect") response.writeHead(307, { Location: "/redirected" }).end()
    })
    const result = await f.checks.check(input(), f.client.signal)
    expect(result.status).toBe("failed")
    expect(JSON.stringify(result)).not.toContain("test-credential")
    expect(f.requests).toHaveLength(1)
  }
)

it.each([
  [401, "API Key"],
  [429, "速率限制"],
  [432, "输入 Token 数限流"],
  [481, "目标模型不存在"],
  [482, "模型不支持该用途"],
  [500, "服务内部异常"],
  [599, "服务状态及接口配置"]
])(
  "uses the existing gateway dictionary for HTTP %s without echoing its body",
  async (code, hint) => {
    const f = await fixture((_body, response) => {
      response.writeHead(code).end(
        JSON.stringify({
          error: { code: "ENOTFOUND", message: "test-credential-do-not-return" }
        })
      )
    })
    const result = await f.checks.check(input(), f.client.signal)
    expect(result).toMatchObject({ status: "failed", detail: expect.stringContaining(hint) })
    expect(result.detail).toContain(`HTTP ${code}`)
    expect(JSON.stringify(result)).not.toContain("test-credential")
    expect(result.detail).not.toContain("域名")
    expect(f.requests).toHaveLength(1)
  }
)

it("diagnoses an actual refused connection through the configured model SDK", async () => {
  const f = await fixture()
  await new Promise<void>((resolve, reject) =>
    f.server.close((error) => (error ? reject(error) : resolve()))
  )
  const result = await f.checks.check(input(), f.client.signal)
  expect(result).toMatchObject({ status: "failed", detail: expect.stringContaining("拒绝连接") })
  expect(JSON.stringify(result)).not.toContain("test-credential")
  expect(f.requests).toHaveLength(0)
})

it.skipIf(spawnSync("openssl", ["version"], { stdio: "ignore" }).status !== 0)(
  "diagnoses an actual untrusted TLS certificate without disabling certificate verification",
  async () => {
    const f = await fixture(),
      keyFile = join(f.root, "test.key"),
      certFile = join(f.root, "test.crt")
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
        "/CN=localhost",
        "-keyout",
        keyFile,
        "-out",
        certFile
      ],
      { stdio: "ignore", timeout: 10_000 }
    )
    let requests = 0
    const server = createSecureServer(
      {
        key: await readFile(keyFile),
        cert: await readFile(certFile)
      },
      (_request, response) => {
        requests++
        response.end()
      }
    )
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    cleanup.push(
      () =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections()
          server.close((error) => (error ? reject(error) : resolve()))
        })
    )
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Missing TLS fixture address")
    f.config.models[0].baseUrl = `https://127.0.0.1:${address.port}/v1`
    await writeBotModelSnapshot(f.modelFile, f.config)
    const result = await f.checks.check(input(), f.client.signal)
    expect(result).toMatchObject({ status: "failed", detail: expect.stringContaining("可信证书") })
    expect(JSON.stringify(result)).not.toContain("test-credential")
    expect(requests).toBe(0)
  }
)

it("rejects untrusted parameters, missing models and unusable configured URLs before issuing a request", async () => {
  const f = await fixture()
  await expect(
    f.checks.check({ ...input(), baseUrl: "http://not-authorized.invalid" }, f.client.signal)
  ).rejects.toThrow()
  await expect(
    f.checks.check({ ...input(), modelRef: "missing" }, f.client.signal)
  ).rejects.toMatchObject({ code: "model_missing" })
  for (const baseUrl of ["invalid", "file:///tmp/model", "https://user:secret@example.test"]) {
    f.config.models[0].baseUrl = baseUrl
    await writeBotModelSnapshot(f.modelFile, f.config)
    await expect(f.checks.check(input(), f.client.signal)).rejects.toMatchObject({
      code: "model_url"
    })
  }
  expect(f.requests).toHaveLength(0)
})

it("fences cached results and in-flight responses against model configuration changes", async () => {
  let release: (() => void) | undefined
  const f = await fixture(async (body, response) => {
      if (f.requests.length === 2)
        await new Promise<void>((resolve) => {
          release = resolve
        })
      reply(body, response)
    }),
    request = input()
  const first = await f.checks.check(request, f.client.signal)
  const pending = f.checks.check(input(), f.client.signal)
  const rejected = expect(pending).rejects.toMatchObject({ code: "model_check_changed" })
  await expect.poll(() => Boolean(release)).toBe(true)
  f.config.models[0].apiKey = "changed-fixture-key"
  await writeBotModelSnapshot(f.modelFile, f.config)
  release!()
  await rejected
  await expect(f.checks.check(request, f.client.signal)).rejects.toMatchObject({
    code: "model_check_changed"
  })
  await expect(
    f.checks.check({ ...request, kind: "vision" }, f.client.signal)
  ).rejects.toMatchObject({ code: "model_check_changed" })
  const next = await f.checks.check(input(), f.client.signal)
  expect(next.configuration).not.toBe(first.configuration)
})

it("cancels before configuration resolution and limits concurrent requests without another client's cancellation", async () => {
  const f = await fixture(() => {}),
    request = input()
  const pending = f.checks.check(request, f.client.signal)
  const rejected = expect(pending).rejects.toThrow()
  f.checks.cancel({ nonce: request.nonce }, f.client.signal)
  await rejected
  expect(f.requests).toHaveLength(0)
  const a = input(),
    b = input()
  const pa = f.checks.check(a, f.client.signal),
    pb = f.checks.check(b, f.client.signal)
  await expect.poll(() => f.requests.length).toBe(2)
  expect(() => f.checks.cancel({ nonce: a.nonce }, new AbortController().signal)).toThrow(
    "另一个客户端"
  )
  await expect(f.checks.check(input(), f.client.signal)).rejects.toMatchObject({
    code: "model_check_busy"
  })
  const duplicate = f.checks.check(a, f.client.signal)
  f.checks.cancel({ nonce: a.nonce }, f.client.signal)
  expect(await pa).toMatchObject({ status: "failed", detail: expect.stringContaining("取消") })
  expect(await duplicate).toEqual(await pa)
  f.client.abort()
  expect(await pb).toMatchObject({ status: "failed", detail: expect.stringContaining("取消") })
  expect(f.requests).toHaveLength(2)
})

it("exposes checks through the authenticated Host transport and aborts them on shutdown", async () => {
  const f = await fixture(() => {}),
    store = new BotStore(":memory:")
  cleanup.push(() => store.close())
  const host = new BotHost(store, { modelChecks: f.checks, execute: async () => "unused" })
  cleanup.push(() => host.stop())
  const token = randomBytes(32).toString("hex"),
    socketPath =
      process.platform === "win32" ? `\\\\.\\pipe\\model-check-${token}` : join(f.root, "host.sock")
  const server = new BotRpcServer(host, token)
  await server.listen(socketPath)
  cleanup.push(() => server.close())
  const client = new BotTransportClient({
    version: 1,
    pid: process.pid,
    hostId: host.id,
    socketPath,
    token
  })
  cleanup.push(() => client.close())
  expect((await client.call("status")).capabilities).toContain("model-checks")
  await expect(
    client.call("checkModel", { ...input(), apiKey: "renderer-key" } as never)
  ).rejects.toThrow()
  const pending = client.call("checkModel", input())
  await expect.poll(() => f.requests.length).toBe(1)
  await host.stop()
  expect(await pending).toMatchObject({ status: "failed" })
})

it.each(["text", "vision"] as const)(
  "checks the projected %s body when the provider includes inline reasoning in a text-only probe",
  async (kind) => {
    const f = await fixture((body, response) => reply(body, response, false, true))
    await writeBotModelSnapshot(f.modelFile, {
      ...f.config,
      models: f.config.models.map((model) => ({
        ...model,
        enableThinking: true,
        interleavedThinking: true
      }))
    })
    const result = await f.checks.check(input(kind), f.client.signal)
    expect(result).toMatchObject({ kind, status: "passed" })
    expect(f.requests).toHaveLength(1)
    expect(Number(f.requests[0].max_tokens ?? f.requests[0].max_completion_tokens)).toBe(512)
    expect(JSON.stringify(result)).not.toContain("PRIVATE_MODEL_CHECK")
  }
)

it.each(["text", "vision"] as const)(
  "still rejects an incorrect projected %s body even when inline provider reasoning is present",
  async (kind) => {
    const f = await fixture((body, response) => reply(body, response, true, true))
    await writeBotModelSnapshot(f.modelFile, {
      ...f.config,
      models: f.config.models.map((model) => ({
        ...model,
        enableThinking: true,
        interleavedThinking: true
      }))
    })
    expect(await f.checks.check(input(kind), f.client.signal)).toMatchObject({
      kind,
      status: "failed"
    })
  }
)

it("returns a failed diagnostic for an unfinished inline think-only response without echoing its body", async () => {
  const f = await fixture((_body, response) => {
    response.writeHead(200, { "Content-Type": "text/event-stream" })
    response.end(
      `data: ${JSON.stringify({
        id: "probe-incomplete",
        object: "chat.completion.chunk",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "<think>PRIVATE_INCOMPLETE_CHECK" },
            finish_reason: "stop"
          }
        ]
      })}\n\ndata: [DONE]\n\n`
    )
  })
  const result = await f.checks.check(input(), f.client.signal)
  expect(result).toMatchObject({ status: "failed", detail: expect.stringContaining("正文") })
  expect(JSON.stringify(result)).not.toContain("PRIVATE_INCOMPLETE")
})

const truncationCases = (["text", "vision", "tools"] as const).flatMap((kind) =>
  ["length", "max_tokens", "max_output_tokens", "model_length", "content_filter_length"].map(
    (reason) => ({ kind, reason })
  )
)
it.each(truncationCases)(
  "does not pass an exact $kind answer with a truncation terminal reason ($reason)",
  async ({ kind, reason }) => {
    const f = await fixture((body, response) => reply(body, response, false, false, reason))
    const request = input(kind),
      result = await f.checks.check(request, f.client.signal)
    expect(result).toMatchObject({
      kind,
      status: "failed",
      detail: expect.stringContaining("截断")
    })
    expect(await f.checks.check(request, f.client.signal)).toEqual(result)
    expect(f.requests).toHaveLength(1)
    expect(Number(f.requests[0].max_tokens ?? f.requests[0].max_completion_tokens)).toBe(512)
    expect(JSON.stringify(result)).not.toContain("test-credential")
  }
)

const refusalCases = (["text", "vision", "tools"] as const).flatMap((kind) =>
  ["refusal", "content_filter", "stop"].map((reason) => ({ kind, reason }))
)
it.each(refusalCases)(
  "does not pass an exact $kind answer with explicit provider refusal ($reason)",
  async ({ kind, reason }) => {
    const f = await fixture((body, response) =>
      reply(
        body,
        response,
        false,
        false,
        reason,
        reason === "stop" ? "PRIVATE_PROVIDER_REFUSAL_NOT_UI_CONTENT" : undefined
      )
    )
    const request = input(kind),
      result = await f.checks.check(request, f.client.signal)
    expect(result).toMatchObject({
      kind,
      status: "failed",
      detail: expect.stringContaining("拒绝")
    })
    expect(await f.checks.check(request, f.client.signal)).toEqual(result)
    expect(f.requests).toHaveLength(1)
    expect(JSON.stringify(result)).not.toContain("PRIVATE_PROVIDER_REFUSAL")
    expect(JSON.stringify(result)).not.toContain("test-credential")
  }
)
