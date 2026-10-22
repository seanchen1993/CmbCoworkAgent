import { cloneElement, createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { beforeEach, describe, expect, it, vi } from "vitest"
import remarkGfm from "remark-gfm"
import { StaticMarkdownFormatting, StreamingMarkdown } from "../components/chat/StreamingMarkdown"
import { completedMarkdownParseCache } from "./markdown-parse-cache"
import { stableMarkdownPrefixCache, streamingMarkdownParseMetrics } from "./markdown-parse-cache"
import { FunctionMarkdown } from "../components/chat/FunctionMarkdown"

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

  it("shares only fixed GFM parsing with Function Markdown and still applies its native safety transforms", () => {
    const text =
      "**Report** [unsafe](javascript:alert(1)) [safe](https://example.test)\n\n" +
      "<context>literal</context>\n\n![inert](https://example.test/image.png)"
    renderToStaticMarkup(createElement(StreamingMarkdown, null, text))
    const html = renderToStaticMarkup(
      createElement(FunctionMarkdown, { props: { text }, nodePath: [] })
    )
    expect(completedMarkdownParseCache.stats()).toMatchObject({ parses: 1, hits: 1 })
    expect(html).toContain("<strong>Report</strong>")
    expect(html).toContain("&lt;context&gt;literal&lt;/context&gt;")
    expect(html).not.toContain("<img")
    expect(html).not.toContain("href=")
  })

  it("does not turn a cached ordinary tree into a bypass of Function Markdown structural limits", () => {
    const text = "> ".repeat(140) + "deep"
    renderToStaticMarkup(createElement(StreamingMarkdown, null, text))
    expect(() =>
      renderToStaticMarkup(createElement(FunctionMarkdown, { props: { text }, nodePath: [] }))
    ).toThrow("MODS_UI_MARKDOWN_LIMIT")
    expect(completedMarkdownParseCache.stats()).toMatchObject({ parses: 1, hits: 1 })
  })

  it("parses a proved code prefix once while measuring cumulative live-suffix work, then corrects completion", () => {
    stableMarkdownPrefixCache.clear()
    streamingMarkdownParseMetrics.clear()
    const prefix = "```ts\n" + "const value = 1;\n".repeat(300) + "```\n\n"
    let baselineCharacters = 0
    for (let index = 1; index <= 12; index++) {
      const text = prefix + "[reference][ref]\n\n" + "tail ".repeat(index * 10)
      baselineCharacters += text.length
      const html = renderToStaticMarkup(
        cloneElement(createElement(StreamingMarkdown, null, text), { isStreaming: true })
      )
      expect(html).toContain("reference")
      expect(html).not.toContain("hljs-keyword")
    }
    const stable = stableMarkdownPrefixCache.stats(),
      live = streamingMarkdownParseMetrics.stats()
    expect(stable).toMatchObject({ parses: 1, hits: 11 })
    expect(stable.parsedCharacters + live.parsedCharacters).toBeLessThan(baselineCharacters / 2)
    const complete = prefix + "[reference][ref]\n\n[ref]: https://example.test/report"
    const html = renderToStaticMarkup(createElement(StreamingMarkdown, null, complete))
    expect(html).toContain('href="https://example.test/report"')
    expect(html).toContain("hljs-keyword")
  })
})
