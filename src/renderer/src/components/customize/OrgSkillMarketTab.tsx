import type React from "react"
import { useEffect, useMemo, useState } from "react"
import {
  Calendar,
  Check,
  CheckCircle,
  FileText,
  GitBranch,
  Search,
  Sparkles,
  Tag,
  Trash2,
  User,
  Zap
} from "lucide-react"
import {
  getMockOrgSkillLabels,
  getMockOrgSkillMarketResponse,
  orgSkillMarketApi,
  type OrgSkillLabel
} from "../../api/org-skill-market"
import { USE_MARKET_MOCK_ON_ERROR } from "../../api/market-flags"
import type { MarketApiResponse, MarketItem } from "../../api/market"
import { Button } from "@/components/ui/button"
import { buildMarketInstalledFlags } from "./MarketUpdateBadge"
import { TabsTrigger } from "@/components/ui/tabs"
import { getOrgSkillUploaderProfile, renderUploaderProfile } from "./MarketUploaderProfile"

export const ORG_SKILL_MARKET_TYPE = "orgSkill" as const
const ORG_SKILL_PAGE_SIZE = 10

export const orgSkillTabIntro = {
  title: "组织级技能来自技能开放平台",
  description:
    "这里展示组织发布和平台内置的技能，安装后会进入本地 Skills，与普通技能保持一致的调用体验。"
}

export function OrgSkillMarketTabTrigger(): React.JSX.Element {
  return (
    <TabsTrigger
      value={ORG_SKILL_MARKET_TYPE}
      className="text-xs rounded-lg data-[state=active]:bg-white data-[state=active]:text-[#141413] data-[state=active]:shadow-[rgba(0,0,0,0.06)_0px_1px_4px] text-[#87867f] data-[state=active]:font-medium transition-all"
    >
      <Sparkles className="size-3 mr-1.5" />
      组织级技能
    </TabsTrigger>
  )
}

export function OrgSkillMarketIntroIcon(): React.JSX.Element {
  return <Sparkles className="mt-0.5 size-4 shrink-0 text-[#7c6fb0]" />
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
  searchQuery: string
  installedSkills: string[]
  reloadToken: number
  downloadingItems: Set<string>
  initialDetailName?: string | null
  onOpenDetail: (item: MarketItem) => void | Promise<void>
  onDownload: (item: MarketItem, downloadToLocal?: boolean) => void | Promise<void>
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
  onDownload,
  onUninstall
}: {
  item: MarketItem
  isDownloading: boolean
  onOpenDetail: (item: MarketItem) => void | Promise<void>
  onDownload: (item: MarketItem, downloadToLocal?: boolean) => void | Promise<void>
  onUninstall: (item: MarketItem) => void | Promise<void>
}): React.JSX.Element {
  const uploaderProfile = getOrgSkillUploaderProfile(item)

  return (
    <div
      className="group rounded-2xl border border-[#e8e6dc] bg-[#faf9f5] p-4 hover:border-[#d9d5c8] hover:bg-white transition-colors shadow-[rgba(0,0,0,0.03)_0px_2px_10px] cursor-pointer"
      onClick={() => onOpenDetail(item)}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className={"flex items-center space-x-2"}>
                <h3 className="text-[15px] font-medium text-[#141413] leading-snug truncate">
                  {item.chinese_name || item.name}
                </h3>
                <div className=" text-[12px] text-[#87867f] truncate">{item.name}</div>
                {item.category && (
                  <span className="inline-flex items-center gap-1 text-xs text-gray-500">
                    <Tag className="size-3" />
                    {getCategoryFilterName(item.category)}
                  </span>
                )}
              </div>
            </div>
            {item.installed && (
              <span className="inline-flex items-center gap-1 rounded-full border border-[#c4e8d1] bg-[#edf7f0] px-2 py-0.5 text-[11px] font-medium text-[#2e7d4f] shrink-0">
                <CheckCircle className="size-3" />
                已安装
              </span>
            )}
          </div>
          {item.description && (
            <p className="mt-2 line-clamp-2 text-sm leading-relaxed text-[#87867f]">
              {item.description}
            </p>
          )}
        </div>
      </div>
      {/*box bottom*/}
      <div className={"flex items-center justify-between  border-t border-[#f0eee6] pt-3 mt-2"}>
        <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-[#87867f]">
          {item.version && (
            <span className="inline-flex items-center gap-1">
              <GitBranch className="size-3" />v{item.version}
            </span>
          )}
          <span className="inline-flex items-center gap-1">
            <Calendar className="size-3" />
            {new Date(item.created_at).toLocaleDateString("zh-CN")}
          </span>
          {(item.user_id || item.managerName || item.managerDepartment) && (
            <span className="inline-flex min-w-0 items-center gap-1">
              <User className="size-3 shrink-0" />
              {renderUploaderProfile(uploaderProfile, item.user_id || item.managerName)}
            </span>
          )}
        </div>
        <div className="mt-3 flex items-center justify-end gap-1.5">
          {isDownloading ? (
            <div className="size-4 border-2 border-[#c4956a] border-t-transparent rounded-full animate-spin" />
          ) : (
            <>
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-3 gap-1 text-xs text-[#5e5d59] border-[#e8e6dc] bg-[#f5f4ed] hover:bg-[#e8e6dc] rounded-lg"
                onClick={(event) => {
                  event.stopPropagation()
                  void onOpenDetail(item)
                }}
              >
                <FileText className="size-3" />
                详情
              </Button>
              {item.installed ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2.5 gap-1 text-xs border-[#fad4d4] text-[#b53333] hover:text-[#b53333] hover:bg-[#fdf2f2] rounded-lg"
                  onClick={(event) => {
                    event.stopPropagation()
                    void onUninstall(item)
                  }}
                  title="卸载"
                >
                  <Trash2 className="size-3" />
                  卸载
                </Button>
              ) : (
                <Button
                  size="sm"
                  className="h-7 px-3 gap-1 text-xs bg-[#c4956a] hover:bg-[#b85a3a] text-[#faf9f5] border-0 rounded-lg"
                  onClick={(event) => {
                    event.stopPropagation()
                    void onDownload(item, false)
                  }}
                >
                  <Zap className="size-3" />
                  安装
                </Button>
              )}
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
    <aside className="rounded-2xl border border-[#e8e6dc] bg-[#faf9f5] p-3 xl:sticky xl:top-4">
      <div className="flex items-center justify-between mb-2 px-1">
        <h3 className="text-xs font-medium text-[#5e5d59]">分类</h3>
        {selectedLabelIds.length > 0 && (
          <button
            type="button"
            onClick={onClearLabels}
            className="text-xs text-[#b85a3a] hover:text-[#9f472d] transition-colors cursor-pointer"
          >
            清除
          </button>
        )}
      </div>
      <div className="space-y-1.5 max-h-[60vh] overflow-y-auto pr-1">
        {loading ? (
          <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-[#87867f]">
            <div className="size-3.5 border-2 border-[#c4956a] border-t-transparent rounded-full animate-spin" />
            <span>分类加载中…</span>
          </div>
        ) : error ? (
          <div className="space-y-2 px-2 py-1.5">
            <p className="text-xs leading-relaxed text-[#b53333]">{error}</p>
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2.5 text-[11px] border-[#fad4d4] bg-white text-[#b53333] hover:bg-[#fdf2f2] rounded-lg"
              onClick={onRetry}
            >
              重试
            </Button>
          </div>
        ) : labels.length === 0 ? (
          <p className="text-xs text-[#87867f] px-2 py-1.5">暂无分类</p>
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
                    ? "bg-[#fdf3e7] border border-[#f5d9c4] text-[#8b623d]"
                    : "border border-transparent text-[#5e5d59] hover:bg-[#f5f4ed]"
                }`}
              >
                <span className="text-[13px] leading-tight pr-2 break-all">{label.labelName}</span>
                {isActive && (
                  <span className="inline-flex items-center justify-center rounded-full bg-[#f5d9c4] px-1.5 py-0.5 text-[#8b623d] shrink-0">
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
  searchQuery,
  installedSkills,
  reloadToken,
  downloadingItems,
  initialDetailName,
  onOpenDetail,
  onDownload,
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
          selectedLabelIds
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
            selectedLabelIds
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
  }, [installedSkills, pageNum, reloadToken, retryToken, selectedLabelIds])

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

  const visibleItems = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    if (!query) return items
    return items.filter(
      (item) =>
        item.name.toLowerCase().includes(query) ||
        item.chinese_name?.toLowerCase().includes(query) ||
        item.description.toLowerCase().includes(query)
    )
  }, [items, searchQuery])

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
      <div className="grid grid-cols-1 xl:grid-cols-[240px_minmax(0,1fr)] gap-4 items-start">
        {renderLabelFilter()}
        <div className="space-y-3 min-w-0">
          <div className="flex flex-col items-center justify-center py-16 text-[#87867f]">
            <div className="size-6 border-2 border-[#c4956a] border-t-transparent rounded-full animate-spin mb-3" />
            <span className="text-sm">加载中…</span>
          </div>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="grid grid-cols-1 xl:grid-cols-[240px_minmax(0,1fr)] gap-4 items-start">
        {renderLabelFilter()}
        <div className="space-y-3 min-w-0">
          <div className="flex flex-col items-center justify-center py-16">
            <div className="size-10 rounded-2xl bg-[#fdf2f2] border border-[#fad4d4] flex items-center justify-center mb-3">
              <span className="text-base">!</span>
            </div>
            <p className="text-sm text-[#b53333] mb-3 text-center">{error}</p>
            {error?.includes("凭证已过期") && (
              <p className="text-sm text-[#b53333] mb-3 text-center">
                需要重新登陆，请退出app之后重新进入/登陆～
              </p>
            )}
            <Button
              variant="outline"
              size="sm"
              className="h-8 px-4 text-xs text-[#5e5d59] border-[#e8e6dc] bg-[#f5f4ed] hover:bg-[#e8e6dc] rounded-lg"
              onClick={() => setRetryToken((prev) => prev + 1)}
            >
              重试
            </Button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="grid grid-cols-1 xl:grid-cols-[240px_minmax(0,1fr)] gap-4 items-start">
      {renderLabelFilter()}
      <div
        key={visibleItems.length === 0 ? "org-skill-results-empty" : "org-skill-results-list"}
        className="space-y-3 min-w-0"
      >
        <div className="flex items-center justify-between text-xs text-[#87867f] px-1">
          <span>
            {selectedLabels.length > 0
              ? `当前分类：${selectedLabels.map((label) => label.labelName).join("、")}`
              : "全部 组织级技能"}
            {` · 筛选结果 ${visibleItems.length} 个`}
          </span>
        </div>
        {visibleItems.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-[#87867f]">
            <div className="size-10 rounded-2xl bg-[#f5f4ed] border border-[#e8e6dc] flex items-center justify-center mb-3">
              <Search className="size-5 text-[#b0aea5]" />
            </div>
            <p className="text-sm">
              {searchQuery.trim() ? "当前页未找到匹配的组织级技能" : "暂无组织级技能"}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 2xl:grid-cols-2 gap-3">
            {visibleItems.map((item) => (
              <OrgSkillCard
                key={getOrgSkillItemKey(item)}
                item={item}
                isDownloading={downloadingItems.has(getOrgSkillItemKey(item))}
                onOpenDetail={onOpenDetail}
                onDownload={onDownload}
                onUninstall={onUninstall}
              />
            ))}
          </div>
        )}
        <div className="flex items-center justify-end gap-2 border-t border-[#f0eee6] pt-3 text-xs text-[#87867f]">
          <span className={"mr-2"}>共 {pagination.total} 条</span>
          <span className="mr-1 tabular-nums">
            第 {pagination.pageNum} / {pagination.pages} 页
          </span>
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2.5 text-[11px] rounded-lg border-[#e8e6dc] bg-white text-[#5e5d59] hover:bg-[#f5f4ed]"
            onClick={() => setPageNum((prev) => Math.max(1, prev - 1))}
            disabled={loading || !pagination.hasPreviousPage}
          >
            上一页
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2.5 text-[11px] rounded-lg border-[#e8e6dc] bg-white text-[#5e5d59] hover:bg-[#f5f4ed]"
            onClick={() => setPageNum((prev) => Math.min(pagination.pages, prev + 1))}
            disabled={loading || !pagination.hasNextPage}
          >
            下一页
          </Button>
        </div>
      </div>
    </div>
  )
}
