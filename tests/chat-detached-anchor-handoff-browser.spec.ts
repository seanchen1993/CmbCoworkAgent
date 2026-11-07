/** Real browser ownership handoff before a later protected row changes height. */
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { build } from "esbuild"
import { chromium } from "playwright"

async function main(): Promise<void> {
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: "ts",
      contents: `
        import { installChatDetachedLayoutAnchor, notifyChatDetachedAnchorOwnerReleased } from
          './src/renderer/src/components/chat/chat-detached-layout-anchor'
        import { beginChatScrollNavigation } from
          './src/renderer/src/components/chat/chat-scroll-navigation'
        const viewport = document.querySelector('#viewport')
        const root = document.querySelector('#content')
        let lease = null, dispose = () => {}, endNavigation = () => {}
        const settle = () => new Promise(resolve => requestAnimationFrame(() =>
          requestAnimationFrame(() => requestAnimationFrame(resolve))))
        const offset = () => document.querySelector('#reading').getBoundingClientRect().top -
          viewport.getBoundingClientRect().top
        const release = () => {
          lease = 1
          notifyChatDetachedAnchorOwnerReleased(viewport)
        }
        window.fixture = {
          async reset() {
            dispose(); endNavigation(); lease = null
            document.querySelector('#above').style.height = '300px'
            viewport.scrollTop = 250
            await settle()
            dispose = installChatDetachedLayoutAnchor({root, viewport, readLease: () => lease})
            await settle()
            return offset()
          },
          async change(kind) {
            const before = offset(), beforeTop = viewport.scrollTop
            if (kind === 'queued') {
              // Navigation queued a capture while restoration still owned the viewport.
              viewport.dispatchEvent(new Event('chat-scroll-navigation-change'))
            }
            if (kind === 'navigation') endNavigation = beginChatScrollNavigation(viewport)
            if (kind === 'wheel') viewport.dispatchEvent(new WheelEvent('wheel', {deltaY:1}))
            if (kind === 'head') viewport.scrollTop = 0
            if (kind === 'disposed' || kind === 'early') dispose()
            release()
            if (kind === 'disabled') {
              lease = null
              notifyChatDetachedAnchorOwnerReleased(viewport)
            }
            if (kind === 'early') {
              dispose = installChatDetachedLayoutAnchor({root, viewport, readLease: () => lease})
            }
            const releaseTop = viewport.scrollTop
            document.querySelector('#above').style.height = '365px'
            await settle()
            return {before,after:offset(),beforeTop,releaseTop,afterTop:viewport.scrollTop}
          }
        }
      `
    },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser"
  })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  try {
    const page = await browser.newPage()
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.setContent(`<div id="viewport" style="height:200px;overflow:auto;overflow-anchor:none">
      <div id="content"><div id="above" style="height:300px"></div>
        <div id="reading" data-chat-message-row data-chat-message-id="reading"
          style="height:100px">Readable history</div><div style="height:1000px"></div>
      </div></div>`)
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    const results: Record<string, unknown> = {}
    for (const kind of [
      "idle",
      "queued",
      "early",
      "navigation",
      "wheel",
      "head",
      "disposed",
      "disabled"
    ]) {
      await page.evaluate("window.fixture.reset()")
      const result = await page.evaluate(
        (kind) =>
          (
            window as unknown as {
              fixture: {
                change(kind: string): Promise<{
                  before: number
                  after: number
                  beforeTop: number
                  releaseTop: number
                  afterTop: number
                }>
              }
            }
          ).fixture.change(kind),
        kind
      )
      results[kind] = result
      if (["idle", "queued", "early"].includes(kind)) {
        assert.equal(
          result.releaseTop,
          result.beforeTop,
          "Handoff itself must never write scrollTop"
        )
        assert(
          Math.abs(result.after - result.before) <= 0.5,
          `${kind}: the released readable anchor must survive subsequent growth: ${JSON.stringify(result)}`
        )
      } else if (kind === "head") {
        assert.equal(result.afterTop, 0, "The absolute history head keeps ownership")
      } else {
        assert.equal(result.afterTop, result.releaseTop, `${kind} must not claim layout ownership`)
      }
    }
    assert.deepEqual(errors, [])
    console.log("PASS detached anchor handoff " + JSON.stringify(results))
  } finally {
    await browser.close()
  }
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
