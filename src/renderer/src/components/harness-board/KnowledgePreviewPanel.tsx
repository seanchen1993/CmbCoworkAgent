import { useEffect, useMemo, useState, type ReactNode } from "react"
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  File,
  Folder,
  FolderOpen,
  Loader2,
  RefreshCw
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { FileViewer } from "@/components/tabs/FileViewer"
import { cn } from "@/lib/utils"
import type { HarnessKnowledgePreviewFile, HarnessKnowledgePreviewResult } from "@/types"

interface KnowledgePreviewPanelProps {
  preview: HarnessKnowledgePreviewResult | null
  loading: boolean
  selectedPath: string | null
  onSelectPath: (path: string | null) => void
  onRefresh: () => void | Promise<void>
}

function normalizeTreePath(path: string): string {
  const trimmed = path.trim()
  if (!trimmed) return "/"
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`
}

function getParentPath(path: string): string {
  const normalized = normalizeTreePath(path)
  const lastSlash = normalized.lastIndexOf("/")
  if (lastSlash <= 0) return "/"
  return normalized.slice(0, lastSlash)
}

function buildTree(files: HarnessKnowledgePreviewFile[]): Map<string, HarnessKnowledgePreviewFile[]> {
  const tree = new Map<string, HarnessKnowledgePreviewFile[]>()
  const allDirs = new Set<string>()

  for (const file of files) {
    const normalized = normalizeTreePath(file.path.endsWith("/") ? file.path.slice(0, -1) : file.path)
    let parent = getParentPath(normalized)
    while (parent !== "/") {
      allDirs.add(parent)
      parent = getParentPath(parent)
    }
    if (file.is_dir) allDirs.add(normalized)

    const parentPath = getParentPath(normalized)
    if (!tree.has(parentPath)) tree.set(parentPath, [])
    tree.get(parentPath)!.push({
      ...file,
      path: normalized
    })
  }

  for (const dir of allDirs) {
    const parentPath = getParentPath(dir)
    const siblings = tree.get(parentPath) ?? []
    if (siblings.some((item) => item.path === dir)) continue
    if (!tree.has(parentPath)) tree.set(parentPath, [])
    tree.get(parentPath)!.push({ path: dir, is_dir: true })
  }

  for (const children of tree.values()) {
    children.sort((left, right) => {
      if (left.is_dir && !right.is_dir) return -1
      if (!left.is_dir && right.is_dir) return 1
      return left.path.localeCompare(right.path)
    })
  }

  return tree
}

function formatSize(bytes?: number): string {
  if (!bytes) return ""
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

function joinKnowledgePath(rootPath: string, relativePath: string): string {
  const separator = rootPath.includes("\\") ? "\\" : "/"
  const root = rootPath.replace(/[\\/]+$/, "")
  const relative = relativePath.replace(/^\/+/, "").replace(/\//g, separator)
  return relative ? `${root}${separator}${relative}` : root
}

export function KnowledgePreviewPanel({
  preview,
  loading,
  selectedPath,
  onSelectPath,
  onRefresh
}: KnowledgePreviewPanelProps): React.JSX.Element {
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set(["/"]))
  const files = preview?.files ?? []
  const tree = useMemo(() => buildTree(files), [files])
  const firstFilePath = useMemo(
    () => files.find((file) => !file.is_dir)?.path ?? null,
    [files]
  )
  const selectedFile = selectedPath
    ? files.find((file) => file.path === selectedPath && !file.is_dir) ?? null
    : null
  const selectedFullPath =
    preview?.path && selectedFile ? joinKnowledgePath(preview.path, selectedFile.path) : null

  useEffect(() => {
    if (!firstFilePath) {
      if (selectedPath) onSelectPath(null)
      return
    }
    const selectedStillValid = files.some((file) => file.path === selectedPath && !file.is_dir)
    if (!selectedStillValid) onSelectPath(firstFilePath)
  }, [files, firstFilePath, onSelectPath, selectedPath])

  const toggleDir = (path: string): void => {
    setExpandedDirs((current) => {
      const next = new Set(current)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
      }
      return next
    })
  }

  const renderNode = (file: HarnessKnowledgePreviewFile, depth: number): React.JSX.Element => {
    const isExpanded = expandedDirs.has(file.path)
    const children = tree.get(file.path) ?? []
    const name = file.path.split("/").pop() || file.path
    const selected = selectedPath === file.path && !file.is_dir

    return (
      <div key={file.path}>
        <button
          type="button"
          className={cn(
            "flex h-8 w-full min-w-0 items-center gap-2 px-3 text-left text-xs transition-colors hover:bg-muted",
            selected && "bg-primary/10 text-primary"
          )}
          style={{ paddingLeft: `${depth * 14 + 10}px` }}
          onClick={() => {
            if (file.is_dir) {
              toggleDir(file.path)
            } else {
              onSelectPath(file.path)
            }
          }}
          title={file.path}
        >
          {file.is_dir ? (
            isExpanded ? (
              <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
            )
          ) : (
            <span className="w-3 shrink-0" />
          )}
          {file.is_dir ? (
            <Folder className="size-3.5 shrink-0 text-status-warning" />
          ) : (
            <File className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="min-w-0 flex-1 truncate">{name}</span>
          {!file.is_dir && file.size !== undefined && (
            <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
              {formatSize(file.size)}
            </span>
          )}
        </button>
        {file.is_dir && isExpanded && children.map((child) => renderNode(child, depth + 1))}
      </div>
    )
  }

  const rootItems = tree.get("/") ?? []

  return (
    <div className="mt-3 overflow-hidden rounded-md border border-border bg-background">
      <div className="flex h-10 items-center justify-between border-b border-border px-3">
        <div className="min-w-0">
          <div className="truncate text-xs font-medium text-foreground">系统约束预览</div>
          {preview?.path && (
            <div className="truncate text-[11px] text-muted-foreground" title={preview.path}>
              {preview.path}
            </div>
          )}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          disabled={loading}
          title="刷新系统约束预览"
          onClick={() => void onRefresh()}
        >
          {loading ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <RefreshCw className="size-3.5" />
          )}
        </Button>
      </div>

      {loading ? (
        <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">
          <Loader2 className="mr-2 size-4 animate-spin" />
          加载知识库...
        </div>
      ) : !preview ? (
        <KnowledgePreviewEmpty icon={<FolderOpen className="size-5" />} text="展开后加载系统约束预览。" />
      ) : !preview.configured ? (
        <KnowledgePreviewEmpty icon={<AlertCircle className="size-5" />} text="暂无知识库" />
      ) : preview.error ? (
        <KnowledgePreviewEmpty icon={<AlertCircle className="size-5" />} text={preview.error} />
      ) : !preview.exists ? (
        <KnowledgePreviewEmpty icon={<FolderOpen className="size-5" />} text="尚未拉取知识库。" />
      ) : files.length === 0 ? (
        <KnowledgePreviewEmpty icon={<FolderOpen className="size-5" />} text="知识库目录为空。" />
      ) : (
        <div className="grid h-[360px] min-h-0 grid-cols-[280px_minmax(0,1fr)]">
          <div className="min-w-0 border-r border-border">
            <ScrollArea className="h-full">
              <div className="py-2">
                {rootItems.map((file) => renderNode(file, 0))}
              </div>
            </ScrollArea>
          </div>
          <div className="flex min-w-0 min-h-0 overflow-hidden">
            {selectedFullPath ? (
              <FileViewer
                filePath={selectedFile?.path ?? selectedFullPath}
                externalFullPath={selectedFullPath}
              />
            ) : (
              <KnowledgePreviewEmpty icon={<File className="size-5" />} text="请选择文件预览。" />
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function KnowledgePreviewEmpty({
  icon,
  text
}: {
  icon: ReactNode
  text: string
}): React.JSX.Element {
  return (
    <div className="flex h-48 flex-col items-center justify-center gap-2 px-4 text-center text-sm text-muted-foreground">
      <div className="text-muted-foreground/70">{icon}</div>
      <div>{text}</div>
    </div>
  )
}
