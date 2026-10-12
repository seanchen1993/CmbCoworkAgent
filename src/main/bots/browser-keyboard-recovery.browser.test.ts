import { describe, expect, it } from "vitest"
import { chromium, type Page } from "playwright"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BotBrowserBroker } from "./browser-broker"
import { LocalBotComputerProvider } from "./computer-provider"

const html =
  '<textarea autofocus></textarea><script>window.events=[];document.addEventListener("keydown",e=>events.push({key:e.key,ctrlKey:e.ctrlKey}));</script>'
async function readings(page: Page) {
  return page.evaluate(
    () => (window as unknown as { events: { key: string; ctrlKey: boolean }[] }).events
  )
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => (resolve = done))
  return { promise, resolve }
}
const channel =
  process.env.CMB_BOT_BROWSER_CHANNEL ?? (process.platform === "win32" ? "msedge" : "chrome")

describe.runIf(process.env.CMB_BOT_BROWSER_TEST === "1")(
  "actual browser keyboard failure recovery",
  () => {
    it("clears failed chords on both exact model and human targets, retaining the consumed frame", async () => {
      const browser = await chromium.launch({ channel, headless: true, chromiumSandbox: true })
      const context = await browser.newContext()
      const broker = new BotBrowserBroker(context)
      const phases: string[] = []
      broker.humanObserver = async (_id, _page, _input, phase) => {
        phases.push(phase)
      }
      try {
        const target = await broker.ensure("keyboard-bot")
        const page = context.pages()[0]
        await page.setContent(html)
        await page.locator("textarea").focus()
        await broker.act(target, { op: "snapshot" }, () => {})
        const press = page.keyboard.press.bind(page.keyboard)
        let presses = 0
        page.keyboard.press = async (key, options) => {
          presses++
          return press(key, options)
        }
        await broker.act(target, { op: "press_key", key: "Control++" }, () => {})
        await broker.act(target, { op: "press_key", key: "ControlOrMeta+a" }, () => {})
        expect(presses).toBe(2)
        expect((await readings(page)).some((item) => item.key === "+")).toBe(true)
        await expect(
          broker.act(target, { op: "press_key", key: "Control+DefinitelyInvalidKey" }, () => {})
        ).rejects.toThrow('Unknown key: "DefinitelyInvalidKey"')
        await page.keyboard.press("a")
        expect((await readings(page)).at(-1)).toEqual({ key: "a", ctrlKey: false })
        const dispatched = presses
        await expect(
          broker.act(target, { op: "press_key", key: "x".repeat(101) }, () => {})
        ).rejects.toThrow("按键")
        expect(presses).toBe(dispatched)
        const human = await broker.takeControl(broker.target("keyboard-bot"))
        const frame = await broker.frame("keyboard-bot")
        await expect(
          broker.humanInput(human, {
            kind: "key",
            key: "Control+DefinitelyInvalidKey",
            frameSeq: frame.frameSeq
          })
        ).rejects.toThrow('Unknown key: "DefinitelyInvalidKey"')
        expect(phases).toEqual(["before", "unconfirmed"])
        await expect(
          broker.humanInput(human, { kind: "key", key: "a", frameSeq: frame.frameSeq })
        ).rejects.toThrow("画面已过期")
        const fresh = await broker.frame("keyboard-bot")
        await broker.humanInput(human, { kind: "key", key: "a", frameSeq: fresh.frameSeq })
        expect((await readings(page)).at(-1)).toEqual({ key: "a", ctrlKey: false })
        expect(phases).toEqual(["before", "unconfirmed", "before", "after"])
      } finally {
        await broker.close()
        await browser.close()
      }
      expect(browser.isConnected()).toBe(false)
    }, 15_000)

    it("does not reopen after early context close while the original cleanup and shutdown are still joined", async () => {
      const root = await mkdtemp(join(tmpdir(), "cmb-keyboard-stop-"))
      const provider = new LocalBotComputerProvider(root, channel)
      const closed = deferred(),
        finishClose = deferred(),
        upStarted = deferred()
      let closeCalls = 0,
        pressCalls = 0
      const primary = new Error("original rejected press")
      try {
        const broker = await provider.get()
        const target = await broker.ensure("keyboard-stop")
        const encoder = await broker.teachEncoderPage()
        const context = encoder.context(),
          browser = context.browser()!
        await encoder.close()
        const owned = context.pages()[0]
        await owned.setContent(html)
        await owned.locator("textarea").focus()
        await broker.act(target, { op: "snapshot" }, () => {})
        const press = owned.keyboard.press.bind(owned.keyboard)
        const up = owned.keyboard.up.bind(owned.keyboard)
        const close = browser.close.bind(browser)
        owned.keyboard.press = async () => {
          pressCalls++
          throw primary
        }
        owned.keyboard.up = (key) => {
          if (key !== "Control") return up(key)
          upStarted.resolve()
          // Hold the client completion until actual original-page disposal. This
          // controlled seam tests the real Provider's shutdown/admission ordering.
          return new Promise<void>((_resolve, reject) =>
            owned.once("close", () => reject(new Error("original page disposed")))
          )
        }
        browser.close = async () => {
          closeCalls++
          await close()
          closed.resolve()
          await finishClose.promise
        }
        const input = broker.act(target, { op: "press_key", key: "Control+Invalid" }, () => {})
        const failed = expect(input).rejects.toBe(primary)
        await upStarted.promise
        const takeover = expect(broker.takeControl(broker.target("keyboard-stop"))).rejects.toThrow(
          "关闭"
        )
        await closed.promise
        expect(closeCalls).toBe(1)
        expect(browser.isConnected()).toBe(false)
        await expect(provider.get()).rejects.toThrow("正在关闭")
        await expect(broker.ensure("another-bot")).rejects.toThrow("关闭")
        let settled = false
        void input.catch(() => {
          settled = true
        })
        await Promise.resolve()
        expect(settled).toBe(false)
        finishClose.resolve()
        await failed
        await takeover
        await provider.close()
        expect(pressCalls).toBe(1)
        expect(closeCalls).toBe(1)
        owned.keyboard.press = press
        expect(provider.status().state).not.toBe("ready")
      } finally {
        finishClose.resolve()
        await provider.shutdown()
        await rm(root, { recursive: true, force: true })
      }
    }, 15_000)

    it("fences the shared owner while a delegated press is pending and joins actual disposal before handoff", async () => {
      const root = await mkdtemp(join(tmpdir(), "cmb-keyboard-press-stop-"))
      const provider = new LocalBotComputerProvider(root, channel)
      const closed = deferred(),
        finishClose = deferred(),
        pressStarted = deferred()
      let closeCalls = 0,
        pressCalls = 0,
        upCalls = 0
      const primary = new Error("pending original press disposed")
      try {
        const broker = await provider.get()
        const target = await broker.ensure("keyboard-press-stop")
        const encoder = await broker.teachEncoderPage()
        const context = encoder.context(),
          browser = context.browser()!
        await encoder.close()
        const owned = context.pages()[0]
        await owned.setContent(html)
        await owned.locator("textarea").focus()
        await broker.act(target, { op: "snapshot" }, () => {})
        const close = browser.close.bind(browser)
        const up = owned.keyboard.up.bind(owned.keyboard)
        owned.keyboard.press = async () => {
          pressCalls++
          await owned.keyboard.down("Control")
          pressStarted.resolve()
          // Hold the original client reply until disposal of this actual Page.
          return new Promise<void>((_resolve, reject) => owned.once("close", () => reject(primary)))
        }
        owned.keyboard.up = async (key) => {
          upCalls++
          return up(key)
        }
        browser.close = async () => {
          closeCalls++
          await close()
          closed.resolve()
          await finishClose.promise
        }
        const input = broker.act(target, { op: "press_key", key: "Control+a" }, () => {})
        const failed = expect(input).rejects.toBe(primary)
        await pressStarted.promise
        const takeover = expect(
          broker.takeControl(broker.target("keyboard-press-stop"))
        ).rejects.toThrow("关闭")
        await closed.promise
        expect(closeCalls).toBe(1)
        expect(browser.isConnected()).toBe(false)
        await expect(provider.get()).rejects.toThrow("正在关闭")
        await expect(broker.ensure("another-bot")).rejects.toThrow("关闭")
        let settled = false
        void input.catch(() => {
          settled = true
        })
        await Promise.resolve()
        expect(settled).toBe(false)
        finishClose.resolve()
        await failed
        await takeover
        await provider.close()
        expect(pressCalls).toBe(1)
        expect(upCalls).toBe(0)
        expect(closeCalls).toBe(1)
        expect(provider.status().state).not.toBe("ready")
      } finally {
        finishClose.resolve()
        await provider.shutdown()
        await rm(root, { recursive: true, force: true })
      }
    }, 15_000)
  }
)
