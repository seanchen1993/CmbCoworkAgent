import { afterEach, expect, it, vi } from "vitest"
import { createServer } from "node:http"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { randomBytes } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import type { BotInteraction, BotRun } from "../../shared/bot-types"
import { readBotComputerHelp } from "../../shared/bot-computer-help"
import { BotStore } from "./store"
import { BotHost } from "./host"
import { BotHostLock } from "./host-lock"
import { BotRpcServer } from "./rpc"
import { BotTransportClient } from "./transport-client"
import { CmbBotRuntime } from "./agent-runtime"
import { LocalBotComputerProvider } from "./computer-provider"
import { writeBotModelSnapshot } from "./model-config"
import { testModelRequest, type TestModelRequest } from "./test-model-protocol"

const cleanup: (() => Promise<unknown> | void)[] = []
afterEach(async () => {
  const errors: unknown[] = []
  for (const close of cleanup.splice(0).reverse()) {
    try {
      await close()
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length) throw new AggregateError(errors, "Computer help fixture cleanup failed")
})

it.runIf(process.env.CMB_BOT_BROWSER_TEST === "1")(
  "pauses the original createAgent graph for manual help, returns control once through authenticated RPC, and continues with a fresh screenshot",
  async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "cmb-help-graph-")))
    cleanup.push(() => rm(directory, { recursive: true, force: true }))
    await mkdir(join(directory, "host"))
    const lock = BotHostLock.acquire(join(directory, "host"))!
    cleanup.push(() => lock.release())
    const store = new BotStore(join(directory, "bots.sqlite"))
    cleanup.push(() => store.close())
    const created = store.createBot({ nonce: "create", name: "人工确认" })
    const requests: TestModelRequest[] = []
    const events: { phase: string; time: number }[] = []
    const mark = (phase: string) => events.push({ phase, time: Date.now() })
    let helpReady!: (value: BotInteraction) => void
    const helpPending = new Promise<BotInteraction>((resolve) => {
      helpReady = resolve
    })
    const requestInteraction = store.requestInteraction.bind(store)
    const interactionObserver = vi
      .spyOn(store, "requestInteraction")
      .mockImplementation((...args) => {
        const result = requestInteraction(...args)
        if (readBotComputerHelp(result.prompt)) {
          mark("help-committed")
          helpReady(result)
        }
        return result
      })
    let finished!: (value: BotRun) => void
    const settled = new Promise<BotRun>((resolve) => {
      finished = resolve
    })
    const finish = store.finish.bind(store)
    const finishObserver = vi.spyOn(store, "finish").mockImplementation((...args) => {
      const result = finish(...args)
      mark(`run-${result.status}`)
      finished(result)
      return result
    })
    cleanup.push(() => {
      interactionObserver.mockRestore()
      finishObserver.mockRestore()
    })
    const server = createServer(async (req, res) => {
      if (req.url === "/manual-confirmation") {
        res.setHeader("Content-Type", "text/html")
        res.end(
          "<!doctype html><title>MANUAL_STEP_COMPLETE</title><body style='background:#225533;color:white;font:36px sans-serif'>Manual confirmation complete</body>"
        )
        return
      }
      try {
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(chunk)
        const body = testModelRequest.parse(JSON.parse(Buffer.concat(chunks).toString()))
        requests.push(body)
        mark(`model-${requests.length}`)
        const tool = body.messages.some((message) => message.role === "tool")
        const message = tool
          ? { content: "MANUAL_CONFIRMATION_OBSERVED" }
          : {
              tool_calls: [
                {
                  id: "help-call-once",
                  type: "function",
                  function: {
                    name: "request_computer_help",
                    arguments: JSON.stringify({
                      backend: "browser",
                      reason: "other",
                      instruction: "请在浏览器完成页面确认"
                    })
                  }
                }
              ]
            }
        res.setHeader("Content-Type", "text/event-stream")
        const delta = (value: unknown, reason: string | null = null) =>
          res.write(
            `data: ${JSON.stringify({ id: `fixture-${requests.length}`, object: "chat.completion.chunk", created: 1, model: "gpt-test", choices: [{ index: 0, delta: value, finish_reason: reason }] })}\n\n`
          )
        delta({
          role: "assistant",
          ...(message.tool_calls
            ? { tool_calls: message.tool_calls.map((call, index) => ({ index, ...call })) }
            : { content: message.content })
        })
        delta({}, message.tool_calls ? "tool_calls" : "stop")
        res.end("data: [DONE]\n\n")
      } catch {
        res.statusCode = 500
        res.end("Controlled model request was invalid")
      }
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    cleanup.push(
      () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections()
          server.close(() => resolve())
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
    const runtime = new CmbBotRuntime(modelFile, computer)
    const host = new BotHost(store, runtime, 2, computer)
    host.bindOwnership(lock)
    cleanup.push(() => host.stop())
    const token = randomBytes(32).toString("hex")
    const socketPath =
      process.platform === "win32"
        ? `\\\\.\\pipe\\help-${token.slice(0, 16)}`
        : join(directory, "help.sock")
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
    const send = await client.call("send", {
      nonce: "help-task",
      conversationId: created.conversationId,
      text: "完成一次页面确认后继续"
    })
    host.start()
    const interaction = await helpPending
    const card = readBotComputerHelp(interaction.prompt)!
    expect(card).toMatchObject({
      botId: created.bot.id,
      runId: send.runIds[0],
      backend: "browser",
      hostId: host.id,
      dataEpoch: store.dataEpoch()
    })
    expect(store.getRun(send.runIds[0]).status).toBe("waiting_input")
    expect(requests).toHaveLength(1)
    expect(requests[0].tools.some((tool) => tool.function.name === "request_computer_help")).toBe(
      true
    )
    // Hold across the original graph wait cadence: no model continuation or child dispatch.
    await delay(350)
    expect(requests).toHaveLength(1)
    expect(store.db.exec("SELECT count(*) FROM bot_runs")[0].values[0][0]).toBe(1)
    expect(store.getRun(send.runIds[0]).status).toBe("waiting_input")
    const broker = await computer.get()
    const release = vi.spyOn(broker, "releaseControl")
    const act = broker.act.bind(broker)
    const screenshots: string[] = []
    const actionObserver = vi.spyOn(broker, "act").mockImplementation(async (...args) => {
      const result = await act(...args)
      const action = args[1]
      if (
        typeof action === "object" &&
        action !== null &&
        "op" in action &&
        action.op === "screenshot"
      ) {
        expect(args[0].control).toBe("bot")
        if (result.image) screenshots.push(result.image)
        mark("fresh-screenshot")
      }
      return result
    })
    cleanup.push(() => {
      release.mockRestore()
      actionObserver.mockRestore()
    })
    const target = await client.call("computerOpen", created.bot.id)
    const human = await client.call("computerTake", {
      ...target,
      conversationId: created.conversationId
    })
    const before = await client.call("computerFrame", created.bot.id)
    expect(before).toMatchObject({
      control: "human",
      controlOwner: "self",
      generation: card.generation
    })
    await client.call("computerInput", {
      target: human,
      input: {
        frameSeq: before.frameSeq,
        kind: "navigate",
        url: `http://127.0.0.1:${port}/manual-confirmation`
      }
    })
    const displayed = await client.call("computerFrame", created.bot.id)
    expect(displayed.title).toBe("MANUAL_STEP_COMPLETE")
    expect(displayed.image).not.toBe(before.image)
    const answer = {
      id: interaction.id,
      revision: interaction.revision,
      answer: "done",
      computerHelpTarget: { backend: "browser" as const, target: displayed }
    }
    const accepted = await client.call("answer", answer)
    expect(accepted).toMatchObject({ id: interaction.id, status: "answered", answer: "done" })
    expect(await client.call("answer", answer)).toEqual(accepted)
    expect(release).toHaveBeenCalledTimes(1)
    expect(await settled).toMatchObject({
      id: send.runIds[0],
      status: "succeeded",
      error: null,
      result: "MANUAL_CONFIRMATION_OBSERVED"
    })
    expect(requests).toHaveLength(2)
    const blocks = requests[1].messages
      .filter((message) => message.role === "tool")
      .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    expect(
      blocks.some((part) => part.type === "text" && part.text?.includes('"humanHelp":"returned"'))
    ).toBe(true)
    expect(blocks.find((part) => part.type === "image_url")?.image_url?.url).toBe(screenshots[0])
    expect(screenshots).toHaveLength(1)
    expect(screenshots[0]).not.toBe(before.image)
    expect(store.db.exec("SELECT count(*) FROM bot_runs")[0].values[0][0]).toBe(1)
    expect(
      store.db.exec("SELECT count(*) FROM bot_receipts WHERE nonce=?", [
        `computer-help-return:${interaction.id}`
      ])[0].values[0][0]
    ).toBe(1)
    const messages = store.messages(created.conversationId)
    expect(messages.filter((message) => message.text.includes("人工操作已完成"))).toHaveLength(1)
    expect(messages.some((message) => message.text.includes('"botComputerHelp"'))).toBe(false)
    expect(broker.target(created.bot.id).control).toBe("bot")
    const screenshotAt = events.findIndex((event) => event.phase === "fresh-screenshot")
    expect(screenshotAt).toBeGreaterThan(
      events.findIndex((event) => event.phase === "help-committed")
    )
    expect(screenshotAt).toBeLessThan(events.findIndex((event) => event.phase === "model-2"))
    const evidence = process.env.CMB_BOT_COMPUTER_HELP_EVIDENCE
    if (evidence) {
      await mkdir(evidence, { recursive: true })
      await writeFile(
        join(evidence, "runtime-events.json"),
        JSON.stringify(
          {
            events,
            runId: send.runIds[0],
            interactionId: interaction.id,
            modelRequests: requests.length,
            releases: release.mock.calls.length,
            screenshots: screenshots.length,
            sameRun: true,
            backend: "browser"
          },
          null,
          2
        ) + "\n"
      )
    }
  },
  30_000
)
