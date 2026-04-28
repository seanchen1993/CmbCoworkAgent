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
  COMMON_TOOLS,
  getCommandHookEventDoc,
  getCommandHookReadableContextDocs,
  getCommandHookToolInputDocs,
  getCommandHookToolInputSummary
} from "./AddHookDialog"

type PluginHookMetadata = Awaited<ReturnType<typeof window.api.plugins.listHooks>>[number]
type SkillHookMetadata = Awaited<ReturnType<typeof window.api.hooks.skills.list>>[number]
type GlobalDisplayHook = HookConfig & { source: "global" }
type PluginDisplayHook = PluginHookMetadata & { source: "plugin" }
type SkillDisplayHook = SkillHookMetadata & { source: "skill" }
type DisplayHook = GlobalDisplayHook | PluginDisplayHook | SkillDisplayHook

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
  PreSkillUse: {
    label: "技能前",
    className: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
    english: "PreSkillUse",
    tip: "Agent 首次读取某个技能前触发，可按技能名拦截"
  },
  PostSkillUse: {
    label: "技能后",
    className: "bg-green-500/15 text-green-600 dark:text-green-400",
    english: "PostSkillUse",
    tip: "Agent 首次读取某个技能后触发，可记录或注入补充上下文"
  },
  PostToolUseFailure: {
    label: "调用失败",
    className: "bg-red-500/15 text-red-600 dark:text-red-400",
    english: "PostToolUseFailure",
    tip: "工具执行失败后触发"
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
  StopFailure: {
    label: "停止失败",
    className: "bg-orange-500/15 text-orange-600 dark:text-orange-400",
    english: "StopFailure",
    tip: "Stop 钩子执行失败时触发"
  },
  Notification: {
    label: "通知",
    className: "bg-purple-500/15 text-purple-600 dark:text-purple-400",
    english: "Notification",
    tip: "Agent 等待审批时触发，用于自定义提醒"
  },
  SubagentStart: {
    label: "子开始",
    className: "bg-violet-500/15 text-violet-600 dark:text-violet-400",
    english: "SubagentStart",
    tip: "子 Agent 启动时触发"
  },
  SubagentStop: {
    label: "子停止",
    className: "bg-indigo-500/15 text-indigo-600 dark:text-indigo-400",
    english: "SubagentStop",
    tip: "子 Agent 完成任务时触发"
  },
  PreCompact: {
    label: "压缩前",
    className: "bg-slate-500/15 text-slate-600 dark:text-slate-400",
    english: "PreCompact",
    tip: "上下文压缩前触发"
  },
  PostCompact: {
    label: "压缩后",
    className: "bg-slate-500/15 text-slate-600 dark:text-slate-400",
    english: "PostCompact",
    tip: "上下文压缩后触发"
  },
  PermissionRequest: {
    label: "权限申请",
    className: "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400",
    english: "PermissionRequest",
    tip: "Agent 申请执行权限时触发"
  },
  PermissionDenied: {
    label: "权限拒绝",
    className: "bg-red-500/15 text-red-600 dark:text-red-400",
    english: "PermissionDenied",
    tip: "权限申请被拒绝时触发"
  },
  Setup: {
    label: "初始化",
    className: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
    english: "Setup",
    tip: "Agent 运行时初始化阶段触发"
  },
  CwdChanged: {
    label: "目录变更",
    className: "bg-lime-500/15 text-lime-600 dark:text-lime-400",
    english: "CwdChanged",
    tip: "工作目录变更时触发"
  },
  FileChanged: {
    label: "文件变更",
    className: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
    english: "FileChanged",
    tip: "工作区文件变更时触发"
  }
}

const GUIDE_EVENT_ORDER: HookEvent[] = [
  "PreToolUse",
  "PostToolUse",
  "PreSkillUse",
  "PostSkillUse",
  "UserPromptSubmit",
  "SessionStart",
  "SessionEnd",
  "Stop",
  "Notification",
  "SubagentStop"
]

const COMMON_COMMAND_RESULT_FIELDS: Array<{ key: string; description: string }> = [
  {
    key: "decision=block",
    description: "阻断当前工具或当前收尾检查，并把 reason / additionalContext 带回 Agent。"
  },
  {
    key: "reason",
    description: "阻断原因；会显示给 Agent，用于指导下一步整改。"
  },
  {
    key: "systemMessage",
    description: "直接展示给用户的可见提示，适合写审批说明或风险提醒。"
  },
  {
    key: "additionalContext",
    description: "隐藏追加到上下文里的整改建议，适合塞更详细的修复要求。"
  },
  {
    key: "updatedInput",
    description: "只在前置事件里有意义，可用来改写工具参数或用户输入。"
  },
  {
    key: "requiredSkill",
    description: "阻断时指定整改技能，让 Agent 明确下一步应调用哪个技能。"
  }
]

const ON_BLOCK_FIELDS: Array<{ key: string; description: string }> = [
  { key: "reason", description: "Hook 阻断但没返回 reason 时，使用这里的默认回退原因。" },
  { key: "systemMessage", description: "阻断后展示给用户的提示，适合写整改入口或说明。" },
  {
    key: "additionalContext",
    description: "阻断后额外塞给 Agent 的隐藏上下文，适合补充详细整改要求。"
  },
  {
    key: "requiredSkill",
    description: "阻断后挂载整改技能，适合把“先调用哪个技能”固化到配置里。"
  }
]

const SKILL_HOOK_FLAT_EXAMPLE = `[
  {
    "event": "PreToolUse",
    "matcher": "write_file|edit_file",
    "type": "command",
    "command": "python hooks/pre-write-check.py",
    "timeout": 10000,
    "onBlock": {
      "reason": "高风险写入，请先按整改流程处理",
      "requiredSkill": "my-skill-name"
    }
  },
  {
    "event": "Stop",
    "type": "command",
    "command": "python hooks/post-check.py"
  }
]`

const SKILL_HOOK_CC_EXAMPLE = `{
  "PreToolUse": [
    {
      "matcher": "write_file|edit_file",
      "hooks": [
        {
          "type": "command",
          "command": "python hooks/pre-write-check.py",
          "timeout": 10
        }
      ]
    }
  ]
}`

const PLUGIN_HOOK_FLAT_EXAMPLE = `[
  {
    "event": "PreToolUse",
    "matcher": "write_file",
    "type": "command",
    "command": "python hooks/pre-write.py",
    "timeout": 10000
  }
]`

const WORKSPACE_HOOK_FLAT_EXAMPLE = `{
  "event": "PreToolUse",
  "matcher": "write_file|edit_file",
  "type": "command",
  "command": "python .cmbdevclaw/hooks/pre-write-check.py",
  "timeout": 10000,
  "onBlock": {
    "reason": "检测到高风险写入，请先按整改流程处理",
    "requiredSkill": "workspace-hook-remediation"
  }
}`

const WORKSPACE_HOOK_CC_EXAMPLE = `{
  "PreToolUse": [
    {
      "matcher": "write_file|edit_file",
      "hooks": [
        {
          "type": "command",
          "command": "python .cmbdevclaw/hooks/pre-write-check.py",
          "timeout": 10,
          "onBlock": {
            "systemMessage": "请先按整改技能修复，再重试",
            "requiredSkill": "workspace-hook-remediation"
          }
        }
      ]
    }
  ]
}`

/** Human-readable summary shown in the list item */
function hookSummary(hook: DisplayHook): string {
  if (hook.type === "prompt") return hook.prompt ?? ""
  return hook.command ?? ""
}

const HOOK_SOURCE_BADGE_CLASS: Record<DisplayHook["source"], string> = {
  global: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
  plugin: "bg-violet-500/15 text-violet-600 dark:text-violet-400",
  skill: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
}

function getHookSourceLabel(source: DisplayHook["source"]): string {
  if (source === "plugin") return "插件"
  if (source === "skill") return "技能"
  return "全局"
}

function getHookSourceDetailLabel(source: DisplayHook["source"]): string {
  return `${getHookSourceLabel(source)} Hook`
}

export function HooksPanel(): React.JSX.Element {
  const pluginVersion = useAppStore((s) => s.pluginVersion)
  const bumpPluginVersion = useAppStore((s) => s.bumpPluginVersion)
  const [hooks, setHooks] = useState<DisplayHook[]>([])
  const [selectedHook, setSelectedHook] = useState<DisplayHook | null>(null)
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
      const [globalHooks, skillHooks, plugins] = await Promise.all([
        window.api.hooks.list(),
        window.api.hooks.skills.list(),
        window.api.plugins.list()
      ])
      const pluginHookGroups = await Promise.all(
        plugins
          .filter((plugin) => (plugin.hookCount ?? 0) > 0)
          .map(async (plugin) => {
            try {
              const detail = await window.api.plugins.getDetail(plugin.id)
              return detail.hooks.map(
                (hook): PluginDisplayHook => ({
                  ...hook,
                  source: "plugin"
                })
              )
            } catch (error) {
              console.error(`[HooksPanel] Failed to load hooks for plugin ${plugin.name}:`, error)
              return []
            }
          })
      )
      const list: DisplayHook[] = [
        ...globalHooks.map(
          (hook): GlobalDisplayHook => ({
            ...hook,
            source: "global"
          })
        ),
        ...skillHooks.map(
          (hook): SkillDisplayHook => ({
            ...hook,
            source: "skill"
          })
        ),
        ...pluginHookGroups.flat()
      ]
      setHooks(list)
      setSelectedHook((prev) => {
        if (!prev) return null
        return list.find((h) => h.id === prev.id && h.source === prev.source) ?? null
      })
    } catch (e) {
      console.error(e)
    }
  }, [])

  useEffect(() => {
    void loadHooks()
  }, [loadHooks, pluginVersion])

  const filteredHooks = useMemo(() => {
    const q = debouncedQuery.trim().toLowerCase()
    if (!q) return hooks
    return hooks.filter((h) => {
      const summary = hookSummary(h).toLowerCase()
      return (
        summary.includes(q) ||
        h.event.toLowerCase().includes(q) ||
        (h.matcher && h.matcher.toLowerCase().includes(q)) ||
        (h.source === "plugin" && h.pluginName.toLowerCase().includes(q)) ||
        (h.source === "skill" && h.skillName.toLowerCase().includes(q)) ||
        getHookSourceLabel(h.source).includes(q) ||
        (h.type === "prompt" ? "自然语言策略" : "命令").includes(q)
      )
    })
  }, [hooks, debouncedQuery])

  const handleToggleEnabled = useCallback(
    async (hook: DisplayHook, enabled: boolean) => {
      try {
        if (hook.source === "plugin") {
          const result = await window.api.plugins.setHookEnabled(hook.pluginId, hook.id, enabled)
          if (!result.success) {
            throw new Error(result.error || "插件 Hook 切换失败")
          }
          bumpPluginVersion()
        } else if (hook.source === "global") {
          await window.api.hooks.setEnabled(hook.id, enabled)
        } else {
          return
        }
        await loadHooks()
      } catch (error) {
        console.error("[HooksPanel] Failed to toggle hook:", error)
      }
    },
    [bumpPluginVersion, loadHooks]
  )

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
                const isPluginHook = hook.source === "plugin"
                const isSkillHook = hook.source === "skill"
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
                        "text-[10px] font-medium px-1.5 py-0.5 rounded-full shrink-0",
                        HOOK_SOURCE_BADGE_CLASS[hook.source]
                      )}
                    >
                      {getHookSourceLabel(hook.source)}
                    </span>
                    {isPluginHook && (
                      <span className="text-[10px] text-muted-foreground shrink-0 truncate max-w-[88px]">
                        {hook.pluginName}
                      </span>
                    )}
                    {isSkillHook && (
                      <span className="text-[10px] text-muted-foreground shrink-0 truncate max-w-[88px]">
                        {hook.skillName}
                      </span>
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
                    <div className="flex items-center gap-1 shrink-0">
                      {isPluginHook && !hook.pluginEnabled && (
                        <span className="text-[10px] text-amber-600 dark:text-amber-400">
                          插件停用
                        </span>
                      )}
                      {!hook.enabled && (
                        <span className="text-[10px] text-muted-foreground">已禁用</span>
                      )}
                    </div>
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
            onShowGuide={() => setSelectedHook(null)}
            onEdit={(h) => {
              setEditHook(h)
              setDialogOpen(true)
            }}
          />
        ) : (
          <HooksGuide />
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
  hook: DisplayHook
  onToggleEnabled: (hook: DisplayHook, enabled: boolean) => void
  onDelete: (hook: HookConfig) => void
  onShowGuide: () => void
  onEdit: (hook: HookConfig) => void
}): React.JSX.Element {
  const { hook, onToggleEnabled, onDelete, onShowGuide, onEdit } = props
  const badge = EVENT_BADGE[hook.event]
  const isPrompt = hook.type === "prompt"
  const isGlobalHook = hook.source === "global"
  const isPluginHook = hook.source === "plugin"
  const isSkillHook = hook.source === "skill"
  const { models } = useAppStore()
  const modelName = hook.modelId
    ? (models.find((m) => m.id === hook.modelId)?.name ?? hook.modelId)
    : null
  const commandHookDoc = getCommandHookEventDoc(hook.event)
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
            <span
              className={cn(
                "text-[10px] font-medium px-1.5 py-0.5 rounded-full",
                HOOK_SOURCE_BADGE_CLASS[hook.source]
              )}
            >
              {getHookSourceDetailLabel(hook.source)}
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
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={onShowGuide}>
            配置说明
          </Button>
          {isGlobalHook && (
            <>
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
            </>
          )}
          {!isSkillHook && (
            <Button
              variant={hook.enabled ? "default" : "outline"}
              size="sm"
              className="h-7 text-xs ml-1"
              onClick={() => onToggleEnabled(hook, !hook.enabled)}
            >
              {hook.enabled ? "已启用" : "已禁用"}
            </Button>
          )}
        </div>
      </div>

      {/* Details */}
      <div className="space-y-4">
        <DetailRow label="来源" value={getHookSourceDetailLabel(hook.source)} />
        {isGlobalHook && <DetailRow label="管理方式" value="这里可以直接启停、编辑和删除。" />}
        {isPluginHook && (
          <DetailRow
            label="所属插件"
            value={hook.pluginName}
            subtext={hook.pluginEnabled ? "插件当前已启用" : "插件当前已禁用，此 Hook 不会执行"}
          />
        )}
        {isPluginHook && <DetailRow label="配置文件" value={hook.hookPath} mono />}
        {isPluginHook && (
          <DetailRow
            label="管理方式"
            value="这里可以切换启停；如需修改脚本或策略内容，请到插件详情页或插件目录中调整。"
          />
        )}
        {isSkillHook && (
          <DetailRow
            label="所属技能"
            value={hook.skillName}
            subtext="该 Hook 跟随技能一起加载；停用技能后会一起移除。"
          />
        )}
        {isSkillHook && <DetailRow label="配置文件" value={hook.hookPath} mono />}
        {isSkillHook && <DetailRow label="技能目录" value={hook.skillPath} mono />}
        {isSkillHook && (
          <DetailRow
            label="管理方式"
            value="这里用于查看；如需停用，请到技能管理页停用技能；如需修改脚本或策略内容，请到技能目录中调整 hooks.json。"
          />
        )}
        <DetailRow label="状态" value={hook.enabled ? "已启用" : "已禁用"} />
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

function GuideSection(props: {
  title: string
  summary: string
  children: React.ReactNode
}): React.JSX.Element {
  const { title, summary, children } = props
  return (
    <details className="rounded-lg border border-border/60 bg-background">
      <summary className="cursor-pointer list-none p-4 [&::-webkit-details-marker]:hidden">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <h4 className="text-sm font-semibold text-foreground">{title}</h4>
            <p className="text-sm text-muted-foreground">{summary}</p>
          </div>
          <span className="shrink-0 rounded-full border border-border/50 bg-muted/30 px-2 py-0.5 text-[10px] text-muted-foreground">
            点击展开
          </span>
        </div>
      </summary>
      <div className="border-t border-border/50 p-4">{children}</div>
    </details>
  )
}

function GuideSubSection(props: {
  title: string
  summary: string
  children: React.ReactNode
}): React.JSX.Element {
  const { title, summary, children } = props
  return (
    <details className="rounded-md border border-border/40 bg-muted/20">
      <summary className="cursor-pointer list-none px-3 py-2.5 [&::-webkit-details-marker]:hidden">
        <div className="space-y-1">
          <p className="text-sm font-medium text-foreground">{title}</p>
          <p className="text-sm text-muted-foreground">{summary}</p>
        </div>
      </summary>
      <div className="border-t border-border/40 px-3 py-3">{children}</div>
    </details>
  )
}

function HooksGuide(): React.JSX.Element {
  const [event, setEvent] = useState<HookEvent>("PreToolUse")
  const [exampleKind, setExampleKind] = useState<"python" | "shell">("python")
  const badge = EVENT_BADGE[event]
  const commandHookDoc = getCommandHookEventDoc(event)
  const readableContextDocs = getCommandHookReadableContextDocs(event)
  const toolInputDocs = getCommandHookToolInputDocs(event)
  const toolInputSummary = getCommandHookToolInputSummary(event)
  const selectedExample =
    exampleKind === "python" ? commandHookDoc.pythonExample : commandHookDoc.shellExample

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center gap-3">
        <div className="rounded-2xl bg-muted p-3">
          <Webhook className="size-6 text-muted-foreground" />
        </div>
        <div className="space-y-1">
          <h3 className="text-lg font-bold">Hook 配置说明</h3>
          <p className="text-sm text-muted-foreground">
            Hook 在 Agent
            执行的关键节点触发，可以拦截工具调用、校验输出、注入上下文，或推送通知。支持 Shell
            脚本和自然语言策略两种形式，来源分为全局、插件、技能和工作区四类。
          </p>
        </div>
      </div>

      <GuideSection
        title="概览：类型、来源与 onBlock"
        summary="Shell 命令 Hook、自然语言策略、全局 / 插件 / 工作区三种来源，以及阻断后附加配置都在这里。"
      >
        <div className="space-y-3">
          <GuideSubSection
            title="Shell 命令 Hook"
            summary="脚本收 stdin JSON，stdout 可返回文本或 JSON，stderr 专门用来打调试日志。"
          >
            <div className="space-y-2 text-sm text-muted-foreground">
              <p>脚本通过 stdin JSON 接收完整输入，环境变量只是便捷补充。</p>
              <p>
                stdout 可以输出普通文本，也可以输出最终 JSON；stderr
                只用于日志，不会参与返回值解析。
              </p>
              <p>适合做审批拦截、写后校验、调用外部系统、通知推送，以及把整改建议回灌给 Agent。</p>
            </div>
          </GuideSubSection>

          <GuideSubSection
            title="自然语言策略 Hook"
            summary="用自然语言写规则，让行内模型在事件发生时实时判决是否放行。"
          >
            <div className="space-y-2 text-sm text-muted-foreground">
              <p>适合不想写脚本、但仍想做风险控制或策略收口的场景。</p>
              <p>
                判决为阻断时，也可以配合
                <code className="mx-1 font-mono text-foreground/85">onBlock.requiredSkill</code>让
                Agent 直接知道应该调用哪个整改技能。
              </p>
            </div>
          </GuideSubSection>

          <GuideSubSection
            title="来源与管理方式"
            summary="全局、插件、技能、工作区四类 Hook 的落点和维护方式不同。"
          >
            <div className="space-y-2 text-sm text-muted-foreground">
              <p>全局 Hook 由你在当前应用里创建、编辑、删除。</p>
              <p>
                插件 Hook 来自插件目录下的
                hooks/hooks.json，随插件启停，这里可以统一控制，但不直接编辑脚本内容。
              </p>
              <p>
                技能 Hook 来自技能目录下的
                hooks.json，随技能一起加载，启停技能时同步生效。适合把某项技能的配套拦截或校验逻辑打包进技能本体一起分发。
              </p>
              <p>
                工作区 Hook 适合跟项目一起分发；脚本或策略本体建议放在项目目录里跟代码一起维护。
              </p>
            </div>
          </GuideSubSection>

          <GuideSubSection
            title="阻断后附加配置 onBlock"
            summary="Hook 阻断后，可以用 onBlock 补充默认原因、用户提示、整改上下文和整改技能。"
          >
            <div className="space-y-2">
              {ON_BLOCK_FIELDS.map((field) => (
                <div
                  key={field.key}
                  className="rounded-md border border-border/40 bg-background px-3 py-2"
                >
                  <p className="font-mono text-[11px] text-foreground/85">{field.key}</p>
                  <p className="text-sm text-muted-foreground">{field.description}</p>
                </div>
              ))}
            </div>
          </GuideSubSection>
        </div>
      </GuideSection>

      <GuideSection
        title="技能 Hook 怎么配"
        summary="把 hooks.json 放到技能目录里，随技能一起加载，适合把拦截逻辑打包进技能本体分发。"
      >
        <div className="space-y-3">
          <GuideSubSection
            title="加载规则"
            summary="技能目录下放 hooks.json，启用技能时自动加载，停用时同步移除。"
          >
            <div className="space-y-2 text-sm text-muted-foreground">
              <p>
                在技能目录里新建
                <code className="mx-1 font-mono text-foreground/85">hooks.json</code>
                即可，无需其他配置。
              </p>
              <pre className="rounded-md border border-border/40 bg-background p-2 text-xs leading-5">
                {`~/.cmbcoworkagent/skills/<skill-name>/\n  SKILL.md\n  hooks.json          ← 新增此文件\n  hooks/              ← 脚本本体建议放这里\n    pre-write-check.py`}
              </pre>
              <p>
                脚本路径相对于技能目录本身，例如
                <code className="mx-1 font-mono text-foreground/85">python hooks/check.py</code>。
              </p>
              <p>
                hooks.json 里写
                <code className="mx-1 font-mono text-foreground/85">{`"enabled": false`}</code>
                可关闭单条规则；在应用里停用技能则整批移除。
              </p>
            </div>
          </GuideSubSection>

          <GuideSubSection
            title="支持格式"
            summary="扁平数组（推荐）、Claude Code hooks settings 格式、带 hooks 包裹层三种都支持。"
          >
            <div className="space-y-2 text-sm text-muted-foreground">
              <p>推荐用扁平数组格式（顶层是数组），可以在一个文件里放多条规则，结构最直观。</p>
              <p>
                也支持 Claude Code 风格的
                <code className="mx-1 font-mono text-foreground/85">{`{ EventName: [...] }`}</code>
                ，以及带
                <code className="mx-1 font-mono text-foreground/85">hooks</code>
                包裹层的
                <code className="mx-1 font-mono text-foreground/85">{`{ hooks: { ... } }`}</code>
                形式。
              </p>
            </div>
          </GuideSubSection>

          <GuideSubSection
            title="最小示例：扁平数组（推荐）"
            summary="一个文件放多条规则；command 里用相对路径调脚本。"
          >
            <pre className="overflow-x-auto rounded-md border border-border/40 bg-background p-3 text-xs leading-5 text-foreground">
              <code>{SKILL_HOOK_FLAT_EXAMPLE}</code>
            </pre>
          </GuideSubSection>

          <GuideSubSection
            title="最小示例：Claude Code 多 Hook 格式"
            summary="timeout 单位是秒，运行时自动转成毫秒。"
          >
            <pre className="overflow-x-auto rounded-md border border-border/40 bg-background p-3 text-xs leading-5 text-foreground">
              <code>{SKILL_HOOK_CC_EXAMPLE}</code>
            </pre>
          </GuideSubSection>
        </div>
      </GuideSection>

      <GuideSection
        title="插件 Hook 怎么配"
        summary="插件目录下放 hooks/hooks.json，随插件启停，格式与技能 Hook 相同。"
      >
        <div className="space-y-3">
          <GuideSubSection
            title="加载规则"
            summary="插件目录下的 hooks/hooks.json 随插件自动加载，这里只能统一启停，不直接编辑。"
          >
            <div className="space-y-2 text-sm text-muted-foreground">
              <p>
                默认路径是
                <code className="mx-1 font-mono text-foreground/85">hooks/hooks.json</code>
                ，也可以在插件清单（manifest.json）里用
                <code className="mx-1 font-mono text-foreground/85">hooks</code>
                字段指定自定义路径。
              </p>
              <pre className="rounded-md border border-border/40 bg-background p-2 text-xs leading-5">
                {`~/.cmbcoworkagent/plugins/<plugin-name>/\n  manifest.json\n  hooks/\n    hooks.json      ← 默认路径\n    check.py`}
              </pre>
              <p>在"插件"页面启用或停用插件，对应的 Hook 随之生效或移除。</p>
            </div>
          </GuideSubSection>

          <GuideSubSection
            title="最小示例"
            summary="格式与技能 Hook 完全相同，扁平数组 / CC settings / CC plugin wrapper 均支持。"
          >
            <pre className="overflow-x-auto rounded-md border border-border/40 bg-background p-3 text-xs leading-5 text-foreground">
              <code>{PLUGIN_HOOK_FLAT_EXAMPLE}</code>
            </pre>
          </GuideSubSection>
        </div>
      </GuideSection>

      <GuideSection
        title="工作区 Hook 怎么配"
        summary="说明目录、自动发现规则、支持格式，以及两种可直接抄的最小示例。"
      >
        <div className="space-y-3">
          <GuideSubSection
            title="加载规则"
            summary="工作区 Hook 跟项目一起分发，放到约定目录后会自动扫描。"
          >
            <div className="space-y-2 text-sm text-muted-foreground">
              <p>
                把配置文件放到
                <code className="mx-1 font-mono text-foreground/85">
                  &lt;workspace&gt;/.cmbdevclaw/hooks/*.json
                </code>
                后，进入该工作区时就会自动加载。
              </p>
              <p>
                命令里的工作目录默认就是当前 workspace，所以可以直接写相对路径，例如
                <code className="mx-1 font-mono text-foreground/85">
                  python .cmbdevclaw/hooks/check.py
                </code>
                。
              </p>
              <p>当前工作区 Hook 默认直接生效，不需要再单独点“信任”。</p>
              <p>
                文件写成
                <code className="mx-1 font-mono text-foreground/85">enabled: false</code>
                时不会启用；删掉文件后就会随项目一起移除。
              </p>
            </div>
          </GuideSubSection>

          <GuideSubSection
            title="当前支持的文件格式"
            summary="工作区目前支持单对象格式，以及 Claude Code 风格的 hooks settings / plugin wrapper。"
          >
            <div className="space-y-2 text-sm text-muted-foreground">
              <p>单文件单 Hook：顶层就是一个对象，适合项目里快速挂一条规则。</p>
              <p>
                Claude Code 风格多 Hook：顶层是
                <code className="mx-1 font-mono text-foreground/85">{`{ EventName: [...] }`}</code>
                的 hooks settings。
              </p>
              <p>
                也支持带
                <code className="mx-1 font-mono text-foreground/85">hooks</code>
                包裹层的
                <code className="mx-1 font-mono text-foreground/85">{`{ hooks: { ... } }`}</code>
                形式。
              </p>
              <p>注意：工作区 Hook 当前不读取“全局 hooks 数组”格式，建议用下面这两种写法。</p>
            </div>
          </GuideSubSection>

          <GuideSubSection
            title="最小示例：单文件单 Hook"
            summary="适合一个项目只挂一条规则；这里的 timeout 单位是毫秒。"
          >
            <pre className="overflow-x-auto rounded-md border border-border/40 bg-background p-3 text-xs leading-5 text-foreground">
              <code>{WORKSPACE_HOOK_FLAT_EXAMPLE}</code>
            </pre>
          </GuideSubSection>

          <GuideSubSection
            title="最小示例：Claude Code 多 Hook"
            summary="适合一份文件里放多条规则；这里的 timeout 单位是秒，运行时会自动转成毫秒。"
          >
            <pre className="overflow-x-auto rounded-md border border-border/40 bg-background p-3 text-xs leading-5 text-foreground">
              <code>{WORKSPACE_HOOK_CC_EXAMPLE}</code>
            </pre>
          </GuideSubSection>

          <GuideSubSection
            title="额外说明"
            summary="工作区 Hook 和脚本本体如何放、onBlock 能不能用、日志怎么看。"
          >
            <div className="space-y-2 text-sm text-muted-foreground">
              <p>
                如果脚本本体是 Python / PowerShell / Shell 文件，可以和 JSON 配置一起放在
                <code className="mx-1 font-mono text-foreground/85">.cmbdevclaw/hooks</code>
                目录里，再在
                <code className="mx-1 font-mono text-foreground/85">command</code>
                里按相对路径调用。
              </p>
              <p>
                工作区 Hook 同样支持
                <code className="mx-1 font-mono text-foreground/85">onBlock.reason</code>、
                <code className="mx-1 font-mono text-foreground/85">onBlock.systemMessage</code>、
                <code className="mx-1 font-mono text-foreground/85">onBlock.additionalContext</code>
                、<code className="mx-1 font-mono text-foreground/85">onBlock.requiredSkill</code>。
              </p>
              <p>
                想查脚本到底收到了什么输入，最直接的办法还是把 payload 打到
                <code className="mx-1 font-mono text-foreground/85">stderr</code>
                ，然后去聊天区的“Hook 执行记录”看。
              </p>
            </div>
          </GuideSubSection>
        </div>
      </GuideSection>

      <GuideSection
        title="按事件查看输入 / 输出协议"
        summary={`当前选中事件：${badge.label}（${badge.english}）。先切事件，再按层展开 stdin / env / 返回字段 / 示例。`}
      >
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {GUIDE_EVENT_ORDER.map((guideEvent) => {
              const guideBadge = EVENT_BADGE[guideEvent]
              const active = guideEvent === event
              return (
                <button
                  key={guideEvent}
                  type="button"
                  className={cn(
                    "rounded-full border px-3 py-1.5 text-xs transition-colors",
                    active
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border/60 bg-muted/20 text-muted-foreground hover:border-primary/40 hover:text-foreground"
                  )}
                  onClick={() => setEvent(guideEvent)}
                >
                  {guideBadge.label}
                  <span className="ml-1 font-mono text-[10px] opacity-80">
                    {guideBadge.english}
                  </span>
                </button>
              )
            })}
          </div>

          <GuideSubSection
            title="脚本输入"
            summary={`${commandHookDoc.inputDescription} 当前事件下常见字段见展开内容。`}
          >
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={cn(
                    "rounded-full px-2 py-0.5 text-[10px] font-medium",
                    badge.className
                  )}
                >
                  {badge.label}
                </span>
                <span className="font-mono text-xs text-muted-foreground">{badge.english}</span>
              </div>
              <p className="text-sm text-muted-foreground">{badge.tip}</p>
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
            </div>
          </GuideSubSection>

          <GuideSubSection
            title="可直接读取的信息"
            summary="按层展开 stdin 顶层字段、环境变量，以及当前事件特有的对象。"
          >
            <div className="space-y-3">
              <GuideSubSection
                title={`stdin 顶层字段（${readableContextDocs.stdinFields.length}）`}
                summary="这些字段会直接出现在传给脚本的 stdin JSON 顶层。"
              >
                <div className="space-y-2">
                  {readableContextDocs.stdinFields.map((field) => (
                    <div
                      key={field.key}
                      className="rounded-md border border-border/40 bg-background px-3 py-2"
                    >
                      <p className="font-mono text-[11px] text-foreground/85">{field.key}</p>
                      <p className="text-sm text-muted-foreground">{field.description}</p>
                      {field.note && (
                        <p className="mt-1 text-xs text-foreground/75">{field.note}</p>
                      )}
                    </div>
                  ))}
                </div>
              </GuideSubSection>

              <GuideSubSection
                title={`环境变量（${readableContextDocs.envFields.length}）`}
                summary="这些字段是便捷读取方式，但大 payload 仍以 stdin JSON 为准。"
              >
                <div className="space-y-2">
                  {readableContextDocs.envFields.map((field) => (
                    <div
                      key={field.key}
                      className="rounded-md border border-border/40 bg-background px-3 py-2"
                    >
                      <p className="font-mono text-[11px] text-foreground/85">{field.key}</p>
                      <p className="text-sm text-muted-foreground">{field.description}</p>
                      {field.note && (
                        <p className="mt-1 text-xs text-foreground/75">{field.note}</p>
                      )}
                    </div>
                  ))}
                </div>
              </GuideSubSection>

              {readableContextDocs.extraObjects.length > 0 && (
                <GuideSubSection
                  title={`事件专属对象（${readableContextDocs.extraObjects.length}）`}
                  summary="例如 tool_response、stop_context、subagent 这类只在部分事件出现的结构。"
                >
                  <div className="space-y-2">
                    {readableContextDocs.extraObjects.map((doc) => (
                      <div
                        key={doc.key}
                        className="rounded-md border border-border/40 bg-background px-3 py-2 space-y-1.5"
                      >
                        <span className="inline-flex rounded-full border border-border/50 bg-muted/20 px-2 py-0.5 font-mono text-[10px] text-foreground/80">
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
                        {doc.note && <p className="text-xs text-foreground/75">{doc.note}</p>}
                      </div>
                    ))}
                  </div>
                </GuideSubSection>
              )}
            </div>
          </GuideSubSection>

          <GuideSubSection
            title="返回值与日志"
            summary="普通文本、JSON 返回、以及 stderr 调试日志的职责边界都在这里。"
          >
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">{commandHookDoc.outputDescription}</p>
              <div className="space-y-2">
                {commandHookDoc.outputNotes.map((note) => (
                  <div
                    key={note}
                    className="rounded-md border border-border/40 bg-background px-3 py-2 text-sm text-muted-foreground"
                  >
                    {note}
                  </div>
                ))}
              </div>
              <GuideSubSection
                title="常见 JSON 返回字段"
                summary="阻断、改写输入、提示用户、挂整改技能这些字段的用途说明。"
              >
                <div className="space-y-2">
                  {COMMON_COMMAND_RESULT_FIELDS.map((field) => (
                    <div
                      key={field.key}
                      className="rounded-md border border-border/40 bg-background px-3 py-2"
                    >
                      <p className="font-mono text-[11px] text-foreground/85">{field.key}</p>
                      <p className="text-sm text-muted-foreground">{field.description}</p>
                    </div>
                  ))}
                </div>
              </GuideSubSection>
            </div>
          </GuideSubSection>

          {toolInputDocs.length > 0 && (
            <GuideSubSection title="tool_input 常见字段" summary={toolInputSummary}>
              <div className="space-y-2">
                {toolInputDocs.map((doc) => (
                  <div
                    key={doc.key}
                    className="rounded-md border border-border/40 bg-background px-3 py-2 space-y-1.5"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded-full border border-border/50 bg-muted/20 px-2 py-0.5 font-mono text-[10px] text-foreground/80">
                        {doc.label}
                      </span>
                      {doc.fileHint && (
                        <span className="rounded-full border border-emerald-300/50 bg-emerald-50 px-2 py-0.5 text-[10px] text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300">
                          可直接读路径
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
            </GuideSubSection>
          )}

          <GuideSubSection
            title="当前事件的最小脚本示例"
            summary="展开后可在 Python 和 Shell / PowerShell 之间切换。"
          >
            <div className="space-y-3">
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant={exampleKind === "python" ? "default" : "outline"}
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => setExampleKind("python")}
                >
                  Python
                </Button>
                <Button
                  type="button"
                  variant={exampleKind === "shell" ? "default" : "outline"}
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => setExampleKind("shell")}
                >
                  Shell / PowerShell
                </Button>
              </div>
              <pre className="overflow-x-auto rounded-md border border-border/40 bg-background p-3 text-xs leading-5 text-foreground">
                <code>{selectedExample}</code>
              </pre>
            </div>
          </GuideSubSection>
        </div>
      </GuideSection>

      <GuideSection
        title="调试建议"
        summary="怎么查看 Hook 日志、stdout / stderr 的分工，以及大 payload 时该看哪。"
      >
        <div className="space-y-2 text-sm text-muted-foreground">
          <p>如果 stdout 输出的是 JSON，就会被当成 Hook 返回值解析；调试日志请尽量写到 stderr。</p>
          <p>
            想确认某次触发时到底传了什么，可以临时把读到的 payload 原样打印到
            stderr，然后去聊天区的“Hook 执行记录”查看。
          </p>
          <p>
            <code className="mx-1 font-mono text-foreground/85">TOOL_ARGS</code> /
            <code className="mx-1 font-mono text-foreground/85">TOOL_RESULT</code>
            只在内容较小时才会注入环境变量。无论大小，完整权威数据都始终在 stdin JSON 里。
          </p>
        </div>
      </GuideSection>
    </div>
  )
}
