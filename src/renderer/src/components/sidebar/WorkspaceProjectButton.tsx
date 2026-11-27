import { useEffect, useId, useRef, useState } from "react"
import { Arrow } from "@radix-ui/react-popover"
import { ArrowRight, Tag } from "lucide-react"
import type { ChatProject } from "../../../../shared/chat-project"
import { Button } from "@/components/ui/button"
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover"
import { cn } from "@/lib/utils"

const guide = { guideId: "workspace-project-binding", revision: 1, maxShowCount: 1 }

export function WorkspaceProjectButton({
  project,
  guideEligible,
  onEdit
}: {
  project: ChatProject | null
  guideEligible: boolean
  onEdit: () => void
}) {
  const anchor = useRef<HTMLButtonElement>(null)
  const descriptionId = useId()
  const [open, setOpen] = useState(false)
  useEffect(() => {
    setOpen(false)
    const button = anchor.current
    if (!guideEligible || !button) return
    let active = true
    async function offer() {
      if (document.visibilityState !== "visible" || !button) return
      document.removeEventListener("visibilitychange", offer)
      try {
        const state = await window.api.uiGuides.getState(guide)
        if (!active || !state.shouldShow) return
        button.scrollIntoView({ block: "nearest", inline: "nearest" })
        if (await window.api.uiGuides.recordDisplay(guide)) {
          if (active) setOpen(true)
        }
      } catch (error) {
        console.warn("[UiGuide] Workspace project hint:", error)
      }
    }
    document.addEventListener("visibilitychange", offer)
    void offer()
    return () => {
      active = false
      document.removeEventListener("visibilitychange", offer)
    }
  }, [guideEligible])

  function dismiss() {
    if (!open) return
    setOpen(false)
    void window.api.uiGuides
      .acknowledge(guide)
      .catch((error) => console.warn("[UiGuide] Workspace project hint:", error))
  }
  function edit() {
    dismiss()
    onEdit()
  }
  return (
    <Popover
      open={guideEligible && open}
      onOpenChange={(next) => {
        if (!next) dismiss()
      }}
    >
      <PopoverAnchor asChild>
        <button
          ref={anchor}
          type="button"
          aria-haspopup="dialog"
          aria-describedby={guideEligible && open ? descriptionId : undefined}
          aria-label={project ? `更改工作区项目 ${project.code}` : "关联工作区项目"}
          title={
            project
              ? ["更改工作区项目", project.code, project.name].filter(Boolean).join(" · ")
              : "关联项目，新会话将自动继承"
          }
          onClick={(event) => {
            event.stopPropagation()
            edit()
          }}
          className={cn(
            "inline-flex h-6 shrink-0 cursor-pointer items-center justify-center rounded-md border hover:bg-background-interactive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            project
              ? "max-w-20 border-primary/20 bg-primary/5 px-1.5 font-mono text-[10px] text-primary"
              : "w-6 border-dashed border-muted-foreground/50 text-muted-foreground hover:border-primary hover:text-primary",
            open &&
              "border-primary bg-primary/10 text-primary ring-2 ring-primary/20 ring-offset-2 ring-offset-background"
          )}
        >
          {project ? (
            <span className="truncate">{project.code}</span>
          ) : (
            <Tag aria-hidden="true" className="size-3" />
          )}
        </button>
      </PopoverAnchor>
      <PopoverContent
        side="right"
        align="center"
        sideOffset={12}
        collisionPadding={10}
        hideWhenDetached
        aria-label="工作区项目指引"
        className="w-[17rem] max-w-[calc(100vw-1.5rem)] rounded-xl border-border bg-popover p-4 shadow-lg"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <Arrow className="fill-popover" />
        <div className="flex items-center gap-2.5">
          <span className="grid size-8 place-items-center rounded-lg bg-primary/10 text-primary">
            <Tag aria-hidden="true" className="size-4" />
          </span>
          <p className="text-sm font-semibold text-foreground">关联精益项目</p>
        </div>
        <p id={descriptionId} className="mt-2.5 text-xs leading-5 text-muted-foreground">
          把对话模式的代码采纳计入精益项目。
        </p>
        <div className="mt-3 flex justify-end gap-1.5">
          <Button
            size="sm"
            variant="ghost"
            className="text-muted-foreground hover:text-foreground"
            onClick={() => {
              dismiss()
              anchor.current?.focus()
            }}
          >
            知道了
          </Button>
          <Button size="sm" onClick={edit}>
            去关联 <ArrowRight aria-hidden="true" className="size-3.5" />
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
