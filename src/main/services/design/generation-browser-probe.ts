import type { DesignBrowserValidationIssue } from "./browser-validation-feedback"

/** Stringified into the hidden browser. Keep this function closure-free. */
export async function designGenerationBrowserProbe(): Promise<DesignBrowserValidationIssue[]> {
  const issues: DesignBrowserValidationIssue[] = []
  const declaration = document.querySelector('script[type="application/design-tweaks+json"]')
  let config: {
    defaults?: Record<string, unknown>
    bindings?: Record<string, Array<{ type: string; name?: string }>>
  } = {}
  try {
    config = JSON.parse(declaration?.textContent ?? "{}")
  } catch {
    /* Source validation reports malformed JSON. */
  }
  const declarations: Array<{
    selector: string
    element: Element | null
    style: CSSStyleDeclaration
  }> = []
  const visit = (rules: CSSRuleList) => {
    for (const rule of Array.from(rules)) {
      if ("style" in rule && "selectorText" in rule) {
        const styled = rule as CSSStyleRule
        let element: Element | null = null
        try {
          element = document.querySelector(styled.selectorText)
        } catch {
          /* Pseudo-elements cannot be selected. */
        }
        if (element)
          declarations.push({ selector: styled.selectorText, element, style: styled.style })
      }
      if ("cssRules" in rule) visit((rule as CSSGroupingRule).cssRules)
    }
  }
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      visit(sheet.cssRules)
    } catch {
      /* Cross-origin stylesheets are not inspectable. */
    }
  }
  for (const element of Array.from(document.querySelectorAll<HTMLElement>("[style]")))
    declarations.push({
      selector: element.id ? `#${CSS.escape(element.id)}` : element.tagName.toLowerCase(),
      element,
      style: element.style
    })
  const seen = new Set<string>()
  for (const [key, bindings] of Object.entries(config.bindings ?? {})) {
    if (issues.length >= 8) break
    if (typeof config.defaults?.[key] !== "number" || !Array.isArray(bindings)) continue
    for (const binding of bindings) {
      if (issues.length >= 8) break
      if (binding.type !== "css-var" || !binding.name) continue
      for (const item of declarations) {
        // Pending var() substitutions can leave shorthand longhands empty in CSSOM.
        const properties = new Set([
          ...Array.from(item.style),
          ...Array.from(item.style.cssText.matchAll(/(?:^|;)\s*([-\w]+)\s*:/g), (match) => match[1])
        ])
        for (const property of properties) {
          if (property.startsWith("--")) continue
          const value = item.style.getPropertyValue(property)
          if (!value.includes(binding.name)) continue
          const computed = getComputedStyle(item.element!)
          let resolved = value
          for (let i = 0; i < 5 && resolved.includes("var("); i++) {
            const next = resolved.replace(
              /var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*))?\)/g,
              (original, name: string, fallback?: string) =>
                computed.getPropertyValue(name).trim() || fallback || original
            )
            if (next === resolved) break
            resolved = next
          }
          if (resolved.includes("var(") || CSS.supports(property, resolved)) continue
          const identity = `${key}:${item.selector}:${property}`
          if (seen.has(identity)) continue
          seen.add(identity)
          issues.push({
            type: "style",
            selector: item.selector,
            message: `Tweaks 参数 ${key} 的 ${binding.name} 使 ${item.selector} 的 ${property}: ${value} 无效（实际值 ${resolved}）。长度参数请在绑定中声明 px/rem 等单位；无单位的比例值保留原单位。`
          })
          if (issues.length >= 8) break
        }
        if (issues.length >= 8) break
      }
    }
  }

  const controls: HTMLElement[] = []
  const groups = new Set<Element>()
  for (const tab of Array.from(
    document.querySelectorAll<HTMLElement>('[role="tab"][aria-selected="false"]')
  )) {
    if (
      !tab.getClientRects().length ||
      tab.matches(":disabled") ||
      tab.closest("form") ||
      tab.hasAttribute("href") ||
      (tab instanceof HTMLButtonElement && tab.form)
    )
      continue
    const group = tab.closest('[role="tablist"]') ?? tab.parentElement!
    if (groups.has(group)) continue
    groups.add(group)
    controls.push(tab)
    if (controls.length === 3) break
  }
  let action = ""
  let interactionFailed = false
  const onError = (event: ErrorEvent) => {
    if (!action) return
    interactionFailed = true
    issues.push({
      type: "interaction",
      selector: action,
      message: `点击 ${action} 后报错：${event.message}`,
      source: event.filename,
      line: event.lineno,
      column: event.colno,
      stack: event.error?.stack
    })
  }
  window.addEventListener("error", onError)
  try {
    for (const control of controls) {
      if (!control.isConnected) continue
      const group = control.closest('[role="tablist"]') ?? control.parentElement!
      const index = Array.from(group.querySelectorAll('[role="tab"]')).indexOf(control)
      action = control.id
        ? `#${CSS.escape(control.id)}`
        : `${group.id ? `#${CSS.escape(group.id)} ` : ""}[role="tab"]:nth-of-type(${index + 1})`
      control.click()
      await new Promise((resolve) => setTimeout(resolve, 50))
      if (interactionFailed) break
      if (control.isConnected && control.getAttribute("aria-selected") === "false")
        issues.push({
          type: "interaction",
          selector: action,
          message: `点击 ${action} 后 aria-selected 仍为 false，请修复该切换控件的事件和状态更新。`
        })
    }
  } finally {
    window.removeEventListener("error", onError)
  }
  return issues
}
