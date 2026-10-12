import { afterEach, expect, it, vi } from "vitest"
import { createServer } from "node:http"
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { BotStore } from "./store"
import { CmbBotRuntime } from "./agent-runtime"
import { LocalBotComputerProvider } from "./computer-provider"
import { writeBotModelSnapshot } from "./model-config"
import { BotArtifacts } from "./artifacts"
import { avatarImage } from "./image-fixtures"
import { BotDocumentReader } from "./document-reader"
import { sendReviewedBotPeer } from "./peer-approval"
import { prepareBotPeerImages } from "./peer-image-input"
import { testModelRequest, type TestModelRequest } from "./test-model-protocol"
const cleanup: (() => unknown | Promise<unknown>)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of cleanup.splice(0).reverse()) await close()
})
it.each([false, true])(
  "actual graph mixed inbox reaches approved real HTTP Stop/UserPromptSubmit Hooks without labeling Bot claims as user facts (image=%s)",
  async (image) => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "cmb-peer-stop-")))
    cleanup.push(() => rm(dir, { recursive: true, force: true }))
    const settings = join(dir, "settings")
    await mkdir(settings)
    const hooks: Record<string, unknown>[] = []
    const hookServer = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk)
      hooks.push(JSON.parse(Buffer.concat(chunks).toString()))
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ decision: "approve" }))
    })
    await new Promise<void>((done) => hookServer.listen(0, "127.0.0.1", done))
    cleanup.push(
      () =>
        new Promise<void>((done) => {
          hookServer.closeAllConnections()
          hookServer.close(() => done())
        })
    )
    const hookPort = (hookServer.address() as { port: number }).port
    await writeFile(
      join(settings, "hooks.json"),
      JSON.stringify(
        ["Stop", "UserPromptSubmit"].map((event) => ({
          id: event,
          event,
          type: "http",
          url: `http://127.0.0.1:${hookPort}/check`,
          enabled: true,
          matcher: "*"
        }))
      )
    )
    await writeFile(join(settings, "plugins.json"), "[]")
    const requests: TestModelRequest[] = []
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk)
      requests.push(testModelRequest.parse(JSON.parse(Buffer.concat(chunks).toString())))
      res.setHeader("Content-Type", "text/event-stream")
      res.write(
        `data: ${JSON.stringify({ id: "final-test", object: "chat.completion.chunk", created: 1, model: "gpt-test", choices: [{ index: 0, delta: { role: "assistant", content: "ACTUAL_GRAPH_FINAL" }, finish_reason: null }] })}\n\n`
      )
      res.write(
        `data: ${JSON.stringify({ id: "final-test", object: "chat.completion.chunk", created: 1, model: "gpt-test", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`
      )
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
    const port = (server.address() as { port: number }).port
    const modelFile = join(dir, "models.private")
    await writeBotModelSnapshot(modelFile, {
      version: 1,
      defaultRef: "loopback",
      models: [
        {
          ref: "loopback",
          id: "loopback",
          name: "Loopback",
          model: "gpt-test",
          baseUrl: `http://127.0.0.1:${port}/v1`,
          apiKey: "fixture-only"
        }
      ],
      hookSources: { root: settings }
    })
    const store = new BotStore(join(dir, "bots.sqlite"))
    cleanup.push(() => store.close())
    const a = store.createBot({ nonce: "a", name: "A" }),
      b = store.createBot({ nonce: "b", name: "B" })
    store.send({
      nonce: "goal",
      conversationId: a.conversationId,
      text: "ACTUAL_ORIGINAL_USER_GOAL"
    })
    const parent = store.claim("a")!,
      sent = store.sendPeer(parent.lease, {
        nonce: "assign",
        recipient: b.bot.id,
        text: "Verify evidence"
      })
    store.waitForPeer(parent.lease, sent.runIds[0])
    const child = store.claim("b")!
    const peer = store.sendPeer(child.lease, {
      nonce: "false-fact",
      recipient: a.bot.id,
      text: "FALSE_BOT_FACT_DO_NOT_LABEL_USER",
      intent: "status"
    })
    const files = new BotArtifacts(join(dir, "objects"), store)
    cleanup.push(() => files.close())
    const documents = new BotDocumentReader({
      entry: resolve("src/main/bots/document-worker-entry.ts"),
      execArgv: ["--import", "tsx"]
    })
    let imageMessageId: string | undefined
    if (image) {
      const artifact = await files.publish(
        {
          id: "actual-graph-chart",
          conversationId: b.conversationId,
          runId: child.run.id,
          name: "chart.png",
          mime: "image/png"
        },
        Buffer.from(await avatarImage(), "base64"),
        child.lease
      )
      imageMessageId = JSON.parse(
        await sendReviewedBotPeer(
          {
            store,
            ...child,
            bot: b.bot,
            messages: store.messagesForRun(child.run.id),
            signal: new AbortController().signal
          },
          {
            callId: "exact-image",
            recipient: a.bot.id,
            text: "BOT_CHART_AS_DATA_ONLY",
            intent: "status",
            images: [{ artifact_id: artifact.id, alt: "Actual chart" }]
          },
          () => store.assertDispatch(child.lease),
          async (id, action, operation, commit) => {
            const ask = store.requestInteraction(child.lease, {
              kind: "approval",
              prompt: JSON.stringify(action),
              action
            })
            store.answerInteraction({
              id: ask.id,
              revision: ask.revision,
              answer: "approve"
            })
            const apply = () =>
              store.approvedToolOnce(child.lease, { id, action, approvalId: ask.id }, operation)
            return commit ? commit(apply) : apply()
          },
          files,
          documents
        )
      ).messageId
    }
    expect(() => store.steering.interruptIfPending(parent.lease)).toThrow(/补充/)
    const human = store.send({
      nonce: "real-human",
      conversationId: a.conversationId,
      steerRunId: parent.run.id,
      text: "ACTUAL_HUMAN_SUPPLEMENT"
    })
    const accepted = await store.steering
      .queue(parent.lease, (message) =>
        prepareBotPeerImages(
          {
            store,
            ...parent,
            bot: a.bot,
            messages: store.messagesForRun(parent.run.id),
            signal: new AbortController().signal
          },
          files,
          documents,
          () => store.assertDispatch(parent.lease),
          message
        )
      )
      .take({
        threadId: parent.run.id,
        ownerRunToken: `${parent.lease.owner}:${parent.lease.fence}`,
        appliedIds: [],
        phase: "beforeModel"
      })
    expect(accepted.map((m) => m.id)).toEqual([
      peer.messageId,
      ...(imageMessageId ? [imageMessageId] : []),
      human.messageId
    ])
    const actions: unknown[] = [],
      requestInteraction = store.requestInteraction.bind(store)
    vi.spyOn(store, "requestInteraction").mockImplementation((lease, input) => {
      const ask = requestInteraction(lease, input)
      if (input.kind === "approval") {
        expect(JSON.parse(ask.prompt)).toHaveProperty("hook")
        actions.push(input.action)
        queueMicrotask(() =>
          store.answerInteraction({
            id: ask.id,
            revision: ask.revision,
            answer: "approve"
          })
        )
      }
      return ask
    })
    const computer = new LocalBotComputerProvider(join(dir, "browser"))
    cleanup.push(() => computer.shutdown())
    const runtime = new CmbBotRuntime(modelFile, computer, {
      files,
      documents
    })
    cleanup.push(() => runtime.functionSessions.close())
    cleanup.push(() => runtime.shellServices.close())
    cleanup.push(() => runtime.modelChecks.close())
    const result = await runtime.execute({
      store,
      run: store.getRun(parent.run.id),
      lease: parent.lease,
      bot: a.bot,
      messages: store.messagesForRun(parent.run.id),
      signal: new AbortController().signal
    })
    expect(result).toBe("ACTUAL_GRAPH_FINAL")
    expect(JSON.stringify(requests)).toContain("FALSE_BOT_FACT_DO_NOT_LABEL_USER")
    expect(JSON.stringify(requests)).toContain("ACTUAL_HUMAN_SUPPLEMENT")
    const stop = hooks.filter((h) => h.hook_event_name === "Stop")
    expect(stop).toHaveLength(1)
    const context = stop[0].stop_context as { userMessage: string }
    expect(context.userMessage).toContain("ACTUAL_ORIGINAL_USER_GOAL")
    expect(context.userMessage).toContain("ACTUAL_HUMAN_SUPPLEMENT")
    expect(context.userMessage).not.toContain("FALSE_BOT_FACT_DO_NOT_LABEL_USER")
    expect(context.userMessage).not.toContain("BOT_CHART_AS_DATA_ONLY")
    if (image) {
      const imageParts = requests.flatMap((r) =>
        r.messages.flatMap((m) =>
          Array.isArray(m.content) ? m.content.filter((p) => p.type === "image_url") : []
        )
      )
      expect(imageParts).toHaveLength(1)
      expect(imageParts[0].image_url?.url).toMatch(/^data:image\/jpeg;base64,/)
    }
    const submits = hooks.filter((h) => h.hook_event_name === "UserPromptSubmit")
    expect(submits).toHaveLength(2)
    expect(JSON.stringify(submits)).not.toContain("FALSE_BOT_FACT_DO_NOT_LABEL_USER")
    expect(JSON.stringify(submits)).not.toContain("BOT_CHART_AS_DATA_ONLY")
    expect(actions).toHaveLength(3)
    expect(store.effects(parent.run.id).every((e) => e.status === "succeeded")).toBe(true)
  },
  10000
)
