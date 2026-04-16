import { useCallback, useEffect, useState, useRef } from "react"
import { AlertTriangle, Code2, Download, Loader2, Play, RotateCcw, Square, Upload } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import type { LspConfig, LspStatus } from "@/types"
import { marketApi } from "../../api/market"

const HEAP_OPTIONS = [
  { value: 512, label: "512 MB" },
  { value: 1024, label: "1024 MB" },
  { value: 2048, label: "2048 MB" },
  { value: 4096, label: "4096 MB" }
]

const selectClass =
  "w-full h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"

const SOURCE_LABELS = {
  configured: "手动配置",
  env: "JAVA_HOME",
  java_home: "系统探测",
  scan: "目录扫描"
} as const

interface VsixDownloadProgress {
  percent: number
  transferred: number
  total: number
}

interface VsixDownloadState {
  isDownloading: boolean
  progress: VsixDownloadProgress | null
}

function isVsixMissingError(message: string | null | undefined): boolean {
  if (!message) return false
  return /lsp-vsix|vsix|运行时缺失/.test(message)
}

function formatMegabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

interface LspPanelProps {
  threadId: string | null
  embedded?: boolean
  statusOnly?: boolean
}

export function LspPanel({ threadId, embedded = false, statusOnly = false }: LspPanelProps): React.JSX.Element {
  const [config, setConfig] = useState<LspConfig | null>(null)
  const [status, setStatus] = useState<LspStatus | null>(null)
  const [jdkHomeInput, setJdkHomeInput] = useState("")
  const [jdkFallbackNotice, setJdkFallbackNotice] = useState<string | null>(null)
  const [downloadingVsix, setDownloadingVsix] = useState(false)
  const [downloadProgress, setDownloadProgress] = useState<VsixDownloadProgress | null>(null)
  const [importingVsix, setImportingVsix] = useState(false)
  const [busyAction, setBusyAction] = useState<"start" | "stop" | null>(null)
  const [projectRoot, setProjectRoot] = useState<string | null>(null)
  const mountedRef = useRef(true)
  const hasReceivedDownloadStatePushRef = useRef(false)

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  useEffect(() => {
    setJdkFallbackNotice(null)
  }, [threadId])

  const loadAll = useCallback(async () => {
    try {
      const cfg = await window.api.lsp.getConfig()
      if (!mountedRef.current) return
      setConfig(cfg)

      if (!threadId) {
        setProjectRoot(null)
        const currentStatus = await window.api.lsp.getStatus(null)
        if (mountedRef.current) setStatus(currentStatus)
        return
      }

      const workspace = await window.api.workspace.get(threadId)
      if (!mountedRef.current) return
      setProjectRoot(workspace)

      if (!workspace) {
        const currentStatus = await window.api.lsp.getStatus(null)
        if (mountedRef.current) setStatus(currentStatus)
        return
      }

      const currentStatus = await window.api.lsp.getStatus(workspace)
      if (mountedRef.current) {
        setStatus(currentStatus)
      }
    } catch (e) {
      console.error("[LspPanel] load error:", e)
    }
  }, [threadId])

  useEffect(() => {
    loadAll()
  }, [loadAll])

  useEffect(() => {
    return window.api.lsp.onChanged(() => { loadAll() })
  }, [loadAll])

  const loadDownloadState = useCallback(async () => {
    try {
      const state = await window.api.lsp.getDownloadState()
      if (!mountedRef.current || hasReceivedDownloadStatePushRef.current) return
      setDownloadingVsix(state.isDownloading)
      setDownloadProgress(state.progress)
    } catch (e) {
      console.error("[LspPanel] load download state error:", e)
    }
  }, [])

  useEffect(() => {
    void loadDownloadState()
  }, [loadDownloadState])

  useEffect(() => {
    return window.api.lsp.onDownloadState((state: VsixDownloadState) => {
      if (mountedRef.current) {
        hasReceivedDownloadStatePushRef.current = true
        setDownloadingVsix(state.isDownloading)
        setDownloadProgress(state.progress)
      }
    })
  }, [])

  const saveConfig = useCallback(async (updates: Partial<LspConfig>) => {
    try {
      await window.api.lsp.saveConfig(updates)
    } catch (e) {
      console.error("[LspPanel] saveConfig error:", e)
    }
  }, [])

  useEffect(() => {
    const manualJavaHome = config?.manualJavaHome?.trim() || ""
    const selectedRuntimePath = status?.selectedRuntime?.path || ""
    const manualJavaHomeInvalid = Boolean(manualJavaHome && status?.manualJavaHomeStatus && !status.manualJavaHomeStatus.valid)

    if (manualJavaHomeInvalid && selectedRuntimePath) {
      setJdkHomeInput(manualJavaHome)
      setJdkFallbackNotice(`手动配置的 JDK 无效，当前临时使用可用 JDK：${selectedRuntimePath}`)
      return
    }

    setJdkHomeInput(manualJavaHome || selectedRuntimePath)
  }, [
    config?.manualJavaHome,
    status?.manualJavaHomeStatus,
    status?.selectedRuntime?.path
  ])

  const handleToggleEnabled = useCallback(async (enabled: boolean) => {
    setConfig((prev) => prev ? { ...prev, enabled } : prev)
    await saveConfig({ enabled })
  }, [saveConfig])

  const handleHeapChange = useCallback(async (value: string) => {
    const maxHeapMb = Number(value)
    setConfig((prev) => prev ? { ...prev, maxHeapMb } : prev)
    await saveConfig({ maxHeapMb })
  }, [saveConfig])

  const handleJdkHomeBlur = useCallback(async (value: string) => {
    if (!config) return
    const trimmed = value.trim()
    const currentManualJavaHome = config.manualJavaHome?.trim() || null
    const selectedRuntimePath = status?.selectedRuntime?.path ?? ""
    const nextManualJavaHome = !trimmed
      ? null
      : (!currentManualJavaHome && trimmed === selectedRuntimePath)
        ? null
        : trimmed
    if (currentManualJavaHome === nextManualJavaHome) return
    setJdkFallbackNotice(null)
    setConfig((prev) => prev ? { ...prev, manualJavaHome: nextManualJavaHome } : prev)
    await saveConfig({ manualJavaHome: nextManualJavaHome })
  }, [config, saveConfig, status?.selectedRuntime?.path])

  const handleStart = useCallback(async () => {
    if (!projectRoot) {
      alert("请先为当前会话选择工作目录")
      return
    }
    if (!status?.selectedRuntime) {
      alert("未探测到可用 JDK，请先配置有效的 JDK Home")
      return
    }
    try {
      setBusyAction("start")
      await window.api.lsp.start(projectRoot)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (mountedRef.current) {
        alert(`启动失败: ${msg}`)
      }
    } finally {
      if (mountedRef.current) setBusyAction(null)
    }
  }, [projectRoot, status?.selectedRuntime])

  const handleStop = useCallback(async () => {
    if (!projectRoot) return
    try {
      setBusyAction("stop")
      await window.api.lsp.stop(projectRoot)
    } catch (e) {
      console.error("[LspPanel] stop error:", e)
    } finally {
      if (mountedRef.current) setBusyAction(null)
    }
  }, [projectRoot])

  const handleReset = useCallback(async () => {
    try {
      const defaults = await window.api.lsp.resetConfig()
      setJdkFallbackNotice(null)
      setConfig(defaults)
    } catch (e) {
      console.error("[LspPanel] reset error:", e)
    }
  }, [])

  const handleDownloadVsix = useCallback(async () => {
    try {
      setDownloadingVsix(true)
      setDownloadProgress({ percent: 0, transferred: 0, total: 0 })
      const result = await marketApi.downloadLspVsix()
      if (!result.success) {
        await loadAll()
        alert(`下载 VSIX 失败: ${result.error ?? "未知错误"}`)
        return
      }
      await loadAll()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      alert(`下载 VSIX 失败: ${msg}`)
    } finally {
      if (mountedRef.current) {
        void loadDownloadState()
      }
    }
  }, [loadAll, loadDownloadState])

  const handleImportVsix = useCallback(async () => {
    try {
      setImportingVsix(true)
      const result = await window.api.lsp.importVsix()
      if (!result.success && result.error !== "已取消导入") {
        alert(`导入 VSIX 失败: ${result.error}`)
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      alert(`导入 VSIX 失败: ${msg}`)
    } finally {
      if (mountedRef.current) setImportingVsix(false)
    }
  }, [])

  if (!config) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
        加载中...
      </div>
    )
  }

  const lifecycle = status?.lifecycle ?? "stopped"
  const serverState = status?.state ?? "stopped"
  const isActive = serverState === "starting" || serverState === "running"
  const hasUsableJdk = Boolean(status?.selectedRuntime)
  const statusText = !config.enabled
    ? "已禁用"
    : threadId && !projectRoot
      ? "未关联工作目录"
      : status?.statusText ?? "已停止"

  const statusClass = cn(
    "text-sm font-medium",
    lifecycle === "ready"
      ? "text-green-500"
      : lifecycle === "degraded"
        ? "text-amber-600 dark:text-amber-400"
        : lifecycle === "starting" || lifecycle === "importing"
          ? "text-sky-600 dark:text-sky-400"
          : lifecycle === "error"
            ? "text-destructive"
            : "text-muted-foreground"
  )
  const visibleLastError = status?.vsixAvailable && isVsixMissingError(config.lastError)
    ? null
    : config.lastError
  const showEmbeddedStatusRow = !(embedded && statusOnly)

  const statusCard = (
    <div className="rounded-md border border-border p-4 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">运行状态</span>
        <div className="flex items-center gap-2">
          {isActive ? (
            <Button
              variant="outline"
              size="sm"
              disabled={busyAction !== null}
              onClick={handleStop}
            >
              <Square className="size-4 mr-1" />
              停止
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              disabled={busyAction !== null || !config.enabled || !projectRoot || !status?.vsixAvailable || !hasUsableJdk}
              onClick={handleStart}
            >
              {busyAction === "start" ? (
                <Loader2 className="size-4 mr-1 animate-spin" />
              ) : (
                <Play className="size-4 mr-1" />
              )}
              {busyAction === "start" ? "启动中..." : "启动"}
            </Button>
          )}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 text-sm">
        {showEmbeddedStatusRow && (
          <>
            <div className="text-muted-foreground">状态</div>
            <div className={statusClass}>{statusText}</div>
          </>
        )}
        <div className="text-muted-foreground">当前会话工作目录</div>
        <div className="text-xs truncate">
          {projectRoot || (threadId ? "当前会话未关联文件夹" : "未选择会话")}
        </div>
        <div className="text-muted-foreground">项目目标 JDK</div>
        <div className="text-xs">
          {status?.projectRequirement
            ? `${status.projectRequirement.runtimeName} (${status.projectRequirement.javaVersion}, 来自 ${status.projectRequirement.source})`
            : projectRoot ? "未识别到项目声明的 Java 版本" : "未关联工作目录"}
        </div>
        <div className="text-muted-foreground">解析项目使用的 JDK</div>
        <div className="text-xs break-all">
          {status?.selectedRuntime
            ? `${status.selectedRuntime.path}${status.selectedRuntime.version ? ` (${status.selectedRuntime.version})` : ""}`
            : "尚未解析到可用 JDK"}
        </div>
        <div className="text-muted-foreground">项目解析状态</div>
        <div className="text-xs">
          {status?.projectStatusText ?? "未启动"}
        </div>
        {lifecycle !== "ready" && status?.progressMessage && status.progressMessage !== status.projectStatusText && (
          <>
            <div className="text-muted-foreground">最近进度</div>
            <div className="text-xs">{status.progressMessage}</div>
          </>
        )}
        {visibleLastError && (
          <>
            <div className="text-muted-foreground">错误信息</div>
            <div className="text-destructive text-xs">{visibleLastError}</div>
          </>
        )}
      </div>

      {status?.degradedReason && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300 flex gap-2">
          <AlertTriangle className="size-4 shrink-0 mt-0.5" />
          <div className="space-y-1">
            <div>{status.degradedReason}</div>
            {status.missingRuntime && (
              <div>
                当前项目需要 {status.missingRuntime}；请在 LSP 配置中设置对应 JDK Home，并确保本机已安装该版本 JDK。
              </div>
            )}
          </div>
        </div>
      )}

      {status?.warningReason && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300 flex gap-2">
          <AlertTriangle className="size-4 shrink-0 mt-0.5" />
          <div className="space-y-1">
            <div>{status.warningReason}</div>
          </div>
        </div>
      )}
    </div>
  )

  if (statusOnly) {
    return (
      <div className={cn("flex-1", !embedded && "overflow-auto")}>
        <div className={cn(embedded ? "p-4" : "max-w-2xl mx-auto p-6")}>
          {statusCard}
        </div>
      </div>
    )
  }

  const runtimeSourceLabel = status?.selectedRuntime ? SOURCE_LABELS[status.selectedRuntime.source] : null
  const manualStatus = status?.manualJavaHomeStatus
  const jdkHelpText = config.manualJavaHome?.trim()
    ? (manualStatus?.valid
      ? `手动配置生效: ${manualStatus.path}${manualStatus.version ? ` (${manualStatus.version})` : ""}`
      : `手动配置无效: ${manualStatus?.error ?? "无法用于 JDTLS"}`)
    : status?.selectedRuntime
      ? `${status.selectedRuntime.path}${runtimeSourceLabel ? ` (${runtimeSourceLabel})` : ""}`
      : "未探测到可用的本机 JDK"
  const showVsixImportCard = status ? !status.vsixAvailable : false
  const vsixActionBusy = downloadingVsix || importingVsix
  const downloadDisplayTotalBytes = 130 * 1024 * 1024
  const downloadProgressWidth = downloadProgress
    ? Math.min(100, Math.round((downloadProgress.transferred / downloadDisplayTotalBytes) * 100))
    : 0
  const downloadMetaText = downloadProgress
    ? `已下载 ${formatMegabytes(downloadProgress.transferred)} / 130MB`
    : "已下载 0.0MB / 130MB"

  return (
    <div className={cn("flex-1", !embedded && "overflow-auto")}>
      <div className={cn(embedded ? "p-4 space-y-4" : "max-w-2xl mx-auto p-6 space-y-6")}>
        <div className="flex items-center justify-between gap-3">
          {!embedded ? (
            <div className="flex items-center gap-2">
              <Code2 className="size-5 text-orange-400" />
              <h2 className="text-lg font-semibold">Java LSP</h2>
              <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400">
                Beta
              </span>
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">当前工作目录的 Java 语义服务配置</div>
          )}
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="sm" onClick={handleReset} title="重置为默认配置">
              <RotateCcw className="size-4 mr-1" />
              重置
            </Button>
            <label className="flex items-center gap-2 cursor-pointer">
              <span className="text-sm text-muted-foreground">
                {config.enabled ? "已启用" : "已禁用"}
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={config.enabled}
                className={cn(
                  "relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors",
                  config.enabled ? "bg-primary" : "bg-muted-foreground/30"
                )}
                onClick={() => handleToggleEnabled(!config.enabled)}
              >
                <span
                  className={cn(
                    "pointer-events-none inline-block size-4 rounded-full bg-white shadow-sm transition-transform",
                    config.enabled ? "translate-x-4" : "translate-x-0"
                  )}
                />
              </button>
            </label>
          </div>
        </div>

        <p className="text-sm text-muted-foreground">
          为CmbDevClaw 添加Java LSP工具，进行精确的代码跳转、查找引用、类型信息查询等操作。
          需要配置项目对应的JDK 用于符号分析。
        </p>

        <p className="text-sm text-muted-foreground">
          每个被选中的工作区都需要单独启动LSP服务，为避免占用过多资源请控制启动的LSP服务数量并及时关闭
          不再使用的LSP服务。
        </p>

        {/* Settings */}
        <div className="space-y-4">
          {/* Max Heap */}
          <div>
            <label className="text-sm font-medium">LSP服务占用最大内存</label>
            <select
              className={cn(selectClass, "mt-1")}
              value={config.maxHeapMb}
              onChange={(e) => handleHeapChange(e.target.value)}
            >
              {HEAP_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          <div className="rounded-md border border-border p-4 space-y-4">
            <div>
              <div className="text-sm font-medium">JDK Home</div>
              <div className="text-xs text-muted-foreground mt-1">
                默认自动探测本机 JDK。你也可以手动填写一个 JDK Home 作为覆盖路径。
              </div>
            </div>

            <Input
              value={jdkHomeInput}
              placeholder={status?.selectedRuntime?.path ?? "/path/to/jdk-home"}
              onChange={(e) => {
                setJdkFallbackNotice(null)
                setJdkHomeInput(e.target.value)
              }}
              onBlur={(e) => handleJdkHomeBlur(e.target.value)}
            />
            {jdkFallbackNotice && (
              <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300 break-all">
                {jdkFallbackNotice}
              </div>
            )}
            <div className="text-xs text-muted-foreground break-all">{jdkHelpText}</div>
          </div>

          {showVsixImportCard && (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-4 space-y-3">
              <div className="flex items-start gap-2">
                <AlertTriangle className="size-4 shrink-0 mt-0.5 text-amber-700 dark:text-amber-300" />
                <div className="space-y-1">
                  <div className="text-sm font-medium text-amber-800 dark:text-amber-200">
                    缺少 Java LSP 运行时文件
                  </div>
                  <div className="text-xs text-amber-700 dark:text-amber-300">
                    下载或导入当前平台的 Java 扩展 `.vsix` 文件，才可以启用Java LSP服务。
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <Button size="sm" onClick={handleDownloadVsix} disabled={vsixActionBusy}>
                  {downloadingVsix ? (
                    <Loader2 className="size-4 mr-1 animate-spin" />
                  ) : (
                    <Download className="size-4 mr-1" />
                  )}
                  {downloadingVsix ? "下载中..." : "下载 VSIX"}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleImportVsix}
                  disabled={vsixActionBusy}
                >
                  {importingVsix ? (
                    <Loader2 className="size-4 mr-1 animate-spin" />
                  ) : (
                    <Upload className="size-4 mr-1" />
                  )}
                  {importingVsix ? "导入中..." : "导入 .vsix"}
                </Button>
              </div>

              {downloadingVsix && (
                <div className="space-y-2">
                  <div className="w-full bg-muted/80 rounded-full h-2 overflow-hidden">
                    <div
                      className="bg-primary h-full rounded-full transition-all duration-300"
                      style={{ width: `${downloadProgressWidth}%` }}
                    />
                  </div>
                  <div className="text-xs text-amber-700 dark:text-amber-300">{downloadMetaText}</div>
                </div>
              )}
            </div>
          )}
        </div>

        {statusCard}
      </div>
    </div>
  )
}
