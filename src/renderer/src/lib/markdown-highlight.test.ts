import { expect, it } from "vitest"
import { unified } from "unified"
import remarkParse from "remark-parse"
import remarkGfm from "remark-gfm"
import remarkRehype from "remark-rehype"
import rehypeHighlight from "rehype-highlight"
import { VFile } from "vfile"
import { rehypeChatHighlight } from "./markdown-highlight"

function render(plugin: typeof rehypeHighlight, text: string) {
  const file = new VFile(text)
  const processor = unified().use(remarkParse).use(remarkGfm).use(remarkRehype).use(plugin)
  return {
    tree: processor.runSync(processor.parse(file), file),
    messages: file.messages.map(message => String(message))
  }
}

it("preserves default highlighting and file diagnostics across independent recycled documents", () => {
  const samples = [
    "```typescript\nconst total: number = 42\nfunction value(x: string) { return x.trim() }\n```",
    "```js\nconst x = `<h1>ok</h1>`; console.log(x)\n```",
    "```python\ndef value(x):\n    return [y for y in x if y > 0]\n```",
    "```json\n{\"answer\":42,\"ok\":true}\n```",
    "```unknown-language\nA < B & C\n```",
    "```\nNo language is not automatically detected\n```",
    "## Report\n\nA **paragraph** with `inline`.\n\n| A | B |\n| - | - |\n| 1 | 2 |"
  ]
  for (let repeat = 0; repeat < 5; repeat++)
    for (const text of samples)
      expect(render(rehypeChatHighlight, text)).toEqual(render(rehypeHighlight, text))
  expect(rehypeChatHighlight()).toBe(rehypeChatHighlight())
})
