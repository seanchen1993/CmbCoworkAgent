import type { DesignInteractionRecordingStatus } from "../../../shared/design-url-import"

export interface DesignClickRecording {
  ids: WeakMap<Element, string>
  steps: Array<{ trigger: string; before: HTMLElement; after: HTMLElement }>
  flush: () => void
  stop: () => void
  status: () => DesignInteractionRecordingStatus
}

/** Runs in the source page. Keep dependencies inside this function for serialization. */
export function controlDesignInteractionRecording(
  action: "start" | "stop" | "clear" | "status"
): DesignInteractionRecordingStatus {
  const host = window as unknown as { __cmbDesignClickRecording?: DesignClickRecording }
  const previous = host.__cmbDesignClickRecording
  if (action === "clear" || action === "start") {
    previous?.stop()
    delete host.__cmbDesignClickRecording
  } else if (action === "stop") previous?.stop()
  if (action !== "start")
    return host.__cmbDesignClickRecording?.status() ?? { recording: false, count: 0 }

  const ids = new WeakMap<Element, string>()
  const locations = new Map<string, { node: Element; id: string }>()
  const steps: DesignClickRecording["steps"] = []
  const url = location.href
  let nextId = 0,
    bytes = 0,
    recording = true,
    message: string | undefined
  let pending:
    | { trigger: string; before: HTMLElement; started: number; index?: number; size?: number }
    | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const id = (node: Element): string => {
    const existing = ids.get(node)
    if (existing) return existing
    const key = node.id
      ? `id:${node.id}`
      : node === document.body
        ? "body"
        : `${node.parentElement ? id(node.parentElement) : "root"}/${node.tagName}/${node.parentElement ? [...node.parentElement.children].indexOf(node) : 0}`
    const slot = locations.get(key)
    const value = slot && !slot.node.isConnected ? slot.id : `r_${++nextId}`
    ids.set(node, value)
    locations.set(key, { node, id: value })
    return value
  }
  const snapshot = (): HTMLElement => {
    const source = [document.body, ...document.body.querySelectorAll("*")]
    if (source.length > 10_000) throw new Error("页面超过 10000 个元素，本次仅抓取静态内容")
    const copy = document.body.cloneNode(true) as HTMLElement
    const targets = [copy, ...copy.querySelectorAll("*")]
    source.forEach((node, index) => {
      const target = targets[index]
      target.setAttribute("data-design-recorded-node", id(node))
      if (node instanceof HTMLInputElement) {
        if (["password", "hidden", "file"].includes(node.type)) target.removeAttribute("value")
        else target.setAttribute("value", node.value)
        target.toggleAttribute("checked", node.checked)
      }
      if (node instanceof HTMLTextAreaElement) target.textContent = node.value
      if (node instanceof HTMLOptionElement) target.toggleAttribute("selected", node.selected)
      if (node instanceof HTMLImageElement) {
        if (node.currentSrc || node.src) target.setAttribute("src", node.currentSrc || node.src)
        for (const attr of ["srcset", "sizes", "loading"]) target.removeAttribute(attr)
      }
      target.toggleAttribute(
        "data-design-capture-modal",
        node instanceof HTMLDialogElement && node.matches(":modal")
      )
      target.toggleAttribute(
        "data-design-capture-popover",
        node.hasAttribute("popover") && node.matches(":popover-open")
      )
    })
    copy.querySelectorAll("script,noscript").forEach((node) => node.remove())
    const root = document.createElement("div")
    for (const attr of [...copy.attributes]) root.setAttribute(attr.name, attr.value)
    root.append(...copy.childNodes)
    return root
  }
  const saveDraft = () => {
    const step = pending
    if (!step) return
    try {
      if (location.href !== url) throw new Error("页面已跳转，请重新录制")
      const after = snapshot()
      step.started = Date.now()
      if (step.before.isEqualNode(after)) {
        if (step.index !== undefined) {
          steps.splice(step.index, 1)
          bytes -= step.size ?? 0
          step.index = undefined
          step.size = 0
        }
        return
      }
      const size = new TextEncoder().encode(step.before.outerHTML + after.outerHTML).byteLength
      if (bytes - (step.size ?? 0) + size > 8 * 1024 * 1024)
        throw new Error("交互记录达到 8MB 上限，请抓取或重新录制")
      // Keep updating the latest click until the next action/stop, including delayed responses.
      step.index ??= steps.length
      steps[step.index] = { trigger: step.trigger, before: step.before, after }
      bytes += size - (step.size ?? 0)
      step.size = size
      if (steps.length >= 8) halt("已记录 8 次页面变化，请抓取或重新录制")
    } catch (error) {
      halt(error instanceof Error ? error.message : "交互录制失败，请重新录制")
    }
  }
  const flush = () => {
    clearTimeout(timer)
    observer.disconnect()
    saveDraft()
    pending = undefined
  }
  const schedule = () => {
    clearTimeout(timer)
    timer = setTimeout(
      saveDraft,
      Math.min(300, Math.max(0, 1500 - (Date.now() - pending!.started)))
    )
  }
  const observer = new MutationObserver(() => {
    if (pending) schedule()
  })
  const halt = (reason?: string) => {
    recording = false
    clearTimeout(timer)
    observer.disconnect()
    pending = undefined
    document.removeEventListener("pointerdown", click, true)
    document.removeEventListener("click", click, true)
    if (reason) message = reason
  }
  const stop = (reason?: string) => {
    flush()
    halt(reason)
  }
  const click = (event: MouseEvent) => {
    if (!recording || !event.isTrusted || event.button !== 0) return
    const target = event.target instanceof Element ? event.target : null
    if (!target) return
    if (target.closest("input,select,textarea")) {
      flush()
      return
    }
    const trigger =
      target.closest('button,a,[role="button"],[role="tab"],[role="option"],summary') ?? target
    // Pointer-driven menus may open before click. Keep their original pre-press state.
    if (event.type === "click" && pending?.trigger === id(trigger)) {
      schedule()
      return
    }
    flush()
    if (!recording) return
    if (location.href !== url) {
      steps.length = 0
      stop("页面已跳转，请重新录制")
      return
    }
    try {
      pending = { trigger: id(trigger), before: snapshot(), started: Date.now() }
      observer.observe(document.body, {
        subtree: true,
        attributes: true,
        childList: true,
        characterData: true
      })
      schedule()
    } catch (error) {
      stop(String(error))
    }
  }
  const status = (): DesignInteractionRecordingStatus => {
    if (location.href !== url) {
      steps.length = 0
      stop("页面已跳转，请重新录制")
    }
    return { recording, count: steps.length, message }
  }
  host.__cmbDesignClickRecording = { ids, steps, flush, stop: () => stop(), status }
  document.addEventListener("pointerdown", click, true)
  document.addEventListener("click", click, true)
  return status()
}

export { installDesignClickPlayback } from "../../../shared/design-capture-runtime"
