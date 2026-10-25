import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { parse } from "parse5"
import * as css from "css-tree"
import { elements, attribute } from "../../../shared/design-tweaks"
import {
  designSourceNodes,
  designAttr,
  type DesignSourceNode
} from "../../../shared/design-node-ids"

export const sourceHash = (text: string): string =>
  `sha256:${createHash("sha256").update(text).digest("hex")}`
export interface IndexedCssRule {
  id: string
  text: string
  tokens: string[]
  vars: string[]
  definitions: string[]
}
export interface DesignDocumentIndex {
  html: string
  hash: string
  nodes: Map<string, DesignSourceNode>
  rules: IndexedCssRule[]
  unresolved: string[]
  externalFiles: Record<string, string>
}

/** CSS is parsed once per source revision. Unsupported selectors remain conservative references. */
export function indexCss(text: string, prefix: string): IndexedCssRule[] {
  const tree = css.parse(text, { positions: true })
  const rules: IndexedCssRule[] = []
  const conditions: string[] = []
  const globals = new Set(["font-face", "keyframes", "-webkit-keyframes", "property"])
  let inGlobal = 0
  css.walk(tree, {
    enter(node) {
      if (node.type === "Atrule") {
        if (node.name === "import")
          rules.push({
            id: `${prefix}:${rules.length}`,
            text: css.generate(node),
            tokens: ["*dependency*"],
            vars: [],
            definitions: []
          })
        if (globals.has(node.name)) {
          if (!inGlobal)
            rules.push({
              id: `${prefix}:${rules.length}`,
              text: css.generate(node),
              tokens: ["*dependency*"],
              vars: [],
              definitions: []
            })
          inGlobal++
        } else if (node.block)
          conditions.push(`@${node.name}${node.prelude ? " " + css.generate(node.prelude) : ""}`)
      }
      if (node.type !== "Rule" || inGlobal) return
      const tokens: string[] = []
      const definitions: string[] = []
      css.walk(node.prelude, (part) => {
        if (part.type === "ClassSelector") tokens.push(`.${part.name}`)
        else if (part.type === "IdSelector") tokens.push(`#${part.name}`)
        else if (part.type === "TypeSelector") tokens.push(part.name)
        else if (part.type === "AttributeSelector") tokens.push(`[${css.generate(part.name)}]`)
        else if (part.type === "PseudoClassSelector" && ["root", "has"].includes(part.name))
          tokens.push("*")
        else if (part.type === "Raw") tokens.push("*")
      })
      css.walk(node.block, (part) => {
        if (part.type === "Declaration" && part.property.startsWith("--"))
          definitions.push(part.property)
      })
      const body = css.generate(node)
      rules.push({
        id: `${prefix}:${rules.length}`,
        text: conditions.reduceRight((s, c) => `${c}{${s}}`, body),
        tokens,
        vars: [...body.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]),
        definitions
      })
    },
    leave(node) {
      if (node.type === "Atrule") {
        if (globals.has(node.name)) inGlobal--
        else if (node.block) conditions.pop()
      }
    }
  })
  return rules
}

const cache = new Map<string, DesignDocumentIndex>()
export function indexDesignDocument(
  html: string,
  artifactPath?: string | null,
  workspacePath?: string | null
): DesignDocumentIndex {
  const hash = sourceHash(html)
  // External styles can change independently, so only cache self-contained documents.
  const key = !/<link\b|@import/i.test(html) ? hash : ""
  if (key && cache.has(key)) return cache.get(key)!
  const result: DesignDocumentIndex = {
    html,
    hash,
    nodes: new Map(designSourceNodes(html).map((n) => [n.id, n])),
    rules: [],
    unresolved: [],
    externalFiles: {}
  }
  const all = elements(parse(html, { sourceCodeLocationInfo: true }))
  const visited = new Set<string>()
  const readCss = (href: string, base: string, depth: number): void => {
    if (depth > 3 || /^(?:[a-z]+:|\/\/|#)/i.test(href)) {
      result.unresolved.push(href)
      return
    }
    try {
      const file = fs.realpathSync(path.resolve(base, decodeURIComponent(href.split(/[?#]/)[0])))
      const root = fs.realpathSync(workspacePath || base)
      if (
        path.relative(root, file).startsWith("..") ||
        path.isAbsolute(path.relative(root, file)) ||
        fs.statSync(file).size > 256_000
      )
        throw new Error("CSS outside scope")
      if (visited.has(file)) return
      visited.add(file)
      const content = fs.readFileSync(file, "utf8")
      result.externalFiles[path.resolve(base, decodeURIComponent(href.split(/[?#]/)[0]))] =
        sourceHash(content)
      parseCss(content, file, path.dirname(file), depth)
    } catch {
      result.unresolved.push(href)
    }
  }
  const parseCss = (text: string, id: string, base: string, depth: number) => {
    try {
      result.rules.push(...indexCss(text, id))
      const tree = css.parse(text)
      css.walk(tree, (node) => {
        if (node.type !== "Atrule" || node.name !== "import" || !node.prelude) return
        let href: string | undefined
        css.walk(node.prelude, (n) => {
          if (!href && (n.type === "Url" || n.type === "String")) href = n.value
        })
        if (href) readCss(href, base, depth + 1)
      })
    } catch {
      result.unresolved.push(`CSS 无法解析：${id}`)
    }
  }
  for (const el of all) {
    if (el.tagName === "style")
      parseCss(
        el.childNodes.map((n) => ("value" in n ? n.value : "")).join(""),
        `inline-${result.rules.length}`,
        artifactPath ? path.dirname(artifactPath) : workspacePath || "",
        0
      )
    if (el.tagName === "link" && attribute(el, "rel") === "stylesheet")
      readCss(
        attribute(el, "href") || "",
        artifactPath ? path.dirname(artifactPath) : workspacePath || "",
        0
      )
  }
  if (key) {
    if (cache.size >= 8) cache.delete(cache.keys().next().value!)
    cache.set(key, result)
  }
  return result
}

export function nodeText(node: DesignSourceNode): string {
  const text = (n: typeof node.element | (typeof node.element.childNodes)[number]): string =>
    "tagName" in n && ["script", "style", "template", "noscript"].includes(n.tagName)
      ? ""
      : "value" in n
        ? n.value
        : "childNodes" in n
          ? n.childNodes.map((c) => text(c)).join(" ")
          : ""
  return text(node.element).replace(/\s+/g, " ").trim()
}
export function verifyDesignPatchDependencies(files: Record<string, string>): void {
  for (const [file, hash] of Object.entries(files)) {
    if (!fs.existsSync(file) || sourceHash(fs.readFileSync(file, "utf8")) !== hash)
      throw new Error("引用的样式文件已变化，请重新提交修改")
  }
}
export function nodeTokens(node: DesignSourceNode): string[] {
  return [
    node.element.tagName,
    ...node.element.attrs.map((a) => `[${a.name}]`),
    ...(designAttr(node.element, "class") || "")
      .split(/\s+/)
      .filter(Boolean)
      .map((c) => `.${c}`),
    ...(designAttr(node.element, "id") ? [`#${designAttr(node.element, "id")}`] : [])
  ]
}
