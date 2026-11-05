import { useEffect, useMemo, useRef, useState } from "react"
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  EllipsisVertical,
  Loader2,
  Share2,
  Trash2
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Avatar, AvatarFallback, AvatarGroup } from "@/components/ui/avatar"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import {
  isRequirementGenerated,
  isRequirementPublished,
  type RequirementRecord,
  type RequirementUser
} from "./requirement-data"
import { isRequirementMine } from "./requirement-history-filter"
import { RequirementStatusTags } from "./RequirementStatusTags"

const PAGE_SIZE = 10
export type RequirementSourceFilter = "all" | "local" | "remote" | "space"

const REMOTE_MOCK_REQUIREMENT: RequirementRecord = {
  id: "mock:remote:shared-membership-migration",
  threadIds: [],
  systemId: "mock-membership",
  title: "【Mock 数据】远端会员等级迁移需求",
  requirementPath: "",
  workspaceMissing: false,
  coreFilesMissing: false,
  coreFilesMissingReason: null,
  updatedAt: "2026/10/22 09:30",
  updatedAtTimestamp: Date.now(),
  system: "会员系统",
  status: "开发中",
  fileName: "",
  link: "",
  sourceType: "text",
  sourceName: "远端共享需求",
  initialDescription: "会员等级规则调整后的历史数据迁移与权益重算，覆盖存量会员。",
  needDesign: "1",
  prdManifest: {
    prd: {
      name: "【Mock 数据】远端会员等级迁移需求",
      status: "published",
      description: "会员等级规则调整后的历史数据迁移与权益重算，覆盖存量会员。",
      file: "mock-prd.md",
      currentStep: 5,
      needDesign: "1",
      htmlFile: "",
      htmlId: "",
      prDetailUrl: "https://example.invalid/requirements/mock"
    },
    functions: [
      {
        fr: "FR-001",
        name: "等级迁移",
        description: "迁移存量会员等级",
        file: "FR-001.md",
        keywords: ["会员", "迁移"],
        htmlFile: "prototype.html",
        htmlId: "",
        needDesign: "1"
      }
    ]
  },
  prd: "是",
  origin: "remote",
  owner: { id: "01045631", name: "王倩" },
  collaborators: [
    { id: "01998273", name: "张伟" },
    { id: "01028819", name: "赵磊" },
    { id: "01010254", name: "陈晨" }
  ],
  readOnly: true,
  mock: true
}

function initials(value: string): string {
  return (value.trim().slice(0, 1) || "需").toUpperCase()
}

const AVATAR_TONE_CLASSES = [
  "bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-300",
  "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300",
  "bg-violet-100 text-violet-700 dark:bg-violet-500/20 dark:text-violet-300",
  "bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300",
  "bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-300",
  "bg-cyan-100 text-cyan-700 dark:bg-cyan-500/20 dark:text-cyan-300",
  "bg-orange-100 text-orange-700 dark:bg-orange-500/20 dark:text-orange-300",
  "bg-fuchsia-100 text-fuchsia-700 dark:bg-fuchsia-500/20 dark:text-fuchsia-300",
  "bg-lime-100 text-lime-700 dark:bg-lime-500/20 dark:text-lime-300",
  "bg-teal-100 text-teal-700 dark:bg-teal-500/20 dark:text-teal-300",
  "bg-indigo-100 text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-300",
  "bg-purple-100 text-purple-700 dark:bg-purple-500/20 dark:text-purple-300",
  "bg-pink-100 text-pink-700 dark:bg-pink-500/20 dark:text-pink-300",
  "bg-sky-100 text-sky-700 dark:bg-sky-500/20 dark:text-sky-300",
  "bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-300",
  "bg-yellow-100 text-yellow-700 dark:bg-yellow-500/20 dark:text-yellow-300"
] as const

function avatarToneClass(value: string): string {
  const label = initials(value)
  let hash = 0
  for (const character of label) hash = (hash * 31 + (character.codePointAt(0) ?? 0)) >>> 0
  return AVATAR_TONE_CLASSES[hash % AVATAR_TONE_CLASSES.length]
}

function sourceTagClass(origin: RequirementRecord["origin"]): string {
  if (origin === "remote") {
    return "bg-[#e6f8f6] text-[#14a89d] dark:bg-[#14a89d]/15 dark:text-[#62d8cf]"
  }
  if (origin === "space") {
    return "bg-[#f1eaff] text-[#8b5cf6] dark:bg-[#8b5cf6]/16 dark:text-[#b9a0ff]"
  }
  return "bg-[#edf1ff] text-[#5570f6] dark:bg-[#5570f6]/16 dark:text-[#9eafff]"
}

function RequirementAvatars({ users }: { users: RequirementUser[] }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearCloseTimer = (): void => {
    if (!closeTimerRef.current) return
    clearTimeout(closeTimerRef.current)
    closeTimerRef.current = null
  }
  const show = (): void => {
    clearCloseTimer()
    setOpen(true)
  }
  const hide = (): void => {
    clearCloseTimer()
    closeTimerRef.current = setTimeout(() => setOpen(false), 100)
  }

  useEffect(() => clearCloseTimer, [])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          onPointerEnter={show}
          onPointerLeave={hide}
          onFocus={show}
          onBlur={hide}
          className="ml-0.5 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`远端用户 ${users.length} 人：${users.map((user) => user.name).join("、")}`}
        >
          <AvatarGroup>
            {users.slice(0, 3).map((user) => (
              <Avatar key={user.id} className="size-6 ring-2 ring-background-elevated">
                <AvatarFallback
                  className={cn("text-[10px] font-semibold", avatarToneClass(user.name))}
                >
                  {initials(user.name)}
                </AvatarFallback>
              </Avatar>
            ))}
          </AvatarGroup>
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="start"
        sideOffset={7}
        className="z-[60] w-56 p-2.5"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onPointerEnter={show}
        onPointerLeave={hide}
      >
        <div className="mb-2 text-[11px] font-medium text-muted-foreground">
          远端用户 · {users.length}
        </div>
        <div className="space-y-1.5">
          {users.map((user) => (
            <div key={user.id} className="flex items-center gap-2 rounded-md px-1 py-0.5">
              <Avatar className="size-6">
                <AvatarFallback
                  className={cn("text-[10px] font-semibold", avatarToneClass(user.name))}
                >
                  {initials(user.name)}
                </AvatarFallback>
              </Avatar>
              <span className="min-w-0 truncate text-xs font-medium text-foreground">
                {user.name}/{user.id}
              </span>
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}

export function RequirementHistoryList({
  requirements,
  currentUser,
  query,
  sourceFilter,
  mineOnly,
  systemId,
  onOpen,
  onDelete
}: {
  requirements: RequirementRecord[]
  currentUser: RequirementUser | null
  query: string
  sourceFilter: RequirementSourceFilter
  mineOnly: boolean
  systemId: string | null
  onOpen: (requirement: RequirementRecord) => void
  onDelete: (requirement: RequirementRecord) => Promise<void>
}): React.JSX.Element {
  const filterKey = `${systemId ?? "all"}\u0000${sourceFilter}\u0000${mineOnly}\u0000${query}`
  const [pageState, setPageState] = useState({ filterKey: "", page: 1 })
  const [toDelete, setToDelete] = useState<RequirementRecord | null>(null)
  const [toOpen, setToOpen] = useState<RequirementRecord | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const page = pageState.filterKey === filterKey ? pageState.page : 1

  const visibleItems = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    const items = [...requirements, REMOTE_MOCK_REQUIREMENT]
    return items
      .filter((item) => item.origin !== "local" || !systemId || item.systemId === systemId)
      .filter((item) => sourceFilter === "all" || item.origin === sourceFilter)
      .filter((item) => !mineOnly || isRequirementMine(item, currentUser))
      .filter(
        (item) =>
          !normalized ||
          [
            item.id,
            item.title,
            item.system,
            item.sourceName,
            item.initialDescription,
            item.status,
            item.owner?.name,
            ...(item.collaborators ?? []).map((user) => user.name)
          ]
            .filter(Boolean)
            .join(" ")
            .toLocaleLowerCase()
            .includes(normalized)
      )
  }, [currentUser, mineOnly, query, requirements, sourceFilter, systemId])
  const totalPages = Math.max(1, Math.ceil(visibleItems.length / PAGE_SIZE))
  const currentPage = Math.min(page, totalPages)
  const pageItems = visibleItems.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE)
  const confirmDelete = async (): Promise<void> => {
    if (!toDelete) return
    setIsDeleting(true)
    setDeleteError(null)
    try {
      await onDelete(toDelete)
      setToDelete(null)
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : "删除需求失败，请重试")
    } finally {
      setIsDeleting(false)
    }
  }

  return (
    <>
      <section className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          {pageItems.length ? (
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 xl:grid-cols-3">
              {pageItems.map((item) => {
                const generated = isRequirementGenerated(item) || isRequirementPublished(item)
                const owner = item.owner ?? (item.origin === "local" ? currentUser : null)
                const collaborators = item.collaborators ?? []
                const description =
                  item.prdManifest.prd.description ||
                  item.initialDescription ||
                  item.sourceName ||
                  "暂无需求描述"
                return (
                  <article
                    key={item.id}
                    role="button"
                    tabIndex={0}
                    className={cn(
                      "group relative flex min-h-[152px] cursor-pointer flex-col rounded-xl border border-border bg-background-elevated px-5 py-3 ring-primary/20 transition-[border-color,box-shadow] duration-200 hover:border-primary/70 hover:ring-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    )}
                    onClick={(event) => {
                      if ((event.target as HTMLElement).closest("button, a, input")) return
                      item.workspaceMissing ? setToOpen(item) : onOpen(item)
                    }}
                    onKeyDown={(event) => {
                      if (
                        event.target !== event.currentTarget ||
                        (event.key !== "Enter" && event.key !== " ")
                      )
                        return
                      event.preventDefault()
                      item.workspaceMissing ? setToOpen(item) : onOpen(item)
                    }}
                  >
                    <div className="flex items-center gap-2 pr-9">
                      <span className="mt-0.5 shrink-0 rounded-md bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                        {item.system}
                      </span>
                      <button
                        type="button"
                        onClick={() => (item.workspaceMissing ? setToOpen(item) : onOpen(item))}
                        className="min-w-0 truncate text-left text-[15px] font-bold text-foreground outline-none hover:text-primary focus-visible:rounded focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {item.title}
                      </button>
                      <span
                        className={cn(
                          "mt-0.5 shrink-0 rounded-md px-2 py-0.5 text-[10px] font-semibold",
                          sourceTagClass(item.origin)
                        )}
                      >
                        {item.origin === "remote"
                          ? "远端"
                          : item.origin === "space"
                            ? "需求空间3.0"
                            : "本地"}
                      </span>
                      {item.origin !== "space" && isRequirementPublished(item) ? (
                        <span
                          className={cn(
                            "mt-0.5 shrink-0 rounded-md px-2 py-0.5 text-[10px] font-semibold",
                            sourceTagClass("space")
                          )}
                        >
                          需求空间3.0
                        </span>
                      ) : null}
                    </div>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          className="absolute right-3 top-3 flex size-7 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-background-interactive hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                          aria-label={`${item.title} 更多操作`}
                        >
                          <EllipsisVertical className="size-4" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <DropdownMenuItem
                              aria-disabled
                              onSelect={(event) => event.preventDefault()}
                              className="text-muted-foreground opacity-60"
                            >
                              <Share2 />
                              分享
                            </DropdownMenuItem>
                          </TooltipTrigger>
                          <TooltipContent side="left">
                            {generated ? "分享功能敬请期待" : "生成规范 PRD 后才能分享"}
                          </TooltipContent>
                        </Tooltip>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          variant="destructive"
                          disabled={item.readOnly}
                          onSelect={() => setToDelete(item)}
                        >
                          <Trash2 />
                          删除
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                    <p
                      className="mt-2 line-clamp-1 text-xs leading-5 text-muted-foreground"
                      title={description}
                    >
                      {description}
                    </p>
                    <div className="mt-auto pt-1">
                      <div className="flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground">
                        <Avatar className="size-6">
                          <AvatarFallback
                            className={cn(
                              "text-[10px] font-semibold",
                              avatarToneClass(owner?.name ?? "需求")
                            )}
                          >
                            {initials(owner?.name ?? "需求")}
                          </AvatarFallback>
                        </Avatar>
                        <span className="max-w-[110px] truncate font-medium text-foreground">
                          {owner ? `${owner.name}/${owner.id}` : "用户信息暂无"}
                        </span>
                        <span className="text-border-emphasis">·</span>
                        <span className="whitespace-nowrap tabular-nums">
                          {item.updatedAt
                            ? item.origin === "space"
                              ? item.updatedAt
                              : `更新 ${item.updatedAt}`
                            : "时间暂无"}
                        </span>
                        {item.workspaceMissing ? (
                          <AlertTriangle
                            className="size-4 shrink-0 text-status-warning"
                            aria-label="工作目录已删除"
                          />
                        ) : null}
                      </div>
                      <div className="mt-2 flex min-h-7 items-end justify-between gap-3">
                        {item.origin === "space" ? (
                          <span />
                        ) : (
                          <RequirementStatusTags
                            standardized={isRequirementGenerated(item)}
                            hasPrototype={
                              Boolean(item.prdManifest.prd.htmlFile?.trim()) ||
                              item.prdManifest.functions.some((entry) =>
                                Boolean(entry.htmlFile?.trim())
                              )
                            }
                            published={isRequirementPublished(item)}
                          />
                        )}
                        {collaborators.length ? (
                          <RequirementAvatars users={collaborators} />
                        ) : (
                          <span />
                        )}
                      </div>
                    </div>
                  </article>
                )
              })}
            </div>
          ) : (
            <div className="flex min-h-[300px] flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-background-elevated text-sm text-muted-foreground">
              <span className="mb-2 text-2xl">⌕</span>没有匹配的需求，试试调整筛选条件
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 pt-5 text-xs text-muted-foreground">
          <span className="mr-2">共 {visibleItems.length} 条</span>
          <button
            type="button"
            disabled={currentPage <= 1}
            onClick={() => setPageState({ filterKey, page: currentPage - 1 })}
            className="flex size-8 items-center justify-center rounded-lg border border-border bg-background-elevated disabled:opacity-40"
            aria-label="上一页"
          >
            <ChevronLeft className="size-4" />
          </button>
          {Array.from({ length: totalPages }, (_, index) => index + 1).map((number) => (
            <button
              key={number}
              type="button"
              aria-current={number === currentPage ? "page" : undefined}
              onClick={() => setPageState({ filterKey, page: number })}
              className={cn(
                "size-8 rounded-lg border text-xs font-semibold",
                number === currentPage
                  ? "border-primary/30 bg-primary/10 text-primary"
                  : "border-border bg-background-elevated text-muted-foreground"
              )}
            >
              {number}
            </button>
          ))}
          <button
            type="button"
            disabled={currentPage >= totalPages}
            onClick={() => setPageState({ filterKey, page: currentPage + 1 })}
            className="flex size-8 items-center justify-center rounded-lg border border-border bg-background-elevated disabled:opacity-40"
            aria-label="下一页"
          >
            <ChevronRight className="size-4" />
          </button>
          <span className="ml-1 rounded-lg border border-border bg-background-elevated px-3 py-2">
            10 条/页
          </span>
        </div>
      </section>

      <Dialog
        open={toDelete !== null}
        onOpenChange={(open) => {
          if (!open && !isDeleting) {
            setToDelete(null)
            setDeleteError(null)
          }
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>确认删除需求</DialogTitle>
            <DialogDescription className="leading-6">
              确定删除「{toDelete?.title ?? ""}」吗？相关需求文件夹也会被删除，且不可恢复。
            </DialogDescription>
          </DialogHeader>
          {deleteError ? (
            <p
              role="alert"
              className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {deleteError}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={isDeleting}
              onClick={() => setToDelete(null)}
            >
              取消
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={isDeleting}
              onClick={() => void confirmDelete()}
            >
              {isDeleting ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Trash2 className="size-4" />
              )}
              确认删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!toOpen}
        onOpenChange={(open) => {
          if (!open) setToOpen(null)
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>工作目录已删除</DialogTitle>
            <DialogDescription>
              该需求的工作目录已被删除，相关内容可能不可用。是否继续打开需求沟通？
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setToOpen(null)}>
              取消
            </Button>
            <Button
              onClick={() => {
                if (toOpen) onOpen(toOpen)
                setToOpen(null)
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
