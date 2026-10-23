import { parse, serialize, type DefaultTreeAdapterTypes as Tree } from "parse5"
import type { DesignTweakSchemaEntry, DesignTweakValue } from "./design-protocol"

export type TweakValues = Record<string, DesignTweakValue>
export type DesignTweakBinding =
  | { type: "css-var"; name: string; unit?: string }
  | { type: "text" | "visibility"; selector: string }
export interface DesignTweakDeclaration {
  defaults: TweakValues
  schema: Record<string, DesignTweakSchemaEntry>
  bindings: Record<string, DesignTweakBinding[]>
  resetOverrides?: string[]
}
export interface DesignTweaksState {
  declaration: DesignTweakDeclaration
  overrides: TweakValues
  orphaned: TweakValues
  revision: number
  past: TweakValues[]
  future: TweakValues[]
}
export interface DesignTweakCommand {
  scope: "artifact" | "draft"
  runId?: string
  baseRevision: number
  operation: "set" | "reset" | "undo" | "redo"
  key?: string
  value?: DesignTweakValue
}

export function elements(root: Tree.Node): Tree.Element[] {
  const result: Tree.Element[] = []
  const visit = (node: Tree.Node) => {
    if ("tagName" in node) result.push(node)
    if ("childNodes" in node) node.childNodes.forEach(visit)
  }
  visit(root)
  return result
}
export const attribute = (el: Tree.Element, name: string): string | undefined =>
  el.attrs.find((a) => a.name === name)?.value
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value)
const safeKey = (key: string) =>
  /^[a-zA-Z][\w.-]{0,79}$/.test(key) && !["constructor", "prototype", "__proto__"].includes(key)
const primitive = (value: unknown): value is DesignTweakValue =>
  typeof value === "boolean" ||
  (typeof value === "number" && Number.isFinite(value)) ||
  (typeof value === "string" && value.length <= 4000)

export function isTweakValueValid(
  declaration: DesignTweakDeclaration,
  key: string,
  value: unknown
): value is DesignTweakValue {
  if (!safeKey(key) || !Object.hasOwn(declaration.defaults, key) || !primitive(value)) return false
  const schema = declaration.schema[key]
  if (!schema) return false
  if (schema.type === "number")
    return (
      typeof value === "number" &&
      value >= (schema.min ?? -Infinity) &&
      value <= (schema.max ?? Infinity)
    )
  if (schema.type === "boolean") return typeof value === "boolean"
  if (typeof value !== "string") return false
  if (
    declaration.bindings[key]?.some((binding) => binding.type === "css-var") &&
    /[;{}<>]/.test(value)
  )
    return false
  if (schema.type === "select") return !!schema.options?.includes(value)
  if (schema.type === "color")
    return (
      value.length <= 128 &&
      !/[;{}<>]/.test(value) &&
      /^(#[\da-f]{3,8}|(?:rgb|hsl|oklch|oklab|lab|lch|color)\([^;{}<>]+\)|[a-z]+)$/i.test(value)
    )
  return value.length <= (schema.maxLength ?? 4000)
}

/** Limited selectors are portable across the browser runtime and source adapter. */
export function tweakTarget(selector: string): { name: string; value: string } | null {
  if (/^#[a-zA-Z][\w-]*$/.test(selector)) return { name: "id", value: selector.slice(1) }
  const match = selector.match(/^\[data-design-tweak=['"]([a-zA-Z][\w.-]*)['"]\]$/)
  return match ? { name: "data-design-tweak", value: match[1] } : null
}

export function normalizeTweakDeclaration(value: unknown): DesignTweakDeclaration | null {
  if (!object(value) || !object(value.defaults) || !object(value.schema) || !object(value.bindings))
    return null
  const result: DesignTweakDeclaration = { defaults: {}, schema: {}, bindings: {} }
  for (const [key, initial] of Object.entries(value.defaults).slice(0, 128)) {
    const raw = value.schema[key]
    const bindings = value.bindings[key]
    if (!safeKey(key) || !primitive(initial) || !object(raw) || !Array.isArray(bindings)) continue
    if (!["color", "number", "text", "select", "boolean"].includes(String(raw.type))) continue
    const schema: DesignTweakSchemaEntry = {
      type: raw.type as DesignTweakSchemaEntry["type"],
      label: typeof raw.label === "string" ? raw.label.slice(0, 100) : key
    }
    for (const field of ["min", "max", "step", "maxLength"] as const) {
      if (typeof raw[field] === "number" && Number.isFinite(raw[field])) schema[field] = raw[field]
    }
    if (Array.isArray(raw.options))
      schema.options = raw.options.filter((v): v is string => typeof v === "string").slice(0, 100)
    const accepted: DesignTweakBinding[] = []
    for (const binding of bindings.slice(0, 32)) {
      if (!object(binding)) continue
      if (
        binding.type === "css-var" &&
        typeof binding.name === "string" &&
        /^--[a-zA-Z][\w-]*$/.test(binding.name)
      ) {
        const unit = typeof binding.unit === "string" ? binding.unit : ""
        if (["", "px", "rem", "em", "%", "vw", "vh"].includes(unit))
          accepted.push({ type: "css-var", name: binding.name, unit })
      } else if (
        (binding.type === "text" || binding.type === "visibility") &&
        typeof binding.selector === "string" &&
        tweakTarget(binding.selector)
      ) {
        accepted.push({ type: binding.type, selector: binding.selector })
      }
    }
    if (!accepted.length) continue
    result.defaults[key] = initial
    result.schema[key] = schema
    result.bindings[key] = accepted
    if (!isTweakValueValid(result, key, initial)) {
      delete result.defaults[key]
      delete result.schema[key]
      delete result.bindings[key]
    }
  }
  result.resetOverrides = Array.isArray(value.resetOverrides)
    ? value.resetOverrides.filter(
        (k): k is string => typeof k === "string" && Object.hasOwn(result.defaults, k)
      )
    : []
  return Object.keys(result.defaults).length ? result : null
}

export function readTweakDeclaration(html: string): DesignTweakDeclaration | null {
  const doc = parse(html)
  const block = elements(doc).find(
    (el) => el.tagName === "script" && attribute(el, "type") === "application/design-tweaks+json"
  )
  if (!block) return null
  try {
    const json = block.childNodes
      .map((node) => ("value" in node ? node.value : ""))
      .join("")
      .replace(/\/\*DESIGN_TWEAKS-(?:BEGIN|END)\*\//g, "")
    return normalizeTweakDeclaration(JSON.parse(json))
  } catch {
    return null
  }
}

export function tweakSourceIssues(html: string): string[] {
  const blocks = elements(parse(html)).filter(
    (el) => el.tagName === "script" && attribute(el, "type") === "application/design-tweaks+json"
  )
  if (!blocks.length) return [] // Legacy v1 has its own adapter.
  if (blocks.length !== 1) return ["Tweaks 声明必须只有一个"]
  try {
    const raw = JSON.parse(
      blocks[0].childNodes
        .map((node) => ("value" in node ? node.value : ""))
        .join("")
        .replace(/\/\*DESIGN_TWEAKS-(?:BEGIN|END)\*\//g, "")
    )
    const normalized = normalizeTweakDeclaration(raw)
    if (
      !normalized ||
      Object.keys(raw.defaults ?? {}).length !== Object.keys(normalized.defaults).length
    )
      return ["Tweaks 参数、类型、范围或绑定无效"]
    for (const key of Object.keys(normalized.defaults)) {
      if (raw.bindings[key]?.length !== normalized.bindings[key].length)
        return [`Tweaks 参数 ${key} 含有不支持的绑定`]
    }
    return []
  } catch {
    return ["Tweaks 声明不是有效 JSON"]
  }
}

export function readyTweakKeys(html: string, declaration: DesignTweakDeclaration): Set<string> {
  const all = elements(parse(html))
  const ready = (el: Tree.Element): boolean =>
    attribute(el, "data-design-pending") === undefined &&
    !(el.parentNode && "tagName" in el.parentNode && !ready(el.parentNode))
  return new Set(
    Object.entries(declaration.bindings)
      .filter(([, bindings]) =>
        bindings.every((binding) => {
          if (binding.type === "css-var") return true
          const target = tweakTarget(binding.selector)
          const matches = target
            ? all.filter((el) => attribute(el, target.name) === target.value)
            : []
          return !!matches.length && matches.every(ready)
        })
      )
      .map(([key]) => key)
  )
}

export function reconcileTweaks(
  declaration: DesignTweakDeclaration | null,
  previous?: DesignTweaksState | null,
  consumeResets = false
): DesignTweaksState | null {
  if (!declaration) return null
  const overrides: TweakValues = {},
    orphaned: TweakValues = { ...previous?.orphaned }
  for (const [key, value] of Object.entries(previous?.overrides ?? {})) {
    if (consumeResets && declaration.resetOverrides?.includes(key)) continue
    if (
      isTweakValueValid(declaration, key, value) &&
      (!previous || previous.declaration.schema[key]?.type === declaration.schema[key]?.type)
    )
      overrides[key] = value
    else orphaned[key] = value
  }
  const compatible = (values: TweakValues): TweakValues =>
    Object.fromEntries(
      Object.entries(values).filter(
        ([key, value]) =>
          isTweakValueValid(declaration, key, value) &&
          !(consumeResets && declaration.resetOverrides?.includes(key))
      )
    )
  return {
    declaration,
    overrides,
    orphaned,
    revision: (previous?.revision ?? 0) + 1,
    past: (previous?.past ?? []).map(compatible),
    future: (previous?.future ?? []).map(compatible)
  }
}

export const effectiveTweaks = (state: DesignTweaksState): TweakValues => ({
  ...state.declaration.defaults,
  ...state.overrides
})

export function editTweaks(
  state: DesignTweaksState,
  command: DesignTweakCommand
): DesignTweaksState {
  if (command.baseRevision !== state.revision) throw new Error("微调版本已更新，请重试")
  const next = structuredClone(state)
  if (command.operation === "undo" || command.operation === "redo") {
    const from = command.operation === "undo" ? next.past : next.future
    const to = command.operation === "undo" ? next.future : next.past
    const value = from.pop()
    if (!value) return state
    to.push(next.overrides)
    next.overrides = value
  } else {
    next.past = [...next.past, next.overrides].slice(-50)
    next.future = []
    next.overrides = { ...next.overrides }
    if (command.operation === "reset") {
      if (command.key) delete next.overrides[command.key]
      else next.overrides = {}
    } else if (
      command.operation === "set" &&
      command.key &&
      isTweakValueValid(next.declaration, command.key, command.value)
    ) {
      if (next.overrides[command.key] === command.value) return state
      next.overrides[command.key] = command.value
    } else throw new Error("微调参数或取值无效")
  }
  next.revision++
  return next
}

/** This function is stringified into a standalone artifact. Keep it closure-free. */
export function designTweaksRuntime(): void {
  const w = window as unknown as {
    __designTweaksInstalled?: boolean
    __designApplyTweaks?: (values: Record<string, unknown>) => void
    __designValidateTweaks?: () => string[]
  }
  if (w.__designTweaksInstalled) return
  w.__designTweaksInstalled = true
  let declaration: DesignTweakDeclaration | null = null,
    current: Record<string, unknown> = {},
    revision = -1
  function read() {
    const block = document.querySelector('script[type="application/design-tweaks+json"]')
    try {
      declaration = JSON.parse(
        (block?.textContent ?? "").replace(/\/\*DESIGN_TWEAKS-(?:BEGIN|END)\*\//g, "")
      )
    } catch {
      declaration = null
    }
    return declaration
  }
  function apply(values: Record<string, unknown>) {
    const config = read()
    if (!config) return
    current = { ...config.defaults, ...current, ...values }
    for (const [key, bindings] of Object.entries(config.bindings ?? {})) {
      if (!Array.isArray(bindings)) continue
      const value = current[key]
      if (value === undefined) continue
      for (const binding of bindings) {
        if (binding.type === "css-var" && /^--[a-zA-Z][\w-]*$/.test(binding.name))
          document.documentElement.style.setProperty(
            binding.name,
            String(value) + (binding.unit ?? "")
          )
        else if (binding.type === "text" || binding.type === "visibility") {
          try {
            document.querySelectorAll(binding.selector).forEach((el) => {
              if (binding.type === "text" && !el.children.length) el.textContent = String(value)
              if (binding.type === "visibility") (el as HTMLElement).hidden = !value
            })
          } catch {
            /* Invalid bindings are reported by validation. */
          }
        }
      }
    }
  }
  w.__designApplyTweaks = apply
  w.__designValidateTweaks = () => {
    const config = read()
    if (!config) return ["Tweaks 声明无法解析"]
    const issues: string[] = []
    const css = [...document.querySelectorAll("style,[style]")]
      .map((el) => (el.tagName === "STYLE" ? el.textContent : el.getAttribute("style")))
      .join("\n")
    for (const [key, bindings] of Object.entries(config.bindings ?? {})) {
      if (!Array.isArray(bindings)) {
        issues.push(key + " 绑定无效")
        continue
      }
      for (const b of bindings) {
        if (
          b.type === "css-var" &&
          !css.includes("var(" + b.name) &&
          !css.includes("var( " + b.name)
        )
          issues.push(key + " 未引用 CSS 变量 " + b.name)
        if (b.type !== "css-var") {
          try {
            const matches = [...document.querySelectorAll(b.selector)]
            if (!matches.length) issues.push(key + " 缺少绑定节点")
            if (b.type === "text" && matches.some((el) => el.children.length))
              issues.push(key + " 文本目标必须为叶子节点")
          } catch {
            issues.push(key + " 绑定选择器无效")
          }
        }
      }
    }
    return issues
  }
  window.addEventListener("message", (event) => {
    const msg = event.data
    if (event.source !== window.parent || !msg || msg.type !== "__design_set_tweak_keys") return
    if (
      msg.previewInstanceId !== document.documentElement.dataset.designPreviewInstance ||
      msg.tweakRevision < revision
    )
      return
    revision = msg.tweakRevision
    apply(msg.keys ?? {})
    window.parent.postMessage(
      {
        type: "__design_tweaks_applied",
        previewInstanceId: msg.previewInstanceId,
        tweakRevision: revision
      },
      "*"
    )
  })
  const start = () => {
    apply({})
    if (window.parent !== window)
      window.parent.postMessage({ type: "__design_runtime_ready", protocol: 2 }, "*")
  }
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", start, { once: true })
  else start()
}

export const DESIGN_TWEAKS_RUNTIME = `;(${designTweaksRuntime.toString()})();`

/** Canonical source composition for export, validation and the next model turn. */
export function materializeTweaks(
  html: string,
  state?: DesignTweaksState | null,
  includeRuntime = true
): string {
  const declaration = state?.declaration ?? readTweakDeclaration(html)
  if (!declaration) return html
  const effective = state ? effectiveTweaks(state) : declaration.defaults
  const doc = parse(html)
  const all = elements(doc)
  const root = all.find((el) => el.tagName === "html")!
  const style = Object.entries(declaration.bindings)
    .flatMap(([key, bindings]) =>
      bindings
        .filter((b) => b.type === "css-var")
        .map(
          (b) =>
            `${(b as { name: string }).name}:${String(effective[key])}${"unit" in b ? (b.unit ?? "") : ""}`
        )
    )
    .join(";")
  let old = attribute(root, "style") ?? ""
  for (const bindings of Object.values(declaration.bindings))
    for (const binding of bindings) {
      if (binding.type === "css-var")
        old = old.replace(new RegExp(`(^|;)\\s*${binding.name}\\s*:[^;]*(?=;|$)`, "g"), "")
    }
  root.attrs = root.attrs.filter(
    (a) => a.name !== "style" && !a.name.startsWith("data-design-preview")
  )
  root.attrs.push({
    name: "style",
    value: [old.replace(/^;+|;+$/g, "").trim(), style].filter(Boolean).join(";")
  })
  for (const [key, bindings] of Object.entries(declaration.bindings)) {
    for (const b of bindings) {
      if (b.type === "css-var") continue
      const target = tweakTarget(b.selector)
      if (!target) continue
      for (const el of all.filter((el) => attribute(el, target.name) === target.value)) {
        if (b.type === "text" && !el.childNodes.some((node) => "tagName" in node))
          el.childNodes = [{ nodeName: "#text", value: String(effective[key]), parentNode: el }]
        if (b.type === "visibility") {
          el.attrs = el.attrs.filter((a) => a.name !== "hidden")
          if (!effective[key]) el.attrs.push({ name: "hidden", value: "" })
        }
      }
    }
  }
  const block = all.find(
    (el) => el.tagName === "script" && attribute(el, "type") === "application/design-tweaks+json"
  )
  // Exported defaults represent what is visible; session state retains the model's defaults.
  if (block)
    block.childNodes = [
      {
        nodeName: "#text",
        value: JSON.stringify({ ...declaration, defaults: effective, resetOverrides: [] }).replace(
          /</g,
          "\\u003c"
        ),
        parentNode: block
      }
    ]
  let result = serialize(doc).replace(
    /<script\b[^>]*\bdata-design-tweaks-runtime[^>]*>[\s\S]*?<\/script\s*>/gi,
    ""
  )
  if (includeRuntime)
    result = result.replace(
      /<\/body\s*>/i,
      `<script data-design-tweaks-runtime>${DESIGN_TWEAKS_RUNTIME.replace(/<\/script/gi, "<\\/script")}</script></body>`
    )
  return result
}
