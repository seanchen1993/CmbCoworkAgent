import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { expect, it, vi } from "vitest"
import type { FunctionSite } from "../components/chat/FunctionSite"
import { ModsChatScope } from "./mods-chat-scope"
const observed = vi.hoisted(() => ({ props: undefined as Parameters<typeof FunctionSite>[0] | undefined }))
vi.mock("../components/tabs/code-highlight-client", () => ({ requestCodeHighlight: vi.fn() }))
vi.mock("../components/chat/FunctionSite", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../components/chat/FunctionSite")>()
  return { ...actual, FunctionSite: (props: Parameters<typeof actual.FunctionSite>[0]) => {
    observed.props = props
    return createElement(actual.FunctionSite, props)
  } }
})
import { FunctionMessageText } from "../components/chat/FunctionMessageText"

it.each(["user", "assistant"] as const)(
  "keeps rich native %s content before any module renders",
  (role) => {
    const html = renderToStaticMarkup(
      createElement(FunctionMessageText, {
        threadId: "thread",
        messageId: "message",
        role,
        text: "actual text",
        isExpanded: true,
        isFirstOfReply: true,
        renderText: (text) => createElement("span", {}, text),
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

it("retains complete oversized text at the protected host message surface", () => {
  const text = "x".repeat(10001)
  const html = renderToStaticMarkup(
    createElement(FunctionMessageText, {
      threadId: "thread",
      messageId: "message",
      role: "user",
      text,
      isExpanded: false,
      isFirstOfReply: false,
      renderText: (text) => createElement("span", {}, text),
      fallback: createElement("span", {}, "original rich content")
    })
  )
  expect(html).toBe('<section data-function-site="UserMessage" class="contents"><span>original rich content</span></section>')
  expect(observed.props?.facts).toEqual({ text, origin: { kind: "unclassified" }, isExpanded: false })
  expect(observed.props?.component).toBe("UserMessage")
  expect(observed.props?.renderNative).toBeTypeOf("function")
})

it("does not expose an oversized raw fallback when an enabled peer cannot protect it", () => {
  const html = renderToStaticMarkup(createElement(ModsChatScope.Provider, {
    value: { threadId: "thread", enabled: true }
  }, createElement(FunctionMessageText, {
    threadId: "thread", messageId: "message", role: "assistant",
    text: "PRIVATE".repeat(2000), isExpanded: true, isFirstOfReply: true,
    renderText: text => createElement("span", {}, text),
    fallback: createElement("span", {}, "unprotected original rich content")
  })))
  expect(html).toContain('role="alert"')
  expect(html).not.toContain("PRIVATE")
  expect(html).not.toContain("unprotected original rich content")
})

it("never infers a message's author from its user role", () => {
  renderToStaticMarkup(createElement(FunctionMessageText, {
    threadId: "thread",
    messageId: "message",
    role: "user",
    text: "task notification",
    isExpanded: false,
    isFirstOfReply: false,
    renderText: (text) => createElement("span", {}, text),
    fallback: null
  }))
  expect(observed.props?.facts).toEqual({
    text: "task notification",
    origin: { kind: "unclassified" },
    isExpanded: false
  })
})
