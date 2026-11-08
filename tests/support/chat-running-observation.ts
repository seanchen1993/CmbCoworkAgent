import type { ElectronApplication, Page } from "playwright"

export interface RunningHeartbeatStats {
  samples: number
  maximumIntervalMs: number
  maximumOverrunMs: number
  overrunAbove150Ms: number
  overrunAbove500Ms: number
  overrunAbove1000Ms: number
}

export interface RunningVisibilityStats {
  samples: number
  maximumSampleGapMs: number
  blankSamples: number
  postReadyBlankSamples: number
  pendingSamples: number
  greyBarSamples: number
  slowNoticeSamples: number
  maximumObservedBlankMs: number
  maximumObservedPendingMs: number
  maximumObservedGreyBarMs: number
  maximumObservedSlowNoticeMs: number
}

export interface RunningVisibilitySample {
  atMs: number
  phase: string
  ready: boolean
  scopeId: string | null
  blank: boolean
  pending: boolean
  trigger: "timer" | "phase" | "ready" | "stop"
  phaseGeneration: number
  blankReason: "document-hidden" | "missing-viewport" | "hidden-viewport" | "no-body" | null
  visibleBodyCount: number
}

interface RunningGeometry {
  x: number
  y: number
  width: number
  height: number
}

export interface RunningBlankContext {
  scrollWrites?: unknown[]
  before: RunningVisibilitySample[]
  anomaly: RunningVisibilitySample
  after: RunningVisibilitySample[]
  readySource: {
    generation: number
    atMs: number
    scopeId: string
    geometry: RunningBlankContext["geometry"] | null
    scrollWrites?: unknown[]
  } | null
  phaseStart: {
    atMs: number
    generation: number
    scopeId: string | null
    geometry: RunningBlankContext["geometry"]
  } | null
  geometry: {
    viewport: {
      scrollTop: number
      scrollHeight: number
      clientHeight: number
      clientWidth: number
      rect: RunningGeometry
    } | null
    rows: Array<{
      messageId: string | null
      rowIdentity: string | null
      rect: RunningGeometry
      bodies: RunningGeometry[]
      pending: RunningGeometry[]
    }>
    rowLimitReached: boolean
  }
}

interface MonitorSnapshot {
  phases: Record<string, RunningHeartbeatStats & { visibility?: RunningVisibilityStats }>
  elapsedMs: number
  visibilitySamples?: RunningVisibilitySample[]
  postReadyBlankEvidence?: RunningVisibilitySample[]
  postReadyBlankContexts?: RunningBlankContext[]
}

export interface RunningObservationSnapshot {
  main: MonitorSnapshot | null
  renderer: MonitorSnapshot | null
  errors: string[]
  semantics: string
}

interface Monitor {
  phase(value: string, preserveReady: boolean, generation: number): void
  tryReady(scopeId: string, generation: number): boolean
  snapshot(): MonitorSnapshot
  stop(): MonitorSnapshot
}

// Executed inside either target process. Keep this function self-contained: Playwright
// serializes it, so no imported helpers or captured Node/renderer values are allowed.
function installMonitor(options: {
  key: string
  renderer: boolean
  scrollDiagnostics?: boolean
}): void {
  const registry = globalThis as unknown as Record<string, Monitor | undefined>
  registry[options.key]?.stop()
  const started = performance.now()
  let previous = started
  let phase = "idle"
  let ready = false
  let phaseGeneration = 0
  let readySource: RunningBlankContext["readySource"] = null
  let phaseStart: RunningBlankContext["phaseStart"] = null
  const visibilitySamples: RunningVisibilitySample[] = []
  const postReadyBlankEvidence: RunningVisibilitySample[] = []
  const postReadyBlankContexts: RunningBlankContext[] = []
  let phaseChanged = false
  const phases: MonitorSnapshot["phases"] = Object.create(null)
  let visibilityAt = started
  let streaks = [0, 0, 0, 0]
  let previousFlags = [false, false, false, false]
  let stopped = false
  const bucket = (name = phase) => {
    if (!phases[name])
      phases[name] = {
        samples: 0,
        maximumIntervalMs: 0,
        maximumOverrunMs: 0,
        overrunAbove150Ms: 0,
        overrunAbove500Ms: 0,
        overrunAbove1000Ms: 0,
        ...(options.renderer
          ? {
              visibility: {
                samples: 0,
                maximumSampleGapMs: 0,
                blankSamples: 0,
                postReadyBlankSamples: 0,
                pendingSamples: 0,
                greyBarSamples: 0,
                slowNoticeSamples: 0,
                maximumObservedBlankMs: 0,
                maximumObservedPendingMs: 0,
                maximumObservedGreyBarMs: 0,
                maximumObservedSlowNoticeMs: 0
              }
            }
          : {})
      }
    return phases[name]
  }
  const visible = (element: Element, area: DOMRect): boolean => {
    const box = element.getBoundingClientRect()
    return (
      box.width > 0 &&
      box.height > 0 &&
      box.bottom > area.top &&
      box.top < area.bottom &&
      box.right > area.left &&
      box.left < area.right &&
      element.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true })
    )
  }
  const readVisibility = (now: number, trigger: RunningVisibilitySample["trigger"]) => {
    const root = document.querySelector("[data-chat-thread-id]")
    const viewport = root?.querySelector("[data-radix-scroll-area-viewport]")
    const area = viewport?.getBoundingClientRect()
    let visibleBodyCount = 0,
      pending = false,
      grey = false,
      slow = false
    const eligible =
      !!viewport &&
      !!area &&
      area.width > 0 &&
      area.height > 0 &&
      viewport.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true })
    if (eligible && viewport && area) {
      // Only mounted, intersecting rows. Text traversal is bounded and never retained.
      const rows = viewport.querySelectorAll("[data-chat-message-row]")
      for (let index = 0; index < Math.min(rows.length, 64); index++) {
        const row = rows[index]
        if (!visible(row, area)) continue
        const bodies = row.querySelectorAll("[data-chat-search-text]")
        for (let bodyIndex = 0; bodyIndex < Math.min(bodies.length, 64); bodyIndex++) {
          const body = bodies[bodyIndex]
          if (!visible(body, area)) continue
          const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT)
          for (
            let count = 0, node = walker.nextNode();
            node && count < 128;
            node = walker.nextNode(), count++
          ) {
            const parent = node.parentElement
            if (!parent || parent.closest("button,svg,[role=status],[data-function-site-pending]"))
              continue
            // Body ownership excludes avatars/toolbars and permits visible continuation
            // paragraphs after the fixture marker has scrolled away. Retain no body text.
            if (!node.nodeValue?.trim() || !visible(parent, area)) continue
            const range = document.createRange()
            range.selectNodeContents(node)
            const box = range.getBoundingClientRect()
            range.detach()
            if (
              box.width > 0 &&
              box.height > 0 &&
              box.bottom > area.top &&
              box.top < area.bottom &&
              box.right > area.left &&
              box.left < area.right
            ) {
              visibleBodyCount++
              break
            }
          }
        }
      }
      const placeholders = viewport.querySelectorAll("[data-function-site-pending]")
      for (let index = 0; index < Math.min(placeholders.length, 64); index++) {
        const placeholder = placeholders[index]
        if (!visible(placeholder, area)) continue
        pending = true
        // Legacy skeleton classes only; a neutral geometry placeholder is not a grey bar.
        grey ||= !!placeholder.querySelector(".animate-pulse,[data-slot=skeleton]")
        const notice = placeholder.querySelector("[role=status]")
        slow ||=
          !!notice &&
          visible(notice, area) &&
          /加载较慢|加载慢/.test(notice.textContent?.slice(0, 128) ?? "")
      }
    }
    const blankReason = document.hidden
      ? "document-hidden"
      : !viewport
        ? "missing-viewport"
        : !eligible
          ? "hidden-viewport"
          : !visibleBodyCount
            ? "no-body"
            : null
    const flags = [blankReason !== null && blankReason !== "document-hidden", pending, grey, slow]
    const sample: RunningVisibilitySample = {
      atMs: now - started,
      phase,
      ready,
      scopeId: root?.getAttribute("data-chat-thread-id")?.slice(0, 128) ?? null,
      blank: flags[0],
      pending,
      trigger,
      phaseGeneration,
      blankReason,
      visibleBodyCount
    }
    return { sample, flags }
  }
  const captureBlankGeometry = (): RunningBlankContext["geometry"] => {
    const root = document.querySelector("[data-chat-thread-id]")
    const viewport = root?.querySelector("[data-radix-scroll-area-viewport]")
    const rect = (element: Element): RunningGeometry => {
      const box = element.getBoundingClientRect()
      return { x: box.x, y: box.y, width: box.width, height: box.height }
    }
    const rows: RunningBlankContext["geometry"]["rows"] = []
    if (!viewport) return { viewport: null, rows, rowLimitReached: false }
    const area = viewport.getBoundingClientRect()
    const mounted = viewport.querySelectorAll("[data-chat-message-row]")
    let rowLimitReached = false
    for (let index = 0; index < Math.min(mounted.length, 64); index++) {
      const row = mounted[index]
      if (!visible(row, area)) continue
      if (rows.length === 16) {
        rowLimitReached = true
        break
      }
      const childRects = (selector: string): RunningGeometry[] => {
        const nodes = row.querySelectorAll(selector)
        const result: RunningGeometry[] = []
        for (let child = 0; child < Math.min(nodes.length, 16); child++) {
          if (visible(nodes[child], area)) result.push(rect(nodes[child]))
        }
        return result
      }
      rows.push({
        messageId: row.getAttribute("data-chat-message-id")?.slice(0, 128) ?? null,
        rowIdentity: row.getAttribute("data-chat-message-row")?.slice(0, 128) ?? null,
        rect: rect(row),
        bodies: childRects("[data-chat-search-text]"),
        pending: childRects("[data-function-site-pending]")
      })
    }
    return {
      viewport: {
        scrollTop: viewport.scrollTop,
        scrollHeight: viewport.scrollHeight,
        clientHeight: viewport.clientHeight,
        clientWidth: viewport.clientWidth,
        rect: rect(viewport)
      },
      rows,
      rowLimitReached: rowLimitReached || mounted.length > 64
    }
  }
  const observeVisibility = (
    now: number,
    trigger: RunningVisibilitySample["trigger"],
    reading = readVisibility(now, trigger)
  ) => {
    const stats = bucket().visibility!
    const gap = now - visibilityAt
    visibilityAt = now
    stats.samples++
    stats.maximumSampleGapMs = Math.max(stats.maximumSampleGapMs, gap)
    const { sample, flags } = reading
    for (const context of postReadyBlankContexts) {
      if (context.after.length < 4) context.after.push(sample)
    }
    if (ready && sample.blank && postReadyBlankContexts.length < 8) {
      postReadyBlankContexts.push({
        before: visibilitySamples.slice(-4),
        anomaly: sample,
        after: [],
        readySource,
        phaseStart,
        ...(Array.isArray(Reflect.get(window, "chatScrollWriteDiagnostic"))
          ? { scrollWrites: Reflect.get(window, "chatScrollWriteDiagnostic").slice(-96) }
          : {}),
        geometry: captureBlankGeometry()
      })
    }
    visibilitySamples.push(sample)
    if (visibilitySamples.length > 128) visibilitySamples.shift()
    if (ready && sample.blank) {
      stats.postReadyBlankSamples++
      // Preserve the first anomalies even after the rolling sample window advances.
      if (postReadyBlankEvidence.length < 16) postReadyBlankEvidence.push(sample)
    }
    const countKeys = [
      "blankSamples",
      "pendingSamples",
      "greyBarSamples",
      "slowNoticeSamples"
    ] as const
    const maximumKeys = [
      "maximumObservedBlankMs",
      "maximumObservedPendingMs",
      "maximumObservedGreyBarMs",
      "maximumObservedSlowNoticeMs"
    ] as const
    flags.forEach((flag, index) => {
      if (flag) stats[countKeys[index]]++
      streaks[index] = flag && previousFlags[index] ? streaks[index] + gap : 0
      stats[maximumKeys[index]] = Math.max(stats[maximumKeys[index]], streaks[index])
    })
    previousFlags = flags
  }
  const tick = () => {
    const now = performance.now(),
      interval = now - previous
    previous = now
    const stats = bucket(phaseChanged ? "transition" : phase)
    phaseChanged = false
    const overrun = Math.max(0, interval - 50)
    stats.samples++
    stats.maximumIntervalMs = Math.max(stats.maximumIntervalMs, interval)
    stats.maximumOverrunMs = Math.max(stats.maximumOverrunMs, overrun)
    if (overrun > 150) stats.overrunAbove150Ms++
    if (overrun > 500) stats.overrunAbove500Ms++
    if (overrun > 1000) stats.overrunAbove1000Ms++
    if (options.renderer && now - visibilityAt >= 100) observeVisibility(now, "timer")
  }
  const timer = setInterval(tick, 50)
  const snapshot = (): MonitorSnapshot => ({
    phases,
    elapsedMs: performance.now() - started,
    ...(options.renderer
      ? { visibilitySamples, postReadyBlankEvidence, postReadyBlankContexts }
      : {})
  })
  const monitor: Monitor = {
    phase(value, preserveReady, generation) {
      // Short scroll/resize actions may finish between timer ticks. Take one bounded
      // outgoing sample at the phase boundary, outside the caller's operation timer.
      if (options.renderer && !stopped) observeVisibility(performance.now(), "phase")
      // Bound retained state even when a caller accidentally supplies a per-round label.
      const next = value in phases || Object.keys(phases).length < 32 ? value : "other"
      phaseChanged ||= next !== phase
      phase = next
      phaseGeneration = generation
      if (!preserveReady) {
        ready = false
        readySource = null
      }
      phaseStart =
        options.renderer && options.scrollDiagnostics && (value === "scroll" || value === "resize")
          ? {
              atMs: performance.now() - started,
              generation,
              scopeId:
                document
                  .querySelector("[data-chat-thread-id]")
                  ?.getAttribute("data-chat-thread-id")
                  ?.slice(0, 128) ?? null,
              geometry: captureBlankGeometry()
            }
          : null
      visibilityAt = performance.now()
      streaks = [0, 0, 0, 0]
      previousFlags = [false, false, false, false]
      bucket()
    },
    tryReady(scopeId, generation) {
      if (stopped || !options.renderer || generation !== phaseGeneration) return false
      const now = performance.now()
      const reading = readVisibility(now, "ready")
      if (reading.sample.scopeId !== scopeId || reading.sample.blankReason !== null) return false
      // Check and publish in the same renderer task, using the exact sampled body.
      ready = true
      readySource = {
        generation,
        atMs: now - started,
        scopeId,
        geometry: options.scrollDiagnostics ? captureBlankGeometry() : null,
        ...(Array.isArray(Reflect.get(window, "chatScrollWriteDiagnostic"))
          ? { scrollWrites: Reflect.get(window, "chatScrollWriteDiagnostic").slice(-96) }
          : {})
      }
      reading.sample.ready = true
      observeVisibility(now, "ready", reading)
      return true
    },
    snapshot,
    stop() {
      if (!stopped) {
        if (options.renderer) observeVisibility(performance.now(), "stop")
        stopped = true
        clearInterval(timer)
        if (options.renderer) window.removeEventListener("pagehide", onPageHide)
      }
      return snapshot()
    }
  }
  const onPageHide = () => monitor.stop()
  if (options.renderer) window.addEventListener("pagehide", onPageHide, { once: true })
  registry[options.key] = monitor
}

/** Optional diagnostics. Start after navigation/reload; setPhase before timed operations.
 * This measures in-process timer intervals, not CDP round-trip latency. Visibility is
 * sampled every ~100 ms and cannot establish what happened between samples or during
 * a stalled event loop. Fresh capability admission can legitimately show pending rows.
 */
export async function startChatRunningObservation(
  app: ElectronApplication,
  page: Page,
  options = { scrollDiagnostics: process.env.CHAT_RUNNING_SCROLL_DIAGNOSTICS === "1" }
) {
  const key = "__devclawRunningObservation"
  const errors: string[] = []
  let generation = 0
  // tsx preserves nested function names through an injected __name helper. Supply
  // that test-only lexical helper in both targets instead of leaking a global.
  const installSource = `((__name) => (${installMonitor.toString()}))(value => value)`
  await app.evaluate(
    (_electron, input) => {
      // Test-owned code only; serialize the same standalone monitor into both processes.
      const install = (0, eval)(input.source) as typeof installMonitor
      install({ key: input.key, renderer: false })
    },
    { source: installSource, key }
  )
  try {
    await page.evaluate(
      (input) => {
        const install = (0, eval)(input.source) as typeof installMonitor
        install({ key: input.key, renderer: true, scrollDiagnostics: input.scrollDiagnostics })
      },
      { source: installSource, key, scrollDiagnostics: options.scrollDiagnostics }
    )
  } catch (error) {
    await app
      .evaluate((_electron, name) => {
        ;(globalThis as unknown as Record<string, Monitor>)[name]?.stop()
      }, key)
      .catch(() => {})
    throw error
  }
  const read = async (stop: boolean): Promise<RunningObservationSnapshot> => {
    const results = await Promise.allSettled([
      app.evaluate(
        (_electron, input) => {
          const monitor = (globalThis as unknown as Record<string, Monitor>)[input.key]
          return monitor ? (input.stop ? monitor.stop() : monitor.snapshot()) : null
        },
        { key, stop }
      ),
      page.evaluate(
        (input) => {
          const monitor = (globalThis as unknown as Record<string, Monitor>)[input.key]
          return monitor ? (input.stop ? monitor.stop() : monitor.snapshot()) : null
        },
        { key, stop }
      )
    ])
    const values = results.map((result, index) => {
      if (result.status === "fulfilled") {
        if (!result.value) errors.push(`${index === 0 ? "main" : "renderer"}: monitor missing`)
        return result.value
      }
      errors.push(`${index === 0 ? "main" : "renderer"}: ${String(result.reason)}`)
      return null
    })
    return {
      main: values[0],
      renderer: values[1],
      errors: [...errors],
      semantics:
        "50 ms in-process heartbeat; ~100 ms and outgoing-phase bounded DOM visibility sampling. " +
        "Heartbeat intervals spanning phase changes belong to transition. " +
        "Observed streaks are sampled, not continuous paint proof; timer stalls leave unknown gaps. " +
        "Ready checks and records visible body atomically for the expected scope/phase generation. " +
        "Pending during fresh display authorization is not automatically a defect."
    }
  }
  return {
    async waitForReady(scopeId: string, timeout = 30000): Promise<void> {
      const expectedGeneration = generation
      const result = await page.waitForFunction(
        (input) => {
          return (
            (globalThis as unknown as Record<string, Monitor>)[input.key]?.tryReady(
              input.scopeId,
              input.generation
            ) ?? false
          )
        },
        { key, scopeId, generation: expectedGeneration },
        { timeout }
      )
      await result.dispose()
    },
    async setPhase(phase: string, preserveReady = false): Promise<void> {
      const nextGeneration = ++generation
      await Promise.all([
        app.evaluate(
          (_electron, input) => {
            ;(globalThis as unknown as Record<string, Monitor>)[input.key]?.phase(
              input.phase,
              input.preserveReady,
              input.generation
            )
          },
          { key, phase, preserveReady, generation: nextGeneration }
        ),
        page.evaluate(
          (input) => {
            ;(globalThis as unknown as Record<string, Monitor>)[input.key]?.phase(
              input.phase,
              input.preserveReady,
              input.generation
            )
          },
          { key, phase, preserveReady, generation: nextGeneration }
        )
      ])
    },
    snapshot: () => read(false),
    stop: () => read(true)
  }
}
