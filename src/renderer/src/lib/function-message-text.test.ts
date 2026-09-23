import { createElement, isValidElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { expect, it, vi } from "vitest"
vi.mock("../components/tabs/code-highlight-client", () => ({ requestCodeHighlight: vi.fn() }))
import { FunctionMessageText } from "../components/chat/FunctionMessageText"

it.each(["user", "assistant"] as const)(
  "keeps rich native %s content before any module renders",
  (role) => {
    const html = renderToStaticMarkup(
      createElement(FunctionMessageText, {
        threadId: "thread",
        role,
        text: "actual text",
        isExpanded: true,
        isFirstOfReply: true,
        fallback: createElement(
          "a",
          { href: "#original", "data-chat-search-text": true },
          "actual text"
        )
      })
    )
    expect(html).toContain(
      `data-function-site="${role === "user" ? "UserMessage" : "AssistantMessage"}"`
    )
    expect(html).toContain('href="#original"')
    expect(html).toContain("data-chat-search-text")
    expect(html).toContain('class="contents"')
    expect(html).not.toContain("text-muted-foreground")
  }
)

it("does not serialize or mount a guest for oversized transcript text", () => {
  const html = renderToStaticMarkup(
    createElement(FunctionMessageText, {
      threadId: "thread",
      role: "user",
      text: "x".repeat(10001),
      isExpanded: false,
      isFirstOfReply: false,
      fallback: createElement("span", {}, "original rich content")
    })
  )
  expect(html).toBe("<span>original rich content</span>")
})

it("never infers a message's author from its user role", () => {
  const node = FunctionMessageText({
    threadId: "thread",
    role: "user",
    text: "task notification",
    isExpanded: false,
    isFirstOfReply: false,
    fallback: null
  })
  if (!isValidElement<{ facts: unknown }>(node)) throw Error("Missing message site")
  expect(node.props.facts).toEqual({
    text: "task notification",
    origin: { kind: "unclassified" },
    isExpanded: false
  })
})
