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
import type { HookConfig, HookEvent, HookUpsert } from "@/types"

const HOOK_EVENTS: { value: HookEvent; label: string; description: string }[] = [
  { value: "PreToolUse", label: "工具调用前", description: "在工具执行前触发，脚本 exit!=0 可阻止工具执行，stdout 作为反馈返回给 Agent" },
  { value: "PostToolUse", label: "工具调用后", description: "在工具执行后触发，可用于日志记录、结果校验或后处理" },
  { value: "Stop", label: "Agent 停止时", description: "Agent 完成任务停止时触发，可用于清理临时文件或发送通知" },
  { value: "Notification", label: "通知事件", description: "通知事件触发，可用于自定义提醒或消息推送" }
]

export function AddHookDialog(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess: () => void
  editHook?: HookConfig | null
}): React.JSX.Element {
  const { open, onOpenChange, onSuccess, editHook } = props
  const [event, setEvent] = useState<HookEvent>(editHook?.event ?? "PreToolUse")
  const [matcher, setMatcher] = useState(editHook?.matcher ?? "")
  const [command, setCommand] = useState(editHook?.command ?? "")
  const [timeout, setTimeout_] = useState(String(editHook?.timeout ?? 10000))
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open && editHook) {
      setEvent(editHook.event)
      setMatcher(editHook.matcher ?? "")
      setCommand(editHook.command)
      setTimeout_(String(editHook.timeout ?? 10000))
    } else if (open && !editHook) {
      setEvent("PreToolUse")
      setMatcher("")
      setCommand("")
      setTimeout_("10000")
    }
  }, [open, editHook])

  const resetForm = useCallback(() => {
    if (editHook) {
      setEvent(editHook.event)
      setMatcher(editHook.matcher ?? "")
      setCommand(editHook.command)
      setTimeout_(String(editHook.timeout ?? 10000))
    } else {
      setEvent("PreToolUse")
      setMatcher("")
      setCommand("")
      setTimeout_("10000")
    }
    setError(null)
  }, [editHook])

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) resetForm()
      onOpenChange(next)
    },
    [onOpenChange, resetForm]
  )

  const showMatcher = event === "PreToolUse" || event === "PostToolUse"

  const handleSubmit = useCallback(async () => {
    const trimmedCommand = command.trim()
    if (!trimmedCommand) {
      setError("请输入命令")
      return
    }

    setError(null)
    setSubmitting(true)
    try {
      const config: HookUpsert = {
        event,
        command: trimmedCommand,
        timeout: Math.min(60000, Math.max(1000, parseInt(timeout, 10) || 10000)),
        enabled: editHook ? editHook.enabled : true
      }
      if (showMatcher && matcher.trim()) {
        config.matcher = matcher.trim()
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
  }, [event, matcher, command, timeout, editHook, onSuccess, handleOpenChange, showMatcher])

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{editHook ? "编辑 Hook" : "添加 Hook"}</DialogTitle>
          <DialogDescription>
            配置在特定事件发生时自动执行的 Shell 命令。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <label htmlFor="hook-event" className="text-sm font-medium">事件类型</label>
            <select
              id="hook-event"
              value={event}
              onChange={(e) => setEvent(e.target.value as HookEvent)}
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
            >
              {HOOK_EVENTS.map((ev) => (
                <option key={ev.value} value={ev.value}>
                  {ev.label}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">
              {HOOK_EVENTS.find((ev) => ev.value === event)?.description}
            </p>
          </div>

          {showMatcher && (
            <div className="space-y-2">
              <label htmlFor="hook-matcher" className="text-sm font-medium">工具匹配（可选）</label>
              <Input
                id="hook-matcher"
                placeholder="execute, write_file, * 或留空匹配所有"
                value={matcher}
                onChange={(e) => setMatcher(e.target.value)}
                className="h-9"
              />
              <p className="text-xs text-muted-foreground">
                指定要匹配的工具名称，留空则匹配所有工具调用
              </p>
            </div>
          )}

          <div className="space-y-2">
            <label htmlFor="hook-command" className="text-sm font-medium">命令</label>
            <Input
              id="hook-command"
              placeholder='echo "hello" 或 exit 1'
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              className="h-9"
            />
          </div>

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
              命令执行超时时间，范围 1000–60000ms，默认 10000ms
            </p>
          </div>
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={submitting}>
            取消
          </Button>
          <Button onClick={handleSubmit} disabled={submitting}>
            {editHook ? "保存" : "添加"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
