import { parse, type DefaultTreeAdapterTypes as Tree } from "parse5"
import * as css from "css-tree"
import { designAttr } from "../../../shared/design-node-ids"
import {
  parseDesignEditCommand,
  type DesignEditCommand,
  type DesignEditableDocument,
  type DesignEditableNode
} from "../../../shared/design-edit"
import { installDesignEditDataRuntime } from "../../../shared/design-edit-data"
import {
  elements,
  readTweakDeclaration,
  reconcileTweaks,
  editTweaks,
  effectiveTweaks,
  isTweakValueValid,
  tweakTarget,
  type DesignTweaksState,
  type DesignTweakDeclaration
} from "../../../shared/design-tweaks"
import { inspectDesignDocument } from "../../../shared/design-progressive"
import { sourceHash } from "./document-index"
import {
  indexEditableSource,
  stabilizeEditableSource,
  applySurfaceEdits,
  escapeDesignText,
  type EditRange
} from "./direct-edit-source"

interface DataBinding {
  path: string
  kind: "text" | "record"
  variationId?: string
}
interface EditData {
  data: Record<string, unknown>
  bindings: Record<string, DataBinding>
}
function dataBlock(html: string) {
  const block = elements(parse(html, { sourceCodeLocationInfo: true })).find(
    (el) => el.tagName === "script" && designAttr(el, "type") === "application/design-edit+json"
  )
  if (!block) return null
  try {
    const config = JSON.parse(
      block.childNodes.map((n) => ("value" in n ? n.value : "")).join("")
    ) as EditData
    if (
      !config ||
      !config.data ||
      typeof config.data !== "object" ||
      !config.bindings ||
      typeof config.bindings !== "object"
    )
      return null
    return { block, config }
  } catch {
    return null
  }
}
function pointer(
  data: unknown,
  path: string
): { parent: Record<string, unknown>; key: string; value: unknown } | null {
  if (!/^\/(?:[^/]+\/?)+$/.test(path) || path.length > 1000) return null
  const parts = path
    .slice(1)
    .split("/")
    .map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"))
  if (parts.some((p) => ["__proto__", "prototype", "constructor"].includes(p))) return null
  let parent = data as Record<string, unknown>
  for (const key of parts.slice(0, -1)) {
    if (!parent || typeof parent !== "object" || !Object.hasOwn(parent, key)) return null
    parent = parent[key] as Record<string, unknown>
  }
  const key = parts.at(-1)!
  return parent && typeof parent === "object" && Object.hasOwn(parent, key)
    ? { parent, key, value: parent[key] }
    : null
}
function bindings(html: string): DesignEditableNode[] {
  const parsed = dataBlock(html)
  if (!parsed) return []
  return Object.entries(parsed.config.bindings).flatMap(([key, binding]) => {
    if (
      !/^[a-zA-Z][\w.-]{0,100}$/.test(key) ||
      !binding ||
      !["text", "record"].includes(binding.kind) ||
      typeof binding.path !== "string"
    )
      return []
    const entry = pointer(parsed.config.data, binding.path)
    if (!entry) return []
    const text = binding.kind === "text" && ["string", "number"].includes(typeof entry.value)
    return [
      {
        id: `b_${key}`,
        tagName: "binding",
        label: text ? String(entry.value).slice(0, 65) : key,
        hash: sourceHash(JSON.stringify(entry.value)),
        variationId: binding.variationId ?? null,
        source: "binding" as const,
        text: text ? [{ id: "value", value: String(entry.value), multiline: false }] : [],
        canDelete: binding.kind === "record" && !Array.isArray(entry.parent),
        canStyle: false,
        reason:
          binding.kind === "record" && Array.isArray(entry.parent)
            ? "重复记录请使用以稳定 ID 为键的对象数据"
            : undefined
      }
    ]
  })
}
export function prepareEditableSource(html: string): string {
  return installDesignEditDataRuntime(stabilizeEditableSource(html))
}
export function inspectEditableSource(
  html: string,
  revision: number,
  tweaks?: DesignTweaksState | null
): DesignEditableDocument {
  const index = indexEditableSource(html)
  if (tweaks) {
    const values = effectiveTweaks(tweaks)
    const all = elements(parse(html))
    for (const target of index.targets.values()) {
      if (target.info.source !== "html" || target.info.text.length !== 1) continue
      const el = all.find((e) => designAttr(e, "data-design-node") === target.info.id)
      if (!el) continue
      for (const [key, list] of Object.entries(tweaks.declaration.bindings))
        if (list.some((binding) => binding.type === "text" && matches(el, binding.selector)))
          target.info.text[0].value = String(values[key])
    }
  }
  return {
    revision,
    tweakRevision: tweaks?.revision ?? 0,
    nodes: [...[...index.targets.values()].map((n) => n.info), ...bindings(html)]
  }
}
function updateDeclaration(html: string, declaration: DesignTweakDeclaration | null): string {
  const el = elements(parse(html, { sourceCodeLocationInfo: true })).find(
    (e) => e.tagName === "script" && designAttr(e, "type") === "application/design-tweaks+json"
  )
  if (!el?.sourceCodeLocation?.startTag || !el.sourceCodeLocation.endTag) return html
  const l = el.sourceCodeLocation
  if (!declaration || !Object.keys(declaration.defaults).length)
    return html.slice(0, l.startOffset) + html.slice(l.endOffset)
  return (
    html.slice(0, l.startTag!.endOffset) +
    JSON.stringify(declaration).replace(/</g, "\\u003c") +
    html.slice(l.endTag!.startOffset)
  )
}
const matches = (el: Tree.Element, selector: string) => {
  const target = tweakTarget(selector)
  return !!target && designAttr(el, target.name) === target.value
}
function validateStyle(values: Record<string, string>): string {
  return Object.entries(values)
    .map(([key, value]) => {
      if (/[<>{};]/.test(value) || /expression\s*\(|javascript\s*:|@import/i.test(value))
        throw new Error("样式值无效")
      const ast = css.parse(`${key}:${value}`, { context: "declarationList" })
      if (ast.type !== "DeclarationList" || ast.children.size !== 1) throw new Error("样式声明无效")
      const declaration = ast.children.first
      if (
        !declaration ||
        declaration.type !== "Declaration" ||
        declaration.property !== key ||
        (css.lexer.matchProperty(key, declaration.value).error && !/var\(/.test(value))
      )
        throw new Error(`样式属性无效：${key}`)
      return `${key}:${value}`
    })
    .join(";")
}

export interface DirectEditCandidate {
  html: string
  tweaks: DesignTweaksState | null
  mode: "live" | "reload"
  targetIds: string[]
  summary: string
  touchedTweaks: string[]
}

/** Main-process source mutations only. Renderer HTML, runtime DOM and raw offsets are never accepted. */
export function applyDirectEdit(
  html: string,
  state: DesignTweaksState | null,
  input: unknown
): DirectEditCandidate {
  const command: DesignEditCommand = parseDesignEditCommand(input)
  const index = indexEditableSource(html)
  const data = dataBlock(html)
  const dynamic = new Map(bindings(html).map((n) => [n.id, n]))
  const edits = new Map<number, EditRange[]>()
  const push = (surface: number, edit: EditRange) =>
    edits.set(surface, [...(edits.get(surface) ?? []), edit])
  let declaration = state ? structuredClone(state.declaration) : readTweakDeclaration(html)
  let tweaks = state ? structuredClone(state) : reconcileTweaks(declaration)
  const touchedTweaks = new Set<string>()
  const removed: Array<{ surface: number; start: number; end: number }> = []
  let reload = false
  let dataChanged = false
  const planned = command.operations.map((op) => {
    const target = index.targets.get(op.nodeId)
    const info = target?.info ?? dynamic.get(op.nodeId)
    if (!info || info.hash !== op.expectedHash) throw new Error("元素内容已变化，请重新选择")
    if (command.variationId && info.variationId !== command.variationId)
      throw new Error("目标不属于当前方案")
    return { op, target, info }
  })
  const deletions = planned.filter(({ op }) => op.type === "delete_node")
  for (const { op, target, info } of planned) {
    if (
      target &&
      deletions.some(
        (d) =>
          d.target &&
          d.target !== target &&
          d.target.surface === target.surface &&
          d.target.start <= target.start &&
          d.target.end >= target.end
      )
    ) {
      if (op.type === "delete_node") continue
      throw new Error("不能同时编辑被删除元素的内部内容")
    }
    if (info.source === "binding") {
      if (!data) throw new Error("数据绑定已失效")
      const binding = data.config.bindings[op.nodeId.slice(2)]
      const entry = pointer(data.config.data, binding.path)
      if (!entry) throw new Error("数据记录已变化")
      if (op.type === "set_text" && info.text.length && op.textSlotId === "value")
        entry.parent[entry.key] = op.value
      else if (op.type === "delete_node" && info.canDelete) delete entry.parent[entry.key]
      else throw new Error(info.reason || "此绑定不支持该操作")
      reload = true
      dataChanged = true
      continue
    }
    if (!target) throw new Error("缺少源码映射")
    const surface = index.surfaces[target.surface]
    reload ||= info.source !== "html"
    if (op.type === "set_text") {
      const slot = target.slots.find((t) => t.id === op.textSlotId)
      if (!slot || !info.text.some((t) => t.id === slot.id))
        throw new Error(info.reason || "该文字不能直接编辑")
      push(target.surface, {
        start: slot.start,
        end: slot.end,
        value:
          slot.encoding === "jsx"
            ? `{${JSON.stringify(op.value).replace(/</g, "\\u003c")}}`
            : escapeDesignText(op.value)
      })
      if (info.source === "html" && declaration && tweaks) {
        const el = index.targets.get(op.nodeId)!
        const node = elements(parse(surface.content, { sourceCodeLocationInfo: true })).find(
          (e) => designAttr(e, "data-design-node") === el.info.id
        )!
        for (const [key, list] of Object.entries(declaration.bindings)) {
          const matched = list.filter((b) => b.type === "text" && matches(node, b.selector))
          if (!matched.length) continue
          if (!isTweakValueValid(declaration, key, op.value))
            throw new Error("文案超出参数的类型或长度限制")
          const all = elements(parse(html))
          const count = list
            .filter((b) => b.type === "text")
            .reduce(
              (n, b) =>
                n + all.filter((e) => matches(e, (b as { selector: string }).selector)).length,
              0
            )
          if (count === 1) {
            tweaks = editTweaks(tweaks, {
              scope: "artifact",
              operation: "set",
              baseRevision: tweaks.revision,
              key,
              value: op.value
            })
            touchedTweaks.add(key)
          } else {
            // Detach only this element; the original shared parameter keeps all other bindings.
            const freshKey = `edit_${sourceHash(op.nodeId).slice(7, 23)}`
            const opening = html.slice(target.start, target.openingEnd)
            const patched = opening
              .replace(/\sdata-design-tweak\s*=\s*(?:"[^"]*"|'[^']*')/i, "")
              .replace(/\/?\s*>$/, (end) => ` data-design-tweak="${freshKey}"${end}`)
            push(0, { start: target.start, end: target.openingEnd, value: patched })
            declaration.bindings[key] = list.filter(
              (b) => !matched.includes(b) || (b.type === "text" && !b.selector.startsWith("#"))
            )
            declaration.defaults[freshKey] = op.value
            declaration.schema[freshKey] = {
              ...declaration.schema[key],
              label: `${declaration.schema[key].label}（当前元素）`
            }
            declaration.bindings[freshKey] = [
              { type: "text", selector: `[data-design-tweak='${freshKey}']` }
            ]
            touchedTweaks.add(freshKey)
          }
        }
      }
    } else if (op.type === "delete_node") {
      if (!info.canDelete) throw new Error(info.reason || "此节点不能直接删除")
      if (removed.some((r) => r.surface === target.surface && r.start === target.start)) continue
      if (info.source === "html") {
        const subtree = html.slice(target.start, target.end)
        const ids = elements(parse(subtree))
          .map((e) => designAttr(e, "id"))
          .filter((v): v is string => !!v)
        const outside = html.slice(0, target.start) + html.slice(target.end)
        for (const id of ids) {
          const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
          if (
            new RegExp(
              `(?:getElementById\\(\\s*['"]${escaped}['"]|querySelector(?:All)?\\(\\s*['"]#${escaped}['"]|(?:for|aria-labelledby|aria-describedby)=["']${escaped}["'])`
            ).test(outside)
          )
            throw new Error(`此区域被脚本或表单引用（${id}），请通过 AI 结构改稿处理依赖`)
        }
      }
      push(target.surface, { start: target.start, end: target.end, value: target.deleteValue })
      removed.push({ surface: target.surface, start: target.start, end: target.end })
    } else {
      if (!info.canStyle) throw new Error("此动态节点的样式请通过组件属性或 AI 修改")
      const declarations = validateStyle(op.declarations)
      const opening = surface.content.slice(target.start, target.openingEnd)
      const old = opening.match(/\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/i)
      const existing = (old?.[1] ?? old?.[2] ?? "").replace(/&quot;/g, '"').replace(/&amp;/g, "&")
      const tree = css.parse(existing, { context: "declarationList" })
      const values = new Map<string, string>()
      if (tree.type === "DeclarationList")
        tree.children.forEach((n) => {
          if (n.type === "Declaration")
            values.set(n.property, css.generate(n.value) + (n.important ? "!important" : ""))
        })
      for (const [key, value] of Object.entries(op.declarations))
        values.set(
          key,
          value +
            (/!important\s*$/.test(values.get(key) ?? "") && !/!important\s*$/.test(value)
              ? "!important"
              : "")
        )
      void declarations
      const style = [...values]
        .map(([k, v]) => `${k}:${v}`)
        .join(";")
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
      const patched = old
        ? opening.replace(old[0], ` style="${style}"`)
        : opening.replace(/\/?\s*>$/, (end) => ` style="${style}"${end}`)
      push(target.surface, { start: target.start, end: target.openingEnd, value: patched })
    }
  }
  if (
    dataChanged &&
    data?.block.sourceCodeLocation?.startTag &&
    data.block.sourceCodeLocation.endTag
  ) {
    push(0, {
      start: data.block.sourceCodeLocation.startTag.endOffset,
      end: data.block.sourceCodeLocation.endTag.startOffset,
      value: JSON.stringify(data.config).replace(/</g, "\\u003c")
    })
  }
  let candidate = applySurfaceEdits(index, edits)
  if (declaration) {
    const remaining = elements(parse(candidate))
    for (const [key, list] of Object.entries(declaration.bindings)) {
      const keep = list.filter(
        (b) => b.type === "css-var" || remaining.some((e) => matches(e, b.selector))
      )
      if (keep.length !== list.length) {
        declaration.bindings[key] = keep
        touchedTweaks.add(key)
      }
      if (!keep.length) {
        delete declaration.bindings[key]
        delete declaration.defaults[key]
        delete declaration.schema[key]
      }
    }
    if (!Object.keys(declaration.defaults).length) declaration = null
    candidate = updateDeclaration(candidate, declaration)
    const old = tweaks
    tweaks = reconcileTweaks(declaration, tweaks)
    if (tweaks && old)
      for (const key of touchedTweaks) {
        if (
          Object.hasOwn(old.overrides, key) &&
          isTweakValueValid(tweaks.declaration, key, old.overrides[key])
        )
          tweaks.overrides[key] = old.overrides[key]
      }
    if (
      sourceHash(JSON.stringify(state?.declaration ?? null)) !==
      sourceHash(JSON.stringify(declaration))
    )
      reload = true
  }
  const inspection = inspectDesignDocument(candidate)
  if (!inspection.finalizable) throw new Error(inspection.issues.join("；") || "页面结构不完整")
  indexEditableSource(candidate)
  const labels = command.operations.map((op) =>
    op.type === "delete_node" ? "删除元素" : op.type === "set_text" ? "修改文字" : "修改样式"
  )
  return {
    html: candidate,
    tweaks,
    mode: reload ? "reload" : "live",
    targetIds: command.operations.map((op) => op.nodeId),
    summary: [...new Set(labels)].join("、"),
    touchedTweaks: [...touchedTweaks]
  }
}

export function directEditValues(state: DesignTweaksState | null) {
  return state ? effectiveTweaks(state) : {}
}
