import { describe, expect, it } from "vitest"
import {
  AGENT_COMMIT_NO_ELIGIBLE_FILES_MESSAGE,
  buildInitialSelectedPaths,
  pathMatchesSelection,
  pathsForCommitSelectionFile,
  resolveCommitWorktreePath,
  shouldAutoDismissEmptyAgentCommitSelection
} from "./agent-git-commit-selection"

describe("Agent git commit selection", () => {
  it("auto-dismisses an explicit Agent scope after every suggested path is filtered out", () => {
    expect(
      shouldAutoDismissEmptyAgentCommitSelection({
        selectionSource: "pathspec",
        suggestedPathCount: 3,
        selectedPathCount: 0,
        loading: false,
        failed: false
      })
    ).toBe(true)
    expect(AGENT_COMMIT_NO_ELIGIBLE_FILES_MESSAGE).toContain("Git ignore")
  })

  it("does not auto-dismiss while loading, after an error, or after a manual selection", () => {
    const base = {
      selectionSource: "pathspec" as const,
      suggestedPathCount: 1,
      selectedPathCount: 0,
      loading: false,
      failed: false
    }

    expect(shouldAutoDismissEmptyAgentCommitSelection({ ...base, loading: true })).toBe(false)
    expect(shouldAutoDismissEmptyAgentCommitSelection({ ...base, failed: true })).toBe(false)
    expect(shouldAutoDismissEmptyAgentCommitSelection({ ...base, selectedPathCount: 1 })).toBe(false)
    expect(
      shouldAutoDismissEmptyAgentCommitSelection({ ...base, selectionSource: "staged" })
    ).toBe(false)
  })

  it("selects every Git-reported change when the Agent did not specify a scope", () => {
    const selected = buildInitialSelectedPaths([{ path: "src/visible.ts" }], undefined, [
      "src/visible.ts",
      "src/beyond-visible-limit.ts"
    ])

    expect(Array.from(selected)).toEqual(["src/visible.ts", "src/beyond-visible-limit.ts"])
  })

  it("keeps an empty staged scope empty instead of selecting working-tree changes", () => {
    const selected = buildInitialSelectedPaths([], [], ["src/unrelated.ts"], {
      suggestedPathKind: "staged"
    })

    expect(Array.from(selected)).toEqual([])
  })

  it("drops suggestions omitted from Git's changed-file list", () => {
    const selected = buildInitialSelectedPaths(
      [{ path: "src/feature.ts" }],
      ["src/feature.ts", ".env", "tmp/agent.log", "missing.txt"],
      ["src/feature.ts"]
    )

    expect(Array.from(selected)).toEqual(["src/feature.ts"])
  })

  it("preserves leading and trailing spaces in Git file names", () => {
    const changedFiles = [" leading.ts", "trailing.ts "]
    const selected = buildInitialSelectedPaths([], changedFiles, changedFiles)

    expect(Array.from(selected)).toEqual(changedFiles)
  })

  it("keeps an ignored-only suggestion empty instead of selecting unrelated changes", () => {
    const selected = buildInitialSelectedPaths(
      [{ path: "src/unrelated.ts" }],
      [".env"],
      ["src/unrelated.ts"]
    )

    expect(Array.from(selected)).toEqual([])
  })

  it("expands a suggested directory against the complete changed-file list", () => {
    const selected = buildInitialSelectedPaths(
      [{ path: "src/visible.ts" }],
      ["src"],
      ["src/visible.ts", "src/beyond-visible-limit.ts", "tests/feature.test.ts"]
    )

    expect(Array.from(selected)).toEqual(["src/visible.ts", "src/beyond-visible-limit.ts"])
  })

  it("fails closed for exclude magic or glob pathspecs", () => {
    const changedFiles = ["safe.ts", "secret.ts"]

    expect(
      Array.from(buildInitialSelectedPaths([], [".", ":(exclude)secret.ts"], changedFiles))
    ).toEqual([])
    expect(Array.from(buildInitialSelectedPaths([], [".", ":!secret.ts"], changedFiles))).toEqual(
      []
    )
    expect(
      Array.from(buildInitialSelectedPaths([], [".", ":/!secret.ts"], changedFiles))
    ).toEqual([])
    expect(
      Array.from(buildInitialSelectedPaths([], [".", ":/^secret.ts"], changedFiles))
    ).toEqual([])
    expect(
      Array.from(buildInitialSelectedPaths([], [".", "://!secret.ts"], changedFiles))
    ).toEqual([])
    expect(
      Array.from(buildInitialSelectedPaths([], [".", "://^secret.ts"], changedFiles))
    ).toEqual([])
    expect(Array.from(buildInitialSelectedPaths([], ["*.ts"], changedFiles))).toEqual([])
  })

  it("treats Git-reported staged paths as literal file names", () => {
    const stagedPaths = [":(exclude)literal.ts", ":/literal.ts"]
    const selected = buildInitialSelectedPaths([], stagedPaths, stagedPaths, {
      suggestedPathKind: "staged"
    })

    expect(Array.from(selected)).toEqual(stagedPaths)
  })

  it("treats drive-looking Git paths as relative inside a POSIX repository", () => {
    const selected = buildInitialSelectedPaths([], ["C:/foo.ts"], ["C:/foo.ts"], {
      suggestedBasePath: "/repo",
      workspacePath: "/repo",
      targetWorktreePath: "/repo",
      suggestedPathKind: "staged"
    })

    expect(Array.from(selected)).toEqual(["C:/foo.ts"])
  })

  it("keeps a POSIX backslash filename distinct from a nested path", () => {
    const selected = buildInitialSelectedPaths(
      [],
      ["dir\\file.ts"],
      ["dir\\file.ts", "dir/file.ts"],
      {
        suggestedBasePath: "/repo",
        workspacePath: "/repo",
        targetWorktreePath: "/repo"
      }
    )

    expect(Array.from(selected)).toEqual(["dir\\file.ts"])
  })

  it("does not widen an exact suggestion through display-only rename metadata", () => {
    const selected = buildInitialSelectedPaths(
      [{ path: "src/new-name.ts", previousPath: "src/old-name.ts" }],
      ["src/new-name.ts"],
      ["src/old-name.ts", "src/new-name.ts"]
    )

    expect(Array.from(selected)).toEqual(["src/new-name.ts"])
  })

  it("keeps both indexed rename paths when the staged scope supplies both", () => {
    const selected = buildInitialSelectedPaths(
      [{ path: "src/new-name.ts", previousPath: "src/old-name.ts" }],
      ["src/old-name.ts", "src/new-name.ts"],
      ["src/old-name.ts", "src/new-name.ts"]
    )

    expect(Array.from(selected)).toEqual(["src/old-name.ts", "src/new-name.ts"])
  })

  it("pairs rename rows but never widens copied rows to their source", () => {
    const renamed = {
      path: "src/new-name.ts",
      previousPath: "src/old-name.ts",
      status: "renamed" as const
    }
    const copied = {
      path: "src/copy.ts",
      previousPath: "src/source.ts",
      status: "copied" as const
    }

    expect(pathsForCommitSelectionFile(renamed)).toEqual([
      "src/old-name.ts",
      "src/new-name.ts"
    ])
    expect(pathMatchesSelection(renamed, "src/old-name.ts")).toBe(true)
    expect(pathsForCommitSelectionFile(copied)).toEqual(["src/copy.ts"])
    expect(pathMatchesSelection(copied, "src/source.ts")).toBe(false)
  })

  it("temporarily preserves suggestions only while the Git file list is loading", () => {
    const loading = buildInitialSelectedPaths([], [".env"])
    const loaded = buildInitialSelectedPaths([], [".env"], [])

    expect(Array.from(loading)).toEqual([".env"])
    expect(Array.from(loaded)).toEqual([])
  })

  it("resolves relative and absolute suggestions against the target worktree", () => {
    const options = {
      suggestedBasePath: "C:/workspace/packages/app",
      workspacePath: "C:/workspace",
      targetWorktreePath: "C:/workspace/packages/app"
    }
    const changedFiles = ["src/relative.ts", "src/absolute.ts"]

    expect(
      Array.from(
        buildInitialSelectedPaths(
          [],
          ["src/relative.ts", "C:/workspace/packages/app/src/absolute.ts"],
          changedFiles,
          options
        )
      )
    ).toEqual(changedFiles)
  })

  it("resolves repository-root-relative staged paths for a subdirectory worktree", () => {
    const selected = buildInitialSelectedPaths(
      [],
      ["packages/app/src/staged.ts"],
      ["src/staged.ts"],
      {
        suggestedBasePath: "C:/workspace",
        workspacePath: "C:/workspace",
        targetWorktreePath: "C:/workspace/packages/app"
      }
    )

    expect(Array.from(selected)).toEqual(["src/staged.ts"])
  })

  it("uses the repository root as the target for pathspecs from a nested cwd", () => {
    const targetWorktreePath = resolveCommitWorktreePath("C:/workspace", "C:/workspace")
    const selected = buildInitialSelectedPaths(
      [],
      ["../../src/index.ts"],
      ["src/index.ts", "packages/app/src/index.ts"],
      {
        suggestedBasePath: "C:/workspace/packages/app",
        workspacePath: "C:/workspace",
        targetWorktreePath
      }
    )

    expect(Array.from(selected)).toEqual(["src/index.ts"])
  })

  it("drops pathspecs outside a nested repository instead of aliasing same-named files", () => {
    const selected = buildInitialSelectedPaths([], ["../../src/index.ts"], ["src/index.ts"], {
      suggestedBasePath: "C:/workspace/packages/app",
      workspacePath: "C:/workspace",
      targetWorktreePath: "C:/workspace/packages/app"
    })

    expect(Array.from(selected)).toEqual([])
  })

  it("resolves top-magic pathspecs from the repository root before scope checks", () => {
    const selected = buildInitialSelectedPaths([], [":/src/index.ts"], ["src/index.ts"], {
      suggestedBasePath: "/repo/packages/app",
      repositoryRootPath: "/repo",
      workspacePath: "/repo/packages/app",
      targetWorktreePath: "/repo/packages/app"
    })

    expect(Array.from(selected)).toEqual([])
  })

  it("keeps POSIX path comparisons case-sensitive", () => {
    const selected = buildInitialSelectedPaths(
      [],
      ["/workspace/repo/src/index.ts"],
      ["src/index.ts"],
      {
        suggestedBasePath: "/workspace/repo",
        workspacePath: "/workspace/Repo",
        targetWorktreePath: "/workspace/Repo"
      }
    )

    expect(Array.from(selected)).toEqual([])
  })

  it("preserves UNC and extended Windows roots used for Git operations", () => {
    expect(resolveCommitWorktreePath("\\\\server\\share\\repo", "\\\\server\\share\\repo")).toBe(
      "//server/share/repo"
    )
    expect(resolveCommitWorktreePath("\\\\?\\C:\\repo", "\\\\?\\C:\\repo")).toBe("//?/C:/repo")
  })

  it("compares extended Windows roots with Git's ordinary root representation", () => {
    const extendedDriveTarget = resolveCommitWorktreePath(
      "//?/C:/repo/packages/app",
      "C:/repo/packages/app"
    )
    const extendedUncTarget = resolveCommitWorktreePath(
      "//?/UNC/server/share/repo/packages/app",
      "//server/share/repo/packages/app"
    )
    const extendedDriveSelection = buildInitialSelectedPaths(
      [],
      ["packages/app/src/index.ts"],
      ["src/index.ts"],
      {
        suggestedBasePath: "C:/repo",
        repositoryRootPath: "C:/repo",
        workspacePath: "//?/C:/repo/packages/app",
        targetWorktreePath: extendedDriveTarget
      }
    )
    const extendedUncSelection = buildInitialSelectedPaths(
      [],
      ["packages/app/src/index.ts"],
      ["src/index.ts"],
      {
        suggestedBasePath: "//server/share/repo",
        repositoryRootPath: "//server/share/repo",
        workspacePath: "//?/UNC/server/share/repo/packages/app",
        targetWorktreePath: extendedUncTarget
      }
    )

    expect(extendedDriveTarget).toBe("//?/C:/repo/packages/app")
    expect(extendedUncTarget).toBe("//?/UNC/server/share/repo/packages/app")
    expect(resolveCommitWorktreePath("//?/C:/repo", "C:/repo/packages/app")).toBe(
      "//?/C:/repo/packages/app"
    )
    expect(
      resolveCommitWorktreePath(
        "//?/UNC/server/share/repo",
        "//server/share/repo/packages/app"
      )
    ).toBe("//?/UNC/server/share/repo/packages/app")
    expect(Array.from(extendedDriveSelection)).toEqual(["src/index.ts"])
    expect(Array.from(extendedUncSelection)).toEqual(["src/index.ts"])
  })

  it("clamps a parent repository root to a subdirectory workspace", () => {
    expect(resolveCommitWorktreePath("C:/workspace/packages/app", "C:/workspace")).toBe(
      "C:/workspace/packages/app"
    )
    expect(resolveCommitWorktreePath("C:/workspace", "C:/workspace/packages/app")).toBe(
      "C:/workspace/packages/app"
    )
  })
})
