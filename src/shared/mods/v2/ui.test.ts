import { describe, expect, it } from "vitest"
import { validateFunctionTree, validFunctionLink, validatePaneArgs } from "./ui"
import type { ModObject } from "../types"

describe("function UI data boundary", () => {
  it("rejects arbitrary DOM properties, code, duplicate controls and malformed trees", () => {
    const button = {
      type: "Button",
      props: { key: "save", label: "Save" },
      press: { plugin: "p", handle: 1 }
    }
    for (const tree of [
      { type: "iframe", props: {}, children: [] },
      { type: "Text", props: { dangerouslySetInnerHTML: "text" }, children: [] },
      { ...button, props: { ...button.props, onClick: "source" } },
      { ...button, press: { plugin: "p", handle: -1 } },
      { type: "Box", props: {}, children: [button, button] },
      { type: "Text", props: {}, children: ["bad\u001b[31m"] },
      { type: "Box", props: {}, children: Array(1001).fill("x") },
      { type: "Code", props: { source: "text", format: "diff" } }
    ])
      expect(() => validateFunctionTree(tree)).toThrow()
    expect(() =>
      validateFunctionTree({ type: "Box", props: {}, children: [button, "plain"] })
    ).not.toThrow()
  })
  it("allows canonical HTTPS or localhost links only", () => {
    for (const url of ["https://example.com/", "http://localhost:8000/view"])
      expect(validFunctionLink(url)).toBe(true)
    for (const url of [
      "javascript:alert(1)",
      "file:///C:/secret",
      "data:text/html,hello",
      "https://example.com",
      "https://name@example.com/",
      "http://example.com/",
      "https://example.com/a b"
    ])
      expect(validFunctionLink(url)).toBe(false)
  })
  it("validates pane IDs, true-only flags and positive row counts", () => {
    expect(() => validatePaneArgs({ id: "board-1", rows: 10, closeOnEscape: true })).not.toThrow()
    const invalid: ModObject[] = [
      { id: "../board" },
      { id: "board", rows: 0 },
      { id: "board", rows: 1.2 },
      { id: "board", focus: false }
    ]
    for (const input of invalid)
      expect(() => validatePaneArgs(input)).toThrow("MODS_UI_PANE_ARGUMENTS")
  })
})
