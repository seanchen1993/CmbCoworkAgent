import type { DesignInteractionRecordingStatus } from "../../../shared/design-url-import"
import type { WebContents } from "electron"

type RecordingAction = "start" | "stop" | "clear" | "status"

/** Match the frame/depth limits of static capture, including cross-origin frames. */
export async function controlDesignFrameInteractionRecording(
  contents: WebContents,
  action: RecordingAction
): Promise<DesignInteractionRecordingStatus> {
  const code = `(${controlDesignInteractionRecording.toString()})(${JSON.stringify(action)})`
  const children = contents.mainFrame.framesInSubtree
    .filter((frame) => {
      let depth = 0
      for (let parent = frame.parent; parent; parent = parent.parent) depth++
      return frame !== contents.mainFrame && depth <= 4
    })
    .slice(0, 32)
  const statuses: DesignInteractionRecordingStatus[] = await Promise.all([
    contents.executeJavaScript(code),
    ...children.map((frame) =>
      frame.executeJavaScript(code).catch(() => ({
        recording: false,
        count: 0,
        message: "部分嵌入页面无法录制，请在页面加载完成后重新录制。"
      }))
    )
  ])
  return {
    recording: statuses.some((status) => status.recording),
    count: statuses.reduce((count, status) => count + status.count, 0),
    message:
      [...new Set(statuses.flatMap((status) => (status.message ? [status.message] : [])))].join(
        " "
      ) || undefined
  }
}

export interface DesignClickRecording {
  ids: WeakMap<Element, string>
  steps: Array<{
    trigger: string
    event?: string
    key?: string
    value?: string
    beforeValue?: string
    before: HTMLElement
    after: HTMLElement
  }>
  flush: () => void
  stop: () => void
  status: () => DesignInteractionRecordingStatus
}

/** Runs in the source page. Keep dependencies inside this function for serialization. */
export function controlDesignInteractionRecording(
  action: RecordingAction
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
  const maxSteps = 50
  const url = location.href
  let nextId = 0,
    bytes = 0,
    recording = true,
    message: string | undefined
  let pending:
    | (Omit<DesignClickRecording["steps"][number], "after"> & {
        started: number
        index?: number
        size?: number
        hoverState?: string
        saved?: boolean
      })
    | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const events = [
    "pointerdown",
    "click",
    "dblclick",
    "contextmenu",
    "keydown",
    "beforeinput",
    "input",
    "change",
    "pointerover",
    "pointerout"
  ]
  const valueOf = (node: Element, saved = false): string => {
    if (node instanceof HTMLSelectElement)
      return JSON.stringify(
        [...node.options]
          .filter((option) => (saved ? option.hasAttribute("selected") : option.selected))
          .map((option) => option.value)
      )
    if (node instanceof HTMLInputElement) {
      if (["checkbox", "radio"].includes(node.type))
        return JSON.stringify(saved ? node.hasAttribute("checked") : node.checked)
      return JSON.stringify(saved ? (node.getAttribute("value") ?? "") : node.value)
    }
    if (node instanceof HTMLTextAreaElement)
      return JSON.stringify(saved ? node.textContent : node.value)
    return JSON.stringify(node.textContent)
  }
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
      if (node instanceof HTMLStyleElement && node.sheet) {
        try {
          target.textContent = [...node.sheet.cssRules].map((rule) => rule.cssText).join("\n")
          if (node.sheet.disabled) target.setAttribute("media", "not all")
        } catch {
          // Retain the source text when CSSOM is unavailable.
        }
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
    copy.querySelectorAll("script,noscript,[data-sites-widget]").forEach((node) => node.remove())
    const root = document.createElement("div")
    for (const attr of [...copy.attributes]) root.setAttribute(attr.name, attr.value)
    root.append(...copy.childNodes)
    return root
  }
  // Hover decoration alone is not a replayable action; retain visible content/state changes.
  const hoverState = (): string => JSON.stringify(
    [document.body, ...document.body.querySelectorAll("*")].flatMap((node) => {
      if (node.closest("[data-sites-widget]") || node.matches('script,style,noscript,template,input[type="password"],input[type="hidden"],input[type="file"]')) return []
      const style = getComputedStyle(node), box = node.getBoundingClientRect()
      if (style.visibility !== "visible" || Number(style.opacity) === 0 || box.width <= 0 || box.height <= 0) return []
      return [[
        id(node),
        [...node.childNodes].filter((child) => child.nodeType === Node.TEXT_NODE)
          .map((child) => child.textContent?.replace(/\s+/g, " ").trim()).join(""),
        node instanceof HTMLInputElement || node instanceof HTMLSelectElement || node instanceof HTMLTextAreaElement
          ? valueOf(node) : null,
        node.getAttribute("aria-expanded"),
        node.getAttribute("aria-selected"),
        node.matches('dialog:modal,[popover]:popover-open')
      ]]
    })
  )
  const saveDraft = () => {
    const step = pending
    if (!step) return
    try {
      if (location.href !== url) throw new Error("页面已跳转，请重新录制")
      const after = snapshot()
      step.saved = true
      step.started = Date.now()
      if (step.before.isEqualNode(after) ||
        (step.hoverState !== undefined && step.hoverState === hoverState())) {
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
      // Keep updating the latest action until the next action/stop, including delayed responses.
      step.index ??= steps.length
      const control = after.querySelector(`[data-design-recorded-node="${step.trigger}"]`)
      steps[step.index] = {
        trigger: step.trigger,
        event: step.event,
        key: step.key,
        beforeValue: step.beforeValue,
        value:
          control && ["input", "change"].includes(step.event ?? "")
            ? valueOf(control, true)
            : undefined,
        before: step.before,
        after
      }
      bytes += size - (step.size ?? 0)
      step.size = size
      if (steps.length >= maxSteps) {
        // Stop accepting actions, but let the final action finish its delayed DOM updates.
        recording = false
        message = `已记录 ${maxSteps} 次页面变化，请抓取或重新录制`
      }
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
    for (const event of events) document.removeEventListener(event, capture, true)
    if (reason) message = reason
  }
  const stop = (reason?: string) => {
    flush()
    halt(reason)
  }
  const capture = (event: Event) => {
    if (!event.isTrusted) return
    if (!recording) {
      if (pending) stop()
      return
    }
    if (
      event instanceof MouseEvent &&
      !["pointerover", "pointerout", "contextmenu"].includes(event.type) &&
      event.button !== 0
    )
      return
    const target = event.composedPath().find((node): node is Element => node instanceof Element)
    if (!target) return
    if (event.composedPath().some((node) => node instanceof Element && node.matches("[data-sites-widget]"))) return
    const label = target.closest("label") as HTMLLabelElement | null
    const control = target.closest("input,select,textarea,[contenteditable]") ?? label?.control
    if (
      control instanceof HTMLInputElement &&
      ["password", "hidden", "file"].includes(control.type)
    ) {
      flush()
      return
    }
    const formEvent =
      control instanceof HTMLSelectElement ||
      (control instanceof HTMLInputElement &&
        !["text", "search", "email", "url", "tel", "number", "button", "submit", "reset"].includes(
          control.type
        ))
        ? "change"
        : "input"
    let type =
      event.type === "pointerdown" ? "click" : event.type === "beforeinput" ? "input" : event.type
    if (event.type === "change" && formEvent === "input") return
    if (event instanceof KeyboardEvent) {
      if (event.isComposing || ["Shift", "Control", "Alt", "Meta"].includes(event.key)) return
      if (control && !["Escape", "Enter", "Tab"].includes(event.key)) type = formEvent
    }
    if (["input", "change"].includes(type)) type = formEvent
    const trigger =
      control ??
      target.closest('button,a,[role="button"],[role="tab"],[role="option"],summary') ??
      target
    if (
      event instanceof MouseEvent &&
      ["pointerover", "pointerout"].includes(type) &&
      event.relatedTarget instanceof Node &&
      trigger.contains(event.relatedTarget)
    )
      return
    const triggerId = id(trigger)
    // A dialog can emit boundary events before its close/focus handlers finish.
    if (["pointerover", "pointerout"].includes(type) && pending && !pending.saved &&
      !["pointerover", "pointerout"].includes(pending.event ?? "")) {
      schedule()
      return
    }
    // Pointer-driven menus may open before click. Keep their original pre-press state.
    if (
      pending?.trigger === triggerId &&
      ((event.type === "click" && pending.event === "click") ||
        (["input", "change"].includes(type) &&
          ["click", "input", "change"].includes(pending.event ?? "") &&
          (["input", "change"].includes(event.type) ||
            (type === "input" && pending.index === undefined))))
    ) {
      if (["input", "change"].includes(type)) {
        pending.event = type
        const before = pending.before.querySelector(`[data-design-recorded-node="${triggerId}"]`)
        if (before) pending.beforeValue = valueOf(before, true)
      }
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
      const before = snapshot()
      const saved = before.querySelector(`[data-design-recorded-node="${triggerId}"]`)
      pending = {
        trigger: triggerId,
        event: type,
        before,
        hoverState: ["pointerover", "pointerout"].includes(type) ? hoverState() : undefined,
        started: Date.now(),
        key:
          event instanceof KeyboardEvent && type === "keydown"
            ? JSON.stringify([
                event.key,
                event.ctrlKey,
                event.metaKey,
                event.altKey,
                event.shiftKey
              ])
            : undefined,
        beforeValue: saved && ["input", "change"].includes(type) ? valueOf(saved, true) : undefined
      }
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
  for (const event of events) document.addEventListener(event, capture, true)
  return status()
}

export { installDesignClickPlayback } from "../../../shared/design-capture-runtime"
