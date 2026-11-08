import type { Page } from "playwright"

export interface ChatRunningRowSample {
  atMs: number
  scopeId: string | null
  trigger: "start" | "mutation" | "stop"
  mountedRows: number
  pendingRows: number
  pendingNodes: number
  bodyNodes: number
  bodyRows: number
  visitedElements: number
  truncated: boolean
}

export interface ChatRunningRowEvidence {
  diagnosticOnly: true
  semantics: string
  timeOrigin: number
  mark: { name: string; atMs: number }
  stoppedAtMs: number
  mutationBatches: number
  sampledStates: number
  droppedSamples: number
  droppedScopes: number
  limits: { samples: number; samplesPerScope: number; scopes: number; elementsPerSample: number }
  peaks: {
    mountedRows: ChatRunningRowSample
    pendingRows: ChatRunningRowSample
    bodyNodes: ChatRunningRowSample
  }
  scopes: Array<{
    scopeId: string | null
    sampledStates: number
    maximumMountedRows: number
    maximumPendingRows: number
    maximumBodyNodes: number
    truncatedSamples: number
  }>
  samples: ChatRunningRowSample[]
}

// Serialized into the renderer. Keep imports and outer runtime values out of this function.
function installChatRunningRowProfile({ key }: { key: string }): void {
  type Installed = { stop(): ChatRunningRowEvidence }
  const registry = globalThis as unknown as Record<string, Installed | undefined>
  registry[key]?.stop()
  const markName = "chat-running-profile-start"
  performance.clearMarks(markName)
  const mark = performance.mark(markName)
  const limits = { samples: 512, samplesPerScope: 32, scopes: 32, elementsPerSample: 12000 }
  const samples: ChatRunningRowSample[] = []
  const scopes = new Map<string | null, ChatRunningRowEvidence["scopes"][number]>()
  let mutationBatches = 0
  let sampledStates = 0
  let droppedSamples = 0
  let droppedScopes = 0
  let previous: ChatRunningRowSample | undefined
  let peaks: ChatRunningRowEvidence["peaks"] | undefined
  let stopped: ChatRunningRowEvidence | undefined

  const sample = (trigger: ChatRunningRowSample["trigger"]): void => {
    const root = document.querySelector("[data-chat-thread-id]")
    const viewport = root?.querySelector("[data-radix-scroll-area-viewport]")
    const pendingRows = new Set<Element>()
    const bodyRows = new Set<Element>()
    const reading: ChatRunningRowSample = {
      atMs: performance.now(),
      scopeId: root?.getAttribute("data-chat-thread-id")?.slice(0, 128) ?? null,
      trigger,
      mountedRows: 0,
      pendingRows: 0,
      pendingNodes: 0,
      bodyNodes: 0,
      bodyRows: 0,
      visitedElements: 0,
      truncated: false
    }
    if (viewport) {
      // Traverse only mounted elements. The budget also bounds pathological expanded rows.
      const walker = document.createTreeWalker(viewport, NodeFilter.SHOW_ELEMENT)
      let node = walker.nextNode() as Element | null
      while (node && reading.visitedElements < limits.elementsPerSample) {
        reading.visitedElements++
        if (node.hasAttribute("data-chat-message-row")) reading.mountedRows++
        if (node.hasAttribute("data-function-site-pending")) {
          reading.pendingNodes++
          const row = node.closest("[data-chat-message-row]")
          if (row) pendingRows.add(row)
        }
        if (node.hasAttribute("data-chat-search-text")) {
          reading.bodyNodes++
          const row = node.closest("[data-chat-message-row]")
          if (row) bodyRows.add(row)
        }
        node = walker.nextNode() as Element | null
      }
      reading.truncated = node !== null
    }
    reading.pendingRows = pendingRows.size
    reading.bodyRows = bodyRows.size
    // Character churn and unrelated attribute changes need no duplicate evidence entries.
    if (
      trigger === "mutation" &&
      previous &&
      reading.scopeId === previous.scopeId &&
      reading.mountedRows === previous.mountedRows &&
      reading.pendingRows === previous.pendingRows &&
      reading.pendingNodes === previous.pendingNodes &&
      reading.bodyNodes === previous.bodyNodes &&
      reading.bodyRows === previous.bodyRows &&
      reading.truncated === previous.truncated
    )
      return
    previous = reading
    sampledStates++
    peaks ??= { mountedRows: reading, pendingRows: reading, bodyNodes: reading }
    for (const metric of ["mountedRows", "pendingRows", "bodyNodes"] as const) {
      if (reading[metric] > peaks[metric][metric]) peaks[metric] = reading
    }
    let scope = scopes.get(reading.scopeId)
    if (!scope) {
      if (scopes.size >= limits.scopes) {
        const oldest = scopes.keys().next().value
        if (oldest !== undefined) scopes.delete(oldest)
        droppedScopes++
      }
      scope = {
        scopeId: reading.scopeId,
        sampledStates: 0,
        maximumMountedRows: 0,
        maximumPendingRows: 0,
        maximumBodyNodes: 0,
        truncatedSamples: 0
      }
      scopes.set(reading.scopeId, scope)
    }
    scope.sampledStates++
    scope.maximumMountedRows = Math.max(scope.maximumMountedRows, reading.mountedRows)
    scope.maximumPendingRows = Math.max(scope.maximumPendingRows, reading.pendingRows)
    scope.maximumBodyNodes = Math.max(scope.maximumBodyNodes, reading.bodyNodes)
    scope.truncatedSamples += Number(reading.truncated)
    if (
      samples.filter((item) => item.scopeId === reading.scopeId).length >= limits.samplesPerScope
    ) {
      samples.splice(
        samples.findIndex((item) => item.scopeId === reading.scopeId),
        1
      )
      droppedSamples++
    }
    if (samples.length >= limits.samples) {
      samples.shift()
      droppedSamples++
    }
    samples.push(reading)
  }
  // Observe the stable document root because switching threads replaces the chat subtree.
  // Sampling runs in this observer microtask, before another animation-frame measurement.
  const observer = new MutationObserver(() => {
    mutationBatches++
    sample("mutation")
  })
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-function-site-pending", "data-chat-thread-id", "aria-busy"]
  })
  sample("start")
  registry[key] = {
    stop() {
      if (stopped) return stopped
      observer.disconnect()
      sample("stop")
      performance.clearMarks(markName)
      stopped = {
        diagnosticOnly: true,
        semantics:
          "MutationObserver DOM counts, not paint or authorization evidence. " +
          "Times use renderer performance.now(); truncated counts are lower bounds. " +
          "Profiling adds work and must not be used as formal performance timing.",
        timeOrigin: performance.timeOrigin,
        mark: { name: markName, atMs: mark.startTime },
        stoppedAtMs: performance.now(),
        mutationBatches,
        sampledStates,
        droppedSamples,
        droppedScopes,
        limits,
        peaks: peaks!,
        scopes: [...scopes.values()],
        samples
      }
      return stopped
    }
  }
}

/** Opt-in diagnostics: reads DOM structure only, never message text or layout geometry. */
export async function startChatRunningRowProfile(page: Page): Promise<{
  stop(): Promise<ChatRunningRowEvidence>
}> {
  const key = "__chatRunningRowProfile"
  // tsx keepNames injects __name around local named functions. Supply it lexically
  // while restoring this test-owned source, without modifying renderer globals.
  const installSource = `((__name) => (${installChatRunningRowProfile.toString()}))(value => value)`
  await page.evaluate(
    ({ source, key }) => {
      const install = (0, eval)(source) as (options: { key: string }) => void
      install({ key })
    },
    { source: installSource, key }
  )
  let result: ChatRunningRowEvidence | undefined
  return {
    async stop() {
      if (result) return result
      result = await page.evaluate(
        ({ key }) => {
          const registry = globalThis as unknown as Record<
            string,
            | {
                stop(): ChatRunningRowEvidence
              }
            | undefined
          >
          const installed = registry[key]
          if (!installed) throw new Error("Chat row profiler is not installed in this renderer")
          const evidence = installed.stop()
          delete registry[key]
          return evidence
        },
        { key }
      )
      return result
    }
  }
}
