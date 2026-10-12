import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { chromium, type Browser } from "playwright"
import { createHash } from "node:crypto"
import { BotBrowserBroker } from "./browser-broker"
import { prepareBotBrowserReview } from "./browser-review"
import { botBrowserUploadFiles, BOT_BROWSER_UPLOAD_BYTES } from "../../shared/bot-browser-upload"

const bytes = Buffer.from("\ufeffid,amount\r\nA,12.30\r\n", "utf8")
const metadata = {
  id: "current-original",
  name: "original.csv",
  mime: "text/csv",
  size: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex")
}
it("bounds complete original payloads before reading objects", () => {
  expect(() => botBrowserUploadFiles.parse([metadata, metadata])).toThrow()
  expect(() =>
    botBrowserUploadFiles.parse([{ ...metadata, size: BOT_BROWSER_UPLOAD_BYTES + 1 }])
  ).toThrow()
  expect(() =>
    botBrowserUploadFiles.parse([
      { ...metadata, size: BOT_BROWSER_UPLOAD_BYTES },
      { ...metadata, id: "two" }
    ])
  ).toThrow()
  expect(() => botBrowserUploadFiles.parse([{ ...metadata, name: "../secret.txt" }])).toThrow()
})

describe.runIf(process.env.CMB_BOT_BROWSER_TEST === "1")("actual owned website file input", () => {
  let browser: Browser
  const cleanup: (() => Promise<unknown>)[] = []
  beforeAll(async () => {
    browser = await chromium.launch({
      channel:
        process.env.CMB_BOT_BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : "chrome"),
      headless: true,
      chromiumSandbox: true,
      // Keep this integration fixture aligned with the native provider. Chrome's
      // updater child can retain transport pipes and make an otherwise complete
      // browser shutdown exceed Vitest's default hook budget.
      args: ["--disable-updater-scheduler"]
    })
  }, 30_000)
  afterEach(async () => {
    vi.restoreAllMocks()
    for (const close of cleanup.splice(0).reverse()) await close()
  })
  afterAll(async () => {
    await browser?.close()
  }, 30_000)
  const check = () => {}
  async function fixture() {
    const context = await browser.newContext()
    const broker = new BotBrowserBroker(context)
    cleanup.push(() => broker.close())
    const received: Buffer[] = []
    const html = `<title>Reviewed upload</title><form action="/submit"><label for="file">Upload original</label><input id="file" type="file" accept=".csv" multiple><input id="text" aria-label="Text"><button type="button">Another target</button></form>
      <script>document.querySelector('#file').addEventListener('change', async e=>{for(const file of e.target.files){await fetch('/receive',{method:'POST',body:await file.arrayBuffer()})} document.body.dataset.selected='yes'})</script>`
    await context.route("https://upload.test/**", async (route) => {
      if (new URL(route.request().url()).pathname === "/receive") {
        received.push(route.request().postDataBuffer()!)
        await route.fulfill({ status: 200, body: "received" })
      } else await route.fulfill({ status: 200, contentType: "text/html", body: html })
    })
    const target = await broker.ensure("upload-owner")
    const page = context.pages()[0]
    await page.goto("https://upload.test/form")
    const snapshot = await broker.act(target, { op: "snapshot" }, check)
    const ref = /Upload original[^\n]*ref=(e\d+)/.exec(snapshot.data!)?.[1]
    expect(ref).toBeTruthy()
    const review = await broker.prepareUpload(target, ref!, [metadata], check)
    cleanup.push(() => review.dispose())
    return { context, broker, target, page, ref: ref!, review, received }
  }
  it("sets exact BOM/CRLF bytes and warns through a bounded selection receipt, without claiming server acceptance", async () => {
    const f = await fixture()
    expect(f.review.destination).toMatchObject({
      origin: "https://upload.test",
      url: "https://upload.test/form",
      title: "Reviewed upload",
      field: "Upload original",
      accept: ".csv",
      multiple: true,
      formAction: "https://upload.test/submit"
    })
    expect(f.review.context.elements).toMatchObject([{ tag: "input", type: "file", id: "file" }])
    await f.broker.assertUpload(f.target, f.review, check)
    const result = await f.broker.performUpload(
      f.target,
      f.review,
      async () => [{ metadata, bytes }],
      check
    )
    await expect.poll(() => f.received.length).toBe(1)
    expect(f.received[0]).toEqual(bytes)
    expect(result).toMatchObject({
      status: "files_selected",
      serverAcceptance: "unverified",
      files: [metadata],
      requiresSnapshot: true
    })
    expect(result.target.generation).not.toBe(f.target.generation)
    expect(f.broker.requiresObservation(f.target.botId)).toBe(true)
    await expect(
      f.broker.act(f.target, { op: "press_key", key: "A" }, check)
    ).rejects.toMatchObject({ code: "stale_target" })
    expect(
      await f.page.locator("#file").evaluate((node) =>
        Array.from((node as HTMLInputElement).files ?? []).map((file) => ({
          name: file.name,
          size: file.size
        }))
      )
    ).toEqual([{ name: metadata.name, size: metadata.size }])
  })
  it.each([
    "reload",
    "replace",
    "form",
    "accept",
    "title",
    "disabled",
    "directory",
    "multiple",
    "ref"
  ] as const)("rejects %s changes before dispatch", async (mode) => {
    const f = await fixture()
    if (mode === "reload") await f.page.reload()
    if (mode === "replace")
      await f.page.locator("#file").evaluate((node) => node.replaceWith(node.cloneNode(true)))
    if (mode === "form")
      await f.page
        .locator("form")
        .evaluate((node) => node.setAttribute("action", "https://different.test/submit"))
    if (mode === "accept")
      await f.page.locator("#file").evaluate((node) => node.setAttribute("accept", ".txt"))
    if (mode === "title")
      await f.page.evaluate(() => {
        document.title = "Other title"
      })
    if (mode === "disabled")
      await f.page.locator("#file").evaluate((node) => {
        ;(node as HTMLInputElement).disabled = true
      })
    if (mode === "directory")
      await f.page.locator("#file").evaluate((node) => node.setAttribute("webkitdirectory", ""))
    if (mode === "multiple")
      await f.page.locator("#file").evaluate((node) => node.removeAttribute("multiple"))
    if (mode === "ref")
      await f.page.evaluate((ref) => {
        ;(globalThis as unknown as { __sandRefs: Map<string, Element> }).__sandRefs.set(
          ref,
          document.querySelector("#text")!
        )
      }, f.ref)
    await expect(
      f.broker.performUpload(f.target, f.review, async () => [{ metadata, bytes }], check)
    ).rejects.toMatchObject({ code: "browser_upload_changed" })
    expect(f.received).toEqual([])
    expect(
      await f.page.locator("#file").evaluate((node) => (node as HTMLInputElement).files!.length)
    ).toBe(0)
  })
  it("binds the selected input to the same ref identity that was approved", async () => {
    const f = await fixture()
    await f.page.evaluate((ref) => {
      const original = (globalThis as unknown as { __sandRefs: Map<string, Element> }).__sandRefs
      const file = document.querySelector("#file")!
      const text = document.querySelector("#text")!
      let reads = 0
      class FlippingRefs extends Map<string, Element> {
        override get(key: string) {
          reads++
          // The admission before loading bytes still sees the approved input;
          // final dispatch must recheck that same retained review target.
          return key === ref && reads >= 2 ? text : (original.get(key) ?? file)
        }
      }
      ;(globalThis as unknown as { __sandRefs: Map<string, Element> }).__sandRefs =
        new FlippingRefs(original)
    }, f.ref)
    await expect(
      f.broker.performUpload(f.target, f.review, async () => [{ metadata, bytes }], check)
    ).rejects.toMatchObject({ code: "browser_upload_changed" })
    expect(f.received).toEqual([])
    expect(
      await f.page.locator("#file").evaluate((node) => (node as HTMLInputElement).files!.length)
    ).toBe(0)
  })
  it("rejects adversarial alternating ref identities while preparing the upload review", async () => {
    const f = await fixture()
    await f.page.evaluate((ref) => {
      const original = (globalThis as unknown as { __sandRefs: Map<string, Element> }).__sandRefs
      const approved = document.querySelector("#file")!
      const unreviewed = approved.cloneNode(true) as HTMLInputElement
      unreviewed.dataset.unreviewed = "yes"
      document.querySelector("form")!.append(unreviewed)
      unreviewed.addEventListener("change", async () => {
        for (const file of unreviewed.files ?? [])
          await fetch("/receive", { method: "POST", body: await file.arrayBuffer() })
      })
      let reads = 0
      class AlternatingRefs extends Map<string, Element> {
        override get(key: string) {
          if (key !== ref) return original.get(key)
          // Both nodes have the same file attributes. A separately retained
          // upload handle and review handle can each pass their own ref check.
          return ++reads % 2 === 1 ? approved : unreviewed
        }
      }
      ;(globalThis as unknown as { __sandRefs: Map<string, Element> }).__sandRefs =
        new AlternatingRefs(original)
    }, f.ref)
    const review = await f.broker.prepareUpload(f.target, f.ref, [metadata], check).then(
      (value) => {
        cleanup.push(() => value.dispose())
        return value
      },
      (error: unknown) => {
        expect(error).toMatchObject({ code: "browser_upload_changed" })
        return null
      }
    )
    if (review)
      await f.broker.performUpload(f.target, review, async () => [{ metadata, bytes }], check)
    expect(
      await f.page
        .locator("[data-unreviewed]")
        .evaluate((node) => Array.from((node as HTMLInputElement).files ?? []).length)
    ).toBe(0)
    expect(
      await f.page
        .locator("#file")
        .first()
        .evaluate((node) => Array.from((node as HTMLInputElement).files ?? []).length)
    ).toBe(0)
    expect(f.received).toEqual([])
    expect(review).toBeNull()
  })
  it("revokes borrowed target methods after the callback without transferring handle ownership", async () => {
    const f = await fixture()
    const action = { op: "fill", ref: f.ref, value: "" }
    const review = await prepareBotBrowserReview(f.page, action, () => [
      { id: f.target.viewId, url: f.page.url() }
    ])
    cleanup.push(() => review.dispose())
    const borrowed = await review.withElement(0, async (element) => {
      expect(await element.evaluate((node) => node.id)).toBe("file")
      return element
    })
    expect(Object.keys(borrowed).sort()).toEqual(["evaluate", "setInputFiles"])
    await expect(borrowed.evaluate((node) => node.id)).rejects.toMatchObject({
      code: "browser_review_changed"
    })
    await expect(
      borrowed.setInputFiles([{ name: metadata.name, mimeType: metadata.mime, buffer: bytes }])
    ).rejects.toMatchObject({ code: "browser_review_changed" })
    // Expiring the borrowed view does not dispose Review's original target.
    await review.assert(f.page, action)
    await review.dispose()
    const operation = vi.fn(async () => {})
    await expect(review.withElement(0, operation)).rejects.toMatchObject({
      code: "browser_review_changed"
    })
    expect(operation).not.toHaveBeenCalled()
    expect(f.received).toEqual([])
    expect(
      await f.page.locator("#file").evaluate((node) => (node as HTMLInputElement).files!.length)
    ).toBe(0)
  })
  it("invalidates borrowed methods immediately when their review is disposed", async () => {
    const f = await fixture()
    const review = await prepareBotBrowserReview(
      f.page,
      { op: "fill", ref: f.ref, value: "" },
      () => [{ id: f.target.viewId, url: f.page.url() }]
    )
    cleanup.push(() => review.dispose())
    await review.withElement(0, async (element) => {
      await review.dispose()
      await expect(element.evaluate((node) => node.id)).rejects.toMatchObject({
        code: "browser_review_changed"
      })
      await expect(
        element.setInputFiles([{ name: metadata.name, mimeType: metadata.mime, buffer: bytes }])
      ).rejects.toMatchObject({ code: "browser_review_changed" })
    })
    expect(f.received).toEqual([])
    expect(
      await f.page.locator("#file").evaluate((node) => (node as HTMLInputElement).files!.length)
    ).toBe(0)
  })
  it("rejects an in-flight borrowed result when review closes before it returns", async () => {
    const f = await fixture()
    const review = await prepareBotBrowserReview(
      f.page,
      { op: "fill", ref: f.ref, value: "" },
      () => [{ id: f.target.viewId, url: f.page.url() }]
    )
    cleanup.push(() => review.dispose())
    await f.page.evaluate(() => {
      const state = globalThis as unknown as {
        uploadReadStarted: boolean
        uploadReadHold: Promise<void>
        releaseUploadRead: () => void
      }
      state.uploadReadStarted = false
      state.uploadReadHold = new Promise<void>((resolve) => {
        state.releaseUploadRead = resolve
      })
    })
    const result = review.withElement(0, (element) =>
      element.evaluate(async (node) => {
        const state = globalThis as unknown as {
          uploadReadStarted: boolean
          uploadReadHold: Promise<void>
        }
        state.uploadReadStarted = true
        await state.uploadReadHold
        return node.id
      })
    )
    // Observe both outcomes immediately, including failures during cleanup.
    const observed = result.then(
      (value) => ({ kind: "resolved", value }),
      (error: unknown) => ({ kind: "rejected", error })
    )
    try {
      await expect
        .poll(() =>
          f.page.evaluate(
            () => (globalThis as unknown as { uploadReadStarted: boolean }).uploadReadStarted
          )
        )
        .toBe(true)
      await review.dispose()
    } finally {
      await f.page.evaluate(() => {
        ;(globalThis as unknown as { releaseUploadRead: () => void }).releaseUploadRead()
      })
    }
    expect(await observed).toMatchObject({
      kind: "rejected",
      error: { code: "browser_review_changed" }
    })
    expect(f.received).toEqual([])
  })
  it("rejects foreign surfaces, takeover and revoked leases before selecting any bytes", async () => {
    const f = await fixture()
    const other = await f.broker.ensure("another-bot")
    await expect(
      f.broker.performUpload(other, f.review, async () => [{ metadata, bytes }], check)
    ).rejects.toMatchObject({ code: "browser_upload_changed" })
    await expect(
      f.broker.performUpload(
        f.target,
        f.review,
        async () => [{ metadata, bytes }],
        () => {
          throw new Error("lease revoked")
        }
      )
    ).rejects.toThrow("lease revoked")
    await f.broker.takeControl(f.target)
    await expect(
      f.broker.performUpload(f.target, f.review, async () => [{ metadata, bytes }], check)
    ).rejects.toThrow()
    expect(f.received).toEqual([])
  })
  it("rejects changed original bytes and retires old inputs after a lost acknowledgement", async () => {
    const f = await fixture()
    await expect(
      f.broker.performUpload(
        f.target,
        f.review,
        async () => [{ metadata, bytes: Buffer.from("replacement") }],
        check
      )
    ).rejects.toMatchObject({ code: "artifact_corrupt" })
    const perform = f.review.perform.bind(f.review)
    vi.spyOn(f.review, "perform").mockImplementationOnce(async (...args) => {
      await perform(...args)
      throw new Error("lost acknowledgement")
    })
    await expect(
      f.broker.performUpload(f.target, f.review, async () => [{ metadata, bytes }], check)
    ).rejects.toThrow("lost acknowledgement")
    await expect.poll(() => f.received.length).toBe(1)
    expect(f.broker.target(f.target.botId).generation).not.toBe(f.target.generation)
    expect(f.broker.requiresObservation(f.target.botId)).toBe(true)
    await expect(
      f.broker.performUpload(
        f.broker.target(f.target.botId),
        f.review,
        async () => [{ metadata, bytes }],
        check
      )
    ).rejects.toThrow()
    expect(f.received).toHaveLength(1)
  })
  it("loads bytes only after page admission and bounds concurrent upload readers", async () => {
    const f = await fixture()
    const targets = [f.target],
      reviews = [f.review]
    for (let i = 1; i < 5; i++) {
      const target = await f.broker.ensure(`upload-owner-${i}`)
      const page = f.context.pages()[i]
      await page.goto("https://upload.test/form")
      const snapshot = await f.broker.act(target, { op: "snapshot" }, check)
      const ref = /Upload original[^\n]*ref=(e\d+)/.exec(snapshot.data!)![1]
      const review = await f.broker.prepareUpload(target, ref, [metadata], check)
      cleanup.push(() => review.dispose())
      targets.push(target)
      reviews.push(review)
    }
    let release!: () => void,
      entered = 0
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const loading = targets.slice(0, 4).map((target, i) =>
      f.broker.performUpload(
        target,
        reviews[i],
        async () => {
          entered++
          await held
          return [{ metadata, bytes }]
        },
        check
      )
    )
    const settled = Promise.allSettled(loading)
    try {
      await expect.poll(() => entered, { timeout: 10_000, interval: 50 }).toBe(4)
      const fifth = vi.fn(async () => [{ metadata, bytes }])
      await expect(
        f.broker.performUpload(targets[4], reviews[4], fifth, check)
      ).rejects.toMatchObject({ code: "browser_upload_limit" })
      expect(fifth).not.toHaveBeenCalled()
    } finally {
      release()
      await settled
    }
    expect((await settled).every((result) => result.status === "fulfilled")).toBe(true)
    await expect(
      f.broker.performUpload(targets[4], reviews[4], async () => [{ metadata, bytes }], check)
    ).resolves.toMatchObject({ status: "files_selected" })
  }, 15_000)
})
