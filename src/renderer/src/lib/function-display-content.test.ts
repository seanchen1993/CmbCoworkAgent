import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { expect, it, vi } from "vitest"
vi.mock("../components/tabs/code-highlight-client", () => ({ requestCodeHighlight: vi.fn() }))
import { FunctionDisplayContent } from "../components/chat/FunctionDisplayContent"
import type { FunctionDisplaySnapshotData } from "../../../shared/mods/v2/display-snapshot"

it("renders only the protected native payload with no inert ancestor or drawing metadata", () => {
  const data: FunctionDisplaySnapshotData = {
    component: "AssistantMessage",
    nativeContent: {
      component: "AssistantMessage",
      nativeUnchanged: true,
      entries: [{ ref: 0, props: { text: "protected text", isFirstOfReply: true } }]
    }
  }
  const renderNative = vi.fn((props) =>
    createElement(
      "div",
      { className: "native-text" },
      createElement("button", { type: "button" }, "Copy"),
      String(props.text)
    )
  )
  const html = renderToStaticMarkup(createElement(FunctionDisplayContent, { data, renderNative }))
  expect(renderNative).toHaveBeenCalledWith({ text: "protected text", isFirstOfReply: true })
  expect(html).toContain("protected text")
  expect(html).toContain("Copy")
  expect(html).not.toContain("inert")
  expect(html).not.toContain("aria-disabled")
  expect(html).not.toContain("data-function-handle")
  expect(html).not.toContain("data-function-plugin")
})

it("formats a pure Markdown leaf without activating any link or preview callback", () => {
  const html = renderToStaticMarkup(
    createElement(FunctionDisplayContent, {
      data: {
        component: "AssistantMessage",
        tree: {
          type: "Markdown",
          props: {
            text: "**protected** [preview](file:///workspace/private.md) [web](https://example.com)"
          }
        }
      }
    })
  )
  expect(html).toContain("<strong>protected</strong>")
  expect(html).not.toContain("href=")
  expect(html).not.toContain("data-function-handle")
})
