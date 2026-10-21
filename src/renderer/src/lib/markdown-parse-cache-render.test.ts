import { cloneElement, createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { beforeEach, describe, expect, it, vi } from "vitest"
import remarkGfm from "remark-gfm"
import { StaticMarkdownFormatting, StreamingMarkdown } from "../components/chat/StreamingMarkdown"
import { completedMarkdownParseCache } from "./markdown-parse-cache"

vi.mock("@/lib/thread-context", () => ({
  useThreadStateSelector: (_threadId: string | null, select: (state: unknown) => unknown) =>
    select({ workspacePath: null, workspaceFiles: [] })
}))

describe("completed Markdown caching in the actual renderer", () => {
  beforeEach(() => completedMarkdownParseCache.clear())

  it("reuses only parsing across remounts while GFM, highlighting and URL cleanup still execute", () => {
    const text =
      "| A | B |\n| --- | --- |\n| 1 | 2 |\n\n" +
      "[unsafe](javascript:alert(1)) [safe](https://example.test)\n\n```ts\nconst value = 1\n```"
    const first = renderToStaticMarkup(createElement(StreamingMarkdown, null, text))
    const second = renderToStaticMarkup(createElement(StreamingMarkdown, null, text))
    expect(completedMarkdownParseCache.stats()).toMatchObject({ parses: 1, hits: 1 })
    expect(second).toBe(first)
    expect(second).toContain("<table")
    expect(second).toContain("hljs-keyword")
    expect(second).toContain('href="https://example.test"')
    expect(second).not.toContain('href="javascript:')
    expect(second).toContain("复制代码")
  })

  it("keeps streaming prefixes out of the history cache and admits the final text", () => {
    for (const text of ["prefix", "prefix again", "prefix again"]) {
      renderToStaticMarkup(
        cloneElement(createElement(StreamingMarkdown, null, text), { isStreaming: true })
      )
    }
    expect(completedMarkdownParseCache.stats()).toMatchObject({ entries: 0, parses: 0, hits: 0 })
    renderToStaticMarkup(createElement(StreamingMarkdown, null, "prefix again"))
    renderToStaticMarkup(createElement(StreamingMarkdown, null, "prefix again"))
    expect(completedMarkdownParseCache.stats()).toMatchObject({ entries: 1, parses: 1, hits: 1 })
  })

  it("does not apply the fixed grammar cache to caller-provided formatting pipelines", () => {
    const text = "~~text~~"
    renderToStaticMarkup(
      createElement(StaticMarkdownFormatting, { text, remarkPlugins: [remarkGfm] })
    )
    renderToStaticMarkup(createElement(StaticMarkdownFormatting, { text }))
    expect(completedMarkdownParseCache.stats()).toMatchObject({ entries: 0, parses: 0 })
  })
})
