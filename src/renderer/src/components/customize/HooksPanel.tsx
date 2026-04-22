import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Plus, Search, X, Pencil, Trash2, Webhook, Terminal, BrainCircuit } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { useAppStore } from "@/lib/store"
import type { HookConfig, HookEvent } from "@/types"
import {
  AddHookDialog,
  COMMAND_HOOK_EVENT_DOCS,
  COMMON_TOOLS,
  getCommandHookReadableContextDocs,
  getCommandHookToolInputDocs,
  getCommandHookToolInputSummary
} from "./AddHookDialog"

const EVENT_BADGE: Record<
  HookEvent,
  { label: string; className: string; english: string; tip: string }
> = {
  PreToolUse: {
    label: "调用前",
    className: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
    english: "PreToolUse",
    tip: "工具执行前触发，可拦截并阻止执行"
  },
  PostToolUse: {
    label: "调用后",
    className: "bg-green-500/15 text-green-600 dark:text-green-400",
    english: "PostToolUse",
    tip: "工具执行后触发，输出追加到 Agent 上下文"
  },
  UserPromptSubmit: {
    label: "提交",
    className: "bg-cyan-500/15 text-cyan-600 dark:text-cyan-400",
    english: "UserPromptSubmit",
    tip: "用户消息进入模型前触发，可阻断或重写"
  },
  SessionStart: {
    label: "会话始",
    className: "bg-teal-500/15 text-teal-600 dark:text-teal-400",
    english: "SessionStart",
    tip: "线程首次运行 Agent 时触发一次"
  },
  SessionEnd: {
    label: "会话终",
    className: "bg-rose-500/15 text-rose-600 dark:text-rose-400",
    english: "SessionEnd",
    tip: "线程删除或应用退出时触发"
  },
  Stop: {
    label: "停止",
    className: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
    english: "Stop",
    tip: "Agent 完成任务停止时触发，可请求返工"
  },
  Notification: {
    label: "通知",
    className: "bg-purple-500/15 text-purple-600 dark:text-purple-400",
    english: "Notification",
    tip: "Agent 等待审批时触发，用于自定义提醒"
  },
  SubagentStop: {
    label: "子停止",
    className: "bg-indigo-500/15 text-indigo-600 dark:text-indigo-400",
    english: "SubagentStop",
    tip: "子 Agent 完成任务时触发"
  }
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

  useEffect(() => {
    loadHooks()
  }, [loadHooks])

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
                    <TooltipProvider delayDuration={200}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span
                            className={cn(
                              "text-[10px] font-medium px-1.5 py-0.5 rounded-full shrink-0 cursor-default",
                              badge.className
                            )}
                          >
                            {badge.label}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent side="top">
                          <p className="font-mono text-xs font-semibold">{badge.english}</p>
                          <p className="text-xs text-muted-foreground">{badge.tip}</p>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                    {/* type icon */}
                    {isPrompt ? (
                      <BrainCircuit className="size-3 shrink-0 text-violet-500" />
                    ) : (
                      <Terminal className="size-3 shrink-0 text-muted-foreground" />
                    )}
                    <span
                      className={cn(
                        "text-sm truncate flex-1",
                        isPrompt ? "italic" : "font-mono",
                        !hook.enabled && "text-muted-foreground"
                      )}
                    >
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
  const commandHookDoc = COMMAND_HOOK_EVENT_DOCS[hook.event]
  const readableContextDocs = getCommandHookReadableContextDocs(hook.event)
  const toolInputDocs = getCommandHookToolInputDocs(hook.event, hook.matcher)
  const toolInputSummary = getCommandHookToolInputSummary(hook.event, hook.matcher)

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1 min-w-0">
          <div className="flex items-center gap-2">
            {isPrompt ? (
              <BrainCircuit className="size-4 text-violet-500 shrink-0" />
            ) : (
              <Terminal className="size-4 text-muted-foreground shrink-0" />
            )}
            <h3 className={cn("text-base font-bold truncate", isPrompt ? "italic" : "font-mono")}>
              {isPrompt
                ? (hook.prompt ?? "").slice(0, 60) + ((hook.prompt?.length ?? 0) > 60 ? "…" : "")
                : (hook.command ?? "")}
            </h3>
          </div>
          <div className="flex items-center gap-2">
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    className={cn(
                      "text-[10px] font-medium px-1.5 py-0.5 rounded-full cursor-default",
                      badge.className
                    )}
                  >
                    {badge.label}
                  </span>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  <p className="font-mono text-xs font-semibold">{badge.english}</p>
                  <p className="text-xs text-muted-foreground">{badge.tip}</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <span
              className={cn(
                "text-[10px] font-medium px-1.5 py-0.5 rounded-full",
                isPrompt
                  ? "bg-violet-500/15 text-violet-600 dark:text-violet-400"
                  : "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400"
              )}
            >
              {isPrompt ? "自然语言策略" : "Shell 命令"}
            </span>
            {hook.matcher &&
              (() => {
                const preset = COMMON_TOOLS.find(
                  (t) => t.value !== "custom" && t.value === hook.matcher
                )
                return (
                  <TooltipProvider delayDuration={200}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="text-xs text-muted-foreground font-mono cursor-default">
                          {preset ? preset.label : hook.matcher}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">
                        <p className="font-mono text-xs font-semibold">{hook.matcher}</p>
                        {preset && (
                          <p className="text-xs text-muted-foreground">{preset.description}</p>
                        )}
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                )
              })()}
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
        <DetailRow
          label="事件类型"
          value={`${badge.label}（${badge.english}）`}
          subtext={badge.tip}
        />
        {hook.matcher &&
          (() => {
            const preset = COMMON_TOOLS.find(
              (t) => t.value !== "custom" && t.value === hook.matcher
            )
            return (
              <DetailRow
                label="工具匹配"
                value={preset ? `${preset.label}（${hook.matcher}）` : hook.matcher}
                mono={!preset}
              />
            )
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
          <>
            <DetailRow label="命令" value={hook.command ?? ""} mono />
            <DetailRow
              label="输入协议"
              value="脚本通过 stdin JSON + 环境变量接收上下文；stdout 可返回纯文本或 JSON，stderr 用于调试日志。"
            />
            <div className="flex items-start gap-4">
              <span className="text-sm text-muted-foreground w-20 shrink-0">脚本输入</span>
              <div className="flex-1 space-y-2 rounded-md border border-border/50 bg-muted/30 px-3 py-2">
                <p className="text-sm text-foreground/90">{commandHookDoc.inputDescription}</p>
                <div className="flex flex-wrap gap-1.5">
                  {commandHookDoc.inputFields.map((field) => (
                    <span
                      key={field}
                      className="rounded-full border border-border/50 bg-background px-2 py-0.5 font-mono text-[10px] text-foreground/80"
                    >
                      {field}
                    </span>
                  ))}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {commandHookDoc.envFields.map((field) => (
                    <span
                      key={field}
                      className="rounded-full border border-dashed border-border/50 bg-background px-2 py-0.5 font-mono text-[10px] text-muted-foreground"
                    >
                      {field}
                    </span>
                  ))}
                </div>
                <div className="rounded-md border border-border/40 bg-background/80 px-3 py-2 space-y-3">
                  <div className="space-y-1">
                    <p className="text-sm font-medium text-foreground">可读取信息总览</p>
                    <p className="text-sm text-muted-foreground">
                      当前事件下，脚本可直接从 stdin JSON、环境变量和事件专属对象里读取这些信息。
                    </p>
                  </div>
                  <div className="space-y-2">
                    <p className="text-xs font-medium text-foreground/90">stdin 顶层字段</p>
                    <div className="space-y-2">
                      {readableContextDocs.stdinFields.map((field) => (
                        <div
                          key={field.key}
                          className="rounded-md border border-border/40 bg-muted/20 px-3 py-2 space-y-1"
                        >
                          <span className="inline-flex rounded-full border border-border/50 bg-background px-2 py-0.5 font-mono text-[10px] text-foreground/80">
                            {field.key}
                          </span>
                          <p className="text-sm text-muted-foreground">{field.description}</p>
                          {field.note && <p className="text-xs text-foreground/80">{field.note}</p>}
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="space-y-2">
                    <p className="text-xs font-medium text-foreground/90">环境变量</p>
                    <div className="space-y-2">
                      {readableContextDocs.envFields.map((field) => (
                        <div
                          key={field.key}
                          className="rounded-md border border-border/40 bg-muted/20 px-3 py-2 space-y-1"
                        >
                          <span className="inline-flex rounded-full border border-dashed border-border/50 bg-background px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
                            {field.key}
                          </span>
                          <p className="text-sm text-muted-foreground">{field.description}</p>
                          {field.note && <p className="text-xs text-foreground/80">{field.note}</p>}
                        </div>
                      ))}
                    </div>
                  </div>
                  {readableContextDocs.extraObjects.length > 0 && (
                    <div className="space-y-2">
                      <p className="text-xs font-medium text-foreground/90">事件专属对象</p>
                      <div className="space-y-2">
                        {readableContextDocs.extraObjects.map((doc) => (
                          <div
                            key={doc.key}
                            className="rounded-md border border-border/40 bg-muted/20 px-3 py-2 space-y-1.5"
                          >
                            <span className="inline-flex rounded-full border border-border/50 bg-background px-2 py-0.5 font-mono text-[10px] text-foreground/80">
                              {doc.key}
                            </span>
                            {doc.fields && doc.fields.length > 0 && (
                              <div className="flex flex-wrap gap-1.5">
                                {doc.fields.map((field) => (
                                  <span
                                    key={`${doc.key}-${field}`}
                                    className="rounded-full border border-dashed border-border/50 bg-background px-2 py-0.5 font-mono text-[10px] text-muted-foreground"
                                  >
                                    {field}
                                  </span>
                                ))}
                              </div>
                            )}
                            <p className="text-sm text-muted-foreground">{doc.description}</p>
                            {doc.note && <p className="text-xs text-foreground/80">{doc.note}</p>}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
            {toolInputDocs.length > 0 && (
              <div className="flex items-start gap-4">
                <span className="text-sm text-muted-foreground w-20 shrink-0">tool_input</span>
                <div className="flex-1 space-y-2 rounded-md border border-border/50 bg-muted/30 px-3 py-2">
                  <p className="text-sm text-foreground/90">{toolInputSummary}</p>
                  {toolInputDocs.map((doc) => (
                    <div
                      key={doc.key}
                      className="rounded-md border border-border/40 bg-background/80 px-3 py-2 space-y-1.5"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="rounded-full border border-border/50 bg-background px-2 py-0.5 font-mono text-[10px] text-foreground/80">
                          {doc.label}
                        </span>
                        {doc.fileHint && (
                          <span className="rounded-full border border-emerald-300/50 bg-emerald-50 px-2 py-0.5 text-[10px] text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300">
                            可直接拿文件路径：`filePath`
                          </span>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {doc.fields.map((field) => (
                          <span
                            key={field}
                            className="rounded-full border border-dashed border-border/50 bg-background px-2 py-0.5 font-mono text-[10px] text-muted-foreground"
                          >
                            {field}
                          </span>
                        ))}
                      </div>
                      <p className="text-sm text-muted-foreground">{doc.description}</p>
                      {doc.fileHint && (
                        <p className="text-xs text-emerald-700 dark:text-emerald-300">
                          {doc.fileHint}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
            <DetailRow
              label="日志查看"
              value="运行后回到聊天区，展开“Hook 执行记录”；调试日志建议输出到 stderr，如果 stdout 输出 JSON，会被当成 Hook 返回值解析。想确认某个事件的原始 payload，也可以先把 payload 整体打印到 stderr。"
            />
          </>
        )}

        {hook.onBlock && (
          <>
            <div className="pt-2 border-t border-border/50">
              <h4 className="text-sm font-medium">阻断后补充配置</h4>
            </div>
            {hook.onBlock.reason && <DetailRow label="回退原因" value={hook.onBlock.reason} />}
            {hook.onBlock.systemMessage && (
              <DetailRow label="用户提示" value={hook.onBlock.systemMessage} />
            )}
            {hook.onBlock.requiredSkill && (
              <DetailRow label="整改技能" value={hook.onBlock.requiredSkill} mono />
            )}
            {hook.onBlock.additionalContext && (
              <div className="flex items-start gap-4">
                <span className="text-sm text-muted-foreground w-20 shrink-0">额外上下文</span>
                <div className="flex-1 max-h-64 overflow-auto rounded-md bg-muted/50 px-3 py-2 text-sm whitespace-pre-wrap break-all border border-border/50">
                  {hook.onBlock.additionalContext}
                </div>
              </div>
            )}
          </>
        )}

        <DetailRow label="超时" value={`${hook.timeout ?? 10000}ms`} />
        <DetailRow label="创建时间" value={formatTime(hook.createdAt)} />
        <DetailRow label="更新时间" value={formatTime(hook.updatedAt)} />
      </div>
    </div>
  )
}

function DetailRow(props: {
  label: string
  value: string
  mono?: boolean
  subtext?: string
}): React.JSX.Element {
  return (
    <div className="flex items-start gap-4">
      <span className="text-sm text-muted-foreground w-20 shrink-0">{props.label}</span>
      <div>
        <span className={cn("text-sm break-all", props.mono && "font-mono")}>{props.value}</span>
        {props.subtext && <p className="text-xs text-muted-foreground mt-0.5">{props.subtext}</p>}
      </div>
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

/* ── Empty state ─────────────────────────────────────────────────── */

function EmptyState(): React.JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center h-full text-center px-8 py-12">
      <Webhook className="size-12 text-muted-foreground/40 mb-4" />
      <h3 className="text-base font-bold mb-2">钩子</h3>
      <p className="text-sm text-muted-foreground max-w-md mb-6">
        钩子允许你在 Agent 生命周期的关键节点执行 Shell 命令，或通过自然语言描述让行内 LLM
        实时判决工具调用是否合规。
      </p>
      <div className="text-left text-sm text-muted-foreground space-y-3 max-w-md">
        <div className="space-y-1">
          <p className="font-medium text-foreground flex items-center gap-1.5">
            <Terminal className="size-3.5" /> Shell 命令模式
          </p>
          <p className="text-xs pl-5">
            脚本通过 stdin JSON 和环境变量接收上下文；stdout 可返回纯文本或 JSON，stderr
            用于调试日志。
          </p>
          <p className="text-xs pl-5">
            右侧详情会按事件列出 stdin 顶层字段、环境变量和事件专属对象；例如 `write_file` /
            `edit_file` 时可从 `tool_input.filePath` 读取路径。
          </p>
        </div>
        <div className="space-y-1">
          <p className="font-medium text-violet-600 dark:text-violet-400 flex items-center gap-1.5">
            <BrainCircuit className="size-3.5" /> 自然语言策略模式
          </p>
          <p className="text-xs pl-5">
            用自然语言写合规规则，行内 LLM 逐次判决是否放行，无需编写脚本
          </p>
        </div>
        <div className="pt-1 border-t border-border/50 space-y-1.5">
          <p>
            <span className="font-medium text-blue-600 dark:text-blue-400">调用前</span>{" "}
            <span className="font-mono text-muted-foreground">PreToolUse</span>
            {" — 拦截并阻断，阻断原因反馈给 Agent 使其自适应调整"}
          </p>
          <p>
            <span className="font-medium text-green-600 dark:text-green-400">调用后</span>{" "}
            <span className="font-mono text-muted-foreground">PostToolUse</span>
            {" — 输出追加到 Agent 上下文，外部系统状态参与 AI 推理"}
          </p>
          <p>
            <span className="font-medium text-amber-600 dark:text-amber-400">停止</span>{" "}
            <span className="font-mono text-muted-foreground">Stop</span>
            {" — 任务完成后复查，可请求 Agent 返工"}
          </p>
          <p>
            <span className="font-medium text-cyan-600 dark:text-cyan-400">提交</span>{" "}
            <span className="font-mono text-muted-foreground">UserPromptSubmit</span>
            {" — 用户消息进入模型前，可阻断或重写"}
          </p>
          <p>
            <span className="font-medium text-purple-600 dark:text-purple-400">通知</span>{" "}
            <span className="font-mono text-muted-foreground">Notification</span>
            {" — 自定义提醒或消息推送"}
          </p>
        </div>
        <div className="pt-1 border-t border-border/50 space-y-1">
          <p className="text-xs">
            右侧详情现在会同步展示当前事件的 stdin 顶层字段、环境变量，以及像
            `tool_response`、`stop_context`、`subagent` 这类事件专属对象。
          </p>
          <p className="text-xs">
            如果你想确认某次运行的原始输入，也可以临时把整份 `payload` 打到
            `stderr`，然后去聊天区“Hook 执行记录”里看。
          </p>
        </div>
      </div>
    </div>
  )
}
