import type { ModJson, ModObject } from "../types"
import { encodeModJson } from "../validation"
import { isModObject, ModFunctionError } from "./contracts"

export const FUNCTION_UI_CAPABILITIES = [
  "ui.open",
  "ui.close",
  "ui.resolve",
  "ui.invalidate"
] as const
export interface FunctionUiElement {
  type: "Box" | "Text" | "Button" | "Input" | "Select" | "Link" | "Code" | "Client"
  props: ModObject
  children?: (FunctionUiElement | string)[]
  press?: { plugin: string; handle: number }
  client?: { plugin: string }
}
export interface FunctionPaneSnapshot {
  key: string
  id: string
  plugin: string
  title: string
  generation: string
  tree: FunctionUiElement
  closeOnEscape: boolean
  rows: number
  clients?: FunctionClientSnapshot[]
}
export interface FunctionClientSnapshot {
  id: string
  plugin: string
  element: string
  module: string
  tree: FunctionUiElement
  error?: string
}
export interface FunctionClientAction {
  pane: string
  instance: string
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
}

const props: Record<FunctionUiElement["type"], readonly string[]> = {
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
    "alignItems",
    "justifyContent",
    "borderStyle",
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
    "dimColor",
    "wrap"
  ],
  Button: ["key", "label", "plain", "dimColor", "autoFocus"],
  Input: ["key", "label", "placeholder", "value", "submitLabel", "autoFocus"],
  Select: ["key", "label", "options", "value", "autoFocus"],
  Link: ["href", "label"],
  Code: ["source", "language", "path", "startLine", "format", "wrap"],
  Client: ["key", "module", "props", "width", "height", "flexGrow"]
}
const text = (value: unknown, max = 10000): value is string =>
  typeof value === "string" &&
  value.length <= max &&
  // eslint-disable-next-line no-control-regex -- Reject terminal escape and control sequences.
  !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(value)

export function validFunctionLink(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048 || /[^\x21-\x7e]|@/.test(value)) return false
  try {
    const url = new URL(value)
    return (
      url.href === value &&
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
    const item = node as unknown as FunctionUiElement
    const p = item.props
    for (const [key, value] of Object.entries(p)) {
      if (!props[item.type].includes(key)) fail()
      if (key === "options") continue
      if (key === "props" && item.type === "Client") continue
      if (
        ["bold", "italic", "underline", "strikethrough", "dimColor"].includes(key) &&
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
    if (p.wrap !== undefined && !["wrap", "truncate-end"].includes(String(p.wrap))) fail()
    if (["Button", "Input", "Select"].includes(item.type)) {
      if (
        !text(p.key, 256) ||
        !p.key ||
        !isModObject(item.press) ||
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
    if (item.type === "Link" && !validFunctionLink(p.href)) fail()
    if (
      item.type === "Code" &&
      (!text(p.source) ||
        (p.format !== undefined && p.format !== "source") ||
        (p.startLine !== undefined &&
          (!Number.isInteger(p.startLine) || (p.startLine as number) < 1)))
    )
      fail()
    if (["Box", "Text", "Link"].includes(item.type)) {
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
