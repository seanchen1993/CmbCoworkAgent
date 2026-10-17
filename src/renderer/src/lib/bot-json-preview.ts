/** Adapted from Grok Bot 0.71.2's sa / aa / Dt; see bots/EDITOR-SOURCES.md. */
class JsonSourceNumber {
  constructor(readonly source: string) {}
}

type JsonLeaf = string | boolean | null | JsonSourceNumber
type JsonContainer = JsonValue[] | { [key: string]: JsonValue }
export type JsonValue = JsonLeaf | JsonContainer

interface JsonRowBase {
  id: string
  depth: number
  name: string | null
}
export type JsonRow =
  | (JsonRowBase & { kind: "leaf"; value: JsonLeaf })
  | (JsonRowBase & {
      kind: "container"
      value: JsonContainer
      childCount: number
      isExpanded: boolean
    })
  | (JsonRowBase & { kind: "more"; hiddenCount: number })

export type JsonDisplayRow = JsonRowBase &
  (
    | { kind: "leaf"; text: string; valueKind: "string" | "number" | "keyword" }
    | { kind: "container"; childCount: number; isExpanded: boolean; isArray: boolean }
    | { kind: "more"; hiddenCount: number }
  )

export type JsonPreviewRequest = { type: "parse"; content: string } | { type: "toggle"; id: string }
export type JsonPreviewResponse = { status: "source" } | { status: "tree"; rows: JsonDisplayRow[] }

const MAX_CHILDREN = 200

/** Keep numeric lexemes, including unsafe integers, -0 and exponents, exactly as written. */
export function parseJsonPreview(content: string): { value: JsonValue } | null {
  try {
    const value: JsonValue = JSON.parse(
      content.charCodeAt(0) === 0xfeff ? content.slice(1) : content,
      (_key: string, value: unknown, context?: { source?: string }) => {
        if (typeof value !== "number") return value
        // The bundled Electron supports context.source. Fail back to source on older engines.
        if (!context?.source) throw new Error("JSON number source unavailable")
        return new JsonSourceNumber(context.source)
      }
    )
    return { value }
  } catch {
    return null
  }
}

function isContainer(value: JsonValue): value is JsonContainer {
  return typeof value === "object" && value !== null && !(value instanceof JsonSourceNumber)
}

function childCount(value: JsonContainer): number {
  if (Array.isArray(value)) return value.length
  let count = 0
  for (const key in value) {
    if (Object.prototype.hasOwnProperty.call(value, key)) count++
  }
  return count
}

function entries(value: JsonContainer): [string, JsonValue][] {
  const result: [string, JsonValue][] = []
  if (Array.isArray(value)) {
    for (let index = 0; index < Math.min(value.length, MAX_CHILDREN); index++) {
      result.push([String(index), value[index]])
    }
    return result
  }
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue
    if (result.length === MAX_CHILDREN) break
    result.push([key, value[key]])
  }
  return result
}

/** Iterative, ordered rows; wide containers have the same explicit limit as Grok. */
export function jsonPreviewRows(
  value: JsonValue,
  expanded: ReadonlyMap<string, boolean>,
  defaultExpandedDepth = 2
): JsonRow[] {
  type Pending = JsonRowBase & { kind: "node"; value: JsonValue }
  const pending: (Pending | Extract<JsonRow, { kind: "more" }>)[] = [
    { kind: "node", id: "0", name: null, value, depth: 0 }
  ]
  const rows: JsonRow[] = []
  for (let item = pending.pop(); item; item = pending.pop()) {
    if (item.kind === "more") {
      rows.push(item)
      continue
    }
    const { id, name, value: node, depth } = item
    if (!isContainer(node)) {
      rows.push({ kind: "leaf", id, name, value: node, depth })
      continue
    }
    const count = childCount(node)
    const isExpanded = expanded.get(id) ?? depth < defaultExpandedDepth
    rows.push({ kind: "container", id, name, value: node, depth, childCount: count, isExpanded })
    if (!isExpanded || count === 0) continue
    const children = entries(node)
    if (count > children.length) {
      pending.push({
        kind: "more",
        id: `${id}.more`,
        name: null,
        depth: depth + 1,
        hiddenCount: count - children.length
      })
    }
    for (let index = children.length - 1; index >= 0; index--) {
      const [key, child] = children[index]
      pending.push({
        kind: "node",
        id: `${id}.${index}`,
        name: key,
        value: child,
        depth: depth + 1
      })
    }
  }
  return rows
}

export function toggleJsonPreviewRow(
  expanded: ReadonlyMap<string, boolean>,
  row: Extract<JsonRow, { kind: "container" }>
): Map<string, boolean> {
  const next = new Map(expanded)
  if (row.isExpanded) {
    for (const key of expanded.keys()) {
      if (key.startsWith(`${row.id}.`)) next.delete(key)
    }
  }
  next.set(row.id, !row.isExpanded)
  return next
}

export function nextJsonPreviewCaret(
  rows: readonly (JsonRow | JsonDisplayRow)[],
  index: number,
  direction: 1 | -1
): number {
  for (let next = index + direction; next >= 0 && next < rows.length; next += direction) {
    const row = rows[next]
    if (row.kind === "container" && row.childCount > 0) return next
  }
  return -1
}

export function jsonPreviewLeaf(value: JsonLeaf): {
  text: string
  kind: "string" | "number" | "keyword"
} {
  if (value instanceof JsonSourceNumber) return { text: value.source, kind: "number" }
  return { text: JSON.stringify(value), kind: typeof value === "string" ? "string" : "keyword" }
}

/** One document per worker; parsed values and expansion state never enter the UI thread. */
export class JsonPreviewSession {
  private document: { value: JsonValue } | null = null
  private expanded = new Map<string, boolean>()
  private rows: JsonRow[] = []

  update(request: JsonPreviewRequest): JsonPreviewResponse {
    if (request.type === "parse") {
      this.document = parseJsonPreview(request.content)
      this.expanded.clear()
    } else {
      const row = this.rows.find((row) => row.id === request.id)
      if (row?.kind === "container" && row.childCount > 0) {
        this.expanded = toggleJsonPreviewRow(this.expanded, row)
      }
    }
    if (!this.document) {
      this.rows = []
      return { status: "source" }
    }
    this.rows = jsonPreviewRows(this.document.value, this.expanded)
    return {
      status: "tree",
      rows: this.rows.map((row): JsonDisplayRow => {
        const { id, name, depth } = row
        if (row.kind === "leaf") {
          const { text, kind } = jsonPreviewLeaf(row.value)
          return { kind: "leaf", id, name, depth, text, valueKind: kind }
        }
        if (row.kind === "more") return row
        return {
          kind: "container",
          id,
          name,
          depth,
          childCount: row.childCount,
          isExpanded: row.isExpanded,
          isArray: Array.isArray(row.value)
        }
      })
    }
  }
}
