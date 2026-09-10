import { useCallback, useEffect, useState, useRef } from "react"
import { Clock, Info, Play, Square, Loader2, Pencil, Plus, Trash2, Sun } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { ToggleThumb } from "@/components/ui/toggle-thumb"
import { cn } from "@/lib/utils"
import type { ScheduledTask } from "@/types"
import { CreateScheduledTaskDialog } from "./CreateScheduledTaskDialog"

const FREQUENCY_LABELS: Record<string, string> = {
  manual: "手动",
  hourly: "每小时",
  daily: "每天",
  weekdays: "工作日",
  weekly: "每周"
}

const WEEKDAY_LABELS: Record<number, string> = {
  0: "星期日",
  1: "星期一",
  2: "星期二",
  3: "星期三",
  4: "星期四",
  5: "星期五",
  6: "星期六"
}

function formatSchedule(task: {
  frequency: string
  runAtTime?: string | null
  weekday?: number | null
}): string {
  const freq = FREQUENCY_LABELS[task.frequency] ?? task.frequency
  if (task.frequency === "manual" || task.frequency === "hourly") return freq
  const time = task.runAtTime ?? "09:00"
  if (task.frequency === "weekly" && task.weekday != null) {
    return `${freq} · ${WEEKDAY_LABELS[task.weekday]} ${time}`
  }
  return `${freq} · ${time}`
}

function formatDate(iso: string | null): string {
  if (!iso) return "-"
  const d = new Date(iso)
  return d.toLocaleString()
}

function resolveModelName(modelId: string | null, modelMap: Map<string, string>): string {
  if (!modelId) return "-"
  return modelMap.get(modelId) ?? modelId
}

export function ScheduledPanel(): React.JSX.Element {
  const [tasks, setTasks] = useState<ScheduledTask[]>([])
  const [selectedTask, setSelectedTask] = useState<ScheduledTask | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editTask, setEditTask] = useState<ScheduledTask | null>(null)
  const [runningIds, setRunningIds] = useState<Set<string>>(new Set())
  const [modelMap, setModelMap] = useState<Map<string, string>>(new Map())
  const [keepAwake, setKeepAwake] = useState(false)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  useEffect(() => {
    window.api.keepAwake.get().then((v) => {
      if (mountedRef.current) setKeepAwake(v)
    }).catch(console.error)
  }, [])

  const handleKeepAwakeToggle = useCallback(async () => {
    const next = !keepAwake
    setKeepAwake(next)
    try {
      await window.api.keepAwake.set(next)
    } catch (e) {
      console.error(e)
      setKeepAwake(!next)
    }
  }, [keepAwake])

  useEffect(() => {
    window.api.models.list().then((configs) => {
      const map = new Map<string, string>()
      for (const c of configs) {
        map.set(c.id, c.name)
      }
      if (mountedRef.current) setModelMap(map)
    }).catch(console.error)
  }, [])

  const loadTasks = useCallback(async () => {
    try {
      const updated = await window.api.scheduledTasks.list()
      if (!mountedRef.current) return
      setTasks(updated)
      setSelectedTask((prev) => {
        if (!prev) return null
        return updated.find((t) => t.id === prev.id) ?? null
      })
      // Sync running state from backend
      const running = new Set<string>()
      await Promise.all(
        updated.map(async (t) => {
          if (await window.api.scheduledTasks.isRunning(t.id)) {
            running.add(t.id)
          }
        })
      )
      if (mountedRef.current) setRunningIds(running)
    } catch (e) {
      console.error(e)
    }
  }, [])

  useEffect(() => {
    loadTasks()
  }, [loadTasks])

  useEffect(() => {
    return window.api.scheduledTasks.onChanged(() => {
      loadTasks()
    })
  }, [loadTasks])

  const handleDelete = useCallback(async (task: ScheduledTask) => {
    if (!confirm(`确定要删除定时任务「${task.name}」吗？此操作不可撤销。`)) return
    try {
      await window.api.scheduledTasks.delete(task.id)
      setSelectedTask((prev) => (prev?.id === task.id ? null : prev))
      await loadTasks()
    } catch (e) {
      console.error(e)
    }
  }, [loadTasks])

  const handleToggleEnabled = useCallback(async (id: string, enabled: boolean) => {
    try {
      await window.api.scheduledTasks.setEnabled(id, enabled)
      await loadTasks()
    } catch (e) {
      console.error(e)
    }
  }, [loadTasks])

  const handleRunNow = useCallback(async (id: string) => {
    setRunningIds((prev) => new Set(prev).add(id))
    try {
      await window.api.scheduledTasks.runNow(id)
    } catch (e) {
      console.error(e)
      if (mountedRef.current) {
        setRunningIds((prev) => {
          const next = new Set(prev)
          next.delete(id)
          return next
        })
      }
    }
  }, [])

  const handleCancel = useCallback(async (id: string) => {
    try {
      await window.api.scheduledTasks.cancel(id)
    } catch (e) {
      console.error(e)
    }
  }, [])

  const isRunning = (id: string): boolean => runningIds.has(id)

  return (
    <div className="flex flex-1 overflow-hidden isolate">
      <div className="w-[330px] shrink-0 border-r border-border flex flex-col">
        <div className="p-3 border-b border-border space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-base font-bold">定时任务</h2>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0 shrink-0"
              onClick={() => {
                setEditTask(null)
                setDialogOpen(true)
              }}
            >
              <Plus className="size-4" />
            </Button>
          </div>
          <div className="flex items-center gap-1.5 px-2 py-1.5 rounded-md bg-muted/50 text-xs text-muted-foreground">
            <Info className="size-3.5 shrink-0" />
            <span className="flex-1">定时任务仅在电脑唤醒状态下运行</span>
            <div className="relative group shrink-0">
              <button
                className="flex items-center gap-1.5 cursor-pointer"
                onClick={handleKeepAwakeToggle}
              >
                <Sun className={cn("size-3.5", keepAwake ? "text-amber-500" : "text-muted-foreground/60")} />
                <span className={cn("text-[11px] whitespace-nowrap", keepAwake ? "text-amber-600" : "text-muted-foreground/60")}>保持唤醒</span>
                <div className={cn(
                  "relative w-7 h-4 rounded-full transition-colors",
                  keepAwake ? "bg-amber-500" : "bg-muted-foreground/25"
                )}>
                  <ToggleThumb className={cn(
                    "absolute left-0 top-0.5 size-3",
                    keepAwake ? "translate-x-3.5" : "translate-x-0.5"
                  )} />
                </div>
              </button>
              <div className="absolute right-0 top-full mt-2 px-3 py-2 rounded-lg bg-popover text-popover-foreground text-[11px] leading-relaxed shadow-lg border border-border whitespace-nowrap opacity-0 pointer-events-none group-hover:opacity-100 transition-opacity z-50">
                {keepAwake ? "当前已阻止电脑自动休眠，点击关闭" : "开启后，应用将阻止电脑自动休眠"}
              </div>
            </div>
          </div>
        </div>
        <ScrollArea className="flex-1">
          <div className="p-2 space-y-2">
            {tasks.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                <Clock className="size-8 opacity-40 mb-2" />
                <p className="text-xs">暂无定时任务</p>
              </div>
            ) : (
              tasks.map((task) => (
                <button
                  key={task.id}
                  className={cn(
                    "w-full flex items-center gap-2 px-2 py-1.5 rounded-md border border-border/70 text-left transition-colors",
                    selectedTask?.id === task.id ? "bg-muted/70" : "hover:bg-muted/50"
                  )}
                  onClick={() => setSelectedTask(task)}
                >
                  {isRunning(task.id) ? (
                    <Loader2 className="size-3.5 shrink-0 text-primary animate-spin" />
                  ) : (
                    <Clock className={cn("size-3.5 shrink-0", task.enabled ? "text-primary" : "text-muted-foreground")} />
                  )}
                  <div className="flex-1 min-w-0">
                    <span className={cn("text-sm truncate block", !task.enabled && "text-muted-foreground")}>
                      {task.name}
                    </span>
                    <span className="text-[10px] text-muted-foreground">
                      {isRunning(task.id)
                        ? "运行中..."
                        : <>
                            {FREQUENCY_LABELS[task.frequency] ?? task.frequency}
                            {task.lastRunStatus === "ok" && " · 上次: 成功"}
                            {task.lastRunStatus === "error" && " · 上次: 失败"}
                          </>
                      }
                    </span>
                  </div>
                </button>
              ))
            )}
          </div>
        </ScrollArea>
      </div>

      {selectedTask ? (
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="p-4 border-b border-border flex items-center justify-between">
            <div>
              <h3 className="text-sm font-bold">{selectedTask.name}</h3>
              <p className="text-xs text-muted-foreground mt-0.5">{selectedTask.description}</p>
            </div>
            <div className="flex items-center gap-1">
              {isRunning(selectedTask.id) ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => handleCancel(selectedTask.id)}
                >
                  <Square className="size-3 mr-1" />
                  停止
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => handleRunNow(selectedTask.id)}
                >
                  <Play className="size-3 mr-1" />
                  立即运行
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0"
                onClick={() => {
                  setEditTask(selectedTask)
                  setDialogOpen(true)
                }}
              >
                <Pencil className="size-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0 text-red-500 hover:text-red-600"
                onClick={() => handleDelete(selectedTask)}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          </div>
          <ScrollArea className="flex-1">
            <div className="p-4 space-y-4">
              <div>
                <label className="text-xs font-medium text-muted-foreground">提示词</label>
                <p className="mt-1 text-sm whitespace-pre-wrap bg-muted/30 rounded-md p-2">
                  {selectedTask.prompt}
                </p>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-xs font-medium text-muted-foreground">模型</label>
                  <p className="mt-1 text-sm">{resolveModelName(selectedTask.modelId, modelMap)}</p>
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">执行频率</label>
                  <p className="mt-1 text-sm">{formatSchedule(selectedTask)}</p>
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">工作目录</label>
                  <p className="mt-1 text-sm truncate" title={selectedTask.workDir ?? undefined}>
                    {selectedTask.workDir ?? "-"}
                  </p>
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">启用状态</label>
                  <div className="mt-1">
                    <button
                      className={cn(
                        "text-xs px-2 py-0.5 rounded-full border",
                        selectedTask.enabled
                          ? "bg-green-500/10 border-green-500/30 text-green-500"
                          : "bg-muted border-border text-muted-foreground"
                      )}
                      onClick={() => handleToggleEnabled(selectedTask.id, !selectedTask.enabled)}
                    >
                      {selectedTask.enabled ? "已启用" : "已禁用"}
                    </button>
                  </div>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4 border-t border-border pt-4">
                <div>
                  <label className="text-xs font-medium text-muted-foreground">上次运行</label>
                  <p className="mt-1 text-sm">{formatDate(selectedTask.lastRunAt)}</p>
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">上次状态</label>
                  <p className={cn(
                    "mt-1 text-sm",
                    selectedTask.lastRunStatus === "ok" && "text-green-500",
                    selectedTask.lastRunStatus === "error" && "text-red-500"
                  )}>
                    {isRunning(selectedTask.id) ? "运行中..." : (selectedTask.lastRunStatus ?? "-")}
                  </p>
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">下次运行</label>
                  <p className="mt-1 text-sm">{formatDate(selectedTask.nextRunAt)}</p>
                </div>
                {selectedTask.lastRunError && (
                  <div className="col-span-2">
                    <label className="text-xs font-medium text-muted-foreground">错误信息</label>
                    <p className="mt-1 text-xs text-red-500 bg-red-500/5 rounded-md p-2">
                      {selectedTask.lastRunError}
                    </p>
                  </div>
                )}
              </div>
            </div>
          </ScrollArea>
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center overflow-y-auto p-8">
          <div className="max-w-md space-y-6">
            <div className="text-center space-y-3">
              <div className="size-14 rounded-2xl bg-muted/60 flex items-center justify-center mx-auto">
                <Clock className="size-7 text-muted-foreground/60" />
              </div>
              <h3 className="text-lg font-semibold text-foreground/80">Scheduled 定时任务</h3>
              <p className="text-sm text-muted-foreground leading-relaxed">
                定时任务让 AI 在指定时间自动执行操作。你只需写好提示词指令，选择执行频率，AI
                就会在后台按时运行，完成后通过系统通知告知你结果。
              </p>
            </div>

            <div className="space-y-3">
              <div className="rounded-xl border border-border/60 bg-muted/30 p-4 space-y-3">
                <p className="text-sm font-medium text-foreground/70">支持的执行频率</p>
                <p className="text-[13px] text-muted-foreground leading-relaxed">
                  <span className="font-medium text-foreground/60">手动</span>
                  ：不自动执行，仅通过「立即运行」按钮手动触发。
                  <br />
                  <span className="font-medium text-foreground/60">每小时</span>
                  ：每小时自动执行一次。
                  <br />
                  <span className="font-medium text-foreground/60">每天 / 工作日 / 每周</span>
                  ：在指定时间点执行，「每周」还可选择具体是周几。适合日报生成、数据检查、定期提醒等周期性工作。
                </p>
              </div>

              <div className="rounded-xl border border-border/60 bg-muted/30 p-4 space-y-3">
                <p className="text-sm font-medium text-foreground/70">如何创建？</p>
                <ul className="text-[13px] text-muted-foreground space-y-2 leading-relaxed">
                  <li className="flex gap-2">
                    <span className="text-foreground/40 shrink-0">1.</span>点击{" "}
                    <span className="font-medium text-foreground/60">+</span>{" "}
                    按钮，填写任务名称和描述
                  </li>
                  <li className="flex gap-2">
                    <span className="text-foreground/40 shrink-0">2.</span>编写 AI
                    要执行的提示词指令，选择使用的模型和工作目录
                  </li>
                  <li className="flex gap-2">
                    <span className="text-foreground/40 shrink-0">3.</span>
                    选择执行频率和时间，保存即可
                  </li>
                  <li className="flex gap-2">
                    <span className="text-foreground/40 shrink-0">4.</span>你也可以在对话中直接让 AI
                    帮你创建定时任务
                  </li>
                </ul>
              </div>

              <div className="rounded-xl border border-border/60 bg-muted/30 p-4 space-y-3">
                <p className="text-sm font-medium text-foreground/70">注意事项</p>
                <p className="text-[13px] text-muted-foreground leading-relaxed">
                  定时任务仅在电脑唤醒且应用运行时执行。任务运行期间可以随时点击「停止」中断。你可以在左侧列表中查看每个任务的上次执行状态和下次执行时间，也可以随时编辑或删除任务。
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      <CreateScheduledTaskDialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open)
          if (!open) setEditTask(null)
        }}
        onSuccess={loadTasks}
        editTask={editTask}
        existingNames={tasks.map((t) => t.name)}
      />
    </div>
  )
}
