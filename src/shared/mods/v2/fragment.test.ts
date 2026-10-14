import { describe, expect, it } from "vitest"
import {
  validateFunctionTree,
  type FunctionUiElement,
  type FunctionUiFragment,
  type FunctionUiNode
} from "./ui"
import {
  functionEngineRefs,
  functionLogicalEngine,
  validateFunctionAskTree,
  validateFunctionClientTree
} from "./engine"
import { functionFocusHandle, functionFocusTargets } from "./focus"
import { normalizeFunctionLinks } from "./link-fallback"

const fragment = (...children: (FunctionUiElement | string)[]): FunctionUiFragment => ({
  type: "fragment", children
})
const engine: FunctionUiElement = { type: "engine", ref: 0 }
const button: FunctionUiNode = {
  type: "Button", props: { key: "review", label: "Review", autoFocus: true },
  press: { plugin: "p", handle: 1 }
}

describe("strict structural Fragment wire type", () => {
  it("accepts root, empty and nested structural sequences without node metadata", () => {
    for (const tree of [fragment(), fragment("a", "b"), fragment(fragment(engine), button)])
      expect(() => validateFunctionTree(tree)).not.toThrow()
  })

  it("rejects every nonstructural field and malformed child list", () => {
    for (const extra of [
      { props: {} }, { key: "x" }, { ref: 0 }, { press: button.press },
      { client: { plugin: "p" } }, { nativeContent: {} }, { style: {} }
    ]) expect(() => validateFunctionTree({ ...fragment(), ...extra })).toThrow()
    for (const value of [
      { type: "fragment" }, { type: "fragment", children: "x" },
      { type: "fragment", children: null }, [engine], "x", 1,
      { type: "fragment", children: [{ type: "unknown", children: [] }] }
    ]) expect(() => validateFunctionTree(value)).toThrow()
  })

  it("rejects hidden metadata and requires both structural fields to survive JSON", () => {
    for (const key of ["press", Symbol("ref")]) {
      const tree = fragment()
      Object.defineProperty(tree, key, { value: { plugin: "other", handle: 1 } })
      expect(() => validateFunctionTree(tree)).toThrow("MODS_UI_TREE_INVALID")
    }
    for (const key of ["type", "children"]) {
      const tree = fragment()
      Object.defineProperty(tree, key, { enumerable: false })
      expect(() => validateFunctionTree(tree)).toThrow("MODS_UI_TREE_INVALID")
    }
  })

  it("counts structural nodes and original depth before any flattening", () => {
    expect(() => validateFunctionTree(fragment(...Array<string>(999).fill("x")))).not.toThrow()
    expect(() => validateFunctionTree(fragment(...Array<string>(1000).fill("x")))).toThrow()
    let tree = fragment()
    for (let index = 0; index < 24; index++) tree = fragment(tree)
    expect(() => validateFunctionTree(tree)).toThrow()
  })

  it("keeps refs, controls and ownership in original drawing order", () => {
    const tree = fragment(fragment({ type: "engine", ref: 8 }), button, engine, engine)
    expect(functionEngineRefs(tree)).toEqual([8, 0, 0])
    expect(functionFocusHandle(tree, { plugin: "p", element: "review" })).toBe(1)
    expect(functionFocusHandle(tree, { plugin: "other", element: "review" })).toBeUndefined()
    expect(functionFocusTargets({ tree })).toEqual([
      { target: { plugin: "p", element: "review" }, autoFocus: true }
    ])
    expect(() => validateFunctionTree(fragment(button, fragment(button)))).toThrow()
  })

  it("normalizes unsafe Links inside fragments without copying healthy action handles", () => {
    const unchanged = fragment(button, engine)
    expect(normalizeFunctionLinks(unchanged)).toBe(unchanged)
    const tree = fragment(button, fragment({ type: "Link", props: { href: "javascript:bad" } }))
    const safe = normalizeFunctionLinks(tree)
    expect(safe.type).toBe("fragment")
    expect(safe.children[0]).toBe(button)
    expect(safe.children[1]).toEqual(fragment({ type: "Text", props: {}, children: ["javascript:bad"] }))
    expect(tree.children[1]).toEqual(fragment({ type: "Link", props: { href: "javascript:bad" } }))
  })

  it("recognizes only a validated single transparent native logical root", () => {
    expect(functionLogicalEngine(fragment(fragment(), fragment(engine)))).toBe(engine)
    for (const tree of [
      fragment(), fragment(engine, engine), fragment("", engine),
      { type: "Box", props: {}, children: [engine] } satisfies FunctionUiNode
    ]) expect(functionLogicalEngine(tree)).toBeUndefined()
    const malformed = { ...fragment(engine), ref: 0 }
    expect(() => functionLogicalEngine(malformed)).toThrow()
  })

  it("allows structural Ask ancestors and rejects every empty or visible tail", () => {
    for (const tree of [fragment(engine), fragment(fragment(), fragment(engine))])
      expect(() => validateFunctionAskTree(tree)).not.toThrow()
    for (const tail of [
      fragment(), "", { type: "Text", props: {}, children: [] } satisfies FunctionUiNode,
      { type: "Box", props: {}, children: [] } satisfies FunctionUiNode
    ]) {
      expect(() => validateFunctionAskTree(fragment(engine, tail))).toThrow("MODS_UI_ASK_TREE_INVALID")
      expect(() => validateFunctionAskTree(fragment(fragment(engine), tail))).toThrow("MODS_UI_ASK_TREE_INVALID")
    }
    expect(() => validateFunctionAskTree(fragment({
      type: "Box", props: { height: 0 }, children: [fragment(engine)]
    }))).toThrow("MODS_UI_ASK_TREE_INVALID")
  })

  it("does not grant isolated Clients native rendering through a transparent wrapper", () => {
    expect(() => validateFunctionClientTree(fragment(button))).not.toThrow()
    for (const tree of [fragment(engine), fragment(fragment(engine))])
      expect(() => validateFunctionClientTree(tree)).toThrow("MODS_UI_CLIENT_ENGINE")
  })
})
