import { expect, it } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import ReactMarkdown from "react-markdown"
import { remarkBotMentions } from "./bot-mention-remark"

it("keeps a bound mention before Markdown normalizes whitespace later in the paragraph", () => {
  const html = renderToStaticMarkup(
    createElement(
      ReactMarkdown,
      {
        remarkPlugins: [
          [
            remarkBotMentions,
            { mentions: [{ start: 0, end: 2, botId: "a", label: "甲" }], start: 0 }
          ]
        ]
      },
      "@甲 校对\n 下一行"
    )
  )
  expect(html).toContain('<span data-bot-mention="0">@甲</span> 校对')
  expect(html).toContain("下一行")
})

it("does not bind an identical name after an entity changes its source offsets", () => {
  const text = "@甲 &amp; @甲"
  const start = text.lastIndexOf("@甲")
  const html = renderToStaticMarkup(
    createElement(
      ReactMarkdown,
      {
        remarkPlugins: [
          [
            remarkBotMentions,
            {
              mentions: [
                { start: 0, end: 2, botId: "a", label: "甲" },
                { start, end: start + 2, botId: "b", label: "甲" }
              ],
              start: 0
            }
          ]
        ]
      },
      text
    )
  )
  expect(html).toContain('<span data-bot-mention="0">@甲</span>')
  expect(html).not.toContain('data-bot-mention="1"')
})

it("renders only bound mentions while preserving Markdown and excluding code and links", () => {
  const text = "@甲 **核对** @甲 `@甲` [@甲](https://example.com)"
  const offsets = [...text.matchAll(/@甲/g)].map((m) => m.index!)
  const mentions = offsets
    .filter((_, i) => i !== 1)
    .map((start) => ({ start, end: start + 2, botId: "a", label: "甲" }))
  const observed: unknown[] = []
  const html = renderToStaticMarkup(
    createElement(
      ReactMarkdown,
      {
        remarkPlugins: [[remarkBotMentions, { mentions, start: 0 }]],
        components: {
          span: ({ node, children }) => {
            observed.push(node?.properties)
            return createElement("span", null, children)
          }
        }
      },
      text
    )
  )
  expect(observed).toEqual([{ "data-bot-mention": "0" }])
  expect(html).toContain("<strong>核对</strong>")
  expect(html).toContain("<code>@甲</code>")
  expect(html).toContain('<a href="https://example.com">@甲</a>')
})

it("uses original offsets in a bounded long-message fragment and does not guess malformed ranges", () => {
  const html = renderToStaticMarkup(
    createElement(
      ReactMarkdown,
      {
        remarkPlugins: [
          [
            remarkBotMentions,
            {
              start: 100,
              mentions: [
                { start: 100, end: 102, botId: "a", label: "甲" },
                { start: 103, end: 105, botId: "b", label: "后文" }
              ]
            }
          ]
        ]
      },
      "@甲 后文"
    )
  )
  expect(html).toContain('<span data-bot-mention="0">@甲</span> 后文')
})
