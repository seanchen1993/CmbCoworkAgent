import type React from "react"
import { useEffect, useMemo, useState } from "react"
import {
  Calendar,
  Check,
  CheckCircle,
  Search,
  Sparkles,
  Tag,
  Trash2,
  User,
  X
} from "lucide-react"
import {
  getMockOrgSkillLabels,
  getMockOrgSkillMarketResponse,
  orgSkillMarketApi,
  type OrgSkillLabel
} from "../../../api/org-skill-market"
import { USE_MARKET_MOCK_ON_ERROR } from "../../../api/market-flags"
import type { MarketApiResponse, MarketItem } from "../../../api/market"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { buildMarketInstalledFlags } from "./MarketUpdateBadge"
import { TabsTrigger } from "@/components/ui/tabs"
import { getOrgSkillUploaderProfile, renderUploaderProfile } from "./MarketUploaderProfile"

export const ORG_SKILL_MARKET_TYPE = "orgSkill" as const
const ORG_SKILL_PAGE_SIZE = 10

export const orgSkillTabIntro = {
  title: "组织级技能来自-Skills市场",
  description:
    "这里展示组织发布和平台内置的技能，安装后会进入本地 Skills，与普通技能保持一致的调用体验。"
}

export function OrgSkillMarketTabTrigger(): React.JSX.Element {
  return (
    <TabsTrigger
      value={ORG_SKILL_MARKET_TYPE}
      className="rounded-lg text-xs text-muted-foreground transition-all data-[state=active]:bg-background-elevated data-[state=active]:font-medium data-[state=active]:text-foreground data-[state=active]:shadow-sm"
    >
      <Sparkles className="size-3 mr-1.5" />
      组织级技能
    </TabsTrigger>
  )
}

export function OrgSkillMarketIntroIcon(): React.JSX.Element {
  return <Sparkles className="mt-0.5 size-4 shrink-0 text-primary" />
}

interface OrgSkillPaginationState {
  pageNum: number
  pageSize: number
  total: number
  pages: number
  hasNextPage: boolean
  hasPreviousPage: boolean
}

interface OrgSkillMarketContentProps {
  initialSearchQuery?: string
  installedSkills: string[]
  reloadToken: number
  downloadingItems: Set<string>
  initialDetailName?: string | null
  onOpenDetail: (item: MarketItem) => void | Promise<void>
  onUninstall: (item: MarketItem) => void | Promise<void>
  onInitialDetailReady?: (item: MarketItem) => void
  onInitialDetailConsumed?: () => void
}

function getOrgSkillItemKey(item: MarketItem): string {
  return item.id || item.name
}

function getCategoryFilterName(category?: string): string {
  if (!category) return "未分类"
  const parts = category
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean)
  if (parts.length <= 1) return parts[0] || "未分类"
  return parts.slice(1).join("/") || "未分类"
}

function getOrgSkillMockLabels(): OrgSkillLabel[] {
  return getMockOrgSkillLabels()
}

function toPaginationState(
  response: MarketApiResponse,
  fallbackPageNum: number
): OrgSkillPaginationState {
  return {
    pageNum: response.pageNum || fallbackPageNum,
    pageSize: response.pageSize || ORG_SKILL_PAGE_SIZE,
    total: response.total ?? response.data?.length ?? 0,
    pages: response.pages || 1,
    hasNextPage: Boolean(response.hasNextPage),
    hasPreviousPage: Boolean(response.hasPreviousPage)
  }
}

function addOrgSkillInstalledFlags(items: MarketItem[], installedSkills: string[]): MarketItem[] {
  return items.map((item) => {
    const isInstalled =
      installedSkills.includes(item.name) ||
      installedSkills.includes(item.chinese_name || "") ||
      installedSkills.some((str) => item.name === str || item.filename?.includes(str))
    return {
      ...item,
      canDelete: false,
      featured: "",
      ...buildMarketInstalledFlags(item, ORG_SKILL_MARKET_TYPE, isInstalled)
    }
  })
}

function OrgSkillCard({
  item,
  isDownloading,
  onOpenDetail,
  onUninstall
}: {
  item: MarketItem
  isDownloading: boolean
  onOpenDetail: (item: MarketItem) => void | Promise<void>
  onUninstall: (item: MarketItem) => void | Promise<void>
}): React.JSX.Element {
  const uploaderProfile = getOrgSkillUploaderProfile(item)
  const updatedAt = item.updated_at || item.created_at

  return (
    <div
      className="group flex h-full cursor-pointer flex-col rounded-2xl border border-border bg-background-elevated p-4 shadow-[rgba(0,0,0,0.08)_0px_2px_10px] transition-colors hover:border-border-emphasis hover:bg-background-interactive"
      onClick={() => onOpenDetail(item)}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className={"flex items-center space-x-2"}>
                <h3 className="truncate text-[15px] font-medium leading-snug text-foreground">
                  {item.chinese_name || item.name}
                </h3>
                <div className="truncate text-[12px] text-muted-foreground">({item.name})</div>
                {item.category && (
                  <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                    <Tag className="size-3" />
                    {getCategoryFilterName(item.category)}
                  </span>
                )}
                <span className="ml-2 inline-flex items-center gap-1 text-xs text-muted-foreground">
            <Calendar className="size-3" />
            更新于 {new Date(updatedAt).toLocaleDateString("zh-CN")}
          </span>
              </div>
            </div>
            {item.installed && (
              <span
                className="inline-flex shrink-0 items-center gap-1 rounded-full border border-status-nominal/25 bg-status-nominal/10 px-2 py-0.5 text-[11px] font-medium text-status-nominal">
                <CheckCircle className="size-3" />
                已安装
              </span>
            )}
          </div>
          {item.description && (
            <p className="mb-2 mt-2 line-clamp-2 text-sm leading-relaxed text-muted-foreground">
              {item.description}
            </p>
          )}
        </div>
      </div>
      {/*box bottom*/}
      <div className="mt-4 mt-auto flex items-center justify-between border-t border-border pt-1">
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-muted-foreground">
          {/*{item.version && (*/}
          {/*  <span className="inline-flex items-center gap-1">*/}
          {/*    <GitBranch className="size-3" />v{item.version}*/}
          {/*  </span>*/}
          {/*)}*/}
          {(item.user_id || item.managerName || item.managerDepartment) && (
            <span className="flex min-w-0 items-start gap-1">
              <User className="mt-0.5 size-3 shrink-0" />
              {renderUploaderProfile(uploaderProfile, item.user_id || item.managerName, {
                multiline: true
              })}
            </span>
          )}
        </div>
        <div className="mt-3 flex items-center justify-end gap-1.5">
          {isDownloading ? (
            <div className="size-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          ) : (
            <>
              {item.installed ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1 rounded-lg border-status-critical/30 px-2.5 text-xs text-status-critical hover:bg-status-critical/10"
                  onClick={(event) => {
                    event.stopPropagation()
                    void onUninstall(item)
                  }}
                  title="卸载"
                >
                  <Trash2 className="size-3" />
                  卸载
                </Button>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function OrgSkillLabelFilter({
  labels,
  selectedLabelIds,
  loading,
  error,
  onToggleLabel,
  onClearLabels,
  onRetry
}: {
  labels: OrgSkillLabel[]
  selectedLabelIds: string[]
  loading: boolean
  error: string | null
  onToggleLabel: (labelId: string) => void
  onClearLabels: () => void
  onRetry: () => void
}): React.JSX.Element | null {
  const selectedLabelSet = new Set(selectedLabelIds)

  return (
    <aside className="rounded-2xl border border-border bg-background-elevated p-3 xl:sticky xl:top-4">
      <div className="flex items-center justify-between mb-2 px-1">
        <h3 className="text-xs font-medium text-muted-foreground">分类</h3>
        {selectedLabelIds.length > 0 && (
          <button
            type="button"
            onClick={onClearLabels}
            className="cursor-pointer text-xs text-status-critical transition-colors hover:opacity-80"
          >
            清除
          </button>
        )}
      </div>
      <div className="space-y-1.5 max-h-[60vh] overflow-y-auto pr-1">
        {loading ? (
          <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground">
            <div className="size-3.5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            <span>分类加载中…</span>
          </div>
        ) : error ? (
          <div className="space-y-2 px-2 py-1.5">
            <p className="text-xs leading-relaxed text-status-critical">{error}</p>
            <Button
              variant="outline"
              size="sm"
              className="h-7 rounded-lg border-status-critical/30 bg-background-elevated px-2.5 text-[11px] text-status-critical hover:bg-status-critical/10"
              onClick={onRetry}
            >
              重试
            </Button>
          </div>
        ) : labels.length === 0 ? (
          <p className="px-2 py-1.5 text-xs text-muted-foreground">暂无分类</p>
        ) : (
          labels.map((label) => {
            const isActive = selectedLabelSet.has(label.labelId)
            return (
              <button
                key={label.labelId}
                type="button"
                onClick={() => onToggleLabel(label.labelId)}
                className={`w-full flex items-center justify-between rounded-xl px-2.5 py-2 text-left transition-colors cursor-pointer ${
                  isActive
                    ? "border border-status-warning/25 bg-status-warning/10 text-status-warning"
                    : "border border-transparent text-muted-foreground hover:bg-background-interactive"
                }`}
              >
                <span className="text-[13px] leading-tight pr-2 break-all">{label.labelName}</span>
                {isActive && (
                  <span className="inline-flex shrink-0 items-center justify-center rounded-full bg-status-warning/15 px-1.5 py-0.5 text-status-warning">
                    <Check className="size-3" />
                  </span>
                )}
              </button>
            )
          })
        )}
      </div>
    </aside>
  )
}

export function OrgSkillMarketContent({
  initialSearchQuery = "",
  installedSkills,
  reloadToken,
  downloadingItems,
  initialDetailName,
  onOpenDetail,
  onUninstall,
  onInitialDetailReady,
  onInitialDetailConsumed
}: OrgSkillMarketContentProps): React.JSX.Element {
  const [pageNum, setPageNum] = useState(1)
  const [items, setItems] = useState<MarketItem[]>([])
  const [labels, setLabels] = useState<OrgSkillLabel[]>([])
  const [selectedLabelIds, setSelectedLabelIds] = useState<string[]>([])
  const [pagination, setPagination] = useState<OrgSkillPaginationState>({
    pageNum: 1,
    pageSize: ORG_SKILL_PAGE_SIZE,
    total: 0,
    pages: 1,
    hasNextPage: false,
    hasPreviousPage: false
  })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [labelsLoading, setLabelsLoading] = useState(false)
  const [labelsError, setLabelsError] = useState<string | null>(null)
  const [retryToken, setRetryToken] = useState(0)
  const [searchInput, setSearchInput] = useState(initialSearchQuery)
  const [submittedKeyword, setSubmittedKeyword] = useState(initialSearchQuery.trim())

  useEffect(() => {
    let cancelled = false

    const loadOrgSkillLabels = async () => {
      setLabelsLoading(true)
      setLabelsError(null)
      try {
        const response = await orgSkillMarketApi.getOrgSkillLabels()
        if (cancelled) return
        setLabels(response)
      } catch (loadError) {
        if (cancelled) return
        if (USE_MARKET_MOCK_ON_ERROR) {
          console.warn("[OrgSkillMarket] fallback to mock labels:", loadError)
          setLabels(getOrgSkillMockLabels())
          setLabelsError(null)
        } else {
          setLabels([])
          setSelectedLabelIds([])
          setLabelsError(loadError instanceof Error ? loadError.message : "加载组织级技能分类失败")
        }
      } finally {
        if (!cancelled) setLabelsLoading(false)
      }
    }

    void loadOrgSkillLabels()
    return () => {
      cancelled = true
    }
  }, [retryToken])

  useEffect(() => {
    let cancelled = false

    const loadOrgSkills = async () => {
      setLoading(true)
      setError(null)
      try {
        const response = await orgSkillMarketApi.getOrgSkills(
          pageNum,
          ORG_SKILL_PAGE_SIZE,
          selectedLabelIds,
          submittedKeyword
        )
        if (!response.success || !response.data) {
          throw new Error(response.error || "加载组织级技能失败")
        }
        if (cancelled) return
        setPagination(toPaginationState(response, pageNum))
        setItems(addOrgSkillInstalledFlags(response.data, installedSkills))
      } catch (loadError) {
        if (cancelled) return
        if (USE_MARKET_MOCK_ON_ERROR) {
          console.warn("[OrgSkillMarket] fallback to mock data:", loadError)
          const mockResponse = getMockOrgSkillMarketResponse(
            pageNum,
            ORG_SKILL_PAGE_SIZE,
            selectedLabelIds,
            submittedKeyword
          )
          setPagination(toPaginationState(mockResponse, pageNum))
          setItems(addOrgSkillInstalledFlags(mockResponse.data || [], installedSkills))
          setError(null)
        } else {
          setItems([])
          setError(loadError instanceof Error ? loadError.message : "加载组织级技能失败")
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void loadOrgSkills()
    return () => {
      cancelled = true
    }
  }, [installedSkills, pageNum, reloadToken, retryToken, selectedLabelIds, submittedKeyword])

  const selectedLabels = useMemo(() => {
    const selectedLabelSet = new Set(selectedLabelIds)
    return labels.filter((label) => selectedLabelSet.has(label.labelId))
  }, [labels, selectedLabelIds])

  const toggleLabel = (labelId: string) => {
    setPageNum(1)
    setSelectedLabelIds((prev) =>
      prev.includes(labelId) ? prev.filter((id) => id !== labelId) : [...prev, labelId]
    )
  }

  const clearLabels = () => {
    setPageNum(1)
    setSelectedLabelIds([])
  }

  const submitSearch = () => {
    setPageNum(1)
    setSubmittedKeyword(searchInput.trim())
  }

  const clearSearch = () => {
    setSearchInput("")
    setPageNum(1)
    setSubmittedKeyword("")
  }

  const renderSearchToolbar = () => (
    <div className="flex items-center gap-2">
      <div className="relative flex-1">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="搜索组织级技能…"
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") submitSearch()
          }}
          className="h-9 rounded-xl border-border bg-background-elevated pl-9 pr-9 text-sm text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-primary"
        />
        {searchInput && (
          <button
            type="button"
            aria-label="清空搜索"
            onClick={clearSearch}
            className="absolute right-2.5 top-1/2 inline-flex size-5 -translate-y-1/2 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-background-interactive hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>
      <Button
        size="sm"
        className="h-9 cursor-pointer gap-1.5 rounded-xl border-0 bg-button px-4 text-xs text-button-foreground hover:bg-button/90"
        onClick={submitSearch}
        disabled={loading}
      >
        <Search className="size-3.5" />
        查询
      </Button>
    </div>
  )

  const renderLabelFilter = () => (
    <OrgSkillLabelFilter
      labels={labels}
      selectedLabelIds={selectedLabelIds}
      loading={labelsLoading}
      error={labelsError}
      onToggleLabel={toggleLabel}
      onClearLabels={clearLabels}
      onRetry={() => setRetryToken((prev) => prev + 1)}
    />
  )

  useEffect(() => {
    const detailName = initialDetailName?.trim()
    if (!detailName || loading || items.length === 0) return
    const normalizedDetailName = detailName.toLowerCase()
    const target = items.find(
      (item) =>
        item.name === detailName ||
        item.chinese_name === detailName ||
        item.name.toLowerCase() === normalizedDetailName ||
        item.chinese_name?.toLowerCase() === normalizedDetailName
    )
    if (!target) {
      onInitialDetailConsumed?.()
      return
    }
    onInitialDetailConsumed?.()
    onInitialDetailReady?.(target)
  }, [initialDetailName, items, loading, onInitialDetailConsumed, onInitialDetailReady])

  if (loading) {
    return (
      <div className="space-y-3">
        {renderSearchToolbar()}
        <div className="grid grid-cols-1 xl:grid-cols-[240px_minmax(0,1fr)] gap-4 items-start">
          {renderLabelFilter()}
          <div className="space-y-3 min-w-0">
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
              <div className="mb-3 size-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
              <span className="text-sm">加载中…</span>
            </div>
          </div>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="space-y-3">
        {renderSearchToolbar()}
        <div className="grid grid-cols-1 xl:grid-cols-[240px_minmax(0,1fr)] gap-4 items-start">
          {renderLabelFilter()}
          <div className="space-y-3 min-w-0">
            <div className="flex flex-col items-center justify-center py-16">
              <div className="mb-3 flex size-10 items-center justify-center rounded-2xl border border-status-critical/25 bg-status-critical/10 text-status-critical">
                <span className="text-base">!</span>
              </div>
              <p className="mb-3 text-center text-sm text-status-critical">{error}</p>
              {error?.includes("凭证已过期") && (
                <p className="mb-3 text-center text-sm text-status-critical">
                  需要重新登陆，请退出app之后重新进入/登陆～
                </p>
              )}
              <Button
                variant="outline"
                size="sm"
                className="h-8 rounded-lg border-border bg-background-interactive px-4 text-xs text-muted-foreground hover:bg-secondary"
                onClick={() => setRetryToken((prev) => prev + 1)}
              >
                重试
              </Button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {renderSearchToolbar()}
      <div className="grid grid-cols-1 xl:grid-cols-[240px_minmax(0,1fr)] gap-4 items-start">
        {renderLabelFilter()}
        <div
          key={items.length === 0 ? "org-skill-results-empty" : "org-skill-results-list"}
          className="space-y-3 min-w-0"
        >
          <div className="flex items-center justify-between px-1 text-xs text-muted-foreground">
            <span>
              {selectedLabels.length > 0
                ? `当前分类：${selectedLabels.map((label) => label.labelName).join("、")}`
                : "全部 组织级技能"}
              {` · 总数 ${pagination.total} 个 · 当前页 ${items.length} 个 · 按更新时间排序`}
            </span>
          </div>
          {items.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
              <div className="mb-3 flex size-10 items-center justify-center rounded-2xl border border-border bg-background-interactive">
                <Search className="size-5 text-muted-foreground" />
              </div>
              <p className="text-sm">
                {submittedKeyword ? "未找到匹配的组织级技能" : "暂无组织级技能"}
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 2xl:grid-cols-2 gap-3">
              {items.map((item) => (
                <OrgSkillCard
                  key={getOrgSkillItemKey(item)}
                  item={item}
                  isDownloading={downloadingItems.has(getOrgSkillItemKey(item))}
                  onOpenDetail={onOpenDetail}
                  onUninstall={onUninstall}
                />
              ))}
            </div>
          )}
          <div className="flex items-center justify-end gap-2 border-t border-border pt-3 text-xs text-muted-foreground">
            <span className={"mr-2"}>共 {pagination.total} 条</span>
            <span className="mr-1 tabular-nums">
              第 {pagination.pageNum} / {pagination.pages} 页
            </span>
            <Button
              variant="outline"
              size="sm"
              className="h-7 rounded-lg border-border bg-background-elevated px-2.5 text-[11px] text-muted-foreground hover:bg-background-interactive"
              onClick={() => setPageNum((prev) => Math.max(1, prev - 1))}
              disabled={loading || !pagination.hasPreviousPage}
            >
              上一页
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 rounded-lg border-border bg-background-elevated px-2.5 text-[11px] text-muted-foreground hover:bg-background-interactive"
              onClick={() => setPageNum((prev) => Math.min(pagination.pages, prev + 1))}
              disabled={loading || !pagination.hasNextPage}
            >
              下一页
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
