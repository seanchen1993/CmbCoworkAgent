import type { Page } from "playwright"

interface Probe {
  inputPaintMs?: number
  clickAcknowledgementMs?: number
  cleanup(): void
}
type ProbeWindow = Window & { __modsLatencyProbe?: Probe }

/** Measure native DOM events, excluding Playwright actionability waits and IPC round trips. */
export async function beginDesktopLatency(page: Page, pane: number, count: number): Promise<void> {
  await page.evaluate(
    ({ pane, count }) => {
      const host = window as ProbeWindow
      host.__modsLatencyProbe?.cleanup()
      let firstFrame = 0,
        secondFrame = 0
      let clickStart: number | undefined
      const buttonLabel = `Soak increment ${pane}`
      const expected = `ACK_${pane}:${count}`
      const button = [...document.querySelectorAll("button")].find(
        (b) => b.textContent === buttonLabel
      )
      const section = button?.closest("[data-function-pane]")
      if (!section) throw Error("LATENCY_PANE_MISSING")
      const observer = new MutationObserver(() => {
        if (clickStart === undefined) return
        if ([...section.querySelectorAll("span")].some((el) => el.textContent === expected)) {
          probe.clickAcknowledgementMs = performance.now() - clickStart
          observer.disconnect()
        }
      })
      const input = (event: Event) => {
        if (
          !event.isTrusted ||
          !(event.target instanceof HTMLInputElement) ||
          event.target.getAttribute("aria-label") !== `Soak note ${pane}`
        )
          return
        const start = performance.now()
        firstFrame = requestAnimationFrame(() => {
          secondFrame = requestAnimationFrame(() => {
            probe.inputPaintMs = performance.now() - start
          })
        })
      }
      const click = (event: Event) => {
        if (
          !event.isTrusted ||
          !(event.target instanceof Element) ||
          event.target.closest("button") !== button
        )
          return
        clickStart = performance.now()
        observer.observe(section, { subtree: true, childList: true, characterData: true })
      }
      const probe: Probe = {
        cleanup() {
          observer.disconnect()
          cancelAnimationFrame(firstFrame)
          cancelAnimationFrame(secondFrame)
          document.removeEventListener("input", input, true)
          document.removeEventListener("click", click, true)
        }
      }
      document.addEventListener("input", input, true)
      document.addEventListener("click", click, true)
      host.__modsLatencyProbe = probe
    },
    { pane, count }
  )
}

export async function finishDesktopLatency(page: Page): Promise<{
  inputPaintMs: number
  clickAcknowledgementMs: number
}> {
  await page.waitForFunction(
    () => {
      const probe = (window as ProbeWindow).__modsLatencyProbe
      return (
        typeof probe?.inputPaintMs === "number" && typeof probe?.clickAcknowledgementMs === "number"
      )
    },
    undefined,
    { timeout: 5000 }
  )
  return page.evaluate(() => {
    const host = window as ProbeWindow
    const probe = host.__modsLatencyProbe!
    probe.cleanup()
    delete host.__modsLatencyProbe
    return {
      inputPaintMs: probe.inputPaintMs!,
      clickAcknowledgementMs: probe.clickAcknowledgementMs!
    }
  })
}
