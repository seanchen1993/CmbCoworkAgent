import { useId } from "react"
import { FolderOpen, Info } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

export function ProjectWorkspaceField({
  workspacePath,
  projectDir,
  readOnly = false,
  disabled = false,
  error,
  onPickWorkspace
}: {
  workspacePath: string
  projectDir: string
  readOnly?: boolean
  disabled?: boolean
  error: string | null
  onPickWorkspace?: () => void
}): React.JSX.Element {
  const id = useId()
  const separator = workspacePath.includes("\\") ? "\\" : "/"
  const projectPath =
    workspacePath && projectDir
      ? `${workspacePath.replace(/[\\/]+$/, "")}${separator}${projectDir}`
      : ""

  return (
    <div className="mt-3 grid min-w-0 gap-1.5 text-xs font-medium text-muted-foreground">
      <div className="flex items-center gap-1">
        <span id={`${id}-label`}>插件工作区 *</span>
        <TooltipProvider delayDuration={150}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label="插件工作区文件夹说明"
                className="inline-flex size-4 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Info className="size-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="z-[70] max-w-72">
              存放 spec.md、plan.md等插件运行产物，非代码仓库路径
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
      <div className="flex min-w-0 items-stretch gap-2">
        <div
          className={cn(
            "min-w-0 flex-1 rounded-md border border-input px-3 py-2 text-sm font-normal",
            projectPath ? "break-all text-foreground" : "text-muted-foreground",
            readOnly && "bg-muted",
            error && "border-status-critical"
          )}
          aria-labelledby={`${id}-label`}
          title={projectPath || undefined}
        >
          {projectPath || "选择空文件夹作为插件工作区"}
        </div>
        {!readOnly && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onPickWorkspace}
            disabled={disabled}
            aria-labelledby={`${id}-label ${id}-pick`}
            aria-describedby={error ? `${id}-error` : undefined}
            aria-invalid={error ? true : undefined}
            className="h-auto shrink-0 gap-1.5"
          >
            <FolderOpen className="size-3.5" />
            <span id={`${id}-pick`}>{projectPath ? "更换文件夹" : "选择文件夹"}</span>
          </Button>
        )}
      </div>
      {error && (
        <span id={`${id}-error`} role="alert" className="text-status-critical">
          {error}
        </span>
      )}
    </div>
  )
}
