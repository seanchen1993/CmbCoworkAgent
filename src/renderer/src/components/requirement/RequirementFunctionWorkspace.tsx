import { useRef, useState, type ReactNode } from "react"
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ExternalLink,
  FileDown,
  FileText,
  Loader2
} from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import type { RequirementRecord } from "./requirement-data"
import { REQUIREMENT_ACTION_HINTS, RequirementActionButton } from "./RequirementActionButton"
import { RequirementMarkdownEditorAndPreview } from "./RequirementMarkdownEditorAndPreview"

export function RequirementFunctionWorkspace({
  requirement,
  title,
  filePath,
  threadId,
  prototypeGenerated,
  hasPrototypeDesignSession,
  prototypeCoveredByFullPrd = false,
  prototypeSkipped,
  prototypePreview,
  prototypeHtmlFile,
  workspacePath,
  reloadToken,
  onBack,
  navigationItems,
  navigationValue,
  onNavigate,
  onOpenAttachment,
  onRequestPrototypeDesign
}: {
  requirement: RequirementRecord
  title: string
  filePath: string
  threadId: string | null
  prototypeGenerated: boolean
  hasPrototypeDesignSession: boolean
  prototypeCoveredByFullPrd?: boolean
  prototypeSkipped: boolean
  prototypePreview?: ReactNode
  prototypeHtmlFile?: string
  workspacePath: string
  reloadToken: number
  onBack: () => void
  navigationItems?: Array<{ value: string; label: string; hasPrototype?: boolean }>
  navigationValue?: string
  onNavigate?: (value: string) => void
  onOpenAttachment?: (filePath: string) => void
  onRequestPrototypeDesign?: () => void
}): React.JSX.Element {
  const [syncRevision, setSyncRevision] = useState(0)
  const [syncing, setSyncing] = useState(false)
  const [markdownEditing, setMarkdownEditing] = useState(false)
  const syncInFlightRef = useRef(false)
  const syncScopeRef = useRef("")
  const syncScope = `${requirement.id}\u0000${filePath}\u0000${prototypeHtmlFile ?? ""}`
  syncScopeRef.current = syncScope

  const syncPrototypeToMarkdown = async (): Promise<void> => {
    if (!prototypeHtmlFile || markdownEditing || syncInFlightRef.current) return
    const requestScope = syncScope
    syncInFlightRef.current = true
    setSyncing(true)
    try {
      const result = await window.api.requirements.syncPrototypeToPrd({
        reqId: requirement.id,
        prdFilePath: filePath,
        prototypeFilePath: prototypeHtmlFile,
        workspacePath
      })
      if (!result.success) throw new Error(result.error || "同步失败")
      if (syncScopeRef.current !== requestScope) return
      setSyncRevision((revision) => revision + 1)
      toast.success("原型 HTML 已同步到 MD 文档")
    } catch (syncError) {
      toast.error(syncError instanceof Error ? syncError.message : "同步原型到 MD 失败")
    } finally {
      syncInFlightRef.current = false
      setSyncing(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[#fbfcfe] p-4">
      <div className="mb-1.5 flex shrink-0 items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-1.5 text-xs"
          onClick={onBack}
        >
          <ArrowLeft className="size-3.5" />
          返回
        </Button>
        {navigationItems && navigationItems.length > 0 && onNavigate ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 min-w-0 max-w-72 gap-1.5 px-2 text-xs"
              >
                <span className="truncate">
                  {navigationItems.find((item) => item.value === navigationValue)?.label ||
                    "切换详情"}
                </span>
                <ChevronDown className="size-3.5 shrink-0" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-80 w-72 overflow-y-auto">
              {navigationItems.map((item) => (
                <DropdownMenuItem
                  key={item.value}
                  className="cursor-pointer gap-2"
                  onSelect={() => onNavigate(item.value)}
                >
                  <Check className={item.value === navigationValue ? "opacity-100" : "opacity-0"} />
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {item.hasPrototype ? (
                    <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                      有原型
                    </span>
                  ) : null}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        <h2 className="min-w-0 truncate text-sm font-semibold text-foreground">{title} · 预览</h2>
        <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
          {prototypeGenerated ? "原型设计阶段" : "规范 PRD 阶段"}
        </span>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-2 gap-3">
        <RequirementMarkdownEditorAndPreview
          requirementId={requirement.id}
          title={title}
          filePath={filePath}
          threadId={threadId}
          reloadToken={reloadToken + syncRevision}
          scrollToBottomToken={syncRevision}
          onEditingChange={setMarkdownEditing}
          onOpenAttachment={onOpenAttachment}
        />

        <section className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-border/80 bg-white transition-colors duration-200 hover:border-primary/70">
          <header className="flex h-10 shrink-0 items-center justify-between border-b border-border/80 bg-slate-100/80 px-3.5">
            <span className="text-xs font-semibold text-foreground/75">原型预览</span>
            {prototypeGenerated ? (
              <div className="flex items-center gap-1">
                {prototypeHtmlFile ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 gap-1 px-2 text-xs text-primary hover:text-primary"
                    disabled={syncing || markdownEditing}
                    onClick={() => void syncPrototypeToMarkdown()}
                  >
                    {syncing ? (
                      <Loader2 className="size-3 animate-spin" />
                    ) : (
                      <FileDown className="size-3" />
                    )}
                    同步到MD文档里
                  </Button>
                ) : null}
                <TooltipProvider delayDuration={200}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 gap-1 px-2 text-xs text-primary hover:text-primary"
                        onClick={onRequestPrototypeDesign}
                      >
                        <ExternalLink className="size-3" />
                        继续完善设计
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="max-w-64">
                      已关联设计会话，点击可跳转并继续完善原型
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
            ) : null}
          </header>
          <div className="relative min-h-0 flex-1 bg-slate-50/70">
            {prototypeGenerated && prototypePreview ? (
              prototypePreview
            ) : (
              <div className="flex h-full flex-col items-center justify-center px-6 text-center">
                {prototypeSkipped ? (
                  <span className="mb-4 inline-flex items-center rounded-full border border-amber-300 bg-amber-100 px-3 py-1.5 text-xs font-semibold text-amber-800">
                    当前状态：无需设计
                  </span>
                ) : null}
                <div
                  className={`mb-3 flex size-12 items-center justify-center rounded-xl border bg-white ${
                    prototypeSkipped
                      ? "border-amber-300 text-amber-700 shadow-sm"
                      : "border-border text-muted-foreground"
                  }`}
                >
                  <FileText className="size-5" />
                </div>
                <p className="text-base font-semibold text-foreground">
                  {prototypeCoveredByFullPrd
                    ? "已包含在完整需求原型中"
                    : prototypeSkipped
                      ? "已选择无需设计，尚未生成原型"
                      : hasPrototypeDesignSession
                        ? "尚未生成可预览原型"
                        : "尚未开始原型设计"}
                </p>
                <p className="mt-2 text-xs leading-5 text-muted-foreground">
                  {prototypeCoveredByFullPrd
                    ? "当前需求采用完整需求原型设计，无需为此功能单独创建原型。"
                    : prototypeSkipped
                      ? "如需补充原型，可随时点击下方按钮重新进入原型设计。"
                      : hasPrototypeDesignSession
                        ? "设计会话已创建，当前尚未生成原型 HTML，可返回会话继续沟通和设计。"
                        : "尚未创建设计会话，点击下方按钮开始设计原型。"}
                </p>
                {onRequestPrototypeDesign && !prototypeCoveredByFullPrd ? (
                  <RequirementActionButton
                    type="button"
                    size="sm"
                    className="mt-5"
                    onClick={onRequestPrototypeDesign}
                    hint={
                      prototypeSkipped || !hasPrototypeDesignSession
                        ? REQUIREMENT_ACTION_HINTS.startDesign
                        : REQUIREMENT_ACTION_HINTS.continueDesign
                    }
                  >
                    {prototypeSkipped || !hasPrototypeDesignSession ? "去设计" : "继续设计"}
                  </RequirementActionButton>
                ) : null}
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}
