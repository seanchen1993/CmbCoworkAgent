import { CheckCircle2, ChevronRight, Download, Layers, RefreshCw, Search } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import type {
  DesignMarketCategory,
  LocalMarketAssetsState,
  MarketCatalogResponse,
  MarketSystemSummary,
  MarketTemplateSummary
} from "../../../../../shared/design-market"
import { formatMarketVersion } from "../../../../../shared/design-market-semver"

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function DesignMarketHome({
  catalog,
  downloaded,
  query,
  category,
  loading,
  downloadingKey,
  onQueryChange,
  onCategoryChange,
  onOpenSystem,
  onOpenTemplate,
  onDownloadSystem,
  onDownloadTemplate
}: {
  catalog: MarketCatalogResponse | null
  downloaded: LocalMarketAssetsState
  query: string
  category: DesignMarketCategory | "全部"
  loading: boolean
  downloadingKey: string | null
  onQueryChange: (q: string) => void
  onCategoryChange: (c: DesignMarketCategory | "全部") => void
  onOpenSystem: (systemId: string) => void
  onOpenTemplate: (templateId: string) => void
  onDownloadSystem: (system: MarketSystemSummary) => void
  onDownloadTemplate: (template: MarketTemplateSummary) => void
}): React.JSX.Element {
  const categories: Array<DesignMarketCategory | "全部"> = [
    "全部",
    ...(catalog?.categories ?? ["企业应用", "移动端", "数据展示", "通用"])
  ]
  const counts = catalog?.categoryCounts ?? { 全部: 0 }
  const systems = catalog?.systems ?? []

  const downloadedSystemMap = new Map<string, LocalMarketAssetsState["systems"]>()
  for (const sys of downloaded.systems) {
    if (sys.removedFromPicker) continue
    const list = downloadedSystemMap.get(sys.systemId) ?? []
    list.push(sys)
    downloadedSystemMap.set(sys.systemId, list)
  }
  const downloadedTemplateMap = new Map<string, LocalMarketAssetsState["templates"]>()
  for (const tpl of downloaded.templates) {
    if (tpl.removedFromPicker) continue
    const list = downloadedTemplateMap.get(tpl.templateId) ?? []
    list.push(tpl)
    downloadedTemplateMap.set(tpl.templateId, list)
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-[260px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="搜索设计系统或模板"
            aria-label="搜索设计系统或模板"
            className="h-10 bg-background-elevated pl-9"
          />
        </div>
        <span className="inline-flex h-10 items-center rounded-lg border border-border bg-background-elevated px-3 text-xs font-medium text-muted-foreground">
          最近更新
        </span>
      </div>

      <div className="grid gap-5 lg:grid-cols-[190px_minmax(0,1fr)]">
        <aside className="rounded-xl border border-border bg-background-elevated p-3 self-start">
          <p className="px-2 pb-2 text-xs font-semibold text-muted-foreground">分类</p>
          <div className="space-y-1" role="tablist" aria-label="设计系统分类">
            {categories.map((item) => {
              const active = category === item
              return (
                <button
                  key={item}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => onCategoryChange(item)}
                  className={cn(
                    "flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-xs font-medium transition-colors",
                    active
                      ? "bg-primary/15 text-foreground font-semibold"
                      : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                  )}
                >
                  <span>{item}</span>
                  <span className="text-[11px] tabular-nums opacity-75">{counts[item] ?? 0}</span>
                </button>
              )
            })}
          </div>
        </aside>

        <div>
          <div className="mb-3 flex items-center justify-between text-xs text-muted-foreground">
            <span>{systems.length} 个设计系统</span>
          </div>

          {loading ? (
            <div className="rounded-xl border border-dashed border-border bg-background-elevated p-12 text-center text-sm text-muted-foreground">
              正在加载设计市场…
            </div>
          ) : systems.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border bg-background-elevated p-12 text-center text-sm text-muted-foreground">
              没有找到匹配的设计系统或模板。
            </div>
          ) : (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {systems.map((sys) => {
                const localVersions = downloadedSystemMap.get(sys.systemId) ?? []
                const hasLatest =
                  sys.latestVersionId != null &&
                  localVersions.some((item) => item.versionId === sys.latestVersionId)
                const hasAny = localVersions.length > 0
                const updateAvailable = hasAny && !hasLatest
                const isDownloading = downloadingKey === `system:${sys.systemId}:${sys.latestVersionId}`
                const accent = sys.palette[0] || "#3B6BE0"

                return (
                  <div
                    key={sys.systemId}
                    data-testid={`market-system-card-${sys.systemId}`}
                    className="flex flex-col overflow-hidden rounded-xl border border-border bg-background-elevated shadow-xs transition-colors hover:border-border-emphasis"
                  >
                    <div
                      className="flex items-center justify-between px-4 py-4"
                      style={{ backgroundColor: `${accent}16` }}
                    >
                      <span className="inline-flex size-9 items-center justify-center rounded-lg border border-border/60 bg-background-elevated text-primary shadow-2xs">
                        <Layers className="size-4" />
                      </span>
                      <div className="flex items-center gap-1 rounded-md border border-border/50 bg-background-elevated/90 px-1.5 py-1">
                        {sys.palette.map((color, idx) => (
                          <span
                            key={`${sys.systemId}-swatch-${idx}`}
                            title={color}
                            className="size-4 rounded-xs border border-black/10"
                            style={{ backgroundColor: color }}
                          />
                        ))}
                      </div>
                    </div>

                    <div className="flex flex-1 flex-col p-4">
                      <div className="flex items-start justify-between gap-2">
                        <h3 className="text-sm font-semibold text-foreground">{sys.name}</h3>
                        <span className="shrink-0 text-xs font-medium text-muted-foreground">
                          {sys.latestVersion ? formatMarketVersion(sys.latestVersion) : "未发布"}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {sys.ownerName} · {sys.templateCount} 个模板
                      </p>
                      <p className="mt-2 line-clamp-2 text-xs leading-5 text-muted-foreground">
                        {sys.description}
                      </p>

                      {sys.matchedTemplates && sys.matchedTemplates.length > 0 && (
                        <div className="mt-3 space-y-2 rounded-lg border border-border/70 bg-muted/30 p-2.5">
                          <p className="text-[11px] font-medium text-muted-foreground">
                            匹配到的所属模板（{sys.matchedTemplates.length}）
                          </p>
                          {sys.matchedTemplates.map((tpl) => {
                            const tplDownloaded = (downloadedTemplateMap.get(tpl.templateId) ?? []).some(
                              (item) => item.versionId === tpl.latestVersionId
                            )
                            return (
                              <div
                                key={tpl.templateId}
                                className="flex items-center gap-2 rounded-md border border-border bg-background px-2 py-1.5"
                              >
                                {tpl.coverDataUrl && (
                                  <img
                                    src={tpl.coverDataUrl}
                                    alt={tpl.name}
                                    className="h-8 w-12 shrink-0 rounded border border-border/60 object-cover"
                                  />
                                )}
                                <div className="min-w-0 flex-1">
                                  <p className="truncate text-xs font-medium text-foreground">
                                    {tpl.name}
                                  </p>
                                  <p className="truncate text-[10px] text-muted-foreground">
                                    {tpl.ownerName} ·{" "}
                                    {tpl.latestVersion
                                      ? formatMarketVersion(tpl.latestVersion)
                                      : ""}{" "}
                                    · {formatBytes(tpl.totalBytes)}
                                  </p>
                                </div>
                                <div className="flex shrink-0 items-center gap-1">
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="ghost"
                                    className="h-7 px-2 text-[11px]"
                                    onClick={() => onOpenTemplate(tpl.templateId)}
                                  >
                                    模板详情
                                  </Button>
                                  {tplDownloaded ? (
                                    <span className="inline-flex items-center gap-1 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">
                                      已下载
                                    </span>
                                  ) : (
                                    <Button
                                      type="button"
                                      size="sm"
                                      variant="outline"
                                      className="h-7 px-2 text-[11px]"
                                      disabled={Boolean(downloadingKey)}
                                      onClick={() => onDownloadTemplate(tpl)}
                                    >
                                      下载
                                    </Button>
                                  )}
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      )}

                      <div className="mt-4 flex items-center justify-between gap-2 pt-1">
                        {hasLatest ? (
                          <span className="inline-flex items-center gap-1 rounded-md bg-emerald-500/12 px-2 py-1 text-[11px] font-medium text-emerald-700">
                            <CheckCircle2 className="size-3" />
                            已下载
                          </span>
                        ) : (
                          <span className="inline-flex items-center rounded-md border border-border bg-muted/40 px-2 py-1 text-[11px] text-muted-foreground">
                            {sys.category}
                          </span>
                        )}

                        <div className="flex items-center gap-1.5">
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="h-8 gap-1 px-2.5 text-xs"
                            onClick={() => onOpenSystem(sys.systemId)}
                          >
                            详情
                            <ChevronRight className="size-3.5" />
                          </Button>
                          {!hasLatest && (
                            <Button
                              type="button"
                              size="sm"
                              variant="secondary"
                              className="h-8 gap-1 px-2.5 text-xs"
                              disabled={Boolean(downloadingKey)}
                              onClick={() => onDownloadSystem(sys)}
                            >
                              {updateAvailable ? (
                                <>
                                  <RefreshCw className="size-3.5" />
                                  更新
                                </>
                              ) : (
                                <>
                                  <Download className="size-3.5" />
                                  {isDownloading ? "下载中" : "下载"}
                                </>
                              )}
                            </Button>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
