import assert from "node:assert/strict"
import type { Page } from "playwright"
import {
  beginDesktopLatency,
  finishDesktopLatency,
  readDesktopLatency
} from "./mods-desktop-latency"

/** Browser measurement regression on real trusted DOM input, not guest/business acceptance. */
export async function verifyDesktopLatencyDiagnostics(
  page: Page,
  pass: (label: string) => void
): Promise<void> {
  await page.evaluate(() => {
    const section = document.createElement("section")
    section.id = "mods-latency-fixture"
    section.dataset.functionPane = "latency-fixture"
    section.style.cssText =
      "position:fixed;top:20px;left:320px;z-index:2147483647;background:white;padding:20px"
    section.innerHTML = `<div data-function-client-instance="latency-client">
      <input aria-label="Soak note 99" data-function-handle="1" />
      <button data-function-handle="2">Soak increment 99</button>
      <span>ACK_99:0</span></div>`
    document.body.append(section)
  })
  try {
    await beginDesktopLatency(page, 99, 1)
    // A redraw may replace the node while retaining the same visible control.
    await page.evaluate(() => {
      const section = document.getElementById("mods-latency-fixture")!
      const previous = section.querySelector("button")!
      const current = previous.cloneNode(true) as HTMLButtonElement
      current.dataset.functionHandle = "3"
      current.addEventListener("click", () => {
        section.querySelector("span")!.textContent = "ACK_99:1"
      })
      previous.replaceWith(current)
    })
    await page.getByRole("textbox", { name: "Soak note 99", exact: true }).fill("latency probe")
    await page.getByRole("button", { name: "Soak increment 99", exact: true }).click()
    await page.getByText("ACK_99:1", { exact: true }).waitFor()
    const evidence = await readDesktopLatency(page)
    assert(evidence)
    assert.equal(evidence.initialButtonConnected, false)
    assert.equal(evidence.currentButton?.handle, "3")
    assert.equal(evidence.currentButton?.clientInstance, "latency-client")
    assert(evidence.events.some((event) => event.kind === "input"))
    for (const kind of ["pointerdown", "pointerup", "click"]) {
      const event = evidence.events.find((event) => event.kind === kind)
      assert(event)
      assert.equal(event.sameAsInitialButton, false)
      assert.equal(event.handle, "3")
      assert.equal(event.disabled, false)
    }
    const result = await finishDesktopLatency(page)
    assert(Number.isFinite(result.inputPaintMs))
    assert(Number.isFinite(result.clickAcknowledgementMs))
    pass("trusted DOM input and click latency survive replacement of the original button node")
    assert.equal(await readDesktopLatency(page), null)

    await beginDesktopLatency(page, 99, 2)
    await page.evaluate(() => {
      const section = document.getElementById("mods-latency-fixture")!
      const previous = section.querySelector("button")!
      previous.replaceWith(previous.cloneNode(true))
      const button = section.querySelector("button")!
      button.click()
      section.querySelector("input")!.dispatchEvent(new Event("input", { bubbles: true }))
    })
    assert.deepEqual((await readDesktopLatency(page))!.events, [])
    pass("synthetic input and click cannot create trusted latency evidence")

    for (let click = 0; click < 7; click++)
      await page.getByRole("button", { name: "Soak increment 99", exact: true }).click()
    const unacknowledged = (await readDesktopLatency(page))!
    assert.equal(unacknowledged.events.length, 16)
    assert.equal(unacknowledged.clickAcknowledgementMs, undefined)
    assert.deepEqual(unacknowledged.acknowledgements, ["ACK_99:1"])
    assert.equal(unacknowledged.expected, "ACK_99:2")
    assert.equal(JSON.stringify(unacknowledged).includes("latency probe"), false)
    pass("missing acknowledgement stays incomplete and trusted event history is bounded")

    await page.evaluate(() => {
      const button = document.querySelector<HTMLButtonElement>("#mods-latency-fixture button")!
      button.disabled = true
      button.setAttribute("aria-disabled", "true")
    })
    const disabled = (await readDesktopLatency(page, true))!
    assert.equal(disabled.currentButton?.disabled, true)
    assert.equal(disabled.currentButton?.ariaDisabled, "true")
    assert.equal(await readDesktopLatency(page), null)
    pass("failure snapshot retains disabled state and cleanup removes the probe")
  } finally {
    await readDesktopLatency(page, true)
    await page.evaluate(() => document.getElementById("mods-latency-fixture")?.remove())
  }
}
