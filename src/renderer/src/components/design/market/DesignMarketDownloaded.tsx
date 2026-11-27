import { useState } from "react"
import {
  AlertTriangle,
  Copy,
  Download,
  ExternalLink,
  RefreshCw,
  RotateCcw,
  Trash2
} from "lucide-react"
import { Button } from "@/components/ui/button"
import type { LocalMarketAssetsState } from "../../../../../shared/design-market"
import { formatMarketVersion } from "../../../../../shared/design-market-semver"

export function DesignMarketDownloaded({
  downloaded,
  downloadingKey,
  onUpdateSystem,
  onUpdateTemplate,
  onRepairSystemForTemplate,
  onRemoveSystem,
  onRestoreSystem,
  onRemoveTemplate,
  onRestoreTemplate,
  onCopySystemLocal,
  onCopyTemplateLocal,
  onPreviewTemplate
}: {
  downloaded: LocalMarketAssetsState
  downloadingKey: string | null
  onUpdateSystem: (systemId: string) => void
  onUpdateTemplate: (templateId: string) => void
  onRepairSystemForTemplate: (templateId: string, versionId: string) => void
  onRemoveSystem: (localSystemId: string) => Promise<void>
  onRestoreSystem: (localSystemId: string) => Promise<void>
  onRemoveTemplate: (localTemplateId: string) => Promise<void>
  onRestoreTemplate: (localTemplateId: string) => Promise<void>
  onCopySystemLocal: (localSystemId: string) => void
  onCopyTemplateLocal: (localTemplateId: string) => void
  onPreviewTemplate: (localTemplateId: string) => void
}): React.JSX.Element {
  const [confirmRemoveSys, setConfirmRemoveSys] = useState<{
    localId: string
    name: string
    affectedCount: number
  } | null>(null)

  const askRemoveSystem = async (localId: string, name: string) => {
    const affected =
      (await window.api?.designMarket?.countAffectedTemplatesForSystemRemoval(localId)) ?? 0
    if (affected > 0) {
      setConfirmRemoveSys({ localId, name, affectedCount: affected })
      return
    }
    await onRemoveSystem(localId)
  }

  return (
    <div className="space-y-6">
      {confirmRemoveSys && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 space-y-2 text-xs">
          <p className="font-medium text-amber-900">
            确认从选择器移除「{confirmRemoveSys.name}」？本地将有 {confirmRemoveSys.affectedCount} 个模板失去可用兼容设计系统并进入「需补齐设计系统」状态（已有历史设计仍可打开）。
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="destructive"
              onClick={() => {
                const target = confirmRemoveSys.localId
                setConfirmRemoveSys(null)
                void onRemoveSystem(target)
              }}
            >
              确认移除
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmRemoveSys(null)}>
              取消
            </Button>
          </div>
        </div>
      )}

      <section className="space-y-3">
        <h3 className="text-sm font-semibold text-foreground">
          已下载的设计系统（{downloaded.systems.length}）
        </h3>
        {downloaded.systems.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border bg-background-elevated p-6 text-xs text-muted-foreground">
            本机尚未下载设计市场的设计系统。
          </p>
        ) : (
          <div className="space-y-2.5">
            {downloaded.systems.map((sys) => (
              <div
                key={sys.localId}
                className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-background-elevated px-4 py-3"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-foreground">{sys.name}</span>
                    <span className="rounded border border-border bg-muted/40 px-2 py-0.5 text-[11px] font-medium">
                      {formatMarketVersion(sys.version)}
                    </span>
                    {sys.updateAvailable && sys.latestMarketVersion && (
                      <span className="rounded bg-primary/15 px-2 py-0.5 text-[11px] font-medium text-primary">
                        可更新至 {formatMarketVersion(sys.latestMarketVersion)}
                      </span>
                    )}
                    {sys.removedFromPicker && (
                      <span className="rounded bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                        已从选择器移除（历史设计仍可读）
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {sys.ownerName} · {sys.category}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {sys.updateAvailable && !sys.removedFromPicker && (
                    <Button
                      type="button"
                      size="sm"
                      disabled={Boolean(downloadingKey)}
                      onClick={() => onUpdateSystem(sys.systemId)}
                    >
                      <RefreshCw className="size-3.5" />
                      更新
                    </Button>
                  )}
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => onCopySystemLocal(sys.localId)}
                  >
                    <Copy className="size-3.5" />
                    另存为本地副本
                  </Button>
                  {sys.removedFromPicker ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => void onRestoreSystem(sys.localId)}
                    >
                      <RotateCcw className="size-3.5" />
                      恢复到选择器
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => void askRemoveSystem(sys.localId, `${sys.name} ${formatMarketVersion(sys.version)}`)}
                    >
                      <Trash2 className="size-3.5" />
                      从选择器移除
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-semibold text-foreground">
          已下载的模板（{downloaded.templates.length}）
        </h3>
        {downloaded.templates.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border bg-background-elevated p-6 text-xs text-muted-foreground">
            本机尚未下载设计市场的模板。
          </p>
        ) : (
          <div className="space-y-2.5">
            {downloaded.templates.map((tpl) => (
              <div
                key={tpl.localId}
                className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-background-elevated px-4 py-3"
              >
                <div className="flex min-w-0 items-center gap-3">
                  {tpl.coverDataUrl && (
                    <img
                      src={tpl.coverDataUrl}
                      alt={tpl.name}
                      className="h-12 w-20 shrink-0 rounded border border-border object-cover object-top"
                    />
                  )}
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold text-foreground">{tpl.name}</span>
                      <span className="rounded border border-border bg-muted/40 px-2 py-0.5 text-[11px] font-medium">
                        {formatMarketVersion(tpl.version)}
                      </span>
                      {tpl.missingCompatibleSystem && (
                        <span className="inline-flex items-center gap-1 rounded bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-800">
                          <AlertTriangle className="size-3" />
                          需补齐设计系统（{formatMarketVersion(tpl.minSystemVersion)}+）
                        </span>
                      )}
                      {tpl.updateAvailable && tpl.latestMarketVersion && (
                        <span className="rounded bg-primary/15 px-2 py-0.5 text-[11px] font-medium text-primary">
                          可更新至 {formatMarketVersion(tpl.latestMarketVersion)}
                        </span>
                      )}
                      {tpl.removedFromPicker && (
                        <span className="rounded bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                          已从选择器移除
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      所属：{tpl.systemName} · 作者：{tpl.ownerName} · 入口：{tpl.defaultEntryPath}
                    </p>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  {tpl.missingCompatibleSystem && !tpl.removedFromPicker && (
                    <Button
                      type="button"
                      size="sm"
                      disabled={Boolean(downloadingKey)}
                      onClick={() => onRepairSystemForTemplate(tpl.templateId, tpl.versionId)}
                    >
                      <Download className="size-3.5" />
                      补齐设计系统
                    </Button>
                  )}
                  {tpl.updateAvailable && !tpl.removedFromPicker && (
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      disabled={Boolean(downloadingKey)}
                      onClick={() => onUpdateTemplate(tpl.templateId)}
                    >
                      <RefreshCw className="size-3.5" />
                      更新
                    </Button>
                  )}
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => onPreviewTemplate(tpl.localId)}
                  >
                    <ExternalLink className="size-3.5" />
                    交互预览
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => onCopyTemplateLocal(tpl.localId)}
                  >
                    <Copy className="size-3.5" />
                    另存为本地副本
                  </Button>
                  {tpl.removedFromPicker ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => void onRestoreTemplate(tpl.localId)}
                    >
                      <RotateCcw className="size-3.5" />
                      恢复到选择器
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => void onRemoveTemplate(tpl.localId)}
                    >
                      <Trash2 className="size-3.5" />
                      从选择器移除
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
