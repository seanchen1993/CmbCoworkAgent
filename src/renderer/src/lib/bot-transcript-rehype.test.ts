import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import type { Element, Root } from "hast"
import { describe, expect, it, vi } from "vitest"
import { StreamingMarkdown } from "../components/chat/StreamingMarkdown"
import { rehypeBotTranscript } from "./bot-transcript-rehype"

vi.mock("@/lib/thread-context", () => ({
  useThreadStateSelector: (_id: unknown, selector: (state: unknown) => unknown) =>
    selector({ workspacePath: null, workspaceFiles: [] })
}))

const table = "| 名称 | 数量 |\n| --- | --- |\n| 一 | 12.50 |\n| 二 | -2 |"
const markdown = (text: string, enabled = true) =>
  renderToStaticMarkup(createElement(StreamingMarkdown, { children: text, botTranscript: enabled }))
const cell = (value: string) => `<td data-bot-numeric="true">${value}</td>`

describe("Bot transcript presentation within the existing Markdown parse", () => {
  it("keeps one source/search wrapper and groups prose/table/prose without changing content", () => {
    const text = `中文 English\n\n- first\n- second\n\n${table}\n\nAfter\n\n\`\`\`python\nprint(1)\n\`\`\``
    const html = markdown(text)
    expect(html.match(/data-chat-search-text/g)).toHaveLength(1)
    expect(html).toContain(`data-chat-search-source-end="${text.length}"`)
    expect(html.match(/data-bot-prose="true"/g)).toHaveLength(2)
    expect(html.match(/streaming-markdown-table-wrap/g)).toHaveLength(1)
    expect(html).toContain("中文 English")
    expect(html).toContain("<ul>")
    expect(html).toContain("streaming-markdown-code-copy")
    expect(html).toContain(cell("12.50"))
    expect(html).toContain(cell("-2"))
    const normal = markdown(text, false)
    expect(normal).not.toContain("data-bot-prose")
    expect(normal).not.toContain("data-bot-numeric")
    expect(normal).toContain("<td>12.50</td>")
  })

  it("does not create empty prose around tables or split code and nested tables", () => {
    const only = markdown(`${table}\n\n${table}`)
    expect(only).not.toContain("data-bot-prose")
    expect(only.match(/streaming-markdown-table-wrap/g)).toHaveLength(2)
    const nested = markdown(`> ${table.replaceAll("\n", "\n> ")}\n\n\`\`\`text\n${table}\n\`\`\``)
    expect(nested.match(/data-bot-prose="true"/g)).toHaveLength(1)
    expect(nested).not.toContain("data-bot-numeric")
    expect(nested).toContain("<blockquote>")
  })

  it.each([
    ["0", true],
    ["**12.5**", true],
    ["$1,234.50", true],
    ["(12.50)", true],
    ["−2", true],
    ["~3%", true],
    ["2.5 bps", true],
    ["3K†", true],
    ["(2)%", true],
    ["(+2)", false],
    ["(2", false],
    ["2)%", false],
    ["2% K", false],
    ["12 apples", false],
    ["`12`", false],
    ["[12](https://example.com)", false]
  ])("uses official numeric boundaries for %s without modifying its source", (value, numeric) => {
    const html = markdown(`| ID | Value |\n| --- | :--- |\n| 123 | ${value} |\n| 456 | — |`)
    expect(html.includes('data-bot-numeric="true"')).toBe(numeric)
    expect(html).toContain("<td>123</td>")
    expect(html).toContain("<td>456</td>")
    if (!numeric) expect(html).toContain('style="text-align:left"')
  })

  it("keeps textual and entirely missing columns unchanged", () => {
    const mixed = markdown(
      "| ID | Mixed | Missing |\n| --- | :---: | ---: |\n| 1 | 12 | N/A |\n| 2 | text | — |"
    )
    expect(mixed).not.toContain("data-bot-numeric")
    expect(mixed).toContain('style="text-align:center"')
    expect(mixed).toContain('style="text-align:right"')
  })

  it("reuses original HAST child references and source positions", () => {
    const paragraph: Element = {
      type: "element",
      tagName: "p",
      properties: {},
      children: [{ type: "text", value: "Hello" }],
      position: { start: { line: 1, column: 1, offset: 0 }, end: { line: 1, column: 6, offset: 5 } }
    }
    const tree: Root = { type: "root", children: [paragraph] }
    rehypeBotTranscript()(tree)
    expect((tree.children[0] as Element).children[0]).toBe(paragraph)
    expect(paragraph.position?.start.offset).toBe(0)
  })

  it("keeps the existing React prose/table keys stable when streaming appends another run", () => {
    const render = (text: string) =>
      ReactMarkdown({
        children: text,
        remarkPlugins: [remarkGfm],
        rehypePlugins: [rehypeBotTranscript]
      }) as ReactElement<{ children: ReactNode }>
    const elements = (text: string) =>
      Children.toArray(render(text).props.children).filter(isValidElement)
    const initial = elements("Before")
    const withTable = elements(`Before\n\n${table}`)
    const withTail = elements(`Before\n\n${table}\n\nAfter`)
    expect(initial[0].key).toBe(withTable[0].key)
    expect(initial[0].type).toBe(withTable[0].type)
    expect(withTable.map((node) => node.key)).toEqual(withTail.slice(0, 2).map((node) => node.key))
    expect(withTail).toHaveLength(3)
  })
})
