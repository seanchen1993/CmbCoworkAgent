import { useEffect, useMemo, useRef, useState } from "react"
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Edit,
  FileText,
  FolderOpen,
  Link2,
  Loader2,
  Trash2,
  X
} from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { IconPopoverButton } from "@/components/ui/icon-popover-button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import {
  getRequirementThreadIds,
  getRequirementModules,
  isRequirementGenerated,
  isRequirementPublished,
  type RequirementRecord
} from "./requirement-data"
import { filterRequirementsBySystem } from "./requirement-history-filter"

const PAGE_SIZE = 10
const HISTORY_GRID_COLUMNS =
  "grid-cols-[88px_minmax(120px,1.12fr)_70px_minmax(160px,1.45fr)_minmax(130px,1.1fr)_120px_minmax(120px,1.15fr)_100px_120px_110px]"
const SELECTION_HISTORY_GRID_COLUMNS =
  "grid-cols-[32px_88px_minmax(120px,1.12fr)_70px_minmax(160px,1.45fr)_minmax(130px,1.1fr)_120px_minmax(120px,1.15fr)_100px_120px_110px]"

const SYSTEM_COLOR_OPTIONS = [
  { text: "#9b4b3a", background: "#fcebe5" },
  { text: "#2f6f8d", background: "#e5f2f7" },
  { text: "#5f6f35", background: "#edf3dd" },
  { text: "#7b569b", background: "#f1e9f8" },
  { text: "#9a6a25", background: "#fbf1d9" },
  { text: "#3e7662", background: "#e3f3ec" },
  { text: "#a65368", background: "#f9e7ec" },
  { text: "#4e638f", background: "#e8edf8" }
] as const

function getSystemColor(systemId: string): (typeof SYSTEM_COLOR_OPTIONS)[number] {
  let hash = 0
  for (let index = 0; index < systemId.length; index += 1) {
    hash = (hash * 31 + systemId.charCodeAt(index)) | 0
  }
  return SYSTEM_COLOR_OPTIONS[Math.abs(hash) % SYSTEM_COLOR_OPTIONS.length]
}

function getStatusLabel(status: string): string {
  if (status.includes("沟通")) return "沟通中"
  if (status.includes("发布")) return "已发布"
  if (status.includes("交付")) return "已交付"
  if (status.includes("生成")) return "已规范"
  return status
}

function getStatusClass(status: string): string {
  if (status.includes("异常")) return "bg-status-critical/10 text-status-critical"
  if (status.includes("沟通")) return "bg-[#fff0e9] text-[#a65a3e]"
  if (status.includes("发布")) return "bg-status-warning/10 text-status-warning"
  if (status.includes("交付")) return "bg-[#e9f2ec] text-[#44715a]"
  return "bg-[#a4e6a27a] text-[#1b7e30]"
}

function RequirementSystem({
  systemId,
  name
}: {
  systemId: string
  name: string
}): React.JSX.Element {
  const color = getSystemColor(systemId)
  return (
    <span
      className="flex min-w-0 items-center gap-2 truncate rounded-[7px] px-1.5 py-1 font-semibold"
      style={{ backgroundColor: color.background, color: color.text }}
      title={name}
    >
      <span className="flex size-5 shrink-0 items-center justify-center rounded-[5px] bg-white/70 text-[11px] font-bold">
        {name.slice(0, 1)}
      </span>
      <span className="min-w-0 truncate">{name}</span>
    </span>
  )
}

function getSourceType(item: RequirementRecord): "file" | "text" | "link" {
  return item.sourceType ?? (item.fileName ? "file" : item.initialDescription ? "text" : "link")
}

function getLegacyLabel(item: RequirementRecord): string {
  if (getSourceType(item) === "text") return "描述"
  return getSourceType(item) === "file" ? "文件" : "链接"
}

function getLegacyValue(item: RequirementRecord): string {
  if (getSourceType(item) === "text") return item.initialDescription || "—"
  return item.sourceName || (getSourceType(item) === "file" ? item.fileName : item.link) || "—"
}

function RequirementWorkDir({
  path,
  missing
}: {
  path: string
  missing?: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearCloseTimer = (): void => {
    if (!closeTimerRef.current) return
    clearTimeout(closeTimerRef.current)
    closeTimerRef.current = null
  }

  const showPopover = (): void => {
    clearCloseTimer()
    setOpen(true)
  }

  const hidePopover = (): void => {
    clearCloseTimer()
    closeTimerRef.current = setTimeout(() => {
      setOpen(false)
      closeTimerRef.current = null
    }, 80)
  }

  useEffect(() => clearCloseTimer, [])

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) setOpen(false)
      }}
    >
      <PopoverTrigger asChild>
        <span
          tabIndex={0}
          role="button"
          onPointerEnter={showPopover}
          onPointerLeave={hidePopover}
          onFocus={showPopover}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              hidePopover()
            }
          }}
          className={cn(
            "min-w-0 cursor-help truncate font-mono text-[11px] outline-none focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-[#c26b4f]/45",
            missing ? "text-[#a65a3e]" : path ? "text-[#74695f]" : "text-[#a59a8f]"
          )}
          aria-label={path ? `工作目录：${path}` : "未关联工作目录"}
        >
          {path || "—"}
        </span>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={6}
        className="w-auto max-w-[360px] p-2.5 text-sm"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onPointerEnter={showPopover}
        onPointerLeave={hidePopover}
      >
        <div className="mb-1 font-semibold text-[#74695f]">工作目录</div>
        <div className="break-all font-mono text-[11.5px] leading-4 text-[#302a25]">
          {path || "未关联工作目录"}
        </div>
        {missing ? <div className="mt-1 text-[11px] text-[#a65a3e]">工作目录已删除</div> : null}
      </PopoverContent>
    </Popover>
  )
}

function SelectionCheckbox({
  checked,
  indeterminate = false,
  onChange,
  ariaLabel
}: {
  checked: boolean
  indeterminate?: boolean
  onChange: () => void
  ariaLabel: string
}): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (inputRef.current) inputRef.current.indeterminate = indeterminate
  }, [indeterminate])

  return (
    <input
      ref={inputRef}
      type="checkbox"
      checked={checked}
      onChange={onChange}
      aria-label={ariaLabel}
      className="size-4 cursor-pointer rounded border-[#cfc3b7] accent-[#c26b4f] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#c26b4f]/45"
    />
  )
}

export function RequirementHistoryList({
  requirements,
  query,
  systemId,
  onOpen,
  onDelete,
  selectionMode,
  onSelectionModeChange
}: {
  requirements: RequirementRecord[]
  query: string
  systemId: string | null
  onOpen: (requirement: RequirementRecord) => void
  onDelete: (requirement: RequirementRecord) => Promise<void>
  selectionMode: boolean
  onSelectionModeChange: (enabled: boolean) => void
}): React.JSX.Element {
  const filterKey = `${systemId ?? "all"}\u0000${query}`
  const [pageState, setPageState] = useState({ filterKey: "", page: 1 })
  const [requirementsToDelete, setRequirementsToDelete] = useState<RequirementRecord[]>([])
  const [requirementToOpen, setRequirementToOpen] = useState<RequirementRecord | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [openingWorkDirId, setOpeningWorkDirId] = useState<string | null>(null)
  const [expandedRequirementIds, setExpandedRequirementIds] = useState<Set<string>>(new Set())
  const [selectedRequirementIds, setSelectedRequirementIds] = useState<Set<string>>(new Set())
  const page = pageState.filterKey === filterKey ? pageState.page : 1

  const visibleItems = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    const systemItems = filterRequirementsBySystem(requirements, systemId)
    if (!normalized) return systemItems
    return systemItems.filter((item) =>
      [
        item.id,
        item.title,
        item.system,
        item.fileName,
        item.sourceName,
        item.link,
        item.requirementPath,
        item.status
      ]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase()
        .includes(normalized)
    )
  }, [query, requirements, systemId])

  const totalPages = Math.max(1, Math.ceil(visibleItems.length / PAGE_SIZE))
  const currentPage = Math.min(page, totalPages)
  const pageItems = visibleItems.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE)
  const selectedRequirements = useMemo(
    () => requirements.filter((item) => selectedRequirementIds.has(item.id)),
    [requirements, selectedRequirementIds]
  )
  const allPageSelected =
    pageItems.length > 0 && pageItems.every((item) => selectedRequirementIds.has(item.id))
  const somePageSelected = pageItems.some((item) => selectedRequirementIds.has(item.id))
  const requirementToDelete = requirementsToDelete[0] ?? null
  const isBatchDelete = requirementsToDelete.length > 1
  const conversationCountToDelete = requirementsToDelete.reduce(
    (count, item) => count + getRequirementThreadIds(item).length,
    0
  )
  const historyGridColumns = selectionMode ? SELECTION_HISTORY_GRID_COLUMNS : HISTORY_GRID_COLUMNS

  useEffect(() => {
    const availableIds = new Set(requirements.map((item) => item.id))
    setSelectedRequirementIds((current) => {
      const next = new Set([...current].filter((id) => availableIds.has(id)))
      return next.size === current.size ? current : next
    })
  }, [requirements])

  const closeDeleteDialog = (): void => {
    if (isDeleting) return
    setRequirementsToDelete([])
    setDeleteError(null)
  }

  const confirmDelete = async (): Promise<void> => {
    if (requirementsToDelete.length === 0) return
    setIsDeleting(true)
    setDeleteError(null)
    const completedIds = new Set<string>()
    try {
      for (const requirement of requirementsToDelete) {
        await onDelete(requirement)
        completedIds.add(requirement.id)
      }
      setRequirementsToDelete([])
    } catch (error) {
      setRequirementsToDelete((current) => current.filter((item) => !completedIds.has(item.id)))
      setDeleteError(error instanceof Error ? error.message : "删除需求失败，请重试")
    } finally {
      if (completedIds.size > 0) {
        setSelectedRequirementIds((current) => {
          const next = new Set(current)
          completedIds.forEach((id) => next.delete(id))
          return next
        })
      }
      setIsDeleting(false)
    }
  }

  const togglePageSelection = (): void => {
    setSelectedRequirementIds((current) => {
      const next = new Set(current)
      if (allPageSelected) {
        pageItems.forEach((item) => next.delete(item.id))
      } else {
        pageItems.forEach((item) => next.add(item.id))
      }
      return next
    })
  }

  const toggleRequirementSelection = (requirementId: string): void => {
    setSelectedRequirementIds((current) => {
      const next = new Set(current)
      if (next.has(requirementId)) next.delete(requirementId)
      else next.add(requirementId)
      return next
    })
  }

  const openWorkDir = async (requirement: RequirementRecord): Promise<void> => {
    setOpeningWorkDirId(requirement.id)
    try {
      const result = await window.api.requirements.openWorkDir(requirement.id)
      if (!result.success) {
        throw new Error(result.error || "打开需求工作目录失败")
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "打开需求工作目录失败")
    } finally {
      setOpeningWorkDirId(null)
    }
  }

  const toggleModules = (requirementId: string): void => {
    setExpandedRequirementIds((current) => {
      const next = new Set(current)
      if (next.has(requirementId)) next.delete(requirementId)
      else next.add(requirementId)
      return next
    })
  }

  return (
    <>
      <section className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="px-0 pb-3">
            {selectionMode ? (
              <div className="mb-2 flex min-h-10 items-center gap-2 border border-[#eadfd4] bg-[#fffaf5] px-3 text-[12px] text-[#74695f]">
                <span className="font-medium">批量选择需求</span>
                {selectedRequirements.length > 0 ? (
                  <>
                    <span>
                      已选择{" "}
                      <b className="tabular-nums text-[#5d4c3e]">{selectedRequirements.length}</b>{" "}
                      项需求
                    </span>
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      className="ml-auto h-7 gap-1.5 px-2.5 text-[12px]"
                      onClick={() => {
                        setDeleteError(null)
                        setRequirementsToDelete(selectedRequirements)
                      }}
                    >
                      <Trash2 className="size-3.5" />
                      删除所选
                    </Button>
                  </>
                ) : null}
                <IconPopoverButton
                  icon={<X className="size-3.5" />}
                  popoverContent="退出批量选择"
                  aria-label="退出批量选择"
                  className="size-7 shrink-0 rounded-[6px] text-[#8b715b] hover:bg-[#f1eae1] hover:text-[#5d4c3e]"
                  onClick={() => {
                    onSelectionModeChange(false)
                    setSelectedRequirementIds(new Set())
                  }}
                />
              </div>
            ) : null}
            <div
              className={`${historyGridColumns} grid items-center gap-2.5 whitespace-nowrap border-b border-[#f0f0f0] bg-[#fbf9f6] px-3 text-[11.5px] text-[#958a7f]`}
            >
              {selectionMode ? (
                <span className="flex h-[38px] items-center justify-center">
                  <SelectionCheckbox
                    checked={allPageSelected}
                    indeterminate={somePageSelected && !allPageSelected}
                    onChange={togglePageSelection}
                    ariaLabel={allPageSelected ? "取消全选当前页" : "全选当前页"}
                  />
                </span>
              ) : null}
              <span className="flex h-[38px] items-center">系统</span>
              <span>需求名称</span>
              <span>需求来源</span>
              <span>旧需求信息</span>
              <span>工作目录</span>
              <span>是否已生成规范PRD</span>
              <span>是否发布需求空间3.0</span>
              <span>规范PRD功能个数</span>
              <span className="text-right">时间</span>
              <span className="text-right">操作</span>
            </div>
            {pageItems.map((item) => {
              const sourceType = getSourceType(item)
              const statusLabel = getStatusLabel(item.status)
              const modules = getRequirementModules(item)
              const hasModules = modules.length > 0
              const modulesExpanded = expandedRequirementIds.has(item.id)
              return (
                <div key={item.id} className="border-b border-[#eee8e1]">
                  <div
                    className={`${historyGridColumns} grid min-h-[52px] w-full items-center gap-2.5 bg-white px-3 text-left text-sm transition-colors hover:bg-[#fdf8f3]`}
                  >
                    {selectionMode ? (
                      <span className="flex justify-center">
                        <SelectionCheckbox
                          checked={selectedRequirementIds.has(item.id)}
                          onChange={() => toggleRequirementSelection(item.id)}
                          ariaLabel={`选择需求 ${item.title}`}
                        />
                      </span>
                    ) : null}
                    <span className="min-w-0 truncate">
                      <RequirementSystem systemId={item.systemId} name={item.system} />
                    </span>
                    <span className="flex min-w-0 items-center gap-1 truncate font-bold text-[#302a25]">
                      <span className="min-w-0 truncate" title={item.title}>
                        {item.title}
                      </span>
                    </span>
                    <span
                      className={cn(
                        "truncate text-[11.5px]",
                        sourceType === "file"
                          ? "text-[#8f6a2a]"
                          : sourceType === "link"
                            ? "text-[#3970a5]"
                            : "text-[#756a5f]"
                      )}
                    >
                      {sourceType === "file" ? "文件" : sourceType === "link" ? "链接" : "输入"}
                    </span>
                    <span className="flex min-w-0 items-center gap-1.5 font-mono text-[11.5px]">
                      <span className="shrink-0 rounded-[5px] bg-[#f1eae1] px-1.5 py-0.5 text-[10px] font-sans text-[#958a7f]">
                        {getLegacyLabel(item)}
                      </span>
                      {sourceType === "file" ? (
                        <FileText className="size-3 shrink-0 text-[#8f6a2a]" />
                      ) : sourceType === "link" ? (
                        <Link2 className="size-3 shrink-0 text-[#3970a5]" />
                      ) : (
                        <Edit className="size-3 shrink-0 text-[#756a5f]" />
                      )}
                      <span
                        className={cn(
                          "min-w-0 truncate underline decoration-dotted underline-offset-4",
                          sourceType === "file"
                            ? "text-[#8f6a2a]"
                            : sourceType === "link"
                              ? "text-[#3970a5]"
                              : "text-[#756a5f]"
                        )}
                        title={getLegacyValue(item)}
                      >
                        {getLegacyValue(item)}
                      </span>
                    </span>
                    <span className="flex min-w-0 items-center gap-1">
                      <RequirementWorkDir
                        path={item.requirementPath}
                        missing={item.workspaceMissing}
                      />
                      {item.workspaceMissing ? (
                        <AlertTriangle
                          className="size-3.5 shrink-0 text-[#b9694e]"
                          aria-label="工作目录已删除"
                        />
                      ) : null}
                      <IconPopoverButton
                        icon={
                          openingWorkDirId === item.id ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : (
                            <FolderOpen className="size-3.5" />
                          )
                        }
                        popoverContent={
                          openingWorkDirId === item.id
                            ? "正在打开工作目录"
                            : item.workspaceMissing
                              ? "工作目录已被删除"
                              : !item.requirementPath
                                ? "未关联工作目录"
                                : "打开工作目录"
                        }
                        aria-label={`打开 ${item.title} 的工作目录`}
                        disabled={
                          !item.requirementPath ||
                          item.workspaceMissing ||
                          openingWorkDirId === item.id
                        }
                        onClick={() => void openWorkDir(item)}
                        className="size-7 shrink-0 rounded-[6px] text-[#8b715b] hover:bg-[#f1eae1] hover:text-[#5d4c3e] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#c26b4f]/45"
                      />
                    </span>
                    <span
                      className={cn(
                        "justify-self-start whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-semibold",
                        getStatusClass(item.status)
                      )}
                    >
                      {statusLabel}
                    </span>
                    <span
                      className={cn(
                        "justify-self-start whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-semibold",
                        isRequirementPublished(item)
                          ? "bg-status-nominal/10 text-status-nominal"
                          : "bg-[#f5f0eb] text-[#a0958a]"
                      )}
                    >
                      {isRequirementPublished(item) ? "是" : "否"}
                    </span>
                    <span
                      className={cn(
                        "text-[12px] font-semibold tabular-nums flex  items-center",
                        isRequirementGenerated(item) ? "text-[#5d554d]" : "text-[#958a7f]"
                      )}
                    >
                      {isRequirementGenerated(item) ? `${modules.length} 个` : "—"}

                      {hasModules ? (
                        <button
                          type="button"
                          aria-expanded={modulesExpanded}
                          aria-controls={`requirement-modules-${item.id}`}
                          aria-label={modulesExpanded ? "收起模块信息" : "展开模块信息"}
                          onClick={() => toggleModules(item.id)}
                          className="flex size-6 shrink-0 items-center justify-center rounded-[5px] text-[#8b715b] transition-colors hover:bg-[#f1eae1] hover:text-[#5d4c3e] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#c26b4f]/45"
                        >
                          {modulesExpanded ? (
                            <ChevronDown className="size-3.5" />
                          ) : (
                            <ChevronRight className="size-3.5" />
                          )}
                        </button>
                      ) : null}
                    </span>
                    <span className="whitespace-nowrap text-right text-[12px] tabular-nums text-[#958a7f]">
                      {item.updatedAt}
                    </span>
                    <span className="flex items-center justify-end gap-1">
                      <button
                        type="button"
                        aria-label={`删除需求 ${item.title}`}
                        title="删除需求"
                        disabled={
                          isDeleting && requirementsToDelete.some((target) => target.id === item.id)
                        }
                        onClick={() => {
                          setDeleteError(null)
                          setRequirementsToDelete([item])
                        }}
                        className="flex size-7 shrink-0 items-center justify-center rounded-[6px] text-[#aa5d4d] transition-colors hover:bg-[#fae9e3] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#c26b4f]/45 disabled:cursor-wait disabled:opacity-50"
                      >
                        {isDeleting &&
                        requirementsToDelete.some((target) => target.id === item.id) ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          <Trash2 className="size-3.5" />
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          if (item.workspaceMissing) {
                            setRequirementToOpen(item)
                            return
                          }
                          onOpen(item)
                        }}
                        className="ml-4 inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-[6px] bg-[#C4956A] px-2.5 py-1.5 text-[12px] font-semibold text-white shadow-sm transition-colors hover:bg-[#b0845b] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#C4956A]/45"
                      >
                        {item.status.includes("沟通") ? "继续" : "查看"} →
                      </button>
                    </span>
                  </div>
                  {modulesExpanded ? (
                    <div
                      id={`requirement-modules-${item.id}`}
                      className="border-t border-[#eee8e1] bg-[#fffaf5] px-4 py-3"
                    >
                      <div className="mb-2 flex items-center justify-between gap-3">
                        <span className="text-[11px] font-semibold text-[#74695f]">
                          规范 PRD 模块详情
                        </span>
                        <span className="text-[11px] tabular-nums text-[#958a7f]">
                          共 {modules.length} 个
                        </span>
                      </div>
                      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                        {modules.map((module) => (
                          <article
                            key={`${item.id}-${module.moduleId}-${module.filePath}`}
                            className="rounded-[7px] border border-[#eadfd4] bg-white px-3 py-2.5"
                          >
                            <div className="flex items-start gap-2">
                              <span className="shrink-0 rounded-[5px] bg-[#f1eae1] px-1.5 py-0.5 text-[10px] font-semibold text-[#8b715b]">
                                {module.moduleId}
                              </span>
                              <span className="min-w-0 truncate text-[12px] font-semibold text-[#302a25]">
                                {module.name}
                              </span>
                            </div>
                            <p className="mt-2 text-[11px] leading-4 text-[#74695f]">
                              {module.description || "暂无模块描述"}
                            </p>
                            {module.keywords.length > 0 ? (
                              <div className="mt-2 flex flex-wrap gap-1">
                                {module.keywords.map((keyword, keywordIndex) => (
                                  <span
                                    key={`${module.moduleId}-${keyword}-${keywordIndex}`}
                                    className="rounded border border-[#eadfd4] bg-[#fffaf5] px-1.5 py-0.5 text-[10px] text-[#8b715b]"
                                  >
                                    {keyword}
                                  </span>
                                ))}
                              </div>
                            ) : null}
                            <p className="mt-2 break-all text-[11px] text-[#958a7f]">
                              文件：{module.filePath || "—"}
                            </p>
                          </article>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              )
            })}
            {pageItems.length === 0 && (
              <div className="border-b border-[#eee8e1] bg-white px-3 py-12 text-center text-[12px] text-[#958a7f]">
                没有匹配的需求历史
              </div>
            )}
            <div className="flex items-center justify-center gap-1.5 border-[#eee8e1] pt-3 text-[12px]">
              <span className="mr-2 whitespace-nowrap text-[#958a7f]">
                共 <b className="text-[#5d554d]">{visibleItems.length}</b> 条 · 第{" "}
                <b className="text-[#5d554d]">{currentPage}</b> /{" "}
                <b className="text-[#5d554d]">{totalPages}</b> 页
              </span>
              <button
                type="button"
                aria-label="上一页"
                disabled={currentPage <= 1}
                onClick={() => setPageState({ filterKey, page: currentPage - 1 })}
                className="flex size-7 items-center justify-center rounded-[7px] border border-transparent text-[#958a7f] transition-colors hover:border-[#ddd5cc] hover:bg-white disabled:pointer-events-none disabled:opacity-45"
              >
                ‹
              </button>
              {Array.from({ length: totalPages }, (_, index) => index + 1).map((pageNumber) => (
                <button
                  key={pageNumber}
                  type="button"
                  aria-label={`第 ${pageNumber} 页`}
                  aria-current={pageNumber === currentPage ? "page" : undefined}
                  onClick={() => setPageState({ filterKey, page: pageNumber })}
                  className={cn(
                    "flex size-7 items-center justify-center rounded-[7px] border text-[12px] font-semibold transition-colors",
                    pageNumber === currentPage
                      ? "border-[#c26b4f] bg-[#c26b4f] text-white"
                      : "border-[#ddd5cc] bg-white text-[#5d554d] hover:border-[#c26b4f]/50"
                  )}
                >
                  {pageNumber}
                </button>
              ))}
              <button
                type="button"
                aria-label="下一页"
                disabled={currentPage >= totalPages}
                onClick={() => setPageState({ filterKey, page: currentPage + 1 })}
                className="flex size-7 items-center justify-center rounded-[7px] border border-transparent text-[#958a7f] transition-colors hover:border-[#ddd5cc] hover:bg-white disabled:pointer-events-none disabled:opacity-45"
              >
                ›
              </button>
            </div>
          </div>
        </div>
      </section>

      <Dialog
        open={!!requirementToDelete}
        onOpenChange={(open) => {
          if (!open) closeDeleteDialog()
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{isBatchDelete ? "确认批量删除需求" : "确认删除需求"}</DialogTitle>
            <DialogDescription className="leading-6">
              {isBatchDelete
                ? `确定删除所选 ${requirementsToDelete.length} 项需求及其关联的 ${conversationCountToDelete} 个会话吗？这会同步删除需求索引映射以及工作目录中的需求文件夹，删除后不可恢复。`
                : `确定要删除「${requirementToDelete?.title ?? ""}」吗？这会同步删除 PRD Agent
                会话、需求索引映射以及工作目录中的该需求文件夹，删除后不可恢复。`}
            </DialogDescription>
          </DialogHeader>
          {!isBatchDelete && requirementToDelete?.requirementPath ? (
            <p className="rounded-lg border border-[#e5d9ce] bg-[#fbf8f4] px-3 py-2 font-mono text-[11px] leading-5 text-[#74695f] break-all">
              {requirementToDelete.requirementPath}
            </p>
          ) : null}
          {deleteError ? (
            <p role="alert" className="rounded-lg bg-[#fceae5] px-3 py-2 text-sm text-[#9f493a]">
              {deleteError}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={closeDeleteDialog}
              disabled={isDeleting}
            >
              取消
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => void confirmDelete()}
              disabled={isDeleting}
            >
              {isDeleting ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Trash2 className="size-4" />
              )}
              {isBatchDelete ? "删除所选需求" : "删除需求"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!requirementToOpen}
        onOpenChange={(open) => {
          if (!open) setRequirementToOpen(null)
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>工作目录已删除</DialogTitle>
            <DialogDescription className="leading-6">
              该需求的工作目录已被删除，相关内容可能不可用。是否继续打开需求沟通？
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setRequirementToOpen(null)}>
              取消
            </Button>
            <Button
              type="button"
              onClick={() => {
                if (!requirementToOpen) return
                const requirement = requirementToOpen
                setRequirementToOpen(null)
                onOpen(requirement)
              }}
            >
              继续打开
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
