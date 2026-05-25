import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  Plus,
  Search,
  X,
  Pencil,
  Trash2,
  Webhook,
  Terminal,
  BrainCircuit,
  FolderOpen
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { toast } from "sonner"
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
    tip: "工具执行前触发，可拦截阻断；continue=false 强制阻断该次工具调用"
  },
  PostToolUse: {
    label: "调用后",
    className: "bg-green-500/15 text-green-600 dark:text-green-400",
    english: "PostToolUse",
    tip: "工具执行后触发，输出追加到 Agent 上下文，可要求修订或终止本轮"
  },
  PreSkillUse: {
    label: "技能前",
    className: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
    english: "PreSkillUse",
    tip: "技能被选择、激活或首次读取前触发，可按技能名拦截或直接终止本轮"
  },
  PostSkillUse: {
    label: "技能后",
    className: "bg-green-500/15 text-green-600 dark:text-green-400",
    english: "PostSkillUse",
    tip: "本轮结束时对已激活技能触发，可记录结果、要求修订或直接终止本轮"
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
    tip: "用户消息进入模型前触发，可阻断、重写或直接终止本轮"
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
    tip: "Agent 完成任务停止时触发，可请求返工或直接终止本轮"
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
    key: "continue=false",
    description:
      "直接终止本轮（不修订、不报错），优先级高于 decision=block；Stop / PostSkillUse 上是真的结束整轮，Pre / Post 工具事件等同强制阻断该次操作。"
  },
  {
    key: "stopReason",
    description: "搭配 continue=false 使用，作为终止原因展示给用户和 Agent。"
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

const FORCED_OUTCOME_FIELDS: Array<{ key: string; description: string }> = [
  {
    key: 'forcedOutcome="always-revise"',
    description:
      "无视 hook stdout，强制走修订流程（等同 hook 总是返回 decision=block）；此时 forcedReason 作为 reason 传给 Agent。"
  },
  {
    key: 'forcedOutcome="always-halt"',
    description:
      "无视 hook stdout，强制终止本轮（等同 hook 总是返回 continue=false）；此时 forcedReason 作为 stopReason；优先级高于 always-revise。"
  },
  {
    key: "forcedReason",
    description:
      "可选；为 always-revise / always-halt 提供静态原因。不填则回退到 hook 自身输出的 reason / stopReason。"
  }
]

const HOOK_CONFIG_EXTENSION_FIELDS: Array<{ key: string; description: string }> = [
  {
    key: "once",
    description:
      "兼容 Claude Code 的一次性执行开关。设为 true 后，同一会话里同一条 Hook 第一次成功执行（exit=0）后不再重复执行；不同事件、来源或 Hook ID 分别计算。脚本失败 / 超时（exit≠0）不会标记为已执行，下次匹配时仍会再试。会话结束（线程删除或应用退出）会清除已执行状态；编辑、禁用再启用、删除该 Hook 也会立即清除。注意：在 SubagentStop / Notification / SessionStart / SessionEnd 等 fire-and-forget 事件下，并发触发可能仍执行多次，如需严格只跑一次请使用 PreToolUse / PostToolUse / Stop 等同步事件。"
  },
  {
    key: "persistAfterInterrupt",
    description:
      "CMB 扩展字段。仅对插件 / 技能 Hook 的作用域有意义；设为 true 后，只要本会话里触发过该 Hook 所属的插件或技能，这条 Hook 后续轮次也会继续命中。持久化按 Hook 身份计算，不会让同技能下未开启的兄弟 Hook 一起生效。"
  },
  {
    key: "timeout",
    description:
      "超时时间。扁平数组 / 单对象格式按毫秒解释；Claude Code hooks settings 格式按秒解释。"
  },
  {
    key: "timeoutMs",
    description:
      "CMB 扩展字段，始终按毫秒解释；在 Claude Code hooks settings / SKILL.md frontmatter 中优先级高于 timeout。"
  },
  {
    key: "id",
    description:
      "可选稳定 ID；在 Claude Code 多 Hook 格式里建议填写，方便一次性执行、日志和后续定位保持稳定。"
  },
  {
    key: "model / modelId",
    description:
      "自然语言策略 Hook 的判决模型。兼容 Claude Code 的 model，也支持 CMB 原生 modelId。"
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
    "once": true,
    "persistAfterInterrupt": true,
    "onBlock": {
      "reason": "高风险写入，请先按整改流程处理",
      "requiredSkill": "my-skill-name"
    }
  },
  {
    "event": "Stop",
    "type": "command",
    "command": "python hooks/post-check.py"
  },
  {
    "event": "PostSkillUse",
    "matcher": "secret-policy",
    "type": "command",
    "command": "python hooks/post-skill-audit.py",
    "forcedOutcome": "always-halt",
    "forcedReason": "安全策略命中，直接终止本轮"
  }
]`

const SKILL_HOOK_CC_EXAMPLE = `{
  "PreToolUse": [
    {
      "matcher": "write_file|edit_file",
      "hooks": [
        {
          "id": "pre-write-check",
          "type": "command",
          "command": "python hooks/pre-write-check.py",
          "timeout": 10,
          "timeoutMs": 12000,
          "once": true,
          "persistAfterInterrupt": true
        }
      ]
    }
  ],
  "PostSkillUse": [
    {
      "matcher": "secret-policy",
      "hooks": [
        {
          "id": "post-skill-audit",
          "type": "command",
          "command": "python hooks/post-skill-audit.py",
          "forcedOutcome": "always-halt",
          "forcedReason": "命中策略，直接终止本轮"
        }
      ]
    }
  ]
}`

const SKILL_HOOK_FRONTMATTER_EXAMPLE = `---
name: secret-policy
description: 处理敏感信息前必须使用。用户提到密钥、凭据、脱敏、审计或 secret 时使用。
hooks:
  PreToolUse:
    - matcher: write_file|edit_file
      hooks:
        - id: pre-write-check
          type: command
          command: python hooks/pre-write-check.py
          timeout: 10
          timeoutMs: 12000
          once: true
          persistAfterInterrupt: true
          onBlock:
            reason: 高风险写入，请先按技能流程处理
            requiredSkill: secret-policy
  PostSkillUse:
    - hooks:
        - id: post-skill-audit
          type: command
          command: python hooks/post-skill-audit.py
          forcedOutcome: always-revise
          forcedReason: 技能使用后需要补充审计结论
---

# Secret Policy

按敏感信息处理流程完成任务。`

const PLUGIN_HOOK_FLAT_EXAMPLE = `[
  {
    "event": "PreToolUse",
    "matcher": "write_file",
    "type": "command",
    "command": "python hooks/pre-write.py",
    "timeout": 10000,
    "once": true,
    "persistAfterInterrupt": true
  },
  {
    "event": "Stop",
    "type": "command",
    "command": "python hooks/budget-check.py",
    "forcedOutcome": "always-halt",
    "forcedReason": "已达到本日操作上限，停止本轮"
  }
]`

const WORKSPACE_HOOK_FLAT_EXAMPLE = `{
  "event": "PreToolUse",
  "matcher": "write_file|edit_file",
  "type": "command",
  "command": "python .cmbdevclaw/hooks/pre-write-check.py",
  "timeout": 10000,
  "once": true,
  "onBlock": {
    "reason": "检测到高风险写入，请先按整改流程处理",
    "requiredSkill": "workspace-hook-remediation"
  },
  "forcedOutcome": "always-revise",
  "forcedReason": "本工作区禁止直接写入，请先生成 PR 模板"
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
          "once": true,
          "onBlock": {
            "systemMessage": "请先按整改技能修复，再重试",
            "requiredSkill": "workspace-hook-remediation"
          },
          "forcedOutcome": "always-revise",
          "forcedReason": "本工作区禁止直接写入，请先生成 PR 模板"
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

const FIRE_AND_FORGET_EVENTS = new Set<HookEvent>([
  "SessionStart",
  "SessionEnd",
  "Notification",
  "SubagentStop"
])

function getHookOwnerLabel(hook: DisplayHook): string {
  if (hook.source === "plugin") return hook.pluginName
  if (hook.source === "skill") {
    return hook.pluginName ? `${hook.skillName} · ${hook.pluginName}` : hook.skillName
  }
  return "全局"
}

function getMatcherKind(event: HookEvent): string {
  if (event === "PreSkillUse" || event === "PostSkillUse") return "技能"
  if (event === "UserPromptSubmit") return "用户消息"
  if (event === "SessionStart" || event === "SessionEnd") return "会话"
  if (event === "Notification") return "通知"
  if (event === "SubagentStop" || event === "SubagentStart") return "子 Agent"
  if (event === "Stop" || event === "StopFailure") return "收尾"
  return "工具"
}

function getMatcherInfo(hook: DisplayHook): { label: string; detail?: string; mono?: boolean } {
  const kind = getMatcherKind(hook.event)
  if (!hook.matcher || hook.matcher === "*") return { label: `${kind}: 全部` }
  const preset = COMMON_TOOLS.find((tool) => tool.value !== "custom" && tool.value === hook.matcher)
  if (preset) return { label: `${kind}: ${preset.label}`, detail: hook.matcher }
  return { label: `${kind}: ${hook.matcher}`, mono: true }
}

function getHookConfigPath(hook: DisplayHook): string {
  if (hook.source === "plugin" || hook.source === "skill") return hook.hookPath
  return hook.hookSourcePath || "~/.cmbcoworkagent/hooks.json"
}

function getHookExecutionRoot(hook: DisplayHook): string {
  if (hook.source === "plugin") return hook.pluginRoot
  if (hook.source === "skill") return hook.skillPath
  return hook.hookSourceRoot || "~/.cmbcoworkagent"
}

function getForcedOutcomeLabel(hook: DisplayHook): string | null {
  if (hook.forcedOutcome === "always-revise") return "强制修订"
  if (hook.forcedOutcome === "always-halt") return "直接停止"
  return null
}

function getForcedOutcomeDescription(hook: DisplayHook): string {
  if (!hook.forcedOutcome) return "跟随脚本 stdout 返回值。"
  const base =
    hook.forcedOutcome === "always-halt"
      ? "无视脚本 stdout，强制按 continue=false 处理。"
      : "无视脚本 stdout，强制按 decision=block 处理。"
  if (FIRE_AND_FORGET_EVENTS.has(hook.event)) {
    return `${base}该事件是异步 fire-and-forget，只更新执行记录和回调语义，不会阻断主流程。`
  }
  return base
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

  useEffect(() => {
    return window.api.hooks.onChanged(() => {
      void loadHooks()
    })
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
        (h.source === "plugin" && h.pluginName.toLowerCase().includes(q)) ||
        (h.source === "skill" && h.skillName.toLowerCase().includes(q)) ||
        getHookSourceLabel(h.source).includes(q) ||
        (h.type === "prompt" ? "自然语言策略" : "命令").includes(q) ||
        (h.once === true && ("once".includes(q) || "一次性".includes(q)))
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
                title="添加全局 Hook"
                aria-label="添加全局 Hook"
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
                {hooks.length === 0 ? "暂无钩子，点击 + 添加全局 Hook" : "没有匹配的钩子"}
              </p>
            ) : (
              filteredHooks.map((hook) => {
                const badge = EVENT_BADGE[hook.event]
                const isPrompt = hook.type === "prompt"
                const isPluginHook = hook.source === "plugin"
                const summary = hookSummary(hook)
                const matcherInfo = getMatcherInfo(hook)
                const ownerLabel = getHookOwnerLabel(hook)
                const forcedLabel = getForcedOutcomeLabel(hook)
                return (
                  <button
                    key={hook.id}
                    className={cn(
                      "w-full rounded-md border border-border/70 px-2.5 py-2 text-left transition-colors",
                      selectedHook?.id === hook.id ? "bg-muted/70" : "hover:bg-muted/50"
                    )}
                    onClick={() => setSelectedHook(hook)}
                  >
                    <div className="space-y-1.5">
                      <div className="flex items-center gap-1.5">
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
                        <span
                          className={cn(
                            "text-[10px] font-medium px-1.5 py-0.5 rounded-full shrink-0",
                            HOOK_SOURCE_BADGE_CLASS[hook.source]
                          )}
                        >
                          {getHookSourceLabel(hook.source)}
                        </span>
                        <span className="min-w-0 truncate text-xs font-medium text-foreground/90">
                          {ownerLabel}
                        </span>
                        <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                          {hook.enabled
                            ? isPluginHook && !hook.pluginEnabled
                              ? "插件停用"
                              : "启用"
                            : "禁用"}
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                        {isPrompt ? (
                          <BrainCircuit className="size-3 shrink-0 text-violet-500" />
                        ) : (
                          <Terminal className="size-3 shrink-0" />
                        )}
                        <span className="shrink-0">{isPrompt ? "自然语言策略" : "Shell 命令"}</span>
                        <span className="rounded-full border border-border/50 px-1.5 py-0.5">
                          {matcherInfo.label}
                        </span>
                        {forcedLabel && (
                          <span className="rounded-full border border-amber-300/50 bg-amber-50 px-1.5 py-0.5 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
                            {forcedLabel}
                          </span>
                        )}
                        {hook.once && (
                          <span className="rounded-full border border-emerald-300/50 bg-emerald-50 px-1.5 py-0.5 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300">
                            once
                          </span>
                        )}
                        {hook.persistAfterInterrupt && (
                          <span className="rounded-full border border-cyan-300/50 bg-cyan-50 px-1.5 py-0.5 text-cyan-700 dark:border-cyan-500/30 dark:bg-cyan-500/10 dark:text-cyan-300">
                            persist
                          </span>
                        )}
                        {hook.onBlock && (
                          <span className="rounded-full border border-blue-300/50 bg-blue-50 px-1.5 py-0.5 text-blue-700 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-300">
                            onBlock
                          </span>
                        )}
                      </div>
                      <div
                        className={cn(
                          "truncate text-xs",
                          isPrompt ? "italic text-foreground/85" : "font-mono text-foreground/80",
                          !hook.enabled && "text-muted-foreground"
                        )}
                      >
                        {summary || "未配置执行内容"}
                      </div>
                    </div>
                  </button>
                )
              })
            )}
          </div>
        </ScrollArea>
        <HookLoggingControls />
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

/* ── Hook logging controls ─────────────────────────────────────────────
 *
 * Rendered as a compact footer at the bottom of the hook list. Two toggles:
 *
 *   - "启用 Hook 日志"  (default off): when on, each chat turn that fired
 *     hooks gets a small chip below the user message — click for the modal
 *     with per-execution detail. Off by default to keep the chat clean for
 *     users who don't author hooks.
 *
 *   - "诊断模式"        (default off, requires the main toggle): adds
 *     stdin payload, full command/cwd, skipped-hook rows, and persists
 *     everything to a daily jsonl file under the openwork dir.
 *
 * Both flags are settings — they live in hook-logging.json, not per-thread.
 */
function HookLoggingControls(): React.JSX.Element {
  const [config, setConfig] = useState<{ enabled: boolean; diagnostic: boolean }>({
    enabled: false,
    diagnostic: false
  })
  const [logDir, setLogDir] = useState("")
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let cancelled = false
    const unsubscribe = window.api.hooks.logging.onChanged((cfg) => {
      if (!cancelled) setConfig(cfg)
    })
    void Promise.all([window.api.hooks.logging.get(), window.api.hooks.logging.getLogDir()])
      .then(([cfg, dir]) => {
        if (!cancelled) setConfig(cfg)
        if (!cancelled) setLogDir(dir)
      })
      .catch((e) => {
        console.warn("[HooksPanel] failed to load logging config:", e)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  const save = useCallback(
    async (next: Partial<{ enabled: boolean; diagnostic: boolean }>) => {
      try {
        const updated = await window.api.hooks.logging.save(next)
        setConfig(updated)
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "保存失败")
      }
    },
    []
  )

  const openLogDir = useCallback(async () => {
    try {
      const res = await window.api.hooks.logging.openLogDir()
      if (!res.success) toast.error(res.error || "无法打开日志目录")
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "无法打开日志目录")
    }
  }, [])

  if (loading) {
    return <div className="border-t border-border/60 px-3 py-2 text-[11px] text-muted-foreground/60">加载中…</div>
  }

  return (
    <div className="border-t border-border/60 px-3 py-2.5 space-y-2 bg-muted/20">
      <div className="flex items-center justify-between gap-2">
        <label className="flex items-center gap-2 cursor-pointer flex-1 min-w-0">
          <input
            type="checkbox"
            className="size-3.5 shrink-0"
            checked={config.enabled}
            onChange={(e) => void save({ enabled: e.target.checked })}
          />
          <span className="text-xs font-medium">启用 Hook 日志</span>
        </label>
      </div>
      <p className="text-[10px] text-muted-foreground/70 leading-relaxed pl-5">
        每个产生过 hook 执行的消息会出现一个小入口，点开查看本轮的执行记录。
      </p>

      <div className="flex items-center justify-between gap-2 pt-1">
        <label
          className={cn(
            "flex items-center gap-2 flex-1 min-w-0",
            config.enabled ? "cursor-pointer" : "cursor-not-allowed opacity-40"
          )}
        >
          <input
            type="checkbox"
            className="size-3.5 shrink-0"
            checked={config.diagnostic}
            disabled={!config.enabled}
            onChange={(e) => void save({ diagnostic: e.target.checked })}
          />
          <span className="text-xs font-medium">诊断模式</span>
        </label>
      </div>
      <p
        className={cn(
          "text-[10px] leading-relaxed pl-5",
          config.enabled ? "text-muted-foreground/70" : "text-muted-foreground/40"
        )}
      >
        额外展示 stdin payload、完整 command、cwd，以及被 scope 过滤掉的 hook；同时把日志按天落到
        <code className="mx-0.5 font-mono">hooks/log/hooks.&lt;日期&gt;.jsonl</code>（保留 7 天）。
        stdin 可能含敏感用户输入。
      </p>

      {config.enabled && config.diagnostic && (
        <div className="flex flex-col gap-2 pt-1 sm:flex-row sm:items-center">
          {logDir && (
            <code className="min-w-0 flex-1 rounded border border-border/60 bg-background/70 px-2 py-1 font-mono text-[10px] text-muted-foreground break-all">
              {logDir}
            </code>
          )}
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1.5 text-xs justify-center sm:w-auto"
            onClick={() => void openLogDir()}
          >
            <FolderOpen className="size-3.5" />
            打开日志目录
          </Button>
        </div>
      )}
    </div>
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
  const ownerLabel = getHookOwnerLabel(hook)
  const matcherInfo = getMatcherInfo(hook)
  const configPath = getHookConfigPath(hook)
  const executionRoot = getHookExecutionRoot(hook)
  const forcedLabel = getForcedOutcomeLabel(hook)

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
        <div className="grid gap-3 md:grid-cols-2">
          <DetailCard
            label="归属"
            value={ownerLabel}
            subtext={
              isPluginHook
                ? hook.pluginEnabled
                  ? "插件当前已启用"
                  : "插件当前已禁用，此 Hook 不会执行"
                : isSkillHook
                  ? "跟随技能加载；停用技能后会一起移除"
                  : "全局 Hook，可在这里直接编辑和删除"
            }
          />
          <DetailCard
            label="触发"
            value={`${badge.label}（${badge.english}）`}
            subtext={`${matcherInfo.label}${matcherInfo.detail ? ` · ${matcherInfo.detail}` : ""}`}
          />
          <DetailCard
            label="执行目录"
            value={executionRoot}
            mono
            subtext={
              isPrompt
                ? "自然语言策略不启动本地命令；此目录仅用于说明来源"
                : "相对路径命令会基于这里解析"
            }
          />
          <DetailCard label="配置文件" value={configPath} mono />
        </div>

        <div className="grid gap-3 md:grid-cols-5">
          <DetailCard label="状态" value={hook.enabled ? "已启用" : "已禁用"} />
          <DetailCard label="超时" value={`${hook.timeout ?? 10000}ms`} />
          <DetailCard
            label="一次性"
            value={hook.once ? "成功后跳过" : "每次匹配执行"}
            subtext={hook.once ? "同一会话内按事件、来源和 Hook ID 记忆" : undefined}
          />
          <DetailCard
            label="会话持久"
            value={hook.persistAfterInterrupt ? "触发后持续" : "仅当前作用域"}
            subtext={
              hook.persistAfterInterrupt
                ? "所属插件 / 技能触发一次后本会话继续命中"
                : "未触发所属插件 / 技能时不会命中"
            }
          />
          <DetailCard
            label="行为"
            value={forcedLabel ?? "跟随脚本"}
            subtext={hook.onBlock ? "含 onBlock 补充配置" : undefined}
          />
        </div>

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
            <details className="rounded-md border border-border/50 bg-muted/20">
              <summary className="cursor-pointer list-none px-3 py-2.5 [&::-webkit-details-marker]:hidden">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium text-foreground">脚本输入参考</p>
                    <p className="text-xs text-muted-foreground">
                      展开查看 stdin、环境变量和 tool_input 字段。
                    </p>
                  </div>
                  <span className="shrink-0 rounded-full border border-border/50 bg-background px-2 py-0.5 text-[10px] text-muted-foreground">
                    展开
                  </span>
                </div>
              </summary>
              <div className="space-y-4 border-t border-border/40 p-3">
                <div className="space-y-2 rounded-md border border-border/50 bg-muted/30 px-3 py-2">
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
                            {field.note && (
                              <p className="text-xs text-foreground/80">{field.note}</p>
                            )}
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
                            {field.note && (
                              <p className="text-xs text-foreground/80">{field.note}</p>
                            )}
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
                <div className="space-y-2 rounded-md border border-border/50 bg-muted/30 px-3 py-2">
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
              )}
            </details>
            <DetailRow
              label="日志查看"
              value="运行后回到聊天区，展开“Hook 执行记录”；调试日志建议输出到 stderr。stdout 只有输出纯 JSON 时才会被当成 Hook 返回值解析，不要额外包单引号或混入日志。想确认某个事件的原始 payload，也可以先把 payload 整体打印到 stderr。"
            />
          </>
        )}

        {hook.forcedOutcome && (
          <>
            <div className="pt-2 border-t border-border/50">
              <h4 className="text-sm font-medium">强制行为</h4>
            </div>
            <DetailRow
              label="策略"
              value={
                hook.forcedOutcome === "always-halt"
                  ? "always-halt：直接停止"
                  : "always-revise：要求修订"
              }
            />
            {hook.forcedReason && <DetailRow label="原因" value={hook.forcedReason} />}
            <DetailRow label="说明" value={getForcedOutcomeDescription(hook)} />
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

        <DetailRow label="创建时间" value={formatTime(hook.createdAt)} />
        <DetailRow label="更新时间" value={formatTime(hook.updatedAt)} />
      </div>
    </div>
  )
}

function DetailCard(props: {
  label: string
  value: string
  mono?: boolean
  subtext?: string
}): React.JSX.Element {
  return (
    <div className="rounded-md border border-border/50 bg-muted/25 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{props.label}</div>
      <div className={cn("mt-1 text-sm break-all", props.mono && "font-mono")}>{props.value}</div>
      {props.subtext && <p className="mt-1 text-xs text-muted-foreground">{props.subtext}</p>}
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
        summary="Shell 命令 Hook、自然语言策略、全局 / 插件 / 技能 / 工作区四种来源，以及常用扩展字段都在这里。"
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
                需要在插件 / 技能触发后让某条 Hook 本会话持续生效时，可以在对应 Hook 上加
                <code className="mx-1 font-mono text-foreground/85">persistAfterInterrupt: true</code>
                。
              </p>
              <p>
                技能 Hook 可以来自技能目录下的 hooks/hooks.json、根目录 hooks.json，或 SKILL.md YAML
                frontmatter 里的 hooks
                字段，随技能一起加载，启停技能时同步生效；嵌套子技能可以拥有自己的 Hook。
                适合把某项技能的配套拦截或校验逻辑打包进技能本体一起分发。
              </p>
              <p>
                工作区 Hook 适合跟项目一起分发；脚本或策略本体建议放在项目目录里跟代码一起维护。
              </p>
              <p>
                command Hook 的默认执行目录由 Hook 来源决定： 全局 Hook 在
                <code className="mx-1 font-mono text-foreground/85">~/.cmbcoworkagent</code>
                执行，插件 Hook 在插件根目录执行，技能 Hook 在技能目录执行，工作区 Hook 在当前
                workspace 执行。事件里的
                <code className="mx-1 font-mono text-foreground/85">SKILL_ROOT</code>
                只表示本次关联的技能，不会改变非 Skill Hook 的执行目录。
              </p>
            </div>
          </GuideSubSection>

          <GuideSubSection
            title="常用扩展字段"
            summary="这些字段在全局、插件、技能、工作区 Hook 里都可使用；SKILL.md frontmatter 也支持。"
          >
            <div className="space-y-2">
              {HOOK_CONFIG_EXTENSION_FIELDS.map((field) => (
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

          <GuideSubSection
            title="强制行为 forcedOutcome"
            summary='可选值仅两个："always-revise" 或 "always-halt"；不写则跟随 hook 脚本 stdout。'
          >
            <p className="mb-2 text-sm text-muted-foreground">
              <code className="font-mono text-foreground/85">forcedOutcome</code>
              {" 取值："}
              <code className="mx-1 font-mono text-foreground/85">"always-revise"</code>
              （强制走修订流程）/
              <code className="mx-1 font-mono text-foreground/85">"always-halt"</code>
              （强制终止本轮）；省略该字段时跟随 hook stdout 决定。
            </p>
            <div className="space-y-2">
              {FORCED_OUTCOME_FIELDS.map((field) => (
                <div
                  key={field.key}
                  className="rounded-md border border-border/40 bg-background px-3 py-2"
                >
                  <p className="font-mono text-[11px] text-foreground/85">{field.key}</p>
                  <p className="text-sm text-muted-foreground">{field.description}</p>
                </div>
              ))}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              对所有事件生效；与 onBlock 共存（forcedOutcome 决定行为，onBlock 补全字段）。 若 hook
              脚本同时输出 continue=false，仍按 forcedOutcome 配置覆盖。
            </p>
          </GuideSubSection>
        </div>
      </GuideSection>

      <GuideSection
        title="技能 Hook 怎么配"
        summary="可写在技能目录 hooks/hooks.json，也可直接写进 SKILL.md YAML frontmatter；父技能和嵌套子技能都支持。"
      >
        <div className="space-y-3">
          <GuideSubSection
            title="加载规则"
            summary="启用技能时自动加载该技能目录里的 hooks；停用技能时同步移除。"
          >
            <div className="space-y-2 text-sm text-muted-foreground">
              <p>
                在技能目录里新建
                <code className="mx-1 font-mono text-foreground/85">hooks/hooks.json</code>
                即可；根目录
                <code className="mx-1 font-mono text-foreground/85">hooks.json</code>
                仍兼容旧包；也可以直接写在
                <code className="mx-1 font-mono text-foreground/85">SKILL.md</code>
                顶部 YAML frontmatter 的
                <code className="mx-1 font-mono text-foreground/85">hooks</code>
                字段里。如果是嵌套子技能，就放在子技能自己的目录里。
              </p>
              <pre className="rounded-md border border-border/40 bg-background p-2 text-xs leading-5">
                {`~/.cmbcoworkagent/skills/office/\n  SKILL.md\n  hooks/\n    hooks.json\n    pre-write-check.py\n  pdf/\n    SKILL.md\n    hooks/\n      hooks.json      ← 子技能自己的 Hook\n      pre-write-check.py`}
              </pre>
              <p>
                Skill Hook 命令默认在技能所在目录作为
                <code className="mx-1 font-mono text-foreground/85">cwd</code>
                执行；脚本放在技能目录时，可以在
                <code className="mx-1 font-mono text-foreground/85">command</code>
                里直接写相对路径，也可以通过
                <code className="mx-1 font-mono text-foreground/85">HOOK_SOURCE_ROOT</code>或
                <code className="mx-1 font-mono text-foreground/85">SKILL_ROOT</code>
                环境变量定位。
              </p>
              <p>
                hooks/hooks.json 里写
                <code className="mx-1 font-mono text-foreground/85">{`"enabled": false`}</code>
                可关闭单条规则；在应用里停用技能则整批移除。
              </p>
              <p>
                如果 Hook 写在 SKILL.md frontmatter 里，配置来源会显示为 SKILL.md；command
                仍默认在技能目录执行，和 hooks/hooks.json 保持一致。
              </p>
            </div>
          </GuideSubSection>

          <GuideSubSection
            title="支持格式"
            summary="扁平数组（推荐）、Claude Code hooks settings、带 hooks 包裹层，以及 SKILL.md frontmatter 都支持。"
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
              <p>
                SKILL.md frontmatter 的 hooks 字段使用 YAML，内部结构与 Claude Code hooks settings
                一致，并额外支持
                <code className="mx-1 font-mono text-foreground/85">once</code>、
                <code className="mx-1 font-mono text-foreground/85">persistAfterInterrupt</code>、
                <code className="mx-1 font-mono text-foreground/85">timeoutMs</code>、
                <code className="mx-1 font-mono text-foreground/85">forcedOutcome</code>、
                <code className="mx-1 font-mono text-foreground/85">forcedReason</code>、
                <code className="mx-1 font-mono text-foreground/85">onBlock</code>和
                <code className="mx-1 font-mono text-foreground/85">modelId</code>。
              </p>
              <p>
                对 PreSkillUse / PostSkillUse，如果 frontmatter 里的 matcher
                省略，默认匹配当前技能名；只选中子技能时，只会激活子技能自己的 Hook。
              </p>
            </div>
          </GuideSubSection>

          <GuideSubSection
            title="最小示例：SKILL.md frontmatter"
            summary="适合把技能说明和配套 Hook 放在同一个 SKILL.md 里；YAML 字段无需加引号。"
          >
            <pre className="overflow-x-auto rounded-md border border-border/40 bg-background p-3 text-xs leading-5 text-foreground">
              <code>{SKILL_HOOK_FRONTMATTER_EXAMPLE}</code>
            </pre>
          </GuideSubSection>

          <GuideSubSection
            title="最小示例：扁平数组（推荐）"
            summary="一个文件放多条规则；command 可直接使用相对于技能目录的路径。"
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
              <p>
                在<code className="mx-1 font-mono text-foreground/85">插件</code>
                页面启用或停用插件，对应的 Hook 随之生效或移除。 command
                默认在插件根目录执行，可通过
                <code className="mx-1 font-mono text-foreground/85">HOOK_SOURCE_ROOT</code>或
                <code className="mx-1 font-mono text-foreground/85">PLUGIN_ROOT</code>
                定位插件内脚本。
              </p>
              <p>
                插件内的
                <code className="mx-1 font-mono text-foreground/85">
                  skills/&lt;skill&gt;/SKILL.md
                </code>
                也可以使用 frontmatter hooks；这类 Hook 仍按技能 Hook
                处理，默认执行目录是该技能目录，同时会携带插件来源信息。
              </p>
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
                ；也可以读取
                <code className="mx-1 font-mono text-foreground/85">HOOK_SOURCE_ROOT</code>或
                <code className="mx-1 font-mono text-foreground/85">WORKSPACE_PATH</code>
                获取这个路径。
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
                也支持
                <code className="mx-1 font-mono text-foreground/85">once</code>、
                <code className="mx-1 font-mono text-foreground/85">persistAfterInterrupt</code>、
                <code className="mx-1 font-mono text-foreground/85">timeoutMs</code>、
                <code className="mx-1 font-mono text-foreground/85">forcedOutcome</code>和
                <code className="mx-1 font-mono text-foreground/85">forcedReason</code>；如果使用
                Claude Code 多 Hook 格式，
                <code className="mx-1 font-mono text-foreground/85">timeout</code>
                按秒解释。
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
          <p>
            stdout 必须输出纯 JSON 才会被当成 Hook 返回值解析；不要额外包单引号、markdown
            或混入调试日志。调试日志请尽量写到 stderr。
          </p>
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
