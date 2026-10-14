import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { expect, it } from "vitest"
import { Element } from "../components/chat/FunctionPanes"
import { FunctionClient } from "../components/chat/FunctionClient"
import { ProtectedFunctionPreview } from "../components/panels/ProtectedFunctionPreview"
import type { FunctionUiElement } from "../../../shared/mods/v2/ui"
import type { FunctionMarkdownContext } from "../components/chat/FunctionMarkdown"
import { functionInlineLabel, functionNativeHint } from "./function-native-content"

const markdown: FunctionMarkdownContext = {
  threadId: "thread", address: { kind: "pane", pane: "pane", generation: "g1" },
  links: [{ nodePath: [0, 1, 0], nonce: "actual-leaf" }]
}
const tree: FunctionUiElement = { type: "fragment", children: [{ type: "Box", props: {},
  children: ["before", { type: "fragment", children: [{ type: "Markdown", props: {
    text: "**Report** [read](https://example.test/report)"
  } }] }] }] }

it("uses the final nested Fragment/Box path to consume only the matching host sidecar", () => {
  const source = JSON.stringify(tree)
  const html = renderToStaticMarkup(createElement(Element, {
    node: tree, busy: false, act: async () => {}, markdown
  }))
  expect(html).toContain("<strong>Report</strong>")
  expect(html).toContain('href="https://example.test/report"')
  expect(html).not.toContain("data-chat-search-text")
  expect(JSON.stringify(tree)).toBe(source)
  const noReceipt = renderToStaticMarkup(createElement(Element, {
    node: tree, busy: false, act: async () => {},
    markdown: { ...markdown, links: [{ nodePath: [1, 0], nonce: "another-leaf" }] }
  }))
  expect(noReceipt).toContain("<strong>Report</strong>")
  expect(noReceipt).not.toContain("href=")
})

it("keeps HTML literal and images inert while reusing the original code and table formatting", () => {
  const node: FunctionUiElement = { type: "Markdown", props: { text:
    "<context>visible</context>\n\n![image label](https://example.test/image.png)\n\n" +
    "| Name | Value |\n| --- | --- |\n| Report | Done |\n\n```ts\nconst value = 1\n```" } }
  const html = renderToStaticMarkup(createElement(Element, {
    node, busy: false, act: async () => {}
  }))
  expect(html).toContain("&lt;context&gt;visible&lt;/context&gt;")
  expect(html).toContain("image label")
  expect(html).not.toContain("<img")
  expect(html).not.toContain("<context>")
  expect(html).toContain("streaming-markdown-table-wrap")
  expect(html).toContain("streaming-markdown-code-block")
  expect(html).toContain("复制代码")
})

it("starts an actual Client tree at its own root instead of borrowing the outer pane path", () => {
  const html = renderToStaticMarkup(createElement(FunctionClient, {
    threadId: "thread", pane: "parent", node: { type: "Client", props: {
      key: "local", module: "client.tsx"
    }, client: { plugin: "Q" } }, snapshot: {
      id: "instance", generation: "cg1", plugin: "Q", element: "local", module: "client.tsx",
      tree: { type: "Markdown", props: { text: "[client](https://example.test/client)" } },
      markdownLinks: [{ nodePath: [], nonce: "client-leaf" }]
    }, refresh: () => {}, render: (node, busy, act, context) => {
      expect(context.address).toEqual({ kind: "client", pane: "parent", instance: "instance",
        generation: "cg1" })
      return createElement(Element, { node, busy, act, markdown: context })
    }
  }))
  expect(html).toContain('href="https://example.test/client"')
})

it("does not display event-supplied preview text before the actual native receipt is read", () => {
  const html = renderToStaticMarkup(createElement(ProtectedFunctionPreview, {
    request: { threadId: "thread", address: { kind: "pane", pane: "pane", generation: "g1" },
      intentId: 1, preview: { receipt: "actual-receipt", title: "FORGED_TITLE",
        text: "RAW_EVENT_TEXT" } }, onClose: () => {}
  }))
  expect(html).not.toContain("RAW_EVENT_TEXT")
  expect(html).not.toContain("FORGED_TITLE")
  expect(html).toContain("正在验证当前组件和读取权限")
})

it("formats Markdown as its own block rather than a nested original mode label or hint", () => {
  const node: FunctionUiElement = { type: "Markdown", props: {
    text: "**Independent content** [report](https://example.test/report)"
  } }
  const label = functionInlineLabel(node, undefined, () => "original mode")
  expect(label).toBeNull()
  expect(functionNativeHint(node, undefined)).toBeNull()
  const html = renderToStaticMarkup(createElement(Element, {
    node, busy: false, act: async () => {}, markdown: { ...markdown,
      links: [{ nodePath: [], nonce: "own-leaf" }] }
  }))
  expect(html).toContain("<strong>Independent content</strong>")
  expect(html).toContain('href="https://example.test/report"')
  expect(html).not.toContain("<button")
})
