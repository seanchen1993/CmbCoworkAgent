import { parse, serialize, defaultTreeAdapter as adapter, type DefaultTreeAdapterMap } from "parse5"
import type { ReportFacts, ReportRow, ReportSnapshot } from "./report-data"

type Node = DefaultTreeAdapterMap["node"]
type Element = DefaultTreeAdapterMap["element"]
type Parent = DefaultTreeAdapterMap["parentNode"]
const isElement = (node: Node): node is Element => "tagName" in node
const attr = (node: Element, name: string) => node.attrs.find((a) => a.name === name)?.value
const text = (node: Element, value: string) => {
  node.childNodes = []
  adapter.insertText(node, value)
}
const allowed = new Set(
  "html head body title meta style main header footer nav section article aside div span p h1 h2 h3 h4 h5 h6 strong em b i u s small sub sup br hr ul ol li dl dt dd table caption colgroup col thead tbody tfoot tr th td details summary a img figure figcaption blockquote pre code time svg g path rect circle ellipse line polyline polygon text tspan defs lineargradient radialgradient stop clippath pattern mask title desc".split(
    " "
  )
)
const repeatKeys = ["members", "projects", "features", "knowledgeFiles"] as const
const CSP =
  "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
export const REPORT_SOURCE_LIMIT = 100_000

function clean(source: string) {
  source = source
    .trim()
    .replace(/^```(?:html)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim()
  if (source.length > REPORT_SOURCE_LIMIT)
    throw new Error("HTML 过长，请使用列表数据引用并精简样式")
  if (!/<html[\s>]/i.test(source) || !/<\/body\s*>/i.test(source) || !/<\/html\s*>/i.test(source))
    throw new Error("请输出完整 HTML 文档，包括结束的 body 和 html 标签")
  const doc = parse(source)
  let count = 0
  function visit(parent: Parent) {
    for (const node of [...parent.childNodes]) {
      if (++count > 8000) throw new Error("HTML 节点过多，请精简版式")
      if (!isElement(node)) {
        if (node.nodeName === "#comment") adapter.detachNode(node)
        continue
      }
      const tag = node.tagName.toLowerCase()
      if (
        !allowed.has(tag) ||
        tag === "meta" ||
        attr(node, "data-report-provenance") !== undefined
      ) {
        adapter.detachNode(node)
        continue
      }
      node.attrs = node.attrs.filter((a) => {
        const name = a.name.toLowerCase()
        if (
          name.startsWith("on") ||
          [
            "srcdoc",
            "contenteditable",
            "autofocus",
            "ping",
            "download",
            "target",
            "srcset",
            "formaction",
            "action",
            "nonce"
          ].includes(name)
        )
          return false
        if (name === "href") return !a.namespace && /^#[\w-]+$/.test(a.value)
        if (name === "src")
          return (
            tag === "img" &&
            /^data:image\/(?:png|jpeg|webp|gif);base64,[a-z0-9+/=]+$/i.test(a.value)
          )
        if (a.namespace) return false
        if (name === "style" && /@import|url\s*\(|expression\s*\(/i.test(a.value)) return false
        return true
      })
      if (tag === "style") {
        const css = node.childNodes
          .map((n) =>
            n.nodeName === "#text" ? (n as DefaultTreeAdapterMap["textNode"]).value : ""
          )
          .join("")
        // Offline artifacts have no CSS dependency loader. CSP additionally blocks escaped URLs.
        if (/@import|url\s*\(|expression\s*\(/i.test(css)) text(node, "")
      }
      visit(node)
    }
  }
  visit(doc)
  return doc
}

function getValue(facts: ReportFacts, path: string, row?: ReportRow): string {
  let value: unknown
  if (/^[a-zA-Z][a-zA-Z0-9]*$/.test(path) && row && Object.hasOwn(row, path)) value = row[path]
  else {
    const [group, field, extra] = path.split(".")
    if (extra || !["meta", "summary", "knowledge"].includes(group))
      throw new Error(`未知数据引用：${path}`)
    const values = facts[group as "meta"]
    if (!field || !Object.hasOwn(values, field)) throw new Error(`未知数据引用：${path}`)
    value = values[field]
  }
  return value === null ? "未记录" : String(value)
}

function cloneElement(node: Element, consumeNode: () => void): Element {
  consumeNode()
  const copy = adapter.createElement(
    node.tagName,
    node.namespaceURI,
    node.attrs.map((a) => ({ ...a }))
  )
  for (const child of node.childNodes) {
    if (isElement(child)) adapter.appendChild(copy, cloneElement(child, consumeNode))
    else if (child.nodeName === "#text") {
      consumeNode()
      adapter.insertText(copy, (child as DefaultTreeAdapterMap["textNode"]).value)
    }
  }
  return copy
}

export function renderReportHtml(
  source: string,
  snapshot: ReportSnapshot
): { source: string; html: string } {
  if (source.includes("【按本期重新撰写】") || source.includes("data-report-rebuild-chart"))
    throw new Error("HTML仍含模板占位内容，请按本期数据重写文字和图表并移除占位标记")
  const doc = clean(source)
  const refs = new Set<string>()
  function validate(parent: Parent, row?: ReportRow) {
    for (const node of parent.childNodes) {
      if (!isElement(node)) continue
      const repeat = attr(node, "data-report-repeat")
      const ref = attr(node, "data-report-value")
      if (
        (repeat || ref) &&
        ["html", "head", "body", "style", "title", "svg", "defs"].includes(node.tagName)
      )
        throw new Error("数据引用只能放在正文文本或列表元素中")
      if (repeat && ref) throw new Error("列表容器与文本数据引用请分别放在父子节点")
      let nextRow = row
      if (repeat) {
        if (row || !repeatKeys.includes(repeat as (typeof repeatKeys)[number]))
          throw new Error(`不支持的列表引用：${repeat}`)
        // Empty lists still validate their field names against the stable schema.
        nextRow = snapshot.facts[repeat as "members"][0] ?? emptyReportRow(repeat)
      }
      if (ref) {
        getValue(snapshot.facts, ref, nextRow)
        refs.add(ref)
        text(node, "")
      } else validate(node, nextRow)
    }
  }
  validate(doc)
  if (refs.size === 0)
    throw new Error("报告须使用 data-report-value 绑定真实数据，不要手写指标数字")
  const normalized = serialize(doc)
  let expandedNodes = 0
  const consumeNode = () => {
    if (++expandedNodes > 60_000) throw new Error("报告明细节点过多，请精简每行的版式")
  }
  function expand(parent: Parent, row?: ReportRow) {
    for (const node of [...parent.childNodes]) {
      if (!isElement(node)) continue
      const repeat = attr(node, "data-report-repeat")
      if (repeat) {
        const rows = snapshot.facts[repeat as "members"]
        if (rows.length > 5000) throw new Error("明细超过单份 HTML 支持的规模，请缩小报告周期")
        for (const item of rows) {
          const copy = cloneElement(node, consumeNode)
          copy.attrs = copy.attrs.filter((a) => a.name !== "data-report-repeat" && a.name !== "id")
          adapter.insertBefore(parent, copy, node)
          expandElement(copy, item)
        }
        adapter.detachNode(node)
      } else expandElement(node, row)
    }
  }
  function expandElement(node: Element, row?: ReportRow) {
    const ref = attr(node, "data-report-value")
    if (ref) text(node, getValue(snapshot.facts, ref, row))
    else expand(node, row)
  }
  expand(doc)
  const html = doc.childNodes.find((n): n is Element => isElement(n) && n.tagName === "html")!
  const head = html.childNodes.find((n): n is Element => isElement(n) && n.tagName === "head")!
  const body = html.childNodes.find((n): n is Element => isElement(n) && n.tagName === "body")!
  const meta = adapter.createElement("meta", html.namespaceURI, [
    { name: "http-equiv", value: "Content-Security-Policy" },
    { name: "content", value: CSP }
  ])
  if (head.childNodes[0]) adapter.insertBefore(head, meta, head.childNodes[0])
  else adapter.appendChild(head, meta)
  adapter.appendChild(
    head,
    adapter.createElement("meta", html.namespaceURI, [{ name: "charset", value: "UTF-8" }])
  )
  adapter.appendChild(
    head,
    adapter.createElement("meta", html.namespaceURI, [
      { name: "name", value: "viewport" },
      { name: "content", value: "width=device-width, initial-scale=1" }
    ])
  )
  const footer = adapter.createElement("footer", html.namespaceURI, [
    { name: "data-report-provenance", value: "true" },
    {
      name: "style",
      value:
        "display:block!important;visibility:visible!important;position:static!important;opacity:1!important;background:#f8fafc!important;color:#475569!important;font:12px/1.7 sans-serif!important;padding:20px!important;margin:24px 0 0!important;white-space:normal!important"
    }
  ])
  text(
    footer,
    [
      snapshot.exampleData ? "【演示数据】" : "",
      `${snapshot.facts.meta.room} · ${snapshot.facts.meta.period} · 数据截至 ${snapshot.periodData.dataAsOf}`,
      ...snapshot.notes
    ]
      .filter(Boolean)
      .join("\n")
  )
  adapter.appendChild(body, footer)
  const rendered = serialize(doc)
  if (Buffer.byteLength(rendered) > 8_000_000) throw new Error("报告文件过大，请精简明细版式")
  return { source: normalized, html: rendered }
}

/** Only the layout and data references survive. Old names, dates, numbers and conclusions do not. */
export function extractReportTemplate(source: string, snapshot?: ReportSnapshot): string {
  const doc = clean(source)
  const labels = new Set(["title", "h1", "h2", "h3", "h4", "h5", "h6", "th", "caption", "summary"])
  const privateValues = snapshot
    ? [
        snapshot.facts.meta.room,
        snapshot.facts.meta.period,
        ...snapshot.facts.members.flatMap((row) => [row.name, row.identity]),
        ...snapshot.facts.projects.flatMap((row) => [row.name, row.projectId]),
        ...snapshot.facts.features.flatMap((row) => [row.name, row.project]),
        ...snapshot.facts.knowledgeFiles.flatMap((row) => [row.name, row.deployUnit, row.updatedBy])
      ].filter((value): value is string => typeof value === "string" && value.length >= 2)
    : []
  function visit(parent: Parent) {
    for (const node of parent.childNodes) {
      if (!isElement(node)) continue
      if (node.tagName === "style") continue
      // Static chart geometry can encode old figures even after its labels are removed.
      if (node.tagName === "svg") {
        text(node, "")
        node.attrs.push({ name: "data-report-rebuild-chart", value: "根据本期数据重建图表" })
        continue
      }
      node.attrs = node.attrs.filter((a) =>
        [
          "class",
          "style",
          "colspan",
          "rowspan",
          "data-report-repeat",
          "data-report-value",
          "data-report-insight",
          "viewBox",
          "width",
          "height",
          "d",
          "fill",
          "stroke"
        ].includes(a.name)
      )
      for (const child of node.childNodes) {
        if (child.nodeName === "#text") {
          const textNode = child as DefaultTreeAdapterMap["textNode"]
          if (!textNode.value.trim()) continue
          const safeLabel =
            labels.has(node.tagName) &&
            !/\d/.test(textNode.value) &&
            !privateValues.some((value) => textNode.value.includes(value))
          if (!safeLabel)
            textNode.value = attr(node, "data-report-value") ? "" : "【按本期重新撰写】"
        }
      }
      visit(node)
    }
  }
  visit(doc)
  return serialize(doc)
}

export function emptyReportRow(key: string): ReportRow {
  const common = {
    conversations: null,
    harnessConversations: null,
    vibeConversations: null,
    knowledgeReads: null,
    generatedLines: null,
    effectiveGeneratedLines: null,
    adoptedLines: null,
    pushedAdoptedLines: null,
    adoptionRate: null,
    pushedAdoptionRate: null,
    harnessAdoptedLines: null,
    vibeAdoptedLines: null
  }
  if (key === "members")
    return { ...common, name: null, identity: null, projectCount: null, featureCount: null }
  if (key === "projects")
    return {
      ...common,
      name: null,
      projectId: null,
      lean: null,
      status: null,
      snapshotAt: null,
      featureCount: null,
      activePeople: null
    }
  if (key === "features")
    return {
      ...common,
      projectId: null,
      featureSlug: null,
      project: null,
      name: null,
      stage: null,
      status: null,
      stageBasis: null
    }
  return { name: null, deployUnit: null, updatedAt: null, updatedBy: null }
}
