import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { createServer, type Server, type ServerResponse } from "node:http"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { setTimeout as delay } from "node:timers/promises"
import type { BrowserContext } from "playwright"
import { LocalBotComputerProvider } from "./computer-provider"
import type { BotBrowserBroker } from "./browser-broker"
import type { BotBrowserSession } from "../../shared/bot-computer"
import { HOST_COMPUTER_CLIENT } from "./computer-client"

const enabled = process.env.CMB_BOT_BROWSER_TEST === "1"
describe.runIf(enabled)("computer idle and wake with an actual browser", () => {
  let server: Server, directory: string, provider: LocalBotComputerProvider, url: string
  let heldDownload: ServerResponse | undefined
  let busy = true,
    ticks = 0,
    hits = 0
  const sessions = new Map<string, BotBrowserSession>()
  const evidence: Record<string, unknown> = {}
  const context = (broker: BotBrowserBroker) =>
    (broker as unknown as { context: BrowserContext }).context
  const until = async (check: () => boolean, timeout = 6000) => {
    const deadline = Date.now() + timeout
    while (!check()) {
      if (Date.now() > deadline) throw Error("Browser idle fixture deadline")
      await delay(25)
    }
  }
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "cmb-computer-idle-"))
    server = createServer((request, response) => {
      if (request.url === "/sw.js") {
        response.setHeader("content-type", "application/javascript")
        response.end(`self.onmessage=()=>setInterval(()=>fetch('/tick'),50)`)
        return
      }
      if (request.url === "/download") {
        response.setHeader("Content-Disposition", 'attachment; filename="audit.txt"')
        response.write("start")
        heldDownload = response
        return
      }
      if (request.url === "/tick") {
        ticks++
        response.end("ok")
        return
      }
      if (request.url === "/clicked") {
        hits++
        response.end("ok")
        return
      }
      response.setHeader("content-type", "text/html")
      response.setHeader("Set-Cookie", [
        "persistent=audit;Max-Age=3600;Path=/;SameSite=Lax",
        "session=audit;Path=/;SameSite=Lax"
      ])
      response.end(
        `<html><head><title>${request.url}</title></head><body><button style="position:absolute;left:20px;top:20px;width:150px;height:35px" onclick="fetch('/clicked')">Save</button><input aria-label="Draft" style="position:absolute;left:20px;top:80px"><script>localStorage.setItem('keep','yes');window.documentIdentity=crypto.randomUUID();navigator.serviceWorker.register('/sw.js').then(()=>navigator.serviceWorker.ready).then(({active})=>active.postMessage('start'));</script></body></html>`
      )
    })
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    provider = new LocalBotComputerProvider(
      join(directory, "profile"),
      process.env.CMB_BOT_BROWSER_CHANNEL ?? "chrome",
      { idleAfterMs: 300, viewerLeaseMs: 1000 }
    )
    provider.persistence = {
      loadBrowserSession: (id) => sessions.get(id) ?? null,
      saveBrowserSession: (id, value) => {
        sessions.set(id, value)
      }
    }
    provider.bindIdleGuard(() => !busy)
  })
  afterAll(async () => {
    await provider?.close()
    server?.closeAllConnections()
    if (server) await new Promise<void>((done) => server.close(() => done()))
    if (process.env.CMB_COMPUTER_IDLE_EVIDENCE)
      await writeFile(
        process.env.CMB_COMPUTER_IDLE_EVIDENCE,
        JSON.stringify(
          {
            ...evidence,
            browserClosed: provider.status().state === "stopped",
            retainedSessions: [...sessions]
          },
          null,
          2
        )
      )
    if (directory) await rm(directory, { recursive: true, force: true })
  }, 15_000)

  it("stops the entire idle browser, keeps durable tabs/profile and session login, then requires fresh observation", async () => {
    const first = await provider.get()
    let target = (
      await first.act(
        await first.ensure("idle-bot"),
        { op: "navigate", url: `${url}/first` },
        () => {}
      )
    ).target
    target = (
      await first.act(target, { op: "navigate", url: `${url}/second`, newTab: true }, () => {})
    ).target
    const page = context(first)
      .pages()
      .find((value) => value.url() === `${url}/second`)!
    const documentBefore = await page.evaluate(
      () => (window as unknown as { documentIdentity: string }).documentIdentity
    )
    await page.getByRole("textbox").fill("unsaved draft")
    await context(first).addCookies([
      {
        name: "secure-private",
        value: "audit-only",
        domain: "secure.example.invalid",
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Strict",
        expires: -1
      },
      {
        name: "partitioned",
        value: "audit-only",
        domain: "partition.example.invalid",
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "None",
        expires: -1,
        _crHasCrossSiteAncestor: false,
        partitionKey: "https://top.example.invalid"
      } as Parameters<BrowserContext["addCookies"]>[0][number]
    ])
    const cookiesBefore = (await context(first).cookies()).filter((value) =>
      ["secure-private", "partitioned"].includes(value.name)
    )
    expect(cookiesBefore).toHaveLength(2)
    await until(() => ticks > 0)
    evidence.browser = context(first).browser()?.version()
    evidence.sandboxEnabled = true
    busy = false
    await until(() => provider.status().state === "stopped")
    const asleepTicks = ticks
    await delay(400)
    expect(ticks).toBe(asleepTicks)
    expect(sessions.get("idle-bot")).toEqual({ urls: [`${url}/first`, `${url}/second`], active: 1 })
    const a = provider.get(),
      b = provider.get()
    expect(a).toBe(b)
    const second = await a
    // Assert before restoring URLs: the fixture must not repair login via Set-Cookie.
    const restoredBeforeNavigation = await context(second).cookies()
    expect(restoredBeforeNavigation.map((value) => value.name)).toEqual(
      expect.arrayContaining(["persistent", "session"])
    )
    expect(
      restoredBeforeNavigation.filter((value) =>
        ["secure-private", "partitioned"].includes(value.name)
      )
    ).toEqual(cookiesBefore)
    evidence.cookieAttributesAndPartitionRestoredBeforeURL = true
    busy = true
    const fresh = await second.ensure("idle-bot")
    expect(fresh.generation).not.toBe(target.generation)
    expect(second.requiresObservation("idle-bot")).toBe(true)
    const reloaded = context(second)
      .pages()
      .find((value) => value.url() === `${url}/second`)!
    expect(await reloaded.getByRole("textbox").inputValue()).toBe("")
    expect(await reloaded.evaluate(() => localStorage.getItem("keep"))).toBe("yes")
    expect(
      await reloaded.evaluate(
        () => (window as unknown as { documentIdentity: string }).documentIdentity
      )
    ).not.toBe(documentBefore)
    expect((await context(second).cookies()).map((value) => value.name)).toEqual(
      expect.arrayContaining(["persistent", "session"])
    )
    let authorized = 0
    await expect(
      second.act(target, { op: "mouse_click_xy", x: 30, y: 30 }, () => authorized++)
    ).rejects.toThrow("画面或控制权")
    await expect(
      second.act(fresh, { op: "mouse_click_xy", x: 30, y: 30 }, () => authorized++)
    ).rejects.toThrow("请先查看")
    expect(authorized).toBe(0)
    expect(hits).toBe(0)
    await second.act(fresh, { op: "snapshot" }, () => {})
    expect(second.requiresObservation("idle-bot")).toBe(false)
    await second.act(fresh, { op: "mouse_click_xy", x: 30, y: 30 }, () => authorized++)
    await until(() => hits === 1)
    evidence.idleStoppedServiceWorker = true
    evidence.loginNamesRestored = ["persistent", "session"]
    evidence.durableStorageRestored = true
    evidence.domMemoryRetained = false
    evidence.oldGenerationDenied = true
    evidence.freshObservationRequired = true
  }, 20_000)

  it("holds real human takeover and its disconnected owner until explicit handback", async () => {
    const broker = await provider.get(),
      owner = new AbortController()
    const held = await broker.takeControl(
      broker.target("idle-bot"),
      undefined,
      undefined,
      owner.signal
    )
    busy = false
    await delay(700)
    expect(provider.status().state).toBe("ready")
    owner.abort()
    await delay(700)
    expect(provider.status().state).toBe("ready")
    const reclaim = await broker.takeControl(
      broker.target("idle-bot"),
      undefined,
      undefined,
      HOST_COMPUTER_CLIENT,
      true
    )
    await broker.releaseControl(reclaim)
    busy = true
    evidence.disconnectedHumanHoldRetained = held.control === "human"
  }, 8000)

  it("holds an active authenticated viewer and releases it on disconnect without retaining its listener", async () => {
    const broker = await provider.get(),
      viewer = new AbortController()
    await broker.frame("idle-bot", viewer.signal)
    busy = false
    await delay(600)
    expect(provider.status().state).toBe("ready")
    viewer.abort()
    await until(() => provider.status().state === "stopped")
    busy = true
    await provider.get()
    evidence.viewerHoldAndAbortRelease = true
  }, 8000)

  it("holds admission before downloads.ready yields, then releases the hold on completion", async () => {
    busy = true
    const broker = await provider.get()
    const downloads = (broker as unknown as { downloads: { ready(): Promise<void> } }).downloads
    const ready = downloads.ready.bind(downloads)
    let release!: () => void
    const gate = new Promise<void>((done) => {
      release = done
    })
    const spy = vi.spyOn(downloads, "ready").mockImplementation(async () => {
      await gate
      await ready()
    })
    const pending = broker.ensure("queued-bot")
    busy = false
    await delay(700)
    expect(provider.status().state).toBe("ready")
    expect(broker.idleBlockedReason).toContain("操作")
    release()
    await pending
    spy.mockRestore()
    await until(() => provider.status().state === "stopped")
    evidence.preAwaitAdmissionHeld = true
  }, 8000)

  it("holds a real in-flight download until file completion", async () => {
    busy = true
    const broker = await provider.get(),
      target = await broker.ensure("idle-bot")
    await broker.act(target, { op: "snapshot" }, () => {})
    const pending = broker.download(
      target,
      `${url}/download`,
      () => {},
      new AbortController().signal
    )
    await until(() => Boolean(heldDownload))
    busy = false
    await delay(700)
    expect(provider.status().state).toBe("ready")
    expect(broker.idleBlockedReason).not.toBeNull()
    heldDownload!.end("done")
    heldDownload = undefined
    expect((await pending).bytes.toString()).toBe("startdone")
    await until(() => provider.status().state === "stopped")
    evidence.realDownloadHeld = true
  }, 8000)

  it("holds the real Teach encoder page across initialization until disposal", async () => {
    busy = true
    const broker = await provider.get(),
      encoder = await broker.teachEncoderPage()
    busy = false
    await delay(700)
    expect(provider.status().state).toBe("ready")
    expect(broker.idleBlockedReason).toContain("示范")
    await encoder.close()
    await until(() => provider.status().state === "stopped")
    evidence.teachEncoderLifetimeHeld = true
  }, 8000)

  it("keeps live tabs when the final durable save fails and retries only after a bounded idle interval", async () => {
    busy = true
    const broker = await provider.get()
    await broker.ensure("idle-bot")
    const persistence = provider.persistence!,
      save = persistence.saveBrowserSession.bind(persistence)
    const spy = vi.spyOn(persistence, "saveBrowserSession").mockImplementation(() => {
      throw Error("fixture storage unavailable")
    })
    busy = false
    await delay(700)
    expect(provider.status().state).toBe("ready")
    expect(context(broker).browser()?.isConnected()).toBe(true)
    expect(spy.mock.calls.length).toBeLessThan(4)
    spy.mockImplementation(save)
    await until(() => provider.status().state === "stopped")
    spy.mockRestore()
    evidence.persistenceFailureKeptLiveBrowser = true
  }, 8000)
  it("lets a hidden viewer lease expire without disconnecting the authenticated control socket", async () => {
    busy = true
    const broker = await provider.get(),
      viewer = new AbortController()
    await broker.frame("idle-bot", viewer.signal)
    busy = false
    await delay(600)
    expect(provider.status().state).toBe("ready")
    await until(() => provider.status().state === "stopped")
    expect(viewer.signal.aborted).toBe(false)
    evidence.hiddenViewerLeaseExpired = true
  }, 8000)
  it("requires a new generation and observation after an unexpected native context close", async () => {
    busy = true
    const before = await provider.get(),
      oldTarget = await before.ensure("idle-bot")
    await context(before).close()
    expect(provider.status().state).toBe("failed")
    const after = await provider.get(),
      newTarget = await after.ensure("idle-bot")
    expect(newTarget.generation).not.toBe(oldTarget.generation)
    expect(after.requiresObservation("idle-bot")).toBe(true)
    let effects = 0
    await expect(
      after.act(newTarget, { op: "mouse_click_xy", x: 30, y: 30 }, () => effects++)
    ).rejects.toThrow("请先查看")
    expect(effects).toBe(0)
    await after.act(newTarget, { op: "snapshot" }, () => {})
    expect(after.requiresObservation("idle-bot")).toBe(false)
    evidence.unexpectedContextCloseRequiresFreshObservation = true
  }, 8000)

  it("does not launch another real Chromium when a queued idle wake crosses Host lifetime shutdown", async () => {
    busy = true
    const broker = await provider.get(),
      native = context(broker),
      browser = native.browser()!
    let finish!: (value: Awaited<ReturnType<BrowserContext["cookies"]>>) => void
    const gate = new Promise<Awaited<ReturnType<BrowserContext["cookies"]>>>((done) => {
      finish = done
    })
    const cookies = vi.spyOn(native, "cookies").mockImplementationOnce(() => gate)
    busy = false
    await until(() => provider.status().state === "stopping")
    const pending = provider.get(),
      rejected = expect(pending).rejects.toThrow("已关闭")
    const stopping = provider.shutdown()
    finish([])
    await stopping
    await rejected
    await expect(provider.get()).rejects.toThrow("已关闭")
    expect(provider.status().state).toBe("stopped")
    expect(browser.isConnected()).toBe(false)
    cookies.mockRestore()
    evidence.queuedWakeRevokedByHostShutdown = true
  }, 8000)
})
