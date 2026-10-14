export function isFirstLiveChatUserRow(
  loading: boolean,
  releasedHistory: boolean,
  visibleCount: number,
  firstRole: string | undefined
): boolean {
  return loading && !releasedHistory && visibleCount === 1 && firstRole === "user"
}

/** Presentation only: never changes site authorization, data or scrolling. */
export interface InitialChatPresentationSample {
  ready: boolean
  geometry: string
}

export function startInitialChatPresentation(options: {
  sample(): InitialChatPresentationSample
  reveal(): void
  requestFrame(callback: () => void): number
  cancelFrame(id: number): void
  setDeadline(callback: () => void, milliseconds: number): ReturnType<typeof setTimeout>
  clearDeadline(id: ReturnType<typeof setTimeout>): void
  now?(): number
  isVisible?(): boolean
}): { reveal(): void; visibilityChanged(): void; dispose(): void } {
  let stopped = false
  let frame: number | undefined
  let deadline: ReturnType<typeof setTimeout> | undefined
  let previous: string | undefined
  let stable = 0
  let remaining = 1500
  const now = options.now ?? (() => performance.now())
  const isVisible = options.isVisible ?? (() => true)
  let active = isVisible()
  let startedAt = now()
  let resumedFrames = 3
  let expired = false
  const clear = (): void => {
    if (frame !== undefined) options.cancelFrame(frame)
    if (deadline !== undefined) options.clearDeadline(deadline)
    frame = undefined
    deadline = undefined
  }
  const reveal = (): void => {
    if (stopped) return
    stopped = true
    clear()
    options.reveal()
  }
  const visibilityChanged = (): void => {
    if (stopped) return
    const visible = isVisible()
    if (active === visible) return
    if (active) remaining = Math.max(0, remaining - (now() - startedAt))
    active = visible
    clear()
    previous = undefined
    stable = 0
    if (active) {
      resumedFrames = 0
      schedule()
    }
  }
  const poll = (): void => {
    frame = undefined
    if (stopped) return
    if (!isVisible()) {
      visibilityChanged()
      return
    }
    resumedFrames++
    const sample = options.sample()
    stable = sample.ready && sample.geometry === previous ? stable + 1 : 0
    previous = sample.ready ? sample.geometry : undefined
    // Restore must get two complete foreground frame intervals even if its budget expired.
    if ((sample.ready && stable >= 2) || (expired && resumedFrames >= 3)) {
      reveal()
      return
    }
    frame = options.requestFrame(poll)
  }
  const schedule = (): void => {
    startedAt = now()
    deadline = options.setDeadline(() => {
      deadline = undefined
      if (stopped) return
      if (!isVisible()) {
        visibilityChanged()
        return
      }
      remaining = 0
      expired = true
      // A timer is not a paint opportunity (Electron can report visible while minimized).
      // Leave publication to the next foreground animation frame.
    }, remaining)
    frame = options.requestFrame(poll)
  }
  // Background time never consumes the foreground escape budget.
  if (active) schedule()
  return {
    reveal,
    visibilityChanged,
    dispose() {
      if (stopped) return
      stopped = true
      clear()
    }
  }
}

export function sampleInitialChatPresentation(
  root: HTMLElement,
  viewport: HTMLElement
): InitialChatPresentationSample {
  const view = root.ownerDocument.defaultView
  if (!view) return { ready: false, geometry: "" }
  const bounds = viewport.getBoundingClientRect()
  const geometry: unknown[] = [viewport.scrollTop, viewport.scrollHeight, viewport.clientHeight]
  let count = 0
  let ready = true
  for (const site of root.querySelectorAll<HTMLElement>(
    '[data-function-site="UserMessage"], [data-function-site="AssistantMessage"], [data-function-site="CommandOutput"]'
  )) {
    let box = site.getBoundingClientRect()
    if (box.width <= 0 || box.height <= 0) {
      const range = root.ownerDocument.createRange()
      range.selectNodeContents(site)
      box = range.getBoundingClientRect()
      range.detach()
    }
    // Overscan sites are not part of this presentation barrier.
    if (box.bottom <= bounds.top || box.top >= bounds.bottom || box.width <= 0 || box.height <= 0)
      continue
    count++
    geometry.push(box.x, box.y, box.width, box.height, site.dataset.functionSite)
    if (site.querySelector("[data-function-site-pending]")) ready = false
    let element: HTMLElement | null = site
    while (element && element !== viewport) {
      const style = view.getComputedStyle(element)
      if (style.visibility === "hidden" || style.display === "none") ready = false
      element = element.parentElement
    }
  }
  // System/tool/hook rows legitimately bypass FunctionSite. They must not pay the stall deadline.
  for (const row of root.querySelectorAll<HTMLElement>("[data-item-index]")) {
    if (row.querySelector("[data-function-site]")) continue
    const box = row.getBoundingClientRect()
    if (
      box.bottom <= bounds.top ||
      box.top >= bounds.bottom ||
      box.width <= 0 ||
      box.height <= 0 ||
      !row.textContent?.trim()
    )
      continue
    count++
    geometry.push("native-row", box.x, box.y, box.width, box.height)
    let element: HTMLElement | null = row
    while (element && element !== viewport) {
      const style = view.getComputedStyle(element)
      if (style.visibility === "hidden" || style.display === "none") ready = false
      element = element.parentElement
    }
  }
  return { ready: ready && count > 0, geometry: JSON.stringify(geometry) }
}
