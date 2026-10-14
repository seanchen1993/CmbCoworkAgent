import type { Nodes } from "hast"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { describe, expect, it } from "vitest"
import {
  FUNCTION_MARKDOWN_MAX_DEPTH,
  functionMarkdownRehype,
  functionMarkdownRemark,
  functionMarkdownUrlTransform,
  parseFunctionMarkdown,
  validateFunctionMarkdownProps
} from "./markdown"

function render(text: string): string {
  return renderToStaticMarkup(
    createElement(
      ReactMarkdown,
      {
        remarkPlugins: [remarkGfm, functionMarkdownRemark],
        rehypePlugins: [functionMarkdownRehype],
        urlTransform: functionMarkdownUrlTransform
      },
      text
    )
  )
}

function textOf(node: Nodes): string {
  if (node.type === "text" || node.type === "raw") return node.value
  return "children" in node ? node.children.map(textOf).join("") : ""
}

describe("bounded Function Markdown data", () => {
  it("accepts empty display text and native callback data at the declared boundaries", () => {
    for (const props of [
      { text: "" },
      { text: "x".repeat(10000), dimColor: false },
      { text: "tab\tline\nnext", key: "key".repeat(80) }
    ])
      expect(() => validateFunctionMarkdownProps(Object.freeze(props))).not.toThrow()
    const props = Object.freeze({
      text: "actions",
      key: "links",
      pressableLinks: Object.freeze(Array(256).fill("h".repeat(2048)))
    })
    expect(() => validateFunctionMarkdownProps(props, true)).not.toThrow()
    expect(() =>
      validateFunctionMarkdownProps({ text: "actions", key: "k", pressableLinks: [] }, true)
    ).not.toThrow()
  })

  it("rejects leaf children, closure props, hidden fields, accessors and malformed action lists", () => {
    const hidden = { text: "visible" }
    Object.defineProperty(hidden, "children", { value: [], enumerable: false })
    const getter = { text: "text" }
    Object.defineProperty(getter, "dimColor", {
      get: () => {
        throw new Error("not read")
      },
      enumerable: true
    })
    const symbol = { text: "text", [Symbol("metadata")]: 1 }
    const sparse = new Array(1)
    for (const props of [
      null,
      [],
      {},
      { text: 7 },
      { text: "x".repeat(10001) },
      { text: "bad\u001b[31m" },
      { text: "bad\u0085" },
      { text: "bad\rline" },
      { text: "text", key: "" },
      { text: "text", key: "k".repeat(257) },
      { text: "text", dimColor: 0 },
      { text: "text", children: [] },
      { text: "text", onLinkPress: () => undefined },
      hidden,
      getter,
      symbol,
      Object.setPrototypeOf({ text: "text" }, { inherited: true }),
      { text: "text", pressableLinks: [] }
    ])
      expect(() => validateFunctionMarkdownProps(props)).toThrow("MODS_UI_MARKDOWN_INVALID")
    for (const props of [
      { text: "text" },
      { text: "text", key: "k", pressableLinks: sparse },
      { text: "text", key: "k", pressableLinks: [""] },
      { text: "text", key: "k", pressableLinks: Array(257).fill("link") },
      { text: "text", key: "k", pressableLinks: ["x".repeat(2049)] }
    ])
      expect(() => validateFunctionMarkdownProps(props, true)).toThrow("MODS_UI_MARKDOWN_INVALID")
  })

  it("allows independent Markdown web targets and keeps exact encoded hrefs", () => {
    for (const href of [
      "https://example.com",
      "http://example.com/a",
      "http://localhost:8080/",
      "HTTPS://example.com/a%20b?q=one&other=two",
      "https://example.com/#part",
      "https://example.com/a@b",
      "http://[::1]:8080/a"
    ])
      expect(functionMarkdownUrlTransform(href)).toBe(href)
    expect(functionMarkdownUrlTransform("https://example.com/a", "src")).toBe("")
  })

  it("refuses empty authority, credentials, unsafe schemes, controls and backslash aliases", () => {
    for (const href of [
      "",
      "/relative",
      "#fragment",
      "//example.com",
      "mailto:a@example.com",
      "javascript:alert(1)",
      "data:text/html,hello",
      "blob:https://example.com/a",
      "https:///example.com",
      "https:////example.com",
      "https://?a",
      "https://.",
      "https://user@example.com",
      "https://user:password@example.com",
      "https://example.com\\evil",
      "https://example.com/a b",
      "https://example.com/\u000a",
      "https://example.com/\u0085",
      "https://example.com/" + "x".repeat(2048)
    ])
      expect(functionMarkdownUrlTransform(href)).toBe("")
  })

  it("only admits raw empty-authority absolute file URLs as targets, without granting a read", () => {
    for (const href of [
      "file:///C:/project/report.md",
      "file:///C:/project/report%20one.md",
      "file:///workspace/report.md"
    ])
      expect(functionMarkdownUrlTransform(href)).toBe(href)
    for (const href of [
      "file:/C:/a",
      "file:C:/a",
      "file://localhost/C:/a",
      "file://server/a",
      "file:////server/a",
      "file:///",
      "file:///C:/a?query",
      "file:///C:/a#fragment",
      "file:///C:/a%2fb",
      "file:///C:/a%5Cb",
      "file:///C:/a%00b",
      "file:///C:\\a"
    ])
      expect(functionMarkdownUrlTransform(href)).toBe("")
  })
})

describe("actual remark-to-HAST Function Markdown", () => {
  it("collects final ordered targets from references, autolinks, entities and GFM tables", () => {
    const source = [
      "[中文](https://example.com/中文?q=one&amp;v=two)",
      "[reference][target] and <https://example.com/autolink> and https://example.com/gfm",
      "",
      "[target]: file:///C:/project/report%20one.md",
      "",
      "| title | link |",
      "| --- | --- |",
      "| row | [table](http://example.com/table) |",
      "",
      "[duplicate](https://example.com/autolink)"
    ].join("\n")
    expect(parseFunctionMarkdown(source).hrefs).toEqual([
      "https://example.com/%E4%B8%AD%E6%96%87?q=one&v=two",
      "file:///C:/project/report%20one.md",
      "https://example.com/autolink",
      "https://example.com/gfm",
      "http://example.com/table"
    ])
    expect(Object.isFrozen(parseFunctionMarkdown(source).hrefs)).toBe(true)
    const html = render(source)
    expect(html).toContain('href="https://example.com/%E4%B8%AD%E6%96%87?q=one&amp;v=two"')
    expect(html).toContain('href="file:///C:/project/report%20one.md"')
    expect(html).toContain("<table>")
  })

  it("does not discover code, escaped syntax, HTML attributes or unsafe destinations", () => {
    const source = [
      "`[inline](https://example.com/code)`",
      "",
      "```md",
      "[fenced](https://example.com/fenced)",
      "```",
      "",
      "\\[escaped](not-a-url)",
      "",
      '<a href="https://example.com/raw">literal HTML</a>',
      "",
      "[unsafe](javascript:alert%281%29) [relative](/workspace/a) [credentials](https://user@example.com/a)"
    ].join("\n")
    expect(parseFunctionMarkdown(source).hrefs).toEqual([])
    const html = render(source)
    expect(html).not.toContain("<a ")
    expect(html).toContain("&lt;a href=")
    expect(html).toContain("[fenced](https://example.com/fenced)")
    expect(html).toContain("unsafe relative credentials")
  })

  it("keeps context/script/HTML text literal and replaces images with their alt text", () => {
    const source =
      "<context>literal</context>\n\n<script>alert(1)</script>\n\n" +
      "![logo](https://example.com/remote.png) ![local](file:///C:/secret.png)\n\n" +
      "[![wrapped alt](https://example.com/remote.png)](https://example.com/safe)"
    const parsed = parseFunctionMarkdown(source)
    expect(parsed.hrefs).toEqual(["https://example.com/safe"])
    expect(textOf(parsed.tree)).toContain("<context>literal</context>")
    expect(textOf(parsed.tree)).toContain("<script>alert(1)</script>")
    expect(textOf(parsed.tree)).toContain("logo local")
    const html = render(source)
    expect(html).not.toContain("<img")
    expect(html).not.toContain("<script>")
    expect(html).toContain("&lt;context&gt;literal&lt;/context&gt;")
    expect(html).toContain('href="https://example.com/safe">wrapped alt</a>')
  })

  it("preserves formatting while unwrapping an unsupported link", () => {
    const parsed = parseFunctionMarkdown("[**strong** text](javascript:bad)")
    expect(parsed.hrefs).toEqual([])
    expect(render("[**strong** text](javascript:bad)")).toBe("<p><strong>strong</strong> text</p>")
  })

  it("bounds source and parser depth before the recursive HAST conversion", () => {
    expect(() => parseFunctionMarkdown("x".repeat(10000))).not.toThrow()
    expect(() => parseFunctionMarkdown("x".repeat(10001))).toThrow("MODS_UI_MARKDOWN_INVALID")
    const deep = "> ".repeat(FUNCTION_MARKDOWN_MAX_DEPTH + 1) + "deep"
    expect(() => parseFunctionMarkdown(deep)).toThrow("MODS_UI_MARKDOWN_LIMIT")
    expect(() => render(deep)).toThrow("MODS_UI_MARKDOWN_LIMIT")
  })

  it("uses request-local owned trees and never rewrites the input leaf", () => {
    const props = Object.freeze({ text: "[safe](https://example.com/a)" })
    const first = parseFunctionMarkdown(props.text)
    const second = parseFunctionMarkdown(props.text)
    first.tree.children.length = 0
    expect(second.hrefs).toEqual(["https://example.com/a"])
    expect(textOf(second.tree)).toBe("safe")
    expect(props.text).toBe("[safe](https://example.com/a)")
  })
})
