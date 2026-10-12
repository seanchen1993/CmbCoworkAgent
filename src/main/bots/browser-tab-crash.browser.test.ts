import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { chromium, type Browser, type BrowserContext, type Page } from "playwright"
import { createServer, type Server } from "node:http"
import { BotBrowserBroker } from "./browser-broker"

const enabled = process.env.CMB_BOT_BROWSER_TEST === "1"
const channel =
  process.env.CMB_BOT_BROWSER_CHANNEL ?? (process.platform === "win32" ? "msedge" : "chrome")
async function crash(page: Page) {
  const session = await page.context().newCDPSession(page)
  let closedAtCrash = true
  const observed = new Promise<void>((resolve) =>
    page.once("crash", () => {
      closedAtCrash = page.isClosed()
      resolve()
    })
  )
  const command = session.send("Page.crash").catch(() => {})
  await observed
  expect(closedAtCrash).toBe(false)
  await command
  await session.detach().catch(() => {})
}

describe.runIf(enabled)("actual isolated Chromium tab-crash recovery", () => {
  let browser: Browser, context: BrowserContext, broker: BotBrowserBroker, server: Server
  let port: number
  const requests: string[] = []
  beforeAll(async () => {
    server = createServer((req, res) => {
      requests.push(`${req.method} ${req.headers.host} ${req.url}`)
      res.setHeader("Content-Type", "text/html; charset=utf-8")
      res.end(
        '<!doctype html><title>Original website</title><textarea aria-label="Input"></textarea><p id="content">original-page</p>'
      )
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    port = (server.address() as { port: number }).port
    browser = await chromium.launch({
      channel,
      headless: true,
      chromiumSandbox: true,
      args: [
        "--site-per-process",
        "--host-resolver-rules=MAP crash-a.test 127.0.0.1,MAP crash-b.test 127.0.0.1,MAP crash-c.test 127.0.0.1",
        "--no-proxy-server"
      ]
    })
    context = await browser.newContext({
      viewport: { width: 1920, height: 1200 }
    })
    broker = new BotBrowserBroker(context)
  }, 20_000)
  afterAll(async () => {
    await broker?.close()
    await browser?.close()
    server?.closeAllConnections()
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it("replaces a selected crashed Page once without replay, preserving view/control/Teach and fencing old human input", async () => {
    const botId = "crash-selected"
    const target = await broker.ensure(botId)
    const original = context.pages()[0]
    await original.goto(`http://crash-a.test:${port}/selected`)
    const other = await broker.ensure("crash-other-bot")
    const otherPage = context.pages().find((page) => page !== original)!
    await otherPage.goto(`http://crash-c.test:${port}/other`)
    await broker.takeControl(target)
    broker.teachRecordingBot = botId
    const frame = await broker.frame(botId)
    const network = requests.filter((value) => !value.endsWith("/favicon.ico")).length
    await crash(original)
    const recovered = await broker.frame(botId)
    expect(original.isClosed()).toBe(true)
    expect(recovered.viewId).toBe(frame.viewId)
    expect(recovered.generation).not.toBe(frame.generation)
    expect(recovered.controlEpoch).toBe(frame.controlEpoch)
    expect(recovered.control).toBe("human")
    expect(broker.humanClientConnected(botId)).toBe(true)
    expect(broker.teachRecordingBot).toBe(botId)
    expect(broker.requiresObservation(botId)).toBe(true)
    expect(recovered.title).toContain("原操作结果待核对")
    expect(recovered.url).toBe("about:blank")
    const replacement = context.pages().find((page) => page !== otherPage)!
    expect(await replacement.locator('[data-bot-recovery="tab-crash"]').count()).toBe(1)
    expect(await replacement.locator("script,iframe,img,a").count()).toBe(0)
    expect(await replacement.locator(".url").innerText()).toContain("/selected")
    expect(requests.filter((value) => !value.endsWith("/favicon.ico")).length).toBe(network)
    expect(broker.target("crash-other-bot")).toEqual(other)
    expect(otherPage.isClosed()).toBe(false)
    expect(await otherPage.locator("#content").innerText()).toBe("original-page")
    await expect(
      broker.humanInput(frame, {
        kind: "text",
        text: "old input",
        frameSeq: frame.frameSeq
      })
    ).rejects.toThrow("画面或控制权")
    await expect(broker.releaseControl(recovered)).rejects.toThrow("示范")
    broker.teachRecordingBot = undefined
    const handedBack = await broker.releaseControl(recovered)
    await expect(
      broker.act(
        handedBack,
        { op: "navigate", url: `http://crash-a.test:${port}/explicit` },
        () => {}
      )
    ).rejects.toThrow("先查看")
    await broker.act(handedBack, { op: "snapshot" }, () => {})
    await broker.act(
      handedBack,
      { op: "navigate", url: `http://crash-a.test:${port}/explicit` },
      () => {}
    )
    expect(await replacement.locator("#content").innerText()).toBe("original-page")
    await broker.releaseBot(botId)
    await broker.releaseBot("crash-other-bot")
  }, 20_000)

  it("replaces only the background crashed tab, retaining healthy active-page authority until the recovered tab is selected", async () => {
    const botId = "crash-background"
    const initial = await broker.ensure(botId)
    const foreground = context.pages()[0]
    await foreground.goto(`http://crash-a.test:${port}/foreground`)
    await broker.act(initial, { op: "snapshot" }, () => {})
    const opened = await broker.act(
      initial,
      {
        op: "navigate",
        newTab: true,
        url: `http://crash-b.test:${port}/background`
      },
      () => {}
    )
    const background = context.pages().find((page) => page !== foreground)!
    const twoTabs = await broker.frame(botId)
    const firstViewId = twoTabs.tabs[0].viewId,
      secondViewId = twoTabs.tabs[1].viewId
    const selected = await broker.act(
      opened.target,
      { op: "tabs", action: "select", index: 0 },
      () => {}
    )
    const network = requests.filter((value) => !value.endsWith("/favicon.ico")).length
    await crash(background)
    const recovered = await broker.frame(botId)
    expect(background.isClosed()).toBe(true)
    expect(foreground.isClosed()).toBe(false)
    expect(recovered.viewId).toBe(firstViewId)
    expect(recovered.title).toBe("Original website")
    expect(recovered.tabs.map((tab) => tab.viewId)).toEqual([firstViewId, secondViewId])
    expect(recovered.tabs[1].title).toContain("原操作结果待核对")
    expect(requests.filter((value) => !value.endsWith("/favicon.ico")).length).toBe(network)
    expect(recovered.generation).toBe(selected.target.generation)
    expect(broker.requiresObservation(botId)).toBe(false)
    const observed = await broker.act(selected.target, { op: "snapshot" }, () => {})
    expect(observed.data).toContain("original-page")
    const recoveredTab = await broker.act(
      observed.target,
      { op: "tabs", action: "select", index: 1 },
      () => {}
    )
    expect(recoveredTab.target.viewId).toBe(secondViewId)
    expect(recoveredTab.target.generation).not.toBe(selected.target.generation)
    expect(broker.requiresObservation(botId)).toBe(true)
    await expect(
      broker.act(
        recoveredTab.target,
        { op: "navigate", url: `http://crash-b.test:${port}/deliberate` },
        () => {}
      )
    ).rejects.toThrow("先查看")
    const notice = await broker.act(recoveredTab.target, { op: "snapshot" }, () => {})
    expect(notice.data).toContain("原操作结果仍需核对")
    await broker.releaseBot(botId)
  }, 20_000)
  it("fails one replacement attempt closed and does not loop when repeated frames arrive", async () => {
    const botId = "crash-failure"
    const target = await broker.ensure(botId)
    const page = context.pages()[0]
    await page.goto(`http://crash-a.test:${port}/failure`)
    const newPage = context.newPage.bind(context)
    let attempts = 0
    context.newPage = async () => {
      attempts++
      throw new Error("controlled replacement launch failure")
    }
    try {
      await crash(page)
      for (let index = 0; index < 3; index++)
        await expect(broker.frame(botId)).rejects.toThrow("标签页恢复失败")
      expect(attempts).toBe(1)
      expect(page.isClosed()).toBe(true)
      expect(broker.target(botId).generation).not.toBe(target.generation)
      expect(broker.requiresObservation(botId)).toBe(true)
    } finally {
      context.newPage = newPage
      await broker.releaseBot(botId)
    }
  }, 15_000)

  it("keeps the healthy current tab usable after a background replacement fails without retrying that lost tab", async () => {
    const botId = "crash-background-failure"
    const initial = await broker.ensure(botId)
    const foreground = context.pages()[0]
    await foreground.goto(`http://crash-a.test:${port}/healthy-after-failure`)
    await broker.act(initial, { op: "snapshot" }, () => {})
    const opened = await broker.act(
      initial,
      { op: "navigate", newTab: true, url: `http://crash-b.test:${port}/failed-background` },
      () => {}
    )
    const background = context.pages().find((page) => page !== foreground)!
    const selected = await broker.act(
      opened.target,
      { op: "tabs", action: "select", index: 0 },
      () => {}
    )
    const newPage = context.newPage.bind(context)
    let attempts = 0
    context.newPage = async () => {
      attempts++
      throw new Error("controlled background creation failure")
    }
    try {
      await crash(background)
      for (let index = 0; index < 3; index++) {
        const healthy = await broker.frame(botId)
        expect(healthy.generation).toBe(selected.target.generation)
        expect(healthy.viewId).toBe(selected.target.viewId)
        expect(healthy.title).toBe("Original website")
        expect(healthy.tabs).toHaveLength(1)
      }
      const observed = await broker.act(selected.target, { op: "snapshot" }, () => {})
      expect(observed.data).toContain("original-page")
      expect(broker.requiresObservation(botId)).toBe(false)
      expect(attempts).toBe(1)
      expect(foreground.isClosed()).toBe(false)
      expect(background.isClosed()).toBe(true)
    } finally {
      context.newPage = newPage
      await broker.releaseBot(botId)
    }
  }, 15_000)

  it("retains the failed recovery marker when saving the new page fails, without blank-page retries", async () => {
    let rejectSave = false
    const isolated = await browser.newContext()
    const persistent = new BotBrowserBroker(isolated, {
      loadBrowserSession: () => null,
      saveBrowserSession: () => {
        if (rejectSave) throw new Error("controlled recovery persistence failure")
      }
    })
    const botId = "crash-persistence-failure"
    const target = await persistent.ensure(botId)
    const page = isolated.pages()[0]
    await page.goto(`http://crash-a.test:${port}/persistence-failure`)
    await persistent.act(target, { op: "snapshot" }, () => {})
    const newPage = isolated.newPage.bind(context)
    let attempts = 0
    isolated.newPage = async () => {
      attempts++
      return newPage()
    }
    try {
      rejectSave = true
      await crash(page)
      for (let index = 0; index < 3; index++)
        await expect(persistent.frame(botId)).rejects.toThrow("标签页恢复失败")
      expect(attempts).toBe(1)
      expect(isolated.pages()).toHaveLength(0)
      expect(persistent.target(botId).generation).not.toBe(target.generation)
      expect(persistent.requiresObservation(botId)).toBe(true)
    } finally {
      rejectSave = false
      isolated.newPage = newPage
      await persistent.close()
    }
  }, 15_000)

  it("does not recreate a deleted surface after crash recovery was already queued", async () => {
    const botId = "crash-deleted"
    await broker.ensure(botId)
    const page = context.pages()[0]
    await page.goto(`http://crash-a.test:${port}/deleted`)
    const newPage = context.newPage.bind(context)
    let entered!: () => void, resume!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const released = new Promise<void>((resolve) => {
      resume = resolve
    })
    let attempts = 0
    context.newPage = async () => {
      attempts++
      entered()
      await released
      return newPage()
    }
    try {
      await crash(page)
      await started
      await broker.releaseBot(botId)
      resume()
      await expect.poll(() => context.pages().length).toBe(0)
      expect(attempts).toBe(1)
      expect(() => broker.target(botId)).toThrow("尚未准备")
    } finally {
      resume?.()
      context.newPage = newPage
      await broker.releaseBot(botId)
    }
  }, 15_000)
  it.each(["bot", "human"] as const)(
    "does not clear crash fencing or report a late accepted %s key as a new-target success",
    async (mode) => {
      const botId = `crash-late-effect-${mode}`
      const target = await broker.ensure(botId)
      const page = context.pages()[0]
      await page.goto(`http://crash-a.test:${port}/late-effect`)
      await page.locator("textarea").focus()
      await broker.act(target, { op: "snapshot" }, () => {})
      const human = mode === "human" ? await broker.takeControl(target) : undefined
      const humanFrame = human ? await broker.frame(botId) : undefined
      const phases: string[] = []
      broker.humanObserver = async (_id, _page, _input, phase) => {
        phases.push(phase)
      }
      const press = page.keyboard.press.bind(page.keyboard)
      let issued!: () => void, resume!: () => void
      const dispatched = new Promise<void>((resolve) => {
        issued = resolve
      })
      const held = new Promise<void>((resolve) => {
        resume = resolve
      })
      let calls = 0
      page.keyboard.press = async (key, options) => {
        calls++
        await press(key, options)
        issued()
        await held
      }
      const outcome =
        human && humanFrame
          ? broker.humanInput(human, { kind: "key", key: "x", frameSeq: humanFrame.frameSeq })
          : broker.act(target, { op: "press_key", key: "x" }, () => {})
      const rejection = expect(outcome).rejects.toThrow("画面或控制权")
      try {
        await dispatched
        const crashed = new Promise<void>((resolve) => page.once("crash", () => resolve()))
        const failure = crash(page)
        await crashed
        resume()
        await failure
        await rejection
        const recovered = await broker.frame(botId)
        expect(calls).toBe(1)
        if (mode === "human") expect(phases).toEqual(["before", "unconfirmed"])
        expect(recovered.generation).not.toBe(target.generation)
        expect(recovered.title).toContain("原操作结果待核对")
        expect(broker.requiresObservation(botId)).toBe(true)
        const replacement = context.pages()[0]
        expect(await replacement.locator("textarea").count()).toBe(0)
      } finally {
        resume?.()
        broker.humanObserver = undefined
        await broker.releaseBot(botId)
      }
    },
    15_000
  )

  it.each(["bot", "human"] as const)(
    "keeps an already dispatched healthy %s input successful when only its background tab crashes",
    async (mode) => {
      const botId = `healthy-inflight-${mode}`
      const initial = await broker.ensure(botId)
      const foreground = context.pages()[0]
      await foreground.goto(`http://crash-a.test:${port}/healthy-inflight`)
      await broker.act(initial, { op: "snapshot" }, () => {})
      const opened = await broker.act(
        initial,
        { op: "navigate", newTab: true, url: `http://crash-b.test:${port}/unrelated-background` },
        () => {}
      )
      const background = context.pages().find((page) => page !== foreground)!
      const selected = await broker.act(
        opened.target,
        { op: "tabs", action: "select", index: 0 },
        () => {}
      )
      const target = selected.target
      await broker.act(target, { op: "snapshot" }, () => {})
      const phases: string[] = []
      broker.humanObserver = async (_bot, _page, _input, phase) => {
        phases.push(phase)
      }
      const human = mode === "human" ? await broker.takeControl(target) : undefined
      const humanFrame = human ? await broker.frame(botId) : undefined
      await foreground.locator("textarea").focus()
      const press = foreground.keyboard.press.bind(foreground.keyboard)
      let issued!: () => void, resume!: () => void
      const dispatched = new Promise<void>((resolve) => {
        issued = resolve
      })
      const held = new Promise<void>((resolve) => {
        resume = resolve
      })
      let calls = 0
      foreground.keyboard.press = async (key, options) => {
        calls++
        await press(key, options)
        issued()
        await held
      }
      const outcome =
        human && humanFrame
          ? broker.humanInput(human, { kind: "key", key: "x", frameSeq: humanFrame.frameSeq })
          : broker.act(target, { op: "press_key", key: "x" }, () => {})
      try {
        await dispatched
        const crashed = new Promise<void>((resolve) => background.once("crash", () => resolve()))
        const failure = crash(background)
        await crashed
        expect(broker.target(botId).generation).toBe(target.generation)
        expect(broker.requiresObservation(botId)).toBe(false)
        resume()
        await outcome
        await failure
        const recovered = await broker.frame(botId)
        expect(calls).toBe(1)
        expect(await foreground.locator("textarea").inputValue()).toBe("x")
        expect(recovered.generation).toBe(target.generation)
        expect(recovered.viewId).toBe(target.viewId)
        expect(recovered.title).toBe("Original website")
        expect(recovered.tabs[1].title).toContain("原操作结果待核对")
        expect(foreground.isClosed()).toBe(false)
        expect(background.isClosed()).toBe(true)
        if (mode === "human") expect(phases).toEqual(["before", "after"])
      } finally {
        resume?.()
        foreground.keyboard.press = press
        broker.humanObserver = undefined
        await broker.releaseBot(botId)
      }
    },
    15_000
  )

  it("stops after a second crash of the recovery notice instead of an automatic recovery loop", async () => {
    const botId = "crash-repeat"
    await broker.ensure(botId)
    const page = context.pages()[0]
    await page.goto(`http://crash-a.test:${port}/repeat`)
    await crash(page)
    const recovered = await broker.frame(botId)
    const replacement = context.pages()[0]
    expect(recovered.title).toContain("原操作结果待核对")
    const newPage = context.newPage.bind(context)
    let attempts = 0
    context.newPage = async () => {
      attempts++
      return newPage()
    }
    try {
      await crash(replacement)
      await expect(broker.frame(botId)).rejects.toThrow("标签页再次崩溃")
      expect(attempts).toBe(0)
      expect(replacement.isClosed()).toBe(true)
    } finally {
      context.newPage = newPage
      await broker.releaseBot(botId)
    }
  }, 15_000)
})
