import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  Download,
  FileText,
  Loader2,
  Network,
  RefreshCw,
  Route,
  ShieldCheck,
  Trash2
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"

type TaskMmdSettings = Awaited<ReturnType<typeof window.api.taskMmd.getSettings>>
type TaskMmdSnapshot = Awaited<ReturnType<typeof window.api.taskMmd.getSnapshot>>
type TaskMmdCompileModelInfo = Awaited<ReturnType<typeof window.api.taskMmd.getCompileModelInfo>>
type TaskMmdEntry = TaskMmdSnapshot["entries"][number]

interface TaskMmdPanelProps {
  threadId?: string | null
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function formatDate(value: string | null): string {
  if (!value) return "尚未生成"
  return new Date(value).toLocaleString()
}

function formatTier(tier: "economy" | "premium" | null): string {
  if (!tier) return "未解析"
  return tier === "economy" ? "经济" : "高级"
}

function formatModelSource(source: TaskMmdCompileModelInfo["source"]): string {
  switch (source) {
    case "tier":
      return "按档位"
    case "routing":
      return "按路由"
    case "fallback":
      return "已回退"
    case "none":
      return "无可用模型"
  }
}

function formatBaseUrl(value: string | null): string {
  if (!value) return "未配置服务地址"
  try {
    const url = new URL(value)
    return url.host || value
  } catch {
    return value
  }
}

function exportText(filename: string, text: string): void {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

function EntryRow({ entry }: { entry: TaskMmdEntry }): React.JSX.Element {
  return (
    <div className="rounded-md border border-border/70 bg-background px-2.5 py-2">
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "size-1.5 rounded-full",
            entry.status === "error" ? "bg-destructive" : "bg-emerald-500"
          )}
        />
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{entry.toolName}</span>
        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
          {entry.scope}
        </span>
      </div>
      <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">
        {entry.resultPreview || entry.argsPreview || "(empty)"}
      </p>
      <p className="mt-1 text-[10px] text-muted-foreground/70">
        {new Date(entry.timestamp).toLocaleTimeString()} · {entry.durationMs}ms
      </p>
    </div>
  )
}

export function TaskMmdPanel({ threadId }: TaskMmdPanelProps): React.JSX.Element {
  const [settings, setSettings] = useState<TaskMmdSettings | null>(null)
  const [snapshot, setSnapshot] = useState<TaskMmdSnapshot | null>(null)
  const [compileModelInfo, setCompileModelInfo] =
    useState<TaskMmdCompileModelInfo | null>(null)
  const [directorySize, setDirectorySize] = useState(0)
  const [svg, setSvg] = useState("")
  const [renderError, setRenderError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const mountedRef = useRef(true)
  const renderId = useMemo(() => `task-mmd-${Math.random().toString(36).slice(2)}`, [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const loadData = useCallback(async () => {
    setLoading(true)
    try {
      const nextSettings = await window.api.taskMmd.getSettings()
      if (!mountedRef.current) return
      setSettings(nextSettings)

      if (!threadId) {
        setSnapshot(null)
        setCompileModelInfo(null)
        setDirectorySize(0)
        return
      }

      const [nextSnapshot, nextSize, nextModelInfo] = await Promise.all([
        window.api.taskMmd.getSnapshot(threadId),
        window.api.taskMmd.getDirectorySize(threadId),
        window.api.taskMmd.getCompileModelInfo(threadId)
      ])
      if (!mountedRef.current) return
      setSnapshot(nextSnapshot)
      setCompileModelInfo(nextModelInfo)
      setDirectorySize(nextSize)
    } catch (error) {
      console.error(error)
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }, [threadId])

  useEffect(() => {
    loadData()
  }, [loadData])

  useEffect(() => {
    return window.api.taskMmd.onChanged((payload) => {
      if (!payload.threadId || payload.threadId === threadId) {
        loadData()
      }
    })
  }, [loadData, threadId])

  useEffect(() => {
    if (!settings?.enabled || !threadId) return
    const id = window.setInterval(() => {
      loadData()
    }, 5000)
    return () => window.clearInterval(id)
  }, [loadData, settings?.enabled, threadId])

  useEffect(() => {
    let cancelled = false
    async function render(): Promise<void> {
      const mmd = snapshot?.mmd?.trim()
      if (!mmd) {
        setSvg("")
        setRenderError(null)
        return
      }
      try {
        const mermaid = await import("mermaid")
        mermaid.default.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: "base",
          themeVariables: {
            fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
            primaryColor: "#eef6ff",
            primaryBorderColor: "#5b8def",
            primaryTextColor: "#172033",
            lineColor: "#7a8496",
            secondaryColor: "#f5f7fb",
            tertiaryColor: "#fff7ed"
          }
        })
        const result = await mermaid.default.render(renderId, mmd)
        if (!cancelled) {
          setSvg(result.svg)
          setRenderError(null)
        }
      } catch (error) {
        if (!cancelled) {
          setSvg("")
          setRenderError(error instanceof Error ? error.message : String(error))
        }
      }
    }
    render()
    return () => {
      cancelled = true
    }
  }, [renderId, snapshot?.mmd])

  const updateSettings = useCallback(
    async (patch: Partial<TaskMmdSettings>) => {
      setSaving(true)
      try {
        const next = await window.api.taskMmd.setSettings(patch)
        if (mountedRef.current) setSettings(next)
      } catch (error) {
        console.error(error)
      } finally {
        if (mountedRef.current) setSaving(false)
      }
    },
    []
  )

  const clearThread = useCallback(async () => {
    if (!threadId) return
    if (!confirm("确定清空当前线程的任务画布吗？此操作不可撤销。")) return
    await window.api.taskMmd.clearThread(threadId)
    await loadData()
  }, [loadData, threadId])

  const currentSettings = settings
  const state = snapshot?.state
  const entries = snapshot?.entries ?? []

  return (
    <div className="flex flex-1 overflow-hidden isolate">
      <div className="w-[340px] shrink-0 border-r border-border flex flex-col">
        <div className="space-y-3 border-b border-border p-3">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <h2 className="text-base font-bold">Task MMD</h2>
              <p className="truncate text-xs text-muted-foreground">
                {threadId ? `线程 ${threadId}` : "未选择线程"}
              </p>
            </div>
            <button
              className={cn(
                "shrink-0 rounded-full border px-2 py-0.5 text-xs transition-colors",
                currentSettings?.enabled
                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                  : "border-border bg-muted text-muted-foreground"
              )}
              disabled={!currentSettings || saving}
              onClick={() => updateSettings({ enabled: !currentSettings?.enabled })}
            >
              {currentSettings?.enabled ? "已启用" : "已禁用"}
            </button>
          </div>

          <div className="grid grid-cols-2 gap-2 text-[11px]">
            <div className="rounded-md border border-border/70 bg-muted/30 p-2">
              <p className="text-muted-foreground">工具记录</p>
              <p className="mt-1 text-sm font-semibold">{state?.totalEntryCount ?? 0}</p>
            </div>
            <div className="rounded-md border border-border/70 bg-muted/30 p-2">
              <p className="text-muted-foreground">目录大小</p>
              <p className="mt-1 text-sm font-semibold">{formatSize(directorySize)}</p>
            </div>
            <div className="col-span-2 rounded-md border border-border/70 bg-muted/30 p-2">
              <p className="text-muted-foreground">最近编译</p>
              <p className="mt-1 truncate text-xs font-medium">{formatDate(state?.lastCompiledAt ?? null)}</p>
            </div>
          </div>

          <div className="space-y-2">
            <label className="block text-[11px] font-medium text-muted-foreground">
              编译模型
            </label>
            <div className="grid grid-cols-2 gap-1 rounded-md border border-border/70 bg-muted/30 p-1">
              {(["economy", "premium"] as const).map((tier) => (
                <button
                  key={tier}
                  className={cn(
                    "rounded-sm px-2 py-1.5 text-xs transition-colors",
                    currentSettings?.compileModelTier === tier
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:bg-background/60"
                  )}
                  disabled={!currentSettings || saving}
                  onClick={() => updateSettings({ compileModelTier: tier })}
                >
                  {tier === "economy" ? "经济" : "高级"}
                </button>
              ))}
            </div>
            <div className="rounded-md border border-border/70 bg-muted/30 p-2 text-[11px] leading-relaxed">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-muted-foreground">实际使用</span>
                <span className="shrink-0 text-muted-foreground">
                  {compileModelInfo ? formatModelSource(compileModelInfo.source) : "正在解析"}
                </span>
              </div>
              <p className="mt-1 truncate text-xs font-semibold">
                {compileModelInfo?.name ?? "未配置可用模型"}
              </p>
              <p className="mt-0.5 truncate text-muted-foreground">
                {compileModelInfo?.model ?? "会使用确定性兜底图谱"}
              </p>
              {compileModelInfo ? (
                <p className="mt-0.5 truncate text-muted-foreground">
                  {formatTier(compileModelInfo.resolvedTier)} · {formatBaseUrl(compileModelInfo.baseUrl)}
                </p>
              ) : null}
              {compileModelInfo?.reason ? (
                <p className="mt-1 line-clamp-2 text-muted-foreground">
                  {compileModelInfo.reason}
                </p>
              ) : null}
            </div>

            <label className="block text-[11px] font-medium text-muted-foreground">
              触发条数
            </label>
            <Input
              type="number"
              min={1}
              max={50}
              value={currentSettings?.l2NullThreshold ?? 4}
              disabled={!currentSettings || saving}
              onChange={(event) =>
                updateSettings({ l2NullThreshold: Number(event.currentTarget.value) })
              }
            />
            <label className="block text-[11px] font-medium text-muted-foreground">
              触发间隔（秒）
            </label>
            <Input
              type="number"
              min={10}
              max={3600}
              value={currentSettings?.l2TimeoutSeconds ?? 300}
              disabled={!currentSettings || saving}
              onChange={(event) =>
                updateSettings({ l2TimeoutSeconds: Number(event.currentTarget.value) })
              }
            />
          </div>

          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" className="flex-1" onClick={loadData}>
              {loading ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
              刷新
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!snapshot?.mmd}
              onClick={() => exportText("task-map.mmd", snapshot?.mmd ?? "")}
            >
              <Download className="size-3" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-destructive"
              disabled={!threadId}
              onClick={clearThread}
            >
              <Trash2 className="size-3" />
            </Button>
          </div>

          <div className="rounded-md border border-border/70 bg-muted/30 p-2 text-[11px] leading-relaxed text-muted-foreground">
            设置为全局生效。编译时只发送脱敏后的工具摘要到所选模型，不保存完整工具结果。
          </div>
        </div>

        <ScrollArea className="flex-1">
          <div className="space-y-2 p-2">
            {entries.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                <Route className="mb-2 size-8 opacity-40" />
                <p className="text-xs">暂无工具轨迹</p>
              </div>
            ) : (
              entries
                .slice()
                .reverse()
                .map((entry) => <EntryRow key={entry.id} entry={entry} />)
            )}
          </div>
        </ScrollArea>
      </div>

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="flex items-center justify-between border-b border-border p-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex size-9 items-center justify-center rounded-md border border-border bg-muted/40">
              <Network className="size-4 text-primary" />
            </div>
            <div className="min-w-0">
              <h3 className="text-sm font-semibold">当前任务画布</h3>
              <p className="truncate text-xs text-muted-foreground">
                {state?.compileStatus === "compiling"
                  ? "编译中"
                  : state?.compileStatus === "error"
                    ? state.lastError || "编译失败"
                    : state?.lastCompileMode === "fallback"
                      ? `使用兜底图谱${state.lastError ? `：${state.lastError}` : ""}`
                    : snapshot?.mmd
                      ? "已生成"
                      : "等待工具调用"}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1.5 rounded-md border border-border/70 bg-muted/30 px-2 py-1 text-[11px] text-muted-foreground">
            <ShieldCheck className="size-3" />
            <span>仅保存摘要</span>
          </div>
        </div>

        <ScrollArea className="flex-1">
          <div className="p-4">
            {!threadId ? (
              <div className="flex min-h-[360px] items-center justify-center text-sm text-muted-foreground">
                请先选择一个会话线程
              </div>
            ) : renderError ? (
              <pre className="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-xs text-destructive whitespace-pre-wrap">
                {renderError}
              </pre>
            ) : svg ? (
              <div
                className="min-h-[360px] overflow-auto rounded-md border border-border bg-background p-4"
                dangerouslySetInnerHTML={{ __html: svg }}
              />
            ) : (
              <div className="flex min-h-[360px] flex-col items-center justify-center rounded-md border border-dashed border-border text-muted-foreground">
                <FileText className="mb-3 size-8 opacity-40" />
                <p className="text-sm">暂无 Mermaid 图</p>
                <p className="mt-1 text-xs">启用后，执行几次工具调用会自动生成</p>
              </div>
            )}

            {snapshot?.mmd ? (
              <pre className="mt-4 overflow-auto rounded-md border border-border/70 bg-muted/30 p-3 text-xs leading-relaxed">
                {snapshot.mmd}
              </pre>
            ) : null}
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}
