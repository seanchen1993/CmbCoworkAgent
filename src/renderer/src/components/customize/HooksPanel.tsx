import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Plus, Search, X, Pencil, Trash2, Webhook, Terminal, BrainCircuit } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import { useAppStore } from "@/lib/store"
import type { HookConfig, HookEvent } from "@/types"
import { AddHookDialog, COMMON_TOOLS } from "./AddHookDialog"

const EVENT_BADGE: Record<HookEvent, { label: string; className: string }> = {
  PreToolUse:   { label: "调用前", className: "bg-blue-500/15 text-blue-600 dark:text-blue-400" },
  PostToolUse:  { label: "调用后", className: "bg-green-500/15 text-green-600 dark:text-green-400" },
  Stop:         { label: "停止",   className: "bg-amber-500/15 text-amber-600 dark:text-amber-400" },
  Notification: { label: "通知",   className: "bg-purple-500/15 text-purple-600 dark:text-purple-400" }
}

/** Human-readable summary shown in the list item */
function hookSummary(hook: HookConfig): string {
  if (hook.type === "prompt") return hook.prompt ?? ""
  return hook.command ?? ""
}

export function HooksPanel(): React.JSX.Element {
  const [hooks, setHooks] = useState<HookConfig[]>([])
  const [selectedHook, setSelectedHook] = useState<HookConfig | null>(null)
  const [searchQuery, setSearchQuery] = useState("")
  const [debouncedQuery, setDebouncedQuery] = useState("")
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editHook, setEditHook] = useState<HookConfig | null>(null)
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const handleSearchChange = useCallback((value: string) => {
    setSearchQuery(value)
    clearTimeout(debounceTimer.current)
    debounceTimer.current = setTimeout(() => setDebouncedQuery(value), 200)
  }, [])

  const loadHooks = useCallback(async () => {
    try {
      const list = await window.api.hooks.list()
      setHooks(list)
      setSelectedHook((prev) => {
        if (!prev) return null
        return list.find((h) => h.id === prev.id) ?? null
      })
    } catch (e) {
      console.error(e)
    }
  }, [])

  useEffect(() => { loadHooks() }, [loadHooks])

  const filteredHooks = useMemo(() => {
    const q = debouncedQuery.trim().toLowerCase()
    if (!q) return hooks
    return hooks.filter((h) => {
      const summary = hookSummary(h).toLowerCase()
      return (
        summary.includes(q) ||
        h.event.toLowerCase().includes(q) ||
        (h.matcher && h.matcher.toLowerCase().includes(q)) ||
        (h.type === "prompt" ? "自然语言策略" : "命令").includes(q)
      )
    })
  }, [hooks, debouncedQuery])

  const handleToggleEnabled = useCallback((id: string, enabled: boolean) => {
    window.api.hooks.setEnabled(id, enabled).catch(console.error)
    setHooks((prev) => prev.map((h) => (h.id === id ? { ...h, enabled } : h)))
    setSelectedHook((prev) => (prev?.id === id ? { ...prev, enabled } : prev))
  }, [])

  const handleDelete = useCallback(
    async (hook: HookConfig) => {
      try {
        await window.api.hooks.delete(hook.id)
        setSelectedHook((prev) => (prev?.id === hook.id ? null : prev))
        await loadHooks()
      } catch (e) {
        console.error(e)
      }
    },
    [loadHooks]
  )

  const handleAddSuccess = useCallback(() => { loadHooks() }, [loadHooks])

  return (
    <>
      {/* Left list column */}
      <div className="w-[330px] shrink-0 border-r border-border flex flex-col">
        <div className="p-3 border-b border-border space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-base font-bold">钩子</h2>
            <div className="flex items-center gap-1">
              <div className="relative flex-1 min-w-[120px] max-w-[160px]">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground pointer-events-none" />
                <Input
                  placeholder="搜索"
                  value={searchQuery}
                  onChange={(e) => handleSearchChange(e.target.value)}
                  className="h-7 pl-7 pr-6 text-xs"
                />
                {searchQuery && (
                  <button
                    type="button"
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground p-0.5 rounded"
                    onClick={() => { setSearchQuery(""); setDebouncedQuery("") }}
                    aria-label="清除"
                  >
                    <X className="size-3" />
                  </button>
                )}
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0 shrink-0"
                onClick={() => { setEditHook(null); setDialogOpen(true) }}
              >
                <Plus className="size-4" />
              </Button>
            </div>
          </div>
        </div>
        <ScrollArea className="flex-1">
          <div className="p-2 space-y-2">
            {filteredHooks.length === 0 ? (
              <p className="text-xs text-muted-foreground px-1 py-2">
                {hooks.length === 0 ? "暂无钩子，点击 + 添加" : "没有匹配的钩子"}
              </p>
            ) : (
              filteredHooks.map((hook) => {
                const badge = EVENT_BADGE[hook.event]
                const isPrompt = hook.type === "prompt"
                const summary = hookSummary(hook)
                return (
                  <button
                    key={hook.id}
                    className={cn(
                      "w-full flex items-center gap-2 px-2 py-1.5 rounded-md border border-border/70 text-left transition-colors",
                      selectedHook?.id === hook.id ? "bg-muted/70" : "hover:bg-muted/50"
                    )}
                    onClick={() => setSelectedHook(hook)}
                  >
                    <span className={cn("text-[10px] font-medium px-1.5 py-0.5 rounded-full shrink-0", badge.className)}>
                      {badge.label}
                    </span>
                    {/* type icon */}
                    {isPrompt
                      ? <BrainCircuit className="size-3 shrink-0 text-violet-500" />
                      : <Terminal className="size-3 shrink-0 text-muted-foreground" />
                    }
                    <span className={cn(
                      "text-sm truncate flex-1",
                      isPrompt ? "italic" : "font-mono",
                      !hook.enabled && "text-muted-foreground"
                    )}>
                      {summary}
                    </span>
                    {!hook.enabled && (
                      <span className="text-[10px] text-muted-foreground shrink-0">已禁用</span>
                    )}
                  </button>
                )
              })
            )}
          </div>
        </ScrollArea>
      </div>

      {/* Right detail column */}
      <div className="flex-1 overflow-auto">
        {selectedHook ? (
          <HookDetail
            hook={selectedHook}
            onToggleEnabled={handleToggleEnabled}
            onDelete={handleDelete}
            onEdit={(h) => { setEditHook(h); setDialogOpen(true) }}
          />
        ) : (
          <EmptyState />
        )}
      </div>

      <AddHookDialog
        open={dialogOpen}
        onOpenChange={(open) => { setDialogOpen(open); if (!open) setEditHook(null) }}
        onSuccess={handleAddSuccess}
        editHook={editHook}
      />
    </>
  )
}

/* ── Hook detail view ──────────────────────────────────────────────── */

function HookDetail(props: {
  hook: HookConfig
  onToggleEnabled: (id: string, enabled: boolean) => void
  onDelete: (hook: HookConfig) => void
  onEdit: (hook: HookConfig) => void
}): React.JSX.Element {
  const { hook, onToggleEnabled, onDelete, onEdit } = props
  const badge = EVENT_BADGE[hook.event]
  const isPrompt = hook.type === "prompt"
  const { models } = useAppStore()
  const modelName = hook.modelId
    ? (models.find((m) => m.id === hook.modelId)?.name ?? hook.modelId)
    : null

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1 min-w-0">
          <div className="flex items-center gap-2">
            {isPrompt
              ? <BrainCircuit className="size-4 text-violet-500 shrink-0" />
              : <Terminal className="size-4 text-muted-foreground shrink-0" />
            }
            <h3 className={cn("text-base font-bold truncate", isPrompt ? "italic" : "font-mono")}>
              {isPrompt ? (hook.prompt ?? "").slice(0, 60) + ((hook.prompt?.length ?? 0) > 60 ? "…" : "") : (hook.command ?? "")}
            </h3>
          </div>
          <div className="flex items-center gap-2">
            <span className={cn("text-[10px] font-medium px-1.5 py-0.5 rounded-full", badge.className)}>
              {badge.label}
            </span>
            <span className={cn(
              "text-[10px] font-medium px-1.5 py-0.5 rounded-full",
              isPrompt
                ? "bg-violet-500/15 text-violet-600 dark:text-violet-400"
                : "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400"
            )}>
              {isPrompt ? "自然语言策略" : "Shell 命令"}
            </span>
            {hook.matcher && (
              <span className="text-xs text-muted-foreground font-mono">
                matcher: {hook.matcher}
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => onEdit(hook)} title="编辑">
            <Pencil className="size-3.5" />
          </Button>
          <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-destructive hover:text-destructive" onClick={() => onDelete(hook)} title="删除">
            <Trash2 className="size-3.5" />
          </Button>
          <Button
            variant={hook.enabled ? "default" : "outline"}
            size="sm"
            className="h-7 text-xs ml-1"
            onClick={() => onToggleEnabled(hook.id, !hook.enabled)}
          >
            {hook.enabled ? "已启用" : "已禁用"}
          </Button>
        </div>
      </div>

      {/* Details */}
      <div className="space-y-4">
        <DetailRow label="事件类型" value={badge.label} />
        {hook.matcher && (() => {
          const preset = COMMON_TOOLS.find((t) => t.value !== "custom" && t.value === hook.matcher)
          return <DetailRow label="工具匹配" value={preset ? `${preset.label}（${hook.matcher}）` : hook.matcher} mono={!preset} />
        })()}

        {isPrompt ? (
          <>
            <div className="flex items-start gap-4">
              <span className="text-sm text-muted-foreground w-20 shrink-0">合规策略</span>
              <div className="flex-1 rounded-md bg-muted/50 px-3 py-2 text-sm whitespace-pre-wrap break-all border border-border/50">
                {hook.prompt}
              </div>
            </div>
            {modelName && <DetailRow label="判决模型" value={modelName} />}
            <DetailRow
              label="超时回退"
              value={hook.fallback === "block" ? "严格（默认阻断）" : "宽松（默认放行）"}
            />
          </>
        ) : (
          <DetailRow label="命令" value={hook.command ?? ""} mono />
        )}

        <DetailRow label="超时" value={`${hook.timeout ?? 10000}ms`} />
        <DetailRow label="创建时间" value={formatTime(hook.createdAt)} />
        <DetailRow label="更新时间" value={formatTime(hook.updatedAt)} />
      </div>
    </div>
  )
}

function DetailRow(props: { label: string; value: string; mono?: boolean }): React.JSX.Element {
  return (
    <div className="flex items-start gap-4">
      <span className="text-sm text-muted-foreground w-20 shrink-0">{props.label}</span>
      <span className={cn("text-sm break-all", props.mono && "font-mono")}>{props.value}</span>
    </div>
  )
}

function formatTime(iso: string): string {
  try { return new Date(iso).toLocaleString() } catch { return iso }
}

/* ── Empty state ─────────────────────────────────────────────────── */

function EmptyState(): React.JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center h-full text-center px-8 py-12">
      <Webhook className="size-12 text-muted-foreground/40 mb-4" />
      <h3 className="text-base font-bold mb-2">钩子</h3>
      <p className="text-sm text-muted-foreground max-w-md mb-6">
        钩子允许你在 Agent 生命周期的关键节点执行 Shell 命令，或通过自然语言描述让行内 LLM 实时判决工具调用是否合规。
      </p>
      <div className="text-left text-sm text-muted-foreground space-y-3 max-w-md">
        <div className="space-y-1">
          <p className="font-medium text-foreground flex items-center gap-1.5">
            <Terminal className="size-3.5" /> Shell 命令模式
          </p>
          <p className="text-xs pl-5">执行脚本，exit!=0 可阻断工具调用，阻断原因直接反馈给 Agent</p>
        </div>
        <div className="space-y-1">
          <p className="font-medium text-violet-600 dark:text-violet-400 flex items-center gap-1.5">
            <BrainCircuit className="size-3.5" /> 自然语言策略模式
          </p>
          <p className="text-xs pl-5">用自然语言写合规规则，行内 LLM 逐次判决是否放行，无需编写脚本</p>
        </div>
        <div className="pt-1 border-t border-border/50 space-y-1.5">
          <p><span className="font-medium text-blue-600 dark:text-blue-400">工具调用前</span>{" — 拦截并阻断，阻断原因反馈给 Agent 使其自适应调整"}</p>
          <p><span className="font-medium text-green-600 dark:text-green-400">工具调用后</span>{" — 输出追加到 Agent 上下文，外部系统状态参与 AI 推理"}</p>
          <p><span className="font-medium text-amber-600 dark:text-amber-400">Agent 停止时</span>{" — 清理或通知，fire-and-forget"}</p>
          <p><span className="font-medium text-purple-600 dark:text-purple-400">通知事件</span>{" — 自定义提醒或消息推送"}</p>
        </div>
      </div>
    </div>
  )
}
