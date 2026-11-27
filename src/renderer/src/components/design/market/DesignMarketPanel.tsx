import { useCallback, useEffect, useRef, useState } from "react"
import { ArrowLeft, CheckCircle2, Loader2, Plus, RefreshCw, WifiOff, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import type {
  DesignMarketCategory,
  DesignMarketDownloadProgress,
  LocalMarketAssetsState,
  MarketCatalogResponse,
  MarketMyUploadsResponse,
  MarketSystemDetail,
  MarketTemplateDetail
} from "../../../../../shared/design-market"
import { DesignMarketDownloaded } from "./DesignMarketDownloaded"
import { DesignMarketHome } from "./DesignMarketHome"
import { DesignMarketMyUploads } from "./DesignMarketMyUploads"
import { DesignMarketSystemDetail } from "./DesignMarketSystemDetail"
import { DesignMarketSystemEditor } from "./DesignMarketSystemEditor"
import { DesignMarketTemplateDetail } from "./DesignMarketTemplateDetail"
import { DesignMarketTemplateEditor } from "./DesignMarketTemplateEditor"

type MarketRoute =
  | { view: "home" }
  | { view: "my_uploads" }
  | { view: "downloaded" }
  | { view: "system_detail"; systemId: string }
  | { view: "template_detail"; templateId: string }
  | { view: "system_editor"; systemId: string | null }
  | { view: "template_editor"; systemId: string; templateId: string | null }

export function DesignMarketPanel({
  mode,
  initialSystemId,
  selectedLocalSystemId,
  onClose,
  onAssetsChanged,
  onOpenNewDesign
}: {
  mode: "standalone" | "overlay"
  initialSystemId?: string | null
  selectedLocalSystemId?: string | null
  onClose?: () => void
  onAssetsChanged?: () => void
  onOpenNewDesign?: (systemLocalId?: string | null) => void
}): React.JSX.Element {
  const [route, setRoute] = useState<MarketRoute>(() =>
    initialSystemId ? { view: "system_detail", systemId: initialSystemId } : { view: "home" }
  )
  const [query, setQuery] = useState("")
  const [category, setCategory] = useState<DesignMarketCategory | "全部">("全部")
  const [catalog, setCatalog] = useState<MarketCatalogResponse | null>(null)
  const [catalogLoading, setCatalogLoading] = useState(true)
  const [uploads, setUploads] = useState<MarketMyUploadsResponse | null>(null)
  const [uploadsLoading, setUploadsLoading] = useState(false)
  const [downloaded, setDownloaded] = useState<LocalMarketAssetsState>({ systems: [], templates: [] })
  const [systemDetail, setSystemDetail] = useState<MarketSystemDetail | null>(null)
  const [templateDetail, setTemplateDetail] = useState<MarketTemplateDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)

  const [progress, setProgress] = useState<DesignMarketDownloadProgress | null>(null)
  const [downloadingKey, setDownloadingKey] = useState<string | null>(null)
  const [downloadError, setDownloadError] = useState<{
    message: string
    retry: () => void
  } | null>(null)
  const [banner, setBanner] = useState<{
    message: string
    downloadedSystemLocalId?: string | null
  } | null>(null)
  const [localPreview, setLocalPreview] = useState<{
    localTemplateId: string
    title: string
    previewUrl: string
    pages: string[]
    entryPath: string
  } | null>(null)

  const mountedRef = useRef(true)

  const loadDownloaded = useCallback(async () => {
    const api = window.api?.designMarket
    if (!api) return
    try {
      const next = await api.listDownloaded()
      if (mountedRef.current) setDownloaded(next)
    } catch {
      // ignore
    }
  }, [])

  const loadCatalog = useCallback(async (q = query, cat = category) => {
    const api = window.api?.designMarket
    if (!api) {
      setCatalog({
        actor: null,
        online: false,
        offlineReason: "设计市场接口未就绪",
        categories: ["企业应用", "移动端", "数据展示", "通用"],
        scenarios: ["列表", "表单", "流程", "看板", "详情", "通用"],
        categoryCounts: { 全部: 0 },
        systems: []
      })
      setCatalogLoading(false)
      return
    }
    setCatalogLoading(true)
    try {
      const next = await api.listCatalog({ query: q, category: cat, sort: "recent" })
      if (mountedRef.current) setCatalog(next)
    } finally {
      if (mountedRef.current) setCatalogLoading(false)
    }
  }, [category, query])

  const loadMyUploads = useCallback(async () => {
    const api = window.api?.designMarket
    if (!api) return
    setUploadsLoading(true)
    try {
      const res = await api.listMyUploads()
      if (mountedRef.current) {
        if (res.success && res.data) setUploads(res.data)
        else setDetailError(res.error || "加载我的上传失败")
      }
    } finally {
      if (mountedRef.current) setUploadsLoading(false)
    }
  }, [])

  const openSystemDetail = useCallback(async (systemId: string) => {
    const api = window.api?.designMarket
    if (!api) return
    setRoute({ view: "system_detail", systemId })
    setDetailLoading(true)
    setDetailError(null)
    try {
      const res = await api.getSystemDetail(systemId)
      if (!mountedRef.current) return
      if (!res.success || !res.data) {
        setDetailError(res.error || "加载设计系统详情失败")
        setSystemDetail(null)
      } else {
        setSystemDetail(res.data)
      }
    } finally {
      if (mountedRef.current) setDetailLoading(false)
    }
  }, [])

  const openTemplateDetail = useCallback(async (templateId: string) => {
    const api = window.api?.designMarket
    if (!api) return
    setRoute({ view: "template_detail", templateId })
    setDetailLoading(true)
    setDetailError(null)
    try {
      const res = await api.getTemplateDetail(templateId)
      if (!mountedRef.current) return
      if (!res.success || !res.data) {
        setDetailError(res.error || "加载模板详情失败")
        setTemplateDetail(null)
      } else {
        setTemplateDetail(res.data)
      }
    } finally {
      if (mountedRef.current) setDetailLoading(false)
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    void loadDownloaded()
    const unsubscribe = window.api?.designMarket?.onDownloadProgress?.((evt) => {
      if (!mountedRef.current) return
      setProgress(evt)
      if (evt.phase === "done" || evt.phase === "error" || evt.phase === "canceled") {
        setDownloadingKey(null)
      }
    })
    return () => {
      mountedRef.current = false
      unsubscribe?.()
    }
  }, [loadDownloaded])

  useEffect(() => {
    if (initialSystemId) {
      void openSystemDetail(initialSystemId)
    }
  }, [initialSystemId, openSystemDetail])

  useEffect(() => {
    void loadCatalog(query, category)
  }, [category, loadCatalog, query])

  const refreshActiveRoute = useCallback(async () => {
    await Promise.all([loadDownloaded(), loadCatalog(query, category)])
    if (route.view === "my_uploads") await loadMyUploads()
    if (route.view === "system_detail") await openSystemDetail(route.systemId)
    if (route.view === "template_detail") await openTemplateDetail(route.templateId)
    onAssetsChanged?.()
  }, [category, loadCatalog, loadDownloaded, loadMyUploads, onAssetsChanged, openSystemDetail, openTemplateDetail, query, route])

  const executeDownloadSystem = async (systemId: string, versionId?: string) => {
    const api = window.api?.designMarket
    if (!api) return
    const key = `system:${systemId}:${versionId || "latest"}`
    setDownloadingKey(key)
    setDownloadError(null)
    setBanner(null)
    try {
      const res = await api.downloadSystem(systemId, versionId)
      if (!mountedRef.current) return
      if (res.canceled) {
        setProgress(null)
        return
      }
      if (!res.success || !res.system) {
        setDownloadError({
          message: res.error || "下载设计系统失败",
          retry: () => void executeDownloadSystem(systemId, versionId)
        })
        return
      }
      setProgress(null)
      setBanner({
        message: `已下载「${res.system.name}」${res.system.version}，可在新建设计中选择`,
        downloadedSystemLocalId: res.system.localId
      })
      await refreshActiveRoute()
    } finally {
      if (mountedRef.current) setDownloadingKey(null)
    }
  }

  const executeDownloadTemplate = async (templateId: string, versionId?: string) => {
    const api = window.api?.designMarket
    if (!api) return
    const key = `template:${templateId}:${versionId || "latest"}`
    setDownloadingKey(key)
    setDownloadError(null)
    setBanner(null)
    try {
      const res = await api.downloadTemplate(templateId, versionId, selectedLocalSystemId)
      if (!mountedRef.current) return
      if (res.canceled) {
        setProgress(null)
        return
      }
      if (!res.success || !res.template) {
        setDownloadError({
          message: res.error || "下载模板失败",
          retry: () => void executeDownloadTemplate(templateId, versionId)
        })
        return
      }
      setProgress(null)
      const alsoMsg = res.alsoDownloadedSystem
        ? `（已同时下载所属设计系统「${res.alsoDownloadedSystem.name}」v${res.alsoDownloadedSystem.version}）`
        : ""
      setBanner({
        message: `已下载模板「${res.template.name}」${alsoMsg}，可在新建设计中选择`,
        downloadedSystemLocalId: res.alsoDownloadedSystem?.localId ?? null
      })
      await refreshActiveRoute()
    } finally {
      if (mountedRef.current) setDownloadingKey(null)
    }
  }

  const openLocalPreview = async (localTemplateId: string, entryPath?: string) => {
    const api = window.api?.designMarket
    if (!api) return
    const res = await api.previewDownloadedTemplate(localTemplateId, entryPath)
    if (!res.success || !res.data) {
      setBanner({ message: res.error || "打开预览失败" })
      return
    }
    const found = downloaded.templates.find((item) => item.localId === localTemplateId)
    setLocalPreview({
      localTemplateId,
      title: found?.name || "模板预览",
      previewUrl: res.data.previewUrl,
      pages: res.data.pages,
      entryPath: res.data.entryPath
    })
  }

  const topTab =
    route.view === "my_uploads"
      ? "my_uploads"
      : route.view === "downloaded"
        ? "downloaded"
        : "home"

  return (
    <div className="flex h-full min-h-0 w-full flex-1 flex-col overflow-hidden bg-background">
      <header className="shrink-0 border-b border-border bg-background-elevated px-6 py-4 lg:px-8">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-6">
            <h1 className="text-xl font-semibold text-foreground">设计市场</h1>
            <nav className="flex items-center gap-5 text-xs font-medium" aria-label="设计市场导航">
              <button
                type="button"
                onClick={() => {
                  setDetailError(null)
                  setRoute({ view: "home" })
                  void loadCatalog(query, category)
                }}
                className={cn(
                  "border-b-2 pb-1 transition-colors",
                  topTab === "home"
                    ? "border-primary font-semibold text-primary"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                )}
              >
                设计系统
              </button>
              <button
                type="button"
                onClick={() => {
                  setDetailError(null)
                  setRoute({ view: "my_uploads" })
                  void loadMyUploads()
                }}
                className={cn(
                  "border-b-2 pb-1 transition-colors",
                  topTab === "my_uploads"
                    ? "border-primary font-semibold text-primary"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                )}
              >
                我的上传
              </button>
              <button
                type="button"
                onClick={() => {
                  setDetailError(null)
                  setRoute({ view: "downloaded" })
                  void loadDownloaded()
                }}
                className={cn(
                  "border-b-2 pb-1 transition-colors",
                  topTab === "downloaded"
                    ? "border-primary font-semibold text-primary"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                )}
              >
                已下载（{downloaded.systems.filter((s) => !s.removedFromPicker).length + downloaded.templates.filter((t) => !t.removedFromPicker).length}）
              </button>
            </nav>
          </div>

          <div className="flex items-center gap-2">
            {mode === "overlay" && onClose && (
              <Button type="button" variant="outline" size="sm" onClick={onClose}>
                <ArrowLeft className="size-3.5" />
                返回新建设计
              </Button>
            )}
            <Button
              type="button"
              size="sm"
              onClick={() => {
                setSystemDetail(null)
                setDetailError(null)
                setRoute({ view: "system_editor", systemId: null })
              }}
            >
              <Plus className="size-3.5" />
              上传设计系统
            </Button>
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5 lg:px-8">
        <div className="mx-auto w-full max-w-[1280px] space-y-4">
          {catalog && !catalog.online && route.view !== "downloaded" && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-2.5 text-xs text-amber-900">
              <div className="flex items-center gap-2">
                <WifiOff className="size-4 shrink-0" />
                <span>{catalog.offlineReason || "当前处于离线或未登录状态，仅可使用「已下载」本地资产。"}</span>
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setRoute({ view: "downloaded" })}
              >
                查看已下载
              </Button>
            </div>
          )}

          {progress && progress.phase !== "done" && progress.phase !== "canceled" && progress.phase !== "error" && (
            <div className="rounded-xl border border-border bg-background-elevated px-4 py-3 space-y-2">
              <div className="flex items-center justify-between gap-3 text-xs">
                <span className="flex items-center gap-2 font-medium text-foreground">
                  <Loader2 className="size-3.5 animate-spin text-primary" />
                  {progress.message}
                  {progress.totalBytes > 0 && (
                    <span className="text-muted-foreground">
                      （{Math.min(100, Math.round((progress.receivedBytes / progress.totalBytes) * 100))}%）
                    </span>
                  )}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs"
                  onClick={() => void window.api?.designMarket?.cancelDownload(progress.downloadKey)}
                >
                  取消下载
                </Button>
              </div>
              {progress.totalBytes > 0 && (
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full bg-primary transition-all"
                    style={{
                      width: `${Math.min(100, Math.round((progress.receivedBytes / progress.totalBytes) * 100))}%`
                    }}
                  />
                </div>
              )}
            </div>
          )}

          {downloadError && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-2.5 text-xs text-destructive">
              <span>{downloadError.message}</span>
              <div className="flex items-center gap-2">
                <Button type="button" size="sm" variant="outline" onClick={downloadError.retry}>
                  <RefreshCw className="size-3.5" />
                  重试
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setDownloadError(null)}
                >
                  关闭
                </Button>
              </div>
            </div>
          )}

          {banner && (
            <div
              role="status"
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-emerald-500/35 bg-emerald-500/10 px-4 py-2.5 text-xs text-emerald-900"
            >
              <span className="flex items-center gap-2 font-medium">
                <CheckCircle2 className="size-4 text-emerald-600" />
                {banner.message}
              </span>
              <div className="flex items-center gap-2">
                {mode === "overlay" && onClose ? (
                  <Button type="button" size="sm" onClick={onClose}>
                    返回新建设计
                  </Button>
                ) : onOpenNewDesign ? (
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => onOpenNewDesign(banner.downloadedSystemLocalId)}
                  >
                    新建设计
                  </Button>
                ) : null}
                <Button type="button" size="sm" variant="ghost" onClick={() => setBanner(null)}>
                  <X className="size-3.5" />
                </Button>
              </div>
            </div>
          )}

          {detailError && (
            <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-2.5 text-xs text-destructive">
              {detailError}
            </p>
          )}

          {route.view === "home" && (
            <DesignMarketHome
              catalog={catalog}
              downloaded={downloaded}
              query={query}
              category={category}
              loading={catalogLoading}
              downloadingKey={downloadingKey}
              onQueryChange={setQuery}
              onCategoryChange={setCategory}
              onOpenSystem={(systemId) => void openSystemDetail(systemId)}
              onOpenTemplate={(templateId) => void openTemplateDetail(templateId)}
              onDownloadSystem={(sys) => void executeDownloadSystem(sys.systemId, sys.latestVersionId ?? undefined)}
              onDownloadTemplate={(tpl) => void executeDownloadTemplate(tpl.templateId, tpl.latestVersionId ?? undefined)}
            />
          )}

          {route.view === "my_uploads" && (
            <DesignMarketMyUploads
              uploads={uploads}
              loading={uploadsLoading}
              onOpenSystem={(systemId) => void openSystemDetail(systemId)}
              onEditSystem={(systemId) => {
                void window.api?.designMarket?.getSystemDetail(systemId).then((res) => {
                  if (res.success && res.data) {
                    setSystemDetail(res.data)
                    setRoute({ view: "system_editor", systemId })
                  } else {
                    setDetailError(res.error || "加载草稿失败")
                  }
                })
              }}
              onDiscardSystemDraft={(systemId) => {
                void window.api?.designMarket?.discardSystemDraft(systemId).then(() => refreshActiveRoute())
              }}
              onToggleSystemStatus={(systemId, status) => {
                void window.api?.designMarket
                  ?.setSystemStatus(systemId, status)
                  .then((res) => {
                    if (res.success && res.data) {
                      setBanner({
                        message:
                          status === "unpublished"
                            ? `已下架，受影响模板 ${res.data.affectedTemplateCount} 个`
                            : "已重新上架"
                      })
                      void refreshActiveRoute()
                    } else {
                      setDetailError(res.error || "操作失败")
                    }
                  })
              }}
              onOpenTemplate={(templateId) => void openTemplateDetail(templateId)}
              onEditTemplate={(templateId) => {
                void window.api?.designMarket?.getTemplateDetail(templateId).then(async (res) => {
                  if (res.success && res.data) {
                    const sysRes = await window.api?.designMarket?.getSystemDetail(res.data.template.systemId)
                    if (sysRes?.success && sysRes.data) setSystemDetail(sysRes.data)
                    setTemplateDetail(res.data)
                    setRoute({
                      view: "template_editor",
                      systemId: res.data.template.systemId,
                      templateId
                    })
                  } else {
                    setDetailError(res.error || "加载模板草稿失败")
                  }
                })
              }}
              onDiscardTemplateDraft={(templateId) => {
                void window.api?.designMarket?.discardTemplateDraft(templateId).then(() => refreshActiveRoute())
              }}
              onToggleTemplateStatus={(templateId, status) => {
                void window.api?.designMarket
                  ?.setTemplateStatus(templateId, status)
                  .then((res) => {
                    if (res.success) void refreshActiveRoute()
                    else setDetailError(res.error || "操作失败")
                  })
              }}
            />
          )}

          {route.view === "downloaded" && (
            <DesignMarketDownloaded
              downloaded={downloaded}
              downloadingKey={downloadingKey}
              onUpdateSystem={(systemId) => void executeDownloadSystem(systemId)}
              onUpdateTemplate={(templateId) => void executeDownloadTemplate(templateId)}
              onRepairSystemForTemplate={(templateId, versionId) =>
                void executeDownloadTemplate(templateId, versionId)
              }
              onRemoveSystem={async (localId) => {
                await window.api?.designMarket?.removeSystemFromPicker(localId)
                await refreshActiveRoute()
              }}
              onRestoreSystem={async (localId) => {
                await window.api?.designMarket?.restoreSystemToPicker(localId)
                await refreshActiveRoute()
              }}
              onRemoveTemplate={async (localId) => {
                await window.api?.designMarket?.removeTemplateFromPicker(localId)
                await refreshActiveRoute()
              }}
              onRestoreTemplate={async (localId) => {
                await window.api?.designMarket?.restoreTemplateToPicker(localId)
                await refreshActiveRoute()
              }}
              onCopySystemLocal={(localId) => {
                void window.api?.designMarket?.copySystemToLocal(localId).then((res) => {
                  if (res.success && res.data) {
                    setBanner({ message: `已另存为本地设计系统「${res.data.name}」` })
                    onAssetsChanged?.()
                  } else {
                    setDetailError(res.error || "复制失败")
                  }
                })
              }}
              onCopyTemplateLocal={(localId) => {
                void window.api?.designMarket?.copyTemplateToLocal(localId).then((res) => {
                  if (res.success && res.data) {
                    setBanner({ message: `已另存为本地模板「${res.data.name}」` })
                    onAssetsChanged?.()
                  } else {
                    setDetailError(res.error || "复制失败")
                  }
                })
              }}
              onPreviewTemplate={(localId) => void openLocalPreview(localId)}
            />
          )}

          {route.view === "system_detail" &&
            (detailLoading ? (
              <div className="p-10 text-center text-sm text-muted-foreground">正在加载设计系统…</div>
            ) : systemDetail ? (
              <DesignMarketSystemDetail
                detail={systemDetail}
                downloaded={downloaded}
                downloadingKey={downloadingKey}
                onBack={() => setRoute({ view: "home" })}
                onEditSystem={() =>
                  setRoute({ view: "system_editor", systemId: systemDetail.system.systemId })
                }
                onUploadTemplate={() => {
                  setTemplateDetail(null)
                  setRoute({
                    view: "template_editor",
                    systemId: systemDetail.system.systemId,
                    templateId: null
                  })
                }}
                onOpenTemplate={(templateId) => void openTemplateDetail(templateId)}
                onEditTemplate={(templateId) => {
                  void window.api?.designMarket?.getTemplateDetail(templateId).then((res) => {
                    if (res.success && res.data) {
                      setTemplateDetail(res.data)
                      setRoute({
                        view: "template_editor",
                        systemId: systemDetail.system.systemId,
                        templateId
                      })
                    }
                  })
                }}
                onDownloadSystem={(systemId, versionId) =>
                  void executeDownloadSystem(systemId, versionId)
                }
                onDownloadTemplate={(tpl) =>
                  void executeDownloadTemplate(tpl.templateId, tpl.latestVersionId ?? undefined)
                }
                onToggleTemplateVisibility={async (templateId, visibility, reason) => {
                  const res = await window.api?.designMarket?.setTemplateVisibilityBySystemOwner(
                    templateId,
                    visibility,
                    reason
                  )
                  if (res && !res.success) {
                    setDetailError(res.error || "更新模板展示状态失败")
                  }
                  await openSystemDetail(systemDetail.system.systemId)
                }}
                onAdminAction={async (action, reason) => {
                  const api = window.api?.designMarket
                  if (!api) return
                  const res =
                    action === "takedown"
                      ? await api.adminTakedown("system", systemDetail.system.systemId, reason)
                      : await api.adminRestore("system", systemDetail.system.systemId, reason)
                  if (!res.success) setDetailError(res.error || "管理员操作失败")
                  await refreshActiveRoute()
                }}
              />
            ) : null)}

          {route.view === "template_detail" &&
            (detailLoading ? (
              <div className="p-10 text-center text-sm text-muted-foreground">正在加载模板详情…</div>
            ) : templateDetail ? (
              <DesignMarketTemplateDetail
                detail={templateDetail}
                downloaded={downloaded}
                selectedLocalSystemId={selectedLocalSystemId}
                downloadingKey={downloadingKey}
                onBackToMarket={() => setRoute({ view: "home" })}
                onBackToSystem={(systemId) => void openSystemDetail(systemId)}
                onEditTemplate={() => {
                  void window.api?.designMarket
                    ?.getSystemDetail(templateDetail.template.systemId)
                    .then((sysRes) => {
                      if (sysRes.success && sysRes.data) setSystemDetail(sysRes.data)
                      setRoute({
                        view: "template_editor",
                        systemId: templateDetail.template.systemId,
                        templateId: templateDetail.template.templateId
                      })
                    })
                }}
                onDownloadVersion={(templateId, versionId) =>
                  void executeDownloadTemplate(templateId, versionId)
                }
                onSaveLocalCopy={(localTemplateId) => {
                  void window.api?.designMarket?.copyTemplateToLocal(localTemplateId).then((res) => {
                    if (res.success && res.data) {
                      setBanner({ message: `已另存为本地模板「${res.data.name}」` })
                      onAssetsChanged?.()
                    } else {
                      setDetailError(res.error || "复制失败")
                    }
                  })
                }}
                onPreviewLocal={(localTemplateId) => void openLocalPreview(localTemplateId)}
                onAdminAction={async (action, reason) => {
                  const api = window.api?.designMarket
                  if (!api) return
                  const res =
                    action === "takedown"
                      ? await api.adminTakedown("template", templateDetail.template.templateId, reason)
                      : await api.adminRestore("template", templateDetail.template.templateId, reason)
                  if (!res.success) setDetailError(res.error || "管理员操作失败")
                  await refreshActiveRoute()
                }}
              />
            ) : null)}

          {route.view === "system_editor" && (
            <DesignMarketSystemEditor
              detail={route.systemId ? systemDetail : null}
              onBack={() =>
                route.systemId
                  ? void openSystemDetail(route.systemId)
                  : setRoute({ view: "home" })
              }
              onSaved={(next, notice) => {
                setSystemDetail(next)
                if (notice) setBanner({ message: notice })
                if (next.system.status === "published" && !next.draft?.dirty) {
                  setRoute({ view: "system_detail", systemId: next.system.systemId })
                } else {
                  setRoute({ view: "system_editor", systemId: next.system.systemId })
                }
                void loadCatalog(query, category)
                onAssetsChanged?.()
              }}
              onReloadLatest={async (systemId) => {
                const res = await window.api?.designMarket?.getSystemDetail(systemId)
                if (res?.success && res.data) {
                  setSystemDetail(res.data)
                  return res.data
                }
                return null
              }}
            />
          )}

          {route.view === "template_editor" && systemDetail && (
            <DesignMarketTemplateEditor
              parentSystem={systemDetail}
              detail={route.templateId ? templateDetail : null}
              onBack={() => void openSystemDetail(systemDetail.system.systemId)}
              onSaved={(next, notice) => {
                setTemplateDetail(next)
                if (notice) setBanner({ message: notice })
                if (next.template.effectiveStatus === "published" && !next.draft?.dirty) {
                  setRoute({ view: "template_detail", templateId: next.template.templateId })
                } else {
                  setRoute({
                    view: "template_editor",
                    systemId: next.template.systemId,
                    templateId: next.template.templateId
                  })
                }
                void loadCatalog(query, category)
                onAssetsChanged?.()
              }}
              onReloadLatest={async (templateId) => {
                const res = await window.api?.designMarket?.getTemplateDetail(templateId)
                if (res?.success && res.data) {
                  setTemplateDetail(res.data)
                  return res.data
                }
                return null
              }}
            />
          )}
        </div>
      </div>

      <Dialog open={Boolean(localPreview)} onOpenChange={(open) => !open && setLocalPreview(null)}>
        <DialogContent className="flex h-[85vh] w-[calc(100vw_-_2rem)] max-w-6xl flex-col gap-0 p-0">
          <DialogHeader className="flex shrink-0 flex-row items-center justify-between border-b border-border px-6 py-4 pr-12">
            <div>
              <DialogTitle>{localPreview?.title} · 本地沙箱预览</DialogTitle>
              <DialogDescription>
                通过 127.0.0.1 隔离沙箱服务预览已下载的本地模板文件。
              </DialogDescription>
            </div>
            {localPreview && localPreview.pages.length > 1 && (
              <select
                aria-label="切换预览页面入口"
                value={localPreview.entryPath}
                onChange={(event) =>
                  void openLocalPreview(localPreview.localTemplateId, event.target.value)
                }
                className="h-8 rounded-md border border-border bg-background px-2.5 text-xs"
              >
                {localPreview.pages.map((page) => (
                  <option key={page} value={page}>
                    {page}
                  </option>
                ))}
              </select>
            )}
          </DialogHeader>
          <div className="min-h-0 flex-1 bg-white">
            {localPreview?.previewUrl && (
              <iframe
                title="本地模板沙箱预览"
                key={`${localPreview.localTemplateId}:${localPreview.entryPath}`}
                src={localPreview.previewUrl}
                sandbox="allow-scripts allow-forms allow-modals"
                referrerPolicy="no-referrer"
                className="h-full w-full border-0 bg-white"
              />
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
