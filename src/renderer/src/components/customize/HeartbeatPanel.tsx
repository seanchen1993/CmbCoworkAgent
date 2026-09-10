import { useCallback, useEffect, useState, useRef } from "react"
import { FolderOpen, Play, Loader2, HeartPulse, RotateCcw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ToggleThumb } from "@/components/ui/toggle-thumb"
import { cn } from "@/lib/utils"
import type { HeartbeatConfig } from "@/types"

const INTERVAL_OPTIONS = [
  { value: 15, label: "15 分钟" },
  { value: 30, label: "30 分钟" },
  { value: 60, label: "1 小时" },
  { value: 120, label: "2 小时" }
]

const selectClass =
  "w-full h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"

function formatDate(iso: string | null): string {
  if (!iso) return "-"
  return new Date(iso).toLocaleString()
}

function statusLabel(status: HeartbeatConfig["lastRunStatus"]): string {
  if (status === "ok") return "成功（有输出）"
  if (status === "ok_silent") return "成功（无事可做）"
  if (status === "skipped") return "跳过（无任务）"
  if (status === "error") return "出错"
  return "-"
}

export function HeartbeatPanel(): React.JSX.Element {
  const [config, setConfig] = useState<HeartbeatConfig | null>(null)
  const [content, setContent] = useState("")
  const [models, setModels] = useState<Array<{ id: string; name: string }>>([])
  const [running, setRunning] = useState(false)
  const [saving, setSaving] = useState(false)
  const mountedRef = useRef(true)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const promptTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      if (promptTimerRef.current) clearTimeout(promptTimerRef.current)
    }
  }, [])

  const loadAll = useCallback(async () => {
    try {
      const [cfg, md, isRunning, modelConfigs] = await Promise.all([
        window.api.heartbeat.getConfig(),
        window.api.heartbeat.getContent(),
        window.api.heartbeat.isRunning(),
        window.api.models.list()
      ])
      if (!mountedRef.current) return
      setConfig(cfg)
      setContent(md)
      setRunning(isRunning)
      setModels(modelConfigs.map((c) => ({ id: c.id, name: c.name })))
    } catch (e) {
      console.error("[HeartbeatPanel] load error:", e)
    }
  }, [])

  useEffect(() => {
    loadAll()
  }, [loadAll])

  useEffect(() => {
    return window.api.heartbeat.onChanged(() => {
      loadAll()
    })
  }, [loadAll])

  const saveConfig = useCallback(async (updates: Partial<HeartbeatConfig>) => {
    try {
      await window.api.heartbeat.saveConfig(updates)
    } catch (e) {
      console.error("[HeartbeatPanel] saveConfig error:", e)
    }
  }, [])

  const handleToggleEnabled = useCallback(async (enabled: boolean) => {
    setConfig((prev) => prev ? { ...prev, enabled } : prev)
    await saveConfig({ enabled })
  }, [saveConfig])

  const handleIntervalChange = useCallback(async (value: string) => {
    const intervalMinutes = Number(value)
    setConfig((prev) => prev ? { ...prev, intervalMinutes } : prev)
    await saveConfig({ intervalMinutes })
  }, [saveConfig])

  const handleModelChange = useCallback(async (modelId: string) => {
    setConfig((prev) => prev ? { ...prev, modelId } : prev)
    await saveConfig({ modelId })
  }, [saveConfig])

  const handleSelectWorkDir = useCallback(async () => {
    const result = await window.api.workspace.select()
    if (result) {
      setConfig((prev) => prev ? { ...prev, workDir: result } : prev)
      await saveConfig({ workDir: result })
    }
  }, [saveConfig])

  const handleContentChange = useCallback((value: string) => {
    setContent(value)
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(async () => {
      setSaving(true)
      try {
        await window.api.heartbeat.saveContent(value)
      } catch (e) {
        console.error("[HeartbeatPanel] saveContent error:", e)
      } finally {
        if (mountedRef.current) setSaving(false)
      }
    }, 800)
  }, [])

  const handleRunNow = useCallback(async () => {
    try {
      setRunning(true)
      await window.api.heartbeat.runNow()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      alert(msg)
      setRunning(false)
    }
  }, [])

  const handlePromptChange = useCallback((prompt: string) => {
    setConfig((prev) => prev ? { ...prev, prompt } : prev)
    if (promptTimerRef.current) clearTimeout(promptTimerRef.current)
    promptTimerRef.current = setTimeout(async () => {
      await saveConfig({ prompt })
    }, 800)
  }, [saveConfig])

  const handleReset = useCallback(async () => {
    try {
      const defaults = await window.api.heartbeat.resetConfig()
      setConfig(defaults)
    } catch (e) {
      console.error("[HeartbeatPanel] reset error:", e)
    }
  }, [])

  if (!config) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
        加载中...
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-auto">
      <div className="max-w-2xl mx-auto p-6 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <HeartPulse className="size-5 text-red-400" />
            <h2 className="text-lg font-semibold">Heartbeat</h2>
          </div>
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
              <ToggleThumb
                className={cn(
                  "inline-block size-4",
                  config.enabled ? "translate-x-4" : "translate-x-0"
                )}
              />
            </button>
          </label>
          </div>
        </div>

        {/* Settings */}
        <div className="space-y-4">
          {/* Interval */}
          <div>
            <label className="text-sm font-medium">检查间隔</label>
            <select
              className={cn(selectClass, "mt-1")}
              value={config.intervalMinutes}
              onChange={(e) => handleIntervalChange(e.target.value)}
            >
              {INTERVAL_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          {/* Model */}
          <div>
            <label className="text-sm font-medium">模型</label>
            <select
              className={cn(selectClass, "mt-1")}
              value={config.modelId || ""}
              onChange={(e) => handleModelChange(e.target.value)}
            >
              <option value="" disabled>
                请选择模型
              </option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </div>

          {/* Work Dir */}
          <div>
            <label className="text-sm font-medium">工作目录</label>
            <div className="flex gap-2 mt-1">
              <Input
                value={config.workDir || ""}
                readOnly
                placeholder="请选择工作目录"
                className="flex-1 text-sm"
              />
              <Button variant="outline" size="sm" onClick={handleSelectWorkDir}>
                <FolderOpen className="size-4 mr-1" />
                选择
              </Button>
            </div>
          </div>

          {/* Prompt */}
          <div>
            <label className="text-sm font-medium">Heartbeat 提示词</label>
            <textarea
              className="mt-1 w-full min-h-[80px] rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-y"
              value={config.prompt}
              onChange={(e) => handlePromptChange(e.target.value)}
              rows={3}
            />
          </div>
        </div>

        {/* HEARTBEAT.md Editor */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-sm font-medium">HEARTBEAT.md</label>
            {saving && <span className="text-xs text-muted-foreground">保存中...</span>}
          </div>
          <p className="text-xs text-muted-foreground mb-2">
            在下方编辑 HEARTBEAT.md 的内容。Heartbeat
            会定期读取此文件并按内容执行。内容为空时会跳过执行。
          </p>
          <textarea
            className="w-full min-h-[200px] rounded-md border border-input bg-transparent px-3 py-2 text-sm font-mono shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-y"
            value={content}
            onChange={(e) => handleContentChange(e.target.value)}
            placeholder={"# Heartbeat 任务\n\n- [ ] 检查项目构建状态\n- [ ] 查看是否有新的 issue"}
            rows={10}
          />
        </div>

        {/* Status & Run */}
        <div className="rounded-md border border-border p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">运行状态</span>
            <Button
              variant="outline"
              size="sm"
              disabled={running || !config.modelId || !config.workDir}
              onClick={handleRunNow}
            >
              {running ? (
                <Loader2 className="size-4 mr-1 animate-spin" />
              ) : (
                <Play className="size-4 mr-1" />
              )}
              {running ? "运行中..." : "立即运行"}
            </Button>
          </div>
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div className="text-muted-foreground">上次运行</div>
            <div>{formatDate(config.lastRunAt)}</div>
            <div className="text-muted-foreground">运行结果</div>
            <div className={cn(
              config.lastRunStatus === "error" && "text-destructive",
              config.lastRunStatus === "ok" && "text-green-500",
              config.lastRunStatus === "ok_silent" && "text-muted-foreground"
            )}>
              {statusLabel(config.lastRunStatus)}
            </div>
            {config.lastRunError && (
              <>
                <div className="text-muted-foreground">错误信息</div>
                <div className="text-destructive text-xs">{config.lastRunError}</div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
