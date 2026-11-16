import { parse as parseHtml } from "parse5"
import { parse as parseJs, type Node } from "acorn"
import { materializeTweaks, readTweakDeclaration } from "./design-tweaks"
import { applyHtmlSourceEdits, htmlElements, insertDesignBodyScript } from "./design-html-mutations"

export function ensureEditMode(html: string): string {
  if (readTweakDeclaration(html)) return materializeTweaks(html)
  const nodes = htmlElements(parseHtml(html, { sourceCodeLocationInfo: true }))
  const scripts = nodes.filter((node) => node.tagName === "script")
  const scriptText = (node: (typeof nodes)[number]) =>
    node.childNodes.map((child) => ("value" in child ? child.value : "")).join("")
  if (scripts.some((node) => /\/\*EDITMODE-BEGIN\*\//.test(scriptText(node)))) return html

  // Recognize declarations in JS syntax, never inside a string containing sample code.
  for (const script of scripts) {
    if (script.attrs.some((attr) => attr.name === "src")) continue
    const type =
      script.attrs
        .find((attr) => attr.name === "type")
        ?.value.trim()
        .toLowerCase() ?? ""
    if (!["", "module", "text/javascript", "application/javascript"].includes(type)) continue
    const js = scriptText(script)
    try {
      const tree = parseJs(js, {
        ecmaVersion: "latest",
        sourceType: type === "module" ? "module" : "script"
      })
      const pending: Node[] = [tree]
      while (pending.length) {
        const node = pending.pop()!
        if (node.type === "VariableDeclarator") {
          const declaration = node as Node & { id: { type: string; name?: string }; init?: Node }
          if (
            declaration.id.type === "Identifier" &&
            declaration.id.name === "TWEAK_DEFAULTS" &&
            declaration.init?.type === "ObjectExpression"
          ) {
            const base = script.sourceCodeLocation!.startTag!.endOffset
            const start = base + declaration.init.start,
              end = base + declaration.init.end
            return applyHtmlSourceEdits(html, [
              { start, end, value: `/*EDITMODE-BEGIN*/${html.slice(start, end)}/*EDITMODE-END*/` }
            ])
          }
        }
        for (const value of Object.values(node))
          for (const child of Array.isArray(value) ? value : [value]) {
            if (child && typeof child === "object" && "type" in child && "start" in child)
              pending.push(child as Node)
          }
      }
    } catch (error) {
      throw new Error(
        `页面脚本无法解析，请使用原始 HTML 重新导入：${error instanceof Error ? error.message : String(error)}`
      )
    }
  }
  const styleContent = nodes
    .filter((node) => node.tagName === "style")
    .map(scriptText)
    .join("\n")
  // 3. CSS custom properties already declared in :root
  const cssVars: Record<string, unknown> = {}
  for (const rootBlock of styleContent.matchAll(/:root\s*\{([^}]+)\}/g)) {
    for (const [, name, rawVal] of rootBlock[1].matchAll(/--([a-zA-Z][\w-]+)\s*:\s*([^;]+);/g)) {
      const v = rawVal.trim()
      const key = name.replace(/-([a-z])/g, (_: string, c: string) => c.toUpperCase())
      if (/^#[0-9a-fA-F]{3,8}$/.test(v)) cssVars[key] = v
      else if (/^[\d.]+$/.test(v)) cssVars[key] = parseFloat(v)
      else if (/^(true|false)$/.test(v)) cssVars[key] = v === "true"
    }
  }
  if (Object.keys(cssVars).length > 0) return appendEditScript(html, cssVars)

  // 4. No CSS variables at all — extract hardcoded hex colors from <style> blocks,
  //    replace them with CSS var() references, and inject :root + EDITMODE script.
  return injectColorVars(html)
}

/** Append an EDITMODE script to html. vars keys are camelCase → CSS --kebab-case vars. */
function appendEditScript(html: string, vars: Record<string, unknown>): string {
  const setLines = Object.keys(vars)
    .map((k) => {
      const cv = "--" + k.replace(/([A-Z])/g, "-$1").toLowerCase()
      return `r.style.setProperty('${cv}',String(t['${k}']));`
    })
    .join("")
  const script = `\n<script>(function(){
var TWEAK_DEFAULTS=/*EDITMODE-BEGIN*/${JSON.stringify(vars)}/*EDITMODE-END*/;
function applyTweaks(edits){var t=Object.assign({},TWEAK_DEFAULTS,edits||{}),r=document.documentElement;${setLines}}
window.addEventListener('message',function(e){if(e.data&&e.data.type==='__set_tweak_keys')applyTweaks(e.data.edits);});
window.parent.postMessage({type:'__edit_mode_available'},'*');
applyTweaks({});
})()</script>`
  // Try </body>, then </html>, then just append
  return insertDesignBodyScript(
    html,
    script.slice(script.indexOf(">") + 1, script.lastIndexOf("</script>")),
    "data-design-legacy-tweaks"
  )
}

/** Strategy 4: replace hardcoded hex colors in <style> with CSS vars, then inject EDITMODE. */
function injectColorVars(html: string): string {
  // Collect 6-digit hex colors from <style> blocks AND inline style="" attributes
  const nodes = htmlElements(parseHtml(html, { sourceCodeLocationInfo: true }))
  const styles = nodes.filter((node) => node.tagName === "style" && node.sourceCodeLocation?.endTag)
  const styleContent = styles
    .map((node) =>
      html.slice(
        node.sourceCodeLocation!.startTag!.endOffset,
        node.sourceCodeLocation!.endTag!.startOffset
      )
    )
    .join("\n")
  const inlineContent = nodes
    .flatMap((node) => node.attrs.filter((attr) => attr.name === "style").map((attr) => attr.value))
    .join("\n")
  const allCssContent = styleContent + "\n" + inlineContent

  const freq: Map<string, number> = new Map()
  for (const [, h] of allCssContent.matchAll(/#([0-9a-fA-F]{6})\b/g)) {
    const c = "#" + h.toLowerCase()
    freq.set(c, (freq.get(c) ?? 0) + 1)
  }
  // Also try 3-digit hex from inline styles
  for (const [, h] of inlineContent.matchAll(/#([0-9a-fA-F]{3})\b/g)) {
    const c = "#" + h[0] + h[0] + h[1] + h[1] + h[2] + h[2] // expand to 6-digit
    freq.set(c, (freq.get(c) ?? 0) + 1)
  }

  // Take up to 6 most-used colors (skip pure black/white as they're usually decorative)
  const palette = [...freq.entries()]
    .sort(([, a], [, b]) => b - a)
    .map(([c]) => c)
    .filter((c) => c !== "#000000" && c !== "#ffffff" && c !== "#fff" && c !== "#000")
    .slice(0, 6)

  // If there are no interesting colors, still provide generic numeric tweaks
  const vars: Record<string, unknown> = {}
  const colorNames = ["primary", "secondary", "accent", "background", "surface", "muted"]

  type Entry = { key: string; cssVar: string; hex: string }
  const entries: Entry[] = palette.map((hex, i) => {
    const key = colorNames[i] ?? `color${i + 1}`
    return { key, cssVar: `--${colorNames[i] ?? "color-" + (i + 1)}`, hex }
  })
  entries.forEach(({ key, hex }) => {
    vars[key] = hex
  })

  // Numeric tweaks extracted from CSS
  const fsMatch = styleContent.match(/\bfont-size\s*:\s*([\d.]+)px/)
  if (fsMatch) vars["fontSize"] = parseFloat(fsMatch[1])
  const rrMatch = styleContent.match(/\bborder-radius\s*:\s*([\d.]+)px/)
  if (rrMatch) vars["borderRadius"] = parseFloat(rrMatch[1])

  // Fallback: if no colors at all, use sensible generic defaults
  if (entries.length === 0) {
    vars["primaryColor"] = "#3b82f6"
    vars["fontSize"] = vars["fontSize"] ?? 16
    vars["borderRadius"] = vars["borderRadius"] ?? 8
    return appendEditScript(html, vars)
  }

  // Replace hardcoded colors in <style> blocks with var() references
  const rootBlock = `:root{${entries.map(({ cssVar, hex }) => `${cssVar}:${hex}`).join(";")}}\n`
  const edits = styles.map((node, index) => {
    const start = node.sourceCodeLocation!.startTag!.endOffset
    const end = node.sourceCodeLocation!.endTag!.startOffset
    let value = html.slice(start, end)
    for (const { hex, cssVar } of entries)
      value = value.replace(new RegExp(hex, "gi"), `var(${cssVar})`)
    return { start, end, value: (index === 0 ? rootBlock : "") + value }
  })
  if (!styles.length) {
    const head = nodes.find((node) => node.tagName === "head")
    const offset = head?.sourceCodeLocation?.startTag?.endOffset ?? 0
    edits.push({ start: offset, end: offset, value: `<style>${rootBlock}</style>` })
  }
  const patched = applyHtmlSourceEdits(html, edits)

  // Build setProperty lines: color vars + optional numeric vars
  const colorSet = entries
    .map(({ key, cssVar }) => `r.style.setProperty('${cssVar}',String(t['${key}']));`)
    .join("")
  const numSet = [
    vars["fontSize"] ? `r.style.setProperty('--font-size',t.fontSize+'px');` : "",
    vars["borderRadius"] ? `r.style.setProperty('--border-radius',t.borderRadius+'px');` : ""
  ].join("")

  const script = `\n<script>(function(){
var TWEAK_DEFAULTS=/*EDITMODE-BEGIN*/${JSON.stringify(vars)}/*EDITMODE-END*/;
function applyTweaks(edits){var t=Object.assign({},TWEAK_DEFAULTS,edits||{}),r=document.documentElement;${colorSet}${numSet}}
window.addEventListener('message',function(e){if(e.data&&e.data.type==='__set_tweak_keys')applyTweaks(e.data.edits);});
window.parent.postMessage({type:'__edit_mode_available'},'*');
applyTweaks({});
})()</script>`

  // Try </body>, then </html>, then just append
  return insertDesignBodyScript(
    patched,
    script.slice(script.indexOf(">") + 1, script.lastIndexOf("</script>")),
    "data-design-legacy-tweaks"
  )
}
