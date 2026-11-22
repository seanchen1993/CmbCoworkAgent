import { describe, expect, it } from "vitest"
import {
  jsonPreviewLeaf,
  JsonPreviewSession,
  jsonPreviewRows,
  nextJsonPreviewCaret,
  parseJsonPreview,
  toggleJsonPreviewRow,
  type JsonRow
} from "./bot-json-preview"

function rowsFor(content: string) {
  const parsed = parseJsonPreview(content)
  expect(parsed).not.toBeNull()
  return jsonPreviewRows(parsed!.value, new Map())
}

function container(rows: JsonRow[], id: string) {
  const row = rows.find((row) => row.id === id)
  if (row?.kind !== "container") throw new Error(`Missing container ${id}`)
  return row
}

describe("Bot JSON file preview", () => {
  it("returns clone-safe display rows and resets state when a document changes", () => {
    const session = new JsonPreviewSession()
    expect(
      session.update({
        type: "parse",
        content: '{"id":9007199254740993,"items":[{"nested":{"ok":true}}]}'
      })
    ).toMatchObject({
      status: "tree",
      rows: [
        { kind: "container" },
        { kind: "leaf", text: "9007199254740993", valueKind: "number" },
        { kind: "container", isArray: true },
        { kind: "container", isExpanded: false }
      ]
    })
    const expanded = structuredClone(session.update({ type: "toggle", id: "0.1.0" }))
    expect(expanded.status === "tree" && expanded.rows.map((r) => r.name)).toEqual([
      null,
      "id",
      "items",
      "0",
      "nested"
    ])
    session.update({ type: "toggle", id: "0" })
    const replacement = session.update({ type: "parse", content: '{"fresh":true}' })
    expect(replacement.status === "tree" && replacement.rows.map((r) => r.name)).toEqual([
      null,
      "fresh"
    ])
    expect(session.update({ type: "parse", content: "invalid" })).toEqual({ status: "source" })
    expect(session.update({ type: "toggle", id: "0" })).toEqual({ status: "source" })
  })
  it("keeps original numeric values rather than rounded or non-finite JS numbers", () => {
    const source = "[9007199254740993,1.234567890123456789,-0,1e400,1e-400,14.20]"
    const values = rowsFor(source).flatMap((row) =>
      row.kind === "leaf" ? [jsonPreviewLeaf(row.value)] : []
    )
    expect(values.map((v) => v.text)).toEqual([
      "9007199254740993",
      "1.234567890123456789",
      "-0",
      "1e400",
      "1e-400",
      "14.20"
    ])
    expect(values.every((v) => v.kind === "number")).toBe(true)
  })

  it("shows the Grok browser fixture in file order with two levels expanded", () => {
    const rows = rowsFor(
      '{"name":"青鹭中文验收","filename":"sample.json","attachment":{"records":[{"id":"r1","amount":"18.25"},{"id":"r2","amount":"7.50"},{"id":"r3","amount":"25.00"}],"declared":"52.75"},"accepted":true}'
    )
    expect(rows.map((r) => r.name)).toEqual([
      null,
      "name",
      "filename",
      "attachment",
      "records",
      "declared",
      "accepted"
    ])
    expect(container(rows, "0").isExpanded).toBe(true)
    expect(container(rows, "0.2").isExpanded).toBe(true)
    expect(container(rows, "0.2.0")).toMatchObject({ childCount: 3, isExpanded: false })
    expect(nextJsonPreviewCaret(rows, 0, 1)).toBe(3)
    expect(nextJsonPreviewCaret(rows, 3, 1)).toBe(4)
    expect(nextJsonPreviewCaret(rows, 4, -1)).toBe(3)
    expect(nextJsonPreviewCaret(rows, 4, 1)).toBe(-1)
    expect(nextJsonPreviewCaret(rows, 0, -1)).toBe(-1)
  })

  it("collapsing clears descendant overrides while preserving sibling containers", () => {
    const parsed = parseJsonPreview('{"a":{"nested":{"value":1}},"b":{"value":2}}')!
    const overrides = new Map([
      ["0.0.0", true],
      ["0.1", false]
    ])
    const collapsed = toggleJsonPreviewRow(
      overrides,
      container(jsonPreviewRows(parsed.value, overrides), "0.0")
    )
    expect([...overrides]).toEqual([
      ["0.0.0", true],
      ["0.1", false]
    ])
    expect([...collapsed]).toEqual([
      ["0.1", false],
      ["0.0", false]
    ])
    expect(jsonPreviewRows(parsed.value, collapsed).map((r) => r.id)).toEqual(["0", "0.0", "0.1"])
    const reopened = toggleJsonPreviewRow(
      collapsed,
      container(jsonPreviewRows(parsed.value, collapsed), "0.0")
    )
    expect(container(jsonPreviewRows(parsed.value, reopened), "0.0.0").isExpanded).toBe(false)
  })

  it("treats prototype keys and HTML as text and preserves empty values", () => {
    const rows = rowsFor(
      '\uFEFF{"__proto__":{"polluted":true},"constructor":"<img onerror=alert(1)>","empty":{},"array":[],"nothing":null}'
    )
    expect(rows.map((r) => r.name)).toEqual([
      null,
      "__proto__",
      "polluted",
      "constructor",
      "empty",
      "array",
      "nothing"
    ])
    expect({}).not.toHaveProperty("polluted")
    expect(container(rows, "0.2").childCount).toBe(0)
    const leaf = rows.find((r) => r.name === "constructor")
    expect(leaf?.kind === "leaf" && jsonPreviewLeaf(leaf.value).text).toBe(
      '"<img onerror=alert(1)>"'
    )
    expect(rowsFor("null")[0]).toMatchObject({ kind: "leaf", value: null })
    expect(rowsFor('""')[0]).toMatchObject({ kind: "leaf", value: "" })
  })

  it("bounds wide containers and counts omitted items explicitly", () => {
    const rows = rowsFor(JSON.stringify(Array.from({ length: 5000 }, (_, i) => i)))
    expect(rows).toHaveLength(202)
    expect(container(rows, "0").childCount).toBe(5000)
    expect(rows.at(-1)).toMatchObject({ kind: "more", hiddenCount: 4800, id: "0.more" })
    const object = rowsFor(
      JSON.stringify(Object.fromEntries(Array.from({ length: 205 }, (_, i) => [`k${i}`, i])))
    )
    expect(object.at(-1)).toMatchObject({ kind: "more", hiddenCount: 5 })
  })

  it("traverses deep data iteratively and falls back for incomplete or invalid JSON", () => {
    const parsed = parseJsonPreview("[".repeat(200) + "true" + "]".repeat(200))!
    const rows = jsonPreviewRows(parsed.value, new Map(), 201)
    expect(rows).toHaveLength(201)
    expect(rows.at(-1)).toMatchObject({ kind: "leaf", value: true, depth: 200 })
    for (const text of ["", '{"a":', "[1,]", "undefined", '{"a":NaN}'])
      expect(parseJsonPreview(text)).toBeNull()
  })
})
