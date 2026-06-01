import { useEffect, useMemo, useState } from "react"
import {
  Check,
  ChevronDown,
  ChevronRight,
  FileText,
  Loader2,
  RotateCcw,
  Save,
  X
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { DiffDisplay } from "@/components/chat/DiffDisplay"
import {
  buildBundleUnifiedDiff,
  ensureTextBundleEvolverMarker,
  type TextBundleFile
} from "@/lib/skill-bundle-diff"
import { cn } from "@/lib/utils"

interface SkillBundleMergeEditorProps {
  open: boolean
  title: string
  description?: string
  baseFiles: TextBundleFile[]
  initialFiles: TextBundleFile[]
  startingFiles?: TextBundleFile[]
  confirmLabel?: string
  saving?: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: (files: TextBundleFile[]) => Promise<void> | void
}

interface MergeBlock {
  id: string
  path: string
  kind: "added" | "deleted" | "changed"
  index: number
  oldStart: number
  newStart: number
  oldLines: string[]
  newLines: string[]
  contextBefore?: string
  contextAfter?: string
  baseContent: string
  candidateContent: string
}

interface LineChangeBlock {
  oldStart: number
  newStart: number
  oldLines: string[]
  newLines: string[]
  contextBefore?: string
  contextAfter?: string
}

function sortedFiles(files: TextBundleFile[]): TextBundleFile[] {
  return [...files].sort((a, b) => a.path.localeCompare(b.path))
}

function splitLines(content: string): string[] {
  return content === "" ? [] : content.split("\n")
}

function joinLines(lines: string[]): string {
  return lines.join("\n")
}

function findUniqueAnchor(
  oldLines: string[],
  newLines: string[],
  oldStart: number,
  oldEnd: number,
  newStart: number,
  newEnd: number
): { oldIndex: number; newIndex: number } | null {
  const oldCounts = new Map<string, number>()
  const newCounts = new Map<string, number>()

  for (let index = oldStart; index < oldEnd; index += 1) {
    oldCounts.set(oldLines[index], (oldCounts.get(oldLines[index]) ?? 0) + 1)
  }
  for (let index = newStart; index < newEnd; index += 1) {
    newCounts.set(newLines[index], (newCounts.get(newLines[index]) ?? 0) + 1)
  }

  for (let oldIndex = oldStart; oldIndex < oldEnd; oldIndex += 1) {
    const line = oldLines[oldIndex]
    if (!line.trim() || oldCounts.get(line) !== 1 || newCounts.get(line) !== 1) continue
    const newIndex = newLines.findIndex(
      (candidate, index) => index >= newStart && index < newEnd && candidate === line
    )
    if (newIndex >= 0) return { oldIndex, newIndex }
  }

  return null
}

function buildLineChangeBlocks(
  oldLines: string[],
  newLines: string[],
  oldOffset = 0,
  newOffset = 0
): LineChangeBlock[] {
  let prefix = 0
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix += 1
  }

  let suffix = 0
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1
  }

  const oldStart = prefix
  const newStart = prefix
  const oldEnd = oldLines.length - suffix
  const newEnd = newLines.length - suffix

  if (oldStart === oldEnd && newStart === newEnd) {
    return []
  }

  const anchor = findUniqueAnchor(oldLines, newLines, oldStart, oldEnd, newStart, newEnd)
  if (anchor) {
    return [
      ...buildLineChangeBlocks(
        oldLines.slice(oldStart, anchor.oldIndex),
        newLines.slice(newStart, anchor.newIndex),
        oldOffset + oldStart,
        newOffset + newStart
      ),
      ...buildLineChangeBlocks(
        oldLines.slice(anchor.oldIndex + 1, oldEnd),
        newLines.slice(anchor.newIndex + 1, newEnd),
        oldOffset + anchor.oldIndex + 1,
        newOffset + anchor.newIndex + 1
      )
    ]
  }

  const contextBefore = oldStart > 0 ? oldLines[oldStart - 1] : undefined
  const contextAfter = oldEnd < oldLines.length ? oldLines[oldEnd] : undefined
  return [
    {
      oldStart: oldOffset + oldStart + 1,
      newStart: newOffset + newStart + 1,
      oldLines: oldLines.slice(oldStart, oldEnd),
      newLines: newLines.slice(newStart, newEnd),
      contextBefore,
      contextAfter
    }
  ]
}

function buildMergeBlocks(
  baseFiles: TextBundleFile[],
  candidateFiles: TextBundleFile[]
): MergeBlock[] {
  const baseByPath = new Map(baseFiles.map((file) => [file.path, file]))
  const candidateByPath = new Map(candidateFiles.map((file) => [file.path, file]))
  const paths = Array.from(new Set([...baseByPath.keys(), ...candidateByPath.keys()])).sort()
  const blocks: MergeBlock[] = []

  for (const path of paths) {
    const baseFile = baseByPath.get(path)
    const candidateFile = candidateByPath.get(path)
    const baseContent = baseFile?.content ?? ""
    const candidateContent = candidateFile?.content ?? ""

    if (!baseFile && candidateFile) {
      blocks.push({
        id: `${path}:added`,
        path,
        kind: "added",
        index: 1,
        oldStart: 1,
        newStart: 1,
        oldLines: [],
        newLines: splitLines(candidateContent),
        contextBefore: undefined,
        contextAfter: undefined,
        baseContent,
        candidateContent
      })
      continue
    }

    if (baseFile && !candidateFile) {
      blocks.push({
        id: `${path}:deleted`,
        path,
        kind: "deleted",
        index: 1,
        oldStart: 1,
        newStart: 1,
        oldLines: splitLines(baseContent),
        newLines: [],
        contextBefore: undefined,
        contextAfter: undefined,
        baseContent,
        candidateContent
      })
      continue
    }

    if (!baseFile || !candidateFile || baseContent === candidateContent) {
      continue
    }

    const oldLines = splitLines(baseContent)
    const newLines = splitLines(candidateContent)
    buildLineChangeBlocks(oldLines, newLines).forEach((block, index) => {
      blocks.push({
        id: `${path}:changed:${index + 1}`,
        path,
        kind: "changed",
        index: index + 1,
        oldStart: block.oldStart,
        newStart: block.newStart,
        oldLines: block.oldLines,
        newLines: block.newLines,
        contextBefore: block.contextBefore,
        contextAfter: block.contextAfter,
        baseContent,
        candidateContent
      })
    })
  }

  return blocks
}

function findLineSequence(haystack: string[], needle: string[]): number {
  if (needle.length === 0 || needle.length > haystack.length) {
    return -1
  }

  for (let index = 0; index <= haystack.length - needle.length; index += 1) {
    let matched = true
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[index + offset] !== needle[offset]) {
        matched = false
        break
      }
    }
    if (matched) return index
  }

  return -1
}

function contentHasLineSequence(content: string | undefined, lines: string[]): boolean {
  if (content === undefined) return false
  if (lines.length === 0) return true
  return findLineSequence(splitLines(content), lines) >= 0
}

function replaceLineBlock(
  currentContent: string,
  fromLines: string[],
  toLines: string[],
  fallbackContent: string,
  contextBefore?: string,
  contextAfter?: string,
  expectedStart?: number
): string {
  const currentLines = splitLines(currentContent)
  if (toLines.length > 0 && findLineSequence(currentLines, toLines) >= 0) {
    return currentContent
  }

  if (fromLines.length === 0) {
    if (toLines.length === 0) return currentContent
    const beforeIndex =
      contextBefore === undefined ? -1 : currentLines.findIndex((line) => line === contextBefore)
    if (beforeIndex >= 0) {
      return joinLines([
        ...currentLines.slice(0, beforeIndex + 1),
        ...toLines,
        ...currentLines.slice(beforeIndex + 1)
      ])
    }
    const afterIndex =
      contextAfter === undefined ? -1 : currentLines.findIndex((line) => line === contextAfter)
    if (afterIndex >= 0) {
      return joinLines([
        ...currentLines.slice(0, afterIndex),
        ...toLines,
        ...currentLines.slice(afterIndex)
      ])
    }
    return fallbackContent
  }

  const index = findLineSequence(currentLines, fromLines)
  if (index < 0) {
    const beforeIndex =
      contextBefore === undefined ? -1 : currentLines.findIndex((line) => line === contextBefore)
    const afterIndex =
      contextAfter === undefined
        ? -1
        : currentLines.findIndex(
            (line, lineIndex) =>
              line === contextAfter && (beforeIndex < 0 || lineIndex > beforeIndex)
          )

    if (beforeIndex >= 0 && afterIndex > beforeIndex) {
      return joinLines([
        ...currentLines.slice(0, beforeIndex + 1),
        ...toLines,
        ...currentLines.slice(afterIndex)
      ])
    }

    if (beforeIndex >= 0) {
      const start = beforeIndex + 1
      const end = Math.min(currentLines.length, start + fromLines.length)
      return joinLines([...currentLines.slice(0, start), ...toLines, ...currentLines.slice(end)])
    }

    if (afterIndex >= 0) {
      const start = Math.max(0, afterIndex - fromLines.length)
      return joinLines([
        ...currentLines.slice(0, start),
        ...toLines,
        ...currentLines.slice(afterIndex)
      ])
    }

    const start = typeof expectedStart === "number" ? expectedStart - 1 : -1
    if (start >= 0 && start <= currentLines.length) {
      const end = Math.min(currentLines.length, start + fromLines.length)
      return joinLines([...currentLines.slice(0, start), ...toLines, ...currentLines.slice(end)])
    }

    return fallbackContent
  }

  return joinLines([
    ...currentLines.slice(0, index),
    ...toLines,
    ...currentLines.slice(index + fromLines.length)
  ])
}

function upsertDraftFile(files: TextBundleFile[], path: string, content: string): TextBundleFile[] {
  const next = files.filter((file) => file.path !== path)
  next.push({ path, content })
  return sortedFiles(next)
}

function removeDraftFile(files: TextBundleFile[], path: string): TextBundleFile[] {
  return files.filter((file) => file.path !== path)
}

function formatLineCount(lines: string[]): string {
  return String(Math.max(0, lines.length))
}

function renderPreviewLines(lines: string[]): string {
  if (lines.length === 0) return "（空）"
  return lines.slice(0, 120).join("\n")
}

export function SkillBundleMergeEditor({
  open,
  title,
  description,
  baseFiles,
  initialFiles,
  startingFiles,
  confirmLabel = "保存",
  saving = false,
  onOpenChange,
  onConfirm
}: SkillBundleMergeEditorProps): React.JSX.Element {
  const [draftFiles, setDraftFiles] = useState<TextBundleFile[]>([])
  const [selectedPath, setSelectedPath] = useState<string>("")
  const [collapsedBlockIds, setCollapsedBlockIds] = useState<Set<string>>(() => new Set())
  const [error, setError] = useState<string | null>(null)

  const candidateFiles = useMemo(() => sortedFiles(initialFiles), [initialFiles])
  const baseStartFiles = useMemo(
    () => (baseFiles.length > 0 ? sortedFiles(baseFiles) : candidateFiles),
    [baseFiles, candidateFiles]
  )
  const workingStartFiles = useMemo(
    () => (startingFiles ? sortedFiles(startingFiles) : baseStartFiles),
    [baseStartFiles, startingFiles]
  )
  const mergeBlocks = useMemo(
    () => buildMergeBlocks(baseFiles, candidateFiles),
    [baseFiles, candidateFiles]
  )
  const filePaths = useMemo(
    () =>
      Array.from(
        new Set([
          ...baseFiles.map((file) => file.path),
          ...candidateFiles.map((file) => file.path),
          ...draftFiles.map((file) => file.path)
        ])
      ).sort(),
    [baseFiles, candidateFiles, draftFiles]
  )

  useEffect(() => {
    if (!open) return
    const nextPaths = Array.from(
      new Set([...candidateFiles.map((file) => file.path), ...baseFiles.map((file) => file.path)])
    ).sort()
    /* eslint-disable react-hooks/set-state-in-effect */
    setDraftFiles(workingStartFiles)
    setSelectedPath(nextPaths.includes("SKILL.md") ? "SKILL.md" : (nextPaths[0] ?? ""))
    setCollapsedBlockIds(new Set())
    setError(null)
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [baseFiles, candidateFiles, open, workingStartFiles])

  const selectedContent =
    draftFiles.find((file) => file.path === selectedPath)?.content ??
    baseFiles.find((file) => file.path === selectedPath)?.content ??
    ""
  const selectedBlocks = mergeBlocks.filter((block) => block.path === selectedPath)
  const diff = useMemo(() => buildBundleUnifiedDiff(baseFiles, draftFiles), [baseFiles, draftFiles])

  const updateSelectedContent = (content: string): void => {
    if (!selectedPath) return
    setDraftFiles((prev) => upsertDraftFile(prev, selectedPath, content))
  }

  const resetDraft = (): void => {
    const nextPaths = Array.from(
      new Set([...candidateFiles.map((file) => file.path), ...baseFiles.map((file) => file.path)])
    ).sort()
    setDraftFiles(workingStartFiles)
    setSelectedPath(nextPaths.includes(selectedPath) ? selectedPath : (nextPaths[0] ?? ""))
    setError(null)
  }

  const applyBlockChoice = (block: MergeBlock, acceptCandidate: boolean): void => {
    setDraftFiles((prev) => {
      let next = prev

      if (block.kind === "added") {
        next = acceptCandidate
          ? upsertDraftFile(prev, block.path, block.candidateContent)
          : removeDraftFile(prev, block.path)
      } else if (block.kind === "deleted") {
        next = acceptCandidate
          ? removeDraftFile(prev, block.path)
          : upsertDraftFile(prev, block.path, block.baseContent)
      } else {
        const currentContent =
          prev.find((file) => file.path === block.path)?.content ?? block.baseContent
        const content = acceptCandidate
          ? replaceLineBlock(
              currentContent,
              block.oldLines,
              block.newLines,
              currentContent,
              block.contextBefore,
              block.contextAfter,
              block.oldStart
            )
          : replaceLineBlock(
              currentContent,
              block.newLines,
              block.oldLines,
              currentContent,
              block.contextBefore,
              block.contextAfter,
              block.newStart
            )
        next = upsertDraftFile(prev, block.path, content)
      }

      return sortedFiles(next)
    })
  }

  const applyAllBlockChoices = (acceptCandidate: boolean): void => {
    setDraftFiles(sortedFiles(acceptCandidate ? candidateFiles : baseStartFiles))
  }

  const getBlockState = (block: MergeBlock): "accepted" | "rejected" | "edited" => {
    const draftContent = draftFiles.find((file) => file.path === block.path)?.content
    if (block.kind === "added") {
      if (draftContent === undefined) return "rejected"
      return contentHasLineSequence(draftContent, block.newLines) ? "accepted" : "edited"
    }
    if (block.kind === "deleted") {
      if (draftContent === undefined) return "accepted"
      return contentHasLineSequence(draftContent, block.oldLines) ? "rejected" : "accepted"
    }
    if (block.oldLines.length === 0) {
      return contentHasLineSequence(draftContent, block.newLines) ? "accepted" : "rejected"
    }
    if (block.newLines.length === 0) {
      return contentHasLineSequence(draftContent, block.oldLines) ? "rejected" : "accepted"
    }
    const hasNew = contentHasLineSequence(draftContent, block.newLines)
    const hasOld = contentHasLineSequence(draftContent, block.oldLines)
    if (hasNew && !hasOld) return "accepted"
    if (hasOld && !hasNew) return "rejected"
    return "edited"
  }

  const toggleBlockCollapsed = (blockId: string): void => {
    setCollapsedBlockIds((prev) => {
      const next = new Set(prev)
      if (next.has(blockId)) {
        next.delete(blockId)
      } else {
        next.add(blockId)
      }
      return next
    })
  }

  const confirm = async (): Promise<void> => {
    try {
      setError(null)
      await onConfirm(ensureTextBundleEvolverMarker(draftFiles))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-[1180px] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 p-0">
        <DialogHeader className="border-b border-border px-5 py-4">
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>

        <div className="grid min-h-0 grid-cols-[220px_minmax(0,1fr)]">
          <div className="min-h-0 border-r border-border bg-muted/30">
            <div className="border-b border-border px-3 py-2 text-xs font-medium text-muted-foreground">
              文件
            </div>
            <div className="max-h-[64vh] overflow-y-auto p-2">
              {filePaths.map((path) => (
                <button
                  key={path}
                  className={cn(
                    "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-background",
                    selectedPath === path && "bg-background text-foreground shadow-sm"
                  )}
                  onClick={() => setSelectedPath(path)}
                >
                  <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 truncate font-mono">{path}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="grid min-h-0 grid-rows-[minmax(240px,1fr)_minmax(220px,0.85fr)]">
            <div className="min-h-0 border-b border-border">
              <div className="flex h-10 items-center justify-between gap-2 border-b border-border px-3">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 truncate text-xs font-mono text-muted-foreground">
                    {selectedPath || "未选择文件"}
                  </span>
                  {selectedBlocks.length > 0 && (
                    <span className="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground">
                      {selectedBlocks.length} 块
                    </span>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 gap-1 text-xs"
                    onClick={() => applyAllBlockChoices(false)}
                    disabled={saving || mergeBlocks.length === 0}
                  >
                    <X className="size-3.5" />
                    全部保留
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 gap-1 text-xs"
                    onClick={() => applyAllBlockChoices(true)}
                    disabled={saving || mergeBlocks.length === 0}
                  >
                    <Check className="size-3.5" />
                    全部采纳
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 gap-1 text-xs"
                    onClick={resetDraft}
                    disabled={saving}
                  >
                    <RotateCcw className="size-3.5" />
                    重置
                  </Button>
                </div>
              </div>

              <div className="grid h-[calc(100%-40px)] min-h-0 grid-cols-[minmax(0,1fr)_320px]">
                <textarea
                  className="h-full w-full resize-none bg-background p-3 font-mono text-xs leading-5 outline-none"
                  spellCheck={false}
                  value={selectedContent}
                  onChange={(event) => updateSelectedContent(event.target.value)}
                />
                <div className="min-h-0 overflow-y-auto border-l border-border bg-muted/20">
                  <div className="sticky top-0 z-10 border-b border-border bg-background/95 px-3 py-2">
                    <div className="text-xs font-medium text-foreground">变更块</div>
                    <div className="mt-0.5 text-[11px] text-muted-foreground">
                      当前文件 {selectedBlocks.length} 块
                    </div>
                  </div>

                  {selectedBlocks.length === 0 ? (
                    <div className="m-3 rounded border border-dashed border-border px-3 py-8 text-center text-xs text-muted-foreground">
                      当前文件没有候选变更块
                    </div>
                  ) : (
                    <div className="space-y-2 p-2">
                      {selectedBlocks.map((block) => {
                        const state = getBlockState(block)
                        const collapsed = collapsedBlockIds.has(block.id)
                        const acceptLabel =
                          block.kind === "deleted"
                            ? "采纳删除"
                            : block.kind === "added"
                              ? "采纳新增"
                              : "采纳新版"
                        const rejectLabel =
                          block.kind === "deleted"
                            ? "保留文件"
                            : block.kind === "added"
                              ? "不新增"
                              : "保留旧版"

                        return (
                          <div
                            key={block.id}
                            className="overflow-hidden rounded border border-border bg-background"
                          >
                            <div className="border-b border-border bg-muted/30 px-2.5 py-2">
                              <div className="flex items-center justify-between gap-2">
                                <button
                                  type="button"
                                  className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-xs font-medium"
                                  onClick={() => toggleBlockCollapsed(block.id)}
                                >
                                  {collapsed ? (
                                    <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                                  ) : (
                                    <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                                  )}
                                  <span>块 {block.index}</span>
                                  <span className="font-normal text-muted-foreground">
                                    -{formatLineCount(block.oldLines)} +
                                    {formatLineCount(block.newLines)}
                                  </span>
                                </button>
                                <span
                                  className={cn(
                                    "shrink-0 rounded border px-1.5 py-0.5 text-[11px]",
                                    state === "accepted" &&
                                      "border-emerald-200 bg-emerald-50 text-emerald-700",
                                    state === "rejected" &&
                                      "border-amber-200 bg-amber-50 text-amber-700",
                                    state === "edited" && "border-blue-200 bg-blue-50 text-blue-700"
                                  )}
                                >
                                  {state === "accepted"
                                    ? "已采纳"
                                    : state === "rejected"
                                      ? "保留旧版"
                                      : "已编辑"}
                                </span>
                              </div>
                              <div className="mt-2 grid grid-cols-2 gap-1.5">
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-7 gap-1 px-2 text-xs"
                                  onClick={() => applyBlockChoice(block, false)}
                                  disabled={saving}
                                >
                                  <X className="size-3.5" />
                                  {rejectLabel}
                                </Button>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-7 gap-1 px-2 text-xs"
                                  onClick={() => applyBlockChoice(block, true)}
                                  disabled={saving}
                                >
                                  <Check className="size-3.5" />
                                  {acceptLabel}
                                </Button>
                              </div>
                            </div>
                            {!collapsed && (
                              <div className="space-y-1.5 p-2">
                                <div>
                                  <div className="mb-1 text-[11px] text-muted-foreground">旧版</div>
                                  <pre className="max-h-24 overflow-auto rounded bg-red-50/70 p-2 font-mono text-[11px] leading-4 text-red-950">
                                    {renderPreviewLines(block.oldLines)}
                                  </pre>
                                </div>
                                <div>
                                  <div className="mb-1 text-[11px] text-muted-foreground">新版</div>
                                  <pre className="max-h-24 overflow-auto rounded bg-emerald-50/70 p-2 font-mono text-[11px] leading-4 text-emerald-950">
                                    {renderPreviewLines(block.newLines)}
                                  </pre>
                                </div>
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              </div>
            </div>
            <div className="min-h-0 overflow-y-auto bg-background">
              <DiffDisplay diff={diff} />
            </div>
          </div>
        </div>

        <DialogFooter className="border-t border-border px-5 py-3">
          {error && <p className="mr-auto self-center text-xs text-destructive">{error}</p>}
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            取消
          </Button>
          <Button onClick={() => void confirm()} disabled={saving || draftFiles.length === 0}>
            {saving ? (
              <Loader2 className="mr-1.5 size-4 animate-spin" />
            ) : (
              <Save className="mr-1.5 size-4" />
            )}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
