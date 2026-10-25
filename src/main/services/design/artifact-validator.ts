export interface DesignLayoutProbe {
  horizontalOverflow: string[]
  styles: Record<string, string[]>
  expectations: string[]
}
export function withDesignValidationDeadline<T>(
  work: Promise<T>,
  signal: AbortSignal,
  timeoutMs = 8000
): Promise<T> {
  return new Promise((resolve, reject) => {
    const finish = (action: () => void) => {
      clearTimeout(timer)
      signal.removeEventListener("abort", abort)
      action()
    }
    const abort = () => finish(() => reject(new Error("局部校验已取消")))
    const timer = setTimeout(() => finish(() => reject(new Error("局部校验超时"))), timeoutMs)
    work.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error))
    )
    if (signal.aborted) abort()
    else signal.addEventListener("abort", abort, { once: true })
  })
}
export interface DesignStyleCheck {
  targetId: string
  property: string
  value: string
  state?: string
  maxWidth?: number
}
interface DesignStyleBrowser {
  executeJavaScript(code: string): Promise<unknown>
  debugger: {
    isAttached(): boolean
    attach(version: string): void
    detach(): void
    sendCommand(method: string, params?: object): Promise<unknown>
  }
}
export async function inspectDesignPatchStyles(
  browser: DesignStyleBrowser,
  checks: DesignStyleCheck[],
  width: number
): Promise<string[]> {
  const inspect = async (items: DesignStyleCheck[]) =>
    (await browser.executeJavaScript(
      `(${designPatchStyleProbe.toString()})(${JSON.stringify(items)})`
    )) as string[]
  const active = checks.filter((c) => !c.maxWidth || width <= c.maxWidth)
  const issues = await inspect(active.filter((c) => !c.state))
  let attached = false
  try {
    for (const check of active.filter((c) => c.state)) {
      const selector = `[data-design-node="${check.targetId}"]`
      let previous: unknown
      let nodeId: number | undefined
      try {
        if (check.state === "disabled")
          previous = await browser.executeJavaScript(
            `(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw Error('缺少状态目标');const previous=el.getAttribute('disabled');el.setAttribute('disabled','');return previous})()`
          )
        else {
          if (!browser.debugger.isAttached()) {
            browser.debugger.attach("1.3")
            attached = true
          }
          await browser.debugger.sendCommand("DOM.enable")
          await browser.debugger.sendCommand("CSS.enable")
          const document = (await browser.debugger.sendCommand("DOM.getDocument", {
            depth: 0
          })) as { root: { nodeId: number } }
          const found = (await browser.debugger.sendCommand("DOM.querySelector", {
            nodeId: document.root.nodeId,
            selector
          })) as { nodeId: number }
          nodeId = found.nodeId
          if (!nodeId) throw new Error("缺少状态目标")
          await browser.debugger.sendCommand("CSS.forcePseudoState", {
            nodeId,
            forcedPseudoClasses:
              check.state === "focus-visible" ? ["focus", "focus-visible"] : [check.state]
          })
        }
        issues.push(...(await inspect([{ ...check, state: undefined }])))
      } finally {
        if (nodeId)
          await browser.debugger.sendCommand("CSS.forcePseudoState", {
            nodeId,
            forcedPseudoClasses: []
          })
        if (check.state === "disabled")
          await browser.executeJavaScript(
            `(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(el){${previous === null || previous === undefined ? "el.removeAttribute('disabled')" : `el.setAttribute('disabled',${JSON.stringify(previous)})`}}})()`
          )
      }
    }
  } finally {
    if (attached) browser.debugger.detach()
  }
  return issues
}
export function designPatchStyleProbe(checks: DesignStyleCheck[]): string[] {
  const issues: string[] = []
  for (const check of checks) {
    if (check.state || (check.maxWidth && innerWidth > check.maxWidth)) continue
    const el = [...document.querySelectorAll<HTMLElement>("[data-design-node]")].find(
      (n) => n.dataset.designNode === check.targetId
    )
    if (!el) {
      issues.push(`缺少样式目标：${check.targetId}`)
      continue
    }
    const computed = getComputedStyle(el)
    const missing = [...check.value.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)].find(
      (match) => !computed.getPropertyValue(match[1]).trim()
    )
    if (missing) {
      issues.push(`样式变量未定义：${missing[1]}`)
      continue
    }
    const actual = computed.getPropertyValue(check.property)
    const probe = document.createElement(el.tagName)
    for (const property of [...computed])
      probe.style.setProperty(property, computed.getPropertyValue(property), "important")
    probe.style.setProperty(
      check.property,
      check.value.replace(/\s*!important\s*$/, ""),
      "important"
    )
    el.parentElement!.appendChild(probe)
    const expected = getComputedStyle(probe).getPropertyValue(check.property)
    probe.remove()
    if (actual !== expected)
      issues.push(
        `样式未实际生效：${check.targetId} ${check.property}，可能被 inline 或 !important 覆盖`
      )
  }
  return issues
}

/** Executed in a complete hidden document; comparison excludes authorized descendants. */
export function designPatchLayoutProbe(): DesignLayoutProbe {
  const horizontalOverflow: string[] = []
  const styles: Record<string, string[]> = {}
  for (const el of [...document.querySelectorAll<HTMLElement>("[data-design-node]")]) {
    const id = el.dataset.designNode!
    const s = getComputedStyle(el)
    if (s.display === "none") continue
    if (
      el.clientWidth > 0 &&
      el.scrollWidth > el.clientWidth + 3 &&
      ["visible", "clip"].includes(s.overflowX)
    )
      horizontalOverflow.push(id)
    const box = el.getBoundingClientRect(),
      parentBox = el.parentElement?.getBoundingClientRect()
    if (
      parentBox &&
      parentBox.width > 0 &&
      parentBox.height > 0 &&
      !["fixed", "absolute"].includes(s.position) &&
      (box.right > parentBox.right + 3 ||
        box.bottom > parentBox.bottom + 3 ||
        box.left < parentBox.left - 3)
    )
      horizontalOverflow.push(`parent:${id}`)
    styles[id] = [
      s.color,
      s.backgroundColor,
      s.fontFamily,
      s.fontSize,
      s.borderRadius,
      s.display,
      s.position
    ]
  }
  if (document.documentElement.scrollWidth > window.innerWidth + 3)
    horizontalOverflow.push("document")
  return { horizontalOverflow, styles, expectations: [] }
}

export function compareDesignPatchLayouts(
  before: DesignLayoutProbe,
  after: DesignLayoutProbe,
  allowed: Set<string>
): string[] {
  const issues: string[] = []
  for (const id of after.horizontalOverflow)
    if (!before.horizontalOverflow.includes(id)) issues.push(`修改产生横向溢出：${id}`)
  for (const [id, values] of Object.entries(after.styles)) {
    if (!allowed.has(id) && before.styles[id] && values.join("|") !== before.styles[id].join("|"))
      issues.push(`修改影响了目标范围外的样式：${id}`)
  }
  return [...issues, ...after.expectations].slice(0, 12)
}
