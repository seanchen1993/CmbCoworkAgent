import { describe, expect, it } from "vitest"
import { unified } from "unified"
import remarkParse from "remark-parse"
import remarkGfm from "remark-gfm"
import { stableMarkdownPrefixLength } from "./stable-markdown-prefix"

const body = "const value = '<reference> [ref] | ~~literal~~';\n".repeat(70)
const fence = "```ts\n" + body + "```\n\n"
const parser = unified().use(remarkParse).use(remarkGfm)
const nodes = (text: string) =>
  JSON.parse(
    JSON.stringify(parser.parse(text).children, (key, value) =>
      key === "position" ? undefined : value
    )
  )

describe("provably append-independent Markdown prefix", () => {
  it("keeps every prefix of a provisional closing fence on the full parser", () => {
    for (const text of ["```ts\n" + body, "```ts\n" + body + "```", "```ts\n" + body + "```\n"])
      expect(stableMarkdownPrefixLength(text)).toBe(0)
    expect(stableMarkdownPrefixLength(fence)).toBe(fence.length)
  })

  it("is semantically identical for future references, containers, tables, math, HTML and fences", () => {
    for (const tail of [
      "[name][ref]\n\n[ref]: https://example.test/report\n",
      "> quoted\n> - nested\n\n1. ordered\n2. list\n",
      "| A | B |\n| --- | --- |\n| 1 | 2 |\n",
      "$$\na+b\n$$\n\n<div>literal</div>\n",
      "~~~python\n[ref]: not a definition\n~~~\n",
      "```js\nunfinished fence",
      "paragraph\n---\n",
      "    indented code\n"
    ]) {
      const text = fence + tail
      const prefix = stableMarkdownPrefixLength(text)
      expect(prefix).toBe(fence.length)
      expect([...nodes(text.slice(0, prefix)), ...nodes(text.slice(prefix))]).toEqual(nodes(text))
    }
  })

  it("does not guess a stable cut for arbitrary blocks or invalid/unfinished fences", () => {
    for (const text of [
      "paragraph\n\n" + fence,
      "[ref]\n\n" + fence,
      "> " + fence,
      "- " + fence,
      "| A | B |\n| --- | --- |\n" + fence,
      "<div>\n" + fence,
      "````ts\n" + body + "```\n\n",
      "```ts`bad\n" + body + "```\n\n",
      "```ts\n" + body + "~~~\n\n",
      "```ts\n" + body + "    ```\n\n",
      "```ts\n" + body + "``` not closed\n\n",
      "```ts\nshort\n```\n\n"
    ])
      expect(stableMarkdownPrefixLength(text)).toBe(0)
  })

  it("handles CRLF, valid fence indentation and longer closing tildes", () => {
    const text = "  ~~~text\r\n" + body.replaceAll("\n", "\r\n") + " ~~~~\r\n \t\r\n"
    const prefix = stableMarkdownPrefixLength(text + "[later][ref]\n\n[ref]: https://example.test")
    expect(prefix).toBe(text.length)
    expect(nodes(text)).toHaveLength(1)
  })
})
