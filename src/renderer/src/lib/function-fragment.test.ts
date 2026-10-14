import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import { Element } from "../components/chat/FunctionPanes"
import type { FunctionUiElement, FunctionUiNode } from "../../../shared/mods/v2/ui"

const text = (value: string): FunctionUiNode => ({ type: "Text", props: {}, children: [value] })

describe("actual Element transparent Fragment rendering", () => {
  it("places nested children directly in their original horizontal parent", () => {
    const tree: FunctionUiElement = {
      type: "Box", props: { flexDirection: "row" }, children: [text("left"), {
        type: "fragment", children: [text("middle"), {
          type: "fragment", children: [text("right")]
        }]
      }]
    }
    const act = vi.fn(async () => {})
    const html = renderToStaticMarkup(createElement(Element, { node: tree, busy: false, act }))
    expect(html.match(/<div/g)).toHaveLength(1)
    expect(html.match(/<span/g)).toHaveLength(3)
    expect(html).toContain("flex-direction:row")
    expect(html).toMatch(/<span[^>]*>left<\/span><span[^>]*>middle<\/span><span[^>]*>right<\/span>/)
    expect(act).not.toHaveBeenCalled()
  })

  it("renders empty root fragments and structural-only children without a container or action", () => {
    const act = vi.fn(async () => {})
    for (const tree of [
      { type: "fragment", children: [] } satisfies FunctionUiElement,
      { type: "fragment", children: [{ type: "fragment", children: [] }] } satisfies FunctionUiElement
    ]) expect(renderToStaticMarkup(createElement(Element, { node: tree, busy: false, act }))).toBe("")
    expect(act).not.toHaveBeenCalled()
  })

  it("calls the original native delegate once through nested fragments", () => {
    const act = vi.fn(async () => {})
    const renderEngine = vi.fn((ref: number) => createElement("button", { "data-ref": ref }, "actual"))
    const tree: FunctionUiElement = {
      type: "fragment", children: [{ type: "fragment", children: [{ type: "engine", ref: 4 }] }]
    }
    const html = renderToStaticMarkup(createElement(Element, { node: tree, busy: false, act, renderEngine }))
    expect(html).toBe('<button data-ref="4">actual</button>')
    expect(renderEngine).toHaveBeenCalledExactlyOnceWith(4)
    expect(act).not.toHaveBeenCalled()
  })
})
