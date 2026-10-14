import type { NativeUserInputQuestion } from "../../user-input-schema"
import type { ModJson, ModObject } from "../types"
import { encodeModJson } from "../validation"
import { isModObject, ModFunctionError } from "./contracts"
import { functionCodeRows } from "./code"
import { validateFunctionMarkdownProps, type FunctionMarkdownLeafProps } from "./markdown"
import type { FunctionMarkdownLinkSidecar } from "./markdown-links"

export const FUNCTION_UI_CAPABILITIES = [
  "ui.open",
  "ui.focus",
  "ui.scroll",
  "ui.close",
  "ui.copy",
  "ui.selection",
  "ui.panes",
  "ui.resolve",
  "ui.invalidate",
  "ui.toast",
  "ui.log",
  "ui.ask",
  "ui.notice",
  "ui.status"
] as const
export type FunctionUiElement =
  | FunctionUiNode
  | FunctionUiEngine
  | FunctionUiFragment
  | FunctionUiMarkdown
/** Markdown is a data leaf; callback closures remain in the actual drawing runtime. */
export interface FunctionUiMarkdown {
  type: "Markdown"
  props: FunctionMarkdownLeafProps & ModObject
  press?: { kind: "onLinkPress"; plugin: string; handle: number }
  children?: never
  client?: never
}
/** Inert structural sequence. It never owns props, native refs, Clients or actions. */
export interface FunctionUiFragment {
  type: "fragment"
  children: (FunctionUiElement | string)[]
}
export interface FunctionUiEngine {
  type: "engine"
  ref: number
}
export interface FunctionUiNode {
  type: "Box" | "Text" | "Button" | "Input" | "Select" | "Link" | "Code" | "Svg" | "Client"
  props: ModObject
  children?: (FunctionUiElement | string)[]
  press?: { plugin: string; handle: number }
  client?: { plugin: string }
}
export interface FunctionPaneSnapshot {
  /** Host-only identity of explicit open; redraw generations do not change it. */
  openRequestId?: string
  key: string
  id: string
  plugin: string
  title: string
  generation: string
  tree: FunctionUiElement
  closeOnEscape: boolean
  /** Native fixed metadata; only true actively holds this thread's transient notifications. */
  holdToasts?: boolean
  rows: number
  /** Set by the host after publication when the site exactly preserves its native default. */
  nativeFallback?: boolean
  /** Host-derived ToolGroup expansion, only when the final tree retains native rendering. */
  nativeExpansion?: boolean
  /** Validated host-derived question wording; never an answer or a permission decision. */
  nativeQuestions?: NativeUserInputQuestion[]
  /** Protected host presentation for this exact native component and drawing. */
  nativeContent?: import("./engine").FunctionNativeContent
  clients?: FunctionClientSnapshot[]
  /** Native publication sidecar only; never accepted as part of a guest tree. */
  markdownLinks?: readonly FunctionMarkdownLinkSidecar[]
  focusRequest?: { id: string; pending: boolean }
  scrollFollowToken?: string
  imperativeScroll?: import("./ui-scroll").FunctionScrollRequest
  imperativeFocus?: import("./ui-focus").FunctionFocusRequest
}
export interface FunctionFocusTarget {
  plugin: string
  element: string
  client?: string
}
export interface FunctionFocusResult {
  focused: boolean
  target?: FunctionFocusTarget
}
export interface FunctionClientSnapshot {
  id: string
  generation: string
  plugin: string
  element: string
  module: string
  tree: FunctionUiElement
  /** Native publication sidecar only; never accepted as part of a guest tree. */
  markdownLinks?: readonly FunctionMarkdownLinkSidecar[]
  error?: string
}
export interface FunctionClientAction {
  pane: string
  instance: string
  generation: string
  intentId: string
  kind: "press" | "change" | "submit" | "select" | "key" | "pointer" | "resize" | "focus" | "scroll"
  handle?: number
  value?: ModJson
}
export interface FunctionUiAction {
  pane: string
  generation: string
  intentId: string
  plugin: string
  handle: number
  kind: "press" | "change" | "submit" | "select" | "close" | "focus" | "scroll"
  value?: ModJson
  link?: FunctionUiPressedLink
}
export interface FunctionUiPressedLink {
  href: string
}

function invalidMarkdownNode(): never {
  throw new ModFunctionError("MODS_UI_TREE_INVALID")
}

function ownData(value: unknown, keys: readonly string[]): Map<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalidMarkdownNode()
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) invalidMarkdownNode()
  const fields = new Map<string, unknown>()
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !keys.includes(key)) invalidMarkdownNode()
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor?.enumerable || !("value" in descriptor)) invalidMarkdownNode()
    fields.set(key, descriptor.value)
  }
  return fields
}

function validateMarkdownNode(value: unknown): asserts value is FunctionUiMarkdown {
  const fields = ownData(value, ["type", "props", "press"])
  if (fields.get("type") !== "Markdown" || !fields.has("props")) invalidMarkdownNode()
  if (fields.has("press")) {
    const press = ownData(fields.get("press"), ["kind", "plugin", "handle"])
    const handle = press.get("handle")
    if (
      press.size !== 3 ||
      press.get("kind") !== "onLinkPress" ||
      !text(press.get("plugin"), 100) ||
      !press.get("plugin") ||
      typeof handle !== "number" ||
      !Number.isSafeInteger(handle) ||
      handle <= 0
    ) invalidMarkdownNode()
  }
  validateFunctionMarkdownProps(fields.get("props"), fields.has("press"))
}

/** Reject new leaf metadata before JSON serialization can inspect its hidden toJSON field. */
function preflightMarkdownLeaves(value: unknown): void {
  const pending: unknown[] = [value]
  const visited = new Set<object>()
  while (pending.length && visited.size <= 30000) {
    const node = pending.pop()
    if (!node || typeof node !== "object" || visited.has(node)) continue
    visited.add(node)
    const type = Object.getOwnPropertyDescriptor(node, "type")
    if (type && "value" in type && type.value === "Markdown") validateMarkdownNode(node)
    const children = Object.getOwnPropertyDescriptor(node, "children")
    if (!children || !("value" in children) || !Array.isArray(children.value)) continue
    for (
      let index = 0;
      index < children.value.length && pending.length + visited.size < 30000;
      index++
    ) {
      const child = Object.getOwnPropertyDescriptor(children.value, String(index))
      if (child && "value" in child) pending.push(child.value)
    }
  }
}

/** A link is callback business data. Native opening still uses its original publication receipt. */
export function validateFunctionUiPressedLink(value: unknown): asserts value is FunctionUiPressedLink {
  const fields = ownData(value, ["href"])
  const href = fields.get("href")
  if (
    fields.size !== 1 ||
    typeof href !== "string" ||
    !href ||
    href.length > 2048 ||
    // eslint-disable-next-line no-control-regex -- Callback targets cannot carry terminal controls.
    /[\u0000-\u001f\u007f-\u009f]/.test(href)
  ) invalidMarkdownNode()
}

/** markdown is fixed by the host's actual current control, never a field from the caller. */
export function validateFunctionUiActionLink(
  action: Pick<FunctionUiAction, "kind" | "link">,
  markdown: boolean
): void {
  const descriptor = Object.getOwnPropertyDescriptor(action, "link")
  if (!markdown) {
    if (descriptor) invalidMarkdownNode()
    return
  }
  const kind = Object.getOwnPropertyDescriptor(action, "kind")
  if (
    !kind ||
    !("value" in kind) ||
    kind.value !== "press" ||
    !descriptor?.enumerable ||
    !("value" in descriptor)
  )
    invalidMarkdownNode()
  validateFunctionUiPressedLink(descriptor.value)
}

const props: Record<FunctionUiNode["type"], readonly string[]> = {
  Box: [
    "key",
    "flexDirection",
    "gap",
    "padding",
    "paddingX",
    "paddingY",
    "margin",
    "marginX",
    "marginY",
    "marginTop",
    "alignItems",
    "justifyContent",
    "borderStyle",
    "borderColor",
    "width",
    "height"
  ],
  Text: [
    "key",
    "color",
    "backgroundColor",
    "bold",
    "italic",
    "underline",
    "strikethrough",
    "inverse",
    "dimColor",
    "wrap"
  ],
  Button: ["key", "label", "plain", "dimColor", "autoFocus", "hotkey"],
  Input: ["key", "label", "placeholder", "value", "submitLabel", "autoFocus"],
  Select: ["key", "label", "options", "value", "autoFocus"],
  Link: ["href", "label"],
  Code: ["source", "language", "path", "startLine", "format", "wrap"],
  Svg: ["source", "alt", "width", "height", "isInteractive"],
  Client: ["key", "module", "props", "width", "height", "flexGrow"]
}
const text = (value: unknown, max = 10000): value is string =>
  typeof value === "string" &&
  value.length <= max &&
  // eslint-disable-next-line no-control-regex -- Reject terminal escape and control sequences.
  !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(value)

export function validFunctionLink(value: unknown): value is string {
  if (
    typeof value !== "string" || value.length > 2048 ||
    /[^\x21-\x7e]|@|\\/.test(value) || !/^https?:\/\/[^/?#]+(?:[/?#]|$)/i.test(value)
  ) return false
  try {
    const url = new URL(value)
    return (
      !url.username &&
      !url.password &&
      (url.protocol === "https:" || (url.protocol === "http:" && url.hostname === "localhost"))
    )
  } catch {
    return false
  }
}

/** Host and renderer share this allowlist; plugin data never becomes arbitrary DOM props. */
export function validateFunctionTree(value: unknown): asserts value is FunctionUiElement {
  preflightMarkdownLeaves(value)
  encodeModJson(value)
  let count = 0
  const keys = new Set<string>()
  const fail = (): never => {
    throw new ModFunctionError("MODS_UI_TREE_INVALID")
  }
  const visit = (node: unknown, depth: number): void => {
    if (++count > 1000 || depth > 24) fail()
    if (typeof node === "string") {
      if (!text(node)) fail()
      return
    }
    if (isModObject(node) && node.type === "engine") {
      if (
        !Object.hasOwn(node, "ref") ||
        !Number.isSafeInteger(node.ref) ||
        (node.ref as number) < 0 ||
        Object.keys(node).some((key) => key !== "type" && key !== "ref")
      ) fail()
      return
    }
    if (isModObject(node) && node.type === "fragment") {
      const type = Object.getOwnPropertyDescriptor(node, "type")
      const children = Object.getOwnPropertyDescriptor(node, "children")
      if (
        !type?.enumerable || !("value" in type) ||
        !children?.enumerable || !("value" in children) ||
        Reflect.ownKeys(node).some((key) => key !== "type" && key !== "children")
      ) fail()
      const childList: unknown = children?.value
      if (!Array.isArray(childList)) return fail()
      for (const child of childList) visit(child, depth + 1)
      return
    }
    if (isModObject(node) && node.type === "Markdown") {
      validateMarkdownNode(node)
      if (node.press) {
        const address = JSON.stringify([node.press.plugin, node.props.key])
        if (keys.has(address)) fail()
        keys.add(address)
      }
      return
    }
    if (
      !isModObject(node) ||
      typeof node.type !== "string" ||
      !Object.hasOwn(props, node.type) ||
      !isModObject(node.props) ||
      Object.keys(node).some(
        (key) => !["type", "props", "children", "press", "client"].includes(key)
      )
    )
      fail()
    const item = node as unknown as FunctionUiNode
    const p = item.props
    if (
      item.type === "Svg" &&
      (!text(p.source, 131072) ||
        !text(p.alt) ||
        (p.isInteractive !== undefined && typeof p.isInteractive !== "boolean") ||
        [p.width, p.height].some((v) => v !== undefined && typeof v !== "number"))
    )
      fail()
    for (const [key, value] of Object.entries(p)) {
      if (!props[item.type].includes(key)) fail()
      if (item.type === "Link" && key === "href") {
        if (typeof value === "string" && (
          value.length > 2048 ||
          // eslint-disable-next-line no-control-regex -- Addresses cannot contain terminal/control text.
          /[\u0000-\u001f\u007f-\u009f]/.test(value)
        )) fail()
        continue
      }
      if (item.type === "Svg" && key === "source") continue
      if (item.type === "Code" && key === "source") continue
      if (key === "options") continue
      if (key === "props" && item.type === "Client") continue
      if (
        ["bold", "italic", "underline", "strikethrough", "inverse", "dimColor"].includes(key) &&
        typeof value !== "boolean"
      )
        fail()
      if (["plain", "autoFocus"].includes(key) && value !== true) fail()
      if (
        [
          "gap",
          "padding",
          "paddingX",
          "paddingY",
          "margin",
          "marginX",
          "marginY",
          "marginTop",
          "flexGrow",
          "startLine"
        ].includes(key) &&
        typeof value !== "number"
      )
        fail()
      if (
        [
          "label",
          "placeholder",
          "value",
          "submitLabel",
          "color",
          "backgroundColor",
          "borderColor",
          "source",
          "language",
          "path"
        ].includes(key) &&
        typeof value !== "string"
      )
        fail()
      if (
        ["width", "height"].includes(key) &&
        typeof value !== "number" &&
        !(typeof value === "string" && /^(100|[1-9]?\d)%$/.test(value))
      )
        fail()
      if (
        typeof value === "string"
          ? !text(value)
          : typeof value !== "boolean" &&
            !(typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 10000)
      )
        fail()
    }
    if (p.key !== undefined && (!text(p.key, 256) || !p.key)) fail()
    if (p.flexDirection !== undefined && !["row", "column"].includes(String(p.flexDirection)))
      fail()
    if (p.wrap !== undefined && !["wrap", "truncate-start", "truncate-end"].includes(String(p.wrap))) fail()
    if (["Button", "Input", "Select"].includes(item.type)) {
      if (
        !text(p.key, 256) ||
        !p.key ||
        !isModObject(item.press) ||
        Object.hasOwn(item.press, "kind") ||
        !text(item.press.plugin, 100) ||
        !Number.isSafeInteger(item.press.handle) ||
        item.press.handle <= 0
      )
        fail()
      const address = JSON.stringify([item.press!.plugin, p.key])
      if (keys.has(address)) fail()
      keys.add(address)
    } else if (item.press) fail()
    if (item.type === "Client") {
      if (
        !text(p.key, 256) ||
        !p.key ||
        !text(p.module, 1024) ||
        /[\\:]/.test(p.module) ||
        p.module.startsWith("/") ||
        p.module.split("/").some((part) => !part || part === "." || part === "..") ||
        !isModObject(item.client) ||
        Object.keys(item.client).some((key) => key !== "plugin") ||
        !text(item.client.plugin, 100)
      )
        fail()
      const address = JSON.stringify([item.client!.plugin, p.key])
      if (keys.has(address)) fail()
      keys.add(address)
    } else if (item.client) fail()
    if (item.type === "Button" && !text(p.label, 1000)) fail()
    if (item.type === "Button" && p.hotkey !== undefined &&
      (typeof p.hotkey !== "string" || !/^[a-z0-9]$/.test(p.hotkey))) fail()
    if (item.type === "Select") {
      if (!Array.isArray(p.options) || !p.options.length || p.options.length > 200) fail()
      const values = new Set<string>()
      for (const option of p.options as ModJson[]) {
        if (
          !isModObject(option) ||
          !text(option.value, 1000) ||
          !text(option.label, 1000) ||
          Object.keys(option).some((key) => !["value", "label"].includes(key)) ||
          values.has(option.value)
        )
          fail()
        values.add((option as ModObject).value as string)
      }
      if (p.value !== undefined && !values.has(p.value as string)) fail()
    }
    if (
      item.type === "Code" &&
      (!text(p.source, Number.MAX_SAFE_INTEGER) ||
        (p.format !== undefined && p.format !== "source" && p.format !== "diff") ||
        (p.startLine !== undefined &&
          (!Number.isInteger(p.startLine) || (p.startLine as number) < 1)))
    )
      fail()
    if (item.type === "Code") functionCodeRows(p)
    if (["Box", "Text", "Link"].includes(item.type)) {
      if (item.type === "Link" && item.children === undefined) return
      if (!Array.isArray(item.children)) fail()
      for (const child of item.children!) visit(child, depth + 1)
    } else if (item.children !== undefined) fail()
  }
  if (typeof value === "string") fail()
  visit(value, 0)
}

export function validatePaneArgs(value: ModObject): void {
  if (
    typeof value.id !== "string" ||
    !/^[\w-]{1,64}$/.test(value.id) ||
    (value.title !== undefined && !text(value.title, 256)) ||
    ["focus", "closeOnEscape", "holdToasts"].some(
      (key) => value[key] !== undefined && value[key] !== true
    ) ||
    (value.rows !== undefined && (!Number.isInteger(value.rows) || (value.rows as number) < 1))
  )
    throw new ModFunctionError("MODS_UI_PANE_ARGUMENTS")
}
