import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { chromium, type Browser, type BrowserContext, type Page } from "playwright"
import { BotBrowserBroker } from "./browser-broker"
import {
  isSandBrowserAutoReviewMutatingAction,
  normalizeSandBrowserExactActionArgs
} from "./upstream/grok-browser-review-bounds"

it("preserves Grok's read-only browser operations and exact argument bounds", () => {
  for (const op of ["snapshot", "screenshot", "get_bounding_box", "highlight", "scroll"])
    expect(isSandBrowserAutoReviewMutatingAction({ op })).toBe(false)
  expect(isSandBrowserAutoReviewMutatingAction({ op: "tabs", tabsAction: "select" })).toBe(false)
  expect(isSandBrowserAutoReviewMutatingAction({ op: "tabs", tabsAction: "close" })).toBe(true)
  expect(() =>
    normalizeSandBrowserExactActionArgs({ op: "fill", value: "x".repeat(2001) })
  ).toThrow("oversized")
})

describe.runIf(process.env.CMB_BOT_BROWSER_TEST === "1")("actual browser approval targets", () => {
  let browser: Browser
  const cleanup: (() => Promise<unknown>)[] = []
  beforeAll(async () => {
    browser = await chromium.launch({
      channel: "chrome",
      headless: true,
      args: ["--disable-updater-scheduler"]
    })
  })
  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close()
  })
  afterAll(async () => {
    await browser?.close()
  })
  const check = () => {}
  async function fixture() {
    const context = await browser.newContext()
    const broker = new BotBrowserBroker(context)
    cleanup.push(() => broker.close())
    const target = await broker.ensure("reviewed-bot")
    const page = context.pages()[0]
    await page.setContent(
      '<form action="https://example.test/submit" method="POST"><input id="name" aria-label="Name" value="PRIVATE_VALUE"><input id="secret" type="password" aria-label="Password" value="PRIVATE_SECRET"><button type="button" id="save">Save</button></form>'
    )
    const snapshot = await broker.act(target, { op: "snapshot" }, check)
    const ref = (label: string) =>
      new RegExp(`${label}[^\\n]*?ref=(e\\d+)`).exec(snapshot.data!)![1]
    const action = { op: "fill", ref: ref("Name"), value: "Reviewed value" }
    const review = await broker.prepareReview(target, action, check)
    cleanup.push(() => review.dispose())
    return { broker, target, page, action, review, ref, context }
  }
  it("binds the actual target and form destination without reading existing input values", async () => {
    const f = await fixture()
    expect(f.review.context.elements).toMatchObject([
      {
        id: "name",
        label: "Name",
        formAction: "https://example.test/submit",
        formMethod: "post",
        sensitive: false
      }
    ])
    expect(JSON.stringify(f.review.context)).not.toContain("PRIVATE_")
    await f.broker.assertReview(f.target, f.action, f.review, check)
    await f.broker.act(f.target, f.action, check, undefined, f.review)
    expect(await f.page.locator("#name").inputValue()).toBe("Reviewed value")
  })
  it.each(["form", "replace", "reload", "tab", "arguments", "takeover"] as const)(
    "rejects changed authorization at the serialized dispatch boundary (%s)",
    async (mode) => {
      const f = await fixture()
      if (mode === "form")
        await f.page
          .locator("form")
          .evaluate((node) => node.setAttribute("action", "https://changed.test/submit"))
      if (mode === "replace") {
        await f.page.locator("#name").evaluate((node) => node.replaceWith(node.cloneNode(true)))
        await f.broker.act(f.target, { op: "snapshot" }, check)
      }
      if (mode === "reload") await f.page.reload()
      if (mode === "tab") await f.broker.act(f.target, { op: "tabs", action: "new" }, check)
      if (mode === "takeover") await f.broker.takeControl(f.target)
      const action = mode === "arguments" ? { ...f.action, value: "unreviewed" } : f.action
      let authorized = 0
      await expect(
        f.broker.act(
          f.target,
          action,
          () => {
            authorized++
          },
          undefined,
          f.review
        )
      ).rejects.toThrow()
      expect(authorized).toBe(0)
      if (mode !== "reload")
        expect(await f.page.locator("#name").inputValue()).toBe("PRIVATE_VALUE")
    }
  )
  it("ignores another Bot's pages and keeps password and oversized actions manual", async () => {
    const f = await fixture()
    await f.broker.ensure("other-bot")
    await f.broker.assertReview(f.target, f.action, f.review, check)
    for (const action of [
      { op: "fill", ref: f.ref("Password"), value: "new" },
      { ...f.action, value: "x".repeat(2001) },
      { op: "click", ref: f.ref("Save") }
    ]) {
      const review = await f.broker.prepareReview(f.target, action, check)
      cleanup.push(() => review.dispose())
      expect(review.context.manualReason).toBeTruthy()
      expect(JSON.stringify(review.context)).not.toContain("PRIVATE_SECRET")
    }
    await f.review.dispose()
    await expect(f.broker.assertReview(f.target, f.action, f.review, check)).rejects.toThrow(
      "已变化"
    )
  })
  it("binds the focused element for keyboard input", async () => {
    const f = await fixture()
    await f.page.locator("#name").focus()
    const action = { op: "press_key", key: "A" }
    const review = await f.broker.prepareReview(f.target, action, check)
    cleanup.push(() => review.dispose())
    expect(review.context.elements).toMatchObject([{ id: "name" }])
    await f.page.locator("#secret").focus()
    await expect(f.broker.act(f.target, action, check, undefined, review)).rejects.toThrow("已变化")
    expect(await f.page.locator("#secret").inputValue()).toBe("PRIVATE_SECRET")
  })

  it.each(["formaction", "formmethod", "formenctype", "formtarget"])(
    "fences an export button's changed %s at download dispatch",
    async (attribute) => {
      const f = await fixture()
      await f.page.locator("#save").evaluate((node) => {
        node.setAttribute("type", "submit")
        node.setAttribute("formaction", "https://example.test/export")
        node.setAttribute("formmethod", "post")
        node.setAttribute("formenctype", "application/x-www-form-urlencoded")
        node.setAttribute("formtarget", "_self")
        node.addEventListener("click", () => node.setAttribute("data-clicked", "yes"))
      })
      const action = { op: "click", ref: f.ref("Save"), element: "Export the report" }
      const review = await f.broker.prepareReview(f.target, action, check)
      cleanup.push(() => review.dispose())
      expect(review.context.elements).toMatchObject([
        {
          formAction: "https://example.test/export",
          formMethod: "post",
          formEnctype: "application/x-www-form-urlencoded",
          formTarget: "_self"
        }
      ])
      await f.page.locator("#save").evaluate((node, name) => {
        const values = {
          formaction: "https://changed.test/export",
          formmethod: "get",
          formenctype: "text/plain",
          formtarget: "_blank"
        }
        node.setAttribute(name, values[name as keyof typeof values])
      }, attribute)
      await expect(
        f.broker.downloadFromPage(
          f.target,
          action.ref,
          check,
          new AbortController().signal,
          review,
          action.element
        )
      ).rejects.toMatchObject({ code: "browser_review_changed" })
      expect(await f.page.locator("#save").getAttribute("data-clicked")).toBeNull()
    }
  )

  async function dragFixture() {
    const context = await browser.newContext({ viewport: { width: 800, height: 600 } })
    const broker = new BotBrowserBroker(context)
    cleanup.push(() => broker.close())
    const target = await broker.ensure("pointer-bot")
    const page = context.pages()[0]
    await page.setContent(
      '<style>body{margin:0;height:1400px}button{position:absolute;top:80px;width:80px;height:40px}#source{left:20px}#target{left:280px}</style><button id="source" aria-label="Source">Source</button><button id="target" aria-label="Target">Target</button><script>window.buttons=[];document.addEventListener("mousemove",e=>window.buttons.push(e.buttons))</script>'
    )
    const snapshot = await broker.act(target, { op: "snapshot" }, check)
    const ref = (label: string) => new RegExp(`${label}[^\\n]*ref=(e\\d+)`).exec(snapshot.data!)![1]
    const action = {
      op: "drag",
      sourceRef: ref("Source"),
      targetRef: ref("Target"),
      element: "Drag Source to Target"
    }
    const review = await broker.prepareReview(target, action, check)
    cleanup.push(() => review.dispose())
    return { context, broker, target, page, action, review }
  }
  it.each(["viewport", "geometry", "scroll", "pixels"] as const)(
    "rejects a changed coordinate review before input (%s)",
    async (mode) => {
      const f = await dragFixture()
      if (mode === "viewport") await f.page.setViewportSize({ width: 810, height: 600 })
      if (mode === "geometry")
        await f.page.locator("#target").evaluate((node) => {
          ;(node as HTMLElement).style.left = "400px"
        })
      if (mode === "scroll") await f.page.evaluate(() => scrollTo(0, 20))
      if (mode === "pixels")
        await f.page.evaluate(() => {
          document.body.style.backgroundColor = "red"
        })
      let authorized = 0
      await expect(
        f.broker.act(
          f.target,
          f.action,
          () => {
            authorized++
          },
          undefined,
          f.review
        )
      ).rejects.toMatchObject({ code: "browser_review_changed" })
      expect(authorized).toBe(0)
      expect(f.review.context.coordinateStateIdentity).toMatch(/^[a-f0-9]{64}$/)
      expect(JSON.stringify(f.review.context)).not.toContain("data:image")
      expect(
        await f.page.evaluate(() => (window as unknown as { buttons: number[] }).buttons)
      ).toEqual([])
    }
  )
  it.each(["fill", "click", "type", "select_option"] as const)(
    "rejects takeover during actual driver page resolution before %s input",
    async (op) => {
      const f = await fixture()
      await f.page.setContent(
        '<input aria-label="Input" value="unchanged"><button aria-label="Button" onclick="document.body.dataset.clicked=\'yes\'">Button</button><select aria-label="Choice"><option value="a">A</option><option value="b">B</option></select>'
      )
      const snapshot = await f.broker.act(f.target, { op: "snapshot" }, check)
      const ref = (label: string) =>
        new RegExp(`${label}[^\\n]*ref=(e\\d+)`).exec(snapshot.data!)![1]
      const action = {
        op,
        ref: ref(op === "click" ? "Button" : op === "select_option" ? "Choice" : "Input"),
        element: "Use the approved input",
        value: "changed",
        text: "changed",
        values: ["b"]
      }
      const review = await f.broker.prepareReview(f.target, action, check)
      cleanup.push(() => review.dispose())
      let entered!: () => void, resume!: () => void
      const entering = new Promise<void>((done) => {
          entered = done
        }),
        held = new Promise<void>((done) => {
          resume = done
        })
      const original = f.context.newCDPSession.bind(f.context)
      let intercepted = false
      f.context.newCDPSession = async (page) => {
        const session = await original(page),
          send = session.send.bind(session)
        session.send = (async (method, ...args) => {
          if (method === "Target.getTargetInfo" && !intercepted) {
            intercepted = true
            entered()
            await held
          }
          return send(method, ...args)
        }) as typeof session.send
        return session
      }
      const acting = f.broker.act(f.target, action, check, undefined, review)
      cleanup.push(async () => {
        resume()
        await acting.catch(() => {})
      })
      await entering
      const taking = f.broker.takeControl(f.target)
      resume()
      await expect(acting).rejects.toMatchObject({ code: "stale_target" })
      await taking
      expect(await f.page.locator("input").inputValue()).toBe("unchanged")
      expect(await f.page.locator("select").inputValue()).toBe("a")
      expect(await f.page.evaluate(() => document.body.dataset.clicked)).toBeUndefined()
    }
  )
  it("rechecks takeover after the first input review await", async () => {
    const f = await fixture()
    let count = 0,
      entered!: () => void,
      resume!: () => void
    const entering = new Promise<void>((done) => {
        entered = done
      }),
      held = new Promise<void>((done) => {
        resume = done
      })
    const assert = f.review.assert.bind(f.review)
    f.review.assert = async (...args) => {
      await assert(...args)
      if (++count === 2) {
        entered()
        await held
      }
    }
    const acting = f.broker.act(f.target, f.action, check, undefined, f.review)
    cleanup.push(async () => {
      resume()
      await acting.catch(() => {})
    })
    await entering
    const taking = f.broker.takeControl(f.target)
    resume()
    await expect(acting).rejects.toMatchObject({ code: "stale_target" })
    await taking
    expect(await f.page.locator("#name").inputValue()).toBe("PRIVATE_VALUE")
  })
  it.each(["move-failure", "revoked"] as const)(
    "releases a real pressed mouse button when a drag is interrupted (%s)",
    async (mode) => {
      const f = await dragFixture()
      const move = f.page.mouse.move.bind(f.page.mouse)
      const failure = new Error("original drag interruption")
      let moves = 0,
        revoked = false
      f.page.mouse.move = async (...args) => {
        await move(...args)
        if (++moves === 3) {
          if (mode === "move-failure") throw failure
          revoked = true
        }
      }
      const acting = f.broker.act(
        f.target,
        f.action,
        () => {
          if (revoked) throw failure
        },
        undefined,
        f.review
      )
      await expect(acting).rejects.toBe(failure)
      await move(700, 500)
      expect(
        await f.page.evaluate(() => (window as unknown as { buttons: number[] }).buttons.at(-1))
      ).toBe(0)
    }
  )

  it("rejects takeover during the scoped new-page wrapper await before creating a page", async () => {
    const f = await fixture()
    const internals = f.broker as unknown as {
      currentPage(surface: unknown): Promise<Page>
      scopedContext(
        surface: unknown,
        guard?: () => void
      ): Pick<BrowserContext, "pages" | "newPage" | "newCDPSession">
    }
    const scoped = internals.scopedContext.bind(internals),
      current = internals.currentPage.bind(internals)
    let inWrapper = false,
      intercepted = false,
      entered!: () => void,
      resume!: () => void
    const entering = new Promise<void>((done) => {
        entered = done
      }),
      held = new Promise<void>((done) => {
        resume = done
      })
    internals.scopedContext = (surface, guard) => {
      const context = scoped(surface, guard),
        newPage = context.newPage.bind(context)
      context.newPage = async () => {
        inWrapper = true
        return newPage()
      }
      return context
    }
    internals.currentPage = async (surface) => {
      const page = await current(surface)
      if (inWrapper && !intercepted) {
        intercepted = true
        entered()
        await held
      }
      return page
    }
    let created = 0
    const newPage = f.context.newPage.bind(f.context)
    f.context.newPage = async () => {
      created++
      return newPage()
    }
    const acting = f.broker.act(f.target, { op: "tabs", action: "new" }, check)
    cleanup.push(async () => {
      resume()
      await acting.catch(() => {})
    })
    await entering
    const taking = f.broker.takeControl(f.target).then(
      (value) => value,
      (error) => error
    )
    resume()
    await expect(acting).rejects.toMatchObject({ code: "stale_target" })
    await taking
    expect(created).toBe(0)
    expect(f.context.pages()).toHaveLength(1)
  })
})
