import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { expect, it, vi } from "vitest"
vi.mock("../components/tabs/code-highlight-client", () => ({ requestCodeHighlight: vi.fn() }))
import { FunctionCode } from "../components/chat/FunctionCode"

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
