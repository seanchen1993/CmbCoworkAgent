import type { DesignImportWarning } from "../../../shared/design-url-import"

export interface CapturedPageSnapshot {
  html: string
  title: string
  url: string
  textLength: number
  restrictedReason?: string
  warnings: DesignImportWarning[]
}

/** Executed in an isolated world. All helpers must remain inside this function. */
export async function extractDesignPageSnapshot(): Promise<CapturedPageSnapshot> {
  const warnings: DesignImportWarning[] = []
  const warn = (code: string, message: string) => {
    if (!warnings.some((item) => item.code === code)) warnings.push({ code, message })
  }
  const text = document.body?.innerText.trim() ?? ""
  const visible = (element: Element) => element.getClientRects().length > 0
  let restrictedReason: string | undefined
  if ([...document.querySelectorAll('input[type="password"]')].some(visible))
    restrictedReason = "页面包含登录表单，请完成登录后抓取当前页，或明确选择还原此页面。"
  if (
    [
      ...document.querySelectorAll('iframe[src*="captcha"], [class*="captcha"], [id*="captcha"]')
    ].some(visible) ||
    /^(验证您是真人|请完成安全验证|verify you are human|checking your browser)/i.test(text)
  )
    restrictedReason = "页面需要验证码或安全验证，请在内置浏览器中完成后继续。"
  if (
    text.length < 1500 &&
    /access denied|403 forbidden|拒绝访问|无权访问|没有访问权限/i.test(text)
  )
    restrictedReason = "页面拒绝访问，请检查内置浏览器中的登录状态和页面权限。"

  const absoluteCss = (css: string, base: string) =>
    css.replace(
      /url\(\s*(?:"([^"]*)"|'([^']*)'|([^"')]*?))\s*\)/gi,
      (whole, a: string, b: string, c: string) => {
        const value = (a ?? b ?? c ?? "").trim()
        if (!value || value.startsWith("#") || /^data:/i.test(value)) return whole
        try {
          return `url(${JSON.stringify(new URL(value, base).href)})`
        } catch {
          return "none"
        }
      }
    )
  const sourceNodes = [document.documentElement, ...document.documentElement.querySelectorAll("*")]
  if (sourceNodes.length > 30_000) throw new Error("页面超过 30000 个元素，请缩小页面内容后重试")
  const clone = document.documentElement.cloneNode(true) as HTMLElement
  const clonedNodes = [clone, ...clone.querySelectorAll("*")]
  const extraStyles: string[] = []
  const captureOpenLayer = (source: Element, target: Element) => {
    // Top-layer state is not represented by cloneNode or outerHTML.
    target.toggleAttribute(
      "data-design-capture-modal",
      source instanceof HTMLDialogElement && source.matches(":modal")
    )
    target.toggleAttribute(
      "data-design-capture-popover",
      source.hasAttribute("popover") && source.matches(":popover-open")
    )
  }
  const captureSheet = (sheet: CSSStyleSheet, target: Element) => {
    try {
      const css = absoluteCss(
        [...sheet.cssRules].map((rule) => rule.cssText).join("\n"),
        sheet.href || document.baseURI
      )
      const style = document.createElement("style")
      style.textContent = css.replace(/<\/style/gi, "\\3c /style")
      if (sheet.media.mediaText) style.media = sheet.media.mediaText
      if (sheet.disabled) style.media = "not all"
      target.replaceWith(style)
    } catch {
      // Cross-origin link remains intact for authenticated resource collection.
      if (target.tagName === "STYLE")
        warn("stylesheet", "部分动态样式无法读取，已尽量保留来源样式。")
    }
  }
  for (let i = 0; i < sourceNodes.length; i++) {
    const source = sourceNodes[i],
      target = clonedNodes[i]
    captureOpenLayer(source, target)
    if (source instanceof HTMLStyleElement || source instanceof HTMLLinkElement) {
      if (source.sheet) captureSheet(source.sheet as CSSStyleSheet, target)
    }
    if (source instanceof HTMLInputElement) {
      if (["password", "file", "hidden"].includes(source.type)) target.removeAttribute("value")
      else target.setAttribute("value", source.value)
      target.toggleAttribute("checked", source.checked)
    }
    if (source instanceof HTMLTextAreaElement) target.textContent = source.value
    if (source instanceof HTMLOptionElement) target.toggleAttribute("selected", source.selected)
    if (source instanceof HTMLImageElement) {
      if (source.currentSrc || source.src)
        target.setAttribute("src", source.currentSrc || source.src)
      target.removeAttribute("srcset")
      target.removeAttribute("sizes")
      target.removeAttribute("loading")
    }
    if (source instanceof HTMLCanvasElement) {
      try {
        const image = document.createElement("img")
        for (const attr of [...target.attributes]) image.setAttribute(attr.name, attr.value)
        image.src = source.toDataURL()
        image.style.width = getComputedStyle(source).width
        image.style.height = getComputedStyle(source).height
        target.replaceWith(image)
        warn("canvas", "Canvas 已保存为图片，可编辑图片位置和尺寸。")
      } catch {
        warn("canvas_unreadable", "部分 Canvas 无法读取，已保留其布局占位。")
      }
    }
    if (
      source instanceof HTMLIFrameElement ||
      source instanceof HTMLObjectElement ||
      source instanceof HTMLEmbedElement
    ) {
      const placeholder = document.createElement("div")
      const computed = getComputedStyle(source)
      placeholder.style.cssText = `width:${computed.width};height:${computed.height};background:#f2f2f2;color:#666;display:grid;place-items:center;overflow:hidden`
      placeholder.textContent = "嵌入内容"
      target.replaceWith(placeholder)
      warn("embedded_content", "嵌入页面和插件内容已使用布局占位，未复制其业务交互。")
    }
  }
  // Flatten open shadow trees. Inline computed styles preserve scoped styling.
  let shadowNodes = 0
  const copyShadow = (source: Element, target: Element, depth: number) => {
    if (depth > 8) {
      warn("shadow_depth", "部分深层组件未能完整提取。")
      return
    }
    if (source.shadowRoot) {
      target.replaceChildren(
        ...[...source.shadowRoot.childNodes].map((node) => node.cloneNode(true))
      )
      const originals = [...source.shadowRoot.querySelectorAll("*")]
      shadowNodes += originals.length
      if (shadowNodes > 5000) throw new Error("组件内部元素过多，请缩小页面范围后重试")
      const copies = [...target.querySelectorAll("*")]
      originals.forEach((node, index) => {
        const copy = copies[index]
        if (!copy) return
        captureOpenLayer(node, copy)
        const computed = getComputedStyle(node)
        copy.setAttribute(
          "style",
          [...computed].map((key) => `${key}:${computed.getPropertyValue(key)};`).join("")
        )
        if (node.tagName === "SLOT") {
          const slot = node as HTMLSlotElement
          copy.replaceChildren(
            ...slot.assignedNodes({ flatten: true }).map((child) => child.cloneNode(true))
          )
        }
        copyShadow(node, copy, depth + 1)
      })
      target.querySelectorAll("style,link[rel~=stylesheet]").forEach((node) => node.remove())
      warn("shadow_dom", "开放 Shadow DOM 已转换为普通元素，组件交互不随快照迁移。")
    }
  }
  sourceNodes.forEach((source, index) => {
    if (source.shadowRoot) copyShadow(source, clonedNodes[index], 0)
    else if (source.tagName.includes("-") && !source.children.length && visible(source))
      warn("custom_element", "部分自定义组件可能包含无法读取的内部内容，请检查预览。")
  })
  for (const sheet of document.adoptedStyleSheets ?? []) {
    try {
      extraStyles.push(
        absoluteCss([...sheet.cssRules].map((rule) => rule.cssText).join("\n"), document.baseURI)
      )
    } catch {
      warn("adopted_styles", "部分组件样式无法读取。")
    }
  }
  const head =
    clone.querySelector("head") ??
    clone.insertBefore(document.createElement("head"), clone.firstChild)
  for (const css of extraStyles) {
    const style = document.createElement("style")
    style.textContent = css
    head.append(style)
  }

  // Include template content in sanitization, even though it is currently inert.
  const clean = (root: ParentNode) => {
    root
      .querySelectorAll("script,base,meta[http-equiv],object,embed,iframe,noscript")
      .forEach((node) => node.remove())
    root.querySelectorAll("link").forEach((node) => {
      if (!(node as HTMLLinkElement).relList.contains("stylesheet")) node.remove()
    })
    root.querySelectorAll("*").forEach((node) => {
      for (const attr of [...node.attributes]) {
        if (
          /^on/i.test(attr.name) ||
          /^(?:nonce|integrity|crossorigin|srcdoc|ping|autofocus|autoplay|action|formaction|target)$/i.test(
            attr.name
          ) ||
          /^(?:javascript|vbscript):/i.test(attr.value.replace(/[\s\u0000-\u001f]/g, ""))
        )
          node.removeAttribute(attr.name)
      }
      if (node instanceof HTMLInputElement && ["password", "file", "hidden"].includes(node.type))
        node.removeAttribute("value")
      if (node instanceof HTMLTemplateElement) clean(node.content)
      if (node.tagName === "STYLE")
        node.textContent = node.textContent?.replace(/<\/style/gi, "\\3c /style") ?? ""
      for (const attr of ["src", "href", "poster", "xlink:href"]) {
        const value = node.getAttribute(attr)
        if (!value || value.startsWith("#") || value.startsWith("data:")) continue
        try {
          node.setAttribute(attr, new URL(value, document.baseURI).href)
        } catch {
          node.removeAttribute(attr)
        }
      }
      if (node.hasAttribute("style"))
        node.setAttribute("style", absoluteCss(node.getAttribute("style")!, document.baseURI))
    })
  }
  clean(clone)
  clone.querySelectorAll("picture source").forEach((node) => node.remove())
  clone.querySelectorAll("video,audio").forEach((node) => {
    node.removeAttribute("src")
    node.querySelectorAll("source,track").forEach((child) => child.remove())
    warn("media", "音视频保留海报或布局，播放内容不包含在快照中。")
  })
  const marker = document.createElement("meta")
  marker.name = "design-capture"
  marker.content = "static"
  head.append(marker)
  head.querySelectorAll("meta[charset]").forEach((node) => node.remove())
  const encoding = document.createElement("meta")
  encoding.setAttribute("charset", "utf-8")
  head.prepend(encoding)
  const freeze = document.createElement("style")
  freeze.textContent =
    "*,*::before,*::after{animation-play-state:paused!important;transition:none!important;caret-color:transparent!important}"
  head.append(freeze)
  return {
    html: "<!DOCTYPE html>\n" + clone.outerHTML,
    title: document.title,
    url: location.href,
    textLength: text.length,
    restrictedReason,
    warnings
  }
}

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

export function installSnapshotRuntime(html: string): string {
  return html.replace(
    /<\/body>/i,
    `<script data-design-capture-runtime>(${designSnapshotRuntime.toString()})()</script></body>`
  )
}
