interface PositionedNode {
  type?: string
  url?: string
  children?: PositionedNode[]
  position?: {
    start?: { offset?: number }
    end?: { offset?: number }
  }
}

interface VFileLike {
  value?: unknown
}

function windowsPathFromRawLink(rawLink: string): string | null {
  // Markdown treats `\.` as an escaped dot. Read Windows destinations from the
  // original source so a directory such as `.prd` does not become `xxx.prd`.
  const match = /\]\(\s*<?((?:[a-zA-Z]:\\|\\\\)[^>\r\n]*?)>?\s*\)$/s.exec(rawLink)
  if (!match) return null
  const windowsPath = match[1]
  if (windowsPath.startsWith("\\\\")) {
    return `//${windowsPath.slice(2).replace(/\\+/g, "/")}`
  }
  return windowsPath.replace(/\\+/g, "/")
}

export function restoreWindowsFileLinkDestinations(
  tree: PositionedNode,
  markdown: string
): void {
  const visit = (node: PositionedNode): void => {
    if (node.type === "link") {
      const start = node.position?.start?.offset
      const end = node.position?.end?.offset
      if (typeof start === "number" && typeof end === "number") {
        const restored = windowsPathFromRawLink(markdown.slice(start, end))
        if (restored) node.url = restored
      }
    }
    node.children?.forEach(visit)
  }
  visit(tree)
}

export default function remarkWindowsFileLinks(): (
  tree: PositionedNode,
  file: VFileLike
) => void {
  return (tree, file) => {
    const markdown = typeof file.value === "string" ? file.value : String(file.value ?? "")
    restoreWindowsFileLinkDestinations(tree, markdown)
  }
}
