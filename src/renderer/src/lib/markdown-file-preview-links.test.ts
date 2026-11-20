import { describe, expect, it } from "vitest"
import { isLocalFileLikeHref, normalizePreviewFileHref } from "./markdown-file-preview-links"

describe("markdown file preview links", () => {
  it("normalizes Windows drive links with a leading slash before matching the workspace", () => {
    expect(
      normalizePreviewFileHref(
        "/D:/workspace/LU76/LU76.12_qua-statistics/src/main/java/com/cmb/qua/statistics/controller/QuaController.java:330",
        "D:/workspace/LU76/LU76.12_qua-statistics"
      )
    ).toBe(
      "D:/workspace/LU76/LU76.12_qua-statistics/src/main/java/com/cmb/qua/statistics/controller/QuaController.java"
    )
  })

  it("classifies unresolved local file links so markdown can block default navigation", () => {
    expect(isLocalFileLikeHref("/D:/workspace/project/src/Foo.java:12")).toBe(true)
    expect(isLocalFileLikeHref("https://example.com/D:/not-local")).toBe(false)
  })

  it.each([
    [
      "C:\\repo\\src\\index.ts:10:4",
      "C:\\repo",
      "C:/repo/src/index.ts"
    ],
    ["c:/repo/src/index.ts", "C:/repo", "c:/repo/src/index.ts"],
    ["codex-file:///C:/repo/src/index.ts:10", "C:/repo", "C:/repo/src/index.ts"],
    ["file:///C:/repo/src/index.ts", "C:/repo", "C:/repo/src/index.ts"],
    [
      "http://localhost:4312/C:/repo/src/index%20file.ts",
      "C:/repo",
      "C:/repo/src/index file.ts"
    ]
  ] as const)("normalizes supported local href %s", (href, workspacePath, expected) => {
    expect(normalizePreviewFileHref(href, workspacePath)).toBe(expected)
  })

  it("normalizes UNC links and compares Windows paths case-insensitively", () => {
    expect(
      normalizePreviewFileHref(
        "\\\\server\\share\\Repo\\src\\index.ts:22",
        "\\\\SERVER\\SHARE\\repo"
      )
    ).toBe("//server/share/Repo/src/index.ts")
  })

  it("rejects paths outside the current workspace", () => {
    expect(normalizePreviewFileHref("C:/other/secret.txt", "C:/repo")).toBeNull()
    expect(normalizePreviewFileHref("/tmp/secret.txt", "/workspace")).toBeNull()
  })

  it("classifies encoded local paths while keeping unsafe protocols out", () => {
    expect(isLocalFileLikeHref("D:%5Crepo%5Csrc%5Cindex.ts")).toBe(true)
    expect(isLocalFileLikeHref("%5C%5Cserver%5Cshare%5Crepo%5Cindex.ts")).toBe(true)
    expect(isLocalFileLikeHref("file:///C:/repo/index.ts")).toBe(true)
    expect(isLocalFileLikeHref("javascript:alert(1)")).toBe(false)
  })
})
