import type { ReactNode } from "react"
import { Check, CheckCircle2, EllipsisVertical, Eye, FolderOpen, Palette } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"
import { IconPopoverButton } from "@/components/ui/icon-popover-button"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import type { NeedDesignChoice, RequirementPrdManifest } from "./requirement-data"

type RequirementFunctionInfo = RequirementPrdManifest["functions"][number]

// 已选择设计状态后的统一修改入口；原型缩略图和状态卡片共用同一菜单。
export function RequirementPrototypeMenu({
  needDesign,
  disabled,
  onChange,
  onDesign,
  className
}: {
  needDesign: NeedDesignChoice
  disabled: boolean
  onChange: (needDesign: NeedDesignChoice) => void
  onDesign: () => void
  className?: string
}): React.JSX.Element {
  const needsDesign = needDesign === "1"
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label="更改原型设计选项"
          className={cn(
            "inline-flex size-8 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-white/90 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/25 disabled:cursor-not-allowed disabled:opacity-50",
            className
          )}
        >
          <EllipsisVertical className="size-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-40"
        onClick={(event) => event.stopPropagation()}
      >
        <DropdownMenuItem onSelect={onDesign} className="cursor-pointer">
          <Palette />
          <span className="flex-1">去设计</span>
          {needsDesign ? <Check className="text-primary" /> : null}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onChange("0")} className="cursor-pointer">
          <CheckCircle2 />
          <span className="flex-1">无需设计</span>
          {!needsDesign ? <Check className="text-status-nominal" /> : null}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// 未选择时提供首次决策；已选择后分别展示“继续设计”操作或“无需设计”状态。
export function RequirementPrototypeAction({
  needDesign,
  choiceMade,
  disabled,
  onChange,
  onDesign
}: {
  needDesign: NeedDesignChoice
  choiceMade: boolean
  disabled: boolean
  onChange: (needDesign: NeedDesignChoice) => void
  onDesign: () => void
}): React.JSX.Element {
  if (!choiceMade) {
    return (
      <div className="flex w-full flex-wrap items-center justify-center gap-1.5 px-3 py-2">
        <Button
          type="button"
          size="sm"
          className="h-7 gap-1 rounded-md px-2.5 text-[11px] shadow-none"
          disabled={disabled}
          onClick={onDesign}
        >
          <Palette className="size-3" />
          去设计
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 gap-1 rounded-md border-border/80 bg-white/90 px-2.5 text-[11px] text-muted-foreground shadow-none"
          disabled={disabled}
          onClick={() => onChange("0")}
        >
          <CheckCircle2 className="size-3" />
          无需设计
        </Button>
      </div>
    )
  }

  const needsDesign = needDesign === "1"
  return (
    <div
      className={cn(
        "relative flex h-full min-h-[88px] w-full items-center justify-center overflow-hidden px-3 py-2",
        needsDesign
          ? "bg-gradient-to-br from-primary/5 via-white to-status-info/10"
          : "bg-gradient-to-br from-status-nominal/5 via-white to-emerald-50/80"
      )}
    >
      <RequirementPrototypeMenu
        needDesign={needDesign}
        disabled={disabled}
        onChange={onChange}
        onDesign={onDesign}
        className="absolute right-1 top-1"
      />

      {needsDesign ? (
        <Button
          type="button"
          size="sm"
          disabled={disabled}
          onClick={onDesign}
          className="h-7 gap-1 rounded-md px-2.5 text-[11px] shadow-none"
        >
          <Palette className="size-3" />
          继续设计
        </Button>
      ) : (
        <div className="inline-flex items-center gap-1.5 rounded-md border border-status-nominal/20 bg-status-nominal/10 px-2.5 py-1.5 text-status-nominal">
          <span className="inline-flex items-center justify-center">
            <CheckCircle2 className="size-3.5" />
          </span>
          <span className="text-[11px] font-medium">无需设计</span>
        </div>
      )}
    </div>
  )
}

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
        if (
          (event.target as HTMLElement).closest(
            "button, a, input, textarea, select, [role=menuitem], [role=menu]"
          )
        )
          return
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
