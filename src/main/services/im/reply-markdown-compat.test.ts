import { readFileSync } from "node:fs"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { describe, expect, it } from "vitest"
import {
  buildImEventReplies,
  buildImProactiveReplies,
  segmentImMarkdownText,
  segmentImReplyText
} from "./reply-segmentation"
import { assertRemoteImReplyV1 } from "../../../shared/im-gateway-contract"

const original = readFileSync(
  new URL("./fixtures/zhaohu-nested-bold-reply.md", import.meta.url),
  "utf8"
)

function render(text: string): string {
  return renderToStaticMarkup(createElement(Markdown, { remarkPlugins: [remarkGfm] }, text))
}

function visibleText(html: string): string {
  // Numbers move from literal text to list markers when the bold wrapper is removed.
  return html
    .replace(/<[^>]*>/gu, "")
    .replace(/(^|\s)\d+\.[ \t]+/gu, "$1")
    .replace(/\s+/gu, " ")
    .trim()
}

describe("Zhaohu compatibility for bold paragraphs containing inline code", () => {
  it("keeps the user's complete reply, changing only the three problematic title wrappers", () => {
    const titles = [
      "1. `llm_client.py` — `chat()` 新增 `validate` 回调，三层失败统一放在同一个重试循环（共用 `LLM_MAX_RETRIES` 预算）",
      "2. `auditor.py` — `audit_text_multi` 接入校验并吞掉最终失败",
      "3. `ab_test.py` — `audit_two_step_multi` 两轮都接入"
    ]
    let expected = original.trim()
    for (const title of titles) expected = expected.replace(`**${title}**`, title)
    const [body] = segmentImMarkdownText(original)
    expect(body).toBe(expected)
    expect(visibleText(render(body))).toBe(visibleText(render(original)))
    const html = render(body)
    expect(html).toContain("<ol>")
    expect(html).toContain('<ol start="2">')
    expect(html).toContain('<ol start="3">')
    for (const name of ["llm_client.py", "auditor.py", "ab_test.py"]) {
      expect(html).toContain(`<code>${name}</code>`)
    }
    expect(html).toContain("<table>")
    expect(html.match(/<td>PASS<\/td>/gu)).toHaveLength(6)
    expect(body).toContain("③ **业务校验层（新增）**：`validate(result)`")
    expect(body).toContain("重试用尽后**不抛异常**")
  })

  it.each([
    ["**1. `file.py` — `chat()`**", "1. `file.py` — `chat()`"],
    ["__2. `file.py` — `chat()`__", "2. `file.py` — `chat()`"],
    ["**执行 ``echo `date` `` 后继续**", "执行 ``echo `date` `` 后继续"],
    ["前文\r\n\r\n **3. `file.py`**  \r\n后文", "前文\r\n\r\n 3. `file.py`  \r\n后文"]
  ])("removes just the outer emphasis: %s", (source, expected) => {
    expect(segmentImMarkdownText(source)).toEqual([expected])
    expect(segmentImMarkdownText(expected)).toEqual([expected])
    expect(visibleText(render(expected))).toBe(visibleText(render(source)))
  })

  it.each([
    "**普通加粗内容**",
    "正文里的 **加粗** 和 `inline_code`",
    "**1. `file.py`** 与 **独立加粗**",
    "**只有一个 ` 反引号**",
    "**转义的 \\`反引号\\`**",
    "    **1. `file.py`**\n    indented code",
    "```markdown\n**1. `file.py`**\n```",
    "~~~markdown\n**1. `file.py`**\n~~~",
    "````markdown\n```\n**1. `file.py`**\n````",
    "| 列 | 值 |\n| --- | --- |\n| **1. `file.py`** | PASS |",
    "[**1. `file.py`**](https://example.test/file.py)",
    "# 标题\n\n1. `file.py`\n\n> 引用"
  ])("preserves unrelated formatting and code literals: %s", (source) => {
    expect(segmentImMarkdownText(source)).toEqual([source.trim()])
  })

  it("normalizes before splitting, so removing wrappers cannot create extra/truncated segments", () => {
    const title = `**1. \`${"x".repeat(24)}\`**`
    expect(title).toHaveLength(33)
    expect(segmentImMarkdownText(title, { maxCharacters: 32 })).toEqual([title.slice(2, -2)])
    const source = Array.from(
      { length: 36 },
      (_, index) => `**${index + 1}. \`file_${index}.py\`**`
    ).join("\n\n")
    const first = segmentImMarkdownText(source, { maxCharacters: 240 })
    expect(first.length).toBeGreaterThan(1)
    expect(segmentImMarkdownText(source, { maxCharacters: 240 })).toEqual(first)
    for (const [index, segment] of first.entries()) {
      expect(Array.from(segment).length).toBeLessThanOrEqual(240)
      expect(segment.length).toBeLessThanOrEqual(3_000)
      expect(segment.startsWith(`[${index + 1}/${first.length}]\n\n`)).toBe(true)
    }
    const joined = first.join("\n")
    for (let index = 0; index < 36; index++) {
      expect(joined.split(`\`file_${index}.py\``)).toHaveLength(2)
    }
  })

  it("uses the same durable body for event and proactive replies while text notices stay verbatim", () => {
    const text = "**1. `llm_client.py` — `chat()`**"
    const prefix = "【会话：接口排障】"
    const eventReplies = buildImEventReplies({
      event: { eventId: "event", conversationKey: "conversation" },
      text,
      prefix,
      format: "markdown"
    })
    const proactiveReplies = buildImProactiveReplies({
      deliveryId: "push",
      conversationKey: "conversation",
      text,
      prefix,
      format: "markdown"
    })
    expect(eventReplies[0].message).toEqual(proactiveReplies[0].message)
    expect(eventReplies[0].message.content).toBe(`${prefix}\n\n1. \`llm_client.py\` — \`chat()\``)
    for (const reply of [...eventReplies, ...proactiveReplies]) assertRemoteImReplyV1(reply)
    expect(
      buildImEventReplies({
        event: { eventId: "event", conversationKey: "conversation" },
        text
      })[0].message.content
    ).toBe(text)
    expect(segmentImReplyText(text)).toEqual([text])
  })
})
