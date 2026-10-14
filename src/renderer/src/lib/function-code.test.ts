import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { expect, it, vi } from "vitest"
vi.mock("../components/tabs/code-highlight-client", () => ({ requestCodeHighlight: vi.fn() }))
import { FunctionCode } from "../components/chat/FunctionCode"
import { Element } from "../components/chat/FunctionPanes"
import type { FunctionUiElement } from "../../../shared/mods/v2/ui"

it("escapes code and draws diff markers, gutters and wrap without exposing a file path", () => {
  const html = renderToStaticMarkup(
    createElement(FunctionCode, {
      props: {
        source: "@@ -1 +1 @@\n-<script>old</script>\n+<img onerror=alert(1)>",
        format: "diff",
        path: "private/secret.ts",
        wrap: "truncate-end"
      }
    })
  )
  expect(html).toContain('data-code-kind="remove"')
  expect(html).toContain('data-code-kind="add"')
  expect(html).toContain("&lt;script&gt;")
  expect(html).not.toContain("<img")
  expect(html).not.toContain("private/secret.ts")
  expect(html).toContain("truncate")
})

it("uses the same budget through actual fragment, box and link renderers", () => {
  const root: FunctionUiElement = {
    type: "fragment",
    children: [
      { type: "Code", props: { source: "a".repeat(70000) } },
      {
        type: "Box",
        props: {},
        children: [
          {
            type: "Link",
            props: { href: "https://example.com" },
            children: [{ type: "Code", props: { source: "b".repeat(70000) } }]
          }
        ]
      }
    ]
  }
  const before = JSON.stringify(root)
  const html = renderToStaticMarkup(
    createElement(Element, {
      node: root,
      busy: false,
      act: async () => undefined
    })
  )
  expect(html).toContain("a".repeat(70000))
  expect(html).toContain("b".repeat(30000))
  expect(html).not.toContain("b".repeat(30001))
  expect(JSON.stringify(root)).toBe(before)
})

it("renders long code from a bounded copy and leaves the source untouched", () => {
  const props = { source: "a".repeat(120000) + "PRIVATE_TAIL" }
  const html = renderToStaticMarkup(createElement(FunctionCode, { props }))
  expect(html).toContain("a".repeat(100000))
  expect(html).not.toContain("a".repeat(100001))
  expect(html).not.toContain("PRIVATE_TAIL")
  expect(props.source).toHaveLength(120012)
})

it("renders a malformed diff as escaped source with no line gutters", () => {
  const html = renderToStaticMarkup(
    createElement(FunctionCode, {
      props: { source: "<script>plain</script>", format: "diff", startLine: 17 }
    })
  )
  expect(html).toContain("&lt;script&gt;plain&lt;/script&gt;")
  expect(html).toContain('data-code-kind="source"')
  expect(html).not.toContain('aria-hidden="true"')
  expect(html).not.toContain('data-code-kind="add"')
})
