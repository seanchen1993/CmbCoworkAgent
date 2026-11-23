import { useId, useState } from "react"
import { ChevronRight, FolderOpen, Info } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

export function ProjectWorkspaceAdvancedSettings({
  onUseDefault,
  onPreviewDefaultPath,
  ...workspace
}: Omit<React.ComponentProps<typeof ProjectWorkspaceField>, "readOnly" | "defaultPath"> & {
  onUseDefault: () => void
  onPreviewDefaultPath: () => Promise<string>
}): React.JSX.Element {
  const [defaultPath, setDefaultPath] = useState<string | null>(null)

  return (
    <details
      className="group mt-3"
      onToggle={(event) => {
        if (event.currentTarget.open && defaultPath === null) {
          void onPreviewDefaultPath().then(
            (path) => setDefaultPath(path),
            () => setDefaultPath("")
          )
        }
      }}
    >
      <summary
        className={cn(
          "flex w-fit cursor-pointer list-none items-center gap-1 rounded-sm text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden",
          workspace.error && "text-status-critical"
        )}
      >
        <ChevronRight aria-hidden="true" className="size-3.5 group-open:rotate-90" />
        高级设置
      </summary>
      <ProjectWorkspaceField {...workspace} defaultPath={defaultPath} />
      {(workspace.workspacePath || workspace.error) && (
        <Button
          type="button"
          variant="link"
          size="sm"
          className="mt-1 h-auto px-0 py-1 text-xs"
          onClick={onUseDefault}
          disabled={workspace.disabled}
        >
          恢复默认路径
        </Button>
      )}
    </details>
  )
}

export function ProjectWorkspaceField({
  workspacePath,
  projectDir,
  defaultPath = null,
  readOnly = false,
  required = false,
  artifactsInProjectDirectory = true,
  disabled = false,
  error,
  onPickWorkspace
}: {
  workspacePath: string
  projectDir: string
  defaultPath?: string | null
  readOnly?: boolean
  required?: boolean
  artifactsInProjectDirectory?: boolean
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
  const displayedPath = projectPath || defaultPath
  const fallbackText = readOnly || required
    ? "选择空文件夹作为插件工作区"
    : defaultPath === null
      ? "正在读取默认路径…"
      : "无法读取默认路径"

  return (
    <div className="mt-3 grid min-w-0 gap-1.5 text-xs font-medium text-muted-foreground">
      <div className="flex items-center gap-1">
        <span id={`${id}-label`}>{readOnly || required ? "插件工作区 *" : "插件工作区"}</span>
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
              {artifactsInProjectDirectory
                ? "插件工作区，存放 spec.md、plan.md，非代码/会话路径"
                : "用于登记本项目。各特性的运行与产物位于创建特性或首次开启托管时确认的目录，实际位置见特性详情。"}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
      <div className="flex min-w-0 items-stretch gap-2">
        <div
          className={cn(
            "min-w-0 flex-1 rounded-md border border-input px-3 py-2 text-sm font-normal",
            displayedPath ? "break-all text-foreground" : "text-muted-foreground",
            readOnly && "bg-muted",
            error && "border-status-critical"
          )}
          aria-labelledby={`${id}-label`}
          title={displayedPath || undefined}
        >
          {displayedPath || fallbackText}
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
            <span id={`${id}-pick`}>{projectPath ? "更换文件夹" : required ? "选择空文件夹" : "自行指定工作区路径"}</span>
          </Button>
        )}
      </div>
      {!readOnly && (
        <p className="text-xs font-normal leading-relaxed">
          请选择新建的空文件夹。已有代码仓库请在创建特性时选择，不要清空代码仓库。
        </p>
      )}
      {error && (
        <span id={`${id}-error`} role="alert" className="text-status-critical">
          {error}
        </span>
      )}
    </div>
  )
}
