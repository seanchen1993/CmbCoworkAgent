import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { DesignSystemLibrary, designSystemFileDraft } from "./system-library"

const roots: string[] = []
const fixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "design-system-library-"))
  roots.push(root)
  return new DesignSystemLibrary(root)
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe("personal design system library", () => {
  it("persists independent copies and keeps old session references immutable after updates", () => {
    const library = fixture()
    const first = library.save(designSystemFileDraft("design.md", "# 团队规范\n\n主色：红色"))
    const second = library.save({
      name: "团队规范更新",
      content: "# 团队规范\n\n主色：蓝色",
      baseId: first.id
    })
    const restored = new DesignSystemLibrary(library.storageDir)
    expect(second.id).not.toBe(first.id)
    expect(second.libraryId).toBe(first.libraryId)
    expect(second.version).toBe(2)
    expect(restored.read(first.id).content).toContain("红色")
    expect(restored.read(second.id).content).toContain("蓝色")
    expect(
      restored
        .list()
        .filter((item) => item.isLatest)
        .map((item) => item.id)
    ).toEqual([second.id])
    expect(() => restored.save({ name: "陈旧修改", content: "旧稿", baseId: first.id })).toThrow(
      "已有新版本"
    )
  })

  it("does not overwrite same-name uploads and never permits writing builtin references", () => {
    const library = fixture()
    const draft = designSystemFileDraft("DESIGN.md", "# 同名规范\n内容")
    const a = library.save(draft),
      b = library.save(draft)
    expect(a.libraryId).not.toBe(b.libraryId)
    expect(library.list().filter((item) => item.isLatest)).toHaveLength(2)
    expect(() => library.save({ ...draft, baseId: "neutral-modern" })).toThrow()
    expect(() => library.read("../../secrets")).toThrow()
  })

  it("validates text and source metadata without requiring structured frontmatter", () => {
    const library = fixture()
    expect(() => designSystemFileDraft("bad.txt", "内容")).toThrow(".md")
    for (const content of [" ", "abc\0def", "a".repeat(1024 * 1024 + 1)])
      expect(() => library.save({ name: "规范", content })).toThrow()
    expect(() => library.save({ name: " ", content: "内容" })).toThrow()
    const result = library.save({
      name: "网页规范",
      content: "自由格式 Markdown",
      source: "web",
      sourceUrl: "https://example.com/page?token=secret#private"
    })
    expect(result.sourceUrl).toBe("https://example.com/page")
    expect(() =>
      library.save({ name: "规范", content: "内容", sourceUrl: "file:///etc/passwd" })
    ).toThrow()
  })
})
