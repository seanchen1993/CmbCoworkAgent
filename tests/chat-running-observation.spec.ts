/** Exercise diagnostics through their real serialization boundary without starting Electron. */
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { chromium, type ElectronApplication } from "playwright"
import { startChatRunningObservation } from "./support/chat-running-observation"
import { installChatScrollWriteDiagnostic } from "./support/chat-scroll-write-diagnostic"

async function main() {
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const page = await browser.newPage()
  const app = {
    evaluate: async (callback: (electron: object, input: unknown) => unknown, input: unknown) =>
      callback({}, input)
  } as unknown as ElectronApplication
  let observation: Awaited<ReturnType<typeof startChatRunningObservation>> | undefined
  try {
    await page.setContent(`<div data-chat-thread-id="controlled">
      <div data-radix-scroll-area-viewport style="height:150px;overflow:auto">
        <div data-chat-message-row><div data-chat-search-text><p>ROW_0</p>
          <p style="height:200px">Paragraph</p><p>Visible continuation</p>
          <p style="height:200px">Another paragraph</p></div></div>
      </div></div>`)
    await page.locator("[data-radix-scroll-area-viewport]").evaluate((element) => {
      element.scrollTop = 230
    })
    observation = await startChatRunningObservation(app, page, { scrollDiagnostics: true })
    await observation.setPhase("scroll")
    await observation.waitForReady("controlled")
    await page.waitForTimeout(350)
    let evidence = await observation.snapshot()
    assert.deepEqual(evidence.errors, [])
    assert((evidence.main?.phases.scroll.samples ?? 0) > 0)
    assert((evidence.renderer?.phases.scroll.visibility?.samples ?? 0) > 0)
    assert.equal(
      evidence.renderer?.phases.scroll.visibility?.blankSamples,
      0,
      "A visible paragraph must count even after the row marker scrolls out of view"
    )
    assert(
      evidence.renderer?.visibilitySamples?.some(
        (sample) =>
          sample.trigger === "ready" && sample.ready && !sample.blank && sample.visibleBodyCount > 0
      )
    )
    await observation.setPhase("long-body-tail")
    await page.locator("[data-radix-scroll-area-viewport]").evaluate((element) => {
      element.innerHTML =
        "<div data-chat-message-row><div data-chat-search-text>" +
        Array.from(
          { length: 300 },
          (_, index) => `<p style="margin:0;height:30px">Paragraph ${index}</p>`
        ).join("") +
        "</div></div>"
      element.scrollTop = element.scrollHeight
    })
    await observation.waitForReady("controlled", 500)
    evidence = await observation.snapshot()
    assert.equal(
      evidence.renderer?.visibilitySamples?.at(-1)?.blank,
      false,
      "A long body's visible tail must count beyond the bounded prefix text scan"
    )
    await observation.setPhase("long-body-hidden-tail")
    await page.locator("[data-chat-search-text]").evaluate((body) => {
      for (const paragraph of [...body.children].slice(-10))
        (paragraph as HTMLElement).style.visibility = "hidden"
    })
    await assert.rejects(observation.waitForReady("controlled", 150), /Timeout/)
    evidence = await observation.snapshot()
    assert.equal(
      evidence.renderer?.visibilitySamples?.at(-1)?.blankReason,
      "no-body",
      "Nearby hidden tail text must not make an empty viewport readable"
    )
    await observation.setPhase("switch")
    await page.locator("[data-radix-scroll-area-viewport]").evaluate((element) => {
      element.scrollTop = 0
      element.innerHTML =
        "<div data-chat-message-row><time>ROW_FAKE</time>" +
        "<button data-chat-search-text>ROW_BUTTON</button>" +
        '<div data-function-site-pending style="height:100px">' +
        '<p role="status" data-chat-search-text>内容加载较慢，请稍候…</p></div></div>'
    })
    await assert.rejects(observation.waitForReady("controlled", 150), /Timeout/)
    await page.waitForTimeout(350)
    evidence = await observation.snapshot()
    assert((evidence.renderer?.phases.switch.visibility?.blankSamples ?? 0) > 0)
    assert((evidence.renderer?.phases.switch.visibility?.pendingSamples ?? 0) > 0)
    assert((evidence.renderer?.phases.switch.visibility?.slowNoticeSamples ?? 0) > 0)
    assert.equal(evidence.renderer?.phases.switch.visibility?.greyBarSamples, 0)
    assert.equal(evidence.renderer?.phases.switch.visibility?.postReadyBlankSamples, 0)
    assert(
      evidence.renderer?.visibilitySamples?.some(
        (sample) =>
          sample.phase === "switch" &&
          !sample.ready &&
          sample.blank &&
          sample.scopeId === "controlled"
      )
    )
    await page.locator("[data-radix-scroll-area-viewport]").evaluate((element) => {
      element.innerHTML =
        "<div data-chat-message-row><p data-chat-search-text>START_RUN_LOAD</p></div>"
    })
    await assert.rejects(observation.waitForReady("another-scope", 150), /Timeout/)
    evidence = await observation.snapshot()
    assert(
      !evidence.renderer?.visibilitySamples?.some(
        (sample) => sample.phase === "switch" && sample.ready
      )
    )
    await observation.waitForReady("controlled")
    evidence = await observation.snapshot()
    assert.equal(evidence.renderer?.visibilitySamples?.at(-1)?.ready, true)
    assert.equal(evidence.renderer?.visibilitySamples?.at(-1)?.blank, false)
    assert.equal(evidence.renderer?.visibilitySamples?.at(-1)?.trigger, "ready")
    for (let index = 0; index < 4; index++) await observation.waitForReady("controlled")
    await page.locator("[data-radix-scroll-area-viewport]").evaluate((element) => {
      element.innerHTML = (
        '<div data-chat-message-row style="height:5px;overflow:hidden">' +
        '<div data-function-site-pending style="height:5px">' +
        "PRIVATE_CONTEXT_BODY_MUST_NOT_BE_RETAINED</div></div>"
      ).repeat(20)
    })
    await page.waitForTimeout(150)
    evidence = await observation.snapshot()
    assert((evidence.renderer?.phases.switch.visibility?.postReadyBlankSamples ?? 0) > 0)
    const firstContext = evidence.renderer?.postReadyBlankContexts?.[0]
    assert(firstContext)
    assert.equal(firstContext.before.length, 4)
    assert(firstContext.before.every((sample) => sample.atMs <= firstContext.anomaly.atMs))
    assert.equal(firstContext.anomaly.blankReason, "no-body")
    assert.equal(firstContext.geometry.viewport?.clientHeight, 150)
    assert.equal(firstContext.geometry.rows.length, 16)
    assert.equal(firstContext.geometry.rowLimitReached, true)
    assert(
      firstContext.geometry.rows.every(
        (row) => row.pending.length === 1 && row.bodies.length === 0 && row.rect.height === 5
      )
    )
    assert(!JSON.stringify(firstContext).includes("PRIVATE_CONTEXT_BODY_MUST_NOT_BE_RETAINED"))
    assert(
      evidence.renderer?.postReadyBlankEvidence?.some(
        (sample) =>
          sample.phase === "switch" &&
          sample.ready &&
          sample.blank &&
          sample.pending &&
          sample.scopeId === "controlled" &&
          sample.blankReason === "no-body" &&
          sample.visibleBodyCount === 0
      )
    )
    await page.locator("[data-radix-scroll-area-viewport]").evaluate((element) => {
      element.innerHTML =
        '<div data-chat-message-row="stable-row" data-chat-message-id="stable-id">' +
        "<p data-chat-search-text>ROW_READY</p></div>"
    })
    await observation.waitForReady("controlled")
    await page
      .locator("[data-chat-message-row]")
      .first()
      .evaluate((element) => {
        element.setAttribute("data-chat-message-id", "scroll-start-id")
        element.setAttribute("data-chat-message-row", "scroll-start-row")
      })
    await observation.setPhase("scroll", true)
    await page.locator("[data-radix-scroll-area-viewport]").evaluate((element) => {
      element.innerHTML = ""
    })
    // The outgoing sample observes a body lost during the operation, before another
    // readiness check could conceal that the previous ready state must carry forward.
    await observation.setPhase("ready-hidden", true)
    evidence = await observation.snapshot()
    assert((evidence.renderer?.phases.scroll.visibility?.postReadyBlankSamples ?? 0) > 0)
    const scrollContext = evidence.renderer?.postReadyBlankContexts?.find(
      (context) => context.anomaly.phase === "scroll"
    )
    assert(scrollContext?.phaseStart)
    assert.equal(scrollContext.phaseStart.scopeId, "controlled")
    assert.equal(scrollContext.phaseStart.generation, scrollContext.anomaly.phaseGeneration)
    assert.equal(scrollContext.phaseStart.geometry.rows[0].messageId, "scroll-start-id")
    assert.equal(scrollContext.phaseStart.geometry.rows[0].rowIdentity, "scroll-start-row")
    assert.equal(scrollContext.geometry.rows.length, 0)
    assert(scrollContext.readySource)
    assert(scrollContext.readySource.geometry)
    assert(scrollContext.readySource.geometry.rows.some((row) => row.bodies.length > 0))
    assert.equal(
      scrollContext.readySource.geometry.rows[0].messageId,
      "stable-id",
      "Ready geometry is a snapshot before the later scroll-start identity change"
    )
    assert(scrollContext.readySource.generation < scrollContext.phaseStart.generation)
    assert(scrollContext.readySource.atMs <= scrollContext.phaseStart.atMs)
    assert.equal(
      firstContext.phaseStart,
      null,
      "Non-scroll phases do not capture starting geometry"
    )
    await page.locator("[data-radix-scroll-area-viewport]").evaluate((element) => {
      element.innerHTML = "<div data-chat-message-row><p data-chat-search-text>ROW_READY</p></div>"
      const viewport = element as HTMLElement
      viewport.closest<HTMLElement>("[data-chat-thread-id]")!.style.display = "none"
    })
    await observation.setPhase("ready-zero-height", true)
    evidence = await observation.snapshot()
    assert((evidence.renderer?.phases["ready-hidden"].visibility?.postReadyBlankSamples ?? 0) > 0)
    await assert.rejects(observation.waitForReady("controlled", 150), /Timeout/)
    await page.locator("[data-radix-scroll-area-viewport]").evaluate((element) => {
      const viewport = element as HTMLElement
      viewport.closest<HTMLElement>("[data-chat-thread-id]")!.style.display = "block"
      viewport.style.height = "0px"
    })
    await observation.setPhase("after-zero-height", true)
    evidence = await observation.snapshot()
    assert(
      (evidence.renderer?.phases["ready-zero-height"].visibility?.postReadyBlankSamples ?? 0) > 0
    )
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, value: true })
    })
    await observation.setPhase("document-hidden", true)
    await assert.rejects(observation.waitForReady("controlled", 150), /Timeout/)
    evidence = await observation.snapshot()
    assert.equal(
      evidence.renderer?.visibilitySamples?.at(-1)?.blank,
      false,
      "A hidden document must not be reported as a blank visible viewport"
    )
    assert.equal(evidence.renderer?.phases["document-hidden"].visibility?.postReadyBlankSamples, 0)
    await page.evaluate(() => {
      Reflect.deleteProperty(document, "hidden")
    })
    await page.locator("[data-radix-scroll-area-viewport]").evaluate((element) => {
      const viewport = element as HTMLElement
      viewport.style.height = "150px"
      viewport.innerHTML = ""
    })
    await observation.setPhase("switch")
    // Reusing a phase label is a new operation and must reset its readiness marker.
    await observation.setPhase("switch")
    await observation.setPhase("after-reset")
    evidence = await observation.snapshot()
    assert.equal(evidence.renderer?.visibilitySamples?.at(-1)?.phase, "switch")
    assert.equal(evidence.renderer?.visibilitySamples?.at(-1)?.ready, false)
    assert.equal(evidence.renderer?.visibilitySamples?.at(-1)?.blank, true)
    // A pending wait must not mark a later operation ready, even if its label repeats.
    const staleWait = assert.rejects(observation.waitForReady("controlled", 300), /Timeout/)
    await observation.setPhase("after-reset")
    await page.locator("[data-radix-scroll-area-viewport]").evaluate((element) => {
      element.innerHTML = "<div data-chat-message-row><p data-chat-search-text>ROW_READY</p></div>"
    })
    await staleWait
    evidence = await observation.snapshot()
    assert(
      !evidence.renderer?.visibilitySamples?.some(
        (sample) => sample.phase === "after-reset" && sample.ready
      )
    )
    await observation.waitForReady("controlled")
    await page.locator("[data-radix-scroll-area-viewport]").evaluate((element) => {
      element.innerHTML = ""
    })
    for (let index = 0; index < 140; index++) await observation.setPhase("bounded", true)
    evidence = await observation.snapshot()
    assert.equal(evidence.renderer?.visibilitySamples?.length, 128)
    assert.equal(evidence.renderer?.postReadyBlankEvidence?.length, 16)
    assert.equal(evidence.renderer?.postReadyBlankContexts?.length, 8)
    for (const context of evidence.renderer!.postReadyBlankContexts!) {
      assert.equal(context.after.length, 4)
      assert(context.before.length <= 4)
      assert(context.after.every((sample) => sample.atMs >= context.anomaly.atMs))
      assert(context.geometry.rows.length <= 16)
      assert(
        context.geometry.rows.every((row) => row.pending.length <= 16 && row.bodies.length <= 16)
      )
    }
    assert.deepEqual(
      evidence.renderer?.postReadyBlankContexts?.[0].anomaly,
      firstContext.anomaly,
      "The first anomaly must survive eviction from the rolling sample window"
    )
    assert(!JSON.stringify(evidence).includes("PRIVATE_CONTEXT_BODY_MUST_NOT_BE_RETAINED"))
    await observation.setPhase("resize")
    await page.waitForTimeout(100)
    evidence = await observation.snapshot()
    assert((evidence.main?.phases.transition.samples ?? 0) > 0)
    await observation.setPhase("short-scroll")
    await observation.setPhase("short-resize")
    evidence = await observation.snapshot()
    assert(
      (evidence.renderer?.phases["short-scroll"].visibility?.samples ?? 0) > 0,
      "Even a phase shorter than the polling interval needs an outgoing visibility sample"
    )
    const stopped = await observation.stop()
    assert((stopped.renderer?.phases["short-resize"].visibility?.samples ?? 0) > 0)
    await page.waitForTimeout(150)
    const later = await observation.snapshot()
    assert.deepEqual(later.main?.phases, stopped.main?.phases)
    assert.deepEqual(later.renderer?.phases, stopped.renderer?.phases)
    await installChatScrollWriteDiagnostic(page)
    await page.locator("[data-radix-scroll-area-viewport]").evaluate((viewport) => {
      viewport.innerHTML = '<div style="height:1000px">PRIVATE_SCROLL_TEXT</div>'
      viewport.scrollTop = 10
      viewport.scrollTo({ top: 20 })
      viewport.scrollBy({ top: 10 })
      document.documentElement.scrollTop = 10
    })
    const writes = await page.evaluate(() => Reflect.get(window, "chatScrollWriteDiagnostic"))
    assert.deepEqual(writes.map((write: { operation: string }) => write.operation),
      ["scrollTop", "scrollTo", "scrollBy"])
    assert(writes.every((write: { threadId: string }) => write.threadId === "controlled"))
    assert(!JSON.stringify(writes).includes("PRIVATE_SCROLL_TEXT"))
    await page.locator("[data-radix-scroll-area-viewport]").evaluate((viewport) => {
      for (let value = 0; value < 140; value++) viewport.scrollTop = value
    })
    assert.equal(await page.evaluate(() =>
      Reflect.get(window, "chatScrollWriteDiagnostic").length), 128)
    await page.close()
    const closed = await observation.stop()
    assert(closed.main)
    assert.equal(closed.renderer, null)
    assert.equal(closed.errors.length, 1, "A closed renderer must retain main-process evidence")
    console.log("PASS serialized heartbeat, offscreen marker, pending/slow sampling and cleanup")
  } finally {
    await observation?.stop()
    await browser.close()
  }
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
