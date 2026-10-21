import { describe, expect, it } from "vitest"
import { unified, type Plugin } from "unified"
import remarkParse from "remark-parse"
import remarkGfm from "remark-gfm"
import type { Root } from "mdast"
import { createRemarkParseCache, MarkdownParseCache } from "./markdown-parse-cache"

const example =
  "# A heading\n\n~~old~~ [safe](https://example.test)\n\n" +
  "| Name | Value |\n| --- | --- |\n| A | B |\n\n- [x] Done\n"

function fixture(cache = new MarkdownParseCache()) {
  let parses = 0
  const countParser: Plugin = function () {
    const parse = this.parser!
    this.parser = (source, file) => {
      parses++
      return parse(source, file)
    }
  }
  return {
    cache,
    parses: () => parses,
    processor: () =>
      unified().use(remarkParse).use(remarkGfm).use(countParser).use(createRemarkParseCache(cache))
  }
}

describe("completed Markdown parse cache", () => {
  it("runs the real GFM parser once across independent processors and returns separate trees", () => {
    const f = fixture()
    const first = f.processor().parse(example)
    const second = f.processor().parse(example)
    expect(f.parses()).toBe(1)
    expect(second).toEqual(first)
    expect(second).not.toBe(first)
    expect(second.children.map((node) => node.type)).toContain("table")
    expect(JSON.stringify(second)).toContain('"checked":true')
    expect(JSON.stringify(second)).toContain('"type":"delete"')
  })

  it("does not retain a caller's mutations or skip downstream transforms on a hit", () => {
    const f = fixture()
    const first = f.processor().parse(example)
    first.children.length = 0
    first.position!.start.offset = 999
    let transforms = 0
    const transform: Plugin<[], Root> = () => (tree) => {
      transforms++
      tree.children.push({ type: "paragraph", children: [{ type: "text", value: "once" }] })
    }
    for (let index = 0; index < 2; index++) {
      const processor = f.processor().use(transform)
      const result = processor.runSync(processor.parse(example))
      expect(result.children.filter((node) => node.type === "paragraph")).toHaveLength(2)
      expect(result.position!.start.offset).toBe(0)
    }
    expect(f.parses()).toBe(1)
    expect(transforms).toBe(2)
  })

  it("keys exact source text and isolates a different grammar cache", () => {
    const f = fixture()
    f.processor().parse(example)
    f.processor().parse(example + " ")
    f.processor().parse(example.replace("heading", "Heading"))
    expect(f.parses()).toBe(3)
    const plain = unified().use(remarkParse).use(createRemarkParseCache(new MarkdownParseCache()))
    expect(plain.parse(example).children.map((node) => node.type)).not.toContain("table")
    expect(f.parses()).toBe(3)
  })

  it("evicts least recently used source when the entry budget is reached", () => {
    const f = fixture(new MarkdownParseCache({ maxEntries: 2 }))
    for (const source of ["A", "B", "A", "C", "A", "B"]) f.processor().parse(source)
    expect(f.parses()).toBe(4)
    expect(f.cache.stats()).toMatchObject({ entries: 2, hits: 2, evictions: 2 })
  })

  it("bounds retained source plus AST bytes independently of the entry budget", () => {
    const first = fixture()
    first.processor().parse("A")
    const entryBytes = first.cache.stats().bytes
    const f = fixture(new MarkdownParseCache({ maxBytes: entryBytes * 1.5 }))
    for (const source of ["A", "B", "A"]) f.processor().parse(source)
    expect(f.parses()).toBe(3)
    expect(f.cache.stats()).toMatchObject({ entries: 1, evictions: 2 })
    expect(f.cache.stats().bytes).toBeLessThanOrEqual(entryBytes * 1.5)
  })

  it("does not retain oversized sources or oversized parsed entries", () => {
    for (const limits of [{ maxSourceCharacters: 2 }, { maxEntryBytes: 2 }, { maxEntries: 0 }]) {
      const f = fixture(new MarkdownParseCache(limits))
      f.processor().parse(example)
      f.processor().parse(example)
      expect(f.parses()).toBe(2)
      expect(f.cache.stats()).toMatchObject({ entries: 0, bytes: 0 })
    }
  })

  it("propagates parse failures and never caches an error as a valid document", () => {
    const cache = new MarkdownParseCache()
    for (let index = 0; index < 2; index++) {
      expect(() =>
        cache.parse("broken", () => {
          throw Error("parser failed")
        })
      ).toThrow("parser failed")
    }
    expect(cache.stats()).toMatchObject({ entries: 0, parses: 2 })
  })
})
