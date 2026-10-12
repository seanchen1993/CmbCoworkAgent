import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { randomBytes } from "node:crypto"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { BotStore } from "./store"
import { BotHost, type BotRuntimePort, type BotRuntimeRequest } from "./host"
import { BotHostLock } from "./host-lock"
import { BotRpcServer } from "./rpc"
import { BotTransportClient } from "./transport-client"
import { LocalBotComputerProvider } from "./computer-provider"
import { BotTeachService } from "./teach-service"

const cleanup: (() => void | Promise<unknown>)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function fixture(
  options: {
    wall?: () => number
    monotonic?: () => number
    runtime?: BotRuntimePort
    physicalOwner?: boolean
  } = {}
) {
  const root = await mkdtemp(join(tmpdir(), "cmb-computer-owner-"))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const lock = options.physicalOwner ? BotHostLock.acquire(await realpath(root)) : undefined
  if (options.physicalOwner) expect(lock).toBeTruthy()
  if (lock) cleanup.push(() => lock.release())
  const store = new BotStore(join(root, "state.sqlite"), options.wall)
  cleanup.push(() => store.close())
  const computer = new LocalBotComputerProvider(join(root, "browser"))
  computer.persistence = store
  cleanup.push(() => computer.close())
  const teach = new BotTeachService(join(root, "teach"), store, computer)
  cleanup.push(() => teach.close())
  const host = new BotHost(store, options.runtime, 4, computer, undefined, teach, options.monotonic)
  if (lock) host.bindOwnership(lock)
  cleanup.push(() => host.stop())
  const token = randomBytes(32).toString("hex")
  const path =
    process.platform === "win32"
      ? `\\\\.\\pipe\\bot-owner-${token.slice(0, 16)}`
      : join(root, "rpc.sock")
  const rpc = new BotRpcServer(host, token)
  await rpc.listen(path)
  cleanup.push(() => rpc.close())
  const client = () => {
    const value = new BotTransportClient({
      version: 1,
      pid: process.pid,
      hostId: host.id,
      socketPath: path,
      token
    })
    cleanup.push(() => value.close())
    return value
  }
  const a = client(),
    b = client()
  const { bot, conversationId } = await a.call("create", { nonce: "owner-bot", name: "Ownership" })
  await a.call("computerOpen", bot.id)
  return { a, b, client, bot, conversationId, store, computer, teach, host }
}

// Actual Chromium and authenticated sockets; no user profile or external service.
describe.runIf(process.env.CMB_BOT_BROWSER_TEST === "1")("browser client ownership", () => {
  it("reserves popup slots before asynchronous registration and closes them during deletion", async () => {
    const f = await fixture(),
      broker = await f.computer.get()
    await f.a.call("computerTake", await f.a.call("computerFrame", f.bot.id))
    const page = await broker.teachObserve(f.bot.id, async (value) => value)
    const context = page.context(),
      attach = context.newCDPSession.bind(context)
    let release!: () => void
    const barrier = new Promise<void>((done) => {
      release = done
    })
    let registrations = 0
    const interception = vi.spyOn(context, "newCDPSession").mockImplementation(async (target) => {
      registrations++
      await barrier
      return attach(target)
    })
    try {
      await page.evaluate(() => {
        for (let index = 0; index < 32; index++) window.open("about:blank")
      })
      await expect.poll(() => registrations).toBe(29)
      await expect.poll(() => context.pages().length).toBeLessThanOrEqual(30)
      const deleted = f.a.call("delete", { id: f.bot.id, revision: f.bot.revision })
      await expect.poll(() => context.pages().length).toBe(0)
      release()
      await deleted
      expect(() => broker.target(f.bot.id)).toThrow()
      expect(context.pages()).toHaveLength(0)
    } finally {
      release()
      interception.mockRestore()
    }
  }, 30_000)

  it("interrupts an in-flight page operation and rejects queued work when its Bot is deleted", async () => {
    const f = await fixture(),
      broker = await f.computer.get()
    await f.a.call("computerTake", await f.a.call("computerFrame", f.bot.id))
    let started = false
    const pending = broker
      .teachObserve(f.bot.id, async (page) => {
        started = true
        return page.evaluate(() => new Promise(() => {}))
      })
      .catch((error) => error)
    await expect.poll(() => started).toBe(true)
    const queued = broker.teachObserve(f.bot.id, async () => "must not run").catch((error) => error)
    await f.a.call("delete", { id: f.bot.id, revision: f.bot.revision })
    expect(await pending).toBeInstanceOf(Error)
    expect(await queued).toBeInstanceOf(Error)
    expect(() => broker.target(f.bot.id)).toThrow()
    await expect(broker.ensure(f.bot.id)).rejects.toThrow("已删除")
  }, 20_000)

  it("coalesces navigation persistence while an operation holds the browser queue", async () => {
    const f = await fixture(),
      broker = await f.computer.get()
    await f.a.call("computerTake", await f.a.call("computerFrame", f.bot.id))
    const page = await broker.teachObserve(f.bot.id, async (value) => value)
    const saved = vi.spyOn(f.store, "saveBrowserSession")
    let release!: () => void,
      started = false
    const held = broker.teachObserve(f.bot.id, async () => {
      started = true
      await new Promise<void>((done) => {
        release = done
      })
    })
    try {
      await expect.poll(() => started).toBe(true)
      await page.evaluate(() => {
        for (let index = 0; index < 100; index++) history.pushState({}, "", `#${index}`)
      })
      await expect.poll(() => page.url()).toContain("#99")
      expect(saved).not.toHaveBeenCalled()
    } finally {
      release()
      await held
    }
    await broker.teachObserve(f.bot.id, async () => {})
    expect(saved).toHaveBeenCalledTimes(1)
    expect(f.store.loadBrowserSession(f.bot.id)?.urls[0]).toContain("#99")
  }, 20_000)

  it("releases only the deleted Bot's pages, rejects old targets and acknowledges a lost delete response", async () => {
    const f = await fixture()
    const other = await f.b.call("create", { nonce: "other", name: "Other" })
    await f.b.call("computerOpen", other.bot.id)
    const target = await f.a.call("computerFrame", f.bot.id)
    await f.a.call("computerTake", target)
    const broker = await f.computer.get()
    const page = await broker.teachObserve(f.bot.id, async (value) => value)
    const remove = { id: f.bot.id, revision: f.bot.revision }
    await f.a.call("delete", remove)
    expect(page.isClosed()).toBe(true)
    expect(() => broker.target(f.bot.id)).toThrow()
    await expect(f.a.call("computerFrame", f.bot.id)).rejects.toThrow("已删除")
    await expect(f.a.call("delete", remove)).resolves.toBeNull()
    expect((await f.b.call("computerFrame", other.bot.id)).image).toMatch(/^data:image\/jpeg/)
  }, 20_000)

  it("keeps a Bot and its browser available until an active recording is explicitly finished", async () => {
    const f = await fixture()
    const session = f.teach.repository.create({
      nonce: "record",
      botId: f.bot.id,
      conversationId: f.conversationId
    })
    for (const phase of ["recording", "paused", "finalizing"] as const) {
      f.store.db.run("UPDATE bot_teach_sessions SET phase=? WHERE id=?", [phase, session.id])
      await expect(f.a.call("delete", { id: f.bot.id, revision: f.bot.revision })).rejects.toThrow(
        "示范"
      )
      expect(f.store.getBot(f.bot.id).deletedAt).toBeNull()
      expect((await f.a.call("computerOpen", f.bot.id)).botId).toBe(f.bot.id)
    }
    f.store.db.run("UPDATE bot_teach_sessions SET phase='discarded' WHERE id=?", [session.id])
    await f.a.call("delete", { id: f.bot.id, revision: f.bot.revision })
    expect(() => f.store.getBot(f.bot.id)).toThrow("已删除")
  }, 20_000)

  it("keeps spectators read-only, preserves the owner's frame and fences transfers and disconnects", async () => {
    const f = await fixture()
    expect((await f.a.call("status")).capabilities).toContain("computer-client-ownership")
    await f.a.call("computerTake", {
      ...(await f.a.call("computerFrame", f.bot.id)),
      conversationId: f.conversationId
    })
    const own = await f.a.call("computerFrame", f.bot.id)
    const watched = await f.b.call("computerFrame", f.bot.id)
    expect(own.controlOwner).toBe("self")
    expect(watched).toMatchObject({
      control: "human",
      controlOwner: "other",
      controlOwnerConnected: true
    })
    // Copying the entire owner's frame cannot copy its transport authority.
    await expect(
      f.b.call("computerInput", {
        target: own,
        input: { kind: "click", x: 5, y: 5, frameSeq: own.frameSeq }
      })
    ).rejects.toThrow("另一客户端")
    await expect(f.b.call("computerRelease", watched)).rejects.toThrow("另一客户端")
    await expect(f.b.call("computerTake", watched)).rejects.toThrow("确认转移")
    await f.a.call("computerInput", {
      target: own,
      input: { kind: "click", x: 5, y: 5, frameSeq: own.frameSeq }
    })
    await expect(
      f.a.call("computerInput", {
        target: own,
        input: { kind: "click", x: 5, y: 5, frameSeq: own.frameSeq }
      })
    ).rejects.toThrow("画面已过期")
    const old = await f.a.call("computerFrame", f.bot.id)
    await f.b.call("computerTake", { ...watched, replaceHuman: true })
    await expect(
      f.a.call("computerInput", {
        target: old,
        input: { kind: "key", key: "Enter", frameSeq: old.frameSeq }
      })
    ).rejects.toThrow("控制权已变化")
    await expect(f.a.call("computerTake", { ...old, replaceHuman: true })).rejects.toThrow(
      "控制权已变化"
    )
    const broker = await f.computer.get()
    await expect(
      broker.act(broker.target(f.bot.id), { op: "press_key", key: "Enter" }, () => {})
    ).rejects.toThrow("控制权")
    f.b.close()
    await expect
      .poll(async () => (await f.a.call("computerFrame", f.bot.id)).controlOwnerConnected)
      .toBe(false)
    // Reconnection creates a new identity and must explicitly reclaim control.
    const reconnected = await f.b.call("computerFrame", f.bot.id)
    expect(reconnected.controlOwner).toBe("other")
    await expect(f.b.call("computerRelease", reconnected)).rejects.toThrow("另一客户端")
    await f.b.call("computerTake", { ...reconnected, replaceHuman: true })
    await f.b.call("computerRelease", await f.b.call("computerFrame", f.bot.id))
    expect((await f.a.call("computerFrame", f.bot.id)).control).toBe("bot")
    expect(f.store.loadBrowserSession(f.bot.id)?.humanHeld).toBeUndefined()
  }, 30_000)

  it("keeps the human hold after browser recreation, without restoring a client's old authority", async () => {
    const f = await fixture()
    const old = await f.a.call("computerFrame", f.bot.id)
    await f.a.call("computerTake", old)
    expect(f.store.loadBrowserSession(f.bot.id)?.humanHeld).toBe(true)
    await f.computer.close()
    const restored = await f.a.call("computerFrame", f.bot.id)
    expect(restored).toMatchObject({
      control: "human",
      controlOwner: "other",
      controlOwnerConnected: false
    })
    expect(restored.generation).not.toBe(old.generation)
    await expect(f.a.call("computerRelease", restored)).rejects.toThrow("另一客户端")
    await f.a.call("computerTake", { ...restored, replaceHuman: true })
    await f.a.call("computerRelease", await f.a.call("computerFrame", f.bot.id))
    await f.computer.close()
    expect((await f.a.call("computerFrame", f.bot.id)).control).toBe("bot")
  }, 30_000)

  it("authorizes Teach controls through the owner and pauses recording on transfer or disconnect", async () => {
    const f = await fixture()
    const input = {
      botId: f.bot.id,
      conversationId: f.conversationId,
      nonce: "teach",
      target: await f.a.call("computerFrame", f.bot.id)
    }
    const session = await f.a.call("teachStart", input)
    expect(session.phase).toBe("recording")
    const foreign = {
      ...input,
      nonce: "foreign",
      target: await f.b.call("computerFrame", f.bot.id)
    }
    await expect(f.b.call("teachStart", foreign)).rejects.toThrow("另一客户端")
    expect(f.teach.repository.forNonce(foreign)).toBeNull()
    await expect(f.b.call("teachPause", { id: session.id, paused: true })).rejects.toThrow(
      "另一客户端"
    )
    await expect(f.b.call("teachStop", { id: session.id, save: false })).rejects.toThrow(
      "另一客户端"
    )
    await f.b.call("computerTake", {
      ...(await f.b.call("computerFrame", f.bot.id)),
      replaceHuman: true
    })
    expect(f.teach.status(f.bot.id)).toMatchObject({
      phase: "paused",
      error: expect.stringContaining("控制权已转移")
    })
    await expect(f.a.call("teachPause", { id: session.id, paused: false })).rejects.toThrow(
      "另一客户端"
    )
    await f.b.call("teachPause", { id: session.id, paused: false })
    f.b.close()
    await expect.poll(() => f.teach.status(f.bot.id)?.phase).toBe("paused")
    expect(f.teach.status(f.bot.id)?.error).toContain("断开")
    await f.a.call("computerTake", {
      ...(await f.a.call("computerFrame", f.bot.id)),
      replaceHuman: true
    })
    await f.a.call("teachStop", { id: session.id, save: false })
    await f.a.call("computerRelease", await f.a.call("computerFrame", f.bot.id))
  }, 30_000)
})

// A controlled Host clock gap exercises the actual admission path without
// changing the OS clock or claiming an OS sleep/lock event was observed.
describe.runIf(process.env.CMB_BOT_BROWSER_TEST === "1")("browser supervision fencing", () => {
  async function supervised() {
    let wall = 1900000000000,
      monotonic = 0,
      running: BotRuntimeRequest | undefined
    const f = await fixture({
      wall: () => wall,
      monotonic: () => monotonic,
      physicalOwner: true,
      runtime: {
        execute: async (request) => {
          running = request
          await new Promise<void>((done) =>
            request.signal.addEventListener("abort", () => done(), { once: true })
          )
          return "LATE_RESULT_MUST_NOT_COMMIT"
        }
      }
    })
    await f.a.call("computerTake", await f.a.call("computerFrame", f.bot.id))
    const broker = await f.computer.get()
    const page = await broker.teachObserve(f.bot.id, async (value) => value)
    await page.setContent(
      '<button id="action" style="width:200px;height:80px" onclick="window.auditClicked=(window.auditClicked||0)+1">Before sleep</button>'
    )
    const frame = await f.a.call("computerFrame", f.bot.id)
    const sent = await f.a.call("send", {
      nonce: "supervised-work",
      conversationId: f.conversationId,
      text: "Hold ongoing work"
    })
    f.host.tick()
    await expect.poll(() => running?.run.id).toBe(sent.runIds[0])
    const gap = (heartbeat = false) => {
      wall += 60_000
      monotonic += 60_000
      if (heartbeat) f.host.tick()
    }
    const clicked = () =>
      page.evaluate(() => (window as unknown as { auditClicked?: number }).auditClicked ?? 0)
    const input = () =>
      f.a.call("computerInput", {
        target: frame,
        input: { kind: "click", frameSeq: frame.frameSeq, x: 30, y: 25 }
      })
    return {
      ...f,
      broker,
      page,
      frame,
      gap,
      clicked,
      input,
      runId: sent.runIds[0],
      request: () => running!
    }
  }

  it.each([false, true])(
    "rejects a pre-gap frame before Teach or DOM input (heartbeatAlreadyRan=%s)",
    async (heartbeat) => {
      const f = await supervised(),
        original = f.broker.humanObserver,
        observed = vi.fn(async (...args: Parameters<NonNullable<typeof original>>) =>
          original?.(...args)
        )
      f.broker.humanObserver = observed
      await f.page.evaluate(() => {
        document.getElementById("action")!.textContent = "Changed while unobserved"
      })
      f.gap(heartbeat)
      await expect(f.input()).rejects.toMatchObject({ code: "stale_target" })
      expect(observed).not.toHaveBeenCalled()
      expect(await f.clicked()).toBe(0)
      expect(f.store.getRun(f.runId).status).toBe("needs_review")
      expect(f.request().signal.aborted).toBe(true)
      expect(f.store.effects(f.runId)).toEqual([])
      expect(JSON.stringify(f.store.messages(f.conversationId))).not.toContain("LATE_RESULT")
    },
    20_000
  )

  it("requires fresh observation while retaining the human owner and the live headless browser", async () => {
    const f = await supervised(),
      state = f.computer.status(),
      other = await f.a.call("create", { nonce: "other-after-clock", name: "Headless observer" })
    await f.a.call("computerOpen", other.bot.id)
    f.gap(true)
    const fresh = await f.a.call("computerFrame", f.bot.id)
    expect(fresh).toMatchObject({
      control: "human",
      controlOwner: "self",
      controlEpoch: f.frame.controlEpoch
    })
    expect(fresh.generation).not.toBe(f.frame.generation)
    await f.a.call("computerInput", {
      target: fresh,
      input: { kind: "click", frameSeq: fresh.frameSeq, x: 30, y: 25 }
    })
    expect(await f.clicked()).toBe(1)
    expect(f.broker.isClosed).toBe(false)
    expect(f.computer.status()).toMatchObject({
      state: "ready",
      attemptId: state.attemptId,
      startedAt: state.startedAt
    })
    expect(f.broker.requiresObservation(other.bot.id)).toBe(true)
    const current = f.broker.target(other.bot.id)
    expect(current.control).toBe("bot")
    await f.broker.act(current, { op: "snapshot" }, () => f.host.assertComputerSupervision())
    expect(f.broker.requiresObservation(other.bot.id)).toBe(false)
  }, 20_000)

  it("checks the same supervision epoch after an awaited page lookup before Teach or DOM", async () => {
    const f = await supervised(),
      broker = f.broker as unknown as {
        currentPage(surface: unknown): Promise<import("playwright").Page>
      },
      currentPage = broker.currentPage.bind(broker),
      original = f.broker.humanObserver,
      observed = vi.fn(async (...args: Parameters<NonNullable<typeof original>>) =>
        original?.(...args)
      )
    f.broker.humanObserver = observed
    let release!: () => void,
      entered = false
    const held = new Promise<void>((done) => {
      release = done
    })
    const interception = vi.spyOn(broker, "currentPage").mockImplementation(async (surface) => {
      const page = await currentPage(surface)
      entered = true
      await held
      return page
    })
    const pending = f.input().then(
      () => null,
      (error: unknown) => error
    )
    try {
      await expect.poll(() => entered).toBe(true)
      f.gap()
      release()
      expect(await pending).toMatchObject({ code: "stale_frame" })
      expect(observed).not.toHaveBeenCalled()
      expect(await f.clicked()).toBe(0)
      expect(f.request().signal.aborted).toBe(true)
    } finally {
      release()
      await pending
      interception.mockRestore()
    }
  }, 20_000)

  it("rechecks after an accepted Teach observer awaits and records no confirmed browser effect", async () => {
    const f = await supervised(),
      original = f.broker.humanObserver
    let release!: () => void,
      entered = false
    const held = new Promise<void>((done) => {
      release = done
    })
    const observed = vi.fn(async (...args: Parameters<NonNullable<typeof original>>) => {
      if (args[3] === "before") {
        entered = true
        await held
      }
      await original?.(...args)
    })
    f.broker.humanObserver = observed
    const pending = f.input().then(
      () => null,
      (error: unknown) => error
    )
    try {
      await expect.poll(() => entered).toBe(true)
      f.gap()
      release()
      expect(await pending).toMatchObject({ code: "stale_frame" })
      expect(observed.mock.calls.map((args) => args[3])).toEqual(["before", "unconfirmed"])
      expect(await f.clicked()).toBe(0)
      expect(f.request().signal.aborted).toBe(true)
    } finally {
      release()
      await pending
    }
  }, 20_000)

  it("does not publish a screenshot ticket whose async capture crossed supervision fencing", async () => {
    const f = await supervised(),
      screenshot = f.page.screenshot.bind(f.page)
    let release!: () => void,
      entered = false
    const held = new Promise<void>((done) => {
      release = done
    })
    const interception = vi.spyOn(f.page, "screenshot").mockImplementation(async (options) => {
      const bytes = await screenshot(options)
      entered = true
      await held
      return bytes
    })
    const pending = f.a.call("computerFrame", f.bot.id).then(
      () => null,
      (error: unknown) => error
    )
    try {
      await expect.poll(() => entered).toBe(true)
      f.gap()
      release()
      expect(await pending).toMatchObject({ code: "stale_frame" })
      interception.mockRestore()
      const fresh = await f.a.call("computerFrame", f.bot.id)
      expect(fresh.control).toBe("human")
      expect(fresh.controlOwner).toBe("self")
      expect(fresh.generation).not.toBe(f.frame.generation)
      expect(await f.clicked()).toBe(0)
    } finally {
      release()
      await pending
      interception.mockRestore()
    }
  }, 20_000)

  it("rejects queued and observer-held input during Host shutdown and joins all resources", async () => {
    const f = await supervised(),
      original = f.broker.humanObserver
    let release!: () => void,
      entered = false
    const held = new Promise<void>((done) => {
      release = done
    })
    f.broker.humanObserver = async (...args) => {
      if (args[3] === "before") {
        entered = true
        await held
      }
      await original?.(...args)
    }
    const pending = f.input().then(
      () => null,
      (error: unknown) => error
    )
    let stopping: Promise<void> | undefined
    try {
      await expect.poll(() => entered).toBe(true)
      stopping = f.host.stop()
      await expect(f.input()).rejects.toMatchObject({ code: "host_stopping" })
      release()
      expect(await pending).toMatchObject({ code: "host_stopping" })
      await stopping
      expect(await f.clicked()).toBe(0)
      await f.computer.close()
      expect(f.computer.status().state).toBe("stopped")
    } finally {
      release()
      await Promise.allSettled([pending, stopping])
    }
  }, 20_000)

  it("leaves a crossed async human transfer suspended until a fresh explicit reclaim", async () => {
    const f = await supervised(),
      original = f.broker.beforeHumanTransfer
    let release!: () => void,
      entered = false
    const held = new Promise<void>((done) => {
      release = done
    })
    f.broker.beforeHumanTransfer = async (botId) => {
      await original?.(botId)
      entered = true
      await held
    }
    const spectator = await f.b.call("computerFrame", f.bot.id)
    const pending = f.b.call("computerTake", { ...spectator, replaceHuman: true }).then(
      () => null,
      (error: unknown) => error
    )
    try {
      await expect.poll(() => entered).toBe(true)
      f.gap()
      release()
      expect(await pending).toMatchObject({ code: "stale_frame" })
      const fresh = await f.b.call("computerFrame", f.bot.id)
      expect(fresh).toMatchObject({
        control: "human",
        controlOwner: "other",
        controlOwnerConnected: false
      })
      await f.b.call("computerTake", { ...fresh, replaceHuman: true })
      expect(await f.b.call("computerFrame", f.bot.id)).toMatchObject({
        control: "human",
        controlOwner: "self"
      })
      expect(await f.clicked()).toBe(0)
    } finally {
      release()
      await pending
    }
  }, 20_000)
})
