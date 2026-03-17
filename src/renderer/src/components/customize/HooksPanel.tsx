import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Plus, Search, X, Pencil, Trash2, Webhook } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import type { HookConfig, HookEvent } from "@/types"
import { AddHookDialog } from "./AddHookDialog"

const EVENT_BADGE: Record<HookEvent, { label: string; className: string }> = {
  PreToolUse: { label: "Pre", className: "bg-blue-500/15 text-blue-600 dark:text-blue-400" },
  PostToolUse: { label: "Post", className: "bg-green-500/15 text-green-600 dark:text-green-400" },
  Stop: { label: "Stop", className: "bg-amber-500/15 text-amber-600 dark:text-amber-400" },
  Notification: { label: "Notify", className: "bg-purple-500/15 text-purple-600 dark:text-purple-400" }
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

  useEffect(() => {
    loadHooks()
  }, [loadHooks])

  const filteredHooks = useMemo(() => {
    const q = debouncedQuery.trim().toLowerCase()
    if (!q) return hooks
    return hooks.filter(
      (h) =>
        h.command.toLowerCase().includes(q) ||
        h.event.toLowerCase().includes(q) ||
        (h.matcher && h.matcher.toLowerCase().includes(q))
    )
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

  const handleAddSuccess = useCallback(() => {
    loadHooks()
  }, [loadHooks])

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
                    onClick={() => {
                      setSearchQuery("")
                      setDebouncedQuery("")
                    }}
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
                onClick={() => {
                  setEditHook(null)
                  setDialogOpen(true)
                }}
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
                return (
                  <button
                    key={hook.id}
                    className={cn(
                      "w-full flex items-center gap-2 px-2 py-1.5 rounded-md border border-border/70 text-left transition-colors",
                      selectedHook?.id === hook.id ? "bg-muted/70" : "hover:bg-muted/50"
                    )}
                    onClick={() => setSelectedHook(hook)}
                  >
                    <span
                      className={cn(
                        "text-[10px] font-medium px-1.5 py-0.5 rounded-full shrink-0",
                        badge.className
                      )}
                    >
                      {badge.label}
                    </span>
                    <span
                      className={cn(
                        "text-sm truncate flex-1 font-mono",
                        !hook.enabled && "text-muted-foreground"
                      )}
                    >
                      {hook.command}
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
            onEdit={(h) => {
              setEditHook(h)
              setDialogOpen(true)
            }}
          />
        ) : (
          <EmptyState />
        )}
      </div>

      <AddHookDialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open)
          if (!open) setEditHook(null)
        }}
        onSuccess={handleAddSuccess}
        editHook={editHook}
      />
    </>
  )
}

/* ── Hook detail view ────────────────────────────────────────── */

function HookDetail(props: {
  hook: HookConfig
  onToggleEnabled: (id: string, enabled: boolean) => void
  onDelete: (hook: HookConfig) => void
  onEdit: (hook: HookConfig) => void
}): React.JSX.Element {
  const { hook, onToggleEnabled, onDelete, onEdit } = props
  const badge = EVENT_BADGE[hook.event]

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1 min-w-0">
          <h3 className="text-base font-bold font-mono truncate">{hook.command}</h3>
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "text-[10px] font-medium px-1.5 py-0.5 rounded-full",
                badge.className
              )}
            >
              {hook.event}
            </span>
            {hook.matcher && (
              <span className="text-xs text-muted-foreground font-mono">
                matcher: {hook.matcher}
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            onClick={() => onEdit(hook)}
            title="编辑"
          >
            <Pencil className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0 text-destructive hover:text-destructive"
            onClick={() => onDelete(hook)}
            title="删除"
          >
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
        <DetailRow label="事件类型" value={hook.event} />
        {hook.matcher && <DetailRow label="工具匹配" value={hook.matcher} mono />}
        <DetailRow label="命令" value={hook.command} mono />
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
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}

/* ── Empty state ─────────────────────────────────────────────── */

function EmptyState(): React.JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center h-full text-center px-8 py-12">
      <Webhook className="size-12 text-muted-foreground/40 mb-4" />
      <h3 className="text-base font-bold mb-2">钩子</h3>
      <p className="text-sm text-muted-foreground max-w-md mb-6">
        钩子允许你在 Agent 生命周期的关键节点自动执行 Shell 命令，实现自定义工作流。
      </p>
      <div className="text-left text-sm text-muted-foreground space-y-2 max-w-md">
        <p>
          <span className="font-medium text-blue-600 dark:text-blue-400">PreToolUse</span>
          {" — 工具调用前触发，exit!=0 可阻止执行"}
        </p>
        <p>
          <span className="font-medium text-green-600 dark:text-green-400">PostToolUse</span>
          {" — 工具调用后触发，可用于日志或后处理"}
        </p>
        <p>
          <span className="font-medium text-amber-600 dark:text-amber-400">Stop</span>
          {" — Agent 停止时触发，可用于清理或通知"}
        </p>
        <p>
          <span className="font-medium text-purple-600 dark:text-purple-400">Notification</span>
          {" — 通知事件触发，可用于自定义提醒"}
        </p>
      </div>
    </div>
  )
}
