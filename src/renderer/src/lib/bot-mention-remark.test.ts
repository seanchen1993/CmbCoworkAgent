import { expect, it } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import ReactMarkdown from "react-markdown"
import { remarkBotMentions } from "./bot-mention-remark"

it("renders only bound mentions while preserving Markdown and excluding code and links", () => {
  const text = "@甲 **核对** @甲 `@甲` [@甲](https://example.com)"
  const offsets = [...text.matchAll(/@甲/g)].map((m) => m.index!)
  const mentions = offsets
    .filter((_, i) => i !== 1)
    .map((start) => ({ start, end: start + 2, botId: "a", label: "甲" }))
  const observed: unknown[] = []
  const html = renderToStaticMarkup(
    createElement(ReactMarkdown, {
      children: text,
      remarkPlugins: [[remarkBotMentions, { mentions, start: 0 }]],
      components: {
        span: ({ node, children }) => {
          observed.push(node?.properties)
          return createElement("span", null, children)
        }
      }
    })
  )
  expect(observed).toEqual([{ "data-bot-mention": "0" }])
  expect(html).toContain("<strong>核对</strong>")
  expect(html).toContain("<code>@甲</code>")
  expect(html).toContain('<a href="https://example.com">@甲</a>')
})

it("uses original offsets in a bounded long-message fragment and does not guess malformed ranges", () => {
  const html = renderToStaticMarkup(
    createElement(ReactMarkdown, {
      children: "@甲 后文",
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
    })
  )
  expect(html).toContain('<span data-bot-mention="0">@甲</span> 后文')
})
