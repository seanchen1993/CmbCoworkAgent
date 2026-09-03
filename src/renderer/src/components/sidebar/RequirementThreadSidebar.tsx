import { useEffect, useMemo, useRef, useState } from "react"
import {
  ArrowLeft,
  AlertCircle,
  ChevronDown,
  ChevronRight,
  createLucideIcon,
  GitFork,
  Info,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Pencil
} from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { IconPopoverButton } from "@/components/ui/icon-popover-button"
import { useAppStore } from "@/lib/store"
import { useAllStreamLoadingStates, useAllThreadStates } from "@/lib/thread-context"
import {
  getRequirementThreadIds,
  type RequirementRecord
} from "@/components/requirement/requirement-data"

const ListChevronsUpDown = createLucideIcon("ListChevronsUpDown", [
  ["path", { d: "M4 6h10", key: "line-1" }],
  ["path", { d: "M4 12h10", key: "line-2" }],
  ["path", { d: "M4 18h10", key: "line-3" }],
  ["path", { d: "m17 8 2-2 2 2", key: "up" }],
  ["path", { d: "m17 16 2 2 2-2", key: "down" }]
])

const ListChevronsDownUp = createLucideIcon("ListChevronsDownUp", [
  ["path", { d: "M4 6h10", key: "line-1" }],
  ["path", { d: "M4 12h10", key: "line-2" }],
  ["path", { d: "M4 18h10", key: "line-3" }],
  ["path", { d: "m17 6 2 2 2-2", key: "down" }],
  ["path", { d: "m17 18 2-2 2 2", key: "up" }]
])

export type RequirementSidebarMode = {
  requirements: RequirementRecord[]
  onSelectRequirement: (requirement: RequirementRecord, threadId?: string) => Promise<void>
  onCreateConversation: (requirement: RequirementRecord) => Promise<void>
  onAttachConversation: (
    requirement: RequirementRecord,
    threadId: string
  ) => Promise<RequirementRecord>
  onDeleteConversation: (requirement: RequirementRecord, threadId: string) => Promise<void>
  onDeleteAllConversations: (requirement: RequirementRecord, threadIds: string[]) => Promise<void>
  onDeleteRequirement: (requirement: RequirementRecord) => Promise<void>
  onRenameRequirement: (requirement: RequirementRecord, title: string) => Promise<void>
  onRefreshRequirementStatus: (requirement: RequirementRecord) => Promise<boolean>
  onNewRequirement?: () => void
  onBackToHistory?: () => void
}

type RequirementThreadSidebarProps = { mode: RequirementSidebarMode }

let requirementSidebarScrollTop = 0

function rememberRequirementSidebarScrollTop(viewport: HTMLElement): void {
  requirementSidebarScrollTop = viewport.scrollTop
}

function displayTitle(title: string | null | undefined, id: string): string {
  const value = title?.trim()
  return value && value !== "..." && value !== "…" ? value : id.slice(0, 20)
}

function formatCompactTime(date: Date | string): string {
  const value = typeof date === "string" ? new Date(date) : date
  if (Number.isNaN(value.getTime())) return ""
  const now = new Date()
  const diff = Math.max(0, now.getTime() - value.getTime())
  const minutes = Math.floor(diff / 60000)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  if (minutes < 1) return "刚刚"
  if (minutes < 60) return `${minutes}分钟`
  if (hours < 24) return `${hours}小时`
  if (days < 7) return `${days}天`
  const month = value.getMonth() + 1
  const day = value.getDate()
  if (value.getFullYear() === now.getFullYear()) return `${month}/${day}`
  return `${String(value.getFullYear()).slice(2)}/${month}/${day}`
}

function getStatusPresentation(status: string): {
  tagClass: string
  dotClass: string
  showDot: boolean
} {
  if (status.includes("异常")) {
    return {
      tagClass: "border-status-critical/20 bg-status-critical/5 text-status-critical/85",
      dotClass: "bg-status-critical/60",
      showDot: true
    }
  }
  if (status.includes("沟通")) {
    return {
      tagClass: "border-status-info/20 bg-status-info/5 text-status-info/85",
      dotClass: "bg-muted-foreground/35",
      showDot: false
    }
  }
  if (status.includes("发布") || status.includes("交付")) {
    return {
      tagClass: "border-status-nominal/20 bg-status-nominal/5 text-status-nominal/85",
      dotClass: "bg-status-nominal/60",
      showDot: true
    }
  }
  if (status.includes("生成") || status.includes("规范")) {
    return {
      tagClass: "border-primary/20 bg-primary/5 text-primary/85",
      dotClass: "bg-primary/60",
      showDot: true
    }
  }
  return {
    tagClass: "border-border/50 bg-muted/20 text-muted-foreground",
    dotClass: "bg-muted-foreground/35",
    showDot: true
  }
}

function getSourceTypeLabel(sourceType: RequirementRecord["sourceType"]): string {
  if (sourceType === "file") return "文件"
  if (sourceType === "link") return "链接"
  return "文本描述"
}

function getSourceNameLabel(requirement: RequirementRecord): string {
  const sourceName = requirement.sourceName.trim()
  if (!sourceName) return getSourceTypeLabel(requirement.sourceType)
  if (sourceName === "file" || sourceName === "文件") return "文件"
  if (sourceName === "link" || sourceName === "链接") return "链接"
  if (sourceName === "text" || sourceName === "文本") return "文本描述"
  return sourceName
}

function getPrdModuleSummary(requirement: RequirementRecord): string {
  if (requirement.status !== "已生成" && requirement.status !== "已发布") return "待生成"
  return `${requirement.prdManifest.functions.length} 个功能模块`
}

function getPrdStatusLabel(status: string): string {
  return status.includes("发布") ? "已发布到需求空间3.0" : status || "未设置"
}

function ThreadStatusIcon({
  isLoading,
  pendingApproval,
  scheduledTaskLoading
}: {
  isLoading: boolean
  pendingApproval: boolean
  scheduledTaskLoading: boolean
}): React.JSX.Element | null {
  if (isLoading || scheduledTaskLoading) {
    return <Loader2 className="size-3.5 shrink-0 animate-spin text-status-info" />
  }
  if (pendingApproval) {
    return <AlertCircle className="size-3.5 shrink-0 text-status-warning" />
  }
  return null
}

export function RequirementThreadSidebar({
  mode
}: RequirementThreadSidebarProps): React.JSX.Element {
  const threads = useAppStore((state) => state.threads)
  const currentThreadId = useAppStore((state) => state.currentThreadId)
  const deleteThread = useAppStore((state) => state.deleteThread)
  const forkThread = useAppStore((state) => state.forkThread)
  const updateThread = useAppStore((state) => state.updateThread)
  const allThreadStates = useAllThreadStates()
  const allStreamLoadingStates = useAllStreamLoadingStates()
  const [query, setQuery] = useState("")
  const [expanded, setExpanded] = useState<Set<string>>(
    new Set(mode.requirements.map((item) => item.id))
  )
  const [renameTarget, setRenameTarget] = useState<RequirementRecord | null>(null)
  const [renameValue, setRenameValue] = useState("")
  const [editingThreadId, setEditingThreadId] = useState<string | null>(null)
  const [editingThreadTitle, setEditingThreadTitle] = useState("")
  const [deleteTarget, setDeleteTarget] = useState<{
    requirement: RequirementRecord
    threadId?: string
  } | null>(null)
  const [hoveredRequirementId, setHoveredRequirementId] = useState<string | null>(null)
  const [refreshingRequirementId, setRefreshingRequirementId] = useState<string | null>(null)
  const scrollAreaRef = useRef<HTMLDivElement>(null)
  const initialTargetThreadIdRef = useRef(currentThreadId)
  const initialTargetScrolledRef = useRef(false)
  const hoverCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const showRequirementInfo = (id: string): void => {
    if (hoverCloseTimerRef.current) clearTimeout(hoverCloseTimerRef.current)
    setHoveredRequirementId(id)
  }
  const hideRequirementInfo = (): void => {
    if (hoverCloseTimerRef.current) clearTimeout(hoverCloseTimerRef.current)
    hoverCloseTimerRef.current = setTimeout(() => setHoveredRequirementId(null), 320)
  }

  const requirementIdByThreadId = useMemo(() => {
    const result = new Map<string, string>()
    for (const requirement of mode.requirements) {
      for (const threadId of getRequirementThreadIds(requirement)) result.set(threadId, requirement.id)
    }
    return result
  }, [mode.requirements])
  const grouped = useMemo(() => {
    const requirementById = new Map(mode.requirements.map((requirement) => [requirement.id, requirement]))
    const byRequirement = new Map<string, typeof threads>()
    for (const thread of threads) {
      const metadataId =
        typeof thread.metadata?.requirementId === "string" ? thread.metadata.requirementId : ""
      const requirementId = metadataId || requirementIdByThreadId.get(thread.thread_id) || ""
      if (!requirementById.has(requirementId)) continue
      const list = byRequirement.get(requirementId) ?? []
      list.push(thread)
      byRequirement.set(requirementId, list)
    }
    return mode.requirements
      .filter((item) => {
        const normalized = query.trim().toLocaleLowerCase()
        return (
          !normalized ||
          `${item.title} ${item.system} ${item.id}`.toLocaleLowerCase().includes(normalized)
        )
      })
      .map((requirement) => ({ requirement, threads: byRequirement.get(requirement.id) ?? [] }))
  }, [mode.requirements, query, requirementIdByThreadId, threads])

  const toggle = (id: string): void => {
    setExpanded((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const allRequirementsExpanded =
    mode.requirements.length > 0 &&
    mode.requirements.every((requirement) => expanded.has(requirement.id))

  const toggleAllRequirements = (): void => {
    setExpanded(
      allRequirementsExpanded
        ? new Set()
        : new Set(mode.requirements.map((requirement) => requirement.id))
    )
  }

  const createConversation = async (requirement: RequirementRecord): Promise<void> => {
    try {
      await mode.onCreateConversation(requirement)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "新建会话失败")
    }
  }

  const deleteRequirement = async (requirement: RequirementRecord): Promise<void> => {
    try {
      await mode.onDeleteRequirement(requirement)
      setHoveredRequirementId(null)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "删除需求失败")
    }
  }

  const refreshRequirementStatus = async (requirement: RequirementRecord): Promise<void> => {
    setRefreshingRequirementId(requirement.id)
    try {
      if (await mode.onRefreshRequirementStatus(requirement)) {
        toast.success("需求状态已刷新")
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "刷新需求状态失败")
    } finally {
      setRefreshingRequirementId(null)
    }
  }

  const confirmDelete = async (): Promise<void> => {
    if (!deleteTarget) return
    const { requirement, threadId } = deleteTarget
    try {
      if (threadId) {
        await mode.onDeleteConversation(requirement, threadId)
        await deleteThread(threadId)
      } else {
        const ids = getRequirementThreadIds(requirement)
        await mode.onDeleteAllConversations(requirement, ids)
      }
      setDeleteTarget(null)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "删除会话失败")
    }
  }

  const fork = async (requirement: RequirementRecord, threadId: string): Promise<void> => {
    try {
      const forked = await forkThread({ sourceThreadId: threadId }, { preserveView: true })
      const updated = await mode.onAttachConversation(requirement, forked.thread_id)
      await mode.onSelectRequirement(updated, forked.thread_id)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Fork 会话失败")
    }
  }

  const saveThreadTitle = async (): Promise<void> => {
    const threadId = editingThreadId
    const title = editingThreadTitle.trim()
    setEditingThreadId(null)
    setEditingThreadTitle("")
    if (!threadId || !title) return
    try {
      await updateThread(threadId, { title })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "重命名会话失败")
    }
  }

  const rememberScrollPosition = (): void => {
    const viewport = scrollAreaRef.current?.querySelector<HTMLElement>(
      "[data-radix-scroll-area-viewport]"
    )
    if (viewport) rememberRequirementSidebarScrollTop(viewport)
  }

  const restoreScrollPosition = (): void => {
    requestAnimationFrame(() => {
      const viewport = scrollAreaRef.current?.querySelector<HTMLElement>(
        "[data-radix-scroll-area-viewport]"
      )
      if (viewport) viewport.scrollTop = requirementSidebarScrollTop
    })
  }

  const selectConversation = async (
    requirement: RequirementRecord,
    threadId: string
  ): Promise<void> => {
    rememberScrollPosition()
    await mode.onSelectRequirement(requirement, threadId)
    restoreScrollPosition()
  }

  useEffect(() => {
    const viewport = scrollAreaRef.current?.querySelector<HTMLElement>(
      "[data-radix-scroll-area-viewport]"
    )
    if (!viewport) return
    const restoreFrame = requestAnimationFrame(() => {
      viewport.scrollTop = requirementSidebarScrollTop
    })
    const recordScrollPosition = (): void => {
      rememberRequirementSidebarScrollTop(viewport)
    }
    viewport.addEventListener("scroll", recordScrollPosition, { passive: true })
    return () => {
      cancelAnimationFrame(restoreFrame)
      viewport.removeEventListener("scroll", recordScrollPosition)
    }
  }, [])

  useEffect(() => {
    if (initialTargetScrolledRef.current) return
    const targetThreadId = initialTargetThreadIdRef.current ?? currentThreadId
    if (!targetThreadId) return

    const target = Array.from(
      scrollAreaRef.current?.querySelectorAll<HTMLElement>("[data-requirement-thread-id]") ?? []
    ).find((element) => element.dataset.requirementThreadId === targetThreadId)
    if (!target) return

    initialTargetScrolledRef.current = true
    requestAnimationFrame(() => {
      target.scrollIntoView({ block: "center", behavior: "auto" })
    })
  }, [currentThreadId, grouped])

  return (
    <aside className="flex min-h-0 flex-1 flex-col overflow-hidden bg-sidebar">
      <div className="flex h-[37px] shrink-0 items-center gap-1 border-b border-border/80 bg-[#fffdf9] px-2">
        <IconPopoverButton
          icon={<ArrowLeft className="size-4" />}
          popoverContent="返回需求历史列表"
          side="bottom"
          align="start"
          sideOffset={4}
          className="size-7"
          onClick={mode.onBackToHistory}
          aria-label="返回需求历史列表"
        />
        <span className="min-w-0 flex-1 truncate px-1 text-sm font-semibold">需求列表</span>
        <IconPopoverButton
          icon={
            allRequirementsExpanded ? (
              <ListChevronsDownUp className="size-4" />
            ) : (
              <ListChevronsUpDown className="size-4" />
            )
          }
          popoverContent={allRequirementsExpanded ? "收起全部需求" : "展开全部需求"}
          className="size-7"
          onClick={toggleAllRequirements}
          aria-label={allRequirementsExpanded ? "收起全部需求" : "展开全部需求"}
        />
        <IconPopoverButton
          icon={<Plus className="size-4" />}
          popoverContent="新建需求"
          className="size-7"
          onClick={mode.onNewRequirement}
          aria-label="新建需求"
        />
      </div>
      <div className="border-b border-border/70 p-2">
        <label className="relative block">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索需求名称"
            aria-label="搜索需求名称"
            className="h-8 pl-8 text-xs"
          />
        </label>
      </div>
      <ScrollArea ref={scrollAreaRef} className="min-h-0 flex-1">
        <div className="space-y-1 p-2">
          {grouped.map(({ requirement, threads: requirementThreads }) => {
            const isExpanded = expanded.has(requirement.id)
            return (
              <div key={requirement.id} className="rounded-sm">
                <Popover modal={false} open={hoveredRequirementId === requirement.id}>
                  <PopoverAnchor asChild>
                    <div className="group flex min-w-0 items-center gap-1 rounded-sm px-2 py-1.5 hover:bg-sidebar-accent/40 focus-within:bg-sidebar-accent/40">
                      <button
                        type="button"
                        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                        onClick={() => toggle(requirement.id)}
                      >
                        {isExpanded ? (
                          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                        ) : (
                          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                        )}
                        <span
                          className="min-w-0 flex-1 truncate text-xs font-medium"
                          onPointerEnter={() => showRequirementInfo(requirement.id)}
                          onPointerLeave={hideRequirementInfo}
                        >
                          {requirement.title}
                        </span>
                        {getStatusPresentation(requirement.status).showDot ? (
                          <span
                            role="img"
                            className={`size-2 shrink-0 rounded-full ${getStatusPresentation(requirement.status).dotClass}`}
                            title={getPrdStatusLabel(requirement.status)}
                            aria-label={`状态：${getPrdStatusLabel(requirement.status)}`}
                          />
                        ) : null}
                      </button>
                      <span className="relative flex h-6 w-0 shrink-0 items-center justify-end overflow-hidden transition-[width] duration-150 group-hover:w-[4.5rem] group-focus-within:w-[4.5rem]">
                        <span className="pointer-events-none absolute right-0 flex items-center justify-end gap-0.5 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
                          <IconPopoverButton
                            icon={<Plus className="size-3" />}
                            popoverContent="新建会话"
                            className="size-6 shrink-0 rounded-sm p-0 hover:bg-accent/20"
                            onClick={() => void createConversation(requirement)}
                            aria-label="新建会话"
                            stopPropagation
                          />
                          <IconPopoverButton
                            icon={<Pencil className="size-3" />}
                            popoverContent="修改需求名称"
                            className="size-6 shrink-0 rounded-sm p-0 hover:bg-accent/20"
                            onClick={() => {
                              setRenameTarget(requirement)
                              setRenameValue(requirement.title)
                            }}
                            aria-label="修改需求名称"
                            stopPropagation
                          />
                          <IconPopoverButton
                            icon={<Trash2 className="size-3" />}
                            popoverContent={
                              <div className="flex flex-col gap-1">
                                <button
                                  type="button"
                                  className="rounded px-2 py-1 text-left hover:bg-muted"
                                  onClick={() => setDeleteTarget({ requirement })}
                                >
                                  只删除会话
                                </button>
                                <button
                                  type="button"
                                  className="rounded px-2 py-1 text-left text-destructive hover:bg-muted"
                                  onClick={() => {
                                    void deleteRequirement(requirement)
                                  }}
                                >
                                  删除需求和会话
                                </button>
                              </div>
                            }
                            className="size-6 shrink-0 rounded-sm p-0 hover:bg-destructive/10 hover:text-destructive"
                            aria-label="删除需求"
                            stopPropagation
                          />
                        </span>
                      </span>
                    </div>
                  </PopoverAnchor>
                  <PopoverContent
                    side="right"
                    align="start"
                    sideOffset={0}
                    className="w-[22rem] overflow-hidden rounded-xl border-border/80 bg-popover p-0 text-xs shadow-xl"
                    onPointerEnter={() => showRequirementInfo(requirement.id)}
                    onPointerLeave={hideRequirementInfo}
                  >
                    <div className="border-b border-border/70 bg-muted/20 px-4 py-3">
                      <div className="flex items-start gap-2.5">
                        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                          <Info className="size-3.5" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="mb-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                            需求信息
                          </div>
                          <div className="flex min-w-0 items-center gap-2">
                            <div className="min-w-0 flex-1 break-words text-sm font-semibold leading-5 text-foreground">
                              {requirement.title}
                            </div>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="h-7 shrink-0 gap-1.5 px-2 text-[11px]"
                              disabled={refreshingRequirementId === requirement.id}
                              onClick={() => void refreshRequirementStatus(requirement)}
                            >
                              <RefreshCw
                                className={`size-3 ${refreshingRequirementId === requirement.id ? "animate-spin" : ""}`}
                              />
                              刷新状态
                            </Button>
                          </div>
                        </div>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-2 px-4 py-3">
                      {[
                        ["系统", requirement.system || "未设置"],
                        ["规范化PRD-状态", getPrdStatusLabel(requirement.status)],
                        ["PRD功能模块", getPrdModuleSummary(requirement)],
                        ["会话", `${requirementThreads.length} 个会话`]
                      ].map(([label, value]) => (
                        <div
                          key={label}
                          className="rounded-md border border-border/60 bg-muted/15 px-2.5 py-2"
                        >
                          <div className="text-[10px] text-muted-foreground">{label}</div>
                          {label === "规范化PRD-状态" ? (
                            <span
                              className={`mt-1 inline-flex max-w-full truncate rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${getStatusPresentation(requirement.status).tagClass}`}
                              title={value}
                            >
                              {value}
                            </span>
                          ) : (
                            <div
                              className="mt-0.5 truncate font-medium text-foreground"
                              title={value}
                            >
                              {value}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                    <dl className="grid grid-cols-[64px_minmax(0,1fr)] gap-x-3 gap-y-2 border-t border-border/60 px-4 py-3 text-muted-foreground">
                      <dt>来源</dt>
                      <dd className="break-words text-foreground">
                        {getSourceNameLabel(requirement)}
                      </dd>
                      <dt>来源类型</dt>
                      <dd className="text-foreground">
                        {getSourceTypeLabel(requirement.sourceType)}
                      </dd>
                      {requirement.link ? (
                        <>
                          <dt>来源链接</dt>
                          <dd className="break-all text-foreground">{requirement.link}</dd>
                        </>
                      ) : null}
                      <dt>归档路径</dt>
                      <dd className="break-all text-foreground">
                        {requirement.requirementPath || "未设置"}
                      </dd>
                      <dt>更新时间</dt>
                      <dd className="text-foreground">
                        {requirement.updatedAt
                          ? formatCompactTime(requirement.updatedAt)
                          : "未设置"}
                      </dd>
                      <dt>需求 ID</dt>
                      <dd className="break-all font-mono text-[10px] text-foreground">
                        {requirement.id}
                      </dd>
                      {requirement.initialDescription ? (
                        <>
                          <dt>初始描述</dt>
                          <dd className="whitespace-pre-wrap break-words text-foreground">
                            {requirement.initialDescription}
                          </dd>
                        </>
                      ) : null}
                    </dl>
                  </PopoverContent>
                </Popover>
                {isExpanded && (
                  <div className="ml-4 space-y-0.5 border-l border-border/70 pl-2">
                    {requirementThreads.map((thread) => {
                      const threadState = allThreadStates[thread.thread_id]
                      const hasRunningCoordinatorWorker = Boolean(
                        threadState?.coordinatorWorkers.some(
                          (worker) => worker.status === "running"
                        )
                      )
                      const isLoading =
                        (allStreamLoadingStates[thread.thread_id] ?? false) ||
                        hasRunningCoordinatorWorker ||
                        threadState?.workflowRun?.status === "running"
                      const scheduledTaskLoading = Boolean(threadState?.scheduledTaskLoading)
                      const hasPendingApproval = Boolean(threadState?.pendingApproval)
                      const hasPendingUserInput = Boolean(threadState?.pendingUserInput)
                      const hasContextReminder = Boolean(threadState?.contextReminder?.pending)

                      return (
                        <div
                          key={thread.thread_id}
                          data-requirement-thread-id={thread.thread_id}
                          className={`group relative flex items-center gap-1 rounded-sm px-2 py-1.5 text-xs ${currentThreadId === thread.thread_id ? "bg-sidebar-accent text-sidebar-accent-foreground" : "hover:bg-sidebar-accent/40 focus-within:bg-sidebar-accent/40"}`}
                        >
                          <ThreadStatusIcon
                            isLoading={isLoading}
                            pendingApproval={hasPendingApproval}
                            scheduledTaskLoading={scheduledTaskLoading}
                          />
                          {editingThreadId === thread.thread_id ? (
                            <input
                              type="text"
                              value={editingThreadTitle}
                              onChange={(event) => setEditingThreadTitle(event.target.value)}
                              onBlur={() => void saveThreadTitle()}
                              onKeyDown={(event) => {
                                if (event.key === "Enter") void saveThreadTitle()
                                if (event.key === "Escape") {
                                  setEditingThreadId(null)
                                  setEditingThreadTitle("")
                                }
                              }}
                              className="h-7 w-full min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-sm outline-none focus:ring-1 focus:ring-ring"
                              autoFocus
                              onClick={(event) => event.stopPropagation()}
                            />
                          ) : (
                            <button
                              type="button"
                              className="flex min-w-0 flex-1 items-center truncate text-left"
                              onPointerDown={rememberScrollPosition}
                              onClick={() => void selectConversation(requirement, thread.thread_id)}
                              title={thread.title || thread.thread_id}
                            >
                              <span className="min-w-0 flex-1 truncate">
                                {displayTitle(thread.title, thread.thread_id)}
                              </span>
                              {hasPendingUserInput ? (
                                <span className="ml-1 shrink-0 rounded-sm border border-status-warning/45 bg-status-warning/10 px-1.5 py-px text-[10px] leading-none text-status-warning">
                                  等待用户回复
                                </span>
                              ) : null}
                            </button>
                          )}
                          {editingThreadId !== thread.thread_id && (
                            <>
                              <span className="relative ml-auto flex h-6 w-12 shrink-0 items-center justify-end overflow-hidden transition-[width] duration-150 group-hover:w-0 group-focus-within:w-0">
                                <span className="absolute right-0 text-[10px] text-muted-foreground transition-opacity group-hover:opacity-0 group-focus-within:opacity-0">
                                  {formatCompactTime(thread.updated_at)}
                                </span>
                              </span>
                              {hasContextReminder && !isLoading ? (
                                <span
                                  className="size-2 shrink-0 rounded-full bg-status-warning"
                                  title="有待处理提醒"
                                  aria-label="有待处理提醒"
                                />
                              ) : null}
                              <span className="relative flex h-6 w-0 shrink-0 items-center justify-end overflow-hidden transition-[width] duration-150 group-hover:w-[4.5rem] group-focus-within:w-[4.5rem]">
                                <span className="pointer-events-none absolute right-0 flex items-center justify-end gap-0.5 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
                                  <IconPopoverButton
                                    icon={<Pencil className="size-3" />}
                                    popoverContent="重命名会话"
                                    className="size-6 shrink-0 rounded-sm p-0 hover:bg-accent/20"
                                    onClick={() => {
                                      setEditingThreadId(thread.thread_id)
                                      setEditingThreadTitle(thread.title || "")
                                    }}
                                    aria-label="重命名会话"
                                    stopPropagation
                                  />
                                  <IconPopoverButton
                                    icon={<GitFork className="size-3" />}
                                    popoverContent="Fork 会话"
                                    className="size-6 shrink-0 rounded-sm p-0 hover:bg-accent/20"
                                    onClick={() => void fork(requirement, thread.thread_id)}
                                    aria-label="Fork 会话"
                                    stopPropagation
                                  />
                                  <IconPopoverButton
                                    icon={<Trash2 className="size-3" />}
                                    popoverContent="删除会话"
                                    className="size-6 shrink-0 rounded-sm p-0 hover:bg-destructive/10 hover:text-destructive"
                                    onClick={() =>
                                      setDeleteTarget({ requirement, threadId: thread.thread_id })
                                    }
                                    aria-label="删除会话"
                                    stopPropagation
                                  />
                                </span>
                              </span>
                            </>
                          )}
                        </div>
                      )
                    })}
                    {requirementThreads.length === 0 && (
                      <div className="px-2 py-2 text-xs text-muted-foreground">暂无会话</div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
          {grouped.length === 0 && (
            <div className="px-3 py-8 text-center text-xs text-muted-foreground">暂无匹配需求</div>
          )}
        </div>
      </ScrollArea>
      <Dialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {deleteTarget?.threadId ? "确认删除会话" : "确认删除全部会话"}
            </DialogTitle>
            <DialogDescription>
              {deleteTarget?.threadId
                ? "删除后不可恢复，需求索引也会同步更新。"
                : `将删除该需求下的 ${deleteTarget ? getRequirementThreadIds(deleteTarget.requirement).length : 0} 个会话。`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              取消
            </Button>
            <Button variant="destructive" onClick={() => void confirmDelete()}>
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={!!renameTarget} onOpenChange={(open) => !open && setRenameTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>修改需求名称</DialogTitle>
            <DialogDescription>名称会同步保存到需求索引。</DialogDescription>
          </DialogHeader>
          <Input
            value={renameValue}
            onChange={(event) => setRenameValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && renameTarget) {
                void mode
                  .onRenameRequirement(renameTarget, renameValue)
                  .then(() => setRenameTarget(null))
                  .catch((error) =>
                    toast.error(error instanceof Error ? error.message : "重命名需求失败")
                  )
              }
            }}
            autoFocus
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameTarget(null)}>
              取消
            </Button>
            <Button
              onClick={() => {
                if (!renameTarget) return
                void mode
                  .onRenameRequirement(renameTarget, renameValue)
                  .then(() => setRenameTarget(null))
                  .catch((error) =>
                    toast.error(error instanceof Error ? error.message : "重命名需求失败")
                  )
              }}
            >
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </aside>
  )
}
