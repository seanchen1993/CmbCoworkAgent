import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { expect, it } from "vitest"
import { FunctionLogsContent } from "../components/chat/FunctionLogs"

it("renders escaped plugin-labelled rows without a model message or executable content", () => {
  const html = renderToStaticMarkup(
    createElement(FunctionLogsContent, {
      entries: [{ id: "line", plugin: "review", text: "<script>bad</script>" }]
    })
  )
  expect(html).toContain("插件日志")
  expect(html).toContain("review")
  expect(html).toContain("&lt;script&gt;")
  expect(html).not.toContain("<script>")
})

it("renders no container when there are no logs", () => {
  expect(renderToStaticMarkup(createElement(FunctionLogsContent, { entries: [] }))).toBe("")
})
