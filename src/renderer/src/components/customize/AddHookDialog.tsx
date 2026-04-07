import { useCallback, useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { useAppStore } from "@/lib/store"
import type { HookConfig, HookEvent, HookType, PromptHookFallback, HookUpsert } from "@/types"

// ── 常用工具选项 ──────────────────────────────────────────────────────────────
export const COMMON_TOOLS: { value: string; label: string; description: string }[] = [
  { value: "*",          label: "所有工具",     description: "匹配任意工具调用" },
  { value: "execute",    label: "执行命令",     description: "Shell / PowerShell 命令执行（execute）" },
  { value: "write_file", label: "写入文件",     description: "创建或覆盖文件内容（write_file）" },
  { value: "edit_file",  label: "编辑文件",     description: "局部替换文件内容（edit_file）" },
  { value: "read_file",  label: "读取文件",     description: "读取文件内容（read_file）" },
  { value: "memory_search", label: "搜索记忆",  description: "检索长期记忆（memory_search）" },
  { value: "memory_get", label: "读取记忆",     description: "读取记忆文件（memory_get）" },
  { value: "manage_scheduler", label: "调度任务", description: "创建/修改定时任务（manage_scheduler）" },
  { value: "manage_skill",   label: "技能管理", description: "加载/卸载技能（manage_skill）" },
  { value: "custom",     label: "自定义…",      description: "手动输入工具名称" },
]
const CUSTOM_SENTINEL = "custom"

const HOOK_EVENTS: { value: HookEvent; label: string; description: string }[] = [
  { value: "PreToolUse", label: "工具调用前", description: "在工具执行前触发，拦截后可阻止执行，阻断原因会反馈给 Agent 使其自适应调整" },
  { value: "PostToolUse", label: "工具调用后", description: "在工具执行后触发，stdout 会追加到 Agent 下一轮上下文，外部系统状态可参与 AI 推理" },
  { value: "Stop", label: "Agent 停止时", description: "Agent 完成任务停止时触发，可用于清理临时文件或发送通知" },
  { value: "Notification", label: "通知事件", description: "通知事件触发，可用于自定义提醒或消息推送" }
]

const FALLBACK_OPTIONS: { value: PromptHookFallback; label: string; description: string }[] = [
  { value: "allow", label: "宽松（默认放行）", description: "模型超时或返回异常时默认放行，适合非关键场景" },
  { value: "block", label: "严格（默认阻断）", description: "模型超时或返回异常时默认阻断，适合高安全要求场景" }
]

export function AddHookDialog(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess: () => void
  editHook?: HookConfig | null
}): React.JSX.Element {
  const { open, onOpenChange, onSuccess, editHook } = props
  const { models, loadModels } = useAppStore()

  useEffect(() => {
    if (open && models.length === 0) loadModels()
  }, [open, models.length, loadModels])

  const [hookType, setHookType] = useState<HookType>(editHook?.type ?? "command")
  const [event, setEvent] = useState<HookEvent>(editHook?.event ?? "PreToolUse")
  const [matcher, setMatcher] = useState(editHook?.matcher ?? "")
  // matcher mode: preset value or "custom" for manual input
  const initMatcherMode = (h: HookConfig | null | undefined): string => {
    const m = h?.matcher ?? ""
    if (!m) return "*"
    return COMMON_TOOLS.some((t) => t.value !== CUSTOM_SENTINEL && t.value === m) ? m : CUSTOM_SENTINEL
  }
  const [matcherMode, setMatcherMode] = useState<string>(initMatcherMode(editHook))
  // command fields
  const [command, setCommand] = useState(editHook?.command ?? "")
  // prompt fields
  const [prompt, setPrompt] = useState(editHook?.prompt ?? "")
  const [modelId, setModelId] = useState(editHook?.modelId ?? "")
  const [fallback, setFallback] = useState<PromptHookFallback>(editHook?.fallback ?? "allow")
  // shared
  const [timeout, setTimeout_] = useState(String(editHook?.timeout ?? 10000))
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const populateFromHook = useCallback((h: HookConfig | null | undefined) => {
    if (h) {
      setHookType(h.type ?? "command")
      setEvent(h.event)
      const mm = initMatcherMode(h)
      setMatcherMode(mm)
      setMatcher(mm === CUSTOM_SENTINEL ? (h.matcher ?? "") : "")
      setCommand(h.command ?? "")
      setPrompt(h.prompt ?? "")
      setModelId(h.modelId ?? "")
      setFallback(h.fallback ?? "allow")
      setTimeout_(String(h.timeout ?? 10000))
    } else {
      setHookType("command")
      setEvent("PreToolUse")
      setMatcherMode("*")
      setMatcher("")
      setCommand("")
      setPrompt("")
      setModelId("")
      setFallback("allow")
      setTimeout_("10000")
    }
    setError(null)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (open) populateFromHook(editHook)
  }, [open, editHook, populateFromHook])

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) populateFromHook(editHook)
      onOpenChange(next)
    },
    [onOpenChange, editHook, populateFromHook]
  )

  const showMatcher = event === "PreToolUse" || event === "PostToolUse"

  const handleSubmit = useCallback(async () => {
    setError(null)

    if (hookType === "command") {
      if (!command.trim()) { setError("请输入命令"); return }
    } else {
      if (!prompt.trim()) { setError("请输入合规策略描述"); return }
    }

    setSubmitting(true)
    try {
      const config: HookUpsert = {
        event,
        type: hookType,
        timeout: Math.min(60000, Math.max(1000, parseInt(timeout, 10) || 10000)),
        enabled: editHook ? editHook.enabled : true
      }
      if (showMatcher) {
        const resolvedMatcher = matcherMode === CUSTOM_SENTINEL ? matcher.trim() : matcherMode
        if (resolvedMatcher && resolvedMatcher !== "*") config.matcher = resolvedMatcher
      }

      if (hookType === "command") {
        config.command = command.trim()
      } else {
        config.prompt = prompt.trim()
        if (modelId.trim()) config.modelId = modelId.trim()
        config.fallback = fallback
      }

      if (editHook) {
        await window.api.hooks.update({ ...config, id: editHook.id })
      } else {
        await window.api.hooks.create(config)
      }
      onSuccess()
      handleOpenChange(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败")
    } finally {
      setSubmitting(false)
    }
  }, [hookType, event, matcher, command, prompt, modelId, fallback, timeout, editHook, onSuccess, handleOpenChange, showMatcher])

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editHook ? "编辑 Hook" : "添加 Hook"}</DialogTitle>
          <DialogDescription>
            配置在特定事件发生时自动执行的 Shell 命令，或用自然语言描述合规策略由模型判决。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Hook type toggle */}
          <div className="space-y-2">
            <label className="text-sm font-medium">Hook 类型</label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setHookType("command")}
                className={cn(
                  "flex-1 py-2 px-3 rounded-md border text-sm font-medium transition-colors",
                  hookType === "command"
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border bg-background text-muted-foreground hover:border-primary/50"
                )}
              >
                Shell 命令
              </button>
              <button
                type="button"
                onClick={() => setHookType("prompt")}
                className={cn(
                  "flex-1 py-2 px-3 rounded-md border text-sm font-medium transition-colors",
                  hookType === "prompt"
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border bg-background text-muted-foreground hover:border-primary/50"
                )}
              >
                自然语言策略
              </button>
            </div>
            <p className="text-xs text-muted-foreground">
              {hookType === "command"
                ? "执行 Shell 命令，exit!=0 时阻断工具调用"
                : "用自然语言描述合规规则，由行内 LLM 实时判决是否允许执行"}
            </p>
          </div>

          {/* Event */}
          <div className="space-y-2">
            <label htmlFor="hook-event" className="text-sm font-medium">事件类型</label>
            <select
              id="hook-event"
              value={event}
              onChange={(e) => setEvent(e.target.value as HookEvent)}
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
            >
              {HOOK_EVENTS.map((ev) => (
                <option key={ev.value} value={ev.value}>{ev.label}</option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">
              {HOOK_EVENTS.find((ev) => ev.value === event)?.description}
            </p>
          </div>

          {/* Matcher */}
          {showMatcher && (
            <div className="space-y-2">
              <label htmlFor="hook-matcher-select" className="text-sm font-medium">工具匹配</label>
              <select
                id="hook-matcher-select"
                value={matcherMode}
                onChange={(e) => {
                  setMatcherMode(e.target.value)
                  if (e.target.value !== CUSTOM_SENTINEL) setMatcher("")
                }}
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                {COMMON_TOOLS.map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                {COMMON_TOOLS.find((t) => t.value === matcherMode)?.description ?? ""}
              </p>
              {matcherMode === CUSTOM_SENTINEL && (
                <Input
                  placeholder="输入工具名称，如 execute"
                  value={matcher}
                  onChange={(e) => setMatcher(e.target.value)}
                  className="h-9 font-mono"
                  autoFocus
                />
              )}
            </div>
          )}

          {/* Command-specific */}
          {hookType === "command" && (
            <div className="space-y-2">
              <label htmlFor="hook-command" className="text-sm font-medium">命令</label>
              <Input
                id="hook-command"
                placeholder='echo "hello" 或 python C:\scripts\check.py'
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                className="h-9 font-mono"
              />
            </div>
          )}

          {/* Prompt-specific */}
          {hookType === "prompt" && (
            <>
              <div className="space-y-2">
                <label htmlFor="hook-prompt" className="text-sm font-medium">合规策略描述</label>
                <textarea
                  id="hook-prompt"
                  placeholder={"例：如果 AI 执行的命令包含生产数据库关键词（prod/prd/production）且不是只读的 SELECT 操作，则阻止并说明原因"}
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  rows={4}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-ring"
                />
                <p className="text-xs text-muted-foreground">
                  用自然语言描述业务合规规则，行内 LLM 将据此对每次工具调用进行实时判决
                </p>
              </div>

              <div className="space-y-2">
                <label htmlFor="hook-model" className="text-sm font-medium">判决模型（可选）</label>
                <select
                  id="hook-model"
                  value={modelId}
                  onChange={(e) => setModelId(e.target.value)}
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="">使用默认模型</option>
                  {models.map((m) => (
                    <option key={m.id} value={m.id} disabled={!m.available}>
                      {m.name}{m.tier === "economy" ? " (轻量)" : ""}{!m.available ? " (不可用)" : ""}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-muted-foreground">
                  建议选轻量模型专用于 Hook 判决，与主对话模型解耦，降低延迟和成本
                </p>
              </div>

              <div className="space-y-2">
                <label htmlFor="hook-fallback" className="text-sm font-medium">超时/异常回退策略</label>
                <select
                  id="hook-fallback"
                  value={fallback}
                  onChange={(e) => setFallback(e.target.value as PromptHookFallback)}
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  {FALLBACK_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
                <p className="text-xs text-muted-foreground">
                  {FALLBACK_OPTIONS.find((o) => o.value === fallback)?.description}
                </p>
              </div>
            </>
          )}

          {/* Timeout (shared) */}
          <div className="space-y-2">
            <label htmlFor="hook-timeout" className="text-sm font-medium">超时（ms）</label>
            <Input
              id="hook-timeout"
              type="number"
              placeholder="10000"
              value={timeout}
              onChange={(e) => setTimeout_(e.target.value)}
              className="h-9"
            />
            <p className="text-xs text-muted-foreground">
              {hookType === "prompt"
                ? "LLM 判决超时时间（含网络往返），范围 1000–60000ms，建议 ≥15000ms"
                : "命令执行超时时间，范围 1000–60000ms，默认 10000ms"}
            </p>
          </div>
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={submitting}>
            取消
          </Button>
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting ? "处理中…" : (editHook ? "保存" : "添加")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
