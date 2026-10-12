import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { chromium, type Browser, type Page } from "playwright"
import { createServer, type ServerResponse } from "node:http"
import { writeFile } from "node:fs/promises"
import { BotBrowserBroker } from "./browser-broker"
import type { BotBrowserFrame, BotHumanInput } from "../../shared/bot-computer"

describe.runIf(process.env.CMB_BOT_BROWSER_TEST === "1")("owned browser new-tab identities", () => {
  let browser: Browser
  const cleanup: (() => Promise<unknown>)[] = []
  beforeAll(async () => {
    browser = await chromium.launch({
      channel:
        process.env.CMB_BOT_BROWSER_CHANNEL ?? (process.platform === "win32" ? "msedge" : "chrome"),
      headless: true,
      chromiumSandbox: true,
      args: ["--disable-updater-scheduler"]
    })
  })
  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close()
  })
  afterAll(async () => {
    await browser?.close()
    if (process.env.CMB_BROWSER_NEW_TAB_CLOSE_PROOF)
      await writeFile(
        process.env.CMB_BROWSER_NEW_TAB_CLOSE_PROOF,
        JSON.stringify(
          {
            physicallyClosedAt: new Date().toISOString(),
            browserConnected: browser?.isConnected() ?? false,
            cleanupEntries: cleanup.length
          },
          null,
          2
        )
      )
  })

  async function fixture() {
    let held: ServerResponse | undefined
    let notify!: () => void
    const requested = new Promise<void>((resolve) => {
      notify = resolve
    })
    const html = (name: string) =>
      `<html><head><title>${name}</title></head><body><input id="field" aria-label="Field" style="position:absolute;left:20px;top:20px;width:180px;height:32px"></body></html>`
    const server = createServer((request, response) => {
      if (request.url === "/drop") {
        request.socket.destroy()
        return
      }
      if (request.url === "/held") {
        held = response
        notify()
        return
      }
      response.setHeader("Content-Type", "text/html")
      if (request.url === "/denied") {
        response.statusCode = 403
        response.end(html("Access denied"))
        return
      }
      response.end(
        html(request.url === "/old" ? "Original" : request.url === "/other" ? "Other Bot" : "New")
      )
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    cleanup.push(async () => {
      held?.end(html("New"))
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    })
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    const broker = new BotBrowserBroker(context)
    cleanup.push(() => broker.close())
    const original = (
      await broker.act(
        await broker.ensure("first-bot"),
        { op: "navigate", url: `${url}/old` },
        () => {}
      )
    ).target
    const oldPage = context.pages()[0]
    const other = (
      await broker.act(
        await broker.ensure("second-bot"),
        { op: "navigate", url: `${url}/other` },
        () => {}
      )
    ).target
    const otherPage = context.pages()[1]
    const releaseHeld = () => {
      held?.setHeader("Content-Type", "text/html")
      held?.end(html("New"))
      held = undefined
    }
    cleanup.push(async () => releaseHeld())
    const human = async (input: Omit<BotHumanInput, "frameSeq">) => {
      const frame = await broker.frame("first-bot")
      await broker.humanInput(frame, { ...input, frameSeq: frame.frameSeq })
      return broker.frame("first-bot")
    }
    const writeHuman = async (value: string) => {
      await human({ kind: "click", x: 40, y: 35 })
      return human({ kind: "text", text: value })
    }
    const selected = (frame: BotBrowserFrame, name: string) => {
      expect(frame.title).toBe(name)
      expect(frame.tabs.find((tab) => tab.viewId === frame.viewId)?.title).toBe(name)
    }
    return {
      broker,
      context,
      original,
      oldPage,
      other,
      otherPage,
      url,
      requested,
      releaseHeld,
      human,
      writeHuman,
      selected
    }
  }

  async function field(page: Page) {
    return page.locator("#field").inputValue()
  }

  it("returns an observed HTTP failure for existing and new pages without blocking fresh observation", async () => {
    const f = await fixture()
    for (const newTab of [false, true]) {
      const result = await f.broker.act(
        await f.broker.ensure("first-bot"),
        { op: "navigate", url: `${f.url}/denied`, newTab },
        () => {}
      )
      expect(JSON.parse(result.data!)).toEqual({
        navigation: { status: "http_error", httpStatus: 403 },
        requiresObservation: true
      })
      expect(result.observation?.url).toBe(`${f.url}/denied`)
      const observed = await f.broker.act(result.target, { op: "snapshot" }, () => {})
      expect(observed.observation?.title).toBe("Access denied")
      expect(observed.data).toContain("Field")
    }
  })

  it("retains a failed network navigation's actual page and permits observation without replay", async () => {
    const f = await fixture()
    const result = await f.broker.act(
      f.original,
      { op: "navigate", url: `${f.url}/drop`, newTab: true },
      () => {}
    )
    expect(JSON.parse(result.data!)).toEqual({
      navigation: { status: "network_error", errorCode: "ERR_EMPTY_RESPONSE" },
      requiresObservation: true
    })
    expect(result.target.viewId).not.toBe(f.original.viewId)
    expect(f.broker.target("first-bot")).toEqual(result.target)
    const observed = await f.broker.act(result.target, { op: "snapshot" }, () => {})
    expect(observed.target.viewId).toBe(result.target.viewId)
    expect(observed.data).not.toContain('"Field"')
    expect(await field(f.oldPage)).toBe("")
    expect(await field(f.otherPage)).toBe("")
  })

  it("keeps old and new pages distinct for human and Bot input, ignoring a supplied foreign view ID", async () => {
    const f = await fixture()
    const created = await f.broker.act(
      f.original,
      {
        op: "navigate",
        url: `${f.url}/new`,
        newTab: true,
        viewId: f.other.viewId
      },
      () => {}
    )
    expect(created.target.viewId).not.toBe(f.original.viewId)
    expect(created.target.viewId).not.toBe(f.other.viewId)
    expect(f.broker.target("second-bot")).toEqual(f.other)
    await expect(
      f.broker.act(f.original, { op: "fill", ref: "e1", value: "stale" }, () => {})
    ).rejects.toThrow("画面或控制权")
    await f.broker.takeControl(created.target)
    const oldFrame = await f.human({ kind: "tab_select", viewId: f.original.viewId })
    f.selected(oldFrame, "Original")
    await f.writeHuman("human-old")
    const newFrame = await f.human({ kind: "tab_select", viewId: created.target.viewId })
    f.selected(newFrame, "New")
    await f.writeHuman("human-new")
    expect(await field(f.oldPage)).toBe("human-old")
    const newPage = f.context.pages()[2]
    expect(await field(newPage)).toBe("human-new")
    expect(await field(f.otherPage)).toBe("")
    const botTarget = await f.broker.releaseControl(await f.broker.frame("first-bot"))
    await expect(
      f.broker.act(botTarget, { op: "tabs", action: "select", index: 0 }, () => {})
    ).rejects.toThrow("请先查看新画面")
    await f.broker.act(botTarget, { op: "snapshot" }, () => {})
    const returned = await f.broker.act(
      botTarget,
      { op: "tabs", action: "select", index: 0 },
      () => {}
    )
    expect(returned.target.viewId).toBe(f.original.viewId)
    await f.broker.act(returned.target, { op: "snapshot" }, () => {})
    await f.broker.act(returned.target, { op: "fill", ref: "e1", value: "bot-old" }, () => {})
    expect(await field(f.oldPage)).toBe("bot-old")
    expect(await field(newPage)).toBe("human-new")
    expect(await field(f.otherPage)).toBe("")
  })

  it("leaves the original page usable after a new navigation target closes", async () => {
    const f = await fixture()
    const navigating = f.broker.act(
      f.original,
      {
        op: "navigate",
        url: `${f.url}/held`,
        newTab: true,
        viewId: f.original.viewId
      },
      () => {}
    )
    const closed = expect(navigating).rejects.toThrow()
    await f.requested
    await f.context.pages()[2].close()
    await closed
    expect(f.broker.target("first-bot")).toEqual(f.original)
    const snapshot = await f.broker.act(f.original, { op: "snapshot" }, () => {})
    expect(snapshot.data).toContain("Field")
    await f.broker.act(f.original, { op: "fill", ref: "e1", value: "after-failure" }, () => {})
    expect(await field(f.oldPage)).toBe("after-failure")
    expect(await field(f.otherPage)).toBe("")
  })

  it("preserves original identities through a late navigation and fences queued Bot input on takeover", async () => {
    const f = await fixture()
    const navigating = f.broker.act(
      f.original,
      {
        op: "navigate",
        url: `${f.url}/held`,
        newTab: true,
        viewId: f.original.viewId
      },
      () => {}
    )
    // Takeover fences the reply from an already-dispatched navigation too.
    // A late successful page load does not restore the Bot's old input authority.
    const fencedNavigation = expect(navigating).rejects.toThrow("画面或控制权")
    await f.requested
    const taking = f.broker.takeControl(f.original)
    void taking.catch(() => {})
    let queuedAuthorized = 0
    const queued = f.broker
      .act(f.original, { op: "fill", ref: "e1", value: "must-not-write" }, () => {
        queuedAuthorized++
      })
      .catch((failure: unknown) => failure)
    try {
      f.releaseHeld()
      await fencedNavigation
      const owned = await taking
      expect(owned.control).toBe("human")
      expect(owned.viewId).toBe(f.original.viewId)
      expect(await queued).toBeInstanceOf(Error)
      expect(queuedAuthorized).toBe(0)
      expect(f.broker.target("second-bot")).toEqual(f.other)
      const current = await f.broker.frame("first-bot")
      const newTab = current.tabs.find((tab) => tab.url === `${f.url}/held`)!
      expect(newTab).toBeDefined()
      expect(newTab.viewId).not.toBe(f.original.viewId)
      expect(newTab.viewId).not.toBe(f.other.viewId)
      const newFrame = await f.human({ kind: "tab_select", viewId: newTab.viewId })
      f.selected(newFrame, "New")
      const oldFrame = await f.human({ kind: "tab_select", viewId: f.original.viewId })
      f.selected(oldFrame, "Original")
      await f.writeHuman("after-transfer")
      expect(await field(f.oldPage)).toBe("after-transfer")
      expect(await field(f.otherPage)).toBe("")
    } finally {
      f.releaseHeld()
      await Promise.allSettled([navigating, taking, queued])
    }
  })
})
