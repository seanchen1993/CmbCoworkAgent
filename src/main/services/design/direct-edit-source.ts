import { parse, parseFragment, type DefaultTreeAdapterTypes as Tree } from "parse5"
import ts from "typescript"
import { designAttr, designSourceNodes } from "../../../shared/design-node-ids"
import { elements } from "../../../shared/design-tweaks"
import { sourceHash } from "./document-index"
import type { DesignEditableNode } from "../../../shared/design-edit"

export interface EditRange {
  start: number
  end: number
  value: string
}
export function replaceEditRanges(source: string, ranges: EditRange[]): string {
  const ordered = [...ranges].sort((a, b) => b.start - a.start)
  let boundary = source.length + 1
  for (const edit of ordered) {
    if (edit.end > boundary || edit.start < 0 || edit.end < edit.start)
      throw new Error("编辑范围重叠")
    source = source.slice(0, edit.start) + edit.value + source.slice(edit.end)
    boundary = edit.start
  }
  return source
}
export const escapeDesignText = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
const textValue = (node: Tree.Node): string =>
  "value" in node ? node.value : "childNodes" in node ? node.childNodes.map(textValue).join("") : ""

export interface EditSourceTarget {
  info: DesignEditableNode
  surface: number
  start: number
  end: number
  openingEnd: number
  slots: Array<{ id: string; start: number; end: number; encoding: "html" | "jsx" }>
  deleteValue: string
}
export interface EditSurface {
  kind: "html" | "jsx" | "vue"
  content: string
  start: number
  end: number
  literal?: boolean
}
export interface EditSourceIndex {
  html: string
  surfaces: EditSurface[]
  targets: Map<string, EditSourceTarget>
}

function jsxFile(source: string) {
  return ts.createSourceFile("design.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
}
function walkTs(node: ts.Node, visit: (node: ts.Node) => void) {
  visit(node)
  ts.forEachChild(node, (child) => walkTs(child, visit))
}
function jsxName(node: ts.JsxOpeningLikeElement): string {
  return node.tagName.getText()
}
function jsxId(node: ts.JsxOpeningLikeElement): string | undefined {
  const attr = node.attributes.properties.find(
    (p) => ts.isJsxAttribute(p) && p.name.getText() === "data-design-node"
  )
  return attr && ts.isJsxAttribute(attr) && attr.initializer && ts.isStringLiteral(attr.initializer)
    ? attr.initializer.text
    : undefined
}
function jsxText(value: string): string {
  const lines = textValue(parseFragment(value)).replace(/\r/g, "").split("\n")
  return lines
    .map((line, i) => {
      let text = line.replace(/\t/g, " ")
      if (i) text = text.replace(/^ +/, "")
      if (i !== lines.length - 1) text = text.replace(/ +$/, "")
      return (
        text + (text && i < lines.length - 1 && lines.slice(i + 1).some((l) => l.trim()) ? " " : "")
      )
    })
    .join("")
}

/** Source surfaces retain original HTML, inline JSX and Vue template literals separately. */
export function editSurfaces(html: string): EditSurface[] {
  const surfaces: EditSurface[] = [{ kind: "html", content: html, start: 0, end: html.length }]
  for (const el of elements(parse(html, { sourceCodeLocationInfo: true }))) {
    const loc = el.sourceCodeLocation
    if (!loc?.startTag || !loc.endTag) continue
    if (
      el.tagName === "template" ||
      (el.tagName === "script" && /(?:x-template|text\/html)/.test(designAttr(el, "type") ?? ""))
    ) {
      surfaces.push({
        kind: "vue",
        content: html.slice(loc.startTag.endOffset, loc.endTag.startOffset),
        start: loc.startTag.endOffset,
        end: loc.endTag.startOffset
      })
    } else if (
      el.tagName === "script" &&
      !designAttr(el, "src") &&
      !/json/.test(designAttr(el, "type") ?? "")
    ) {
      const content = html.slice(loc.startTag.endOffset, loc.endTag.startOffset)
      if (/text\/(babel|jsx|tsx)/.test(designAttr(el, "type") ?? "")) {
        surfaces.push({
          kind: "jsx",
          content,
          start: loc.startTag.endOffset,
          end: loc.endTag.startOffset
        })
      }
      const file = jsxFile(content)
      walkTs(file, (n) => {
        if (
          !ts.isPropertyAssignment(n) ||
          n.name.getText(file).replace(/['"]/g, "") !== "template" ||
          !(ts.isStringLiteral(n.initializer) || ts.isNoSubstitutionTemplateLiteral(n.initializer))
        )
          return
        const literal = n.initializer
        surfaces.push({
          kind: "vue",
          content: literal.text,
          start: loc.startTag!.endOffset + literal.getStart(file),
          end: loc.startTag!.endOffset + literal.end,
          literal: true
        })
      })
    }
  }
  return surfaces
}

/** Persist IDs once; subsequent structural edits cannot renumber surviving siblings. */
export function stabilizeEditableSource(html: string): string {
  const surfaces = editSurfaces(html)
  const edits: EditRange[] = []
  for (let s = 0; s < surfaces.length; s++) {
    const surface = surfaces[s]
    const local: EditRange[] = []
    if (surface.kind === "jsx") {
      let count = 0
      const file = jsxFile(surface.content)
      const reserved = new Set<string>()
      walkTs(file, (node) => {
        if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
          const id = jsxId(node)
          if (id) reserved.add(id)
        }
      })
      walkTs(file, (n) => {
        if (
          !(ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) ||
          !/^[a-z]/.test(jsxName(n))
        )
          return
        count++
        if (jsxId(n)) return
        const offset = n.end - (ts.isJsxSelfClosingElement(n) ? 2 : 1)
        let id = `j_${s}_${count}`
        while (reserved.has(id)) id += "_new"
        reserved.add(id)
        local.push({ start: offset, end: offset, value: ` data-design-node="${id}"` })
      })
    } else {
      for (const node of designSourceNodes(surface.content)) {
        if (designAttr(node.element, "data-design-node")) continue
        const loc = node.element.sourceCodeLocation!.startTag!
        const offset = loc.endOffset - (surface.content[loc.endOffset - 2] === "/" ? 2 : 1)
        local.push({
          start: offset,
          end: offset,
          value: ` data-design-node="${s ? `v_${s}_` : ""}${node.id}"`
        })
      }
    }
    if (!local.length) continue
    if (s === 0) edits.push(...local)
    else {
      // Vue literals inside JSX are not a supported mixed-source surface.
      if (
        surfaces.some(
          (parent, i) =>
            i > 0 && i !== s && parent.start <= surface.start && parent.end >= surface.end
        )
      )
        continue
      const value = replaceEditRanges(surface.content, local)
      edits.push({
        start: surface.start,
        end: surface.end,
        value: surface.literal ? JSON.stringify(value).replace(/</g, "\\u003c") : value
      })
    }
  }
  return replaceEditRanges(html, edits)
}

export function indexEditableSource(html: string): EditSourceIndex {
  const surfaces = editSurfaces(html)
  const targets = new Map<string, EditSourceTarget>()
  const add = (target: EditSourceTarget) => {
    if (targets.has(target.info.id)) throw new Error("编辑节点身份重复")
    targets.set(target.info.id, target)
  }
  for (let s = 0; s < surfaces.length; s++) {
    const surface = surfaces[s]
    if (surface.kind !== "jsx") {
      for (const node of designSourceNodes(surface.content)) {
        const el = node.element
        const slots = el.childNodes.flatMap((child, i) => {
          if (child.nodeName !== "#text" || !child.sourceCodeLocation || !textValue(child).trim())
            return []
          const value = textValue(child)
          if (/\{\{|\}\}/.test(value)) return []
          return [
            {
              id: `t${i}`,
              start: child.sourceCodeLocation.startOffset,
              end: child.sourceCodeLocation.endOffset,
              encoding: "html" as const,
              value
            }
          ]
        })
        if (
          !slots.length &&
          !el.childNodes.some((child) => "tagName" in child) &&
          el.sourceCodeLocation?.endTag &&
          !/^(svg|path|input|textarea|select|canvas|video|audio)$/.test(el.tagName) &&
          !/\{\{/.test(textValue(el))
        )
          slots.push({
            id: "empty",
            start: el.sourceCodeLocation.startTag!.endOffset,
            end: el.sourceCodeLocation.endTag.startOffset,
            encoding: "html",
            value: textValue(el)
          })
        const hasCode = elements(el).some((e) =>
          ["script", "style", "iframe", "object", "embed", "template"].includes(e.tagName)
        )
        let repeatedAncestor = false
        let ancestor: Tree.Node | null = el.parentNode
        while (ancestor) {
          if ("tagName" in ancestor && ancestor.attrs.some((a) => a.name === "v-for"))
            repeatedAncestor = true
          ancestor = "parentNode" in ancestor ? ancestor.parentNode : null
        }
        const dynamic =
          repeatedAncestor || elements(el).some((e) => e.attrs.some((a) => /^v-for$/.test(a.name)))
        const mounts = [...html.matchAll(/\.mount\(\s*['"]#([\w-]+)['"]\s*\)/g)].map((m) => m[1])
        let inVueMount = false
        let owner: Tree.Node | null = el
        while (owner) {
          if ("tagName" in owner && mounts.includes(designAttr(owner, "id") ?? ""))
            inVueMount = true
          owner = "parentNode" in owner ? owner.parentNode : null
        }
        const runtime =
          s === 0 &&
          el.attrs.some((a) => a.name === "id") &&
          /ReactDOM|createRoot|createApp/.test(html) &&
          (mounts.includes(designAttr(el, "id") ?? "") ||
            !el.childNodes.some((n) => "tagName" in n || textValue(n).trim()))
        const info: DesignEditableNode = {
          id: node.id,
          parentId: node.parentId,
          tagName: el.tagName,
          label: (designAttr(el, "aria-label") || textValue(el).trim() || el.tagName).slice(0, 65),
          hash: sourceHash(surface.content.slice(node.start, node.end)),
          variationId: node.variationId,
          source: inVueMount ? "vue" : surface.kind,
          text: dynamic
            ? []
            : slots.map((t) => ({ id: t.id, value: t.value, multiline: el.tagName === "pre" })),
          canDelete: !hasCode && !dynamic && !runtime,
          canStyle: surface.kind === "html" && !runtime,
          reason: dynamic
            ? "重复模板请使用实例数据绑定后编辑"
            : hasCode || runtime
              ? "此节点包含应用或运行代码，请选择内部内容"
              : undefined
        }
        add({
          info,
          surface: s,
          start: node.start,
          end: node.end,
          openingEnd: el.sourceCodeLocation!.startTag!.endOffset,
          slots,
          deleteValue: ""
        })
      }
    } else {
      const file = jsxFile(surface.content)
      walkTs(file, (n) => {
        if (!(ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n))) return
        const opening = ts.isJsxElement(n) ? n.openingElement : n
        const id = jsxId(opening)
        if (!id) return
        let parent = n.parent
        let parentId: string | undefined
        let repeated = false
        while (parent && !ts.isSourceFile(parent)) {
          if (
            ts.isCallExpression(parent) &&
            /\.(map|flatMap)\s*$/.test(parent.expression.getText(file))
          )
            repeated = true
          if (!parentId && ts.isJsxElement(parent)) parentId = jsxId(parent.openingElement)
          parent = parent.parent
        }
        const children = ts.isJsxElement(n) ? [...n.children] : []
        const slots = children.flatMap((child, i) => {
          if (ts.isJsxText(child) && jsxText(child.text).trim())
            return [
              {
                id: `t${i}`,
                start: child.pos,
                end: child.end,
                encoding: "jsx" as const,
                value: jsxText(child.text)
              }
            ]
          if (
            ts.isJsxExpression(child) &&
            child.expression &&
            ts.isStringLiteralLike(child.expression)
          )
            return [
              {
                id: `t${i}`,
                start: child.getStart(file),
                end: child.end,
                encoding: "jsx" as const,
                value: child.expression.text
              }
            ]
          return []
        })
        const start = n.getStart(file)
        const tagName = jsxName(opening)
        const info: DesignEditableNode = {
          id,
          parentId,
          tagName,
          label:
            slots
              .map((t) => t.value)
              .join(" ")
              .slice(0, 65) || tagName,
          hash: sourceHash(surface.content.slice(start, n.end)),
          variationId: null,
          source: "jsx",
          text: repeated ? [] : slots.map((t) => ({ id: t.id, value: t.value, multiline: false })),
          canDelete: !repeated,
          canStyle: false,
          reason: repeated ? "重复组件请使用实例数据绑定后编辑" : undefined
        }
        const inJsxChildren = ts.isJsxElement(n.parent) || ts.isJsxFragment(n.parent)
        add({
          info,
          surface: s,
          start,
          end: n.end,
          openingEnd: opening.end,
          slots,
          deleteValue: inJsxChildren ? "" : "null"
        })
      })
    }
  }
  return { html, surfaces, targets }
}

export function applySurfaceEdits(index: EditSourceIndex, edits: Map<number, EditRange[]>): string {
  const outer = edits.get(0) ?? []
  for (const [s, ranges] of edits) {
    if (!s) continue
    const surface = index.surfaces[s]
    const content = replaceEditRanges(surface.content, ranges)
    if (surface.kind === "jsx") {
      const errors = (jsxFile(content) as ts.SourceFile & { parseDiagnostics?: ts.Diagnostic[] })
        .parseDiagnostics
      if (errors?.length) throw new Error("编辑后 JSX 语法无效")
    }
    outer.push({
      start: surface.start,
      end: surface.end,
      value: surface.literal ? JSON.stringify(content).replace(/</g, "\\u003c") : content
    })
  }
  return replaceEditRanges(index.html, outer)
}
