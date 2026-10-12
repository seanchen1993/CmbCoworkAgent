import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { chromium, type Browser, type BrowserContext, type Page } from "playwright"
import { BotNativeSelectController, type BotNativeSelectObservation } from "./browser-native-select"
import { BotBrowserBroker } from "./browser-broker"
import { BrowserBotTeachSource } from "./teach-browser-source"
import type { BotBrowserFrame } from "../../shared/bot-computer"

const enabled = process.env.CMB_BOT_BROWSER_TEST === "1"
const html =
  '<label for="region">地区</label><select id="region" style="position:absolute;left:20px;top:40px;width:220px;height:40px"><option value="">请选择地区</option><optgroup label="常用"><option value="same">东区</option><option value="same">西区</option></optgroup><optgroup label="停用" disabled><option value="north">北区</option></optgroup></select>'
const guard = { prepare: async () => {}, assert: () => {} }

describe.runIf(enabled)("human native select on the owned browser surface", () => {
  // Browser integration includes process startup; parallel project typechecks are not its latency contract.
  vi.setConfig({ testTimeout: 15_000 })
  let browser: Browser
  const contexts: BrowserContext[] = [],
    controllers: BotNativeSelectController[] = []
  beforeAll(async () => {
    browser = await chromium.launch({
      channel: process.env.CMB_BOT_BROWSER_CHANNEL || "chrome",
      headless: true,
      chromiumSandbox: true,
      args: ["--disable-updater-scheduler"]
    })
  }, 30_000)
  afterEach(async () => {
    for (const controller of controllers.splice(0)) await controller.close()
    for (const context of contexts.splice(0)) await context.close()
  })
  afterAll(async () => {
    await browser?.close()
  })
  async function fixture(markup = html) {
    const context = await browser.newContext({
      viewport: { width: 1920, height: 1200 }
    })
    contexts.push(context)
    await context.route("**/*", (route) => route.abort())
    const page = await context.newPage()
    await page.setContent(markup)
    const controller = new BotNativeSelectController()
    controllers.push(controller)
    await page.locator("select").first().focus()
    return { page, controller, context }
  }
  async function captured(controller: BotNativeSelectController, page: Page) {
    const view = await controller.capture(page)
    expect(view).toBeDefined()
    return view!
  }
  async function brokerFixture() {
    const context = await browser.newContext({
      viewport: { width: 1920, height: 1200 }
    })
    contexts.push(context)
    await context.route("**/*", (route) => route.abort())
    const broker = new BotBrowserBroker(context)
    const client = new AbortController()
    const target = await broker.ensure("select-owner")
    const page = context.pages()[0]
    await page.setContent(
      html +
        '<button id="save" style="position:absolute;left:300px;top:40px;width:100px;height:40px" onclick="this.dataset.count=String(Number(this.dataset.count||0)+1)">提交</button>'
    )
    await broker.takeControl(target, undefined, undefined, client.signal)
    let frame = await broker.frame("select-owner", client.signal)
    await broker.humanInput(
      frame,
      {
        kind: "click",
        x: 50,
        y: 60,
        frameSeq: frame.frameSeq,
        navigationEpoch: frame.navigationEpoch
      },
      client.signal
    )
    frame = await broker.frame("select-owner", client.signal)
    expect(frame.nativeSelect?.label).toBe("地区")
    return { broker, page, client, frame }
  }
  function choice(frame: BotBrowserFrame, indices: number[]) {
    return {
      kind: "select_option" as const,
      frameSeq: frame.frameSeq,
      navigationEpoch: frame.navigationEpoch,
      selectToken: frame.nativeSelect!.token,
      optionIndices: indices
    }
  }

  it("opens from a pixel click, selects duplicate values by exact index, and observes actual results", async () => {
    const f = await brokerFixture()
    const events: {
      phase: string
      selection?: BotNativeSelectObservation
    }[] = []
    f.broker.humanObserver = async (_id, _page, _input, phase, selection) => {
      events.push({ phase, selection })
    }
    await f.broker.humanInput(f.frame, choice(f.frame, [2]), f.client.signal)
    expect(
      await f.page.locator("select").evaluate((element: HTMLSelectElement) => element.selectedIndex)
    ).toBe(2)
    expect(events).toMatchObject([
      { phase: "before", selection: { requested: [2], selected: [0] } },
      {
        phase: "after",
        selection: {
          requested: [2],
          selected: [2],
          labels: [{ index: 2, label: "西区" }]
        }
      }
    ])
    const after = await f.broker.frame("select-owner", f.client.signal)
    expect(after.nativeSelect).toBeUndefined()
    await expect(
      f.broker.humanInput(f.frame, choice(f.frame, [1]), f.client.signal)
    ).rejects.toMatchObject({ code: "stale_frame" })
    await f.broker.humanInput(
      after,
      {
        kind: "click",
        frameSeq: after.frameSeq,
        navigationEpoch: after.navigationEpoch,
        x: 320,
        y: 60
      },
      f.client.signal
    )
    expect(await f.page.locator("#save").getAttribute("data-count")).toBe("1")
    await f.broker.close()
  })
  it("keeps the token across passive observations, but rejects an old frame", async () => {
    const f = await brokerFixture()
    const next = await f.broker.frame("select-owner", f.client.signal)
    expect(next.nativeSelect?.token).toBe(f.frame.nativeSelect?.token)
    await expect(
      f.broker.humanInput(f.frame, choice(f.frame, [1]), f.client.signal)
    ).rejects.toMatchObject({ code: "stale_frame" })
    expect(await f.page.locator("select").inputValue()).toBe("")
    await f.broker.humanInput(next, choice(next, [1]), f.client.signal)
    await f.broker.close()
  })
  it("projects only visible enabled choices and does not disclose option values", async () => {
    const f = await fixture(),
      view = await captured(f.controller, f.page)
    expect(view.options).toMatchObject([
      { index: 0, label: "请选择地区" },
      { index: 1, label: "东区", group: "常用" },
      { index: 2, label: "西区" }
    ])
    expect(JSON.stringify(view)).not.toContain('"value"')
    expect(JSON.stringify(view)).not.toContain('"same"')
    expect(JSON.stringify(view)).not.toContain("北区")
    await expect(
      f.controller.select(f.page, view.token, [3], guard, async () => {})
    ).rejects.toMatchObject({ code: "invalid_input" })
    expect(await f.page.locator("select").inputValue()).toBe("")
  })
  it("does not project hidden options or unavailable controls", async () => {
    const f = await fixture(
      '<select><option value="shown">显示</option><option hidden value="hidden">隐藏</option><option disabled value="disabled">停用</option></select>'
    )
    const view = await captured(f.controller, f.page)
    expect(view.options).toEqual([{ index: 0, label: "显示", selected: true }])
    await expect(
      f.controller.select(f.page, view.token, [1], guard, async () => {})
    ).rejects.toMatchObject({ code: "invalid_input" })
    f.controller.reset()
    await f.page.setContent("<select><option>可用</option></select>")
    await f.page.locator("select").focus()
    await captured(f.controller, f.page)
    await f.page.locator("select").evaluate((element: HTMLSelectElement) => {
      element.disabled = true
    })
    expect(await f.controller.capture(f.page)).toBeUndefined()
  })
  it.each([[], [1, 2], [1, 1], [-1], [256], [1.5], ["1"]].map((indices) => [indices]))(
    "rejects malformed single-select indices %j",
    async (indices) => {
      const f = await fixture(),
        view = await captured(f.controller, f.page)
      await expect(
        f.controller.select(f.page, view.token, indices, guard, async () => {})
      ).rejects.toMatchObject({ code: "invalid_input" })
      expect(await f.page.locator("select").inputValue()).toBe("")
    }
  )
  it("supports an explicit multiple combination and explicit clearing", async () => {
    const f = await fixture(
      '<select multiple><option value="a">甲</option><option value="b">乙</option><option value="c">丙</option></select>'
    )
    let view = await captured(f.controller, f.page)
    const selected = await f.controller.select(f.page, view.token, [0, 2], guard, async () => {})
    expect(selected.selected).toEqual([0, 2])
    f.controller.reset()
    view = await captured(f.controller, f.page)
    expect(
      (await f.controller.select(f.page, view.token, [], guard, async () => {})).selected
    ).toEqual([])
  })
  it("rejects changes to the same option's hidden value after capture", async () => {
    const f = await fixture(),
      view = await captured(f.controller, f.page)
    await f.page.locator("select").evaluate((element: HTMLSelectElement) => {
      element.options[1].value = "changed"
    })
    await expect(
      f.controller.select(f.page, view.token, [1], guard, async () => {})
    ).rejects.toMatchObject({ code: "stale_frame" })
    expect(await f.page.locator("select").inputValue()).toBe("")
  })
  it("rejects an identically rendered replacement element", async () => {
    const f = await fixture(),
      view = await captured(f.controller, f.page)
    await f.page.locator("select").evaluate((element) => {
      element.replaceWith(element.cloneNode(true))
    })
    await f.page.locator("select").focus()
    await expect(
      f.controller.select(f.page, view.token, [1], guard, async () => {})
    ).rejects.toMatchObject({ code: "stale_frame" })
    expect(await f.page.locator("select").inputValue()).toBe("")
  })
  it("revalidates after Teach's await and never retries an unconfirmed dispatch", async () => {
    const f = await fixture(),
      view = await captured(f.controller, f.page)
    await expect(
      f.controller.select(f.page, view.token, [1], guard, async () => {
        await f.page.locator("select").evaluate((element: HTMLSelectElement) => {
          element.options[1].text = "changed"
        })
      })
    ).rejects.toMatchObject({ code: "stale_frame" })
    expect(await f.page.locator("select").inputValue()).toBe("")
    await expect(
      f.controller.select(f.page, view.token, [1], guard, async () => {})
    ).rejects.toMatchObject({ code: "stale_frame" })
  })
  it("selects in the focused iframe and rejects its re-navigation", async () => {
    const f = await fixture()
    await f.page.setContent("<iframe></iframe>")
    await f.page.locator("iframe").evaluate((element: HTMLIFrameElement) => {
      element.srcdoc =
        '<select><option value="">空</option><option value=east>东区</option></select>'
    })
    await f.page.waitForFunction(() =>
      (document.querySelector("iframe") as HTMLIFrameElement).contentDocument?.querySelector(
        "select"
      )
    )
    const child = f.page.frames()[1]
    await child.locator("select").focus()
    let view = await captured(f.controller, f.page)
    expect(
      (await f.controller.select(f.page, view.token, [1], guard, async () => {})).selected
    ).toEqual([1])
    f.controller.reset()
    view = await captured(f.controller, f.page)
    await child.setContent("<select><option>新文档</option><option>东区</option></select>")
    await child.locator("select").focus()
    await expect(
      f.controller.select(f.page, view.token, [1], guard, async () => {})
    ).rejects.toMatchObject({ code: "stale_frame" })
  })
  it("finds a focused shadow select without scanning unrelated frames", async () => {
    const f = await fixture()
    await f.page.setContent(
      '<div id="root"></div><iframe srcdoc="<select><option>无关</option></select>"></iframe>'
    )
    await f.page.evaluate(() => {
      const root = document.querySelector("#root")!.attachShadow({ mode: "open" })
      root.innerHTML = "<select><option>甲</option><option>乙</option></select>"
      root.querySelector("select")!.focus()
    })
    const view = await captured(f.controller, f.page)
    expect(
      (await f.controller.select(f.page, view.token, [1], guard, async () => {})).labels
    ).toEqual([{ index: 1, label: "乙" }])
  })
  it("retires the capability on dismissal, control handback, or another client", async () => {
    const f = await brokerFixture()
    const other = new AbortController()
    await expect(
      f.broker.humanInput(f.frame, choice(f.frame, [1]), other.signal)
    ).rejects.toMatchObject({ code: "computer_owned_elsewhere" })
    await f.broker.humanInput(
      f.frame,
      {
        kind: "select_dismiss",
        frameSeq: -1,
        selectToken: f.frame.nativeSelect!.token
      },
      f.client.signal
    )
    expect((await f.broker.frame("select-owner", f.client.signal)).nativeSelect).toBeUndefined()
    await f.broker.releaseControl(f.broker.target("select-owner"), f.client.signal)
    await expect(
      f.broker.humanInput(f.frame, choice(f.frame, [1]), f.client.signal)
    ).rejects.toThrow()
    await f.broker.close()
  })
  it("bounds options and complete identities, refusing silently truncated controls", async () => {
    const f = await fixture("<select>" + "<option>项</option>".repeat(257) + "</select>")
    expect(await f.controller.capture(f.page)).toBeUndefined()
    await f.page.setContent('<select><option value="' + "x".repeat(1025) + '">项</option></select>')
    await f.page.locator("select").focus()
    expect(await f.controller.capture(f.page)).toBeUndefined()
  })
  it("passes actual post-selection facts through the existing Teach source", async () => {
    const f = await brokerFixture(),
      source = new BrowserBotTeachSource(f.broker)
    const observed: Record<string, unknown>[] = []
    const detach = source.attach("select-owner", {
      beforeTransfer: async () => {},
      input: async (_botId, _view, input, phase) => {
        if (phase === "before") observed.push(await input.details())
        if (phase === "after") observed.push((await input.afterDetails?.()) ?? {})
      }
    })
    try {
      await f.broker.humanInput(f.frame, choice(f.frame, [1]), f.client.signal)
      expect(observed[0]).toMatchObject({
        selection: { requested: [1], selected: [0] }
      })
      expect(observed[1]).toMatchObject({
        selection: { selected: [1], labels: [{ label: "东区" }] }
      })
    } finally {
      detach()
      await f.broker.close()
    }
  })
})
