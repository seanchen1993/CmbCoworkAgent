import type { Page } from "playwright"

interface ControlEvidence {
  handle: string | null
  clientInstance: string | null
  connected: boolean
  disabled: boolean
  ariaDisabled: string | null
  focused: boolean
  sameAsInitialButton: boolean
}

export interface DesktopLatencyEvidence {
  expected: string
  elapsedMs: number
  sectionConnected: boolean
  initialButtonConnected: boolean
  currentButton: ControlEvidence | null
  acknowledgements: string[]
  events: Array<ControlEvidence & { kind: string; elapsedMs: number }>
  inputPaintMs?: number
  clickAcknowledgementMs?: number
}

interface Probe {
  inputPaintMs?: number
  clickAcknowledgementMs?: number
  read(): DesktopLatencyEvidence
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
      const started = performance.now()
      const events: DesktopLatencyEvidence["events"] = []
      const clip = (value: string | null) => value?.slice(0, 160) ?? null
      const control = (target: Element): ControlEvidence => ({
        handle: clip(target.getAttribute("data-function-handle")),
        clientInstance: clip(
          target
            .closest("[data-function-client-instance]")
            ?.getAttribute("data-function-client-instance") ?? null
        ),
        connected: target.isConnected,
        disabled: target.matches(":disabled"),
        ariaDisabled: clip(target.getAttribute("aria-disabled")),
        focused: document.activeElement === target,
        sameAsInitialButton: target === button
      })
      const record = (event: Event, target: Element) => {
        events.push({
          kind: event.type,
          elapsedMs: performance.now() - started,
          ...control(target)
        })
        if (events.length > 16) events.shift()
      }
      const liveButton = (event: Event): HTMLButtonElement | null => {
        if (!event.isTrusted || !(event.target instanceof Element)) return null
        const target = event.target.closest("button")
        return target?.closest("[data-function-pane]") === section &&
          target.textContent === buttonLabel
          ? target
          : null
      }
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
          event.target.closest("[data-function-pane]") !== section ||
          event.target.getAttribute("aria-label") !== `Soak note ${pane}`
        )
          return
        record(event, event.target)
        cancelAnimationFrame(firstFrame)
        cancelAnimationFrame(secondFrame)
        delete probe.inputPaintMs
        const start = performance.now()
        firstFrame = requestAnimationFrame(() => {
          secondFrame = requestAnimationFrame(() => {
            probe.inputPaintMs = performance.now() - start
          })
        })
      }
      const click = (event: Event) => {
        const target = liveButton(event)
        if (!target) return
        record(event, target)
        delete probe.clickAcknowledgementMs
        clickStart = performance.now()
        observer.observe(section, { subtree: true, childList: true, characterData: true })
      }
      const pointer = (event: Event) => {
        const target = liveButton(event)
        if (target) record(event, target)
      }
      const probe: Probe = {
        read() {
          const current = [...section.querySelectorAll("button")].find(
            (target) =>
              target.closest("[data-function-pane]") === section &&
              target.textContent === buttonLabel
          )
          return {
            expected,
            elapsedMs: performance.now() - started,
            sectionConnected: section.isConnected,
            initialButtonConnected: button?.isConnected ?? false,
            currentButton: current ? control(current) : null,
            acknowledgements: [...section.querySelectorAll("span")]
              .map((target) => target.textContent ?? "")
              .filter((text) => text.length <= 80 && /^ACK_\d+:\d+$/.test(text))
              .slice(0, 16),
            events: [...events],
            inputPaintMs: probe.inputPaintMs,
            clickAcknowledgementMs: probe.clickAcknowledgementMs
          }
        },
        cleanup() {
          observer.disconnect()
          cancelAnimationFrame(firstFrame)
          cancelAnimationFrame(secondFrame)
          document.removeEventListener("input", input, true)
          document.removeEventListener("click", click, true)
          document.removeEventListener("pointerdown", pointer, true)
          document.removeEventListener("pointerup", pointer, true)
        }
      }
      document.addEventListener("input", input, true)
      document.addEventListener("click", click, true)
      document.addEventListener("pointerdown", pointer, true)
      document.addEventListener("pointerup", pointer, true)
      host.__modsLatencyProbe = probe
    },
    { pane, count }
  )
}

/** Read only bounded soak control metadata; never collect input or conversation contents. */
export async function readDesktopLatency(
  page: Page,
  cleanup = false
): Promise<DesktopLatencyEvidence | null> {
  return page.evaluate((cleanup) => {
    const host = window as ProbeWindow
    const probe = host.__modsLatencyProbe
    if (!probe) return null
    try {
      return probe.read()
    } finally {
      if (cleanup) {
        probe.cleanup()
        delete host.__modsLatencyProbe
      }
    }
  }, cleanup)
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
