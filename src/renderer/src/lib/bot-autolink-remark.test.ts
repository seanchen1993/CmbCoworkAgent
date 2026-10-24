import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { describe, expect, it, vi } from "vitest"
import { StreamingMarkdown } from "../components/chat/StreamingMarkdown"
import { remarkBotAutolinks } from "./bot-autolink-remark"
import { remarkBotMentions } from "./bot-mention-remark"
import type { Root } from "mdast"
import { VFile } from "vfile"

vi.mock("@/lib/thread-context", () => ({
  useThreadStateSelector: (_id: unknown, selector: (state: unknown) => unknown) =>
    selector({ workspacePath: null, workspaceFiles: [] })
}))
const render = (text: string, botTranscript = true, isStreaming = false) =>
  renderToStaticMarkup(
    createElement(StreamingMarkdown, { children: text, botTranscript, isStreaming })
  )
const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1])

describe("Bot bare URLs within the existing Markdown parser", () => {
  it.each([
    ["https://example.com（标题「Example", "https://example.com"],
    ["www.example.com（标题「Example", "https://www.example.com"]
  ])(
    "constructs the exact retained href when the existing destination is normalized: %s",
    (label, expected) => {
      const url = new URL(label.startsWith("www.") ? `https://${label}` : label).href
      const tree: Root = {
        type: "root",
        children: [
          {
            type: "paragraph",
            children: [
              {
                type: "link",
                url,
                children: [{ type: "text", value: label }],
                position: {
                  start: { line: 1, column: 1, offset: 0 },
                  end: { line: 1, column: label.length + 1, offset: label.length }
                }
              }
            ]
          }
        ]
      }
      remarkBotAutolinks()(tree, new VFile(label))
      const child = tree.children[0]
      expect(
        child.type === "paragraph" && child.children[0].type === "link" && child.children[0].url
      ).toBe(expected)
    }
  )

  it.each([false, true])(
    "separates Chinese prose in both observed replies without reinterpreting Markdown (streaming=%s)",
    (streaming) => {
      const first = render(
        "已在新标签页打开 https://example.com（标题「Example Domain」），并已请求协助。",
        true,
        streaming
      )
      expect(hrefs(first)).toEqual(["https://example.com"])
      expect(first).toContain("（标题「Example Domain」），并已请求协助。")
      const second = render(
        "归还后重新读取同一页面：仍在 **https://example.com/**，页面标题「Example Domain」，页面内容与之前一致。",
        true,
        streaming
      )
      // The original parser consumed the emphasis delimiter; this fix only
      // returns CJK prose to text and does not invent Markdown semantics.
      expect(hrefs(second)).toEqual(["https://example.com/"])
      expect(second).toContain("</a>**，页面标题「Example Domain」")
      expect(second).not.toContain("<strong>")
    }
  )

  it.each([
    "**https://example.com/**，@甲 后文",
    "https://example.com/，@甲 后文",
    "😀\n\n**https://example.com/**，@甲 后文"
  ])("retains original coordinates for a selected Bot after %s", (text) => {
    const start = text.indexOf("@甲")
    const html = renderToStaticMarkup(
      createElement(ReactMarkdown, {
        children: text,
        remarkPlugins: [
          remarkGfm,
          remarkBotAutolinks,
          [
            remarkBotMentions,
            {
              mentions: [{ botId: "exact-id", label: "甲", start: 100 + start, end: 102 + start }],
              start: 100
            }
          ]
        ]
      })
    )
    expect(html).toContain('<span data-bot-mention="0">@甲</span>')
    expect(hrefs(html)).toEqual(["https://example.com/"])
  })

  it("preserves explicit destinations, code, email, Unicode paths and balanced ASCII URL punctuation", () => {
    const text =
      "[地址](https://example.com/中文，路径) <https://example.com/中文，路径> `https://example.com，代码`\n\nhttps://example.com/中文?q=中文 https://example.com/a(b)?q=x&x=y#片段 contact@example.com"
    const html = render(text)
    expect(hrefs(html)).toEqual([
      "https://example.com/%E4%B8%AD%E6%96%87%EF%BC%8C%E8%B7%AF%E5%BE%84",
      "https://example.com/%E4%B8%AD%E6%96%87%EF%BC%8C%E8%B7%AF%E5%BE%84",
      "https://example.com/%E4%B8%AD%E6%96%87?q=%E4%B8%AD%E6%96%87",
      "https://example.com/a(b)?q=x&amp;x=y#%E7%89%87%E6%AE%B5",
      "mailto:contact@example.com"
    ])
    expect(html).toContain("https://example.com，代码</code>")
  })

  it.each([
    "https://example.com/文件，版本",
    "https://example.com/?q=甲，乙",
    "https://example.com/#甲，乙",
    "https://example.com/?q=😀，说明",
    "https://例子.测试，后文",
    "www.例子.测试，后文",
    "https://example.com:99999（标题"
  ])(
    "preserves original GFM when a destination is non-ASCII or its authority cannot be parsed: %s",
    (text) => {
      const original = renderToStaticMarkup(
        createElement(ReactMarkdown, { children: text, remarkPlugins: [remarkGfm] })
      )
      expect(hrefs(original)).toHaveLength(1)
      expect(hrefs(render(text))).toEqual(hrefs(original))
    }
  )

  it.each([
    ["https://example.com/a?!，后文", "https://example.com/a", "?!，后文"],
    ["https://example.com/a(b)（说明", "https://example.com/a(b)", "（说明"],
    ["https://example.com/a(b))（说明", "https://example.com/a(b)", ")（说明"],
    ["https://example.com/a(b(c))**，后文", "https://example.com/a(b(c))", "**，后文"]
  ])(
    "trims generic trailing punctuation while keeping balanced URL parentheses: %s",
    (text, expected, suffix) => {
      const html = render(text)
      expect(hrefs(html)).toEqual([expected])
      expect(html).toContain(`</a>${suffix}`)
    }
  )

  it("leaves original workbench parsing unchanged", () => {
    const text = "仍在 **https://example.com/**，页面标题「Example Domain」"
    const original = renderToStaticMarkup(
      createElement(ReactMarkdown, { children: text, remarkPlugins: [remarkGfm] })
    )
    const workbench = render(text, false)
    expect(hrefs(workbench)).toEqual(hrefs(original))
    expect(workbench).not.toContain("<strong>")
  })

  it("preserves existing Unicode hosts, localhost and ordinary emphasis parsing", () => {
    const text =
      "https://例子.测试/中文 https://localhost:123/a www.例子.测试/中文\n\n**https://example.com/** 普通加粗"
    const original = renderToStaticMarkup(
      createElement(ReactMarkdown, { children: text, remarkPlugins: [remarkGfm] })
    )
    const html = render(text)
    expect(hrefs(html)).toEqual(hrefs(original))
    expect(hrefs(html)).toHaveLength(4)
    expect(html).toContain('<strong><a href="https://example.com/"')
  })
})
