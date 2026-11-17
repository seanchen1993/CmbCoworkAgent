import { insertDesignBodyScript } from "./design-html-mutations"

/** Host-owned behavior only, installed after removing all source scripts. */
export function designSnapshotRuntime(): void {
  document
    .querySelectorAll<HTMLDialogElement>("dialog[data-design-capture-modal]")
    .forEach((dialog) => {
      if (dialog.matches(":modal")) return
      dialog.removeAttribute("open")
      try {
        dialog.showModal()
      } catch {
        dialog.setAttribute("open", "")
      }
    })
  document.querySelectorAll<HTMLElement>("[data-design-capture-popover]").forEach((popover) => {
    try {
      popover.showPopover()
    } catch {
      // A removed/hidden ancestor may make a captured popover unavailable.
    }
  })
  document.addEventListener("submit", (event) => event.preventDefault(), true)
  document.addEventListener(
    "click",
    (event) => {
      if ((event.target as Element | null)?.closest?.("a[href],area[href]")) event.preventDefault()
    },
    true
  )
}

/** Host-owned DOM replay. Never evaluates captured handlers or source scripts. */
export function installDesignClickPlayback(): void {
  const attr = "data-design-recorded-node"
  const key = (node: Element) => node.getAttribute(attr)
  const find = (id: string | null) =>
    id && /^r_\d+$/.test(id) ? document.querySelector(`[${attr}="${id}"]`) : null
  const steps = [
    ...document.querySelectorAll<HTMLTemplateElement>("template[data-design-interaction]")
  ]
    .map((template) => ({
      trigger: template.getAttribute("data-trigger"),
      event: template.getAttribute("data-event") ?? "click",
      key: template.getAttribute("data-key"),
      value: template.getAttribute("data-value"),
      beforeValue: template.getAttribute("data-beforevalue"),
      before: template.content.querySelector<HTMLTemplateElement>('template[data-state="before"]')
        ?.content.firstElementChild,
      after: template.content.querySelector<HTMLTemplateElement>('template[data-state="after"]')
        ?.content.firstElementChild
    }))
    .filter((step) => step.before && step.after)
  if (!steps.length) return
  const states = steps.flatMap((step) => [step.before!, step.after!]).reverse()

  // Tabs select a recorded destination independently of the tab active at capture time.
  const selectTab = (tab: Element): boolean => {
    const group = tab.closest('[role="tablist"]')
    const groupId = group && key(group)
    const selected = group?.querySelector('[role="tab"][aria-selected="true"]')
    const targetId = key(tab),
      selectedId = selected && key(selected)
    if (!group || !groupId || !targetId || !selectedId) return false
    if (![groupId, targetId, selectedId].every((id) => /^r_\d+$/.test(id))) return false
    const stateFor = (id: string) =>
      states.find((root) => {
        const recordedGroup = root.querySelector(`[${attr}="${groupId}"]`)
        return (
          recordedGroup?.querySelector(`[${attr}="${id}"]`)?.getAttribute("aria-selected") ===
          "true"
        )
      })
    const before = stateFor(selectedId),
      after = stateFor(targetId)
    if (!before || !after) return false
    const beforeGroup = before.querySelector(`[${attr}="${groupId}"]`)!
    const afterGroup = after.querySelector(`[${attr}="${groupId}"]`)!
    const ids = new Set(
      [...group.querySelectorAll('[role="tab"]')].flatMap((item) =>
        (item.getAttribute("aria-controls") ?? "").split(/\s+/).filter(Boolean)
      )
    )
    const regions: Array<[Element, Element, Element]> = [[beforeGroup, afterGroup, group]]
    for (const id of ids) {
      const oldPanel = [...before.querySelectorAll("[id]")].find((node) => node.id === id)
      const panel = [...after.querySelectorAll("[id]")].find((node) => node.id === id)
      const live = document.getElementById(id)
      if (!oldPanel || !panel || !live) return false
      regions.push([oldPanel, panel, live])
    }
    if (!regions.every(([old, next, live]) => patch(old, next, live, false))) return false
    for (const [old, next, live] of regions) patch(old, next, live, true)
    return true
  }

  // Compare/apply only differences between recorded states, preserving editor nodes and edits elsewhere.
  const patch = (
    before: Element,
    after: Element,
    live: Element,
    apply: boolean,
    form = false
  ): boolean => {
    if (before.isEqualNode(after)) return true
    for (const name of new Set(
      [...before.attributes, ...after.attributes].map((item) => item.name)
    )) {
      const oldValue = before.getAttribute(name),
        value = after.getAttribute(name)
      if (oldValue === value || name === attr) continue
      if (
        !apply &&
        live.getAttribute(name) !== oldValue &&
        !(form && ["value", "checked", "selected"].includes(name) && live.matches("input,option"))
      )
        return false
      if (apply) {
        if (value === null) live.removeAttribute(name)
        else live.setAttribute(name, value)
        if (live instanceof HTMLInputElement && name === "value") live.value = value ?? ""
        if (live instanceof HTMLInputElement && name === "checked") live.checked = value !== null
        if (live instanceof HTMLOptionElement && name === "selected") live.selected = value !== null
      }
    }
    const oldChildren = [...before.children],
      children = [...after.children]
    const oldIds = oldChildren.map(key),
      ids = children.map(key)
    for (const old of oldChildren)
      if (!ids.includes(key(old))) {
        const node = find(key(old))
        if (!apply && node?.parentElement !== live) return false
        if (apply) node?.remove()
      }
    for (const child of children) {
      const old = oldChildren.find((node) => key(node) === key(child))
      const node = find(key(child))
      if (old) {
        if (old.isEqualNode(child)) continue
        if (!node || !patch(old, child, node, apply, form)) return false
      } else {
        if (!apply && node) return false
        if (apply) {
          const next = children
            .slice(children.indexOf(child) + 1)
            .map((item) => find(key(item)))
            .find((item) => item?.parentElement === live)
          live.insertBefore(child.cloneNode(true), next ?? null)
        }
      }
    }
    if (
      apply &&
      oldIds.filter((id) => ids.includes(id)).join() !==
        ids.filter((id) => oldIds.includes(id)).join()
    ) {
      let next: Element | null = null
      for (const child of [...children].reverse()) {
        const node = find(key(child))
        if (node?.parentElement === live && (next ? node.nextElementSibling !== next : false))
          live.insertBefore(node, next)
        next = node
      }
    }
    const oldText = [...before.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE)
    const text = [...after.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE)
    if (
      oldText.map((node) => node.textContent).join() !== text.map((node) => node.textContent).join()
    ) {
      const current = [...live.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE)
      if (
        !apply &&
        ![oldText, text].some(
          (nodes) =>
            current.map((node) => node.textContent).join() ===
            nodes.map((node) => node.textContent).join()
        )
      )
        return false
      if (apply) {
        current.forEach((node) => node.remove())
        for (const node of [...after.childNodes])
          if (node.nodeType === Node.TEXT_NODE) {
            const following = [...after.childNodes]
              .slice([...after.childNodes].indexOf(node) + 1)
              .find((item) => item instanceof Element)
            live.insertBefore(
              node.cloneNode(true),
              following instanceof Element ? find(key(following)) : null
            )
          }
        if (live instanceof HTMLTextAreaElement) live.value = after.textContent ?? ""
      }
    }
    return true
  }
  const valueOf = (node: Element): string => {
    if (node instanceof HTMLSelectElement)
      return JSON.stringify([...node.selectedOptions].map((option) => option.value))
    if (node instanceof HTMLInputElement)
      return JSON.stringify(["checkbox", "radio"].includes(node.type) ? node.checked : node.value)
    if (node instanceof HTMLTextAreaElement) return JSON.stringify(node.value)
    return JSON.stringify(node.textContent)
  }
  const replay = (event: Event) => {
    if (document.querySelector("[data-design-editor-mode]")) return
    const path = event.composedPath().filter((node): node is Element => node instanceof Element)
    const control = path[0]?.closest("input,select,textarea,[contenteditable]")
    if (
      control instanceof HTMLInputElement &&
      ["password", "hidden", "file"].includes(control.type)
    )
      return
    const form = ["input", "change"].includes(event.type)
    const value = form && control ? valueOf(control) : null
    const eventKey =
      event instanceof KeyboardEvent
        ? JSON.stringify([event.key, event.ctrlKey, event.metaKey, event.altKey, event.shiftKey])
        : null
    for (const target of path) {
      if (
        event instanceof MouseEvent &&
        ["pointerover", "pointerout"].includes(event.type) &&
        event.relatedTarget instanceof Node &&
        target.contains(event.relatedTarget)
      )
        continue
      if (event.type === "click" && target.matches('[role="tab"]') && selectTab(target)) {
        event.preventDefault()
        break
      }
      let reverse = false
      const step = steps.find((item) => {
        if (
          item.trigger !== key(target) ||
          item.event !== event.type ||
          (event.type === "keydown" && item.key !== eventKey)
        )
          return false
        reverse = form && value === item.beforeValue && value !== item.value
        if (form && value !== item.value && !reverse) return false
        return patch(
          reverse ? item.after! : item.before!,
          reverse ? item.before! : item.after!,
          document.body,
          false,
          form
        )
      })
      if (!step) continue
      if (!(event instanceof KeyboardEvent && event.key === "Tab")) event.preventDefault()
      patch(
        reverse ? step.after! : step.before!,
        reverse ? step.before! : step.after!,
        document.body,
        true,
        form
      )
      document
        .querySelectorAll<HTMLDialogElement>("dialog[data-design-capture-modal]")
        .forEach((dialog) => {
          if (!dialog.matches(":modal")) {
            dialog.removeAttribute("open")
            dialog.showModal()
          }
        })
      document.querySelectorAll<HTMLElement>("[popover]").forEach((popover) => {
        try {
          if (popover.hasAttribute("data-design-capture-popover")) popover.showPopover()
          else popover.hidePopover()
        } catch {
          /* Hidden ancestor. */
        }
      })
      break
    }
  }
  for (const event of [
    "click",
    "dblclick",
    "contextmenu",
    "keydown",
    "input",
    "change",
    "pointerover",
    "pointerout"
  ])
    document.addEventListener(event, replay)
}

const runtimeVersion = "/* design-interaction-runtime-v4 */"

export function installDesignSnapshotRuntime(html: string): string {
  const playback = html.includes('data-design-interaction="click"')
    ? `;${runtimeVersion}(${installDesignClickPlayback.toString()})()`
    : ""
  return insertDesignBodyScript(
    html,
    `(${designSnapshotRuntime.toString()})()${playback}`,
    "data-design-capture-runtime"
  )
}

/** Refresh saved captures without replaying their older embedded host code. */
export function refreshDesignSnapshotRuntime(html: string): string {
  if (
    !html.includes('data-design-interaction="click"') ||
    !html.includes("data-design-capture-runtime") ||
    html.includes(runtimeVersion)
  )
    return html
  return installDesignSnapshotRuntime(html)
}
