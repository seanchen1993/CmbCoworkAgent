import { describe, expect, it } from "vitest"
import type { FunctionUiElement, FunctionUiNode } from "./ui"
import { functionEngineRefs, validateFunctionAskTree, validateFunctionClientTree } from "./engine"

const native: FunctionUiElement = Object.freeze({ type: "engine", ref: 0 })
const box = (...children: (FunctionUiElement | string)[]): FunctionUiNode => ({
  type: "Box",
  props: {},
  children
})
const text = (body = "Review before answering"): FunctionUiNode => ({
  type: "Text",
  props: {},
  children: [body]
})
const client: FunctionUiNode = {
  type: "Client",
  props: { key: "summary", module: "summary.ts" },
  client: { plugin: "p" }
}

describe("native engine data trees", () => {
  it("keeps Markdown descriptions above Ask and rejects even empty leaves after its controls", () => {
    const description: FunctionUiElement = { type: "Markdown", props: { text: "# Review" } }
    expect(() => validateFunctionAskTree(box(description, native))).not.toThrow()
    expect(functionEngineRefs(box(description, native))).toEqual([0])
    expect(() => validateFunctionAskTree(box(native, { type: "Markdown", props: { text: "" } })))
      .toThrow("MODS_UI_ASK_TREE_INVALID")
    expect(() => validateFunctionAskTree({ type: "fragment", children: [
      native, { type: "fragment", children: [{ type: "Markdown", props: { text: "" } }] }
    ] })).toThrow("MODS_UI_ASK_TREE_INVALID")
  })

  it("permits Client Markdown data but refuses Hook closures and takeover lists", () => {
    expect(() => validateFunctionClientTree(box({ type: "Markdown", props: { text: "Docs" } })))
      .not.toThrow()
    expect(() => validateFunctionClientTree(box({
      type: "Markdown", props: { key: "docs", text: "Docs", pressableLinks: [] },
      press: { kind: "onLinkPress", plugin: "Q", handle: 1 }
    }))).toThrow("MODS_UI_CLIENT_MARKDOWN")
  })
  it("collects refs in drawing order without resolving or sharing a table", () => {
    const first = box(text(), { type: "engine", ref: 4 }, box(native, native), {
      type: "engine",
      ref: 999
    })
    expect(functionEngineRefs(first)).toEqual([4, 0, 0, 999])
    expect(functionEngineRefs(box({ type: "engine", ref: 1 }))).toEqual([1])
    expect(functionEngineRefs(box(text(), client))).toEqual([])
    expect(Object.keys(native)).toEqual(["type", "ref"])
  })

  it("rejects malformed metadata before any engine refs can be consumed", () => {
    for (const extra of [
      { props: {} },
      { children: [] },
      {
        press: { plugin: "other", handle: 1 }
      },
      { nativeContent: { component: "Pane", entries: [] } }
    ]) {
      expect(() => functionEngineRefs({ ...native, ...extra })).toThrow("MODS_UI_TREE_INVALID")
    }
  })

  it("allows existing Client controls but rejects engine at every nesting depth", () => {
    const control: FunctionUiNode = {
      type: "Button",
      props: { key: "answer", label: "Answer" },
      press: { plugin: "p", handle: 3 }
    }
    expect(() => validateFunctionClientTree(box(text(), control))).not.toThrow()
    for (const tree of [
      native,
      box(native),
      box(text(), box(native)),
      {
        type: "Link",
        props: { href: "https://example.com" },
        children: [native]
      }
    ])
      expect(() => validateFunctionClientTree(tree)).toThrow("MODS_UI_CLIENT_ENGINE")
  })
})

describe("explicit native Ask structure", () => {
  it("accepts a bare native slot and descriptions or Client above it", () => {
    for (const tree of [
      native,
      box(text(), native),
      box(client, box(text(), native)),
      {
        type: "Box",
        props: { flexDirection: "column", gap: 1, padding: 1 },
        children: [text(), native]
      }
    ])
      expect(() => validateFunctionAskTree(tree)).not.toThrow()
  })

  it("requires exactly one native slot without implicitly augmenting legacy descriptions", () => {
    for (const tree of [text(), box(client), box(native, native)])
      expect(() => validateFunctionAskTree(tree)).toThrow("MODS_UI_ASK_TREE_INVALID")
  })

  it("rejects every node after the controls, including empty strings and empty containers", () => {
    for (const tail of ["", "after", text(""), box(), client]) {
      expect(() => validateFunctionAskTree(box(native, tail))).toThrow("MODS_UI_ASK_TREE_INVALID")
      expect(() => validateFunctionAskTree(box(box(text(), native), tail))).toThrow(
        "MODS_UI_ASK_TREE_INVALID"
      )
    }
  })

  it("rejects inline embedding and dimension-constrained ancestors", () => {
    for (const tree of [
      { type: "Text", props: {}, children: [native] },
      { type: "Link", props: { href: "https://example.com" }, children: [native] },
      ...[0, 1, "0%", "100%"].flatMap((dimension) => [
        { type: "Box", props: { width: dimension }, children: [native] },
        { type: "Box", props: { height: dimension }, children: [box(native)] }
      ])
    ])
      expect(() => validateFunctionAskTree(tree)).toThrow("MODS_UI_ASK_TREE_INVALID")
  })

  it("does not restrict dimensions of unrelated descriptions above the native controls", () => {
    expect(() =>
      validateFunctionAskTree(
        box(
          {
            type: "Box",
            props: { height: 1, width: 10 },
            children: [text()]
          },
          native
        )
      )
    ).not.toThrow()
  })

  it("rejects hidden or future layout attributes rather than guessing their effect", () => {
    for (const props of [
      { overflow: "hidden" },
      { display: "none" },
      { position: "absolute" },
      {
        hover: "hidden"
      }
    ])
      expect(() =>
        validateFunctionAskTree({
          type: "Box",
          props,
          children: [native]
        })
      ).toThrow("MODS_UI_TREE_INVALID")
  })
})
