import { describe, expect, it } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import type { FunctionNativeContent } from "../../../shared/mods/v2/engine"
import { validateFunctionNativeContent } from "../../../shared/mods/v2/engine"
import type { FunctionUiElement } from "../../../shared/mods/v2/ui"
import {
  functionInlineLabel,
  functionInlineTree,
  functionNativeHint
} from "./function-native-content"

const modes: FunctionNativeContent = {
  component: "SessionMode",
  entries: [
    { ref: 0, props: { modes: ["safe mode"] } },
    { ref: 1, props: { modes: ["next mode"] } }
  ]
}

describe("native inline presentation", () => {
  it("keeps nested labels in spans within the one original trigger", () => {
    const tree: FunctionUiElement = {
      type: "Box",
      props: { gap: 1 },
      children: [
        { type: "Text", props: { bold: true }, children: ["Review "] },
        { type: "engine", ref: 1 }
      ]
    }
    const html = renderToStaticMarkup(
      createElement(
        "button",
        null,
        functionInlineLabel(tree, modes, (props) => (props.modes as string[]).join(" & "))
      )
    )
    expect(html).toContain("next mode")
    expect(html).toContain("Review ")
    expect(html.match(/<button/g)).toHaveLength(1)
    expect(html).not.toMatch(/<div|<section/)
  })

  it("does not adopt interactive custom trees as trigger children", () => {
    const tree: FunctionUiElement = {
      type: "Box",
      props: {},
      children: [
        { type: "Button", props: { key: "action", label: "custom" } },
        { type: "engine", ref: 0 }
      ]
    }
    expect(functionInlineTree(tree)).toBe(false)
    expect(functionInlineLabel(tree, modes, () => "mode")).toBeNull()
  })

  it("uses protected ref zero for unknown hints and keeps complex hints separate", () => {
    const native: FunctionNativeContent = {
      component: "PromptHint",
      entries: [
        { ref: 0, props: { hint: "safe hint" } },
        { ref: 1, props: { hint: "next hint" } }
      ]
    }
    expect(functionNativeHint({ type: "engine", ref: 500 }, native)).toBe("safe hint")
    expect(
      functionNativeHint(
        { type: "Box", props: {}, children: ["prefix ", { type: "engine", ref: 1 }] },
        native
      )
    ).toBe("prefix next hint")
    expect(
      functionNativeHint({ type: "Button", props: { key: "x", label: "x" } }, native)
    ).toBeNull()
  })

  it("rejects duplicate references, component swaps and stale Ask IDs", () => {
    expect(() => validateFunctionNativeContent(modes, "SessionMode")).not.toThrow()
    expect(() => validateFunctionNativeContent(modes, "Spinner")).toThrow(
      "MODS_UI_NATIVE_PUBLICATION"
    )
    expect(() =>
      validateFunctionNativeContent({ ...modes, entries: [modes.entries[0], modes.entries[0]] })
    ).toThrow("MODS_UI_NATIVE_PUBLICATION")
    expect(() =>
      validateFunctionNativeContent(
        { component: "AskUserQuestion", requestId: "R2", entries: [{ ref: 0, props: {} }] },
        "AskUserQuestion",
        "R1"
      )
    ).toThrow("MODS_UI_NATIVE_PUBLICATION")
  })
})

describe("transparent inline fragments", () => {
  it("preserves labels in the one original trigger without adding a layout wrapper", () => {
    const tree: FunctionUiElement = {
      type: "fragment", children: ["Review ", { type: "fragment", children: [{ type: "engine", ref: 1 }] }]
    }
    const html = renderToStaticMarkup(createElement(
      "button", null,
      functionInlineLabel(tree, modes, (props) => (props.modes as string[]).join(" & "))
    ))
    expect(html).toContain("Review <span>next mode</span>")
    expect(html.match(/<button/g)).toHaveLength(1)
    expect(html).not.toMatch(/<div|<section|display/)
    expect(functionInlineLabel({ type: "fragment", children: [] }, modes, () => "mode"))
      .not.toBeNull()
  })

  it("never puts a hidden interactive child inside the original mode Button", () => {
    const tree: FunctionUiElement = { type: "fragment", children: [{
      type: "fragment", children: [{
        type: "Button", props: { key: "review", label: "Review" },
        press: { plugin: "p", handle: 1 }
      }]
    }] }
    expect(functionInlineTree(tree)).toBe(false)
    expect(functionInlineLabel(tree, modes, () => "mode")).toBeNull()
    expect(functionNativeHint(tree, undefined)).toBeNull()
  })

  it.each(["plain", "link"] as const)(
    "keeps %s Markdown out of the original mode trigger and composer placeholder",
    (kind) => {
      const leaf: FunctionUiElement = kind === "plain"
        ? { type: "Markdown", props: { text: "Plain independent block" } }
        : { type: "Markdown", props: { key: "report", text: "[report](https://example.test)" },
          press: { kind: "onLinkPress", plugin: "Q", handle: 1 } }
      const tree: FunctionUiElement = { type: "fragment", children: [
        { type: "Box", props: {}, children: [leaf] }, { type: "engine", ref: 0 }
      ] }
      let labels = 0
      expect(functionInlineTree(leaf)).toBe(false)
      expect(functionInlineTree(tree)).toBe(false)
      expect(functionInlineLabel(tree, modes, () => { labels++; return "mode" })).toBeNull()
      expect(labels).toBe(0)
      expect(functionNativeHint(tree, {
        component: "PromptHint", entries: [{ ref: 0, props: { hint: "original safe hint" } }]
      })).toBeNull()
    }
  )
})
