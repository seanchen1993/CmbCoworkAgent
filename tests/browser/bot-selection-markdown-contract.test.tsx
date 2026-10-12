import { renderToStaticMarkup } from "react-dom/server"
import { parseFragment, type DefaultTreeAdapterMap } from "parse5"
import { afterEach, describe, expect, it, vi } from "vitest"
import { StreamingMarkdown } from "../../src/renderer/src/components/chat/StreamingMarkdown"
import { BotStore } from "../../src/main/bots/store"
import {
  botQuoteSourceProjection,
  quoteText,
  type BotSelectionQuote,
  type BotSelectionQuoteSpan
} from "../../src/shared/bot-selection-quotes"

// Only the unrelated thread/file-preview state is substituted. The production
// Markdown parser, React rendering, highlighting and code-block wrappers run.
vi.mock("@/lib/thread-context", () => ({
  useThreadStateSelector: () => null
}))

type HtmlNode = DefaultTreeAdapterMap["node"]
type HtmlElement = DefaultTreeAdapterMap["element"]
const children = (node: HtmlNode): HtmlNode[] => ("childNodes" in node ? node.childNodes : [])
const attribute = (node: HtmlNode, name: string): boolean =>
  "attrs" in node && node.attrs.some((item) => item.name === name)
function visibleText(node: HtmlNode): string {
  if (attribute(node, "data-chat-search-ignore")) return ""
  if (node.nodeName === "#text" && "value" in node) return node.value
  return children(node).map(visibleText).join("")
}

/** Mirrors capture's DOM textContent policy, without importing the HAST reader
 * under test or using a source-text search to infer selected character offsets. */
function renderedSelection(markdown: string, excerpt: string, isStreaming: boolean) {
  const html = renderToStaticMarkup(
    <StreamingMarkdown isStreaming={isStreaming}>{markdown}</StreamingMarkdown>
  )
  const tree = parseFragment(html)
  const fragments: HtmlElement[] = []
  function findFragments(node: HtmlNode): void {
    if (attribute(node, "data-chat-search-text") && "tagName" in node) fragments.push(node)
    else children(node).forEach(findFragments)
  }
  findFragments(tree)
  expect(fragments).toHaveLength(1)
  const fragment = fragments[0]
  let offset = 0
  const selections: Array<{ from: number; to: number }> = []
  function visit(node: HtmlNode): void {
    if (attribute(node, "data-chat-search-ignore")) return
    if ("tagName" in node && node.tagName === "strong" && visibleText(node) === excerpt)
      selections.push({ from: offset, to: offset + excerpt.length })
    if (node.nodeName === "#text" && "value" in node) offset += node.value.length
    else children(node).forEach(visit)
  }
  visit(fragment)
  expect(selections).toHaveLength(1)
  const display = visibleText(fragment)
  const selection = selections[0]
  expect(display.slice(selection.from, selection.to)).toBe(excerpt)
  return { html, display, selection }
}

const excerpt = "合计金额：1245.81 元"
const cases = [
  {
    name: "GFM table with bold cells, list and nonbreaking cell whitespace",
    markdown: [
      "### 报销明细 🙂",
      "",
      "| 项目 | 金额（元） |",
      "| :--- | ---: |",
      "| **云资源** | 1000.00 |",
      "| 工具许可 | 245.81 |",
      "| &nbsp; |  |",
      "",
      `**${excerpt}**`,
      "",
      "- 已核对金额",
      "- 费用包含税款"
    ].join("\n")
  },
  {
    name: "nested and loose lists preserve their inter-element text",
    markdown: [
      "- **研发费用 🙂**",
      "  - 云资源：1000.00 元",
      "  - 工具许可：245.81 元",
      "",
      "- 已核对",
      "",
      "  无差异。",
      "",
      `**${excerpt}**`
    ].join("\n")
  },
  {
    name: "highlighted fenced code retains the displayed synthetic final newline",
    markdown: [
      "```ts",
      'const label = "费用 🙂"',
      "const total = 1245.81",
      "```",
      "",
      `**${excerpt}**`
    ].join("\n")
  },
  {
    name: "indented code retains the displayed synthetic final newline",
    markdown: ["    费用 🙂 = 1245.81", "    已核对 = true", "", `**${excerpt}**`].join("\n")
  }
]
const stores: BotStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})

describe("selected Bot Markdown matches its production DOM and Host provenance", () => {
  it.each(cases)("$name", ({ markdown }) => {
    const complete = renderedSelection(markdown, excerpt, false)
    const streaming = renderedSelection(markdown, excerpt, true)
    expect(botQuoteSourceProjection(markdown, true)).toBe(complete.display)
    expect(streaming.display).toBe(complete.display)
    expect(streaming.selection).toEqual(complete.selection)
    if (markdown.includes("| 项目")) {
      expect(complete.html).toContain("<table>")
      expect(complete.display).toContain("\u00a0")
    }
    if (markdown.includes("const total")) {
      expect(complete.html).toContain("hljs")
      expect(complete.display).toContain("const total = 1245.81\n\n")
      expect(complete.display).not.toContain("复制代码")
    }
    if (markdown.startsWith("    ")) expect(complete.display).toContain("已核对 = true\n\n")

    const store = new BotStore(":memory:")
    stores.push(store)
    const bot = store.createBot({ nonce: "markdown-bot", name: "Report" })
    store.send({ nonce: "report", conversationId: bot.conversationId, text: "Prepare a report" })
    const claimed = store.claim("report-host", 300_000)!
    // A nonzero immutable source range is exercised for every shape. Identical
    // excerpts outside that range cannot be substituted for the selected one.
    const prefix = `前段不在当前显示片段内：${excerpt}\n\n`
    const suffix = `\n\n后段不在当前显示片段内：${excerpt}`
    store.finish(claimed.lease, "succeeded", prefix + markdown + suffix)
    const source = store.messages(bot.conversationId).find((message) => message.sender === "bot")!
    const quote: BotSelectionQuote = {
      sourceMessageId: source.id,
      sourceConversationId: source.conversationId,
      sourceSequence: source.sequence,
      sourceDataEpoch: store.dataEpoch(),
      sourceFragment: { from: prefix.length, to: prefix.length + markdown.length },
      selection: complete.selection,
      text: excerpt,
      truncated: false
    }
    const input = (selection: BotSelectionQuote, nonce: string) => {
      const quoted = quoteText(selection)
      const selectionQuotes: BotSelectionQuoteSpan[] = [
        { from: 0, to: quoted.length, quote: selection }
      ]
      return {
        nonce,
        conversationId: bot.conversationId,
        text: `${quoted}\n复核这段金额。`,
        selectionQuotes
      }
    }
    const receipt = store.send(input(quote, "quoted-report"))
    expect(
      store.message({ conversationId: bot.conversationId, id: receipt.messageId })
        .selectionQuotes?.[0].quote
    ).toEqual(quote)

    const before = store.messages(bot.conversationId).length
    const invalid = [
      {
        ...quote,
        selection: { from: quote.selection.from + 1, to: quote.selection.to + 1 }
      },
      { ...quote, sourceFragment: { from: prefix.length, to: prefix.length + 1 } },
      { ...quote, text: excerpt.replace("1245.81", "1245.82") }
    ]
    invalid.forEach((changed, index) => {
      const nonce = `invalid-quote-${index}`
      expect(() => store.send(input(changed, nonce))).toThrow(
        expect.objectContaining({ code: "selection_quote_unavailable" })
      )
      expect(store.hasSendReceipt(nonce)).toBe(false)
      expect(store.messages(bot.conversationId)).toHaveLength(before)
    })
  })
})
