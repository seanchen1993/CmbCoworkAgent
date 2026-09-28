import { useId } from "react"
import { Info } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

export function ProjectWorkspaceField({
  workspacePath,
  projectDir,
  readOnly = false,
  error,
  onPickWorkspace,
  onProjectDirChange
}: {
  workspacePath: string
  projectDir: string
  readOnly?: boolean
  error: string | null
  onPickWorkspace?: () => void
  onProjectDirChange?: (value: string) => void
}): React.JSX.Element {
  const id = useId()
  const fieldClassName =
    "min-w-0 max-w-[calc((100%-1.5rem)/2)] shrink-0 truncate text-foreground placeholder:text-muted-foreground/45 focus:text-clip"

  return (
    <div className="mt-3 grid min-w-0 gap-1.5 text-xs font-medium text-muted-foreground">
      <div className="flex items-center gap-1">
        <label htmlFor={id}>插件工作目录 *</label>
        <TooltipProvider delayDuration={150}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="插件工作目录说明"
                className="inline-flex size-4 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Info className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="z-[70] max-w-72">
              插件工作区，存放 spec.md、plan.md，非代码/会话路径
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
      <div className="flex min-w-0 items-center gap-2">
        <Input
          value={workspacePath}
          readOnly
          onClick={readOnly ? undefined : onPickWorkspace}
          onKeyDown={(event) => {
            if (!readOnly && (event.key === "Enter" || event.key === " ")) {
              event.preventDefault()
              onPickWorkspace?.()
            }
          }}
          onBlur={(event) => {
            event.currentTarget.scrollLeft = 0
          }}
          aria-label="插件工作区根目录"
          title={workspacePath || "请选择保存位置"}
          placeholder="插件工作区路径"
          className={cn(
            fieldClassName,
            workspacePath ? "w-auto [field-sizing:content]" : "w-44",
            readOnly ? "bg-muted text-muted-foreground" : "cursor-pointer"
          )}
        />
        <span className="w-2 shrink-0 text-center" aria-hidden="true">
          {workspacePath.includes("\\") ? "\\" : "/"}
        </span>
        <Input
          id={id}
          value={projectDir}
          readOnly={readOnly}
          onChange={(event) => onProjectDirChange?.(event.target.value)}
          onBlur={(event) => {
            event.currentTarget.scrollLeft = 0
          }}
          aria-label="本项目产物文件夹"
          title={projectDir || "本项目产物文件夹"}
          placeholder="本项目产物文件夹"
          className={cn(
            fieldClassName,
            projectDir ? "w-auto [field-sizing:content]" : "w-44",
            readOnly && "bg-muted text-muted-foreground",
            error && "border-status-critical"
          )}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
        />
      </div>
      {error && (
        <span id={`${id}-error`} className="text-status-critical">
          {error}
        </span>
      )}
    </div>
  )
}
