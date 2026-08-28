import type React from "react"
import {
  BarChart3,
  Calendar,
  CheckCircle,
  Edit,
  FileText,
  GitBranch,
  Lightbulb,
  Sparkles,
  Star,
  Tag,
  Trash2,
  User,
  Zap
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import type { MarketItem, MarketItemType } from "../../../api/market"
import { buildOrgSkillSubscribeUrl } from "../../../api/org-skill-market"
import type { DashboardTraceDetail } from "../../dashboard/use-dashboard"
import type { UploaderProfile } from "./MarketUploaderProfile"
import { renderUploaderProfile } from "./MarketUploaderProfile"
import { MarketUpdateBadge, UpdateVersionTooltip } from "./MarketUpdateBadge"
import { toast } from "sonner"

type SkillUserUsage = {
  sapId: string
  userName: string
  orgName: string
  count: number
}

type MarketExtraJson = {
  updated_at?: string
}

function parseMarketExtraJson(extraJson?: string): MarketExtraJson {
  if (!extraJson?.trim()) return {}
  try {
    const parsed = JSON.parse(extraJson) as MarketExtraJson
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

function getMarketUpdatedAt(item: MarketItem): string {
  return parseMarketExtraJson(item.extra_json).updated_at || item.updated_at || item.created_at
}

function formatMarketDateTime(value?: string): string {
  if (!value) return "-"
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN")
}

interface MarketDetailViewProps {
  activeTab: MarketItemType
  selectedItem: MarketItem
  canManageSelectedItem: boolean
  detailFilePanel: React.ReactNode
  canViewSkillUserDetail: boolean
  selectedSkillCallCount: number | null
  selectedSkillUserCount: number | null
  selectedSkillUsageRows: SkillUserUsage[]
  skillUsageLoading: boolean
  selectedSkillTraces: DashboardTraceDetail[]
  skillTracesLoading: boolean
  skillTracesError: string | null
  selectedUploaderProfile: UploaderProfile | null
  selectedUploaderFallback?: string
  downloadingItems: Set<string>
  updatingItems: Set<string>
  getItemKey: (item: MarketItem) => string
  getMarketTypeLabel: (type: MarketItemType) => string
  formatMarketVersionLabel: (version?: string | null) => string
  isAutoOptimizedMarketItem: (item: MarketItem) => boolean
  onUpdateInstall: (item: MarketItem) => void
  onDownload: (item: MarketItem, downloadToLocal?: boolean) => void
  onUninstall: (item: MarketItem) => void
  onUpdate: (item: MarketItem) => void
  onDelete: (item: MarketItem) => void
  onOpenSkillTraceDialog: () => void
}

export function MarketDetailView(props: MarketDetailViewProps): React.JSX.Element {
  const {
    activeTab,
    selectedItem,
    canManageSelectedItem,
    detailFilePanel,
    canViewSkillUserDetail,
    selectedSkillCallCount,
    selectedSkillUserCount,
    selectedSkillUsageRows,
    skillUsageLoading,
    selectedSkillTraces,
    skillTracesLoading,
    skillTracesError,
    selectedUploaderProfile,
    selectedUploaderFallback,
    downloadingItems,
    updatingItems,
    getItemKey,
    getMarketTypeLabel,
    formatMarketVersionLabel,
    isAutoOptimizedMarketItem,
    onUpdateInstall,
    onDownload,
    onUninstall,
    onUpdate,
    onDelete,
    onOpenSkillTraceDialog
  } = props

  const subscribeUrl =
    activeTab === "orgSkill" ? buildOrgSkillSubscribeUrl(selectedItem) : null
  const createdAtLabel = formatMarketDateTime(selectedItem.created_at)
  const updatedAtLabel = formatMarketDateTime(getMarketUpdatedAt(selectedItem))

  const handleOpenSubscribe = () => {
    if (!subscribeUrl) {
      toast.error("当前技能缺少订阅地址信息")
      return
    }
    void window.electron.openExternal(subscribeUrl)
  }

  const renderSkillTraceEntry = () => {
    if (activeTab !== "skill") return null
    return (
      <div className="space-y-3 rounded-2xl border border-border bg-background-elevated p-4 shadow-[rgba(0,0,0,0.08)_0px_2px_10px]">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h4 className="text-[13px] font-medium text-foreground">
              最近 10 条 Trace 记录（本月）
            </h4>
            <p className="mt-1 text-[11px] text-muted-foreground">
              {skillTracesLoading
                ? "Trace 加载中…"
                : skillTracesError
                  ? skillTracesError
                  : `已加载 ${selectedSkillTraces.length} 条记录`}
            </p>
          </div>
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-status-info/25 bg-status-info/10 px-2 py-0.5 text-[11px] text-status-info">
            <BarChart3 className="size-3" />
            <span className="tabular-nums">{selectedSkillTraces.length}</span>
          </span>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="h-8 w-full cursor-pointer gap-1.5 rounded-lg border-border bg-background-elevated text-xs text-muted-foreground hover:bg-background-interactive"
          onClick={onOpenSkillTraceDialog}
        >
          <FileText className="size-3" />
          查看 Trace 详情
        </Button>
      </div>
    )
  }

  return (
    <ScrollArea className="flex-1">
      <div className="p-5 h-full">
        <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_380px] gap-5 items-start xl:h-full">
          <div className="space-y-3 xl:order-1 order-2">{detailFilePanel}</div>

          <div className="xl:order-2 order-1 space-y-3 xl:sticky xl:top-4 w-full h-full overflow-y-auto pr-1">
            <div className="space-y-3 rounded-2xl border border-border bg-background-elevated p-4 shadow-[rgba(0,0,0,0.10)_0px_4px_16px]">
              {selectedItem.description && (
                <p className="my-4 text-xs  leading-relaxed whitespace-pre-wrap break-words">
                  {selectedItem.description}
                </p>
              )}

              <div className="flex flex-wrap items-center gap-1.5 text-xs">
                {selectedItem.category && (
                  <span className="inline-flex items-center gap-1 rounded-full border border-border bg-background-interactive px-2.5 py-1 text-muted-foreground">
                    <Tag className="size-3" />
                    {selectedItem.category}
                  </span>
                )}
                {selectedItem.version && (
                  <span className="inline-flex items-center gap-1 rounded-full border border-border bg-background-interactive px-2.5 py-1 text-muted-foreground">
                    <GitBranch className="size-3" />
                    {selectedItem.updateAvailable && selectedItem.installedVersion
                      ? `${formatMarketVersionLabel(selectedItem.installedVersion)} -> ${formatMarketVersionLabel(selectedItem.version)}`
                      : formatMarketVersionLabel(selectedItem.version)}
                  </span>
                )}
                <span className="inline-flex items-center gap-1 rounded-full border border-border bg-background-interactive px-2.5 py-1 text-muted-foreground">
                  <Calendar className="size-3" />
                  创建于 {createdAtLabel}
                </span>
                <span className="inline-flex items-center gap-1 rounded-full border border-border bg-background-interactive px-2.5 py-1 text-muted-foreground">
                  <Edit className="size-3" />
                  更新于 {updatedAtLabel}
                </span>
                {selectedItem.installed && (
                  <span className="inline-flex items-center gap-1 rounded-full border border-status-nominal/25 bg-status-nominal/10 px-2.5 py-1 text-status-nominal">
                    <CheckCircle className="size-3" />
                    已安装
                  </span>
                )}
                {selectedItem.updateAvailable && (
                  <MarketUpdateBadge
                    typeLabel={getMarketTypeLabel(activeTab)}
                    installedVersion={selectedItem.installedVersion}
                    currentVersion={selectedItem.version}
                    label={`当前${getMarketTypeLabel(activeTab)}有更新`}
                    className="text-[12px] px-3 py-1"
                  />
                )}
                {selectedItem.featured === "精品" && (
                  <span className="inline-flex items-center gap-1 rounded-full border border-status-warning/25 bg-status-warning/10 px-2.5 py-1 text-status-warning">
                    <Star className="size-3 fill-current" />
                    精品
                  </span>
                )}
                {isAutoOptimizedMarketItem(selectedItem) && (
                  <span className="inline-flex items-center gap-1 rounded-full border border-status-info/25 bg-status-info/10 px-2.5 py-1 text-status-info">
                    <Sparkles className="size-3" />
                    系统优化
                  </span>
                )}
                {selectedUploaderFallback ? (
                  <span className="flex min-w-0 max-w-full items-start gap-1 rounded-xl border border-border bg-background-interactive px-2.5 py-1 text-muted-foreground">
                    <User className="mt-1 size-3 shrink-0" />
                    {renderUploaderProfile(selectedUploaderProfile, selectedUploaderFallback, {
                      multiline: true
                    })}
                  </span>
                ) : null}
                {activeTab === "skill" && selectedSkillCallCount !== null && (
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-status-info/25 bg-status-info/10 px-3 py-1 text-status-info">
                    <BarChart3 className="size-3" />
                    <span className="text-[11px] text-status-info/80">调用次数</span>
                    <span className="font-semibold tabular-nums">{selectedSkillCallCount}</span>
                  </span>
                )}
                {activeTab === "skill" && selectedSkillUserCount !== null && (
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-status-nominal/25 bg-status-nominal/10 px-3 py-1 text-status-nominal">
                    <User className="size-3" />
                    <span className="text-[11px] text-status-nominal/80">使用用户数</span>
                    <span className="font-semibold tabular-nums">{selectedSkillUserCount}</span>
                  </span>
                )}
              </div>

              <div className="grid grid-cols-2 gap-2 pt-1">
                {activeTab === "orgSkill" && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 cursor-pointer gap-1.5 rounded-lg border-status-info/25 bg-status-info/10 text-xs text-status-info hover:bg-status-info/15"
                    onClick={handleOpenSubscribe}
                  >
                    <Sparkles className="size-3" />
                    跳转去订阅
                  </Button>
                )}
                {selectedItem.installed ? (
                  activeTab === "orgSkill" ? (
                    <span className="inline-flex items-center gap-1.5 rounded-lg border border-status-nominal/25 bg-status-nominal/10 px-3 py-2 text-xs text-status-nominal">
                      <CheckCircle className="size-3" />
                      已安装
                    </span>
                  ) : selectedItem.featured === "精品" ? (
                    <TooltipProvider delayDuration={180}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="col-span-2 inline-flex items-center gap-1.5 rounded-lg border border-status-warning/25 bg-status-warning/10 px-3 py-2 text-xs text-status-warning">
                            <Zap className="size-3" />
                            自动保持最新
                          </span>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="max-w-72 text-xs leading-relaxed">
                          这是一个精品技能。系统会自动为你安装并保持最新版本，无需手动安装或更新。
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  ) : selectedItem.installDisabledReason ? (
                    <TooltipProvider delayDuration={180}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="col-span-2 inline-flex cursor-not-allowed">
                            <Button
                              variant="outline"
                              size="sm"
                              className="pointer-events-none h-8 w-full gap-1.5 rounded-lg border-border bg-background-interactive text-xs text-muted-foreground opacity-90"
                              disabled
                              aria-disabled="true"
                            >
                              <Zap className="size-3" />
                              无需安装
                            </Button>
                          </span>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="max-w-72 text-xs leading-relaxed">
                          {selectedItem.installDisabledReason}
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  ) : selectedItem.updateAvailable ? (
                    <UpdateVersionTooltip
                      typeLabel={getMarketTypeLabel(activeTab)}
                      installedVersion={selectedItem.installedVersion}
                      currentVersion={selectedItem.version}
                    >
                      <Button
                        variant="outline"
                        size="sm"
                        className="market-update-bounce h-8 cursor-pointer gap-1.5 rounded-lg border-status-nominal/30 bg-status-nominal/10 text-xs text-status-nominal hover:bg-status-nominal/15"
                        onClick={() => onUpdateInstall(selectedItem)}
                        disabled={updatingItems.has(getItemKey(selectedItem))}
                      >
                        <Zap className="size-3" />
                        更新安装
                      </Button>
                    </UpdateVersionTooltip>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 cursor-pointer gap-1.5 rounded-lg border-border bg-background-interactive text-xs text-muted-foreground hover:bg-secondary"
                      onClick={() => onUpdateInstall(selectedItem)}
                      disabled={updatingItems.has(getItemKey(selectedItem))}
                    >
                      <Zap className="size-3" />
                      重新安装
                    </Button>
                  )
                ) : selectedItem.installDisabledReason ? (
                  <TooltipProvider delayDuration={180}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="col-span-2 inline-flex cursor-not-allowed">
                          <Button
                            size="sm"
                            className="pointer-events-none h-8 w-full gap-1.5 rounded-lg border-0 bg-muted text-xs text-muted-foreground opacity-85"
                            disabled
                            aria-disabled="true"
                          >
                            <Zap className="size-3" />
                            无需安装
                          </Button>
                        </span>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="max-w-72 text-xs leading-relaxed">
                        {selectedItem.installDisabledReason}
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                ) : (
                  <Button
                    size="sm"
                    className="h-8 cursor-pointer gap-1.5 rounded-lg border-0 bg-button text-xs text-button-foreground hover:bg-button/90"
                    onClick={() => onDownload(selectedItem, false)}
                    disabled={downloadingItems.has(getItemKey(selectedItem))}
                  >
                    <Zap className="size-3" />
                    安装
                  </Button>
                )}
                {selectedItem.installed &&
                  selectedItem.featured !== "精品" &&
                  !selectedItem.installDisabledReason && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 cursor-pointer gap-1.5 rounded-lg border-status-critical/30 text-xs text-status-critical hover:bg-status-critical/10"
                      onClick={() => onUninstall(selectedItem)}
                    >
                      <Trash2 className="size-3" />
                      卸载
                    </Button>
                  )}
                {activeTab !== "orgSkill" && canManageSelectedItem && (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 cursor-pointer gap-1.5 rounded-lg border-border bg-background-interactive text-xs text-muted-foreground hover:bg-secondary"
                        onClick={() => onUpdate(selectedItem)}
                      >
                        <Edit className="size-3" />
                        编辑
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 cursor-pointer gap-1.5 rounded-lg border-status-critical/30 text-xs text-status-critical hover:bg-status-critical/10"
                        onClick={() => onDelete(selectedItem)}
                      >
                        <Trash2 className="size-3" />
                        删除
                      </Button>
                    </>
                  )}
              </div>
            </div>

            {activeTab === "skill" && canViewSkillUserDetail && (
              <div className="space-y-3 rounded-2xl border border-border bg-background-elevated p-4 shadow-[rgba(0,0,0,0.08)_0px_2px_10px]">
                <div className="flex items-center justify-between">
                  <h4 className="text-[13px] font-medium text-foreground">使用用户明细（本月）</h4>
                  <div className="flex items-center gap-1.5">
                    <span className="inline-flex items-center gap-1 rounded-full border border-status-info/25 bg-status-info/10 px-2 py-0.5 text-[11px] text-status-info">
                      <BarChart3 className="size-3" />
                      <span className="tabular-nums">{selectedSkillCallCount ?? 0}</span>
                    </span>
                    <span className="inline-flex items-center gap-1 rounded-full border border-status-nominal/25 bg-status-nominal/10 px-2 py-0.5 text-[11px] text-status-nominal">
                      <User className="size-3" />
                      <span className="tabular-nums">{selectedSkillUserCount ?? 0}</span>
                    </span>
                  </div>
                </div>
                {skillUsageLoading ? (
                  <div className="flex items-center justify-center py-5 text-xs text-muted-foreground">
                    <div className="mr-2 size-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                    加载中…
                  </div>
                ) : (
                  <div className="max-h-[260px] overflow-auto rounded-xl border border-border">
                    <table className="w-full text-[12px]">
                      <thead className="bg-background-interactive">
                        <tr className="text-muted-foreground">
                          <th className="text-left py-2 px-2 font-medium">Id</th>
                          <th className="text-left py-2 px-2 font-medium">名称</th>
                          <th className="text-left py-2 px-2 font-medium">机构</th>
                          <th className="text-right py-2 px-2 font-medium">调用</th>
                        </tr>
                      </thead>
                      <tbody>
                        {selectedSkillUsageRows.map((user) => (
                          <tr
                            key={user.sapId}
                            className="border-t border-border text-muted-foreground"
                          >
                            <td className="py-1.5 px-2 font-mono">
                              {user.sapId === "__empty_user__" ? "—" : user.sapId}
                            </td>
                            <td className="py-1.5 px-2">
                              {user.sapId === "__empty_user__"
                                ? user.userName
                                : user.userName || user.sapId}
                            </td>
                            <td className="py-1.5 px-2">{user.orgName || "—"}</td>
                            <td className="py-1.5 px-2 text-right">{user.count}</td>
                          </tr>
                        ))}
                        {selectedSkillUsageRows.length === 0 && (
                          <tr>
                            <td colSpan={4} className="py-6 text-center text-muted-foreground">
                              暂无调用用户数据
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            {renderSkillTraceEntry()}

            {selectedItem.guidance && (
              <div className="rounded-xl border border-status-warning/25 bg-status-warning/10 p-4 text-sm shadow-[rgba(0,0,0,0.03)_0px_2px_8px]">
                <div className="mb-2 flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.08em] text-status-warning">
                  <Lightbulb className="size-3.5 shrink-0" />
                  <span>使用指引</span>
                </div>
                <p className="break-all whitespace-pre-wrap text-[13px] leading-relaxed text-muted-foreground">
                  {selectedItem.guidance}
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </ScrollArea>
  )
}
