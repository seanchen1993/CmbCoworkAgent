import type { Element, Root } from "hast"
import { common, type LanguageFn } from "lowlight"
import rehypeHighlight from "rehype-highlight"
import { VFile } from "vfile"
import { describe, expect, it, vi } from "vitest"
import {
  collectMarkdownHighlightGrammars,
  createMarkdownHighlighter
} from "./markdown-highlight"

function codeTree(blocks: ReadonlyArray<readonly [string, string]>): Root {
  return {
    type: "root",
    children: blocks.map(
      ([language, code]): Element => ({
        type: "element",
        tagName: "pre",
        properties: {},
        children: [
          {
            type: "element",
            tagName: "code",
            properties: language ? { className: [`language-${language}`] } : {},
            children: [{ type: "text", value: code }]
          }
        ]
      })
    )
  }
}

describe("Markdown syntax highlighting", () => {
  it("matches default markup for the common grammars, aliases, and embedded languages", () => {
    const grammars = collectMarkdownHighlightGrammars()
    const blocks: Array<[string, string]> = Object.entries(grammars).flatMap(
      ([name, grammar]) =>
        [name, ...(grammar.aliases ?? [])].map((label): [string, string] => [
          label,
          'const value = 1; # "example"\n'
        ])
    )
    blocks.unshift(
      [
        "js",
        "const view = <strong>text</strong>;\nconst style = css`p { color: red }`;\nconst user = gql`query { user { name } }`;\n"
      ],
      [
        "html",
        "<script>const value = 1;</script><style>p { color: red }</style>\n"
      ],
      ["php-template", '<p><?php echo "text"; ?></p>\n'],
      ["console", '$ echo "text"\ntext\n'],
      ["unknown-language", 'const value = "<text>";\n'],
      ["", 'const value = "<text>";\n']
    )

    const before = codeTree(blocks)
    const after = codeTree(blocks)
    const beforeFile = new VFile()
    const afterFile = new VFile()
    rehypeHighlight()(before, beforeFile)
    createMarkdownHighlighter(grammars)(after, afterFile)

    expect(after).toEqual(before)
    expect(afterFile.messages.map((message) => message.reason)).toEqual(
      beforeFile.messages.map((message) => message.reason)
    )
  })

  it("constructs only used grammars and preserves grammar inspection and raw definitions", () => {
    const grammars = collectMarkdownHighlightGrammars()
    const defineJavaScript = common.javascript
    let engine: Parameters<LanguageFn>[0] | undefined
    const javascript = vi
      .spyOn(common, "javascript")
      .mockImplementation((highlighter) => {
        engine = highlighter
        return defineJavaScript(highlighter)
      })
    const python = vi.spyOn(common, "python")
    try {
      const highlight = createMarkdownHighlighter(grammars)
      expect(javascript).not.toHaveBeenCalled()
      expect(python).not.toHaveBeenCalled()
      highlight(codeTree([["js", "const answer = 42;\n"]]), new VFile())
      expect(javascript).toHaveBeenCalledTimes(1)
      expect(python).not.toHaveBeenCalled()

      for (const name of Object.keys(common)) {
        const language = engine?.getLanguage(name)
        const raw = language?.rawDefinition?.()
        expect(language?.name).toBe(grammars[name].name || name)
        expect(raw).toBeDefined()
        const keys = Object.keys(raw ?? {})
        expect(Object.keys(language ?? {})).toEqual(
          expect.arrayContaining(keys)
        )
        expect(keys.every((key) => language && key in language)).toBe(true)
      }
    } finally {
      javascript.mockRestore()
      python.mockRestore()
    }
  })
})
