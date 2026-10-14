import type { Element, ElementContent, Nodes as HastNodes, Root, RootContent } from "hast"
import type { Nodes as MdastNodes, Root as MdastRoot } from "mdast"
import remarkGfm from "remark-gfm"
import remarkParse from "remark-parse"
import remarkRehype from "remark-rehype"
import { unified, type Plugin } from "unified"
import { ModFunctionError } from "./contracts"

export const FUNCTION_MARKDOWN_MAX_TEXT = 10000
export const FUNCTION_MARKDOWN_MAX_HREF = 2048
export const FUNCTION_MARKDOWN_MAX_LINKS = 256
/** Parser structure is separate from the outer UI tree's depth and node budgets. */
export const FUNCTION_MARKDOWN_MAX_DEPTH = 128
export const FUNCTION_MARKDOWN_MAX_NODES = 30000
export const FUNCTION_MARKDOWN_MAX_TARGETS = 4096

export interface FunctionMarkdownLeafProps {
  text: string
  key?: string
  dimColor?: boolean
  pressableLinks?: string[]
}

export interface ParsedFunctionMarkdown {
  /** An owned, final HAST tree, never HTML executed or supplied by a plugin. */
  tree: Root
  /** Ordered unique href attributes after the renderer's shared URL transform. */
  hrefs: readonly string[]
}

function invalid(): never {
  throw new ModFunctionError("MODS_UI_MARKDOWN_INVALID")
}

function limit(): never {
  throw new ModFunctionError("MODS_UI_MARKDOWN_LIMIT")
}

const validText = (value: unknown, max: number): value is string =>
  typeof value === "string" &&
  value.length <= max &&
  // eslint-disable-next-line no-control-regex -- Markdown may contain LF/tab, not terminal controls.
  !/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(value)

/** This validates data only. hasPress is supplied by the native callback provenance checker. */
export function validateFunctionMarkdownProps(
  value: unknown,
  hasPress = false
): asserts value is FunctionMarkdownLeafProps {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid()
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) invalid()
  const fields = new Map<string, unknown>()
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !["text", "key", "dimColor", "pressableLinks"].includes(key))
      invalid()
    const field = Object.getOwnPropertyDescriptor(value, key)
    if (!field?.enumerable || !("value" in field)) invalid()
    fields.set(key, field.value)
  }
  if (!fields.has("text") || !validText(fields.get("text"), FUNCTION_MARKDOWN_MAX_TEXT)) invalid()
  if (fields.has("key") && (!validText(fields.get("key"), 256) || !fields.get("key"))) invalid()
  if (fields.has("dimColor") && typeof fields.get("dimColor") !== "boolean") invalid()
  if (hasPress && !fields.has("key")) invalid()
  if (!fields.has("pressableLinks")) return
  const links = fields.get("pressableLinks")
  if (!hasPress || !Array.isArray(links) || links.length > FUNCTION_MARKDOWN_MAX_LINKS) invalid()
  if (Reflect.ownKeys(links).length !== links.length + 1) invalid()
  for (let index = 0; index < links.length; index++) {
    const entry = Object.getOwnPropertyDescriptor(links, String(index))
    if (
      !entry?.enumerable ||
      !("value" in entry) ||
      !validText(entry.value, FUNCTION_MARKDOWN_MAX_HREF) ||
      !entry.value
    )
      invalid()
  }
}

/**
 * This Markdown-only scheme policy does not change Link's existing allowlist.
 * Return the exact HAST href; canonicalization is only a later native permission check.
 */
export function functionMarkdownUrlTransform(value: string, key = "href"): string {
  if (
    key !== "href" ||
    !value ||
    value.length > FUNCTION_MARKDOWN_MAX_HREF ||
    // eslint-disable-next-line no-control-regex -- WHATWG must not silently strip controls or spaces.
    /[\u0000-\u0020\u007f-\u009f]|\\/.test(value)
  )
    return ""
  const web = /^https?:\/\/[^/?#]+(?:[/?#]|$)/i.test(value)
  const file = /^file:\/\/\/(?!\/)/i.test(value)
  if (!web && !file) return ""
  try {
    const url = new URL(value)
    if (url.username || url.password) return ""
    if (web)
      return (url.protocol === "http:" || url.protocol === "https:") &&
        /[a-z0-9]/i.test(url.hostname)
        ? value
        : ""
    // Raw empty authority excludes localhost aliases and UNC before URL normalization.
    return url.protocol === "file:" &&
      !url.hostname &&
      !url.search &&
      !url.hash &&
      url.pathname.startsWith("/") &&
      url.pathname.length > 1 &&
      !/%(?:00|2f|5c)/i.test(value)
      ? value
      : ""
  } catch {
    return ""
  }
}

function assertParserBounds(tree: MdastNodes | HastNodes): void {
  const pending = [{ node: tree, depth: 0 }]
  let nodes = 0
  while (pending.length) {
    const current = pending.pop()
    if (!current) return
    if (++nodes > FUNCTION_MARKDOWN_MAX_NODES || current.depth > FUNCTION_MARKDOWN_MAX_DEPTH)
      limit()
    if ("children" in current.node)
      for (const child of current.node.children)
        pending.push({ node: child, depth: current.depth + 1 })
  }
}

/** Run before remark-rehype in both native parsing and the actual renderer. */
export const functionMarkdownRemark: Plugin<[], MdastRoot> = () => (tree) => {
  assertParserBounds(tree)
}

function normalizeElement(node: Element): ElementContent[] {
  if (node.tagName === "img")
    return [
      { type: "text", value: typeof node.properties.alt === "string" ? node.properties.alt : "" }
    ]
  node.children = node.children.flatMap(normalizeContent)
  if (node.tagName === "a") {
    const href = functionMarkdownUrlTransform(String(node.properties.href || ""))
    if (!href) return node.children
    node.properties.href = href
  }
  return [node]
}

function normalizeContent(node: ElementContent): ElementContent[] {
  if (node.type === "raw") return [{ type: "text", value: node.value }]
  return node.type === "element" ? normalizeElement(node) : [node]
}

/**
 * Run last in the renderer's rehype chain. Raw HTML stays visible as text and no image
 * src reaches a DOM node. Native link membership is derived from this same final HAST.
 */
export const functionMarkdownRehype: Plugin<[], Root> = () => (tree) => {
  assertParserBounds(tree)
  tree.children = tree.children.flatMap<RootContent>((node) => {
    if (node.type === "raw") return [{ type: "text" as const, value: node.value }]
    return node.type === "element" ? normalizeElement(node) : [node]
  })
}

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(functionMarkdownRemark)
  // ReactMarkdown uses this option, then makes raw nodes literal unless skipHtml is set.
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(functionMarkdownRehype)
  .freeze()

/** Parse a bounded leaf without filesystem, network, storage or callback side effects. */
export function parseFunctionMarkdown(text: string): ParsedFunctionMarkdown {
  if (!validText(text, FUNCTION_MARKDOWN_MAX_TEXT)) invalid()
  const tree = processor.runSync(processor.parse(text))
  const hrefs = new Set<string>()
  const pending: HastNodes[] = [tree]
  while (pending.length) {
    const node = pending.pop()
    if (!node) break
    if (
      node.type === "element" &&
      node.tagName === "a" &&
      typeof node.properties.href === "string"
    ) {
      hrefs.add(node.properties.href)
      if (hrefs.size > FUNCTION_MARKDOWN_MAX_TARGETS) limit()
    }
    if ("children" in node)
      for (let index = node.children.length - 1; index >= 0; index--)
        pending.push(node.children[index])
  }
  return { tree, hrefs: Object.freeze([...hrefs]) }
}
