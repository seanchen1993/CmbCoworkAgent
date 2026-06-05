import { useEffect, useMemo, useState } from "react"
import {
  Check,
  ChevronDown,
  ChevronRight,
  FileText,
  GitMerge,
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
  readSkillBundleVersion,
  type TextBundleFile
} from "@/lib/skill-bundle-diff"
import {
  buildFileMergePlans,
  buildMergedFiles,
  defaultDecisions,
  hasConflictMarkers,
  reconstructFile,
  summarizeFile,
  threeWayMergeFile,
  type FileMergePlan,
  type HunkSide,
  type MergeRegion
} from "@/lib/skill-bundle-merge"
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

type ChangeRegion = Extract<MergeRegion, { type: "change" }>

type DecisionMap = Record<string, Record<string, HunkSide>>

function regionLabels(region: ChangeRegion): { accept: string; reject: string } {
  if (region.baseLines.length === 0) return { accept: "采纳新增", reject: "不新增" }
  if (region.candidateLines.length === 0) return { accept: "采纳删除", reject: "保留" }
  return { accept: "采纳新版", reject: "保留旧版" }
}

function renderPreviewLines(lines: string[]): string {
  if (lines.length === 0) return "（空）"
  return lines.slice(0, 120).join("\n")
}

function fileBadge(
  plan: FileMergePlan | undefined,
  decisions: Record<string, HunkSide> | undefined,
  edited: boolean,
  conflict: boolean
): { text: string; tone: "green" | "amber" | "blue" | "muted" | "red" } | null {
  if (conflict) return { text: "冲突", tone: "red" }
  if (edited) return { text: "已编辑", tone: "blue" }
  if (!plan || !plan.hasChange) return { text: "无变更", tone: "muted" }
  const summary = summarizeFile(plan, decisions, false)
  if (summary.accepted === summary.total) return { text: "全采纳", tone: "green" }
  if (summary.accepted === 0) return { text: "全保留", tone: "amber" }
  return { text: `${summary.accepted}/${summary.total}`, tone: "blue" }
}

const TONE_CLASS: Record<string, string> = {
  green: "border-emerald-200 bg-emerald-50 text-emerald-700",
  amber: "border-amber-200 bg-amber-50 text-amber-700",
  blue: "border-blue-200 bg-blue-50 text-blue-700",
  red: "border-red-200 bg-red-50 text-red-700",
  muted: "border-border bg-muted/40 text-muted-foreground"
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
  const [decisions, setDecisions] = useState<DecisionMap>({})
  const [editedContent, setEditedContent] = useState<Record<string, string>>({})
  const [selectedPath, setSelectedPath] = useState<string>("")
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => new Set())
  const [error, setError] = useState<string | null>(null)

  const plans = useMemo(
    () => buildFileMergePlans(baseFiles, initialFiles),
    [baseFiles, initialFiles]
  )
  const planByPath = useMemo(() => new Map(plans.map((plan) => [plan.path, plan])), [plans])
  const baseByPath = useMemo(() => new Map(baseFiles.map((f) => [f.path, f.content])), [baseFiles])
  const candidateByPath = useMemo(
    () => new Map(initialFiles.map((f) => [f.path, f.content])),
    [initialFiles]
  )

  const filePaths = useMemo(() => {
    const set = new Set<string>(plans.map((plan) => plan.path))
    for (const path of Object.keys(editedContent)) set.add(path)
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  }, [plans, editedContent])

  useEffect(() => {
    if (!open) return
    /* eslint-disable react-hooks/set-state-in-effect */
    const nextDecisions: DecisionMap = {}
    for (const plan of plans) nextDecisions[plan.path] = defaultDecisions(plan.regions)

    const nextEdited: Record<string, string> = {}
    if (startingFiles) {
      const savedMap = new Map(startingFiles.map((f) => [f.path, f.content]))
      for (const plan of plans) {
        const saved = savedMap.get(plan.path)
        const fallback = reconstructFile(plan.regions, nextDecisions[plan.path])
        if (saved !== undefined && saved !== fallback) nextEdited[plan.path] = saved
      }
      for (const file of startingFiles) {
        if (!planByPath.has(file.path)) nextEdited[file.path] = file.content
      }
    }

    setDecisions(nextDecisions)
    setEditedContent(nextEdited)
    const candidatePaths = plans.map((plan) => plan.path)
    setSelectedPath(candidatePaths.includes("SKILL.md") ? "SKILL.md" : (candidatePaths[0] ?? ""))
    setCollapsedIds(new Set())
    setError(null)
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [open, plans, planByPath, startingFiles])

  const selectedPlan = planByPath.get(selectedPath)
  const selectedEdited = editedContent[selectedPath]
  const isEdited = selectedEdited !== undefined
  const selectedDecisions = decisions[selectedPath]
  const selectedContent =
    selectedEdited ??
    (selectedPlan
      ? reconstructFile(selectedPlan.regions, selectedDecisions ?? defaultDecisions(selectedPlan.regions))
      : "")
  const changeRegions = useMemo(
    () =>
      (selectedPlan?.regions ?? []).filter(
        (region): region is ChangeRegion => region.type === "change"
      ),
    [selectedPlan]
  )

  const mergedFiles = useMemo(() => {
    const fromPlans = buildMergedFiles(plans, decisions, editedContent)
    const planPaths = new Set(plans.map((plan) => plan.path))
    const extras = Object.entries(editedContent)
      .filter(([path, content]) => !planPaths.has(path) && content !== "")
      .map(([path, content]) => ({ path, content }))
    return [...fromPlans, ...extras].sort((a, b) => a.path.localeCompare(b.path))
  }, [plans, decisions, editedContent])

  const diff = useMemo(() => buildBundleUnifiedDiff(baseFiles, mergedFiles), [baseFiles, mergedFiles])

  const setRegionSide = (path: string, regionId: string, side: HunkSide): void => {
    setDecisions((prev) => ({ ...prev, [path]: { ...(prev[path] ?? {}), [regionId]: side } }))
  }

  const setAllSides = (path: string, side: HunkSide): void => {
    const plan = planByPath.get(path)
    if (!plan) return
    const map: Record<string, HunkSide> = {}
    for (const region of plan.regions) {
      if (region.type === "change") map[region.id] = side
    }
    setDecisions((prev) => ({ ...prev, [path]: map }))
    setEditedContent((prev) => {
      if (prev[path] === undefined) return prev
      const next = { ...prev }
      delete next[path]
      return next
    })
  }

  const resetFile = (path: string): void => {
    const plan = planByPath.get(path)
    setEditedContent((prev) => {
      const next = { ...prev }
      delete next[path]
      return next
    })
    if (plan) {
      setDecisions((prev) => ({ ...prev, [path]: defaultDecisions(plan.regions) }))
    }
    setError(null)
  }

  const editSelectedContent = (content: string): void => {
    if (!selectedPath) return
    setEditedContent((prev) => ({ ...prev, [selectedPath]: content }))
  }

  const runThreeWayMerge = (path: string): void => {
    const plan = planByPath.get(path)
    const base = baseByPath.get(path) ?? ""
    const theirs = candidateByPath.get(path) ?? ""
    const ours =
      editedContent[path] ??
      (plan
        ? reconstructFile(plan.regions, decisions[path] ?? defaultDecisions(plan.regions))
        : "")
    const { content, conflict } = threeWayMergeFile(ours, base, theirs)
    setEditedContent((prev) => ({ ...prev, [path]: content }))
    setError(
      conflict
        ? "三方合并完成，但存在冲突：请在左侧文本中查找 <<<<<<< 标记并手动裁决。"
        : null
    )
  }

  const toggleCollapsed = (regionKey: string): void => {
    setCollapsedIds((prev) => {
      const next = new Set(prev)
      if (next.has(regionKey)) next.delete(regionKey)
      else next.add(regionKey)
      return next
    })
  }

  const confirm = async (): Promise<void> => {
    try {
      setError(null)
      onValidateConflicts(mergedFiles)
      // 版本号由系统托管：始终从「源版本(base)」+1，与写入 evolved-by 标识同处理。
      // 从 base 而非候选当前版本 bump，避免候选已是 source+1 时重复累加。
      const sourceVersion = readSkillBundleVersion(baseFiles)
      await onConfirm(ensureTextBundleEvolverMarker(mergedFiles, sourceVersion))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const conflictFiles = useMemo(
    () => mergedFiles.filter((file) => hasConflictMarkers(file.content)).map((file) => file.path),
    [mergedFiles]
  )

  const selectedHasConflict = conflictFiles.includes(selectedPath)
  const canMergeThreeWay = Boolean(
    selectedPlan && baseByPath.has(selectedPath) && candidateByPath.has(selectedPath)
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-[1180px] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 p-0">
        <DialogHeader className="border-b border-border px-5 py-4">
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>

        <div className="grid min-h-0 grid-cols-[230px_minmax(0,1fr)]">
          <div className="min-h-0 border-r border-border bg-muted/30">
            <div className="border-b border-border px-3 py-2 text-xs font-medium text-muted-foreground">
              文件
            </div>
            <div className="max-h-[64vh] overflow-y-auto p-2">
              {filePaths.map((path) => {
                const badge = fileBadge(
                  planByPath.get(path),
                  decisions[path],
                  editedContent[path] !== undefined,
                  conflictFiles.includes(path)
                )
                return (
                  <button
                    key={path}
                    className={cn(
                      "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-background",
                      selectedPath === path && "bg-background text-foreground shadow-sm"
                    )}
                    onClick={() => setSelectedPath(path)}
                  >
                    <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate font-mono">{path}</span>
                    {badge && (
                      <span
                        className={cn(
                          "shrink-0 rounded border px-1 py-0.5 text-[10px] leading-none",
                          TONE_CLASS[badge.tone]
                        )}
                      >
                        {badge.text}
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          </div>

          <div className="grid min-h-0 grid-rows-[minmax(240px,1fr)_minmax(220px,0.85fr)]">
            <div className="min-h-0 border-b border-border">
              <div className="flex h-10 items-center justify-between gap-2 border-b border-border px-3">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 truncate text-xs font-mono text-muted-foreground">
                    {selectedPath || "未选择文件"}
                  </span>
                  {changeRegions.length > 0 && (
                    <span className="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground">
                      {changeRegions.length} 块
                    </span>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 gap-1 text-xs"
                    onClick={() => setAllSides(selectedPath, "base")}
                    disabled={saving || !selectedPlan?.hasChange}
                  >
                    <X className="size-3.5" />
                    全部保留
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 gap-1 text-xs"
                    onClick={() => setAllSides(selectedPath, "candidate")}
                    disabled={saving || !selectedPlan?.hasChange}
                  >
                    <Check className="size-3.5" />
                    全部采纳
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 gap-1 text-xs"
                    onClick={() => runThreeWayMerge(selectedPath)}
                    disabled={saving || !canMergeThreeWay}
                    title="把候选改动合并进当前草稿（以原版为共同祖先的三方合并）"
                  >
                    <GitMerge className="size-3.5" />
                    三方合并候选
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 gap-1 text-xs"
                    onClick={() => resetFile(selectedPath)}
                    disabled={saving}
                  >
                    <RotateCcw className="size-3.5" />
                    重置该文件
                  </Button>
                </div>
              </div>

              <div className="grid h-[calc(100%-40px)] min-h-0 grid-cols-[minmax(0,1fr)_340px]">
                <div className="flex min-h-0 flex-col">
                  {isEdited && (
                    <div className="flex items-center justify-between gap-2 border-b border-blue-200 bg-blue-50/60 px-3 py-1.5 text-[11px] text-blue-700">
                      <span>该文件已手动编辑，分块选择已停用。</span>
                      <button
                        type="button"
                        className="underline hover:no-underline"
                        onClick={() => resetFile(selectedPath)}
                      >
                        重置该文件
                      </button>
                    </div>
                  )}
                  {selectedHasConflict && (
                    <div className="border-b border-red-200 bg-red-50/70 px-3 py-1.5 text-[11px] text-red-700">
                      存在未解决的合并冲突，请在下方文本中处理 <code>{"<<<<<<<"}</code> /{" "}
                      <code>{"======="}</code> / <code>{">>>>>>>"}</code> 标记。
                    </div>
                  )}
                  <textarea
                    className="min-h-0 flex-1 w-full resize-none bg-background p-3 font-mono text-xs leading-5 outline-none"
                    spellCheck={false}
                    value={selectedContent}
                    onChange={(event) => editSelectedContent(event.target.value)}
                  />
                </div>
                <div className="min-h-0 overflow-y-auto border-l border-border bg-muted/20">
                  <div className="sticky top-0 z-10 border-b border-border bg-background/95 px-3 py-2">
                    <div className="text-xs font-medium text-foreground">变更块</div>
                    <div className="mt-0.5 text-[11px] text-muted-foreground">
                      当前文件 {changeRegions.length} 块
                      {isEdited && " · 已停用（手动编辑中）"}
                    </div>
                  </div>

                  {changeRegions.length === 0 ? (
                    <div className="m-3 rounded border border-dashed border-border px-3 py-8 text-center text-xs text-muted-foreground">
                      当前文件没有候选变更块
                    </div>
                  ) : (
                    <div className={cn("space-y-2 p-2", isEdited && "pointer-events-none opacity-50")}>
                      {changeRegions.map((region, index) => {
                        const regionKey = `${selectedPath}:${region.id}`
                        const side = selectedDecisions?.[region.id] ?? "candidate"
                        const collapsed = collapsedIds.has(regionKey)
                        const labels = regionLabels(region)

                        return (
                          <div
                            key={regionKey}
                            className="overflow-hidden rounded border border-border bg-background"
                          >
                            <div className="border-b border-border bg-muted/30 px-2.5 py-2">
                              <div className="flex items-center justify-between gap-2">
                                <button
                                  type="button"
                                  className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-xs font-medium"
                                  onClick={() => toggleCollapsed(regionKey)}
                                >
                                  {collapsed ? (
                                    <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                                  ) : (
                                    <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                                  )}
                                  <span>块 {index + 1}</span>
                                  <span className="font-normal text-muted-foreground">
                                    -{region.baseLines.length} +{region.candidateLines.length}
                                  </span>
                                </button>
                                <span
                                  className={cn(
                                    "shrink-0 rounded border px-1.5 py-0.5 text-[11px]",
                                    side === "candidate" ? TONE_CLASS.green : TONE_CLASS.amber
                                  )}
                                >
                                  {side === "candidate" ? "已采纳" : "保留旧版"}
                                </span>
                              </div>
                              <div className="mt-2 grid grid-cols-2 gap-1.5">
                                <Button
                                  size="sm"
                                  variant={side === "base" ? "default" : "outline"}
                                  className="h-7 gap-1 px-2 text-xs"
                                  onClick={() => setRegionSide(selectedPath, region.id, "base")}
                                  disabled={saving}
                                >
                                  <X className="size-3.5" />
                                  {labels.reject}
                                </Button>
                                <Button
                                  size="sm"
                                  variant={side === "candidate" ? "default" : "outline"}
                                  className="h-7 gap-1 px-2 text-xs"
                                  onClick={() => setRegionSide(selectedPath, region.id, "candidate")}
                                  disabled={saving}
                                >
                                  <Check className="size-3.5" />
                                  {labels.accept}
                                </Button>
                              </div>
                            </div>
                            {!collapsed && (
                              <div className="space-y-1.5 p-2">
                                <div>
                                  <div className="mb-1 text-[11px] text-muted-foreground">旧版</div>
                                  <pre className="max-h-24 overflow-auto rounded bg-red-50/70 p-2 font-mono text-[11px] leading-4 text-red-950">
                                    {renderPreviewLines(region.baseLines)}
                                  </pre>
                                </div>
                                <div>
                                  <div className="mb-1 text-[11px] text-muted-foreground">新版</div>
                                  <pre className="max-h-24 overflow-auto rounded bg-emerald-50/70 p-2 font-mono text-[11px] leading-4 text-emerald-950">
                                    {renderPreviewLines(region.candidateLines)}
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
          {!error && conflictFiles.length > 0 && (
            <p className="mr-auto self-center text-xs text-red-600">
              {conflictFiles.length} 个文件存在未解决冲突
            </p>
          )}
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            取消
          </Button>
          <Button
            onClick={() => void confirm()}
            disabled={saving || mergedFiles.length === 0 || conflictFiles.length > 0}
          >
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

function onValidateConflicts(files: TextBundleFile[]): void {
  const conflicted = files.filter((file) => hasConflictMarkers(file.content)).map((file) => file.path)
  if (conflicted.length > 0) {
    throw new Error(`存在未解决的合并冲突：${conflicted.join(", ")}`)
  }
}
