import { describe, expect, it } from "vitest"
import {
  inferWorkspacePreviewPathKind,
  resolveResourcePreviewPaths,
  selectResourcePreviewFileSource
} from "./resource-preview-paths"

describe("resource preview paths", () => {
  it("treats Windows drive-letter casing as the same workspace without losing absolute intent", () => {
    const resolved = resolveResourcePreviewPaths("c:\\repo\\src\\index.ts", "C:\\repo", "win32")
    expect(resolved).toMatchObject({
      inWorkspace: true,
      workspaceFilePath: "/src/index.ts",
      workspacePathKind: "absolute"
    })
    expect(selectResourcePreviewFileSource(resolved, false)).toEqual({
      filePath: "c:/repo/src/index.ts",
      workspacePathKind: "absolute"
    })
  })

  it("treats a Windows file-tree index as relative only when its source says so", () => {
    const resolved = resolveResourcePreviewPaths("/src/index.ts", "C:\\repo", "win32", "relative")
    expect(resolved).toMatchObject({
      fullPath: "C:/repo/src/index.ts",
      inWorkspace: true,
      workspaceFilePath: "/src/index.ts"
    })
    expect(selectResourcePreviewFileSource(resolved, false)).toEqual({
      filePath: "/src/index.ts",
      workspacePathKind: "relative"
    })
  })

  it("treats the POSIX file-tree /src convention as workspace-relative when explicit", () => {
    const resolved = resolveResourcePreviewPaths("/src/index.ts", "/workspace", "linux", "relative")
    expect(resolved).toMatchObject({
      fullPath: "/workspace/src/index.ts",
      inWorkspace: true,
      workspaceFilePath: "/src/index.ts"
    })
    expect(selectResourcePreviewFileSource(resolved, false)).toEqual({
      filePath: "/src/index.ts",
      workspacePathKind: "relative"
    })
  })

  it("keeps an explicit POSIX file-tree path relative while metadata hydrates", () => {
    const resolved = resolveResourcePreviewPaths("/src/index.ts", null, "linux", "relative")
    expect(selectResourcePreviewFileSource(resolved, false)).toEqual({
      filePath: "/src/index.ts",
      workspacePathKind: "relative"
    })
  })

  it("does not reinterpret a POSIX tool /tmp path as a workspace-relative file", () => {
    const resolved = resolveResourcePreviewPaths("/tmp/report.md", "/workspace", "linux")
    expect(resolved).toMatchObject({
      fullPath: "/tmp/report.md",
      inWorkspace: false,
      workspacePathKind: "absolute"
    })
    expect(selectResourcePreviewFileSource(resolved, false)).toEqual({
      filePath: "/tmp/report.md",
      externalFullPath: "/tmp/report.md"
    })
  })

  it("keeps a POSIX tool /tmp path absolute while workspace metadata hydrates", () => {
    const resolved = resolveResourcePreviewPaths("/tmp/report.md", null, "linux")
    expect(selectResourcePreviewFileSource(resolved, false)).toEqual({
      filePath: "/tmp/report.md",
      workspacePathKind: "absolute"
    })
  })

  it("uses auto only when a known source explicitly requests authoritative disambiguation", () => {
    const unresolved = resolveResourcePreviewPaths("/src/index.ts", null, "linux", "auto")
    expect(selectResourcePreviewFileSource(unresolved, false)).toEqual({
      filePath: "/src/index.ts",
      workspacePathKind: "auto"
    })

    const hydrated = resolveResourcePreviewPaths("/src/index.ts", "/workspace", "linux", "auto")
    expect(hydrated).toMatchObject({
      fullPath: "/workspace/src/index.ts",
      inWorkspace: true
    })
  })

  it("preserves a genuine POSIX absolute path already inside the workspace", () => {
    const resolved = resolveResourcePreviewPaths("/workspace/src/index.ts", "/workspace", "darwin")
    expect(resolved).toMatchObject({
      fullPath: "/workspace/src/index.ts",
      inWorkspace: true,
      workspaceFilePath: "/src/index.ts",
      workspacePathKind: "absolute"
    })
    expect(selectResourcePreviewFileSource(resolved, false)).toEqual({
      filePath: "/workspace/src/index.ts",
      workspacePathKind: "absolute"
    })
  })

  it("treats Windows UNC casing as the same workspace", () => {
    const resolved = resolveResourcePreviewPaths(
      "\\\\server\\share\\repo\\src\\index.ts",
      "\\\\SERVER\\SHARE\\REPO",
      "win32"
    )
    expect(resolved).toMatchObject({
      fullPath: "//server/share/repo/src/index.ts",
      inWorkspace: true,
      workspaceFilePath: "/src/index.ts",
      workspacePathKind: "absolute"
    })
  })

  it("keeps an ordinary relative path on the authoritative workspace route", () => {
    const resolved = resolveResourcePreviewPaths("src/index.ts", null)
    expect(selectResourcePreviewFileSource(resolved, false)).toEqual({
      filePath: "src/index.ts",
      workspacePathKind: "relative"
    })
  })

  it.each(["C:\\repo\\src\\index.ts", "\\\\server\\share\\repo\\src\\index.ts"])(
    "keeps the drive/UNC candidate %s absolute while metadata hydrates",
    (filePath) => {
      const resolved = resolveResourcePreviewPaths(filePath, null, "win32")
      expect(selectResourcePreviewFileSource(resolved, false)).toEqual({
        filePath: filePath.replace(/\\/g, "/"),
        workspacePathKind: "absolute"
      })
    }
  )

  it("handles a POSIX root workspace without adding or removing a root separator", () => {
    expect(resolveResourcePreviewPaths("etc/config.json", "/", "linux", "relative")).toMatchObject({
      fullPath: "/etc/config.json",
      inWorkspace: true,
      workspaceFilePath: "/etc/config.json"
    })
  })

  it("uses the external route when a trusted-source authorization is present", () => {
    const resolved = resolveResourcePreviewPaths("C:\\artifacts\\report.md", "C:\\repo", "win32")
    expect(selectResourcePreviewFileSource(resolved, true)).toEqual({
      filePath: "C:/artifacts/report.md",
      externalFullPath: "C:/artifacts/report.md"
    })
  })

  it("keeps the original POSIX absolute path when an external grant exists", () => {
    const resolved = resolveResourcePreviewPaths("/outside/report.md", "/workspace", "linux")
    expect(selectResourcePreviewFileSource(resolved, true)).toEqual({
      filePath: "/outside/report.md",
      externalFullPath: "/outside/report.md"
    })
  })

  it("infers file-tree and tool semantics independently", () => {
    expect(inferWorkspacePreviewPathKind("src/index.ts", "linux")).toBe("relative")
    expect(inferWorkspacePreviewPathKind("/tmp/report.md", "linux")).toBe("absolute")
    expect(inferWorkspacePreviewPathKind("C:\\temp\\report.md", "linux")).toBe("absolute")
    expect(inferWorkspacePreviewPathKind("\\\\server\\share\\report.md", "linux")).toBe("absolute")
  })
})
