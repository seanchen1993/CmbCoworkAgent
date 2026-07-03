import { describe, expect, it } from "vitest"
import { buildGitPanelFileTree, flattenGitPanelFileTree, type GitPanelTreeFile } from "./git-panel-file-tree"

function file(displayPath: string, additions = 1, deletions = 0): GitPanelTreeFile {
  return {
    path: displayPath,
    displayPath,
    additions,
    deletions
  }
}

describe("git panel file tree", () => {
  it("groups changed files by directory with directory rows before files", () => {
    const tree = buildGitPanelFileTree([
      file("README.md"),
      file("src/components/Button.tsx", 5, 2),
      file("src/utils/path.ts", 2, 1),
      file("docs/guide.md", 3, 0)
    ])

    const rows = flattenGitPanelFileTree(tree)

    expect(rows.map((row) => `${row.kind}:${row.name}`)).toEqual([
      "directory:docs",
      "file:guide.md",
      "directory:src",
      "directory:components",
      "file:Button.tsx",
      "directory:utils",
      "file:path.ts",
      "file:README.md"
    ])
  })

  it("summarizes file count and diff totals on directory rows", () => {
    const tree = buildGitPanelFileTree([
      file("src/components/Button.tsx", 5, 2),
      file("src/components/Dialog.tsx", 7, 3),
      file("src/index.ts", 1, 0)
    ])

    const src = flattenGitPanelFileTree(tree)[0]
    const components = flattenGitPanelFileTree(tree).find((row) => row.name === "components")

    expect(src).toMatchObject({
      kind: "directory",
      name: "src",
      fileCount: 3,
      additions: 13,
      deletions: 5
    })
    expect(components).toMatchObject({
      kind: "directory",
      fileCount: 2,
      additions: 12,
      deletions: 5
    })
  })

  it("compacts single-child directory chains", () => {
    const tree = buildGitPanelFileTree([file("packages/app/src/main.ts")])

    expect(flattenGitPanelFileTree(tree).map((row) => row.name)).toEqual([
      "packages/app/src",
      "main.ts"
    ])
  })

  it("hides child rows when a directory is collapsed", () => {
    const tree = buildGitPanelFileTree([
      file("src/components/Button.tsx"),
      file("src/utils/path.ts")
    ])
    const src = tree.find((node) => node.name === "src")

    const rows = flattenGitPanelFileTree(tree, new Set(src ? [src.id] : []))

    expect(rows.map((row) => row.name)).toEqual(["src"])
    expect(rows[0]).toMatchObject({
      fileCount: 2,
      additions: 2
    })
  })
})
