import { describe, expect, it, vi } from "vitest"
import {
  validateFunctionTree,
  validFunctionLink,
  validatePaneArgs,
  validateFunctionUiActionLink,
  validateFunctionUiPressedLink
} from "./ui"
import type { ModObject } from "../types"
import { functionFocusHandle, functionFocusTargets } from "./focus"

describe("function UI data boundary", () => {
  it("accepts only a bare non-negative safe integer engine reference", () => {
    for (const ref of [0, 1, Number.MAX_SAFE_INTEGER])
      expect(() => validateFunctionTree({ type: "engine", ref })).not.toThrow()
    for (const tree of [
      { type: "engine" },
      { type: "engine", ref: -1 },
      { type: "engine", ref: 0.5 },
      { type: "engine", ref: Number.MAX_SAFE_INTEGER + 1 },
      { type: "engine", ref: NaN },
      { type: "engine", ref: Infinity },
      { type: "engine", ref: "0" },
      { type: "engine", ref: null },
      ...["props", "children", "press", "client", "nativeContent"].map((key) => ({
        type: "engine", ref: 0, [key]: {}
      }))
    ]) expect(() => validateFunctionTree(tree)).toThrow()
  })

  it("counts engine leaves against the existing tree limits", () => {
    const engine = { type: "engine", ref: 0 }
    expect(() => validateFunctionTree({
      type: "Box", props: {}, children: Array(999).fill(engine)
    })).not.toThrow()
    expect(() => validateFunctionTree({
      type: "Box", props: {}, children: Array(1000).fill(engine)
    })).toThrow("MODS_UI_TREE_INVALID")
    let tree: unknown = engine
    for (let depth = 0; depth < 24; depth++) tree = { type: "Box", props: {}, children: [tree] }
    expect(() => validateFunctionTree(tree)).toThrow("MODS_JSON_DEPTH")
    // The JSON depth bound already applies before tree traversal and is not widened.
  })

  it("retains the JSON byte limit when native content is mixed with text", () => {
    expect(() => validateFunctionTree({
      type: "Box", props: {}, children: [{ type: "engine", ref: 0 },
        ...Array(105).fill("x".repeat(10000))]
    })).toThrow("MODS_JSON_SIZE")
  })

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
      { type: "Code", props: { source: "text", format: "unified" } },
      { type: "Code", props: { source: "text\u0000", format: "diff" } }
    ])
      expect(() => validateFunctionTree(tree)).toThrow()
    expect(() =>
      validateFunctionTree({ type: "Box", props: {}, children: [button, "plain"] })
    ).not.toThrow()
  })
  it("accepts plain diff text for the renderer fallback without changing the original data", () => {
    const tree = { type: "Code", props: { source: "plain text", format: "diff", startLine: 17 } }
    const before = JSON.stringify(tree)
    expect(() => validateFunctionTree(tree)).not.toThrow()
    expect(JSON.stringify(tree)).toBe(before)
  })
  it("allows explicit safe HTTPS or localhost links only", () => {
    for (const url of ["https://example.com/", "https://example.com", "http://localhost:8000/view"])
      expect(validFunctionLink(url)).toBe(true)
    for (const url of [
      "javascript:alert(1)",
      "file:///C:/secret",
      "data:text/html,hello",
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
  it("accepts holdToasts only as true and resets it by omission", () => {
    expect(() => validatePaneArgs({ id: "dialog", holdToasts: true })).not.toThrow()
    expect(() => validatePaneArgs({ id: "dialog" })).not.toThrow()
    expect(() => validatePaneArgs({ id: "dialog", holdToasts: false })).toThrow()
  })
  it("accepts a strict Markdown leaf with optional native link callback provenance", () => {
    for (const tree of [
      { type: "Markdown", props: { text: "# Heading\n\n[Docs](https://example.com)" } },
      { type: "Markdown", props: { text: "", dimColor: false } },
      { type: "Markdown", props: { key: "docs", text: "Docs", pressableLinks: [] },
        press: { kind: "onLinkPress", plugin: "Q", handle: 1 } }
    ]) expect(() => validateFunctionTree(tree)).not.toThrow()
  })

  it("rejects malformed leaf metadata, fake callbacks and list without actual press", () => {
    const leaf = { type: "Markdown", props: { text: "Docs" } }
    for (const tree of [
      { ...leaf, children: [] }, { ...leaf, client: { plugin: "Q" } },
      { ...leaf, nativeContent: {} }, { ...leaf, markdownLinks: [] },
      { ...leaf, props: { text: "Docs", onLinkPress: "callback" } },
      { ...leaf, props: { text: "Docs", pressableLinks: [] } },
      { ...leaf, props: { text: "Docs", key: "docs", pressableLinks: [""] },
        press: { kind: "onLinkPress", plugin: "Q", handle: 1 } },
      { ...leaf, press: { kind: "onLinkPress", plugin: "Q", handle: 1 } },
      { ...leaf, props: { text: "Docs", key: "docs" },
        press: { plugin: "Q", handle: 1 } },
      { ...leaf, props: { text: "Docs", key: "docs" },
        press: { kind: "onPress", plugin: "Q", handle: 1 } },
      { ...leaf, props: { text: "Docs", key: "docs" },
        press: { kind: "onLinkPress", plugin: "Q", handle: 0 } },
      { ...leaf, props: { text: "Docs", key: "docs" },
        press: { kind: "onLinkPress", plugin: "Q", handle: 1, source: "person" } },
      { type: "Button", props: { key: "docs", label: "Docs" },
        press: { kind: "onLinkPress", plugin: "Q", handle: 1 } }
    ]) expect(() => validateFunctionTree(tree)).toThrow()
  })

  it("rejects leaf getter, hidden or symbolic metadata without evaluating it", () => {
    const read = vi.fn(() => "Docs")
    const leaf = { type: "Markdown", props: { text: "Docs" } }
    Object.defineProperty(leaf.props, "text", { enumerable: true, get: read })
    expect(() => validateFunctionTree(leaf)).toThrow()
    expect(read).not.toHaveBeenCalled()
    const stringify = vi.fn(() => ({ type: "Markdown", props: { text: "changed" } }))
    const hidden = { type: "Markdown", props: { text: "Docs" } }
    Object.defineProperty(hidden, "toJSON", { value: stringify })
    expect(() => validateFunctionTree({ type: "Box", props: {}, children: [hidden] })).toThrow()
    expect(stringify).not.toHaveBeenCalled()
    expect(() => validateFunctionTree({
      type: "Markdown", props: { text: "Docs" }, [Symbol("authority")]: true
    })).toThrow()
  })

  it("shares actual action addresses across Fragment, Markdown and existing controls", () => {
    const markdown = {
      type: "Markdown", props: { key: "same", text: "Docs" },
      press: { kind: "onLinkPress", plugin: "Q", handle: 1 }
    }
    const button = {
      type: "Button", props: { key: "same", label: "Save" }, press: { plugin: "Q", handle: 2 }
    }
    expect(() => validateFunctionTree({ type: "fragment", children: [markdown, button] }))
      .toThrow("MODS_UI_TREE_INVALID")
    expect(() => validateFunctionTree({ type: "fragment", children: [
      markdown, { ...button, press: { plugin: "R", handle: 2 } }
    ] })).not.toThrow()
  })

  it("does not treat a Markdown callback key as an existing autofocus control", () => {
    const tree = {
      type: "fragment",
      children: [
        {
          type: "Markdown",
          props: { key: "docs", text: "[Docs](https://example.com)" },
          press: { kind: "onLinkPress", plugin: "Q", handle: 1 }
        },
        {
          type: "Button",
          props: { key: "save", label: "Save", autoFocus: true },
          press: { plugin: "Q", handle: 2 }
        }
      ]
    }
    validateFunctionTree(tree)
    expect(functionFocusHandle(tree, { plugin: "Q", element: "docs" })).toBeUndefined()
    expect(functionFocusHandle(tree, { plugin: "Q", element: "save" })).toBe(2)
    expect(functionFocusTargets({ tree })).toEqual([
      { target: { plugin: "Q", element: "save" }, autoFocus: true }
    ])
  })

  it("requires link only for the host's actual Markdown press and preserves business href", () => {
    expect(() => validateFunctionUiActionLink({ kind: "press", link: {
      href: "rewritten:callback-business-data"
    } }, true)).not.toThrow()
    expect(() => validateFunctionUiActionLink({ kind: "press" }, false)).not.toThrow()
    for (const [action, markdown] of [
      [{ kind: "press" }, true],
      [{ kind: "change", link: { href: "https://example.com" } }, true],
      [{ kind: "press", link: { href: "https://example.com" } }, false]
    ] as const) expect(() => validateFunctionUiActionLink(action, markdown)).toThrow()
    for (const link of [
      {}, { href: "" }, { href: "x".repeat(2049) }, { href: "x\u009fy" },
      { href: "https://example.com", source: "person" }
    ]) expect(() => validateFunctionUiPressedLink(link)).toThrow()
    const read = vi.fn(() => "https://example.com")
    const link = Object.defineProperty({}, "href", { enumerable: true, get: read })
    expect(() => validateFunctionUiPressedLink(link)).toThrow()
    expect(read).not.toHaveBeenCalled()
  })
})


it("accepts only official single digit or lowercase Button hotkeys", () => {
  const tree = (hotkey: unknown) => ({type:"Button",props:{key:"go",label:"Go",hotkey},
    press:{plugin:"p",handle:1}})
  for (const key of ["0","9","a","z"])
    expect(()=>validateFunctionTree(tree(key))).not.toThrow()
  for (const key of ["A","Enter","ctrl+w","","ab",1,null,"中"])
    expect(()=>validateFunctionTree(tree(key))).toThrow()
})


it("accepts the original package layout/text props without widening their types", () => {
  expect(()=>validateFunctionTree({type:"Box",props:{borderStyle:"round",borderColor:"magenta",marginTop:1},
    children:[{type:"Text",props:{inverse:true,color:"cyan",wrap:"truncate-start"},children:["path"]}]})).not.toThrow()
  for (const props of [{borderColor:1},{marginTop:"1"},{marginTop:-1}])
    expect(()=>validateFunctionTree({type:"Box",props})).toThrow()
  for (const props of [{inverse:"true"},{wrap:"unknown"}])
    expect(()=>validateFunctionTree({type:"Text",props})).toThrow()
})
