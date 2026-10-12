import { expect, it, vi } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { defaultUrlTransform } from "react-markdown"
import { botMessageLink } from "../../../shared/bot-deep-link"
import { botMarkdownUrlTransform } from "./bot-markdown-links"
import { BotMessageMarkdown } from "../components/bots/BotMessageMarkdown"

vi.mock("@/lib/thread-context", () => ({
  useThreadStateSelector: (_id: unknown, selector: (value: unknown) => unknown) =>
    selector({ workspacePath: null, workspaceFiles: [] })
}))

const internal = botMessageLink({
  conversationId: "11111111-1111-4111-8111-111111111111",
  messageId: "22222222-2222-4222-8222-222222222222"
})
const node = { type: "element" as const, tagName: "a", properties: {}, children: [] }

it("allows only canonical internal message anchors while the generic default remains unchanged", () => {
  expect(defaultUrlTransform(internal)).toBe("")
  expect(botMarkdownUrlTransform(internal, "href", node)).toBe(internal)
  expect(botMarkdownUrlTransform(internal.replace("cmbcowork:", "CMBCOWORK:"), "href", node)).toBe(
    internal
  )
  expect(botMarkdownUrlTransform(internal, "src", node)).toBe("")
})

it("does not turn arbitrary app or executable protocols into links", () => {
  for (const url of [
    internal.replace("://app/", "://evil/"),
    internal.toUpperCase(),
    internal.replace("/v1/", "/v2/"),
    `${internal}?nonce=1`,
    `${internal}#fragment`,
    "cmbcowork://user:password@app/whatever",
    "javascript:alert(1)",
    "data:text/html,hello",
    "file:///etc/passwd",
    "custom-app://open"
  ])
    expect(botMarkdownUrlTransform(url, "href", node), url).toBe("")
})

it("delegates ordinary links and images to the existing Markdown safe policy", () => {
  for (const url of [
    "https://example.org/a?q=1#section",
    "http://localhost:9000/",
    "mailto:hello@example.org",
    "#section",
    "/document",
    "./asset.png",
    "C:/private/file.ts"
  ]) {
    expect(botMarkdownUrlTransform(url, "href", node)).toBe(defaultUrlTransform(url))
    expect(botMarkdownUrlTransform(url, "src", node)).toBe(defaultUrlTransform(url))
  }
})

it("keeps Chinese prose outside literal links, including help acknowledgements", () => {
  const text =
    "请在 http://127.0.0.1:57685/manual）上找到表单。再访问 https://example.org/路径。下一句"
  const html = renderToStaticMarkup(createElement(BotMessageMarkdown, null, text))
  expect(html).toContain('href="http://127.0.0.1:57685/manual"')
  expect(html).toContain(`href="${encodeURI("https://example.org/路径")}"`)
  expect(html).toContain("</a>）上找到表单。")
  expect(html).toContain("</a>。下一句")
})

it("preserves explicit destinations, encoded punctuation, Unicode paths and code", () => {
  const html = renderToStaticMarkup(
    createElement(
      BotMessageMarkdown,
      null,
      "[文档](https://example.org/路径）继续) <https://example.org/路径）继续> " +
        "https://example.org/文档?q=%EF%BC%89 `https://example.org/路径）继续`"
    )
  )
  expect(html.split(`href="${encodeURI("https://example.org/路径）继续")}"`)).toHaveLength(3)
  expect(html).toContain(`href="${encodeURI("https://example.org/文档")}?q=%EF%BC%89"`)
  expect(html).toContain(
    'class="streaming-markdown-inline-code">https://example.org/路径）继续</code>'
  )
})

it("retains a valid partial URL without consuming the following Chinese sentence", () => {
  const html = renderToStaticMarkup(
    createElement(BotMessageMarkdown, null, "https://example.org/。正在读取")
  )
  expect(html).toContain('href="https://example.org/"')
  expect(html).toContain("</a>。正在读取")
})
