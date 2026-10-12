import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { chromium, type Browser, type Frame } from "playwright"
import { createServer, type Server } from "node:http"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { BotBrowserBroker } from "./browser-broker"
import { BotStore } from "./store"
import { BotTeachService } from "./teach-service"
import type { LocalBotComputerProvider } from "./computer-provider"
import { teachHasSensitiveInput } from "./teach-observation"

const contextError = "Execution context was destroyed, most likely because of a navigation"
describe.runIf(process.env.CMB_BOT_BROWSER_TEST === "1")("Teach navigation safety gate", () => {
  let browser: Browser, server: Server, url: string
  const cleanup: (() => Promise<unknown> | void)[] = []
  beforeAll(async () => {
    browser = await chromium.launch({ channel: "chrome", headless: true })
    server = createServer((request, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8")
      if (request.url?.startsWith("/secret"))
        response.end('<input type="password" aria-label="密码">')
      else
        response.end(`<title>月报</title><form action="/demo" method="get">
        <input type="hidden" name="submitted" value="1"><input type="month" name="month" value="2026-09">
        <select name="region"><option value="东区">东区</option><option value="西区">西区</option></select>
        <button>生成月报</button></form><output>${request.url?.includes("submitted=1") ? "31" : ""}</output>`)
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    for (const close of cleanup.splice(0).reverse()) await close()
  })
  afterAll(async () => {
    await browser?.close()
    server?.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }, 30_000)
  async function pageFixture() {
    const context = await browser.newContext()
    cleanup.push(() => context.close())
    const page = await context.newPage()
    await page.goto(`${url}/demo`)
    return page
  }
  // Only synthesize the driver error at its existing boundary; the successful
  // scans, documents, frame replacement and navigation use actual Chromium.
  function fault(frame: Frame, state: { remaining: number; message: string; attempts: number }) {
    const originalEvaluate = frame.evaluate.bind(frame)
    const originalHandle = frame.evaluateHandle.bind(frame)
    const throwIfNeeded = () => {
      state.attempts++
      if (state.remaining > 0) {
        state.remaining--
        throw new Error(state.message)
      }
    }
    vi.spyOn(frame, "evaluate").mockImplementation(async (...args) => {
      throwIfNeeded()
      return originalEvaluate(...args)
    })
    vi.spyOn(frame, "evaluateHandle").mockImplementation(async (...args) => {
      throwIfNeeded()
      return originalHandle(...args)
    })
  }
  it("recognizes ordinary month/region controls as safe", async () => {
    expect(await teachHasSensitiveInput(await pageFixture())).toBe(false)
  })
  it("retries one destroyed context and rechecks the new actual document", async () => {
    const page = await pageFixture()
    await page.goto(`${url}/demo?submitted=1&month=2026-09&region=东区`)
    const state = { remaining: 1, message: contextError, attempts: 0 }
    fault(page.mainFrame(), state)
    expect(await teachHasSensitiveInput(page)).toBe(false)
    expect(state.attempts).toBe(2)
    expect(await page.locator("output").textContent()).toBe("31")
  })
  it("recovers an actual Chromium document context destroyed during the gate", async () => {
    const page = await pageFixture()
    const frame = page.mainFrame(),
      original = frame.evaluateHandle.bind(frame)
    let actualContextError = false
    vi.spyOn(frame, "evaluateHandle").mockImplementationOnce(async (...args) => {
      const handle = await original(...args)
      await page.goto(`${url}/demo?submitted=1&month=2026-09&region=东区`)
      const evaluate = handle.evaluate.bind(handle)
      vi.spyOn(handle, "evaluate").mockImplementationOnce(async (...input) => {
        try {
          return await evaluate(...input)
        } catch (error) {
          actualContextError =
            error instanceof Error && error.message.includes("Execution context was destroyed")
          throw error
        }
      })
      return handle
    })
    expect(await teachHasSensitiveInput(page)).toBe(false)
    expect(actualContextError).toBe(true)
    expect(await page.locator("output").textContent()).toBe("31")
  })
  it("pauses after exactly three destroyed contexts", async () => {
    const page = await pageFixture()
    const state = { remaining: 99, message: contextError, attempts: 0 }
    fault(page.mainFrame(), state)
    expect(await teachHasSensitiveInput(page)).toBe(true)
    expect(state.attempts).toBe(3)
  })
  it("does not retry an unrelated driver failure", async () => {
    const page = await pageFixture()
    const state = { remaining: 99, message: "Permission denied", attempts: 0 }
    fault(page.mainFrame(), state)
    expect(await teachHasSensitiveInput(page)).toBe(true)
    expect(state.attempts).toBe(1)
  })
  it("does not treat a password in the new document as safe after navigation", async () => {
    const page = await pageFixture()
    await page.goto(`${url}/secret`)
    const state = { remaining: 1, message: contextError, attempts: 0 }
    fault(page.mainFrame(), state)
    expect(await teachHasSensitiveInput(page)).toBe(true)
    expect(state.attempts).toBe(2)
  })
  it("re-reads a changed frame set and rejects its new protected input", async () => {
    const page = await pageFixture()
    const frame = page.mainFrame(),
      original = frame.evaluateHandle.bind(frame)
    let inserted = false
    vi.spyOn(frame, "evaluateHandle").mockImplementation(async (...args) => {
      const handle = await original(...args)
      if (!inserted) {
        const evaluate = handle.evaluate.bind(handle)
        vi.spyOn(handle, "evaluate").mockImplementationOnce(async (...input) => {
          const result = await evaluate(...input)
          inserted = true
          await page.evaluate(() => {
            const child = document.createElement("iframe")
            child.srcdoc = '<input type="password">'
            document.body.append(child)
          })
          await page.locator("iframe").contentFrame().locator('input[type="password"]').waitFor()
          return result
        })
      }
      return handle
    })
    expect(await teachHasSensitiveInput(page)).toBe(true)
    expect(inserted).toBe(true)
  })
  it("releases every actual document handle on failed and successful passes", async () => {
    const page = await pageFixture()
    const frame = page.mainFrame(),
      original = frame.evaluateHandle.bind(frame)
    let issued = 0,
      disposed = 0
    vi.spyOn(frame, "evaluateHandle").mockImplementation(async (...args) => {
      expect(issued).toBe(disposed)
      const handle = await original(...args)
      issued++
      const dispose = handle.dispose.bind(handle)
      vi.spyOn(handle, "dispose").mockImplementation(async () => {
        disposed++
        await dispose()
      })
      if (issued === 1) vi.spyOn(handle, "evaluate").mockRejectedValueOnce(new Error(contextError))
      return handle
    })
    expect(await teachHasSensitiveInput(page)).toBe(false)
    expect(issued).toBe(2)
    expect(disposed).toBe(issued)
  })
  it("returns unsafe if the page closes during the retry window", async () => {
    const page = await pageFixture()
    let entered!: () => void, release!: () => void
    const gateEntered = new Promise<void>((resolve) => {
      entered = resolve
    })
    const continueGate = new Promise<void>((resolve) => {
      release = resolve
    })
    const read = vi.spyOn(page.mainFrame(), "evaluateHandle").mockImplementationOnce(async () => {
      entered()
      await continueGate
      throw new Error(contextError)
    })
    const pending = teachHasSensitiveInput(page)
    await gateEntered
    try {
      // The driver continuation is held until physical closure has completed.
      // This proves lifecycle handling without racing a timer under CPU load.
      await page.close()
    } finally {
      release()
    }
    expect(await pending).toBe(true)
    expect(read).toHaveBeenCalledTimes(1)
  })
  async function serviceFixture() {
    const directory = await mkdtemp(join(tmpdir(), "cmb-teach-navigation-"))
    cleanup.push(() => rm(directory, { recursive: true, force: true }))
    const context = await browser.newContext()
    const broker = new BotBrowserBroker(context)
    cleanup.push(() => broker.close())
    const store = new BotStore(":memory:")
    cleanup.push(() => store.close())
    const { bot, conversationId } = store.createBot({ nonce: "month", name: "月报助手" })
    let target = await broker.ensure(bot.id)
    target = (await broker.act(target, { op: "navigate", url: `${url}/demo` }, () => {})).target
    const computer = { get: async () => broker } as LocalBotComputerProvider
    const teach = new BotTeachService(directory, store, computer)
    cleanup.push(() => teach.close())
    const session = await teach.start({ botId: bot.id, conversationId, nonce: "start", target })
    const page = context.pages().find((item) => item.url().includes("/demo"))!
    const deadline = Date.now() + 5000
    while (!teach.repository.get(session.id).frameCount) {
      if (Date.now() > deadline) throw new Error("No Teach frame")
      await delay(20)
    }
    return { broker, store, teach, session, bot, page }
  }
  it.each([1, 99])(
    "keeps completed form submit recorded or safely pauses (%s context errors)",
    async (errors) => {
      const f = await serviceFixture()
      const state = { remaining: 0, message: contextError, attempts: 0 }
      fault(f.page.mainFrame(), state)
      const click = f.page.mouse.click.bind(f.page.mouse)
      vi.spyOn(f.page.mouse, "click").mockImplementation(async (...args) => {
        await click(...args)
        state.remaining = errors
        state.attempts = 0
      })
      const beforeFrames = f.teach.repository.get(f.session.id).frameCount
      const rect = await f.page.locator("button").boundingBox()
      const frame = await f.broker.frame(f.bot.id)
      await f.broker.humanInput(frame, {
        kind: "click",
        x: Math.floor(rect!.x + rect!.width / 2),
        y: Math.floor(rect!.y + rect!.height / 2),
        frameSeq: frame.frameSeq
      })
      expect(await f.page.locator("output").textContent()).toBe("31")
      const session = f.teach.repository.get(f.session.id)
      if (errors === 1) {
        expect(session.phase).toBe("recording")
        expect(f.teach.repository.events(session.id).some((event) => event.kind === "click")).toBe(
          true
        )
      } else {
        expect(session.phase).toBe("paused")
        expect(session.frameCount).toBe(beforeFrames)
      }
    },
    15000
  )
})
