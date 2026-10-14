import { useImperativeHandle, useLayoutEffect, useRef, useState } from "react"
import { BookOpen, X } from "lucide-react"
import { SparksTourExamples } from "./SparksTourExamples"
import { simpleTourTasks } from "./simple-tour-tasks"
import type { SimpleAuthoringPracticeIntent } from "@/lib/simple-authoring-intent"

type Destination = "assistant" | "mods" | "claw" | "flows" | "evaluation"
export interface SparksTourHandle {
  dismiss(): void
}
const STORAGE_KEY = "devclaw.sparks-tour.v1"
let dismissedInMemory = false
function hasSeenTour(): boolean {
  if (dismissedInMemory) return true
  try {
    return localStorage.getItem(STORAGE_KEY) === "seen"
  } catch {
    return false
  }
}

export function SparksTour({
  ref,
  visible,
  activePage,
  activeSection,
  onOpenChange,
  onNavigate,
  onPractice
}: {
  ref?: React.Ref<SparksTourHandle>
  visible: boolean
  activePage?: string
  activeSection?: "examples" | "create" | "installed"
  onOpenChange?(open: boolean): void
  onNavigate(page: Destination, section?: "examples" | "create"): void
  onPractice?(task: SimpleAuthoringPracticeIntent["task"], suggestedName?: string): void
}) {
  const [open, setOpen] = useState(() => !hasSeenTour())
  const [task, setTask] = useState(0)
  const region = useRef<HTMLElement>(null)
  const reopenButton = useRef<HTMLButtonElement>(null)
  const wasOpen = useRef(false)
  useLayoutEffect(() => {
    const showing = open && visible
    onOpenChange?.(showing)
    if (showing && !wasOpen.current) region.current?.focus({ preventScroll: true })
    if (!showing && wasOpen.current && visible) reopenButton.current?.focus({ preventScroll: true })
    wasOpen.current = showing
  }, [open, visible, onOpenChange])
  useLayoutEffect(() => {
    if (region.current) region.current.scrollTop = 0
  }, [task, open, visible])
  const dismiss = () => {
    dismissedInMemory = true
    try {
      localStorage.setItem(STORAGE_KEY, "seen")
    } catch {
      /* Storage cannot block closing. */
    }
    setOpen(false)
  }
  useImperativeHandle(ref, () => ({ dismiss }))
  if (!visible) return null
  if (!open)
    return (
      <div className="flex shrink-0 flex-wrap justify-end gap-2 border-b px-4 py-2">
        <button
          ref={reopenButton}
          type="button"
          className="rounded px-2 py-1 text-xs text-primary"
          onClick={() => {
            setTask(
              activePage === "claw" || activePage === "flows"
                ? 1
                : activeSection === "create"
                  ? 0
                  : 2
            )
            setOpen(true)
          }}
        >
          看看这页怎么用
        </button>
        <button
          type="button"
          className="inline-flex items-center gap-2 rounded px-2 py-1 text-xs text-muted-foreground"
          onClick={() => {
            setTask(0)
            setOpen(true)
          }}
        >
          <BookOpen className="size-3.5" aria-hidden="true" />
          新功能导览
        </button>
      </div>
    )
  return (
    <section
      ref={region}
      tabIndex={-1}
      aria-label="新功能导览"
      data-sparks-tour-open
      className="absolute inset-0 z-20 overflow-y-auto bg-background px-4 py-4 sm:px-6"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault()
          event.stopPropagation()
          dismiss()
        }
      }}
    >
      <div className="mx-auto max-w-2xl">
        <div className="flex items-start justify-between gap-3">
          <h2 className="font-semibold">先选一件想做的事，跟着示例看一遍</h2>
          <button
            type="button"
            aria-label="跳过导览"
            className="rounded p-1.5 hover:bg-muted"
            onClick={dismiss}
          >
            <X className="size-4" />
          </button>
        </div>
        <label className="mt-3 grid gap-1 text-xs text-muted-foreground">
          选择任务
          <select
            aria-label="选择任务"
            className="w-full rounded-lg border bg-background p-2 text-foreground"
            value={task}
            onChange={(event) => setTask(Number(event.target.value))}
          >
            {simpleTourTasks.map((item, index) => (
              <option key={item.task} value={index}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <SparksTourExamples
          key={task}
          chapter={task}
          onPractice={(selected, suggestedName) => {
            const selectedTask = selected ?? simpleTourTasks[task].task
            if (onPractice) onPractice(selectedTask, suggestedName)
            else
              onNavigate(
                selectedTask === "create"
                  ? "mods"
                  : selectedTask === "combine"
                    ? "claw"
                    : "assistant",
                selectedTask === "create" ? "create" : undefined
              )
            dismiss()
          }}
        />
        <button
          type="button"
          className="mt-4 rounded px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted"
          onClick={dismiss}
        >
          关闭导览，自己操作
        </button>
      </div>
    </section>
  )
}
