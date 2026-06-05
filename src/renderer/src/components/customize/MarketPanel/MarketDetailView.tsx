import type React from "react"
import {
  ArrowLeft,
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
import type { DashboardTraceDetail } from "../../dashboard/use-dashboard"
import type { UploaderProfile } from "./MarketUploaderProfile"
import { renderUploaderProfile } from "./MarketUploaderProfile"
import { MarketUpdateBadge, UpdateVersionTooltip } from "./MarketUpdateBadge"

type SkillUserUsage = {
  sapId: string
  userName: string
  orgName: string
  count: number
}

interface MarketDetailViewProps {
  activeTab: MarketItemType
  selectedItem: MarketItem
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
  onBackToList: () => void
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

  const renderSkillTraceEntry = () => {
    if (activeTab !== "skill") return null
    return (
      <div className="rounded-2xl border border-[#e8e6dc] bg-[#faf9f5] p-4 space-y-3 shadow-[rgba(0,0,0,0.03)_0px_2px_10px]">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h4 className="text-[13px] font-medium text-[#141413]">
              最近 10 条 Trace 记录（本月）
            </h4>
            <p className="mt-1 text-[11px] text-[#87867f]">
              {skillTracesLoading
                ? "Trace 加载中…"
                : skillTracesError
                  ? skillTracesError
                  : `已加载 ${selectedSkillTraces.length} 条记录`}
            </p>
          </div>
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-[#d7e2f5] bg-[#eef4ff] px-2 py-0.5 text-[11px] text-[#365d97]">
            <BarChart3 className="size-3" />
            <span className="tabular-nums">{selectedSkillTraces.length}</span>
          </span>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="h-8 w-full gap-1.5 text-xs text-[#5e5d59] border-[#e8e6dc] bg-white hover:bg-[#f5f4ed] rounded-lg cursor-pointer"
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
            <div className="rounded-2xl border border-[#e8e6dc] bg-[#faf9f5] p-4 space-y-3 shadow-[rgba(0,0,0,0.04)_0px_4px_16px]">
              {activeTab !== "skill" && (
                <div className="space-y-1.5">
                  {selectedItem.chinese_name ? (
                    <h3 className="text-base font-medium leading-snug text-[#141413]">
                      {selectedItem.chinese_name}
                      <span className="ml-2 text-[#87867f] font-normal text-sm">
                        ({selectedItem.name})
                      </span>
                    </h3>
                  ) : (
                    <h3 className="text-base font-medium leading-snug text-[#141413]">
                      {selectedItem.name}
                    </h3>
                  )}
                  {selectedItem.description && (
                    <p className="text-sm text-[#87867f] leading-relaxed whitespace-pre-wrap break-words">
                      {selectedItem.description}
                    </p>
                  )}
                </div>
              )}

              <div className="flex flex-wrap items-center gap-1.5 text-xs">
                {selectedItem.category && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-[#f5f4ed] border border-[#e8e6dc] text-[#5e5d59] px-2.5 py-1">
                    <Tag className="size-3" />
                    {selectedItem.category}
                  </span>
                )}
                {selectedItem.version && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-[#f5f4ed] border border-[#e8e6dc] text-[#5e5d59] px-2.5 py-1">
                    <GitBranch className="size-3" />
                    {selectedItem.updateAvailable && selectedItem.installedVersion
                      ? `${formatMarketVersionLabel(selectedItem.installedVersion)} -> ${formatMarketVersionLabel(selectedItem.version)}`
                      : formatMarketVersionLabel(selectedItem.version)}
                  </span>
                )}
                <span className="inline-flex items-center gap-1 rounded-full bg-[#f5f4ed] border border-[#e8e6dc] text-[#5e5d59] px-2.5 py-1">
                  <Calendar className="size-3" />
                  {new Date(selectedItem.created_at).toLocaleDateString("zh-CN")}
                </span>
                {selectedItem.installed && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-[#edf7f0] border border-[#c4e8d1] text-[#2e7d4f] px-2.5 py-1">
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
                  <span className="inline-flex items-center gap-1 rounded-full bg-[#fdf3e7] border border-[#f5d9c4] text-[#c4956a] px-2.5 py-1">
                    <Star className="size-3 fill-[#c4956a]" />
                    精品
                  </span>
                )}
                {isAutoOptimizedMarketItem(selectedItem) && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-[#eef5ff] border border-[#cdddf6] text-[#3b68a8] px-2.5 py-1">
                    <Sparkles className="size-3" />
                    系统优化
                  </span>
                )}
                {selectedUploaderFallback ? (
                  <span className="flex min-w-0 max-w-full items-start gap-1 rounded-xl bg-[#f5f4ed] border border-[#e8e6dc] text-[#5e5d59] px-2.5 py-1">
                    <User className="mt-1 size-3 shrink-0" />
                    {renderUploaderProfile(selectedUploaderProfile, selectedUploaderFallback, {
                      multiline: true
                    })}
                  </span>
                ) : null}
                {activeTab === "skill" && selectedSkillCallCount !== null && (
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-[#d7e2f5] bg-[linear-gradient(135deg,#f4f8ff_0%,#e9f1ff_100%)] text-[#365d97] px-3 py-1">
                    <BarChart3 className="size-3" />
                    <span className="text-[11px] text-[#6a7fa5]">调用次数</span>
                    <span className="font-semibold tabular-nums">{selectedSkillCallCount}</span>
                  </span>
                )}
                {activeTab === "skill" && selectedSkillUserCount !== null && (
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-[#cfe4d9] bg-[linear-gradient(135deg,#f2faf5_0%,#e8f7ef_100%)] text-[#2f7a55] px-3 py-1">
                    <User className="size-3" />
                    <span className="text-[11px] text-[#4c8669]">使用用户数</span>
                    <span className="font-semibold tabular-nums">{selectedSkillUserCount}</span>
                  </span>
                )}
              </div>

              <div className="grid grid-cols-2 gap-2 pt-1">
                {selectedItem.installed ? (
                  activeTab === "orgSkill" ? (
                    <span className="text-xs bg-[#edf7f0] border border-[#c4e8d1] text-[#2e7d4f] px-3 py-2 rounded-lg inline-flex items-center gap-1.5">
                      <CheckCircle className="size-3" />
                      已安装
                    </span>
                  ) : selectedItem.featured === "精品" ? (
                    <span className="col-span-2 text-xs bg-[#fdf3e7] border border-[#f5d9c4] text-[#c4956a] px-3 py-2 rounded-lg inline-flex items-center gap-1.5">
                      <Zap className="size-3" />
                      自动保持最新
                    </span>
                  ) : selectedItem.installDisabledReason ? (
                    <TooltipProvider delayDuration={180}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="col-span-2 inline-flex cursor-not-allowed">
                            <Button
                              variant="outline"
                              size="sm"
                              className="pointer-events-none h-8 w-full gap-1.5 text-xs rounded-lg text-[#9b8f80] border-[#e8e0d4] bg-[#f6f2ea] opacity-90"
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
                        className="market-update-bounce h-8 gap-1.5 text-xs rounded-lg cursor-pointer text-[#0f766e] border-[#78d7cb] bg-[#e5fbf7] hover:bg-[#d4f7f0]"
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
                      className="h-8 gap-1.5 text-xs rounded-lg cursor-pointer text-[#5e5d59] border-[#e8e6dc] bg-[#f5f4ed] hover:bg-[#e8e6dc]"
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
                            className="pointer-events-none h-8 w-full gap-1.5 text-xs bg-[#d8c8b5] text-[#faf9f5] border-0 rounded-lg opacity-85"
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
                    className="h-8 gap-1.5 text-xs bg-[#c4956a] hover:bg-[#b85a3a] text-[#faf9f5] border-0 shadow-[#c4956a_0px_0px_0px_0px,#c4956a_0px_0px_0px_1px] rounded-lg cursor-pointer"
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
                      className="h-8 gap-1.5 text-xs border-[#fad4d4] text-[#b53333] hover:text-[#b53333] hover:bg-[#fdf2f2] rounded-lg cursor-pointer"
                      onClick={() => onUninstall(selectedItem)}
                    >
                      <Trash2 className="size-3" />
                      卸载
                    </Button>
                  )}
                {activeTab !== "orgSkill" &&
                  (selectedItem.canDelete ||
                    (selectedItem.ip &&
                      localStorage.getItem("localIp") &&
                      selectedItem.ip === localStorage.getItem("localIp"))) && (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 gap-1.5 text-xs text-[#5e5d59] border-[#e8e6dc] bg-[#f5f4ed] hover:bg-[#e8e6dc] rounded-lg cursor-pointer"
                        onClick={() => onUpdate(selectedItem)}
                      >
                        <Edit className="size-3" />
                        编辑
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 gap-1.5 text-xs border-[#fad4d4] text-[#b53333] hover:text-[#b53333] hover:bg-[#fdf2f2] rounded-lg cursor-pointer"
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
              <div className="rounded-2xl border border-[#e8e6dc] bg-[#faf9f5] p-4 space-y-3 shadow-[rgba(0,0,0,0.03)_0px_2px_10px]">
                <div className="flex items-center justify-between">
                  <h4 className="text-[13px] font-medium text-[#141413]">使用用户明细（本月）</h4>
                  <div className="flex items-center gap-1.5">
                    <span className="inline-flex items-center gap-1 rounded-full border border-[#d7e2f5] bg-[#eef4ff] px-2 py-0.5 text-[11px] text-[#365d97]">
                      <BarChart3 className="size-3" />
                      <span className="tabular-nums">{selectedSkillCallCount ?? 0}</span>
                    </span>
                    <span className="inline-flex items-center gap-1 rounded-full border border-[#cfe4d9] bg-[#edf8f2] px-2 py-0.5 text-[11px] text-[#2f7a55]">
                      <User className="size-3" />
                      <span className="tabular-nums">{selectedSkillUserCount ?? 0}</span>
                    </span>
                  </div>
                </div>
                {skillUsageLoading ? (
                  <div className="flex items-center justify-center py-5 text-xs text-[#87867f]">
                    <div className="size-4 border-2 border-[#c4956a] border-t-transparent rounded-full animate-spin mr-2" />
                    加载中…
                  </div>
                ) : (
                  <div className="max-h-[260px] overflow-auto border border-[#f0eee6] rounded-xl">
                    <table className="w-full text-[12px]">
                      <thead className="bg-[#f5f4ed]">
                        <tr className="text-[#87867f]">
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
                            className="border-t border-[#f0eee6] text-[#5e5d59]"
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
                            <td colSpan={4} className="py-6 text-center text-[#87867f]">
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
              <div className="rounded-xl border border-[#f5d9c4] bg-[#fdf3e7] p-4 text-sm shadow-[rgba(0,0,0,0.03)_0px_2px_8px]">
                <div className="flex items-center gap-2 mb-2 text-[11px] uppercase tracking-[0.08em] text-[#c4956a] font-medium">
                  <Lightbulb className="size-3.5 shrink-0" />
                  <span>使用指引</span>
                </div>
                <p className="text-[#5e5d59] whitespace-pre-wrap leading-relaxed break-all text-[13px]">
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
