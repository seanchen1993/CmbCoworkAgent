import { randomUUID } from "node:crypto"
import { parse } from "parse5"
import { designAttr, type DesignSourceNode } from "../../../shared/design-node-ids"
import type { DesignPatchRequest, DesignPatchTarget } from "../../../shared/design-patch"
import {
  effectiveTweaks,
  tweakTarget,
  elements,
  type DesignTweaksState
} from "../../../shared/design-tweaks"
import { nodeText, nodeTokens, sourceHash, type DesignDocumentIndex } from "./document-index"

export interface DesignPatchContext {
  protocol: "design-patch/1"
  contextId: string
  baseArtifactRevision: number
  instruction: string
  targets: Array<{
    targetId: string
    sectionId: string
    hash: string
    html: string
    instruction?: string
  }>
  parents: Array<{
    targetId: string
    tag: string
    attributes: Record<string, string>
    siblings: Array<{ targetId: string; tag: string; label: string }>
  }>
  styles: Array<{ resourceId: string; css: string; readOnly: true }>
  tweaks: Array<{
    key: string
    value: unknown
    schema: unknown
    bindings: unknown
    writable: boolean
  }>
  directory: Array<{
    targetId: string
    sectionId: string
    tag: string
    label: string
    hash?: string
    parentId?: string
  }>
  omitted: Array<{ resourceId: string; reason: string }>
  unresolvedDependencies: string[]
  layoutObservations: NonNullable<DesignPatchRequest["observations"]>
  constraints: string[]
}
export interface PreparedPatchContext {
  public: DesignPatchContext
  index: DesignDocumentIndex
  allowed: Set<string>
  roots: DesignSourceNode[]
  allowedTweaks: Set<string>
  tweaks: DesignTweaksState | null
  tweakRevision: number
  variationId: string | null
}
export class DesignPatchScopeError extends Error {}
const MAX_CONTEXT = 48_000

function resolveTarget(
  index: DesignDocumentIndex,
  target: DesignPatchTarget,
  variationId: string | null
): DesignSourceNode {
  let candidates = [...index.nodes.values()].filter(
    (n) => !variationId || n.variationId === variationId
  )
  if (target.nodeId) candidates = candidates.filter((n) => n.id === target.nodeId)
  else if (target.sectionId)
    candidates = candidates.filter(
      (n) => designAttr(n.element, "data-design-section") === target.sectionId
    )
  else if (target.selector?.startsWith("#"))
    candidates = candidates.filter((n) => designAttr(n.element, "id") === target.selector!.slice(1))
  else {
    if (target.tagName) candidates = candidates.filter((n) => n.element.tagName === target.tagName)
    if (target.text)
      candidates = candidates.filter(
        (n) => nodeText(n) === target.text!.replace(/\s+/g, " ").trim()
      )
    else throw new DesignPatchScopeError("无法定位该标记，请重新点击目标元素")
  }
  if (candidates.length !== 1)
    throw new DesignPatchScopeError(
      candidates.length
        ? "目标不唯一，请重新点击需要修改的元素"
        : "目标已变化或由脚本生成，请重新选择目标"
    )
  return candidates[0]
}

export function preparePatchContext(
  index: DesignDocumentIndex,
  instruction: string,
  request: DesignPatchRequest,
  artifactRevision: number,
  tweaks: DesignTweaksState | null
): PreparedPatchContext {
  if (request.artifactRevision !== artifactRevision)
    throw new DesignPatchScopeError("设计版本已更新，请重新提交修改")
  if (
    request.targets.some(
      (t) => t.artifactRevision !== undefined && t.artifactRevision !== artifactRevision
    )
  )
    throw new DesignPatchScopeError("标记属于旧版本，请重新点击目标")
  const scope = [...index.nodes.values()].filter(
    (n) => !request.variationId || n.variationId === request.variationId
  )
  const requested = request.targets.map((t) => ({
    node: resolveTarget(index, t, request.variationId),
    instruction: t.instruction
  }))
  const roots = requested
    .map((r) => r.node)
    .filter(
      (n, i, all) =>
        !all.some(
          (other, j) =>
            j !== i &&
            other.start <= n.start &&
            other.end >= n.end &&
            (other.start !== n.start || j < i)
        )
    )
  const allowed = new Set(
    scope.filter((n) => roots.some((r) => n.start >= r.start && n.end <= r.end)).map((n) => n.id)
  )
  const related = new Map<string, DesignSourceNode>()
  for (const id of allowed) {
    let n = index.nodes.get(id)
    while (n) {
      related.set(n.id, n)
      n = n.parentId ? index.nodes.get(n.parentId) : undefined
    }
  }
  const tokens = new Set([...related.values()].flatMap(nodeTokens))
  const selected = new Map(
    index.rules
      .filter((r) => r.tokens.some((t) => t === "*" || t === "*dependency*" || tokens.has(t)))
      .map((r) => [r.id, r])
  )
  let changed = true
  while (changed) {
    changed = false
    const vars = new Set([...selected.values()].flatMap((r) => r.vars))
    for (const r of index.rules)
      if (!selected.has(r.id) && r.definitions.some((v) => vars.has(v))) {
        selected.set(r.id, r)
        changed = true
      }
  }
  const current = tweaks ? effectiveTweaks(tweaks) : {}
  const relevantTweaks: DesignPatchContext["tweaks"] = []
  const allowedTweaks = new Set<string>()
  for (const [key, bindings] of Object.entries(tweaks?.declaration.bindings ?? {})) {
    const affected = new Set<string>()
    for (const b of bindings) {
      if (b.type === "css-var") {
        // CSS variables are inherited and may serve other sections: only whole-scope ownership permits writes.
        for (const n of index.nodes.values())
          if (
            index.html.slice(n.start, n.end).includes(b.name) ||
            index.rules.some(
              (r) => r.vars.includes(b.name) && r.tokens.some((t) => nodeTokens(n).includes(t))
            )
          )
            affected.add(n.id)
      } else {
        const target = tweakTarget(b.selector)
        if (target)
          for (const n of index.nodes.values())
            if (designAttr(n.element, target.name) === target.value) affected.add(n.id)
      }
    }
    if (!affected.size || ![...affected].some((id) => allowed.has(id))) continue
    const writable = [...affected].every((id) => allowed.has(id))
    if (writable) allowedTweaks.add(key)
    relevantTweaks.push({
      key,
      value: current[key],
      schema: tweaks!.declaration.schema[key],
      bindings,
      writable
    })
  }
  const directory = scope
    .filter(
      (n) =>
        designAttr(n.element, "data-design-section") !== undefined ||
        !n.parentId ||
        /^(h[1-6]|button|input|select|nav|form)$/.test(n.element.tagName)
    )
    .slice(0, 120)
    .map((n) => ({
      targetId: n.id,
      sectionId: n.sectionId,
      tag: n.element.tagName,
      label: nodeText(n).slice(0, 100),
      hash: sourceHash(index.html.slice(n.start, n.end)),
      parentId: n.parentId
    }))
  const context: DesignPatchContext = {
    protocol: "design-patch/1",
    contextId: randomUUID(),
    baseArtifactRevision: artifactRevision,
    instruction,
    targets: roots.map((n) => ({
      targetId: n.id,
      sectionId: n.sectionId,
      hash: sourceHash(index.html.slice(n.start, n.end)),
      html: (() => {
        let source = index.html.slice(n.start, n.end)
        const additions = scope
          .filter(
            (s) =>
              s.start >= n.start && s.end <= n.end && !designAttr(s.element, "data-design-node")
          )
          .map((s) => {
            const end = s.element.sourceCodeLocation!.startTag!.endOffset
            const offset = end - n.start - (index.html[end - 2] === "/" ? 2 : 1)
            return { start: offset, end: offset, text: ` data-design-node="${s.id}"` }
          })
        for (const el of elements(parse(index.html, { sourceCodeLocationInfo: true }))) {
          const loc = el.sourceCodeLocation
          if (!loc || loc.startOffset < n.start || loc.endOffset > n.end) continue
          if (["script", "style"].includes(el.tagName))
            additions.push({
              start: loc.startOffset - n.start,
              end: loc.endOffset - n.start,
              text: `<!-- protected ${el.tagName} omitted -->`
            })
          else
            for (const a of el.attrs.filter((a) => a.name.startsWith("on"))) {
              const range = loc.attrs?.[a.name]
              if (range)
                additions.push({
                  start: range.startOffset - n.start,
                  end: range.endOffset - n.start,
                  text: `${a.name}="[protected]"`
                })
            }
        }
        for (const edit of additions.sort((a, b) => b.start - a.start))
          source = source.slice(0, edit.start) + edit.text + source.slice(edit.end)
        return source
      })(),
      instruction: requested.find((r) => r.node.id === n.id)?.instruction
    })),
    parents: roots.flatMap((n) => {
      const p = n.parentId ? index.nodes.get(n.parentId) : undefined
      return p
        ? [
            {
              targetId: p.id,
              tag: p.element.tagName,
              attributes: Object.fromEntries(
                p.element.attrs
                  .filter((a) => !a.name.startsWith("on"))
                  .map((a) => [a.name, a.value])
              ),
              siblings: scope
                .filter((s) => s.parentId === p.id)
                .slice(0, 20)
                .map((s) => ({
                  targetId: s.id,
                  tag: s.element.tagName,
                  label: nodeText(s).slice(0, 60)
                }))
            }
          ]
        : []
    }),
    styles: [...selected.values()].map((r) => ({ resourceId: r.id, css: r.text, readOnly: true })),
    tweaks: relevantTweaks,
    directory,
    omitted: index.rules
      .filter((r) => !selected.has(r.id))
      .map((r) => ({ resourceId: r.id, reason: "未匹配当前依赖" })),
    unresolvedDependencies: index.unresolved,
    layoutObservations: (request.observations ?? [])
      .slice(0, 24)
      .filter(
        (o) =>
          related.has(o.nodeId) && Number.isFinite(o.box?.width) && Number.isFinite(o.box?.height)
      )
      .map((o) => ({
        nodeId: o.nodeId,
        box: {
          width: Math.min(100_000, Math.max(0, o.box.width)),
          height: Math.min(100_000, Math.max(0, o.box.height))
        },
        computed: Object.fromEntries(
          Object.entries(o.computed).filter(
            ([key, value]) =>
              /^(display|position|width|height|gap|padding|margin|grid-template-columns|flex-direction|font-size|line-height|color|background-color)$/.test(
                key
              ) &&
              typeof value === "string" &&
              value.length < 200
          )
        )
      })),
    constraints: [
      "Only targets and their descendants may be changed. Parents, shared CSS and directory are read-only.",
      "Use set_tweak for a writable binding; do not fight its override with CSS.",
      "Preserve IDs, names, business data attributes, scripts and tweak bindings. No JavaScript or global stylesheet changes."
    ]
  }
  // Descendants need individually addressable hashes, but do not duplicate all subtree HTML.
  if (allowed.size > 250) throw new DesignPatchScopeError("区块节点数量超过局部编辑预算")
  context.directory.push(
    ...scope
      .filter((n) => allowed.has(n.id) && !roots.includes(n))
      .map((n) => ({
        targetId: n.id,
        sectionId: n.sectionId,
        tag: n.element.tagName,
        hash: sourceHash(index.html.slice(n.start, n.end)),
        parentId: n.parentId,
        label: nodeText(n).slice(0, 60)
      }))
  )
  if (JSON.stringify(context).length > MAX_CONTEXT)
    throw new DesignPatchScopeError("区块及样式依赖超过局部上下文预算，需要扩大为完整改稿")
  return {
    public: context,
    index,
    allowed,
    roots,
    allowedTweaks,
    tweaks,
    tweakRevision: tweaks?.revision ?? 0,
    variationId: request.variationId
  }
}

export function expandPatchContext(prepared: PreparedPatchContext, resourceIds: string[]): void {
  if (resourceIds.length > 12) throw new DesignPatchScopeError("单次补读资源过多")
  for (const id of resourceIds) {
    const rule = prepared.index.rules.find((r) => r.id === id)
    if (!rule) throw new DesignPatchScopeError("补读资源不在当前索引中")
    if (!prepared.public.styles.some((s) => s.resourceId === id))
      prepared.public.styles.push({ resourceId: id, css: rule.text, readOnly: true })
  }
  if (JSON.stringify(prepared.public).length > MAX_CONTEXT)
    throw new DesignPatchScopeError("补读后上下文超过预算")
}
