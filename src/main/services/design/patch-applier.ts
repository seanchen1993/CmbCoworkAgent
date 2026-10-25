import { parse, parseFragment, serializeOuter, type DefaultTreeAdapterTypes as Tree } from "parse5"
import * as css from "css-tree"
import { randomUUID } from "node:crypto"
import { designAttr, designSourceNodes } from "../../../shared/design-node-ids"
import {
  parseDesignPatch,
  type DesignAppliedPatch,
  type DesignPatchProposal
} from "../../../shared/design-patch"
import {
  elements,
  editTweaks,
  effectiveTweaks,
  tweakSourceIssues,
  type DesignTweaksState,
  type TweakValues
} from "../../../shared/design-tweaks"
import { inspectDesignDocument } from "../../../shared/design-progressive"
import { sourceHash } from "./document-index"
import type { PreparedPatchContext } from "./patch-context"
import type { DesignStyleCheck } from "./artifact-validator"

export interface AppliedDesignCandidate {
  validationLevel: "source" | "layout" | "interaction"
  allowedIds: string[]
  externalFiles: Record<string, string>
  styleChecks: DesignStyleCheck[]
  html: string
  tweaks: DesignTweaksState | null
  patch: DesignAppliedPatch
  baseSourceHash: string
  baseTweakRevision: number
  tweakReads: TweakValues
  tweakUpdates: TweakValues
}
function setAttr(el: Tree.Element, name: string, value: string) {
  const attr = el.attrs.find((a) => a.name === name)
  if (attr) attr.value = value
  else el.attrs.push({ name, value })
}
function declarations(text: string): Map<string, { value: string; important: boolean }> {
  const result = new Map<string, { value: string; important: boolean }>()
  const tree = css.parse(text, { context: "declarationList" })
  if (tree.type !== "DeclarationList") throw new Error("CSS 声明无效")
  tree.children.forEach((node) => {
    if (node.type !== "Declaration") throw new Error("CSS 包含非声明内容")
    result.set(node.property, { value: css.generate(node.value), important: !!node.important })
  })
  return result
}
function safeDeclarations(
  values: Record<string, string>
): Map<string, { value: string; important: boolean }> {
  const result = new Map<string, { value: string; important: boolean }>()
  for (const [property, value] of Object.entries(values)) {
    if (/[<>{}]/.test(value) || /expression\s*\(|javascript\s*:|@import/i.test(value))
      throw new Error("样式值包含不支持的内容")
    const parsed = declarations(`${property}:${value}`)
    if (parsed.size !== 1 || !parsed.has(property)) throw new Error("每个样式值必须只包含一个声明")
    const entry = parsed.get(property)!
    const match = css.lexer.matchProperty(property, entry.value)
    if (match.error && !/var\(/.test(entry.value)) throw new Error(`CSS 属性值无效：${property}`)
    result.set(property, entry)
  }
  return result
}
const printDeclarations = (values: Map<string, { value: string; important: boolean }>) =>
  [...values].map(([key, v]) => `${key}:${v.value}${v.important ? "!important" : ""}`).join(";")

function protectFragment(before: Tree.Element, after: Tree.Element, scripts: string): void {
  const protectedAttrs = (el: Tree.Element) =>
    el.attrs.filter(
      (a) =>
        a.name === "id" ||
        a.name === "name" ||
        a.name.startsWith("data-") ||
        a.name.startsWith("on") ||
        (a.name === "class" && /querySelector|getElementsByClassName/.test(scripts))
    )
  const old = elements(before).filter((el) => protectedAttrs(el).length)
  const fresh = elements(after)
  const consumed = new Set<Tree.Element>()
  for (const el of old) {
    const attrs = protectedAttrs(el)
    const match = fresh.find(
      (candidate) =>
        !consumed.has(candidate) &&
        candidate.tagName === el.tagName &&
        attrs.every((a) => designAttr(candidate, a.name) === a.value)
    )
    if (!match) throw new Error("结构补丁删除了业务标识、事件或参数绑定，需要完整改稿")
    consumed.add(match)
  }
}

export function validatePatchDocument(before: string, html: string): void {
  const inspection = inspectDesignDocument(html)
  if (!inspection.finalizable) throw new Error(inspection.issues.join("；") || "页面包含未完成区块")
  const doc = parse(html)
  const all = elements(doc)
  const ids = all.map((e) => designAttr(e, "id")).filter(Boolean)
  if (new Set(ids).size !== ids.length) throw new Error("补丁产生重复业务 ID")
  const issues = tweakSourceIssues(html)
  if (issues.length) throw new Error(issues.join("；"))
  // Script source must remain byte-identical; local operations cannot alter executable behavior.
  const scripts = (source: string) =>
    elements(parse(source, { sourceCodeLocationInfo: true }))
      .filter((e) => e.tagName === "script")
      .map((e) => source.slice(e.sourceCodeLocation!.startOffset, e.sourceCodeLocation!.endOffset))
  if (JSON.stringify(scripts(before)) !== JSON.stringify(scripts(html)))
    throw new Error("局部补丁不允许改写脚本")
  designSourceNodes(html)
}

export function applyDesignPatch(
  prepared: PreparedPatchContext,
  input: unknown
): AppliedDesignCandidate {
  const proposal: DesignPatchProposal = parseDesignPatch(input)
  if (
    proposal.contextId !== prepared.public.contextId ||
    proposal.baseArtifactRevision !== prepared.public.baseArtifactRevision
  )
    throw new Error("补丁上下文或版本不匹配")
  const html = prepared.index.html
  // Never mutate cached AST nodes: each candidate gets an isolated source tree.
  const nodes = new Map(designSourceNodes(html).map((n) => [n.id, n]))
  let tweaks = prepared.tweaks ? structuredClone(prepared.tweaks) : null
  const changed = new Set<string>()
  const styleEdits = new Map<string, string>()
  const replaced: Array<{ start: number; end: number }> = []
  let structural = false
  let layout = false
  const tweakUpdates: TweakValues = {}
  const styleChecks: DesignStyleCheck[] = []
  for (const op of proposal.operations) {
    if (op.op === "set_tweak") {
      if (!tweaks || !prepared.allowedTweaks.has(op.key))
        throw new Error("该参数影响授权范围以外的元素")
      tweaks = editTweaks(tweaks, {
        scope: "artifact",
        baseRevision: tweaks.revision,
        operation: "set",
        key: op.key,
        value: op.value
      })
      tweakUpdates[op.key] = op.value
      layout = true
      continue
    }
    const node = nodes.get(op.targetId)
    if (!node || !prepared.allowed.has(node.id)) throw new Error("补丁超出目标范围")
    if (sourceHash(html.slice(node.start, node.end)) !== op.expectedHash)
      throw new Error("目标内容已变化")
    if (replaced.some((r) => node.start >= r.start && node.end <= r.end))
      throw new Error("结构替换与其他操作重叠")
    const el = node.element
    changed.add(node.id)
    if (op.op === "set_text") {
      layout = true
      if (
        /^(input|img|br|hr|source|wbr|area|col|embed|link|meta|param|track|base)$/.test(el.tagName)
      )
        throw new Error("该节点不能承载文字，请修改其相应属性或选择文字节点")
      if (el.childNodes.some((n) => "tagName" in n))
        throw new Error("只能直接修改叶子文案，请选择内部文字节点")
      const bound = prepared.public.tweaks.find((t) =>
        (t.bindings as Array<{ type: string; selector?: string }>).some(
          (b) =>
            b.type === "text" &&
            b.selector &&
            ((b.selector.startsWith("#") && designAttr(el, "id") === b.selector.slice(1)) ||
              b.selector.includes(`'${designAttr(el, "data-design-tweak")}'`))
        )
      )
      if (bound) throw new Error("此文案受参数控制，请提交 set_tweak")
      el.childNodes = [{ nodeName: "#text", value: op.text, parentNode: el }]
    } else if (op.op === "set_attribute") {
      layout = true
      if (
        !/^(alt|title|aria-label|aria-description|aria-expanded|aria-hidden|placeholder|href|src)$/.test(
          op.name
        )
      )
        throw new Error("该属性不允许局部修改")
      if (
        (op.name === "placeholder" && !["input", "textarea"].includes(el.tagName)) ||
        (op.name === "alt" && !["img", "input", "area"].includes(el.tagName)) ||
        (op.name === "href" && !["a", "area"].includes(el.tagName)) ||
        (op.name === "src" &&
          !["img", "source", "audio", "video", "track", "input"].includes(el.tagName))
      )
        throw new Error("该属性不适用于目标节点")
      if (
        ["href", "src"].includes(op.name) &&
        (/^\s*(?:javascript|data|vbscript):/i.test(op.value) ||
          /[<>]/.test(op.value) ||
          [...op.value].some((c) => c.charCodeAt(0) < 32))
      )
        throw new Error("资源或链接地址无效")
      setAttr(el, op.name, op.value)
    } else if (op.op === "set_style") {
      for (const [property, value] of Object.entries(op.declarations))
        styleChecks.push({
          targetId: node.id,
          property,
          value,
          state: op.state,
          maxWidth: op.maxWidth
        })
      if (
        op.state ||
        op.maxWidth ||
        Object.keys(op.declarations).some(
          (p) =>
            !/^(color|background-color|border(?:-(?:top|right|bottom|left))?-color|border-radius|opacity|box-shadow|text-shadow)$/.test(
              p
            )
        )
      )
        layout = true
      const values = safeDeclarations(op.declarations)
      if (!op.state && !op.maxWidth) {
        const existing = declarations(designAttr(el, "style") || "")
        for (const [p, value] of values)
          existing.set(p, { ...value, important: value.important || !!existing.get(p)?.important })
        setAttr(el, "style", printDeclarations(existing))
      } else {
        setAttr(el, "data-design-node", node.id)
        const styleId = `patch-${node.id}-${op.state ?? "base"}-${op.maxWidth ?? "all"}`
        const existing =
          styleEdits.get(styleId) ||
          elements(parse(html))
            .find((e) => designAttr(e, "data-design-patch-style") === styleId)
            ?.childNodes.map((n) => ("value" in n ? n.value : ""))
            .join("") ||
          ""
        const merged = new Map<string, { value: string; important: boolean }>()
        if (existing)
          css.walk(css.parse(existing.replace(/^<style[^>]*>|<\/style>$/g, "")), (n) => {
            if (n.type === "Declaration")
              merged.set(n.property, { value: css.generate(n.value), important: !!n.important })
          })
        for (const [p, value] of values) merged.set(p, value)
        let body = `[data-design-node="${node.id}"]${op.state ? `:${op.state}` : ""}{${printDeclarations(merged)}}`
        if (op.maxWidth) body = `@media(max-width:${op.maxWidth}px){${body}}`
        styleEdits.set(styleId, `<style data-design-patch-style="${styleId}">${body}</style>`)
      }
    } else {
      if (
        !el.sourceCodeLocation?.endTag ||
        /<(?:\/?(?:html|head|body|script|style|iframe|object|embed|base|link|meta))\b/i.test(
          op.html
        ) ||
        /\son[a-z]+\s*=/i.test(op.html)
      )
        throw new Error("结构片段包含不允许的节点或事件")
      if (elements(el).some((e) => ["script", "style", "iframe"].includes(e.tagName)))
        throw new Error("此区域包含运行代码，需要完整改稿")
      if (
        [...changed].some(
          (id) =>
            id !== node.id && nodes.get(id)!.start >= node.start && nodes.get(id)!.end <= node.end
        )
      )
        throw new Error("结构替换与已修改节点重叠")
      const before = { ...el, childNodes: [...el.childNodes] }
      const parseErrors: string[] = []
      const fragment = parseFragment(el, op.html, { onParseError: (e) => parseErrors.push(e.code) })
      if (parseErrors.length) throw new Error(`结构片段无法完整解析：${parseErrors.join(",")}`)
      el.childNodes = fragment.childNodes
      for (const child of el.childNodes) child.parentNode = el
      if (
        elements(el).some((e) =>
          e.attrs.some(
            (a) =>
              a.name.startsWith("on") ||
              (/^(href|src|action|formaction|poster|background|data)$/.test(a.name) &&
                /^\s*(?:javascript|vbscript|data):/i.test(a.value))
          )
        )
      )
        throw new Error("结构片段不能新增事件处理器")
      for (const e of elements(el))
        if (designAttr(e, "style")) {
          const values = declarations(designAttr(e, "style")!)
          if (
            [...values.values()].some((v) => /expression\s*\(|javascript\s*:|[<>]/i.test(v.value))
          )
            throw new Error("结构片段包含不支持的样式")
        }
      protectFragment(before, el, html)
      replaced.push({ start: node.start, end: node.end })
      structural = true
    }
  }
  const roots = [...changed]
    .map((id) => nodes.get(id)!)
    .filter((n, _i, list) => !list.some((p) => p !== n && p.start <= n.start && p.end >= n.end))
  const edits = roots.map((n) => ({ start: n.start, end: n.end, text: serializeOuter(n.element) }))
  const all = elements(parse(html, { sourceCodeLocationInfo: true }))
  for (const [id, text] of styleEdits) {
    const old = all.find((e) => designAttr(e, "data-design-patch-style") === id)
    if (old?.sourceCodeLocation)
      edits.push({
        start: old.sourceCodeLocation.startOffset,
        end: old.sourceCodeLocation.endOffset,
        text
      })
    else {
      const head = all.find((e) => e.tagName === "head")?.sourceCodeLocation?.endTag?.startOffset
      if (head === undefined) throw new Error("页面缺少可写入样式的 head")
      edits.push({ start: head, end: head, text })
    }
  }
  let output = html
  for (const edit of edits.sort((a, b) => b.start - a.start))
    output = output.slice(0, edit.start) + edit.text + output.slice(edit.end)
  validatePatchDocument(html, output)
  return {
    html: output,
    tweaks,
    patch: {
      id: randomUUID(),
      revision: proposal.baseArtifactRevision + 1,
      mode: structural ? "reload" : "live",
      targetIds: [...changed],
      summary: proposal.summary
    },
    validationLevel: structural ? "interaction" : layout ? "layout" : "source",
    allowedIds: [...prepared.allowed],
    externalFiles: prepared.index.externalFiles,
    styleChecks: [
      ...new Map(
        styleChecks.map((c) => [
          `${c.targetId}:${c.state ?? "base"}:${c.maxWidth ?? "all"}:${c.property}`,
          c
        ])
      ).values()
    ],
    baseSourceHash: prepared.index.hash,
    baseTweakRevision: prepared.tweakRevision,
    tweakReads: Object.fromEntries(
      prepared.public.tweaks.map((t) => [t.key, effectiveTweaks(prepared.tweaks!)[t.key]])
    ),
    tweakUpdates
  }
}
