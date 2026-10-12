import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { chromium, type Browser, type BrowserContext, type Page } from "playwright"
import { writeFile } from "node:fs/promises"
import { executeGrokBrowserAction, refHandle } from "./upstream/grok-browser-actions.js"

describe.runIf(process.env.CMB_BOT_BROWSER_TEST === "1")(
  "actual browser action handle collection",
  () => {
    let browser: Browser
    const contexts: BrowserContext[] = []
    const readings: { name: string; collected: boolean }[] = []
    beforeAll(async () => {
      browser = await chromium.launch({
        channel:
          process.env.CMB_BOT_BROWSER_CHANNEL ??
          (process.platform === "win32" ? "msedge" : "chrome"),
        headless: true,
        chromiumSandbox: true,
        args: ["--disable-updater-scheduler"]
      })
    })
    afterEach(async () => {
      for (const context of contexts.splice(0)) await context.close()
    })
    afterAll(async () => {
      await browser?.close()
      if (process.env.CMB_BROWSER_HANDLE_CLOSE_PROOF)
        await writeFile(
          process.env.CMB_BROWSER_HANDLE_CLOSE_PROOF,
          JSON.stringify(
            {
              physicallyClosedAt: new Date().toISOString(),
              browserConnected: browser?.isConnected() ?? false,
              contexts: contexts.length,
              readings
            },
            null,
            2
          )
        )
    })

    async function fixture(html: string) {
      const context = await browser.newContext()
      contexts.push(context)
      const page = await context.newPage()
      await page.setContent(html)
      const session = await context.newCDPSession(page)
      let targetId: string
      try {
        targetId = (await session.send("Target.getTargetInfo")).targetInfo.targetId
      } finally {
        await session.detach()
      }
      const state = { views: { owned: targetId }, lastViewId: "owned" }
      const run = (action: Record<string, unknown> & { op: string }) =>
        executeGrokBrowserAction(action, context, state)
      await run({ op: "snapshot" })
      await page.evaluate(() => {
        // A weak reference cannot keep the removed node alive. No console or
        // object-valued evaluate result exposes a second debugger root.
        ;(globalThis as unknown as { actionElement: WeakRef<Element> }).actionElement = new WeakRef(
          document.getElementById("target")!
        )
      })
      return { page, run }
    }

    async function detachAndCollect(page: Page, name: string) {
      await page.evaluate(() => {
        document.getElementById("target")!.remove()
        ;(globalThis as unknown as { __sandRefs: Map<string, Element> }).__sandRefs = new Map()
      })
      return collect(page, name)
    }

    async function collect(page: Page, name: string) {
      const session = await page.context().newCDPSession(page)
      try {
        // DOM wrapper collection crosses Blink/V8 tasks. A single immediate GC
        // can leave a released wrapper alive; use a fixed small number of complete
        // turns, then read WeakRef once so deref itself cannot extend its lifetime.
        for (let turn = 0; turn < 3; turn++) {
          await session.send("Runtime.evaluate", {
            expression: "new Promise(resolve => setTimeout(resolve, 0))",
            awaitPromise: true,
            returnByValue: true
          })
          await session.send("HeapProfiler.collectGarbage")
        }
        const collected = await page.evaluate(
          () =>
            (globalThis as unknown as { actionElement: WeakRef<Element> }).actionElement.deref() ===
            undefined
        )
        readings.push({ name, collected })
        return collected
      } finally {
        await session.detach()
      }
    }

    it("releases real action handles exactly once while preserving successful page input", async () => {
      const f = await fixture('<input id="target" aria-label="Target">')
      const acquire = f.page.evaluateHandle.bind(f.page)
      const handles: { releases: number }[] = []
      f.page.evaluateHandle = (async (...args: Parameters<Page["evaluateHandle"]>) => {
        const handle = await acquire(...args)
        const state = { releases: 0 }
        handles.push(state)
        const release = handle.dispose.bind(handle)
        handle.dispose = async () => {
          state.releases++
          await release()
        }
        return handle
      }) as Page["evaluateHandle"]
      try {
        for (let index = 0; index < 20; index++)
          await f.run({ op: "fill", ref: "e1", value: `value-${index}` })
        expect(await f.page.locator("#target").inputValue()).toBe("value-19")
        expect(handles).toHaveLength(20)
        expect(handles.every((handle) => handle.releases === 1)).toBe(true)
      } finally {
        f.page.evaluateHandle = acquire
      }
    })

    it("collects a hidden element after a bounding-box failure", async () => {
      const f = await fixture('<div id="target" style="display:none">Hidden</div>')
      await f.page.evaluate(() => {
        ;(globalThis as unknown as { __sandRefs: Map<string, Element> }).__sandRefs = new Map([
          ["hidden", document.getElementById("target")!]
        ])
      })
      await expect(f.run({ op: "get_bounding_box", ref: "hidden" })).rejects.toThrow(
        "no visible bounding box"
      )
      expect(await detachAndCollect(f.page, "failed bounding-box")).toBe(true)
    })

    it("retains a directly owned review handle until that owner explicitly releases it", async () => {
      const f = await fixture('<input id="target" aria-label="Target">')
      const owned = await refHandle(f.page, "e1")
      try {
        expect(await detachAndCollect(f.page, "retained owner handle")).toBe(false)
      } finally {
        await owned.dispose()
      }
      expect(await collect(f.page, "released owner handle")).toBe(true)
    })
  }
)
