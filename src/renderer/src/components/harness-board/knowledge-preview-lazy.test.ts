import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const source = readFileSync(new URL("./KnowledgePreviewPanel.tsx", import.meta.url), "utf8")

describe("Harness knowledge preview route isolation", () => {
  it("keeps the heavy file viewer outside the initial Harness static module graph", () => {
    expect(source).not.toMatch(/import\s+\{\s*FileViewer\s*\}\s+from/)
    expect(source).toContain("const FileViewer = lazy(() =>")
    expect(source).toContain('import("@/components/tabs/FileViewer")')
  })

  it("mounts the lazy viewer behind a Suspense fallback only for a selected file", () => {
    const selectionBranch = source.slice(source.indexOf("{selectedFullPath ? ("))
    expect(selectionBranch).toContain("<Suspense")
    expect(selectionBranch).toContain("正在加载文件预览...")
    expect(selectionBranch.indexOf("<FileViewer")).toBeGreaterThan(
      selectionBranch.indexOf("<Suspense")
    )
  })
})
