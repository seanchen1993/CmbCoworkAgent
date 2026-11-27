import { useMemo, useState } from "react"
import {
  CheckCircle2,
  ChevronDown,
  Download,
  Edit3,
  Eye,
  EyeOff,
  Info,
  Layers,
  Plus,
  Search,
  ShieldAlert
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { MarkdownPreview } from "@/components/ui/MarkdownPreview/MarkdownPreview"
import { cn } from "@/lib/utils"
import {
  DESIGN_MARKET_SCENARIOS,
  type DesignMarketScenario,
  type LocalMarketAssetsState,
  type MarketSystemDetail,
  type MarketTemplateSummary
} from "../../../../../shared/design-market"
import { formatMarketVersion } from "../../../../../shared/design-market-semver"

export function DesignMarketSystemDetail({
  detail,
  downloaded,
  downloadingKey,
  onBack,
  onEditSystem,
  onUploadTemplate,
  onOpenTemplate,
  onEditTemplate,
  onDownloadSystem,
  onDownloadTemplate,
  onToggleTemplateVisibility,
  onAdminAction
}: {
  detail: MarketSystemDetail
  downloaded: LocalMarketAssetsState
  downloadingKey: string | null
  onBack: () => void
  onEditSystem: () => void
  onUploadTemplate: () => void
  onOpenTemplate: (templateId: string) => void
  onEditTemplate: (templateId: string) => void
  onDownloadSystem: (systemId: string, versionId?: string) => void
  onDownloadTemplate: (template: MarketTemplateSummary) => void
  onToggleTemplateVisibility: (
    templateId: string,
    visibility: "visible" | "hidden_by_system_owner",
    reason?: string
  ) => Promise<void>
  onAdminAction: (action: "takedown" | "restore", reason: string) => Promise<void>
}): React.JSX.Element {
  const { system, markdown, versions, templates } = detail
  const [tab, setTab] = useState<"spec" | "templates" | "versions">("templates")
  const [tplSearch, setTplSearch] = useState("")
  const [scenario, setScenario] = useState<DesignMarketScenario | "全部">("全部")
  const [versionMenuOpen, setVersionMenuOpen] = useState(false)
  const [hideTarget, setHideTarget] = useState<MarketTemplateSummary | null>(null)
  const [hideReason, setHideReason] = useState("")
  const [hideBusy, setHideBusy] = useState(false)

  const localSysVersions = downloaded.systems.filter(
    (item) => item.systemId === system.systemId && !item.removedFromPicker
  )
  const hasLatestSys =
    system.latestVersionId != null &&
    localSysVersions.some((item) => item.versionId === system.latestVersionId)

  const filteredTemplates = useMemo(() => {
    const q = tplSearch.trim().toLowerCase()
    return templates.filter((tpl) => {
      if (scenario !== "全部" && tpl.scenario !== scenario) return false
      if (!q) return true
      return (
        tpl.name.toLowerCase().includes(q) ||
        tpl.description.toLowerCase().includes(q) ||
        tpl.ownerName.toLowerCase().includes(q)
      )
    })
  }, [scenario, templates, tplSearch])

  const submitHide = async () => {
    if (!hideTarget || !hideReason.trim()) return
    setHideBusy(true)
    try {
      await onToggleTemplateVisibility(hideTarget.templateId, "hidden_by_system_owner", hideReason.trim())
      setHideTarget(null)
      setHideReason("")
    } finally {
      setHideBusy(false)
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <button type="button" className="hover:text-foreground" onClick={onBack}>
          设计市场
        </button>
        <span>&gt;</span>
        <span className="font-medium text-foreground">{system.name}</span>
      </div>

      <section className="rounded-xl border border-border bg-background-elevated p-5 shadow-xs">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-4">
            <span
              className="flex size-12 shrink-0 items-center justify-center rounded-xl border border-border"
              style={{ backgroundColor: `${system.palette[0]}18` }}
            >
              <Layers className="size-6 text-primary" />
            </span>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-xl font-semibold text-foreground">{system.name}</h2>
                {system.status !== "published" && (
                  <span className="rounded bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-800">
                    {system.status === "admin_removed" ? "已被平台下架" : "已下架"}
                  </span>
                )}
              </div>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">{system.description}</p>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span>{system.ownerName}</span>
                <span>·</span>
                <span>{system.latestVersion ? formatMarketVersion(system.latestVersion) : "草稿"}</span>
                <span>·</span>
                <span className="rounded border border-border bg-muted/40 px-2 py-0.5 text-[11px]">
                  {system.category}
                </span>
              </div>
            </div>
          </div>

          <div className="relative flex flex-wrap items-center gap-2">
            {hasLatestSys && (
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/12 px-2.5 py-1 text-xs font-medium text-emerald-700">
                <CheckCircle2 className="size-3.5" />
                已下载
              </span>
            )}
            {system.canEdit && (
              <Button type="button" variant="outline" size="sm" onClick={onEditSystem}>
                <Edit3 className="size-3.5" />
                编辑设计系统
              </Button>
            )}
            {system.canModerate && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  void onAdminAction(
                    system.status === "admin_removed" ? "restore" : "takedown",
                    system.status === "admin_removed" ? "平台管理员审核恢复" : "平台管理员应急下架"
                  )
                }
              >
                <ShieldAlert className="size-3.5" />
                {system.status === "admin_removed" ? "管理员恢复" : "应急下架"}
              </Button>
            )}
            {system.status === "published" && (
              <div className="relative">
                {hasLatestSys ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setVersionMenuOpen((open) => !open)}
                  >
                    查看下载版本
                    <ChevronDown className="size-3.5" />
                  </Button>
                ) : (
                  <div className="flex items-center gap-1.5">
                    <Button
                      type="button"
                      size="sm"
                      disabled={Boolean(downloadingKey)}
                      onClick={() => onDownloadSystem(system.systemId, system.latestVersionId ?? undefined)}
                    >
                      <Download className="size-3.5" />
                      下载设计系统
                    </Button>
                    {versions.length > 1 && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        aria-label="选择系统下载版本"
                        onClick={() => setVersionMenuOpen((open) => !open)}
                      >
                        <ChevronDown className="size-3.5" />
                      </Button>
                    )}
                  </div>
                )}
                {versionMenuOpen && (
                  <div className="absolute right-0 top-10 z-20 w-60 rounded-lg border border-border bg-background-elevated p-2 shadow-lg">
                    <p className="px-2 py-1 text-[11px] font-medium text-muted-foreground">
                      选择版本下载
                    </p>
                    {versions.map((ver) => {
                      const installed = localSysVersions.some((item) => item.versionId === ver.versionId)
                      return (
                        <div
                          key={ver.versionId}
                          className="flex items-center justify-between rounded-md px-2 py-1.5 text-xs hover:bg-muted/50"
                        >
                          <span className="font-medium">{formatMarketVersion(ver.version)}</span>
                          {installed ? (
                            <span className="text-[11px] text-emerald-700">已下载</span>
                          ) : (
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              className="h-6 px-2 text-[11px]"
                              disabled={Boolean(downloadingKey)}
                              onClick={() => {
                                setVersionMenuOpen(false)
                                onDownloadSystem(system.systemId, ver.versionId)
                              }}
                            >
                              下载
                            </Button>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </section>

      <div className="flex items-center gap-6 border-b border-border text-sm">
        {(
          [
            ["spec", "设计规范"],
            ["templates", "模板市场"],
            ["versions", "版本记录"]
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={cn(
              "-mb-px border-b-2 pb-2.5 text-xs font-semibold transition-colors",
              tab === key
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "spec" && (
        <div className="rounded-xl border border-border bg-background-elevated p-5">
          <MarkdownPreview content={markdown} showHeader={false} showModeToggle={false} defaultExpanded />
        </div>
      )}

      {tab === "templates" && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative min-w-[240px] flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={tplSearch}
                onChange={(event) => setTplSearch(event.target.value)}
                placeholder={`搜索${system.name}的模板`}
                aria-label={`搜索${system.name}的模板`}
                className="h-9 bg-background-elevated pl-9"
              />
            </div>
            <select
              aria-label="按场景筛选模板"
              value={scenario}
              onChange={(event) => setScenario(event.target.value as DesignMarketScenario | "全部")}
              className="h-9 rounded-lg border border-border bg-background-elevated px-3 text-xs text-foreground"
            >
              <option value="全部">全部场景</option>
              {DESIGN_MARKET_SCENARIOS.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
            {system.status === "published" && (
              <Button type="button" size="sm" onClick={onUploadTemplate}>
                <Plus className="size-3.5" />
                上传模板
              </Button>
            )}
          </div>

          <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/35 px-3 py-2 text-xs text-muted-foreground">
            <Info className="size-3.5 shrink-0" />
            <span>下载的模板会出现在「新建设计」中。缺少适配的设计系统版本时会一并下载。</span>
          </div>

          {hideTarget && (
            <div className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-4 space-y-2">
              <p className="text-xs font-medium text-foreground">
                隐藏模板「{hideTarget.name}」在市场中的展示（记录原因并通知作者 {hideTarget.ownerName}）
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  value={hideReason}
                  onChange={(event) => setHideReason(event.target.value)}
                  placeholder="请输入隐藏展示原因（必填）"
                  className="h-8 flex-1 bg-background"
                />
                <Button
                  type="button"
                  size="sm"
                  disabled={hideBusy || !hideReason.trim()}
                  onClick={() => void submitHide()}
                >
                  确认隐藏
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={hideBusy}
                  onClick={() => {
                    setHideTarget(null)
                    setHideReason("")
                  }}
                >
                  取消
                </Button>
              </div>
            </div>
          )}

          {filteredTemplates.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border bg-background-elevated p-10 text-center text-xs text-muted-foreground">
              当前条件下暂无可展示模板。
            </div>
          ) : (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {filteredTemplates.map((tpl) => {
                const downloadedEntry = downloaded.templates.find(
                  (item) =>
                    !item.removedFromPicker &&
                    item.templateId === tpl.templateId &&
                    item.versionId === tpl.latestVersionId
                )
                const anyLocal = downloaded.templates.some(
                  (item) => !item.removedFromPicker && item.templateId === tpl.templateId
                )
                const isHidden = tpl.effectiveStatus === "hidden_by_system_owner"
                return (
                  <div
                    key={tpl.templateId}
                    data-testid={`market-template-card-${tpl.templateId}`}
                    className={cn(
                      "flex flex-col overflow-hidden rounded-xl border border-border bg-background-elevated shadow-xs",
                      isHidden && "opacity-75"
                    )}
                  >
                    <div className="h-44 w-full overflow-hidden border-b border-border bg-muted/20">
                      {tpl.coverDataUrl ? (
                        <img
                          src={tpl.coverDataUrl}
                          alt={`${tpl.name}静态封面`}
                          className="h-full w-full object-cover object-top"
                        />
                      ) : (
                        <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                          暂无静态预览
                        </div>
                      )}
                    </div>
                    <div className="flex flex-1 flex-col p-4">
                      <div className="flex items-start justify-between gap-2">
                        <h3 className="text-sm font-semibold text-foreground">{tpl.name}</h3>
                        <span className="shrink-0 rounded border border-border bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground">
                          {tpl.scenario}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {tpl.ownerName} ·{" "}
                        {tpl.latestVersion ? formatMarketVersion(tpl.latestVersion) : "未发布"}
                        {tpl.canEdit ? " · 本人上传" : ""}
                      </p>
                      {tpl.effectiveStatus !== "published" && (
                        <p className="mt-1 text-[11px] font-medium text-amber-700">
                          {tpl.effectiveStatus === "hidden_by_system_owner"
                            ? `已由系统作者隐藏${tpl.visibilityReason ? `：${tpl.visibilityReason}` : ""}`
                            : tpl.effectiveStatus === "parent_unpublished"
                              ? "所属系统已下架"
                              : tpl.effectiveStatus === "admin_removed"
                                ? "已被平台下架"
                                : "未上架"}
                        </p>
                      )}
                      <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5">
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="h-8 gap-1 px-2.5 text-xs"
                            onClick={() => onOpenTemplate(tpl.templateId)}
                          >
                            <Eye className="size-3.5" />
                            详情与预览
                          </Button>
                          {tpl.canSystemOwnerManage && tpl.latestVersionId && (
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              className="h-8 gap-1 px-2 text-xs"
                              onClick={() => {
                                if (tpl.visibility === "hidden_by_system_owner") {
                                  void onToggleTemplateVisibility(tpl.templateId, "visible", "恢复展示")
                                } else {
                                  setHideTarget(tpl)
                                  setHideReason("")
                                }
                              }}
                            >
                              {tpl.visibility === "hidden_by_system_owner" ? (
                                <>
                                  <Eye className="size-3.5" />
                                  恢复展示
                                </>
                              ) : (
                                <>
                                  <EyeOff className="size-3.5" />
                                  隐藏
                                </>
                              )}
                            </Button>
                          )}
                        </div>
                        <div className="flex items-center gap-1.5">
                          {tpl.canEdit && (
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              className="h-8 gap-1 px-2.5 text-xs"
                              onClick={() => onEditTemplate(tpl.templateId)}
                            >
                              <Edit3 className="size-3.5" />
                              编辑
                            </Button>
                          )}
                          {tpl.effectiveStatus === "published" &&
                            (downloadedEntry ? (
                              <span className="inline-flex items-center gap-1 rounded-md bg-emerald-500/12 px-2 py-1 text-[11px] font-medium text-emerald-700">
                                <CheckCircle2 className="size-3" />
                                已下载
                              </span>
                            ) : (
                              <Button
                                type="button"
                                size="sm"
                                variant="secondary"
                                className="h-8 gap-1 px-2.5 text-xs"
                                disabled={Boolean(downloadingKey)}
                                onClick={() => onDownloadTemplate(tpl)}
                              >
                                <Download className="size-3.5" />
                                {anyLocal ? "更新模板" : "下载模板"}
                              </Button>
                            ))}
                        </div>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {tab === "versions" && (
        <div className="space-y-3">
          {versions.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border bg-background-elevated p-8 text-center text-xs text-muted-foreground">
              暂无已发布版本。
            </div>
          ) : (
            versions.map((ver) => {
              const installed = localSysVersions.some((item) => item.versionId === ver.versionId)
              return (
                <div
                  key={ver.versionId}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-background-elevated px-4 py-3"
                >
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold">{formatMarketVersion(ver.version)}</span>
                      {ver.versionId === system.latestVersionId && (
                        <span className="rounded bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
                          当前版本
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">{ver.changelog}</p>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      {ver.createdByName} · {new Date(ver.createdAt).toLocaleString("zh-CN")}
                    </p>
                  </div>
                  {system.status === "published" &&
                    (installed ? (
                      <span className="inline-flex items-center gap-1 rounded-md bg-emerald-500/12 px-2.5 py-1 text-xs font-medium text-emerald-700">
                        <CheckCircle2 className="size-3.5" />
                        已下载
                      </span>
                    ) : (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={Boolean(downloadingKey)}
                        onClick={() => onDownloadSystem(system.systemId, ver.versionId)}
                      >
                        <Download className="size-3.5" />
                        下载此版本
                      </Button>
                    ))}
                </div>
              )
            })
          )}
        </div>
      )}
    </div>
  )
}
