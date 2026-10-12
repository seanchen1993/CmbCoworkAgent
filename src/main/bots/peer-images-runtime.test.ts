import { afterEach, expect, it, vi } from "vitest"
import type { BotInteraction, BotRun } from "../../shared/bot-types"
import { createServer } from "node:http"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { randomBytes } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import { BotStore } from "./store"
import { BotArtifacts } from "./artifacts"
import { BotHost } from "./host"
import { BotHostLock } from "./host-lock"
import { BotRpcServer } from "./rpc"
import { BotTransportClient } from "./transport-client"
import { CmbBotRuntime } from "./agent-runtime"
import { LocalBotComputerProvider } from "./computer-provider"
import { BotDocumentReader } from "./document-reader"
import { writeBotModelSnapshot } from "./model-config"
import { avatarImage } from "./image-fixtures"
import { testModelRequest, type TestModelRequest } from "./test-model-protocol"

const cleanup: (() => Promise<unknown> | void)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
async function fixture(rejectVision = false) {
  const directory = await mkdtemp(join(tmpdir(), "cmb-peer-vision-"))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  await mkdir(join(directory, "host"))
  const lock = BotHostLock.acquire(join(directory, "host"))!
  cleanup.push(() => lock.release())
  const store = new BotStore(join(directory, "bots.sqlite"))
  cleanup.push(() => store.close())
  // Wait for the actual committed Host milestones, within the original test
  // deadline. A parser subprocess can outlive expect.poll's default 500 ms.
  let approveReady!: (interaction: BotInteraction) => void
  const approvalReady = new Promise<BotInteraction>((resolve) => {
    approveReady = resolve
  })
  const requestInteraction = store.requestInteraction.bind(store)
  const approvalObserver = vi.spyOn(store, "requestInteraction").mockImplementation((...args) => {
    const interaction = requestInteraction(...args)
    if (interaction.kind === "approval") approveReady(interaction)
    return interaction
  })
  const finish = store.finish.bind(store)
  const pending = new Map<string, (run: BotRun) => void>()
  const finishObserver = vi.spyOn(store, "finish").mockImplementation((...args) => {
    const run = finish(...args)
    pending.get(run.id)?.(run)
    pending.delete(run.id)
    return run
  })
  const settled = (id: string): Promise<BotRun> => {
    const run = store.getRun(id)
    if (["succeeded", "failed", "cancelled", "needs_review"].includes(run.status))
      return Promise.resolve(run)
    return new Promise((resolve) => {
      pending.set(id, resolve)
    })
  }
  cleanup.push(() => {
    approvalObserver.mockRestore()
    finishObserver.mockRestore()
  })
  const reader = new BotDocumentReader({
    entry: resolve("src/main/bots/document-worker-entry.ts"),
    execArgv: ["--import", "tsx"]
  })
  const files = new BotArtifacts(join(directory, "objects"), store, reader)
  cleanup.push(() => files.close())
  const source = store.createBot({ nonce: "a", name: "图片交办" }),
    target = store.createBot({ nonce: "b", name: "图片分析" })
  const image = await files.publish(
    {
      id: "chart",
      conversationId: source.conversationId,
      runId: null,
      name: "chart.png",
      mime: "image/png"
    },
    Buffer.from(await avatarImage("#1084fe"), "base64")
  )
  const requests: TestModelRequest[] = []
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk)
    const body = testModelRequest.parse(JSON.parse(Buffer.concat(chunks).toString()))
    requests.push(body)
    const peer = body.messages.some(
      (message) =>
        Array.isArray(message.content) && message.content.some((part) => part.type === "image_url")
    )
    const done = body.messages.some((message) => message.role === "tool")
    if (peer && rejectVision) {
      res.statusCode = 400
      res.setHeader("Content-Type", "application/json")
      res.end(
        JSON.stringify({
          error: {
            message: "This configured model does not support image inputs",
            type: "invalid_request_error",
            code: "unsupported_image"
          }
        })
      )
      return
    }
    const message = peer
      ? { content: "RECIPIENT_VISION_INPUT_RECEIVED" }
      : done
        ? { content: "SOURCE_ASSIGNED" }
        : {
            tool_calls: [
              {
                id: "peer-image-call",
                type: "function",
                function: {
                  name: "message_bot",
                  arguments: JSON.stringify({
                    bot_id: target.bot.id,
                    message: "请检查这张图",
                    images: [{ artifact_id: image.id, alt: "蓝色图表" }]
                  })
                }
              }
            ]
          }
    res.setHeader("Content-Type", "text/event-stream")
    const delta = (value: unknown, finish: string | null = null) =>
      res.write(
        `data: ${JSON.stringify({ id: `fixture-${requests.length}`, object: "chat.completion.chunk", created: 1, model: "gpt-test", choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`
      )
    delta({
      role: "assistant",
      ...(message.tool_calls
        ? { tool_calls: message.tool_calls.map((call, index) => ({ index, ...call })) }
        : { content: message.content })
    })
    delta({}, "tool_calls" in message ? "tool_calls" : "stop")
    res.end("data: [DONE]\n\n")
  })
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  cleanup.push(
    () =>
      new Promise<void>((done) => {
        server.closeAllConnections()
        server.close(() => done())
      })
  )
  const { port } = server.address() as { port: number }
  const modelFile = join(directory, "host", "models.private")
  await writeBotModelSnapshot(modelFile, {
    version: 1,
    defaultRef: "fixture",
    models: [
      {
        ref: "fixture",
        id: "fixture",
        name: "fixture",
        model: "gpt-test",
        apiKey: "fixture-only",
        baseUrl: `http://127.0.0.1:${port}/v1`
      }
    ]
  })
  const computer = new LocalBotComputerProvider(join(directory, "browser"))
  cleanup.push(() => computer.shutdown())
  const runtime = new CmbBotRuntime(modelFile, computer, { files, documents: reader })
  const host = new BotHost(store, runtime, 2, computer, files, undefined, undefined, reader)
  host.bindOwnership(lock)
  cleanup.push(() => host.stop())
  const token = randomBytes(32).toString("hex")
  const socketPath =
    process.platform === "win32"
      ? `\\\\.\\pipe\\peer-${token.slice(0, 16)}`
      : join(directory, "peer.sock")
  const rpc = new BotRpcServer(host, token)
  await rpc.listen(socketPath)
  cleanup.push(() => rpc.close())
  const client = new BotTransportClient({
    version: 1,
    pid: process.pid,
    hostId: host.id,
    socketPath,
    token
  })
  cleanup.push(() => client.close())
  return { source, target, image, store, host, requests, client, files, approvalReady, settled }
}
it("carries approved exact images through the real leased graph, authenticated RPC and SSE recipient transport", async () => {
  const f = await fixture()
  // A private message which was not selected is not copied to the recipient.
  f.store.send({
    nonce: "private",
    conversationId: f.source.conversationId,
    text: "PRIVATE_HISTORY_CANARY"
  })
  const old = f.store.claim("history")!
  f.store.finish(old.lease, "succeeded", "Private result")
  const send = await f.client.call("send", {
    nonce: "visible",
    conversationId: f.source.conversationId,
    text: "请把所选图片交给分析 Bot",
    attachments: [f.image.id]
  })
  f.host.start()
  const approval = await f.approvalReady
  expect(f.store.snapshot().interactions).toHaveLength(1)
  expect(JSON.parse(approval.prompt)).toMatchObject({
    peer: {
      recipient: { id: f.target.bot.id },
      images: [{ sourceId: f.image.id, sha256: f.image.sha256, alt: "蓝色图表" }]
    }
  })
  expect(f.store.messages(f.target.conversationId)).toEqual([])
  await f.client.call("answer", { id: approval.id, revision: approval.revision, answer: "approve" })
  expect(await f.settled(send.runIds[0])).toMatchObject({ status: "succeeded", error: null })
  const handoff = f.store
    .messages(f.target.conversationId)
    .find((message) => message.peerImages?.length)!
  expect(handoff.peerImages).toHaveLength(1)
  const recipient = f.store.db.exec("SELECT id,status,result FROM bot_runs WHERE message_id=?", [
    handoff.id
  ])[0].values[0]
  expect(await f.settled(String(recipient[0]))).toMatchObject({ status: "succeeded", error: null })
  const vision = f.requests.find((request) =>
    request.messages.some(
      (message) =>
        Array.isArray(message.content) && message.content.some((part) => part.type === "image_url")
    )
  )!
  expect(vision).toBeDefined()
  expect(JSON.stringify(vision.messages)).not.toContain("PRIVATE_HISTORY_CANARY")
  const blocks = vision.messages.flatMap((message) =>
    Array.isArray(message.content) ? message.content : []
  )
  const url = blocks.find((part) => part.type === "image_url")!.image_url!.url
  expect(url).toMatch(/^data:image\/jpeg;base64,/)
  expect(Buffer.from(url.split(",")[1], "base64").length).toBeLessThanOrEqual(1024 * 1024)
  expect(JSON.stringify(blocks)).toContain("蓝色图表")
  expect(f.store.getRun(String(recipient[0])).result).toBe("RECIPIENT_VISION_INPUT_RECEIVED")
  expect(f.store.effects(send.runIds[0])).toMatchObject([{ status: "succeeded" }])
  expect(
    (await f.client.call("messages", { conversationId: f.target.conversationId })).some(
      (message) => message.peerImages?.length === 1
    )
  ).toBe(true)
  await delay(20)
  expect(f.requests.filter((request) => request === vision)).toHaveLength(1)
}, 20_000)

it("keeps a real rejected vision delivery visible without substituting a model or claiming task success", async () => {
  const f = await fixture(true)
  const send = await f.client.call("send", {
    nonce: "vision-rejected",
    conversationId: f.source.conversationId,
    text: "请把所选图片交给分析 Bot",
    attachments: [f.image.id]
  })
  f.host.start()
  const approval = await f.approvalReady
  expect(f.store.snapshot().interactions).toHaveLength(1)
  await f.client.call("answer", { id: approval.id, revision: approval.revision, answer: "approve" })
  expect((await f.settled(send.runIds[0])).status).toBe("succeeded")
  const incoming = (
    await f.client.call("messages", { conversationId: f.target.conversationId })
  ).find((message) => message.peerDelivery?.direction === "incoming")!
  const recipient = incoming.peerDelivery!.recipientRunId
  expect((await f.settled(recipient)).status).toBe("failed")
  expect(f.store.getRun(recipient).error).toMatch(/400|image inputs/)
  expect(f.store.getRun(recipient).result).toBeNull()
  expect(
    f.requests.filter((request) =>
      request.messages.some(
        (message) =>
          Array.isArray(message.content) &&
          message.content.some((part) => part.type === "image_url")
      )
    )
  ).toHaveLength(1)
  expect(new Set(f.requests.map((request) => request.model))).toEqual(new Set(["gpt-test"]))
  expect(
    (await f.client.call("messages", { conversationId: f.source.conversationId })).some(
      (message) => message.peerDelivery?.direction === "outgoing"
    )
  ).toBe(true)
  expect(incoming.peerImages).toHaveLength(1)
  expect(f.store.getArtifact(incoming.peerImages![0].id).sha256).toBe(f.image.sha256)
  expect(f.store.effects(send.runIds[0])).toMatchObject([{ status: "succeeded" }])
}, 20_000)
