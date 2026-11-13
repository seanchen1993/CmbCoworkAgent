import { useDeferredValue, useEffect, useState } from "react"
import { Command, Plus, Search } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { RequirementHistoryList } from "./RequirementHistoryList"
import type { RequirementRecord, RequirementUser } from "./requirement-data"
import { useRequirementStore } from "./requirement-store"
import {
  filterRequirements,
  type RequirementSourceFilter
} from "./requirement-history-filter"
import { REQUIREMENT_SPACE_LIST_QUERY_KEY } from "./requirement-navigation"

const sourceFilters: Array<{ value: RequirementSourceFilter; label: string }> = [
  { value: "all", label: "全部" },
  { value: "local", label: "本地" },
  { value: "remote", label: "远端" },
  { value: "space", label: "需求空间3.0" }
]

function takeSpaceListQuery(): string {
  const query = window.sessionStorage.getItem(REQUIREMENT_SPACE_LIST_QUERY_KEY) || ""
  window.sessionStorage.removeItem(REQUIREMENT_SPACE_LIST_QUERY_KEY)
  return query
}

export function RequirementHistoryView({
  requirements,
  currentUser,
  sourceFilter,
  requirementSpaceLoading,
  requirementSpaceTotal,
  requirementSpacePage,
  onRequirementSpacePageChange,
  onSourceFilterChange,
  onNew,
  onOpenRequirement,
  onDeleteRequirement
}: {
  requirements: RequirementRecord[]
  currentUser: RequirementUser | null
  sourceFilter: RequirementSourceFilter
  requirementSpaceLoading: boolean
  requirementSpaceTotal: number
  requirementSpacePage: number
  onRequirementSpacePageChange: (page: number) => void
  onSourceFilterChange: (filter: RequirementSourceFilter) => void
  onNew: () => void
  onOpenRequirement: (requirement: RequirementRecord) => void
  onDeleteRequirement: (requirement: RequirementRecord) => Promise<void>
}): React.JSX.Element {
  const [initialQuery] = useState(takeSpaceListQuery)
  const [searchInput, setSearchInput] = useState(initialQuery)
  const [query, setQuery] = useState(initialQuery)
  const [mineOnly, setMineOnly] = useState(false)
  const deferredQuery = useDeferredValue(query)
  const selectedSystemId = useRequirementStore((state) => state.selectedSystemId)

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault()
        document.getElementById("requirement-search")?.focus()
      }
    }
    window.addEventListener("keydown", handleShortcut)
    return () => window.removeEventListener("keydown", handleShortcut)
  }, [])

  const visibleCount =
    filterRequirements(requirements, {
      currentUser,
      mineOnly,
      query,
      sourceFilter,
      systemId: selectedSystemId
    }).length + (!mineOnly && (sourceFilter === "all" || sourceFilter === "remote") ? 1 : 0)

  return (
    <TooltipProvider delayDuration={180}>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
        <div className="min-h-0 flex-1 overflow-hidden px-5 py-4 lg:px-7">
          <div className="mx-auto flex h-full min-h-0 w-full max-w-[2200px] flex-col">
            <header className="mb-4 flex flex-wrap items-center gap-3">
              <div className="mr-2 flex items-center gap-2.5">
                <h1 className="text-[16px] font-bold tracking-tight text-foreground">
                  全部需求/特性
                </h1>
                <span className="rounded-md bg-muted px-2 py-1 text-xs font-semibold tabular-nums text-muted-foreground">
                  {sourceFilter === "space" && !query.trim() && !mineOnly
                    ? requirementSpaceTotal
                    : visibleCount}
                </span>
              </div>
              <div
                className="flex h-9 items-center rounded-lg bg-background-interactive p-1"
                aria-label="需求来源筛选"
              >
                {sourceFilters.map((filter) => {
                  const unavailable = filter.value === "remote"
                  const button = (
                    <button
                      key={filter.value}
                      type="button"
                      disabled={unavailable}
                      aria-pressed={sourceFilter === filter.value}
                      onClick={() => onSourceFilterChange(filter.value)}
                      className={cn(
                        "h-7 rounded-md px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        sourceFilter === filter.value
                          ? "bg-background-elevated text-foreground shadow-sm"
                          : "text-muted-foreground hover:text-foreground",
                        unavailable && "cursor-not-allowed opacity-50"
                      )}
                    >
                      {filter.label}
                    </button>
                  )
                  return unavailable ? (
                    <Tooltip key={filter.value}>
                      <TooltipTrigger asChild>
                        <span>{button}</span>
                      </TooltipTrigger>
                      <TooltipContent>敬请期待</TooltipContent>
                    </Tooltip>
                  ) : (
                    button
                  )
                })}
              </div>
              <div
                className="flex h-9 items-center rounded-lg bg-background-interactive p-1"
                aria-label="需求归属筛选"
              >
                <button
                  type="button"
                  aria-pressed={mineOnly}
                  onClick={() => setMineOnly(true)}
                  className={cn(
                    "h-7 rounded-md px-3 text-xs font-medium",
                    mineOnly
                      ? "bg-background-elevated text-foreground shadow-sm"
                      : "text-muted-foreground"
                  )}
                >
                  我的
                </button>
                <button
                  type="button"
                  aria-pressed={!mineOnly}
                  onClick={() => setMineOnly(false)}
                  className={cn(
                    "h-7 rounded-md px-3 text-xs font-medium",
                    !mineOnly
                      ? "bg-background-elevated text-foreground shadow-sm"
                      : "text-muted-foreground"
                  )}
                >
                  全部
                </button>
              </div>
              <form
                className="relative min-w-[240px] flex-1 xl:max-w-[420px]"
                onSubmit={(event) => {
                  event.preventDefault()
                  setQuery(searchInput)
                }}
              >
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="requirement-search"
                  type="search"
                  value={searchInput}
                  onChange={(event) => {
                    setSearchInput(event.target.value)
                    setQuery(event.target.value)
                  }}
                  placeholder="搜索 系统 / 需求 / 用户"
                  aria-label="搜索系统、需求或用户"
                  className="h-9 rounded-lg border-0 bg-background-interactive pl-9 pr-12 text-xs shadow-none"
                />
                <span className="pointer-events-none absolute right-3 top-1/2 flex -translate-y-1/2 items-center gap-0.5 text-[11px] text-muted-foreground">
                  <Command className="size-3" />K
                </span>
              </form>
              <div className="ml-auto flex items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  onClick={onNew}
                  className="h-9 rounded-lg px-3.5 text-xs"
                >
                  <Plus className="size-4" />
                  新建需求
                </Button>
              </div>
            </header>
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              <RequirementHistoryList
                requirements={requirements}
                currentUser={currentUser}
                query={deferredQuery}
                sourceFilter={sourceFilter}
                loading={sourceFilter === "space" && requirementSpaceLoading}
                serverTotal={
                  sourceFilter === "space" && !deferredQuery.trim() && !mineOnly
                    ? requirementSpaceTotal
                    : undefined
                }
                serverPage={sourceFilter === "space" ? requirementSpacePage : undefined}
                onServerPageChange={
                  sourceFilter === "space" ? onRequirementSpacePageChange : undefined
                }
                mineOnly={mineOnly}
                systemId={selectedSystemId}
                onCreate={onNew}
                onOpen={onOpenRequirement}
                onDelete={onDeleteRequirement}
              />
            </div>
          </div>
        </div>
      </div>
    </TooltipProvider>
  )
}
