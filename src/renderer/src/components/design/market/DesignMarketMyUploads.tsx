import { Bell, Edit3, Eye, RotateCcw } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { MarketMyUploadsResponse } from "../../../../../shared/design-market"
import { formatMarketVersion } from "../../../../../shared/design-market-semver"

function templateStatusLabel(status: MarketMyUploadsResponse["templates"][number]["effectiveStatus"]) {
  switch (status) {
    case "published":
      return { text: "已上架", cls: "bg-emerald-500/12 text-emerald-700" }
    case "parent_unpublished":
      return { text: "所属系统已下架", cls: "bg-amber-500/15 text-amber-800" }
    case "hidden_by_system_owner":
      return { text: "已被系统作者隐藏", cls: "bg-amber-500/15 text-amber-800" }
    case "admin_removed":
      return { text: "已被平台下架", cls: "bg-destructive/15 text-destructive" }
    default:
      return { text: "未上架", cls: "bg-muted text-muted-foreground" }
  }
}

export function DesignMarketMyUploads({
  uploads,
  loading,
  onOpenSystem,
  onEditSystem,
  onDiscardSystemDraft,
  onToggleSystemStatus,
  onOpenTemplate,
  onEditTemplate,
  onDiscardTemplateDraft,
  onToggleTemplateStatus
}: {
  uploads: MarketMyUploadsResponse | null
  loading: boolean
  onOpenSystem: (systemId: string) => void
  onEditSystem: (systemId: string) => void
  onDiscardSystemDraft: (systemId: string) => void
  onToggleSystemStatus: (systemId: string, status: "published" | "unpublished") => void
  onOpenTemplate: (templateId: string) => void
  onEditTemplate: (templateId: string) => void
  onDiscardTemplateDraft: (templateId: string) => void
  onToggleTemplateStatus: (templateId: string, status: "published" | "unpublished") => void
}): React.JSX.Element {
  if (loading) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-background-elevated p-10 text-center text-sm text-muted-foreground">
        正在加载我的上传…
      </div>
    )
  }

  const systems = uploads?.systems ?? []
  const templates = uploads?.templates ?? []
  const notices = uploads?.notices ?? []

  return (
    <div className="space-y-6">
      {notices.length > 0 && (
        <section className="rounded-xl border border-border bg-background-elevated p-4 space-y-2">
          <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
            <Bell className="size-3.5 text-primary" />
            治理与状态通知
          </div>
          <div className="space-y-1.5">
            {notices.slice(0, 6).map((n) => (
              <div key={n.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted/40 px-3 py-2 text-xs">
                <span>
                  <strong>{n.assetName}</strong>：{n.reason}
                </span>
                <span className="text-[11px] text-muted-foreground">
                  {n.actorName} · {new Date(n.createdAt).toLocaleString("zh-CN")}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="space-y-3">
        <h3 className="text-sm font-semibold text-foreground">我上传的设计系统（{systems.length}）</h3>
        {systems.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border bg-background-elevated p-6 text-xs text-muted-foreground">
            暂未上传设计系统。
          </p>
        ) : (
          <div className="space-y-2.5">
            {systems.map((sys) => (
              <div
                key={sys.systemId}
                className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-background-elevated px-4 py-3"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-foreground">{sys.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {sys.latestVersion ? `线上 ${formatMarketVersion(sys.latestVersion)}` : "尚未发布"}
                    </span>
                    {sys.hasDraft && (
                      <span className="rounded bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-800">
                        有未发布草稿
                      </span>
                    )}
                    <span className="rounded bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                      {sys.status === "published" ? "已上架" : sys.status === "admin_removed" ? "平台已下架" : "已下架"}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{sys.description}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button type="button" size="sm" variant="ghost" onClick={() => onOpenSystem(sys.systemId)}>
                    <Eye className="size-3.5" />
                    查看
                  </Button>
                  <Button type="button" size="sm" variant="outline" onClick={() => onEditSystem(sys.systemId)}>
                    <Edit3 className="size-3.5" />
                    {sys.hasDraft ? "继续编辑草稿" : "编辑"}
                  </Button>
                  {sys.hasDraft && sys.latestVersionId && (
                    <Button type="button" size="sm" variant="ghost" onClick={() => onDiscardSystemDraft(sys.systemId)}>
                      <RotateCcw className="size-3.5" />
                      放弃草稿
                    </Button>
                  )}
                  {sys.latestVersionId && sys.status !== "admin_removed" && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        onToggleSystemStatus(sys.systemId, sys.status === "published" ? "unpublished" : "published")
                      }
                    >
                      {sys.status === "published" ? "下架" : "重新上架"}
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-semibold text-foreground">我上传的模板（{templates.length}）</h3>
        {templates.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border bg-background-elevated p-6 text-xs text-muted-foreground">
            暂未上传模板。可进入任意已上架的设计系统下上传模板。
          </p>
        ) : (
          <div className="space-y-2.5">
            {templates.map((tpl) => {
              const label = templateStatusLabel(tpl.effectiveStatus)
              return (
                <div
                  key={tpl.templateId}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-background-elevated px-4 py-3"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold text-foreground">{tpl.name}</span>
                      <span className="text-xs text-muted-foreground">所属：{tpl.systemName}</span>
                      <span className="text-xs text-muted-foreground">
                        {tpl.latestVersion ? `线上 ${formatMarketVersion(tpl.latestVersion)}` : "尚未发布"}
                      </span>
                      {tpl.hasDraft && (
                        <span className="rounded bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-800">
                          有未发布草稿
                        </span>
                      )}
                      <span className={`rounded px-2 py-0.5 text-[11px] font-medium ${label.cls}`}>
                        {label.text}
                      </span>
                    </div>
                    {tpl.visibilityReason && (
                      <p className="mt-1 text-xs text-amber-700">隐藏原因：{tpl.visibilityReason}</p>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button type="button" size="sm" variant="ghost" onClick={() => onOpenTemplate(tpl.templateId)}>
                      <Eye className="size-3.5" />
                      查看
                    </Button>
                    <Button type="button" size="sm" variant="outline" onClick={() => onEditTemplate(tpl.templateId)}>
                      <Edit3 className="size-3.5" />
                      {tpl.hasDraft ? "继续编辑草稿" : "编辑"}
                    </Button>
                    {tpl.hasDraft && tpl.latestVersionId && (
                      <Button type="button" size="sm" variant="ghost" onClick={() => onDiscardTemplateDraft(tpl.templateId)}>
                        <RotateCcw className="size-3.5" />
                        放弃草稿
                      </Button>
                    )}
                    {tpl.latestVersionId && tpl.status !== "admin_removed" && (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={tpl.status !== "published" && tpl.parentStatus !== "published"}
                        onClick={() =>
                          onToggleTemplateStatus(
                            tpl.templateId,
                            tpl.status === "published" ? "unpublished" : "published"
                          )
                        }
                      >
                        {tpl.status === "published" ? "下架" : "重新上架"}
                      </Button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </section>
    </div>
  )
}
