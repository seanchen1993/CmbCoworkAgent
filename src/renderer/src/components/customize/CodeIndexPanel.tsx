import { useCallback, useEffect, useRef, useState } from "react"
import { Database, Info, Loader2, Square, RotateCcw, CheckCircle2, AlertCircle, FolderOpen } from "lucide-react"
import { cn } from "@/lib/utils"

interface CodeIndexSettings {
  enabled: boolean
  embeddingProvider: string
  embeddingBaseUrl: string
  embeddingApiKey: string
  embeddingModel: string
  embeddingDimensions: number
  vectorWeight: number
  ftsWeight: number
}

interface IndexingStatus {
  state: "idle" | "scanning" | "indexing" | "indexed" | "error"
  message: string
  totalFiles: number
  processedFiles: number
  totalChunks: number
  embeddedChunks: number
  workspacePath: string | null
}

const STATE_CONFIG: Record<string, { label: string; color: string; icon: React.ReactNode }> = {
  idle: { label: "未启动", color: "text-muted-foreground", icon: <Database className="size-3.5" /> },
  scanning: { label: "扫描中", color: "text-blue-500", icon: <Loader2 className="size-3.5 animate-spin" /> },
  indexing: { label: "索引中", color: "text-amber-500", icon: <Loader2 className="size-3.5 animate-spin" /> },
  indexed: { label: "已就绪", color: "text-green-500", icon: <CheckCircle2 className="size-3.5" /> },
  error: { label: "错误", color: "text-red-500", icon: <AlertCircle className="size-3.5" /> },
}

function shortenPath(p: string): string {
  const parts = p.split("/").filter(Boolean)
  if (parts.length <= 3) return p
  return ".../" + parts.slice(-2).join("/")
}

export function CodeIndexPanel(): React.JSX.Element {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [allStatuses, setAllStatuses] = useState<IndexingStatus[]>([])
  const mountedRef = useRef(true)

  // Form state
  const [baseUrl, setBaseUrl] = useState("")
  const [apiKey, setApiKey] = useState("")
  const [model, setModel] = useState("")
  const [dimensions, setDimensions] = useState(1024)
  const [enabled, setEnabled] = useState(false)

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const loadSettings = useCallback(async () => {
    try {
      const s = await window.api.codeIndex.getSettings() as CodeIndexSettings
      if (!mountedRef.current) return
      setBaseUrl(s.embeddingBaseUrl)
      setApiKey(s.embeddingApiKey)
      setModel(s.embeddingModel)
      setDimensions(s.embeddingDimensions)
      setEnabled(s.enabled)
      setLoading(false)
    } catch (e) {
      console.error("[CodeIndexPanel] Failed to load settings:", e)
      if (mountedRef.current) setLoading(false)
    }
  }, [])

  const loadAllStatuses = useCallback(async () => {
    try {
      const statuses = await window.api.codeIndex.getAllStatuses() as IndexingStatus[]
      if (mountedRef.current) setAllStatuses(statuses)
    } catch { /* ignore */ }
  }, [])

  useEffect(() => { loadSettings() }, [loadSettings])
  useEffect(() => { loadAllStatuses() }, [loadAllStatuses])

  // Poll statuses periodically when there are active indexing tasks
  useEffect(() => {
    if (!enabled) return
    const interval = setInterval(loadAllStatuses, 3000)
    return () => clearInterval(interval)
  }, [enabled, loadAllStatuses])

  // Listen for status changes
  useEffect(() => {
    const unsubStatus = window.api.codeIndex.onStatusChanged(() => {
      loadAllStatuses()
    })
    const unsubChanged = window.api.codeIndex.onChanged(() => {
      loadSettings()
      loadAllStatuses()
    })
    return () => { unsubStatus(); unsubChanged() }
  }, [loadSettings, loadAllStatuses])

  const handleSave = useCallback(async () => {
    setSaving(true)
    try {
      await window.api.codeIndex.setSettings({
        embeddingBaseUrl: baseUrl.trim(),
        embeddingApiKey: apiKey.trim(),
        embeddingModel: model.trim(),
        embeddingDimensions: dimensions,
      })
      await loadSettings()
    } catch (e) {
      console.error("[CodeIndexPanel] Failed to save:", e)
    } finally {
      if (mountedRef.current) setSaving(false)
    }
  }, [baseUrl, apiKey, model, dimensions, loadSettings])

  const handleToggleEnabled = useCallback(async () => {
    if (!enabled) {
      if (!baseUrl.trim() || !model.trim()) return
    }
    setSaving(true)
    try {
      const newEnabled = !enabled
      await window.api.codeIndex.setSettings({
        enabled: newEnabled,
        embeddingBaseUrl: baseUrl.trim(),
        embeddingApiKey: apiKey.trim(),
        embeddingModel: model.trim(),
        embeddingDimensions: dimensions,
      })
      setEnabled(newEnabled)
      await loadSettings()
      // Refresh statuses after a short delay to allow indexing to start
      setTimeout(loadAllStatuses, 1000)
    } catch (e) {
      console.error("[CodeIndexPanel] Failed to toggle:", e)
      // Revert to actual state on failure
      await loadSettings()
    } finally {
      if (mountedRef.current) setSaving(false)
    }
  }, [enabled, baseUrl, apiKey, model, dimensions, loadSettings, loadAllStatuses])

  const handleReindex = useCallback(async (workspacePath: string) => {
    try {
      await window.api.codeIndex.reindex(workspacePath)
      setTimeout(loadAllStatuses, 500)
    } catch (e) {
      console.error("[CodeIndexPanel] Reindex failed:", e)
    }
  }, [loadAllStatuses])

  const handleStop = useCallback(async (workspacePath: string) => {
    try {
      await window.api.codeIndex.stop(workspacePath)
      setTimeout(loadAllStatuses, 500)
    } catch (e) {
      console.error("[CodeIndexPanel] Stop failed:", e)
    }
  }, [loadAllStatuses])

  const canEnable = baseUrl.trim() !== "" && model.trim() !== ""

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground text-sm p-8">
        加载中...
      </div>
    )
  }

  return (
    <div className="flex flex-1 overflow-hidden isolate">
      <div className="w-full flex flex-col p-6 gap-8 overflow-y-auto">

        {/* 说明 */}
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-2">
            <Database className="size-5" />
            <h2 className="text-lg font-bold">语义搜索</h2>
            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400">Beta</span>
          </div>

          <div className="flex items-start gap-2 rounded-md border border-blue-500/20 bg-blue-500/5 p-3 text-sm text-blue-600 dark:text-blue-400">
            <Info className="size-4 mt-0.5 shrink-0" />
            <p>为工作区代码建立语义索引，Agent 可通过 <code className="px-1 py-0.5 rounded bg-blue-500/10">codebase_search</code> 工具搜索相关代码片段。需要配置 Embedding 模型（支持 OpenAI 兼容接口，如 BGE-M3）。</p>
          </div>
        </div>

        {/* Embedding 配置 */}
        <div className="flex flex-col gap-4">
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">Embedding 模型配置</h3>

          <div className="flex flex-col gap-3 max-w-lg">
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium">Base URL <span className="text-red-500">*</span></label>
              <input
                type="text"
                className="px-3 py-2 text-sm border border-border rounded-md bg-background focus:outline-none focus:border-primary transition-colors"
                placeholder="http://open-llm.uat.cmbchina.cn/llm/bge-m3-mx/v1"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">OpenAI 兼容的 Embedding API 地址</p>
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium">API Key</label>
              <input
                type="password"
                className="px-3 py-2 text-sm border border-border rounded-md bg-background focus:outline-none focus:border-primary transition-colors"
                placeholder="sk-..."
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
            </div>

            <div className="flex gap-3">
              <div className="flex flex-col gap-1.5 flex-1">
                <label className="text-sm font-medium">模型名称 <span className="text-red-500">*</span></label>
                <input
                  type="text"
                  className="px-3 py-2 text-sm border border-border rounded-md bg-background focus:outline-none focus:border-primary transition-colors"
                  placeholder="bge-m3-mx"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                />
              </div>

              <div className="flex flex-col gap-1.5 w-28">
                <label className="text-sm font-medium">向量维度</label>
                <input
                  type="number"
                  className="px-3 py-2 text-sm border border-border rounded-md bg-background focus:outline-none focus:border-primary transition-colors"
                  value={dimensions}
                  onChange={(e) => setDimensions(Number(e.target.value) || 1024)}
                />
              </div>
            </div>

            <button
              onClick={handleSave}
              disabled={saving}
              className={cn(
                "self-start rounded-md px-4 py-2 text-sm font-medium transition-colors",
                saving
                  ? "bg-muted text-muted-foreground cursor-not-allowed"
                  : "bg-primary text-primary-foreground hover:bg-primary/90"
              )}
            >
              {saving ? "保存中..." : "保存配置"}
            </button>
          </div>
        </div>

        {/* 启用开关 */}
        <div className="flex flex-col gap-4">
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">索引控制</h3>

          <button
            onClick={handleToggleEnabled}
            disabled={saving || (!enabled && !canEnable)}
            className={cn(
              "flex items-center justify-between max-w-lg rounded-lg border-2 p-4 text-left transition-colors",
              (saving || (!enabled && !canEnable)) && "opacity-60 cursor-not-allowed",
              enabled
                ? "border-green-500 bg-green-500/5"
                : "border-border hover:border-green-500/40 hover:bg-muted/40"
            )}
          >
            <div className="flex items-center gap-3">
              <Database className={cn("size-4 shrink-0", enabled ? "text-green-500" : "text-muted-foreground")} />
              <div className="flex flex-col gap-1">
                <span className="text-sm font-medium">启用语义索引</span>
                <p className="text-xs text-muted-foreground">
                  {canEnable
                    ? "开启后将自动为工作区代码建立语义索引"
                    : "请先填写 Base URL 和模型名称"
                  }
                </p>
              </div>
            </div>
            <div className={cn(
              "relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors",
              enabled ? "bg-green-500" : "bg-muted-foreground/30"
            )}>
              <span className={cn(
                "inline-block size-4 rounded-full bg-white shadow transition-transform mt-0.5",
                enabled ? "translate-x-4" : "translate-x-0.5"
              )} />
            </div>
          </button>
        </div>

        {/* 工作区索引列表 */}
        {enabled && (
          <div className="flex flex-col gap-4">
            <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">工作区索引状态</h3>

            {allStatuses.length === 0 ? (
              <div className="flex items-start gap-2 rounded-md border border-border bg-muted/30 p-3 text-sm text-muted-foreground max-w-lg">
                <Info className="size-4 mt-0.5 shrink-0" />
                <p>暂无已索引的工作区。选择工作区或发起对话后将自动开始索引。</p>
              </div>
            ) : (
              <div className="flex flex-col gap-3 max-w-2xl">
                {allStatuses.map((ws, index) => {
                  const conf = STATE_CONFIG[ws.state] ?? STATE_CONFIG.idle
                  const isWsIndexing = ws.state === "scanning" || ws.state === "indexing"
                  return (
                    <div
                      key={ws.workspacePath ?? `unknown-${index}`}
                      className={cn(
                        "rounded-lg border p-4 flex flex-col gap-3",
                        ws.state === "error"
                          ? "border-red-500/20 bg-red-500/5"
                          : ws.state === "indexed"
                            ? "border-green-500/20 bg-green-500/5"
                            : isWsIndexing
                              ? "border-amber-500/20 bg-amber-500/5"
                              : "border-border bg-muted/20"
                      )}
                    >
                      {/* Header: path + status */}
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-2 min-w-0">
                          <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
                          <span className="text-sm font-medium truncate" title={ws.workspacePath ?? ""}>
                            {ws.workspacePath ? shortenPath(ws.workspacePath) : "未知"}
                          </span>
                        </div>
                        <div className={cn("flex items-center gap-1.5 shrink-0", conf.color)}>
                          {conf.icon}
                          <span className="text-xs font-medium">{conf.label}</span>
                        </div>
                      </div>

                      {/* Progress bar */}
                      {isWsIndexing && ws.totalFiles > 0 && (
                        <div className="flex flex-col gap-1">
                          <div className="flex justify-between text-xs text-muted-foreground">
                            <span>{ws.message}</span>
                            <span>{ws.processedFiles} / {ws.totalFiles}</span>
                          </div>
                          <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                            <div
                              className="h-full rounded-full bg-amber-500 transition-all duration-300"
                              style={{ width: `${Math.round((ws.processedFiles / ws.totalFiles) * 100)}%` }}
                            />
                          </div>
                        </div>
                      )}

                      {/* Error message */}
                      {ws.state === "error" && ws.message && (
                        <p className="text-xs text-red-600 dark:text-red-400">{ws.message}</p>
                      )}

                      {/* Stats + actions */}
                      <div className="flex items-center justify-between">
                        <div className="flex gap-4 text-xs text-muted-foreground">
                          {(ws.state === "indexed" || ws.totalChunks > 0) && (
                            <>
                              <span>代码块: <strong className="text-foreground">{ws.totalChunks}</strong></span>
                              <span>已向量化: <strong className="text-foreground">{ws.embeddedChunks}</strong></span>
                            </>
                          )}
                        </div>
                        <div className="flex gap-2">
                          {isWsIndexing ? (
                            <button
                              onClick={() => ws.workspacePath && handleStop(ws.workspacePath)}
                              className="flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium border border-red-500/30 text-red-600 dark:text-red-400 hover:bg-red-500/10 transition-colors"
                            >
                              <Square className="size-3" />
                              停止
                            </button>
                          ) : (
                            <button
                              onClick={() => ws.workspacePath && handleReindex(ws.workspacePath)}
                              className="flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium border border-border hover:bg-muted text-foreground transition-colors"
                            >
                              <RotateCcw className="size-3" />
                              重建
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}

      </div>
    </div>
  )
}
