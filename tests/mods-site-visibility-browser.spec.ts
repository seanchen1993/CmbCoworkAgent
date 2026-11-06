/** Actual DOM geometry for cold-mount scheduling, including display:contents and scroll clips. */
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { build } from "esbuild"
import { chromium } from "playwright"

async function main() {
  const bundle = await build({
    entryPoints: ["src/renderer/src/lib/function-site-visibility.ts"],
    bundle: true,
    write: false,
    format: "iife",
    globalName: "FunctionSiteVisibility"
  })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
    await page.setContent(`<style>body{margin:0}.row{height:24px;width:400px}</style>
      <section id="visible" class="row">visible</section>
      <section id="contents" style="display:contents"><span>visible contents</span></section>
      <section id="offscreen" class="row" style="position:absolute;top:1500px">offscreen</section>
      <div style="position:absolute;top:1600px;height:40px;width:400px">
        <section id="scroll-contents" style="display:contents"><span>scrolling text</span></section>
        <section id="shared-contents" style="display:contents"><span>second text</span></section>
      </div>
      <section style="height:30px;overflow:hidden"><div style="height:100px"></div>
        <section id="clipped" style="display:contents"><span>clipped contents</span></section>
      </section>
      <div style="opacity:0"><section id="transparent" class="row">transparent</section></div>
      <section id="hidden" class="row" style="visibility:hidden">hidden</section>
      <div id="transcript" data-radix-scroll-area-viewport style="height:100px;overflow:auto">
        <div style="height:400px"></div>
        <div data-chat-message-row style="height:50px">
          <section id="transcript-site" style="display:contents">protected transcript</section>
        </div>
      </div>`)
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    const result = await page.evaluate(() => {
      const api = (
        window as unknown as {
          FunctionSiteVisibility: {
            isFunctionSiteInViewport(element: HTMLElement | null): boolean
          }
        }
      ).FunctionSiteVisibility
      return ["visible", "contents", "offscreen", "clipped", "transparent", "hidden"].map((id) => [
        id,
        api.isFunctionSiteInViewport(document.getElementById(id))
      ])
    })
    assert.deepEqual(result, [
      ["visible", true],
      ["contents", true],
      ["offscreen", false],
      ["clipped", false],
      ["transparent", false],
      ["hidden", false]
    ])
    await page.evaluate(`window.visibilityProbe = FunctionSiteVisibility.observeFunctionSiteVisibility(
      document.getElementById('offscreen'))`)
    assert.equal(await page.evaluate("window.visibilityProbe.visible()"), false)
    await page.evaluate(`window.contentsProbe = FunctionSiteVisibility.observeFunctionSiteVisibility(
      document.getElementById('scroll-contents'));
      window.sharedProbe = FunctionSiteVisibility.observeFunctionSiteVisibility(
      document.getElementById('shared-contents'));window.scrollTo(0,0)`)
    await page.waitForFunction("!window.contentsProbe.visible() && !window.sharedProbe.visible()")
    await page.evaluate("window.scrollTo(0,1400)")
    await page.waitForFunction("window.contentsProbe.visible() && window.sharedProbe.visible()")
    await page.evaluate("window.contentsProbe.close();window.scrollTo(0,0)")
    await page.waitForFunction("!window.sharedProbe.visible()")
    await page.evaluate("window.sharedProbe.close()")
    await page.evaluate("window.scrollTo(0, 1200)")
    await page.waitForFunction("window.visibilityProbe.visible()")
    await page.evaluate("window.scrollTo(0, 0)")
    await page.waitForFunction("!window.visibilityProbe.visible()")
    await page.evaluate("window.visibilityProbe.close();window.scrollTo(0,1200)")
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))
    assert.equal(await page.evaluate("window.visibilityProbe.visible()"), false)
    await page.evaluate(`window.scrollTo(0,0);window.transcriptVisibilityChanges=0;window.transcriptProbe =
      FunctionSiteVisibility.observeFunctionSiteVisibility(document.getElementById('transcript-site'),
        () => { window.transcriptVisibilityChanges++ })`)
    assert.equal(await page.evaluate("window.transcriptProbe.visible()"), false)
    // Scroll restoration can still be settling while the user scrolls. Newly visible
    // messages must be promoted in the read queue during that window too.
    await page.locator("#transcript").evaluate(node => node.setAttribute("data-chat-initial-presentation", "pending"))
    await page.evaluate("document.getElementById('transcript').scrollTop=400")
    await page.waitForFunction("window.transcriptProbe.visible()")
    assert.equal(await page.evaluate("window.transcriptVisibilityChanges"), 1)
    await page.evaluate("document.getElementById('transcript').scrollTop=0")
    await page.waitForFunction("!window.transcriptProbe.visible()")
    assert.equal(await page.evaluate("window.transcriptVisibilityChanges"), 2)
    await page.evaluate("window.transcriptProbe.close()")
    await page.evaluate("document.getElementById('transcript').scrollTop=400")
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))
    assert.equal(await page.evaluate("window.transcriptVisibilityChanges"), 2)
    console.log("PASS actual contents/ancestor-clipping/viewport scheduling geometry")
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
