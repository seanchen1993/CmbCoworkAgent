import type {
  DesignEditableDocument,
  DesignEditableNode,
  DesignEditOperation,
  DesignEditCommand
} from "../../../shared/design-edit"

export interface DesignEditorController {
  update: (document: DesignEditableDocument) => void
  cleanup: () => void
  flush: () => Promise<void>
  editSelected: () => void
  deleteSelected: () => void
  takeCommand: () => Omit<DesignEditCommand, "protocol" | "variationId"> | null
}

/** Stringified into the iframe. All editor DOM lives in a host-owned shadow root. */
export function designDirectEditRuntime(initial: DesignEditableDocument): void {
  if (!document.body) return
  const w = window as unknown as { __designEditor?: DesignEditorController }
  if (w.__designEditor) {
    w.__designEditor.update(initial)
    return
  }
  let config = initial
  let selected: Element | null = null
  let fallbackSelection: Element | null = null
  let hovered: Element | null = null
  let disposed = false
  let composing = false
  let editing: {
    node: DesignEditableNode
    slot: string
    input: HTMLTextAreaElement
    original: string
    revision: number
    tweakRevision?: number
    commandId?: string
  } | null = null
  let pending: {
    id: string
    resolve: () => void
    reject: (error: Error) => void
    promise: Promise<void>
    command: Omit<DesignEditCommand, "protocol" | "variationId">
    timer: number
  } | null = null
  const instance = document.documentElement.dataset.designPreviewInstance
  const root = document.createElement("div")
  root.setAttribute("data-design-host-runtime", "editor")
  root.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483646"
  const shadow = root.attachShadow({ mode: "open" })
  shadow.innerHTML = `<style>
    :host{font:12px system-ui,sans-serif;color:#172033}*{box-sizing:border-box}[hidden]{display:none!important}
    .box{position:fixed;pointer-events:none;border:2px solid #2563eb;z-index:1}.hover{border:1px dashed #60a5fa}
    .tools{position:fixed;display:flex;gap:4px;align-items:center;max-width:calc(100vw - 16px);padding:5px;background:#fff;border:1px solid #cbd5e1;border-radius:7px;box-shadow:0 3px 12px #0002;pointer-events:auto;z-index:3}
    button{font:12px system-ui,sans-serif;border:0;border-radius:4px;background:#f1f5f9;color:#172033;padding:5px 7px;cursor:pointer;white-space:nowrap}button:hover{background:#dbeafe}button:disabled{opacity:.45;cursor:default}
    .label{max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.error{color:#b91c1c;max-width:300px;white-space:normal}
    textarea{position:fixed;pointer-events:auto;z-index:4;resize:none;border:2px solid #2563eb;border-radius:2px;outline:none;padding:2px;background:#fff;box-shadow:0 0 0 2px #fff}
  </style>`
  const box = document.createElement("div"),
    hoverBox = document.createElement("div"),
    tools = document.createElement("div")
  box.className = "box"
  hoverBox.className = "box hover"
  tools.className = "tools"
  box.hidden = hoverBox.hidden = tools.hidden = true
  shadow.append(hoverBox, box, tools)
  document.documentElement.appendChild(root)
  const post = (type: string, payload: object = {}) =>
    window.parent.postMessage(
      {
        type,
        previewInstanceId: instance,
        revision: config.revision,
        tweakRevision: config.tweakRevision,
        ...payload
      },
      "*"
    )
  const nodeId = (el: Element) =>
    el.hasAttribute("data-design-bind")
      ? `b_${el.getAttribute("data-design-bind")}`
      : el.getAttribute("data-design-node")
  const describe = (el: Element | null): DesignEditableNode | undefined => {
    if (!el) return
    const id = nodeId(el)
    const node = config.nodes.find((n) => n.id === id)
    if (!node) return
    const duplicates = [
      ...document.querySelectorAll("[data-design-node],[data-design-bind]")
    ].filter((candidate) => nodeId(candidate) === id)
    return duplicates.length > 1
      ? {
          ...node,
          text: [],
          canDelete: false,
          canStyle: false,
          reason: "重复组件需要实例级数据绑定"
        }
      : node
  }
  const target = (value: EventTarget | null): Element | null => {
    let el = value instanceof Element ? value : null
    while (el && el !== document.documentElement) {
      if (describe(el)) return el
      el = el.parentElement
    }
    return null
  }
  function position(el: Element | null, border: HTMLElement) {
    if (!el?.isConnected) {
      border.hidden = true
      return
    }
    const r = el.getBoundingClientRect()
    border.hidden = false
    border.style.cssText = `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px`
  }
  function refreshPosition() {
    position(selected, box)
    position(hovered, hoverBox)
    if (selected?.isConnected && !tools.hidden) {
      const r = selected.getBoundingClientRect()
      tools.style.left = Math.max(8, Math.min(r.left, innerWidth - tools.offsetWidth - 8)) + "px"
      tools.style.top =
        Math.max(
          4,
          r.top > 42
            ? r.top - tools.offsetHeight - 5
            : Math.min(innerHeight - tools.offsetHeight - 4, r.bottom + 5)
        ) + "px"
    }
  }
  function styles(el: Element) {
    const cs = getComputedStyle(el),
      r = el.getBoundingClientRect()
    const n = (name: string) => parseFloat(cs.getPropertyValue(name)) || 0
    return {
      fontFamily: cs.fontFamily,
      fontSize: n("font-size"),
      fontWeight: cs.fontWeight,
      color: cs.color,
      textAlign: cs.textAlign,
      lineHeight: n("line-height") / (n("font-size") || 1),
      letterSpacing: n("letter-spacing"),
      width: r.width,
      height: r.height,
      opacity: n("opacity"),
      paddingTop: n("padding-top"),
      paddingRight: n("padding-right"),
      paddingBottom: n("padding-bottom"),
      paddingLeft: n("padding-left"),
      marginTop: n("margin-top"),
      marginRight: n("margin-right"),
      marginBottom: n("margin-bottom"),
      marginLeft: n("margin-left"),
      borderWidth: n("border-width"),
      borderRadius: n("border-radius")
    }
  }
  function addButton(label: string, action: () => void, disabled = false) {
    const b = document.createElement("button")
    b.type = "button"
    b.textContent = label
    b.disabled = disabled
    b.addEventListener("mousedown", (e) => e.preventDefault())
    b.addEventListener("click", action)
    tools.appendChild(b)
  }
  function select(el: Element | null) {
    selected = el
    const info = describe(el)
    tools.replaceChildren()
    tools.hidden = !info
    if (info && el) {
      const ancestors: Element[] = []
      let parent = el.parentElement
      while (parent && ancestors.length < 4) {
        if (describe(parent)) ancestors.unshift(parent)
        parent = parent.parentElement
      }
      for (const ancestor of ancestors)
        addButton(describe(ancestor)!.tagName, () => select(ancestor))
      const label = document.createElement("span")
      label.className = "label"
      label.textContent = info.label
      tools.appendChild(label)
      addButton("改文字", () => beginText(), !info.text.length)
      addButton("删除", () => removeSelected(), !info.canDelete)
      if (info.reason) tools.title = info.reason
      post("__design_editor_select", {
        nodeId: info.id,
        tagName: info.tagName,
        styles: styles(el),
        info
      })
    } else post("__design_editor_select", { nodeId: null })
    refreshPosition()
  }
  function issue(op: DesignEditOperation, commandId: string = crypto.randomUUID()): Promise<void> {
    if (pending) return pending.promise
    let resolve!: () => void, reject!: (e: Error) => void
    const promise = new Promise<void>((ok, fail) => {
      resolve = ok
      reject = fail
    })
    const command = {
      commandId,
      baseRevision: editing?.revision ?? config.revision,
      baseTweakRevision: editing?.tweakRevision ?? config.tweakRevision,
      operations: [op]
    }
    const timer = window.setTimeout(() => {
      if (pending?.id !== commandId) return
      pending = null
      if (editing) {
        editing.input.readOnly = false
        editing.input.focus()
      }
      post("__design_editor_error", { error: "保存结果未返回，可重试；已提交的命令不会重复执行" })
      reject(new Error("保存结果未返回"))
    }, 15000)
    pending = { id: commandId, resolve, reject, promise, command, timer }
    post("__design_editor_command", {
      commandId,
      operation: op,
      revision: command.baseRevision,
      tweakRevision: command.baseTweakRevision
    })
    return promise
  }
  function closeText() {
    const item = editing
    editing = null
    item?.input.remove()
    composing = false
  }
  function flush(): Promise<void> {
    if (pending) return pending.promise
    if (!editing) return Promise.resolve()
    const item = editing
    if (item.input.value === item.original) {
      closeText()
      return Promise.resolve()
    }
    item.input.readOnly = true
    item.commandId ??= crypto.randomUUID()
    return issue(
      {
        type: "set_text",
        nodeId: item.node.id,
        expectedHash: item.node.hash,
        textSlotId: item.slot,
        value: item.input.value
      },
      item.commandId
    )
  }
  function beginText(event?: MouseEvent) {
    if (editing || pending || !selected) return
    const info = describe(selected)
    if (!info?.text.length) return
    let slot = info.text[0]
    const textNodes = [...selected.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE)
    if (event && info.text.length > 1)
      for (const n of textNodes) {
        const range = document.createRange()
        range.selectNodeContents(n)
        if (
          [...range.getClientRects()].some(
            (r) =>
              event.clientX >= r.left &&
              event.clientX <= r.right &&
              event.clientY >= r.top &&
              event.clientY <= r.bottom
          )
        )
          slot = info.text.find((t) => t.value.trim() === n.textContent?.trim()) ?? slot
      }
    const input = document.createElement("textarea")
    input.setAttribute("aria-label", "编辑文字")
    input.value = slot.value
    const cs = getComputedStyle(selected),
      r = selected.getBoundingClientRect()
    input.style.cssText = `left:${r.left}px;top:${r.top}px;width:${Math.max(100, r.width)}px;height:${Math.max(36, r.height + 6)}px;font:${cs.font};color:${cs.color};line-height:${cs.lineHeight};letter-spacing:${cs.letterSpacing};text-align:${cs.textAlign}`
    editing = {
      node: info,
      slot: slot.id,
      input,
      original: slot.value,
      revision: config.revision,
      tweakRevision: config.tweakRevision
    }
    input.addEventListener("input", () => {
      if (editing && !pending) editing.commandId = undefined
    })
    input.addEventListener("compositionstart", () => {
      composing = true
    })
    input.addEventListener("compositionend", () => {
      composing = false
    })
    input.addEventListener("keydown", (e) => {
      e.stopPropagation()
      if (e.isComposing || composing || e.keyCode === 229) return
      if (e.key === "Escape") {
        e.preventDefault()
        if (!pending) closeText()
      }
      if (e.key === "Enter" && !(e.shiftKey && slot.multiline)) {
        e.preventDefault()
        void flush().catch(() => undefined)
      }
    })
    input.addEventListener("paste", (e) => {
      e.preventDefault()
      const text = e.clipboardData?.getData("text/plain") ?? ""
      input.setRangeText(text, input.selectionStart, input.selectionEnd, "end")
    })
    input.addEventListener("blur", () => {
      if (editing?.input === input && !pending && !composing) void flush().catch(() => undefined)
    })
    shadow.appendChild(input)
    input.focus()
    input.select()
  }
  function removeSelected() {
    const info = describe(selected)
    if (!info?.canDelete || editing || pending) return
    fallbackSelection = target(selected?.parentElement ?? null)
    void issue({ type: "delete_node", nodeId: info.id, expectedHash: info.hash }).catch(
      () => undefined
    )
  }
  function own(event: Event) {
    return event.composedPath().includes(root)
  }
  function click(event: MouseEvent) {
    if (own(event)) return
    event.preventDefault()
    event.stopImmediatePropagation()
    if (editing) {
      void flush().catch(() => undefined)
      return
    }
    if (!pending) select(target(event.target))
  }
  function doubleClick(event: MouseEvent) {
    if (own(event)) return
    event.preventDefault()
    event.stopImmediatePropagation()
    if (!editing && !pending) {
      select(target(event.target))
      beginText(event)
    }
  }
  function over(event: MouseEvent) {
    if (own(event) || editing) return
    hovered = target(event.target)
    if (hovered === selected) hovered = null
    refreshPosition()
  }
  function keydown(event: KeyboardEvent) {
    if (own(event) || editing || composing) return
    const element = event.target as HTMLElement | null
    if (element?.closest("input,textarea,select,[contenteditable='true']")) return
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault()
      event.stopImmediatePropagation()
      removeSelected()
    }
    if (event.key === "Escape") {
      event.preventDefault()
      select(null)
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
      event.preventDefault()
      event.stopImmediatePropagation()
      post("__design_editor_history", { operation: event.shiftKey ? "redo" : "undo" })
    }
  }
  function submit(event: Event) {
    if (!own(event)) {
      event.preventDefault()
      event.stopImmediatePropagation()
    }
  }
  function message(event: MessageEvent) {
    const m = event.data
    if (
      event.source !== window.parent ||
      m?.previewInstanceId !== instance ||
      m.type !== "__design_editor_result" ||
      m.commandId !== pending?.id
    )
      return
    const item = pending
    pending = null
    if (item) clearTimeout(item.timer)
    if (m.error) {
      if (editing) {
        editing.input.readOnly = false
        editing.input.focus()
      }
      const error = document.createElement("span")
      error.className = "error"
      error.textContent = m.error
      tools.appendChild(error)
      tools.hidden = false
      item?.reject(new Error(m.error))
    } else {
      closeText()
      item?.resolve()
      select(
        selected?.isConnected ? selected : fallbackSelection?.isConnected ? fallbackSelection : null
      )
    }
  }
  document.addEventListener("click", click, true)
  document.addEventListener("dblclick", doubleClick, true)
  document.addEventListener("mouseover", over, true)
  document.addEventListener("keydown", keydown, true)
  document.addEventListener("submit", submit, true)
  window.addEventListener("message", message)
  window.addEventListener("scroll", refreshPosition, true)
  window.addEventListener("resize", refreshPosition)
  const observer = new MutationObserver(() => {
    if (!disposed) refreshPosition()
  })
  observer.observe(document.documentElement, { childList: true, subtree: true })
  w.__designEditor = {
    update(value) {
      if (value.revision < config.revision) return
      if (
        (value.revision !== config.revision || value.tweakRevision !== config.tweakRevision) &&
        editing &&
        !pending
      ) {
        editing.input.readOnly = true
        post("__design_editor_error", { error: "页面版本已变化，请复制输入内容后重新选择" })
      }
      config = value
      if (!editing && !pending)
        select(
          selected?.isConnected
            ? selected
            : fallbackSelection?.isConnected
              ? fallbackSelection
              : null
        )
    },
    flush,
    editSelected: () => beginText(),
    deleteSelected: removeSelected,
    takeCommand() {
      if (pending) return pending.command
      if (!editing || editing.input.value === editing.original) return null
      editing.commandId ??= crypto.randomUUID()
      return {
        commandId: editing.commandId,
        baseRevision: editing.revision,
        baseTweakRevision: editing.tweakRevision,
        operations: [
          {
            type: "set_text",
            nodeId: editing.node.id,
            expectedHash: editing.node.hash,
            textSlotId: editing.slot,
            value: editing.input.value
          }
        ]
      }
    },
    cleanup() {
      disposed = true
      observer.disconnect()
      document.removeEventListener("click", click, true)
      document.removeEventListener("dblclick", doubleClick, true)
      document.removeEventListener("mouseover", over, true)
      document.removeEventListener("keydown", keydown, true)
      document.removeEventListener("submit", submit, true)
      window.removeEventListener("message", message)
      window.removeEventListener("scroll", refreshPosition, true)
      window.removeEventListener("resize", refreshPosition)
      if (pending) {
        clearTimeout(pending.timer)
        pending.reject(new Error("编辑预览已关闭"))
        pending = null
      }
      closeText()
      root.remove()
      delete w.__designEditor
    }
  }
  post("__design_editor_ready")
}
