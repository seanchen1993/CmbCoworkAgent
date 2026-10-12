import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { chromium, type Browser } from "playwright"
import { BotBrowserBroker } from "./browser-broker"
import { isSandBrowserAutoReviewMutatingAction } from "./upstream/grok-browser-review-bounds"

// Real owned Chromium pages. No application profile, model, task or oracle is used.
describe.runIf(process.env.CMB_BOT_BROWSER_TEST === "1")("owned browser viewport resize", () => {
  let browser: Browser
  const cleanup: (() => Promise<unknown>)[] = []
  const check = () => {}
  beforeAll(async () => {
    browser = await chromium.launch({ channel: "chrome", headless: true })
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    for (const close of cleanup.splice(0).reverse()) await close()
  })
  afterAll(async () => {
    await browser?.close()
  })
  async function fixture() {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    const broker = new BotBrowserBroker(context)
    cleanup.push(() => broker.close())
    const target = await broker.ensure("viewport-bot")
    const page = context.pages()[0]
    await page.setContent(`<style>#narrow{display:none}@media(max-width:400px){#narrow{display:block}}</style>
      <p id="narrow">Narrow layout</p><button onclick="document.body.dataset.clicked='yes'">Save</button>
      <input aria-label="Name"><script>window.keys=[];document.addEventListener('keydown',e=>window.keys.push(e.key))</script>`)
    const snapshot = await broker.act(target, { op: "snapshot" }, check)
    const ref = /Save[^\n]*ref=(e\d+)/.exec(snapshot.data!)![1]
    const action = { op: "resize", width: 375, height: 812 }
    const review = await broker.prepareReview(target, action, check)
    cleanup.push(() => review.dispose())
    return { context, broker, target, page, ref, action, review }
  }

  it("changes actual CSS viewport only on the owned page and requires fresh refs", async () => {
    const f = await fixture()
    const other = await f.broker.ensure("other-bot")
    const beforeOther = await f.broker.frame(other.botId)
    expect(isSandBrowserAutoReviewMutatingAction(f.action)).toBe(true)
    const result = await f.broker.act(f.target, f.action, check, undefined, f.review)
    expect(JSON.parse(result.data!)).toEqual({
      viewport: { width: 375, height: 812 },
      unit: "css-px",
      requiresSnapshot: true
    })
    expect(await f.page.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual({
      width: 375,
      height: 812
    })
    expect(await f.page.locator("#narrow").isVisible()).toBe(true)
    expect(result.target.viewId).toBe(f.target.viewId)
    expect(result.target.controlEpoch).toBe(f.target.controlEpoch)
    expect(result.target.generation).not.toBe(f.target.generation)
    expect(f.broker.requiresObservation(f.target.botId)).toBe(true)
    await expect(f.broker.act(f.target, { op: "snapshot" }, check)).rejects.toMatchObject({
      code: "stale_target"
    })
    await expect(
      f.broker.act(result.target, { op: "click", ref: f.ref }, check)
    ).rejects.toMatchObject({ code: "computer_reobserve" })
    await f.broker.act(result.target, { op: "screenshot" }, check)
    await expect(f.broker.act(result.target, { op: "click", ref: f.ref }, check)).rejects.toThrow(
      "Unknown or stale ref"
    )
    const fresh = await f.broker.act(result.target, { op: "snapshot" }, check)
    const freshRef = /Save[^\n]*ref=(e\d+)/.exec(fresh.data!)![1]
    await f.broker.act(fresh.target, { op: "click", ref: freshRef }, check)
    expect(await f.page.locator("body").getAttribute("data-clicked")).toBe("yes")
    const frame = await f.broker.frame(f.target.botId)
    expect([frame.width, frame.height]).toEqual([375, 812])
    const afterOther = await f.broker.frame(other.botId)
    expect([afterOther.width, afterOther.height, afterOther.generation]).toEqual([
      beforeOther.width,
      beforeOther.height,
      beforeOther.generation
    ])
    expect(f.broker.requiresObservation(other.botId)).toBe(false)
  })

  it("rejects already queued keys and old coordinate approvals after resize", async () => {
    const f = await fixture()
    const click = { op: "mouse_click_xy", x: 20, y: 20, element: "Click the visible button" }
    const oldReview = await f.broker.prepareReview(f.target, click, check)
    cleanup.push(() => oldReview.dispose())
    const resizing = f.broker.act(f.target, f.action, check, undefined, f.review)
    const key = f.broker.act(f.target, { op: "press_key", key: "A" }, check)
    const rejected = expect(key).rejects.toMatchObject({ code: "stale_target" })
    const result = await resizing
    await rejected
    expect(await f.page.evaluate(() => (window as unknown as { keys: string[] }).keys)).toEqual([])
    await expect(f.broker.act(f.target, click, check, undefined, oldReview)).rejects.toMatchObject({
      code: "stale_target"
    })
    await f.broker.act(result.target, { op: "snapshot" }, check)
    await expect(
      f.broker.act(result.target, click, check, undefined, oldReview)
    ).rejects.toMatchObject({ code: "browser_review_changed" })
  })

  it("keeps human control and pre-dispatch lease rejection outside resize", async () => {
    const f = await fixture()
    const resize = vi.spyOn(f.page, "setViewportSize")
    await expect(
      f.broker.act(
        f.target,
        f.action,
        () => {
          throw new Error("LEASE_REVOKED")
        },
        undefined,
        f.review
      )
    ).rejects.toThrow("LEASE_REVOKED")
    expect(resize).not.toHaveBeenCalled()
    expect(f.broker.target(f.target.botId).generation).toBe(f.target.generation)
    const human = await f.broker.takeControl(f.target)
    await expect(f.broker.act(human, f.action, check, undefined, f.review)).rejects.toMatchObject({
      code: "stale_target"
    })
    expect(resize).not.toHaveBeenCalled()
    expect(f.broker.target(f.target.botId).control).toBe("human")
    expect(f.page.viewportSize()).toEqual({ width: 1280, height: 800 })
  })

  it("retires old frames and refs when an applied resize loses its reply", async () => {
    const f = await fixture()
    const original = f.page.setViewportSize.bind(f.page)
    vi.spyOn(f.page, "setViewportSize").mockImplementationOnce(async (size) => {
      await original(size)
      throw new Error("REPLY_LOST_AFTER_APPLY")
    })
    await expect(f.broker.act(f.target, f.action, check, undefined, f.review)).rejects.toThrow(
      "REPLY_LOST_AFTER_APPLY"
    )
    const freshTarget = f.broker.target(f.target.botId)
    expect(freshTarget.generation).not.toBe(f.target.generation)
    expect(f.broker.requiresObservation(f.target.botId)).toBe(true)
    expect(f.page.viewportSize()).toEqual({ width: 375, height: 812 })
    await expect(
      f.broker.act(f.target, { op: "press_key", key: "A" }, check)
    ).rejects.toMatchObject({ code: "stale_target" })
    await f.broker.act(freshTarget, { op: "screenshot" }, check)
    await expect(f.broker.act(freshTarget, { op: "click", ref: f.ref }, check)).rejects.toThrow(
      "Unknown or stale ref"
    )
  })

  it("settles takeover during an issued resize and rejects prior human frame authority", async () => {
    const f = await fixture()
    const oldHuman = await f.broker.takeControl(f.target)
    const oldFrame = await f.broker.frame(f.target.botId)
    const target = await f.broker.releaseControl(oldHuman)
    await f.broker.act(target, { op: "snapshot" }, check)
    const review = await f.broker.prepareReview(target, f.action, check)
    cleanup.push(() => review.dispose())
    let entered!: () => void, resume!: () => void
    const started = new Promise<void>((done) => {
      entered = done
    })
    const held = new Promise<void>((done) => {
      resume = done
    })
    const original = f.page.setViewportSize.bind(f.page)
    vi.spyOn(f.page, "setViewportSize").mockImplementationOnce(async (size) => {
      entered()
      await held
      await original(size)
    })
    const resize = f.broker.act(target, f.action, check, undefined, review)
    const rejected = expect(resize).rejects.toMatchObject({ code: "stale_target" })
    await started
    const takeover = f.broker.takeControl(target)
    resume()
    await rejected
    const human = await takeover
    expect(human.control).toBe("human")
    expect(human.generation).not.toBe(target.generation)
    await expect(
      f.broker.humanInput(oldHuman, {
        frameSeq: oldFrame.frameSeq,
        navigationEpoch: oldFrame.navigationEpoch,
        kind: "key",
        key: "A"
      })
    ).rejects.toMatchObject({ code: "stale_target" })
    const frame = await f.broker.frame(f.target.botId)
    await f.broker.humanInput(human, {
      frameSeq: frame.frameSeq,
      navigationEpoch: frame.navigationEpoch,
      kind: "key",
      key: "B"
    })
    expect(await f.page.evaluate(() => (window as unknown as { keys: string[] }).keys)).toEqual([
      "B"
    ])
  })
})
