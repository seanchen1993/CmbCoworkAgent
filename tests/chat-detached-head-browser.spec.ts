/** Real resize/mutation observers: keep the history boundary while cold bodies expand. */
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { build } from "esbuild"
import { chromium } from "playwright"

async function main() {
  const bundle = await build({
    entryPoints: ["src/renderer/src/components/chat/chat-detached-layout-anchor.ts"],
    bundle: true,
    write: false,
    format: "iife",
    globalName: "DetachedAnchor"
  })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  try {
    const page = await browser.newPage()
    await page.setContent(`<style>body{margin:0}#viewport{height:200px;overflow:auto;
      overflow-anchor:none}#root{overflow-anchor:none}</style>
      <div id="viewport"><div id="root">
        <div id="head" style="height:40px">Load earlier messages</div>
        <div id="cold" data-chat-message-row data-chat-message-id="cold" style="height:40px">
          <div data-function-site-pending>Pending</div>
        </div>
        <div id="body" data-chat-message-row data-chat-message-id="body" style="height:60px">
          Readable body
        </div><div style="height:1000px"></div>
      </div></div>`)
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    await page.evaluate(`window.stopAnchor = DetachedAnchor.installChatDetachedLayoutAnchor({
      root: document.getElementById('root'), viewport: document.getElementById('viewport'),
      readLease: () => 1 })`)
    const settle = () => page.evaluate(`new Promise(resolve => {
      let frames = 0;
      const step = () => { if (++frames === 6) resolve(); else requestAnimationFrame(step) };
      requestAnimationFrame(step)
    })`)
    await settle()
    await page.evaluate("document.getElementById('cold').style.height='500px'")
    await settle()
    assert.equal(await page.evaluate("document.getElementById('viewport').scrollTop"), 0)
    assert.equal(await page.evaluate("document.getElementById('head').getBoundingClientRect().top"), 0)

    // Leaving the head still preserves the current readable row during independent resizing.
    await page.evaluate(`document.querySelector('[data-function-site-pending]').removeAttribute(
      'data-function-site-pending');document.getElementById('viewport').scrollTop=550`)
    await settle()
    const before = await page.locator("#body").boundingBox()
    assert(before)
    await page.evaluate("document.getElementById('cold').style.height='700px'")
    await settle()
    const after = await page.locator("#body").boundingBox()
    assert(after)
    assert(Math.abs(after.y - before.y) <= 1, "detached middle reading position remains stable")
    await page.evaluate("window.stopAnchor()")
    // A running conversation at the tail must not schedule detached correction work
    // for each token. Real observers still see all these mutations.
    await page.evaluate(`window.anchorFrames = 0;
      window.nativeFrame = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = callback => {
        window.anchorFrames++;
        return window.nativeFrame(callback);
      };
      window.stopAnchor = DetachedAnchor.installChatDetachedLayoutAnchor({
        root: document.getElementById('root'), viewport: document.getElementById('viewport'),
        readLease: () => null
      })`)
    await page.evaluate(`(async () => {
      for (let index=0;index<40;index++) {
        document.getElementById('body').textContent += ' streamed token';
        document.getElementById('cold').style.height=(700+index)+'px';
        await new Promise(resolve => window.nativeFrame(resolve));
      }
    })()`)
    assert.equal(await page.evaluate("window.anchorFrames"), 0,
      "following a stream must not schedule detached layout corrections")
    await page.evaluate("window.stopAnchor(); window.requestAnimationFrame=window.nativeFrame")
    console.log("PASS history head remains reachable and detached middle rows retain their position")
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
