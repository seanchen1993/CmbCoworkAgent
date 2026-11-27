import { useEffect, useState } from "react"
import {
  CheckCircle2,
  Copy,
  Download,
  Edit3,
  ExternalLink,
  Info,
  ShieldAlert
} from "lucide-react"
import { Button } from "@/components/ui/button"
import type {
  DesignMarketDownloadPlan,
  LocalMarketAssetsState,
  MarketTemplateDetail
} from "../../../../../shared/design-market"
import {
  formatCompatibilityRange,
  formatMarketVersion
} from "../../../../../shared/design-market-semver"

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function DesignMarketTemplateDetail({
  detail,
  downloaded,
  selectedLocalSystemId,
  downloadingKey,
  onBackToMarket,
  onBackToSystem,
  onEditTemplate,
  onDownloadVersion,
  onSaveLocalCopy,
  onPreviewLocal,
  onAdminAction
}: {
  detail: MarketTemplateDetail
  downloaded: LocalMarketAssetsState
  selectedLocalSystemId?: string | null
  downloadingKey: string | null
  onBackToMarket: () => void
  onBackToSystem: (systemId: string) => void
  onEditTemplate: () => void
  onDownloadVersion: (templateId: string, versionId?: string) => void
  onSaveLocalCopy: (localTemplateId: string) => void
  onPreviewLocal: (localTemplateId: string, entryPath?: string) => void
  onAdminAction: (action: "takedown" | "restore", reason: string) => Promise<void>
}): React.JSX.Element {
  const { template, system, versions } = detail
  const [plan, setPlan] = useState<DesignMarketDownloadPlan | null>(null)

  const latestLocal = downloaded.templates.find(
    (item) =>
      !item.removedFromPicker &&
      item.templateId === template.templateId &&
      item.versionId === template.latestVersionId
  )
  const anyLocal = downloaded.templates.find(
    (item) => !item.removedFromPicker && item.templateId === template.templateId
  )
  const latestVersionRecord =
    versions.find((v) => v.versionId === template.latestVersionId) ?? versions[0]
  const staticCover = latestVersionRecord?.coverDataUrl || template.coverDataUrl

  useEffect(() => {
    let active = true
    const api = window.api?.designMarket
    if (!api || template.effectiveStatus !== "published" || !template.latestVersionId) {
      setPlan(null)
      return
    }
    void api
      .planDownload("template", template.templateId, template.latestVersionId, selectedLocalSystemId)
      .then((res) => {
        if (active && res.success && res.data) setPlan(res.data)
      })
      .catch(() => {
        if (active) setPlan(null)
      })
    return () => {
      active = false
    }
  }, [selectedLocalSystemId, template.effectiveStatus, template.latestVersionId, template.templateId])

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <button type="button" className="hover:text-foreground" onClick={onBackToMarket}>
          设计市场
        </button>
        <span>&gt;</span>
        <button
          type="button"
          className="hover:text-foreground"
          onClick={() => onBackToSystem(system.systemId)}
        >
          {system.name}
        </button>
        <span>&gt;</span>
        <span>模板市场</span>
        <span>&gt;</span>
        <span className="font-medium text-foreground">{template.name}</span>
      </div>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold text-foreground">{template.name}</h2>
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>{template.ownerName}</span>
            <span>·</span>
            <span>
              {template.latestVersion ? formatMarketVersion(template.latestVersion) : "未发布"}
            </span>
            <span className="rounded border border-border bg-muted/40 px-2 py-0.5 text-[11px]">
              {template.scenario}
            </span>
          </div>
          {template.effectiveStatus !== "published" && (
            <p className="mt-2 text-xs font-medium text-amber-700">
              {template.effectiveStatus === "hidden_by_system_owner"
                ? `已被系统作者隐藏${template.visibilityReason ? `：${template.visibilityReason}` : ""}`
                : template.effectiveStatus === "parent_unpublished"
                  ? "所属设计系统已下架，暂不可新增下载"
                  : template.effectiveStatus === "admin_removed"
                    ? "已被平台管理员下架"
                    : "尚未上架"}
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {template.canEdit && (
            <Button type="button" variant="outline" size="sm" onClick={onEditTemplate}>
              <Edit3 className="size-3.5" />
              编辑模板
            </Button>
          )}
          {template.canModerate && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                void onAdminAction(
                  template.status === "admin_removed" ? "restore" : "takedown",
                  template.status === "admin_removed" ? "平台管理员审核恢复" : "平台管理员应急下架"
                )
              }
            >
              <ShieldAlert className="size-3.5" />
              {template.status === "admin_removed" ? "管理员恢复" : "应急下架"}
            </Button>
          )}
          {(latestLocal || anyLocal) && (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onPreviewLocal((latestLocal || anyLocal)!.localId)}
              >
                <ExternalLink className="size-3.5" />
                交互预览
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onSaveLocalCopy((latestLocal || anyLocal)!.localId)}
              >
                <Copy className="size-3.5" />
                另存为本地副本
              </Button>
            </>
          )}
          {template.effectiveStatus === "published" &&
            (latestLocal ? (
              <span className="inline-flex items-center gap-1 rounded-lg bg-emerald-500/12 px-3 py-1.5 text-xs font-medium text-emerald-700">
                <CheckCircle2 className="size-3.5" />
                已下载最新版
              </span>
            ) : plan && !plan.compatible ? (
              <span className="inline-flex items-center gap-1 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs font-medium text-amber-800">
                缺少适配版本
              </span>
            ) : (
              <Button
                type="button"
                size="sm"
                disabled={Boolean(downloadingKey)}
                onClick={() => onDownloadVersion(template.templateId, template.latestVersionId ?? undefined)}
              >
                <Download className="size-3.5" />
                {anyLocal ? "更新模板" : "下载模板"}
              </Button>
            ))}
        </div>
      </div>

      {plan && !latestLocal && template.effectiveStatus === "published" && (
        <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/35 px-3 py-2 text-xs text-muted-foreground">
          <Info className="size-3.5 shrink-0" />
          <span>
            {!plan.compatible
              ? plan.missingReason
              : plan.willDownloadSystem && plan.systemToDownload
                ? `将同时下载所属设计系统「${plan.systemToDownload.name}」${formatMarketVersion(plan.systemToDownload.version)}（约 ${formatBytes(plan.systemToDownload.bytes)}）`
                : `本地已有兼容的所属设计系统（${plan.reusedSystemVersion ? formatMarketVersion(plan.reusedSystemVersion) : "兼容版本"}），本次仅下载模板包。`}
          </span>
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.4fr)_minmax(280px,1fr)]">
        <section className="rounded-xl border border-border bg-background-elevated p-5 space-y-3">
          <h3 className="text-sm font-semibold text-foreground">页面预览</h3>
          <div>
            <span className="inline-flex items-center rounded-md bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary">
              {template.defaultEntryPath} · 默认入口
            </span>
          </div>
          <div className="overflow-hidden rounded-lg border border-border bg-white">
            {staticCover ? (
              <img
                src={staticCover}
                alt={`${template.name}静态预览`}
                className="w-full max-h-[520px] object-contain"
              />
            ) : (
              <div className="flex h-64 items-center justify-center text-xs text-muted-foreground">
                暂无静态封面图片
              </div>
            )}
          </div>
        </section>

        <div className="space-y-4">
          <section className="rounded-xl border border-border bg-background-elevated p-5 space-y-3">
            <h3 className="text-sm font-semibold text-foreground">模板信息</h3>
            <p className="text-xs leading-5 text-muted-foreground">{template.description}</p>
            <dl className="space-y-2.5 pt-1 text-xs">
              <div className="flex items-center justify-between gap-3">
                <dt className="text-muted-foreground">所属设计系统</dt>
                <dd>
                  <button
                    type="button"
                    className="font-medium text-primary hover:underline"
                    onClick={() => onBackToSystem(system.systemId)}
                  >
                    {system.name}
                  </button>
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-muted-foreground">适配规范</dt>
                <dd className="font-medium text-foreground">
                  {formatCompatibilityRange(template.minSystemVersion)}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-muted-foreground">技术栈</dt>
                <dd className="font-medium text-foreground">{template.framework}</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-muted-foreground">包体积</dt>
                <dd className="font-medium text-foreground">{formatBytes(template.totalBytes)}</dd>
              </div>
              <div className="flex items-start justify-between gap-3">
                <dt className="shrink-0 text-muted-foreground">页面入口</dt>
                <dd className="text-right font-mono text-[11px] text-foreground">
                  {template.pages.join("、") || template.defaultEntryPath}
                </dd>
              </div>
            </dl>
          </section>

          <section className="rounded-xl border border-border bg-background-elevated p-5 space-y-3">
            <h3 className="text-sm font-semibold text-foreground">版本记录</h3>
            {versions.length === 0 ? (
              <p className="text-xs text-muted-foreground">暂无已发布版本。</p>
            ) : (
              <div className="space-y-3 divide-y divide-border/60">
                {versions.map((ver) => {
                  const installed = downloaded.templates.some(
                    (item) =>
                      !item.removedFromPicker &&
                      item.templateId === template.templateId &&
                      item.versionId === ver.versionId
                  )
                  return (
                    <div key={ver.versionId} className="flex items-start justify-between gap-3 pt-3 first:pt-0">
                      <div className="min-w-0">
                        <p className="text-xs font-semibold text-foreground">
                          {formatMarketVersion(ver.version)}
                          <span className="ml-2 font-normal text-muted-foreground">
                            适配 {formatMarketVersion(ver.minSystemVersion)}+
                          </span>
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">{ver.changelog}</p>
                      </div>
                      {ver.versionId === template.latestVersionId && (
                        <span className="shrink-0 rounded border border-border bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground">
                          当前版本
                        </span>
                      )}
                      {installed ? (
                        <span className="shrink-0 text-[11px] font-medium text-emerald-700">
                          已下载
                        </span>
                      ) : template.effectiveStatus === "published" ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="h-7 shrink-0 px-2.5 text-[11px]"
                          disabled={Boolean(downloadingKey)}
                          onClick={() => onDownloadVersion(template.templateId, ver.versionId)}
                        >
                          <Download className="size-3" />
                          下载此版本
                        </Button>
                      ) : null}
                    </div>
                  )
                })}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
