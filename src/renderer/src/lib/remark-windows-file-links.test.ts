import { describe, expect, it } from "vitest"
import { unified } from "unified"
import remarkParse from "remark-parse"
import remarkWindowsFileLinks from "./remark-windows-file-links"

interface LinkNode {
  type?: string
  url?: string
  children?: LinkNode[]
}

function firstLinkUrl(markdown: string): string | undefined {
  const processor = unified().use(remarkParse).use(remarkWindowsFileLinks)
  const tree = processor.runSync(processor.parse(markdown), { value: markdown }) as LinkNode
  return tree.children?.[0]?.children?.[0]?.url
}

describe("remarkWindowsFileLinks", () => {
  it("preserves a dot-prefixed Windows directory", () => {
    expect(firstLinkUrl("[查看](C:\\workspace\\xxx\\.prd\\prd-manifest.json)")).toBe(
      "C:/workspace/xxx/.prd/prd-manifest.json"
    )
  })

  it("preserves ordinary Windows drive and UNC paths", () => {
    expect(firstLinkUrl("[查看](D:\\workspace\\src\\index.ts)")).toBe(
      "D:/workspace/src/index.ts"
    )
    expect(firstLinkUrl("[查看](\\\\server\\share\\.prd\\manifest.json)")).toBe(
      "//server/share/.prd/manifest.json"
    )
  })

  it("does not rewrite web links", () => {
    expect(firstLinkUrl("[查看](https://example.com/a\\.prd/file.json)")).toBe(
      "https://example.com/a.prd/file.json"
    )
  })
})
