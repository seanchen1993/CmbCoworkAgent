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
      <section style="height:30px;overflow:hidden"><div style="height:100px"></div>
        <section id="clipped" style="display:contents"><span>clipped contents</span></section>
      </section>
      <div style="opacity:0"><section id="transparent" class="row">transparent</section></div>
      <section id="hidden" class="row" style="visibility:hidden">hidden</section>`)
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
    console.log("PASS actual contents/ancestor-clipping/viewport scheduling geometry")
  } finally {
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
