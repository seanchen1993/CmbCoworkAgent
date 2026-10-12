import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { chromium, type Browser } from "playwright"
import { BotBrowserBroker } from "./browser-broker"
import type { BotBrowserFrame, BotHumanInput } from "../../shared/bot-computer"

const enabled = process.env.CMB_BOT_BROWSER_TEST === "1"

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => (resolve = done))
  return { promise, resolve }
}

/** Actual isolated Chromium. No model, application profile, task or credentials. */
describe.runIf(enabled)("continuous owned human browser input", () => {
  let browser: Browser
  const cleanup: (() => Promise<unknown>)[] = []
  beforeAll(async () => {
    browser = await chromium.launch({ channel: "chrome", headless: true, chromiumSandbox: true })
  }, 30_000)
  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close()
  })
  afterAll(async () => {
    await browser?.close()
  })
  async function fixture() {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1200 } })
    const broker = new BotBrowserBroker(context)
    cleanup.push(() => broker.close())
    const target = await broker.ensure("human-stream")
    const page = context.pages()[0]
    await page.setContent(`<!doctype html><title>Human stream</title>
      <input id="month" style="position:absolute;left:20px;top:20px">
      <select id="region" size="2" style="position:absolute;left:300px;top:20px;width:200px;height:60px">
      <option value="">Choose</option><option value="east">East</option></select>
      <script>window.events=[];document.addEventListener('keydown',e=>events.push('key:'+e.key));
      document.addEventListener('click',e=>events.push('click:'+(e.target.closest('select')?.id||e.target.id)));
      document.querySelector('input').addEventListener('input',e=>events.push('input:'+e.target.value))</script>`)
    await page.locator("input").focus()
    const client = new AbortController()
    await broker.takeControl(target, undefined, undefined, client.signal)
    const frame = await broker.frame(target.botId, client.signal)
    expect(frame.humanInputLease).toBeDefined()
    const input = (
      sequence: number,
      value: Omit<BotHumanInput, "frameSeq" | "navigationEpoch" | "humanInputLease">,
      source: BotBrowserFrame = frame
    ) =>
      broker.humanInput(
        source,
        {
          ...value,
          frameSeq: source.frameSeq,
          navigationEpoch: source.navigationEpoch,
          humanInputLease: { id: source.humanInputLease!.id, sequence }
        },
        client.signal
      )
    return { broker, page, client, frame, input }
  }

  it("executes type-click-key in order against the original source frame without a JPEG round trip", async () => {
    const f = await fixture()
    await f.input(1, { kind: "text", text: "2026-10" })
    await f.input(2, { kind: "click", x: 320, y: 30 })
    await f.input(3, { kind: "key", key: "ArrowDown" })
    await f.input(4, { kind: "key", key: "Enter" })
    expect(await f.page.locator("input").inputValue()).toBe("2026-10")
    expect(await f.page.locator("select").inputValue()).toBe("east")
    expect(await f.page.evaluate(() => Reflect.get(window, "events"))).toEqual([
      "input:2026-10",
      "click:region",
      "key:ArrowDown",
      "key:Enter"
    ])
    await expect(f.input(4, { kind: "key", key: "Enter" })).rejects.toMatchObject({
      code: "stale_frame"
    })
    const next = await f.broker.frame(f.frame.botId, f.client.signal)
    expect(next.humanInputLease).toEqual({ id: f.frame.humanInputLease!.id, nextSequence: 5 })
  })

  it("bounds actual Host admission and preserves admitted order behind one active effect", async () => {
    const f = await fixture()
    const entered = deferred(),
      release = deferred()
    cleanup.push(async () => release.resolve())
    f.broker.humanObserver = async (_bot, _page, _input, phase) => {
      if (phase === "before") {
        entered.resolve()
        await release.promise
      }
    }
    const pending = Array.from({ length: 16 }, (_, index) =>
      f.input(index + 1, { kind: "key", key: "a" })
    )
    const settled = Promise.allSettled(pending)
    await entered.promise
    await expect(f.input(17, { kind: "key", key: "b" })).rejects.toMatchObject({
      code: "input_queue_full"
    })
    release.resolve()
    expect((await settled).every((result) => result.status === "fulfilled")).toBe(true)
    expect(await f.page.locator("input").inputValue()).toBe("a".repeat(16))
    await f.input(17, { kind: "key", key: "c" })
    expect(await f.page.locator("input").inputValue()).toBe("a".repeat(16) + "c")
  })

  it("bounds aggregate retained characters without consuming the overflow sequence", async () => {
    const f = await fixture()
    const entered = deferred(),
      release = deferred()
    cleanup.push(async () => release.resolve())
    f.broker.humanObserver = async (_bot, _page, _input, phase) => {
      if (phase === "before") {
        entered.resolve()
        await release.promise
      }
    }
    const settled = Promise.allSettled([
      f.input(1, { kind: "text", text: "a".repeat(16_000) }),
      f.input(2, { kind: "text", text: "b".repeat(16_000) })
    ])
    await entered.promise
    await expect(f.input(3, { kind: "key", key: "x" })).rejects.toMatchObject({
      code: "input_queue_full"
    })
    release.resolve()
    expect((await settled).every((result) => result.status === "fulfilled")).toBe(true)
    expect((await f.page.locator("input").inputValue()).length).toBe(32_000)
    await f.input(3, { kind: "key", key: "x" })
  })

  it("rejects original pointers while navigation is pending and after a same-URL document replacement", async () => {
    const f = await fixture()
    const requested = deferred(),
      release = deferred()
    cleanup.push(async () => release.resolve())
    await f.page.route("http://human-stream.invalid/**", async (route) => {
      requested.resolve()
      await release.promise
      await route.fulfill({
        contentType: "text/html",
        body: '<input id="new"><button>New</button>'
      })
    })
    const navigating = f.page.goto("http://human-stream.invalid/page")
    const settled = Promise.allSettled([navigating])
    await requested.promise
    const pendingFrame = await f.broker.frame(f.frame.botId, f.client.signal)
    expect(pendingFrame.humanInputPending).toBe(true)
    expect(pendingFrame.humanInputLease).toBeUndefined()
    await expect(
      f.broker.humanInput(
        pendingFrame,
        { kind: "click", x: 320, y: 30, frameSeq: pendingFrame.frameSeq },
        f.client.signal
      )
    ).rejects.toMatchObject({ code: "stale_frame" })
    await expect(f.input(1, { kind: "click", x: 320, y: 30 })).rejects.toMatchObject({
      code: "stale_frame"
    })
    release.resolve()
    expect((await settled)[0].status).toBe("fulfilled")
    const next = await f.broker.frame(f.frame.botId, f.client.signal)
    expect(next.humanInputLease!.id).not.toBe(f.frame.humanInputLease!.id)
    await f.page.reload()
    await expect(f.input(1, { kind: "click", x: 320, y: 30 }, next)).rejects.toMatchObject({
      code: "stale_frame"
    })
  })

  it("retires queued inputs immediately on control transfer before their effects start", async () => {
    const f = await fixture()
    const entered = deferred(),
      release = deferred()
    cleanup.push(async () => release.resolve())
    f.broker.humanObserver = async (_bot, _page, _input, phase) => {
      if (phase === "before") {
        entered.resolve()
        await release.promise
      }
    }
    const first = f.input(1, { kind: "key", key: "a" })
    const settledFirst = Promise.allSettled([first])
    await entered.promise
    const second = f.input(2, { kind: "key", key: "b" })
    const nextClient = new AbortController()
    const transfer = f.broker.takeControl(f.frame, undefined, undefined, nextClient.signal, true)
    const settled = Promise.allSettled([second, transfer])
    release.resolve()
    expect((await settledFirst)[0].status).toBe("rejected")
    expect((await settled).map((result) => result.status)).toEqual(["rejected", "fulfilled"])
    expect(await f.page.locator("input").inputValue()).toBe("")
    const next = await f.broker.frame(f.frame.botId, nextClient.signal)
    expect(next.humanInputLease!.id).not.toBe(f.frame.humanInputLease!.id)
  })

  it("rejects forged source tickets and changed viewport without dispatch", async () => {
    const f = await fixture()
    await expect(
      f.input(1, { kind: "key", key: "a" }, { ...f.frame, frameSeq: f.frame.frameSeq + 100 })
    ).rejects.toMatchObject({ code: "stale_frame" })
    await f.page.setViewportSize({ width: 900, height: 600 })
    await expect(f.input(1, { kind: "click", x: 320, y: 30 })).rejects.toMatchObject({
      code: "stale_frame"
    })
    expect(await f.page.locator("input").inputValue()).toBe("")
    const next = await f.broker.frame(f.frame.botId, f.client.signal)
    expect(next.humanInputLease!.id).not.toBe(f.frame.humanInputLease!.id)
  })

  it("does not replay an applied but unconfirmed effect or its subsequent inputs", async () => {
    const f = await fixture()
    f.broker.humanObserver = async (_bot, _page, _input, phase) => {
      if (phase === "after") throw new Error("Controlled post-effect uncertainty")
    }
    await expect(f.input(1, { kind: "key", key: "a" })).rejects.toThrow("post-effect uncertainty")
    await expect(f.input(2, { kind: "key", key: "b" })).rejects.toMatchObject({
      code: "stale_frame"
    })
    expect(await f.page.locator("input").inputValue()).toBe("a")
    const next = await f.broker.frame(f.frame.botId, f.client.signal)
    expect(next.humanInputLease!.id).not.toBe(f.frame.humanInputLease!.id)
  })
})
