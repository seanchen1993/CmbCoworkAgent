/** Tests the detector, not the application: transient failures deliberately injected in an owned page. */
import assert from "node:assert/strict"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"
import { installChatFrameObserver } from "./support/chat-frame-observer"
import { findRestoredSiteFlashes } from "./support/chat-frame-analysis"

interface ObserverWindow extends Window {
  observer: ReturnType<typeof installChatFrameObserver>
}

async function main() {
  const output = resolve("output/live-dev-inspection-20261012", `observer-${Date.now()}`)
  mkdirSync(output, { recursive: true })
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const checks: string[] = []
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    await page.setContent(`<style>.row{height:40px} [data-function-site]{height:30px}</style>
      <main><div data-chat-message-row data-chat-message-id="a" data-message-role="assistant" class="row">SENSITIVE_FIXTURE_BODY</div>
      <div data-chat-message-row data-chat-message-id="b" data-message-role="assistant" class="row">SENSITIVE_FIXTURE_BODY</div>
      <section data-function-site="AbovePrompt"><button>Replay</button></section>
      <div data-chat-message-row data-chat-message-id="contents-row" data-message-role="assistant" class="row"><section data-function-site="AssistantMessage" style="display:contents"><span>Contents protected text</span></section></div>
      <div style="height:1px;overflow:hidden"><div style="height:10px"></div><div data-chat-message-row data-chat-message-id="a" data-message-role="assistant">clipped duplicate</div></div>
      <textarea class="composer-textarea"></textarea></main>`)
    const bundle = await build({
      stdin: {
        contents: `import {installChatFrameObserver} from './tests/support/chat-frame-observer'; window.observer=installChatFrameObserver()`,
        resolveDir: resolve("."),
        loader: "ts"
      },
      bundle: true,
      write: false,
      platform: "browser",
      format: "iife"
    })
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    // tsx preserves function names in serialized Playwright callbacks using this helper.
    await page.addScriptTag({ content: "globalThis.__name = (value) => value" })
    await page.evaluate(async () => {
      const observer = (window as unknown as ObserverWindow).observer
      const painted = () =>
        new Promise<void>((done) =>
          requestAnimationFrame(() => requestAnimationFrame(() => done()))
        )
      await painted()
      observer.mark("one-painted-frame-blank")
      const row = document.querySelector('[data-chat-message-id="a"]') as HTMLElement
      const original = row.innerText
      row.innerText = ""
      await painted()
      row.innerText = original
      await painted()
      observer.mark("same-id-transient-duplicate")
      const duplicate = row.cloneNode(true)
      row.after(duplicate)
      await painted()
      duplicate.parentNode?.removeChild(duplicate)
      await painted()
      observer.mark("same-content-node-replacement")
      row.replaceWith(row.cloneNode(true))
      await painted()
      observer.mark("site-fast-clear-without-status")
      const site = document.querySelector("[data-function-site]") as HTMLElement
      const child = site.firstElementChild as Element
      child.remove()
      await painted()
      site.append(child)
      await painted()
      observer.mark("legitimate-identical-distinct-ids")
      await painted()
      observer.mark("contents-body-clear")
      const contents = document.querySelector(
        '[data-function-site="AssistantMessage"]'
      ) as HTMLElement
      const contentsHtml = contents.innerHTML
      contents.replaceChildren()
      await painted()
      contents.innerHTML = contentsHtml
      await painted()
      observer.mark("inert-protected-body-stays-visible")
      contents.inert = true
      await painted()
      contents.inert = false
      observer.mark("between-frame-mutation")
      const currentRow = document.querySelector('[data-chat-message-id="a"]') as HTMLElement
      currentRow.innerText = ""
      await Promise.resolve()
      await Promise.resolve()
      currentRow.innerText = original
      await painted()
      const clip = document.createElement("div")
      clip.style.cssText = "position:fixed;top:0;left:500px;width:200px;height:80px;overflow:auto"
      clip.innerHTML =
        '<div data-chat-message-row data-chat-message-id="scroll-body" data-message-role="assistant" style="height:200px"><section data-function-site="AssistantMessage">Protected clipped body remains intact</section></div>'
      document.body.append(clip)
      observer.mark("body-scroll-clipped-row-still-visible")
      clip.scrollTop = 60
      await painted()
      clip.remove()
      const pair = document.createElement("div")
      pair.style.cssText = "position:fixed;top:300px;left:500px;width:300px"
      pair.innerHTML = ["candidate-1", "candidate-2"]
        .map(
          (id) =>
            '<div data-chat-message-row data-chat-message-id="' +
            id +
            '" data-message-role="assistant"><section data-function-site="AssistantMessage">Identical protected reply body for review</section></div>'
        )
        .join("")
      document.body.append(pair)
      observer.mark("actual-body-same-content-candidate")
      await painted()
      observer.mark("identical-loading-chrome-not-reply")
      pair.querySelectorAll("section").forEach((node) => {
        node.innerHTML =
          '<span role="status">Identical loading placeholder long enough to match</span>'
      })
      await painted()
      pair.remove()
      const toolRow = document.createElement("div")
      toolRow.style.cssText = "position:fixed;top:300px;left:500px;width:300px;height:100px"
      toolRow.setAttribute("data-chat-message-row", "")
      toolRow.setAttribute("data-chat-message-id", "tool-row")
      toolRow.innerHTML =
        '<section data-function-site="ToolGroup">Protected tool arguments and execution record</section>'
      document.body.append(toolRow)
      observer.mark("tool-slot-remove-restore")
      await painted()
      const toolSite = toolRow.firstElementChild!
      toolSite.remove()
      await painted()
      toolRow.append(toolSite)
      await painted()
      toolRow.remove()
    })
    const result = await page.evaluate(() => (window as unknown as ObserverWindow).observer.stop())
    const paged = await page.evaluate(() => {
      const observer = (window as unknown as ObserverWindow).observer
      const stats = observer.stats()
      const samples: typeof result.samples = []
      for (let index = 0; index < stats.sampleCount; index += 3)
        samples.push(...observer.readSamples(index, 3))
      return { stats, samples }
    })
    assert.deepEqual(paged.samples, result.samples)
    assert(paged.stats.captureMs >= paged.stats.maxCaptureMs && paged.stats.stopped)
    checks.push("bounded-chunk-export-retains-all-observed-states-and-cost-metrics")
    assert(result.frames > 10)
    assert.equal(result.dropped, 0)
    assert(
      result.samples.some(
        (sample) =>
          sample.source === "frame" &&
          sample.phase === "one-painted-frame-blank" &&
          sample.rows.some((row) => row.id === "a" && row.text.length === 0)
      )
    )
    checks.push("one-frame-content-blank-with-constant-row-height-detected")
    assert(
      result.samples.some(
        (sample) =>
          sample.phase === "same-id-transient-duplicate" && sample.duplicateRowIds.includes("a")
      )
    )
    assert.equal(result.samples.at(-1)?.duplicateRowIds.length, 0)
    checks.push("transient-duplicate-detected-despite-clean-final-state")
    const identities = new Set(
      result.samples.flatMap((sample) =>
        sample.rows.filter((row) => row.id === "a").map((row) => row.node)
      )
    )
    assert(identities.size >= 3)
    checks.push("same-content-dom-replacement-detected")
    assert(
      result.samples.some(
        (sample) =>
          sample.source === "frame" &&
          sample.phase === "site-fast-clear-without-status" &&
          sample.sites.some((site) => site.text.length === 0 && site.statuses === 0)
      )
    )
    checks.push("fast-site-empty-without-loader-or-height-change-detected")
    const legitimate = result.samples.filter(
      (sample) => sample.phase === "legitimate-identical-distinct-ids"
    )
    assert(
      legitimate.length > 0 &&
        legitimate.every(
          (sample) => sample.rows.length === 3 && sample.duplicateRowIds.length === 0
        )
    )
    checks.push("equal-text-distinct-message-identities-not-treated-as-duplicates")
    assert(
      result.samples.some(
        (sample) =>
          sample.source === "frame" &&
          sample.sites.some((site) => site.name === "AssistantMessage" && site.text.length > 0)
      ),
      "display:contents body must be sampled despite having no own box"
    )
    assert(
      result.samples.some(
        (sample) =>
          sample.source === "frame" &&
          sample.phase === "contents-body-clear" &&
          sample.sites.some((site) => site.name === "AssistantMessage" && site.text.length === 0)
      ),
      "empty display:contents must remain observable inside a visible row"
    )
    checks.push("display-contents-protected-body-and-one-frame-clear-detected")
    assert(
      result.samples.some(
        (sample) =>
          sample.source === "frame" &&
          sample.phase === "inert-protected-body-stays-visible" &&
          sample.sites.some((site) => site.name === "AssistantMessage" && site.text.length > 0)
      )
    )
    checks.push("inert-readonly-protected-body-remains-visible-to-observer")
    assert(
      result.samples.some(
        (sample) =>
          sample.source === "mutation" &&
          sample.phase === "between-frame-mutation" &&
          sample.rows.some((row) => row.id === "a" && row.text.length === 0)
      )
    )
    checks.push("between-frame-dom-change-recorded-separately-from-paint")
    checks.push("clipped-virtualization-overscan-not-counted-visible")
    assert(
      findRestoredSiteFlashes(result.samples).some(
        (flash) =>
          flash.name === "ToolGroup" && flash.messageId === "tool-row" && flash.end > flash.start
      )
    )
    assert(
      !findRestoredSiteFlashes(result.samples).some(
        (flash) => flash.phase === "body-scroll-clipped-row-still-visible"
      )
    )
    checks.push("removed-tool-slot-restoration-detected-without-clipping-false-positive")
    assert(
      result.samples.some(
        (sample) =>
          sample.source === "frame" &&
          sample.phase === "body-scroll-clipped-row-still-visible" &&
          sample.rows.some((row) => row.id === "scroll-body") &&
          !sample.sites.some((site) => site.messageId === "scroll-body") &&
          sample.clippedSites.some(
            (site) => site.messageId === "scroll-body" && site.text.length > 0
          )
      )
    )
    checks.push("body-clipped-while-row-padding-visible-retains-offscreen-evidence")
    assert(
      result.samples.some(
        (sample) =>
          sample.source === "frame" &&
          sample.phase === "actual-body-same-content-candidate" &&
          sample.sameContentBodyCandidates.some(
            (candidate) =>
              candidate.ids.includes("candidate-1") && candidate.ids.includes("candidate-2")
          )
      )
    )
    assert(
      result.samples
        .filter(
          (sample) =>
            sample.source === "frame" && sample.phase === "identical-loading-chrome-not-reply"
        )
        .every((sample) => sample.sameContentBodyCandidates.length === 0)
    )
    checks.push("only-protected-body-content-produces-cross-id-review-candidate")
    assert(!JSON.stringify(result).includes("SENSITIVE_FIXTURE_BODY"))
    checks.push("message-bodies-not-exported")
    const before = result.samples.length
    await page.evaluate(async () => {
      document.querySelector("main")?.append(document.createElement("p"))
      await new Promise<void>((done) => requestAnimationFrame(() => done()))
    })
    assert.equal(
      await page.evaluate(
        () => (window as unknown as ObserverWindow).observer.snapshot().samples.length
      ),
      before
    )
    checks.push("stop-detaches-read-only-observer")
    assert.deepEqual(errors, [])
    writeFileSync(
      resolve(output, "result.json"),
      JSON.stringify({ passed: true, checks, errors, ...result }, null, 2)
    )
    console.log(JSON.stringify({ passed: true, checks, output }, null, 2))
  } finally {
    await browser.close()
  }
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
