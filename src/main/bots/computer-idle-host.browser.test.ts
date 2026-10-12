import { afterEach, describe, expect, it, vi } from "vitest"
import { createServer } from "node:http"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import type { BrowserContext } from "playwright"
import { LocalBotComputerProvider } from "./computer-provider"
import { BotHost, type BotRuntimePort } from "./host"
import { BotStore } from "./store"
import { waitForBotComputer } from "./computer-wait"
const cleanup: (() => Promise<unknown> | void)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
const until = async (check: () => boolean) => {
  const end = Date.now() + 5000
  while (!check()) {
    if (Date.now() > end) throw Error("Host idle fixture deadline")
    await delay(25)
  }
}
describe.runIf(process.env.CMB_BOT_BROWSER_TEST === "1")(
  "Host task lifetime versus browser idle",
  () => {
    it.each(["approval", "question"] as const)(
      "keeps the actual %s waiting_input run/form live, then lazily wakes for the next message",
      async (kind) => {
        const directory = await mkdtemp(join(tmpdir(), "cmb-idle-host-"))
        cleanup.push(() => rm(directory, { recursive: true, force: true }))
        const server = createServer((_request, response) => {
          response.setHeader("content-type", "text/html")
          response.end(
            '<html><body><input aria-label="Draft"><button>Continue</button></body></html>'
          )
        })
        await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
        cleanup.push(async () => {
          server.closeAllConnections()
          await new Promise<void>((done) => server.close(() => done()))
        })
        const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
        const computer = new LocalBotComputerProvider(
          join(directory, "profile"),
          process.env.CMB_BOT_BROWSER_CHANNEL ?? "chrome",
          { idleAfterMs: 250 }
        )
        cleanup.push(() => computer.close())
        const store = new BotStore(join(directory, "bots.sqlite"))
        cleanup.push(() => store.close())
        computer.persistence = store
        const { bot, conversationId } = store.createBot({ nonce: "bot", name: "Idle worker" })
        let release!: () => void,
          interactionId: string | undefined,
          turns = 0
        const gate = new Promise<void>((done) => {
          release = done
        })
        const host = new BotHost(
          store,
          {
            execute: async (request) => {
              const broker = await computer.get(),
                target = await broker.ensure(bot.id)
              turns++
              if (turns === 1) {
                await broker.act(target, { op: "navigate", url }, () => {})
                const page = (broker as unknown as { context: BrowserContext }).context.pages()[0]
                await page.getByRole("textbox").fill("pending user work")
                interactionId = store.requestInteraction(request.lease, {
                  kind,
                  prompt: "Confirm this form",
                  ...(kind === "approval"
                    ? { action: { browser: { op: "fill" }, botId: bot.id, target } }
                    : {})
                }).id
                await gate
                expect(await page.getByRole("textbox").inputValue()).toBe("pending user work")
                return "waiting completed"
              }
              expect(await waitForBotComputer(request, computer)).toBe(true)
              expect(broker.requiresObservation(bot.id)).toBe(true)
              await broker.act(target, { op: "snapshot" }, () => {})
              expect(broker.requiresObservation(bot.id)).toBe(false)
              return "new message completed after fresh observation"
            }
          },
          4,
          computer
        )
        cleanup.push(() => host.stop())
        const run = store.send({ nonce: "first", conversationId, text: "Prepare a form and wait" })
          .runIds[0]!
        host.tick()
        await until(() => Boolean(interactionId))
        expect(store.getRun(run).status).toBe("waiting_input")
        await delay(600)
        expect(computer.status().state).toBe("ready")
        const answer = store.getInteraction(interactionId!)
        store.answerInteraction({
          id: answer.id,
          revision: answer.revision,
          answer: kind === "approval" ? "approve" : "continue"
        })
        release()
        await until(() => store.getRun(run).status === "succeeded")
        await until(() => computer.status().state === "stopped")
        expect(store.getRun(run).status).toBe("succeeded")
        expect(store.loadBrowserSession(bot.id)?.urls).toEqual([url + "/"])
        const next = store.send({ nonce: "second", conversationId, text: "Continue the work" })
          .runIds[0]!
        host.tick()
        await until(() => store.getRun(next).status === "succeeded")
        expect(turns).toBe(2)
        expect(computer.status().state).toBe("ready")
      },
      15000
    )
    it("keeps the original form for a durable needs_review task after its executor has settled", async () => {
      const directory = await mkdtemp(join(tmpdir(), "cmb-idle-review-"))
      cleanup.push(() => rm(directory, { recursive: true, force: true }))
      const server = createServer((_request, response) => {
        response.setHeader("content-type", "text/html")
        response.end('<html><body><input aria-label="Draft"></body></html>')
      })
      await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
      cleanup.push(async () => {
        server.closeAllConnections()
        await new Promise<void>((done) => server.close(() => done()))
      })
      const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
      const computer = new LocalBotComputerProvider(
        join(directory, "profile"),
        process.env.CMB_BOT_BROWSER_CHANNEL ?? "chrome",
        { idleAfterMs: 250 }
      )
      cleanup.push(() => computer.close())
      const store = new BotStore(":memory:")
      cleanup.push(() => store.close())
      computer.persistence = store
      const { bot, conversationId } = store.createBot({ nonce: "bot", name: "Review worker" })
      let ready = false
      const host = new BotHost(
        store,
        {
          execute: async (request) => {
            const broker = await computer.get(),
              target = await broker.ensure(bot.id)
            await broker.act(target, { op: "navigate", url }, () => {})
            await (broker as unknown as { context: BrowserContext }).context
              .pages()[0]
              .getByRole("textbox")
              .fill("must survive review")
            ready = true
            await new Promise<never>((_, reject) =>
              request.signal.addEventListener("abort", () => reject(request.signal.reason), {
                once: true
              })
            )
            return "unreachable"
          }
        },
        4,
        computer
      )
      cleanup.push(() => host.stop())
      const run = store.send({
        nonce: "task",
        conversationId,
        text: "Preserve this interrupted form"
      }).runIds[0]!
      host.tick()
      await until(() => ready)
      store.fenceOwner(host.id, "fixture interruption requiring human review")
      host.tick()
      await delay(700)
      expect(store.getRun(run).status).toBe("needs_review")
      expect(computer.status().state).toBe("ready")
      const broker = await computer.get()
      expect(
        await (broker as unknown as { context: BrowserContext }).context
          .pages()[0]
          .getByRole("textbox")
          .inputValue()
      ).toBe("must survive review")
      store.recover({
        id: run,
        revision: store.getRun(run).revision,
        decision: "cancel",
        note: "Checked fixture form; no external action",
        effects: []
      })
      await until(() => computer.status().state === "stopped")
    }, 15000)
    it("can idle the browser while an unrelated keepAlive HTTP service remains busy and available", async () => {
      const directory = await mkdtemp(join(tmpdir(), "cmb-idle-service-"))
      cleanup.push(() => rm(directory, { recursive: true, force: true }))
      const server = createServer((_request, response) => {
        response.end("<html><body>Independent service</body></html>")
      })
      await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
      cleanup.push(async () => {
        server.closeAllConnections()
        await new Promise<void>((done) => server.close(() => done()))
      })
      const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
      const computer = new LocalBotComputerProvider(
        join(directory, "profile"),
        process.env.CMB_BOT_BROWSER_CHANNEL ?? "chrome",
        { idleAfterMs: 250 }
      )
      cleanup.push(() => computer.close())
      const store = new BotStore(":memory:")
      cleanup.push(() => store.close())
      computer.persistence = store
      const { bot, conversationId } = store.createBot({
        nonce: "bot",
        name: "Service independent worker"
      })
      // The runtime busy port is backed by a real long-lived HTTP server. Native
      // shell containment is outside this browser-lifetime fixture's verdict.
      const services = {
        get busy() {
          return server.listening
        },
        bind: vi.fn(),
        tick: vi.fn(),
        abort: vi.fn(),
        hasRun() {
          return false
        },
        close: vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
      }
      const runtime = {
        shellServices: services,
        execute: async () => {
          const broker = await computer.get(),
            target = await broker.ensure(bot.id)
          await broker.act(target, { op: "navigate", url }, () => {})
          return "Browser work completed; independent service remains running"
        }
      } as unknown as BotRuntimePort
      const host = new BotHost(store, runtime, 4, computer)
      cleanup.push(() => host.stop())
      const run = store.send({ nonce: "work", conversationId, text: "Check the service once" })
        .runIds[0]!
      host.tick()
      await until(() => store.getRun(run).status === "succeeded")
      expect(services.busy).toBe(true)
      expect(services.abort).not.toHaveBeenCalled()
      expect(store.hasUnfinishedWork()).toBe(false)
      await until(() => computer.status().state === "stopped")
      expect(services.busy).toBe(true)
      expect(await (await fetch(url)).text()).toContain("Independent service")
    }, 15000)
  }
)
