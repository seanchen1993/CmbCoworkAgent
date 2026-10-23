import type { ReactNode } from "react"
import { Eye, FolderOpen } from "lucide-react"

import { IconPopoverButton } from "@/components/ui/icon-popover-button"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import type { RequirementPrdManifest } from "./requirement-data"

type RequirementFunctionInfo = RequirementPrdManifest["functions"][number]

export function RequirementFunctionCard({
  functionInfo,
  actions,
  details,
  onRevealFile,
  onPreviewFile,
  onOpenDetails
}: {
  functionInfo: RequirementFunctionInfo
  actions?: ReactNode
  details?: ReactNode
  onRevealFile: (filePath: string) => void
  onPreviewFile?: (filePath: string) => void
  onOpenDetails?: () => void
}): React.JSX.Element {
  const card = (
    <article
      role={onOpenDetails ? "button" : undefined}
      tabIndex={onOpenDetails ? 0 : undefined}
      className={cn(
        "overflow-hidden rounded-xl border border-border/80 bg-white transition-colors duration-200",
        onOpenDetails &&
          "cursor-pointer hover:border-primary/70 focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20"
      )}
      onClick={(event) => {
        if (!onOpenDetails) return
        if ((event.target as HTMLElement).closest("button, a, input, textarea, select")) return
        onOpenDetails()
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return
        if (!onOpenDetails || (event.key !== "Enter" && event.key !== " ")) return
        event.preventDefault()
        onOpenDetails()
      }}
    >
      <div className="flex items-stretch">
        <div className="flex min-w-0 flex-1 items-start gap-3 p-4">
          <div className="flex shrink-0 flex-col items-center gap-1.5">
            <span className="rounded-md bg-primary/10 px-2 py-1 text-xs font-semibold text-primary">
              {functionInfo.fr || functionInfo.id}
            </span>
            {functionInfo.file ? (
              <>
                <IconPopoverButton
                  icon={<FolderOpen className="size-3.5" />}
                  popoverContent="打开文件所在文件夹"
                  aria-label={`在文件夹中显示 ${functionInfo.file}`}
                  className="size-6 p-0 hover:text-primary"
                  stopPropagation
                  onClick={() => onRevealFile(functionInfo.file)}
                />
                {onPreviewFile ? (
                  <IconPopoverButton
                    icon={<Eye className="size-3.5" />}
                    popoverContent="在右侧面板预览文件"
                    aria-label={`预览 ${functionInfo.file}`}
                    className="size-6 p-0 hover:text-primary"
                    stopPropagation
                    onClick={() => onPreviewFile(functionInfo.file)}
                  />
                ) : null}
              </>
            ) : null}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-1.5">
              <TooltipProvider delayDuration={250}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <h4 className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
                      {functionInfo.name || "未命名功能"}
                    </h4>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="max-w-80 whitespace-normal">
                    {functionInfo.name || "未命名功能"}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
            <TooltipProvider delayDuration={250}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">
                    {functionInfo.description || "暂无功能描述"}
                  </p>
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-80 whitespace-normal">
                  {functionInfo.description || "暂无功能描述"}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            {functionInfo.keywords.length > 0 ? (
              <TooltipProvider delayDuration={250}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="mt-2 line-clamp-2 leading-6">
                      {functionInfo.keywords.map((keyword, keywordIndex) => (
                        <span
                          key={`${functionInfo.fr || functionInfo.id}-${keyword}-${keywordIndex}`}
                          className="mb-1.5 mr-1.5 inline-flex rounded border border-border/70 bg-muted/30 px-1.5 py-0.5 text-[11px] text-muted-foreground"
                        >
                          {keyword}
                        </span>
                      ))}
                    </div>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="max-w-80 whitespace-normal">
                    {functionInfo.keywords.join("、")}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            ) : null}
            {details}
          </div>
        </div>
        {actions ? (
          <div className="relative flex w-[208px] shrink-0 self-stretch items-center justify-center overflow-hidden border-l border-border/70 bg-slate-50/70 shadow-[-8px_0_16px_-12px_rgba(15,23,42,0.45)]">
            {actions}
          </div>
        ) : null}
      </div>
    </article>
  )

  return card
}
