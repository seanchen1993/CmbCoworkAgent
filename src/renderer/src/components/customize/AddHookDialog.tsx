import { useCallback, useEffect, useMemo, useState } from "react"
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { cn } from "@/lib/utils"
import { useAppStore } from "@/lib/store"
import type { HookConfig, HookEvent, HookType, PromptHookFallback, HookUpsert, SkillMetadata } from "@/types"

// ── 常用工具选项 ──────────────────────────────────────────────────────────────
export const COMMON_TOOLS: { value: string; label: string; description: string }[] = [
  { value: "*",              label: "所有工具（*）",                description: "匹配任意工具调用" },
  { value: "execute",        label: "执行命令（execute）",          description: "Shell / PowerShell 命令执行" },
  { value: "write_file",     label: "写入文件（write_file）",      description: "创建或覆盖文件内容" },
  { value: "edit_file",      label: "编辑文件（edit_file）",       description: "局部替换文件内容" },
  { value: "read_file",      label: "读取文件（read_file）",       description: "读取文件内容" },
  { value: "memory_search",  label: "搜索记忆（memory_search）",   description: "检索长期记忆" },
  { value: "memory_get",     label: "读取记忆（memory_get）",      description: "读取记忆文件" },
  { value: "manage_scheduler", label: "调度任务（manage_scheduler）", description: "创建/修改定时任务" },
  { value: "manage_skill",   label: "技能管理（manage_skill）",    description: "加载/卸载技能" },
  { value: "custom",         label: "自定义…",                     description: "手动输入工具名称或正则表达式" },
]
const CUSTOM_SENTINEL = "custom"

const HOOK_EVENTS: { value: HookEvent; label: string; description: string }[] = [
  { value: "PreToolUse", label: "工具调用前（PreToolUse）", description: "在工具执行前触发，拦截后可阻止执行，阻断原因会反馈给 Agent 使其自适应调整" },
  { value: "PostToolUse", label: "工具调用后（PostToolUse）", description: "在工具执行后触发，stdout 会追加到 Agent 下一轮上下文，外部系统状态可参与 AI 推理" },
  { value: "UserPromptSubmit", label: "用户提交提示（UserPromptSubmit）", description: "用户消息进入模型前触发，可阻断、重写提示或注入 additionalContext" },
  { value: "SessionStart", label: "会话开始（SessionStart）", description: "线程首次运行 Agent 时触发一次，适合初始化会话资源" },
  { value: "SessionEnd", label: "会话结束（SessionEnd）", description: "线程删除或应用退出时触发，适合清理会话资源" },
  { value: "Stop", label: "Agent 停止时（Stop）", description: "Agent 完成任务停止时触发，可请求 Agent 返工或发送通知" },
  { value: "Notification", label: "通知事件（Notification）", description: "Agent 等待用户审批时触发，可用于自定义提醒或消息推送" },
  { value: "SubagentStop", label: "子 Agent 停止（SubagentStop）", description: "子 Agent 任务结束时触发，可用于记录或同步子任务结果" }
]

const FALLBACK_OPTIONS: { value: PromptHookFallback; label: string; description: string }[] = [
  { value: "allow", label: "宽松（默认放行）", description: "模型超时或返回异常时默认放行，适合非关键场景" },
  { value: "block", label: "严格（默认阻断）", description: "模型超时或返回异常时默认阻断，适合高安全要求场景" }
]
const MANUAL_SKILL_VALUE = "__manual_skill__"

export function AddHookDialog(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess: () => void
  editHook?: HookConfig | null
}): React.JSX.Element {
  const { open, onOpenChange, onSuccess, editHook } = props
  const { models, loadModels } = useAppStore()
  const [skills, setSkills] = useState<SkillMetadata[]>([])
  const [disabledSkillNames, setDisabledSkillNames] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (open && models.length === 0) loadModels()
  }, [open, models.length, loadModels])

  useEffect(() => {
    if (!open) return

    let cancelled = false
    void Promise.all([window.api.skills.list(), window.api.skills.getDisabled()])
      .then(([availableSkills, disabled]) => {
        if (cancelled) return
        setSkills([...availableSkills].sort((a, b) => a.name.localeCompare(b.name, "zh-CN")))
        setDisabledSkillNames(new Set(disabled.map((name) => name.trim().toLowerCase())))
      })
      .catch((error) => {
        console.error("[AddHookDialog] Failed to load skills:", error)
        if (cancelled) return
        setSkills([])
        setDisabledSkillNames(new Set())
      })

    return () => {
      cancelled = true
    }
  }, [open])

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
  const [onBlockReason, setOnBlockReason] = useState(editHook?.onBlock?.reason ?? "")
  const [onBlockSystemMessage, setOnBlockSystemMessage] = useState(editHook?.onBlock?.systemMessage ?? "")
  const [onBlockRequiredSkill, setOnBlockRequiredSkill] = useState(editHook?.onBlock?.requiredSkill ?? "")
  const [onBlockAdditionalContext, setOnBlockAdditionalContext] = useState(editHook?.onBlock?.additionalContext ?? "")
  // shared
  const [timeout, setTimeout_] = useState(String(editHook?.timeout ?? 10000))
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const configuredSkills = useMemo(() => {
    const enabled: SkillMetadata[] = []
    const disabled: SkillMetadata[] = []

    for (const skill of skills) {
      if (disabledSkillNames.has(skill.name.trim().toLowerCase())) {
        disabled.push(skill)
      } else {
        enabled.push(skill)
      }
    }

    return [...enabled, ...disabled]
  }, [skills, disabledSkillNames])
  const matchedSkill = useMemo(() => {
    const normalized = onBlockRequiredSkill.trim().toLowerCase()
    if (!normalized) return null
    return skills.find((skill) => skill.name.trim().toLowerCase() === normalized) ?? null
  }, [skills, onBlockRequiredSkill])
  const matchedSkillDisabled = matchedSkill
    ? disabledSkillNames.has(matchedSkill.name.trim().toLowerCase())
    : false
  const requiredSkillPickerValue =
    matchedSkill
      ? matchedSkill.name
      : MANUAL_SKILL_VALUE

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
      setOnBlockReason(h.onBlock?.reason ?? "")
      setOnBlockSystemMessage(h.onBlock?.systemMessage ?? "")
      setOnBlockRequiredSkill(h.onBlock?.requiredSkill ?? "")
      setOnBlockAdditionalContext(h.onBlock?.additionalContext ?? "")
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
      setOnBlockReason("")
      setOnBlockSystemMessage("")
      setOnBlockRequiredSkill("")
      setOnBlockAdditionalContext("")
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

      const onBlock = {
        reason: onBlockReason.trim(),
        systemMessage: onBlockSystemMessage.trim(),
        requiredSkill: onBlockRequiredSkill.trim(),
        additionalContext: onBlockAdditionalContext.trim()
      }
      if (onBlock.reason || onBlock.systemMessage || onBlock.requiredSkill || onBlock.additionalContext) {
        config.onBlock = onBlock
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
  }, [hookType, event, matcherMode, matcher, command, prompt, modelId, fallback, timeout, onBlockReason, onBlockSystemMessage, onBlockRequiredSkill, onBlockAdditionalContext, editHook, onSuccess, handleOpenChange, showMatcher])

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[85vh] flex flex-col gap-0 p-0">
        <DialogHeader className="shrink-0 px-6 pt-6 pb-4 border-b border-border/60">
          <DialogTitle>{editHook ? "编辑 Hook" : "添加 Hook"}</DialogTitle>
          <DialogDescription>
            配置在特定事件发生时自动执行的 Shell 命令，或用自然语言描述合规策略由模型判决。
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain px-6 py-4">
          <div className="space-y-4 pr-1">
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
                ? "执行 Shell 命令，exit=2 时阻断；exit=0 可返回 Claude Code JSON 输出"
                : "用自然语言描述合规规则，由行内 LLM 实时判决是否允许执行"}
            </p>
          </div>

          {/* Event */}
          <div className="space-y-2">
            <label className="text-sm font-medium">事件类型</label>
            <Select value={event} onValueChange={(v) => setEvent(v as HookEvent)}>
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {HOOK_EVENTS.map((ev) => (
                  <SelectItem key={ev.value} value={ev.value} className="py-2">
                    <div>
                      <span className="text-sm">{ev.label}</span>
                      <p className="text-xs text-muted-foreground mt-0.5">{ev.description}</p>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Matcher */}
          {showMatcher && (
            <div className="space-y-2">
              <label className="text-sm font-medium">工具匹配</label>
              <Select value={matcherMode} onValueChange={(v) => {
                setMatcherMode(v)
                if (v !== CUSTOM_SENTINEL) setMatcher("")
              }}>
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {COMMON_TOOLS.map((t) => (
                    <SelectItem key={t.value} value={t.value} className="py-2">
                      <div>
                        <span className="text-sm">{t.label}</span>
                        <p className="text-xs text-muted-foreground mt-0.5">{t.description}</p>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {matcherMode === CUSTOM_SENTINEL && (
                <>
                  <Input
                    placeholder="输入工具名称，如 execute 或 write_file|edit_file"
                    value={matcher}
                    onChange={(e) => setMatcher(e.target.value)}
                    className="h-9 font-mono"
                    autoFocus
                  />
                  <p className="text-xs text-muted-foreground">
                    精确匹配工具名（不区分大小写）。包含 <code className="font-mono">| * + ? ^ $ ( ) [ ] {"{"} {"}"} \</code> 时按
                    <strong>正则表达式</strong>解析（不是 glob）。例如 <code className="font-mono">write_file|edit_file</code> 命中两个工具，
                    <code className="font-mono">mcp__.*</code> 命中所有 mcp 工具。
                  </p>
                </>
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

          <div className="space-y-3 rounded-md border border-border/60 bg-muted/20 p-3">
            <div className="space-y-1">
              <label className="text-sm font-medium">阻断后补充配置（onBlock）</label>
              <p className="text-xs text-muted-foreground">
                当 Hook 发生阻断或停止时，静态补齐整改信息。不会覆盖 Hook 自己已经返回的 reason，只补充缺失字段并附加提示。
              </p>
            </div>

            <div className="space-y-2">
              <label htmlFor="hook-onblock-reason" className="text-sm font-medium">阻断原因回退（可选）</label>
              <Input
                id="hook-onblock-reason"
                placeholder="例如：请先按整改技能处理后再重试"
                value={onBlockReason}
                onChange={(e) => setOnBlockReason(e.target.value)}
                className="h-9"
              />
            </div>

            <div className="space-y-2">
              <label htmlFor="hook-onblock-system-message" className="text-sm font-medium">用户提示（可选）</label>
              <Input
                id="hook-onblock-system-message"
                placeholder="例如：Hook 已阻断本次操作，并附带整改技能"
                value={onBlockSystemMessage}
                onChange={(e) => setOnBlockSystemMessage(e.target.value)}
                className="h-9"
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">联动已配置技能（可选）</label>
              <Select
                value={requiredSkillPickerValue}
                onValueChange={(value) => {
                  if (value === MANUAL_SKILL_VALUE) return
                  setOnBlockRequiredSkill(value)
                }}
              >
                <SelectTrigger className="h-9">
                  <SelectValue placeholder={configuredSkills.length > 0 ? "从当前已配置技能中选择" : "暂无已配置技能"} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={MANUAL_SKILL_VALUE}>手动输入或保留当前值</SelectItem>
                  {configuredSkills.map((skill) => {
                    const skillDisabled = disabledSkillNames.has(skill.name.trim().toLowerCase())

                    return (
                      <SelectItem key={skill.path} value={skill.name} className="py-2">
                        <div>
                          <span className="text-sm">
                            {skill.name}
                            {skillDisabled ? "（已禁用）" : ""}
                          </span>
                          <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                            {skill.description || (skillDisabled ? "该技能当前已禁用" : "无描述")}
                          </p>
                        </div>
                      </SelectItem>
                    )
                  })}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {configuredSkills.length > 0
                  ? "这里联动的是当前已配置技能。选中后会自动写入下方 `requiredSkill` 字段；若技能已禁用，需要先启用后运行时才会注入整改指引。"
                  : "当前还没有可联动的技能，仍可手动填写 `requiredSkill`。"}
              </p>
            </div>

            <div className="space-y-2">
              <label htmlFor="hook-onblock-required-skill" className="text-sm font-medium">整改技能（requiredSkill，可选）</label>
              <Input
                id="hook-onblock-required-skill"
                placeholder="可手动输入，或从上方已配置技能列表带入"
                value={onBlockRequiredSkill}
                onChange={(e) => setOnBlockRequiredSkill(e.target.value)}
                className="h-9 font-mono"
              />
              {onBlockRequiredSkill.trim() && matchedSkill && !matchedSkillDisabled && (
                <p className="text-xs text-muted-foreground">
                  已匹配技能：`{matchedSkill.name}` {matchedSkill.source === "user" ? "（自定义）" : "（内置）"}
                </p>
              )}
              {onBlockRequiredSkill.trim() && matchedSkillDisabled && (
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  当前填写的技能存在，但已被禁用。运行时只会对已启用技能注入整改指引。
                </p>
              )}
              {onBlockRequiredSkill.trim() && !matchedSkill && (
                <p className="text-xs text-muted-foreground">
                  当前值未匹配到技能列表，将按原样保存。只有运行时能解析到已启用技能时才会生效。
                </p>
              )}
            </div>

            <div className="space-y-2">
              <label htmlFor="hook-onblock-context" className="text-sm font-medium">额外上下文（additionalContext，可选）</label>
              <textarea
                id="hook-onblock-context"
                placeholder="补充给 Agent 的隐藏整改说明"
                value={onBlockAdditionalContext}
                onChange={(e) => setOnBlockAdditionalContext(e.target.value)}
                rows={3}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
          </div>
          </div>
        </div>

        <div className="shrink-0 border-t border-border/60 px-6 py-4 bg-background">
          {error && <p className="text-sm text-destructive mb-3">{error}</p>}

          <DialogFooter>
            <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={submitting}>
              取消
            </Button>
            <Button onClick={handleSubmit} disabled={submitting}>
              {submitting ? "处理中…" : (editHook ? "保存" : "添加")}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  )
}
