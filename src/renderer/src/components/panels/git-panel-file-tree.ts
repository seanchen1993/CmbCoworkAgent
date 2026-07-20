export type GitPanelTreeFile = {
  path: string
  displayPath: string
  additions: number
  deletions: number
}

export type GitPanelFileTreeNode<TFile extends GitPanelTreeFile = GitPanelTreeFile> = {
  id: string
  name: string
  fullPath: string
  depth: number
  kind: "directory" | "file"
  children: GitPanelFileTreeNode<TFile>[]
  file?: TFile
  files: TFile[]
  additions: number
  deletions: number
  fileCount: number
}

export type GitPanelFileTreeRow<TFile extends GitPanelTreeFile = GitPanelTreeFile> = {
  id: string
  name: string
  fullPath: string
  depth: number
  kind: "directory" | "file"
  children: GitPanelFileTreeNode<TFile>[]
  file?: TFile
  files: TFile[]
  additions: number
  deletions: number
  fileCount: number
}

function normalizeTreePath(filePath: string): string {
  return String(filePath || "").replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "")
}

function compareTreeNodes<TFile extends GitPanelTreeFile>(
  left: GitPanelFileTreeNode<TFile>,
  right: GitPanelFileTreeNode<TFile>
): number {
  if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1
  return left.name.localeCompare(right.name, "zh-Hans-CN", {
    numeric: true,
    sensitivity: "base"
  })
}

function createDirectoryNode<TFile extends GitPanelTreeFile>(
  name: string,
  fullPath: string,
  depth: number
): GitPanelFileTreeNode<TFile> {
  return {
    id: `dir:${fullPath}`,
    name,
    fullPath,
    depth,
    kind: "directory",
    children: [],
    files: [],
    additions: 0,
    deletions: 0,
    fileCount: 0
  }
}

function createFileNode<TFile extends GitPanelTreeFile>(
  file: TFile,
  name: string,
  fullPath: string,
  depth: number
): GitPanelFileTreeNode<TFile> {
  return {
    id: `file:${file.path}`,
    name,
    fullPath,
    depth,
    kind: "file",
    children: [],
    file,
    files: [file],
    additions: file.additions,
    deletions: file.deletions,
    fileCount: 1
  }
}

function updateDirectoryTotals<TFile extends GitPanelTreeFile>(
  node: GitPanelFileTreeNode<TFile>
): void {
  if (node.kind === "file") return
  node.files = []
  node.additions = 0
  node.deletions = 0
  node.fileCount = 0
  for (const child of node.children) {
    updateDirectoryTotals(child)
    node.files.push(...child.files)
    node.additions += child.additions
    node.deletions += child.deletions
    node.fileCount += child.fileCount
  }
}

function sortTreeNodes<TFile extends GitPanelTreeFile>(
  nodes: GitPanelFileTreeNode<TFile>[]
): void {
  nodes.sort(compareTreeNodes)
  for (const node of nodes) {
    sortTreeNodes(node.children)
  }
}

export function buildGitPanelFileTree<TFile extends GitPanelTreeFile>(
  files: readonly TFile[]
): GitPanelFileTreeNode<TFile>[] {
  const roots: GitPanelFileTreeNode<TFile>[] = []
  const directoryByPath = new Map<string, GitPanelFileTreeNode<TFile>>()

  for (const file of files) {
    const normalizedPath = normalizeTreePath(file.displayPath || file.path)
    const segments = normalizedPath.split("/").filter(Boolean)
    if (segments.length === 0) continue

    let siblings = roots
    let parentPath = ""
    for (let index = 0; index < segments.length - 1; index += 1) {
      const segment = segments[index]
      const fullPath = parentPath ? `${parentPath}/${segment}` : segment
      let directory = directoryByPath.get(fullPath)
      if (!directory) {
        directory = createDirectoryNode(segment, fullPath, index)
        directoryByPath.set(fullPath, directory)
        siblings.push(directory)
      }
      siblings = directory.children
      parentPath = fullPath
    }

    const fileName = segments[segments.length - 1]
    siblings.push(createFileNode(file, fileName, normalizedPath, segments.length - 1))
  }

  for (const root of roots) {
    updateDirectoryTotals(root)
  }
  sortTreeNodes(roots)
  return roots
}

function compactDirectoryChain<TFile extends GitPanelTreeFile>(
  node: GitPanelFileTreeNode<TFile>
): GitPanelFileTreeNode<TFile>[] {
  if (node.kind !== "directory") return [node]
  const onlyChild = node.children.length === 1 ? node.children[0] : undefined
  if (!onlyChild || onlyChild.kind !== "directory") return [node]
  return [node, ...compactDirectoryChain(onlyChild)]
}

export function flattenGitPanelFileTree<TFile extends GitPanelTreeFile>(
  roots: readonly GitPanelFileTreeNode<TFile>[],
  collapsedDirectoryIds: ReadonlySet<string> = new Set()
): GitPanelFileTreeRow<TFile>[] {
  const rows: GitPanelFileTreeRow<TFile>[] = []

  const visit = (node: GitPanelFileTreeNode<TFile>, depth: number): void => {
    if (node.kind === "file") {
      rows.push({
        id: node.id,
        name: node.name,
        fullPath: node.fullPath,
        depth,
        kind: "file",
        children: [],
        file: node.file,
        files: node.files,
        additions: node.additions,
        deletions: node.deletions,
        fileCount: node.fileCount
      })
      return
    }

    const chain = compactDirectoryChain(node)
    const tail = chain[chain.length - 1]
    rows.push({
      id: node.id,
      name: chain.map((item) => item.name).join("/"),
      fullPath: tail.fullPath,
      depth,
      kind: "directory",
      children: tail.children,
      files: node.files,
      additions: node.additions,
      deletions: node.deletions,
      fileCount: node.fileCount
    })
    if (!collapsedDirectoryIds.has(node.id)) {
      for (const child of tail.children) {
        visit(child, depth + 1)
      }
    }
  }

  for (const root of roots) {
    visit(root, 0)
  }
  return rows
}
