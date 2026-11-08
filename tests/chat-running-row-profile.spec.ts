/** Exercise the real tsx -> Playwright serialization boundary without starting Electron. */
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { chromium } from "playwright"
import { startChatRunningRowProfile } from "./support/chat-running-row-profile"

async function main() {
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" })
  })
  const page = await browser.newPage()
  let profile: Awaited<ReturnType<typeof startChatRunningRowProfile>> | undefined
  try {
    await page.setContent(`<div data-chat-thread-id="controlled">
      <div data-radix-scroll-area-viewport></div></div>`)
    // A lexical __name shim must suffice. Do not add any helper to the target global.
    assert.equal(await page.evaluate(() => Object.hasOwn(globalThis, "__name")), false)
    await page.evaluate(`(() => {
      const Original = globalThis.MutationObserver
      globalThis.__rowObserverProbe = { disconnects: 0 }
      globalThis.MutationObserver = class extends Original {
        disconnect() {
          globalThis.__rowObserverProbe.disconnects++
          return super.disconnect()
        }
      }
    })()`)
    profile = await startChatRunningRowProfile(page)
    assert.equal(
      await page.evaluate(
        () => performance.getEntriesByName("chat-running-profile-start", "mark").length
      ),
      1
    )
    const secret = "PRIVATE_MESSAGE_CONTENT_MUST_NOT_BE_RETAINED"
    const pending = `<div data-chat-message-row><span data-function-site-pending></span></div>`
    const body = `<div data-chat-message-row><p data-chat-search-text>${secret}</p></div>`
    const viewport = page.locator("[data-radix-scroll-area-viewport]")
    await viewport.evaluate((element, html) => {
      element.innerHTML = html
    }, pending.repeat(40))
    await viewport.evaluate((element, html) => {
      element.innerHTML = html
    }, body.repeat(40))
    await viewport.evaluate((element, html) => {
      element.innerHTML = html
    }, body.repeat(2))
    // Attribute-only changes must be observed as well as replacing pending child nodes.
    await viewport.evaluate((element) => {
      element.firstElementChild!.setAttribute("data-function-site-pending", "")
    })
    await viewport.evaluate((element) => {
      element.firstElementChild!.removeAttribute("data-function-site-pending")
    })
    const evidence = await profile.stop()
    assert.equal(evidence.peaks.mountedRows.mountedRows, 40)
    assert.equal(evidence.peaks.pendingRows.pendingRows, 40)
    assert.equal(evidence.peaks.bodyNodes.bodyNodes, 40)
    assert(
      evidence.samples.some(
        (sample) =>
          sample.trigger === "mutation" &&
          sample.mountedRows === 2 &&
          sample.pendingRows === 1 &&
          sample.bodyRows === 2
      )
    )
    assert.equal(evidence.samples.at(-1)?.mountedRows, 2)
    assert.equal(evidence.samples.at(-1)?.pendingRows, 0)
    assert(evidence.mark.atMs <= evidence.samples[0].atMs)
    assert(evidence.timeOrigin > 0 && evidence.stoppedAtMs >= evidence.mark.atMs)
    assert(!JSON.stringify(evidence).includes(secret), "Evidence must not retain body text")
    assert.equal(
      await page.evaluate(
        () => performance.getEntriesByName("chat-running-profile-start", "mark").length
      ),
      0
    )
    assert.equal(
      await page.evaluate(() => Object.hasOwn(globalThis, "__chatRunningRowProfile")),
      false
    )
    assert.equal(await page.evaluate(() => Object.hasOwn(globalThis, "__name")), false)
    assert.equal(await page.evaluate("globalThis.__rowObserverProbe.disconnects"), 1)
    await viewport.evaluate((element) => {
      element.innerHTML = ""
    })
    assert.deepEqual(await profile.stop(), evidence, "Stopped evidence remains unchanged")

    profile = await startChatRunningRowProfile(page)
    // Yield to MutationObserver delivery after each mutation, with no artificial timer delay.
    await page.evaluate(async () => {
      const root = document.querySelector("[data-chat-thread-id]")!
      const viewport = root.querySelector("[data-radix-scroll-area-viewport]")!
      for (let scope = 0; scope < 35; scope++) {
        root.setAttribute("data-chat-thread-id", `scope-${scope}`)
        for (let change = 0; change < 36; change++) {
          viewport.innerHTML =
            "<div data-chat-message-row><p data-chat-search-text></p></div>".repeat(
              1 + (change % 2)
            )
          await Promise.resolve()
        }
      }
      // A single oversized mounted row must respect the traversal budget as well.
      viewport.innerHTML = "<div data-chat-message-row>" + "<i></i>".repeat(12010) + "</div>"
      await Promise.resolve()
    })
    const bounded = await profile.stop()
    assert.equal(bounded.samples.length, bounded.limits.samples)
    assert(bounded.droppedSamples > 0)
    assert.equal(bounded.scopes.length, bounded.limits.scopes)
    assert(bounded.droppedScopes > 0)
    const perScope = new Map<string | null, number>()
    for (const sample of bounded.samples) {
      perScope.set(sample.scopeId, (perScope.get(sample.scopeId) ?? 0) + 1)
      assert(sample.visitedElements <= bounded.limits.elementsPerSample)
    }
    assert([...perScope.values()].every((count) => count <= bounded.limits.samplesPerScope))
    assert(
      bounded.samples.some(
        (sample) => sample.truncated && sample.visitedElements === bounded.limits.elementsPerSample
      )
    )
    assert.equal(await page.evaluate("globalThis.__rowObserverProbe.disconnects"), 2)
    assert.equal(
      await page.evaluate(
        () => performance.getEntriesByName("chat-running-profile-start", "mark").length
      ),
      0
    )
    await page.close()
    assert.deepEqual(await profile.stop(), bounded, "Repeated stop does not need a live renderer")
    console.log("PASS serialized row profiling, pending/body peaks, bounded evidence and cleanup")
  } finally {
    await profile?.stop()
    await browser.close()
  }
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
