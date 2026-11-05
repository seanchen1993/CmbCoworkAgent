import { useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import {
  AlertTriangle,
  Brain,
  ChevronRight,
  Eye,
  FileCheck2,
  FileText,
  Info,
  KeyRound,
  Loader2,
  PanelRightClose,
  RotateCcw,
  Send,
  Trash2,
  WandSparkles
} from "lucide-react"
import { SubagentStreamPanel } from "@/components/chat/SubagentStreamPanel"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { HtmlThumbnailPreview } from "@/components/ui/html-thumbnail-preview"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { assembleBoundedTextPreview } from "@/lib/text-preview-pages"
import type { RequirementDesignEntry } from "@/lib/requirement-design-entry"
import { cn } from "@/lib/utils"
import type { WorkspaceFilePreviewReadResult } from "../../../../shared/workspace-file-preview"
import type {
  NeedDesignChoice,
  RequirementPrdManifest,
  RequirementRecord
} from "./requirement-data"
import {
  RequirementFunctionCard,
  RequirementPrototypeAction,
  RequirementPrototypeMenu
} from "./RequirementFunctionCard"
import { RequirementFunctionWorkspace } from "./RequirementFunctionWorkspace"
import { RequirementPrdSummaryCard } from "./RequirementPrdSummaryCard"
import { RequirementStatusTags } from "./RequirementStatusTags"

export type RequirementPreviewTab = "expert-process" | "source" | "prd"
export type RequirementPrototypeStatus = {
  functionInfo: RequirementPrdManifest["functions"][number]
  prototypePath: string
  generated: boolean
  skipped: boolean
  complete: boolean
  choiceMade: boolean
}

type RequirementDetailsPanelProps = {
  requirement: RequirementRecord
  manifest: RequirementPrdManifest | null
  prototypeStatuses: RequirementPrototypeStatus[]
  previewTab: RequirementPreviewTab
  collapsed: boolean
  threadId: string | null
  workspacePath: string
  sourcePreview: string
  sourcePreviewLoading: boolean
  sourcePreviewError: string | null
  sourceDocumentFiles: Array<{ path: string; size?: number }>
  manifestLoading: boolean
  manifestError: string | null
  statusRefreshing: boolean
  conversationLoading: boolean
  tokenSaving: boolean
  hasStoredToken: boolean
  publishRequestQueued: boolean
  prdGenerationCompleted: boolean
  prototypeCompleted: boolean
  fullPrdDesignEntry: RequirementDesignEntry | null
  requirementSpacePublished: boolean
  allPrototypeFunctionsCompleted: boolean
  completedPrototypeCount: number
  generatedPrototypeCount: number
  skippedPrototypeCount: number
  prdPreviewReloadToken: number
  showExpertProcess: boolean
  onPreviewTabChange: (tab: RequirementPreviewTab) => void
  onFunctionWorkspaceChange: (open: boolean) => void
  onFocusExpertProcess: () => void
  onRefreshStatus: () => void | Promise<void>
  onCollapse: () => void
  onReloadSource: () => void | Promise<void>
  onReloadManifest: () => void | Promise<unknown>
  onOpenWorkspaceFilePreview: (filePath: string) => void
  onRevealRequirementFile: (filePath: string) => void
  onRequestPrototypeDesign: (functionInfo: RequirementPrdManifest["functions"][number]) => void
  onStartBatchPrototypeDesign: (
    functionInfos: RequirementPrdManifest["functions"],
    mode: "functions" | "full-prd"
  ) => void | Promise<void>
  onClearPrototypeDesign: () => void | Promise<void>
  onClearPrototypeFunction: (
    functionInfo: RequirementPrdManifest["functions"][number]
  ) => void | Promise<void>
  onUpdatePrototypeFunctionDesign: (
    functionInfo: RequirementPrdManifest["functions"][number],
    needDesign: NeedDesignChoice
  ) => void
  onPublishToRequirementSpace: () => void
  onSendLeanstarToken: () => void | Promise<void>
}

function getPrototypeFunctionKey(functionInfo: { fr: string; file: string }): string {
  return `${functionInfo.fr}:${functionInfo.file}`
}
function normalizePrdFilePath(filePath: string): string {
  const normalized = filePath.trim().replace(/\\/g, "/").replace(/^\/+/, "")
  const prdMarker = normalized.toLowerCase().lastIndexOf("/prd/")
  if (prdMarker >= 0) return `/${normalized.slice(prdMarker + 1)}`
  return normalized.toLowerCase() === "prd" || normalized.toLowerCase().startsWith("prd/")
    ? `/${normalized}`
    : `/prd/${normalized}`
}
function getDisplayFileName(filePath: string): string {
  return filePath.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? filePath
}
function isRequirementSpacePublished(manifest: RequirementPrdManifest | null): boolean {
  return (
    manifest?.prd.status.toLowerCase() === "published" || Boolean(manifest?.prd.prDetailUrl?.trim())
  )
}

const REQUIREMENT_WORKSPACE_PREVIEW_MAX_BYTES = 8 * 1024 * 1024
const REQUIREMENT_WORKSPACE_PREVIEW_MAX_PAGES = 64
async function readRequirementWorkspaceTextFile(
  threadId: string,
  filePath: string
): Promise<{ success: boolean; content?: string; error?: string }> {
  const requestToken = globalThis.crypto.randomUUID()
  const lane = `requirement-prototype-html:${threadId}:${requestToken}`
  const readPage = (offset: number): Promise<WorkspaceFilePreviewReadResult> =>
    window.api.workspace.readFilePreview({
      source: {
        threadId,
        filePath,
        workspacePathKind: /^(?:[a-zA-Z]:[\\/]|[/\\]{2}|\/)/.test(filePath)
          ? "absolute"
          : "relative"
      },
      offset,
      lane,
      requestToken
    })
  const first = await readPage(0)
  if (!first.success) return { success: false, error: first.error }
  const assembled = await assembleBoundedTextPreview(
    first,
    async (offset) => {
      const page = await readPage(offset)
      return page.success ? page : null
    },
    {
      maxBytes: REQUIREMENT_WORKSPACE_PREVIEW_MAX_BYTES,
      maxPages: REQUIREMENT_WORKSPACE_PREVIEW_MAX_PAGES
    }
  )
  return { success: true, content: assembled.content }
}

function PrototypeHtmlPreview({
  threadId,
  filePath,
  reloadToken,
  workspacePath,
  fit = "thumbnail"
}: {
  threadId: string
  filePath: string
  reloadToken: number
  workspacePath: string
  fit?: "thumbnail" | "fill"
}): React.JSX.Element {
  const previewKey = `${threadId}:${filePath}:${reloadToken}`
  const [preview, setPreview] = useState<{ key: string; html: string; error: boolean }>({
    key: "",
    html: "",
    error: false
  })
  useEffect(() => {
    let cancelled = false
    void readRequirementWorkspaceTextFile(threadId, filePath).then((result) => {
      if (cancelled) return
      setPreview(
        !result.success || !result.content
          ? { key: previewKey, html: "", error: true }
          : { key: previewKey, html: result.content, error: false }
      )
    })
    return () => {
      cancelled = true
    }
  }, [filePath, previewKey, threadId])
  if (preview.key === previewKey && preview.error) {
    return (
      <div className="flex h-full items-center justify-center px-3 text-center text-[11px] text-destructive">
        HTML 原型加载失败
      </div>
    )
  }
  if (preview.key !== previewKey || !preview.html) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
      </div>
    )
  }
  return (
    <HtmlThumbnailPreview
      key={previewKey}
      html={preview.html}
      title={`原型预览 ${filePath}`}
      browserUrl={filePath}
      browserWorkspacePath={workspacePath}
      fit={fit}
      className="h-full w-full"
    />
  )
}

function PrototypeScopeBadge({ scope }: { scope: "function" | "full-prd" }): React.JSX.Element {
  const isFullPrd = scope === "full-prd"
  return (
    <TooltipProvider delayDuration={180}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={cn(
              "inline-flex cursor-help items-center rounded-full border px-2 py-1 text-[10px] font-semibold shadow-sm backdrop-blur-sm",
              isFullPrd
                ? "border-violet-200 bg-violet-50/95 text-violet-700"
                : "border-blue-200 bg-blue-50/95 text-blue-700"
            )}
          >
            {isFullPrd ? "整个需求原型" : "功能原型"}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-64 text-xs leading-5">
          {isFullPrd
            ? "基于完整 PRD 生成，用于预览整个需求的页面结构和完整流程。"
            : "仅针对当前功能生成，用于预览该功能的页面和交互。"}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

function FullPrdModeFunctionNotice(): React.JSX.Element {
  return (
    <TooltipProvider delayDuration={180}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex h-full min-h-[88px] w-full cursor-help items-center justify-center bg-violet-50/60 px-3 py-2">
            <span className="rounded-full border border-violet-200 bg-white px-2.5 py-1.5 text-[11px] font-medium text-violet-700 shadow-sm">
              已包含在整个需求原型中
            </span>
          </div>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-64 text-xs leading-5">
          当前采用“基于完整 PRD 设计”模式，无需再为每个功能单独选择设计方式。
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

function FullPrdPrototypeCard({
  filePath,
  threadId,
  reloadToken,
  workspacePath,
  description
}: {
  filePath: string
  threadId: string
  reloadToken: number
  workspacePath: string
  description: string
}): React.JSX.Element {
  return (
    <section className="overflow-hidden rounded-xl border border-violet-200 bg-white shadow-sm">
      <div className="flex items-center justify-between gap-3 border-b border-violet-100 bg-violet-50/60 px-3.5 py-2.5">
        <div>
          <h3 className="text-sm font-semibold text-foreground">整个需求原型</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
        </div>
        <PrototypeScopeBadge scope="full-prd" />
      </div>
      <div className="relative h-64 overflow-hidden bg-white">
        <PrototypeHtmlPreview
          filePath={filePath}
          threadId={threadId}
          reloadToken={reloadToken}
          workspacePath={workspacePath}
          fit="fill"
        />
      </div>
    </section>
  )
}

export function RequirementDetailsPanel({
  requirement,
  manifest: requirementSpaceManifest,
  prototypeStatuses,
  previewTab,
  collapsed,
  threadId,
  workspacePath,
  sourcePreview,
  sourcePreviewLoading,
  sourcePreviewError,
  sourceDocumentFiles,
  manifestLoading,
  manifestError,
  statusRefreshing,
  conversationLoading,
  tokenSaving,
  hasStoredToken,
  publishRequestQueued,
  prdGenerationCompleted,
  prototypeCompleted,
  fullPrdDesignEntry,
  requirementSpacePublished,
  allPrototypeFunctionsCompleted,
  completedPrototypeCount,
  generatedPrototypeCount,
  skippedPrototypeCount,
  prdPreviewReloadToken,
  showExpertProcess,
  onPreviewTabChange,
  onFunctionWorkspaceChange,
  onFocusExpertProcess,
  onRefreshStatus: handleRefreshStatus,
  onCollapse,
  onReloadSource: loadSourcePreview,
  onReloadManifest: loadRequirementSpaceManifest,
  onOpenWorkspaceFilePreview: openWorkspaceFilePreview,
  onRevealRequirementFile: revealRequirementFile,
  onRequestPrototypeDesign: requestPrototypeDesign,
  onStartBatchPrototypeDesign: startBatchPrototypeDesign,
  onClearPrototypeDesign: clearPrototypeDesign,
  onClearPrototypeFunction: clearPrototypeFunction,
  onUpdatePrototypeFunctionDesign: updatePrototypeFunctionDesign,
  onPublishToRequirementSpace: handlePublishToRequirementSpace,
  onSendLeanstarToken: handleSendLeanstarToken
}: RequirementDetailsPanelProps): React.JSX.Element {
  const [batchDialogOpen, setBatchDialogOpen] = useState(false)
  const [batchSelection, setBatchSelection] = useState<Set<string>>(() => new Set())
  const [batchDesignMode, setBatchDesignMode] = useState<"functions" | "full-prd">("functions")
  const [batchStarting, setBatchStarting] = useState(false)
  const [clearDialogOpen, setClearDialogOpen] = useState(false)
  const [clearTargetFunction, setClearTargetFunction] = useState<
    RequirementPrdManifest["functions"][number] | null
  >(null)
  const [clearStarting, setClearStarting] = useState(false)
  const batchStartingRef = useRef(false)
  const [selectedFunction, setSelectedFunction] = useState<
    RequirementPrdManifest["functions"][number] | null
  >(null)
  const [fullPrdWorkspaceOpen, setFullPrdWorkspaceOpen] = useState(false)
  const selectedPrototypeStatus = selectedFunction
    ? prototypeStatuses.find(
        (item) =>
          getPrototypeFunctionKey(item.functionInfo) === getPrototypeFunctionKey(selectedFunction)
      )
    : undefined
  const hasFullPrdDesignSession = Boolean(fullPrdDesignEntry?.htmlId)
  const fullPrdPrototypeGenerated = Boolean(fullPrdDesignEntry?.htmlFile?.trim())
  const prototypeDesignCompleted = hasFullPrdDesignSession
    ? fullPrdPrototypeGenerated
    : allPrototypeFunctionsCompleted
  const hasPrototypeDesignSession =
    hasFullPrdDesignSession || prototypeStatuses.some((item) => item.functionInfo.htmlId?.trim())
  const hasPrototypeDesignState =
    hasPrototypeDesignSession ||
    requirementSpaceManifest?.prd.needDesign !== "" ||
    prototypeStatuses.some(
      (item) =>
        item.functionInfo.needDesign !== "" ||
        Boolean(item.functionInfo.htmlFile?.trim()) ||
        Boolean(item.functionInfo.htmlId?.trim())
    )
  const prototypeStatusByFunction = useMemo(
    () =>
      new Map(
        prototypeStatuses.map((item) => [getPrototypeFunctionKey(item.functionInfo), item] as const)
      ),
    [prototypeStatuses]
  )
  const runBatchPrototypeDesign = async (
    functionInfos: RequirementPrdManifest["functions"],
    mode: "functions" | "full-prd"
  ): Promise<boolean> => {
    if (batchStartingRef.current) return false
    batchStartingRef.current = true
    setBatchStarting(true)
    try {
      await startBatchPrototypeDesign(functionInfos, mode)
      return true
    } catch (error) {
      console.error("[RequirementDetailsPanel] Failed to start batch design:", error)
      toast.error(error instanceof Error ? error.message : "批量创建设计会话失败")
      return false
    } finally {
      batchStartingRef.current = false
      setBatchStarting(false)
    }
  }

  useEffect(() => {
    onFunctionWorkspaceChange(Boolean(selectedFunction) || fullPrdWorkspaceOpen)
  }, [fullPrdWorkspaceOpen, onFunctionWorkspaceChange, selectedFunction])

  useEffect(() => {
    if (hasFullPrdDesignSession) setSelectedFunction(null)
  }, [hasFullPrdDesignSession])

  useEffect(() => {
    return () => onFunctionWorkspaceChange(false)
  }, [onFunctionWorkspaceChange])

  return (
    <aside
      className={cn(
        "flex min-h-0 min-w-0 flex-col overflow-hidden bg-white",
        collapsed && "hidden"
      )}
    >
      {requirement.workspaceMissing ? (
        <div
          role="alert"
          className="flex shrink-0 items-center gap-2 border-b border-[#ead3a1] bg-[#fff9e9] px-4 py-2 text-sm leading-5 text-[#8f6a2a]"
        >
          <AlertTriangle className="size-3.5 shrink-0" />
          <span>该需求的工作目录已被删除，当前内容可能不可用。</span>
        </div>
      ) : null}
      {requirement.coreFilesMissing && !requirement.workspaceMissing ? (
        <div
          role="alert"
          className="flex shrink-0 items-center gap-2 border-b border-status-critical/20 bg-status-critical/5 px-4 py-2 text-sm leading-5 text-status-critical"
        >
          <AlertTriangle className="size-3.5 shrink-0" />
          <span>
            {requirement.coreFilesMissingReason || "需求核心文件缺失，当前内容可能不可用。"}
          </span>
        </div>
      ) : null}
      <Tabs
        value={previewTab}
        onValueChange={(value) => {
          const nextTab: RequirementPreviewTab =
            value === "expert-process" ? "expert-process" : value === "prd" ? "prd" : "source"
          onPreviewTabChange(nextTab)
          setSelectedFunction(null)
          if (nextTab === "expert-process") {
            onFocusExpertProcess()
          }
        }}
        className="flex min-h-0 flex-1 flex-col"
      >
        {!selectedFunction && !fullPrdWorkspaceOpen ? (
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border/70 bg-white px-4 py-1.5 shadow-[0_1px_0_rgba(15,23,42,0.02)]">
            <TabsList
              aria-label="需求信息分类"
              className="h-8 min-w-0 justify-start gap-5 rounded-none bg-transparent p-0 -mb-2"
            >
              {[
                {
                  value: "source",
                  label: "初始需求信息",
                  enabled: true
                },
                {
                  value: "expert-process",
                  label: "专家思考过程",
                  enabled: true
                },
                {
                  value: "prd",
                  label: "规范PRD文件",
                  enabled: true
                }
              ].map((tab) => (
                <div key={tab.value} className="min-w-0">
                  <TabsTrigger
                    value={tab.value}
                    disabled={!tab.enabled}
                    className="relative -mb-px h-8 rounded-none border-b-2 border-transparent bg-transparent px-0.5 text-xs font-semibold text-muted-foreground shadow-none transition-colors hover:text-foreground data-[state=active]:border-[#c99366] data-[state=active]:bg-transparent data-[state=active]:text-[#b97843] data-[state=active]:shadow-none"
                  >
                    {tab.label}
                  </TabsTrigger>
                </div>
              ))}
            </TabsList>
            <div className="flex shrink-0 items-center gap-2">
              <RequirementStatusTags
                standardized={prdGenerationCompleted}
                hasPrototype={prototypeCompleted}
                published={requirementSpacePublished}
              />
              <TooltipProvider delayDuration={180}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => void handleRefreshStatus()}
                      disabled={statusRefreshing}
                      className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors enabled:hover:bg-background-interactive enabled:hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                      aria-label="刷新状态"
                    >
                      <RotateCcw className={cn("size-3.5", statusRefreshing && "animate-spin")} />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="text-xs">
                    刷新状态
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
              <TooltipProvider delayDuration={180}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedFunction(null)
                        setFullPrdWorkspaceOpen(false)
                        onCollapse()
                      }}
                      className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-background-interactive hover:text-foreground"
                      aria-label="收起右侧面板"
                    >
                      <PanelRightClose className="size-3.5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="text-xs">
                    收起右侧面板
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
          </div>
        ) : null}

        {fullPrdWorkspaceOpen && requirementSpaceManifest ? (
          <RequirementFunctionWorkspace
            requirement={requirement}
            title={requirementSpaceManifest.prd.name || requirement.title}
            filePath={normalizePrdFilePath(requirementSpaceManifest.prd.file)}
            threadId={threadId}
            prototypeGenerated={fullPrdPrototypeGenerated}
            hasPrototypeDesignSession={hasFullPrdDesignSession}
            prototypeSkipped={false}
            prototypePreview={
              fullPrdDesignEntry?.htmlFile && threadId ? (
                <PrototypeHtmlPreview
                  threadId={threadId}
                  filePath={fullPrdDesignEntry.htmlFile}
                  reloadToken={prdPreviewReloadToken}
                  workspacePath={workspacePath}
                  fit="fill"
                />
              ) : undefined
            }
            reloadToken={prdPreviewReloadToken}
            onBack={() => setFullPrdWorkspaceOpen(false)}
            navigationValue="full-prd"
            navigationItems={[
              { value: "full-prd", label: "完整需求 MD" },
              ...requirementSpaceManifest.functions.map((functionInfo) => ({
                value: getPrototypeFunctionKey(functionInfo),
                label: functionInfo.name || "未命名功能"
              }))
            ]}
            onNavigate={(value) => {
              if (value === "full-prd") return
              const nextFunction = requirementSpaceManifest.functions.find(
                (functionInfo) => getPrototypeFunctionKey(functionInfo) === value
              )
              if (!nextFunction) return
              setFullPrdWorkspaceOpen(false)
              setSelectedFunction(nextFunction)
            }}
            onRequestPrototypeDesign={
              hasFullPrdDesignSession
                ? () => void runBatchPrototypeDesign([], "full-prd")
                : undefined
            }
          />
        ) : selectedFunction ? (
          <RequirementFunctionWorkspace
            requirement={requirement}
            title={selectedFunction.name || "未命名功能"}
            filePath={normalizePrdFilePath(selectedFunction.file)}
            threadId={threadId}
            prototypeGenerated={
              (selectedPrototypeStatus?.generated ?? false) ||
              (hasFullPrdDesignSession && fullPrdPrototypeGenerated)
            }
            hasPrototypeDesignSession={
              Boolean(selectedFunction.htmlId?.trim()) || hasFullPrdDesignSession
            }
            prototypeCoveredByFullPrd={hasFullPrdDesignSession}
            prototypeSkipped={selectedPrototypeStatus?.skipped ?? false}
            prototypePreview={
              selectedPrototypeStatus?.generated && threadId ? (
                <PrototypeHtmlPreview
                  threadId={threadId}
                  filePath={selectedPrototypeStatus.prototypePath}
                  reloadToken={prdPreviewReloadToken}
                  workspacePath={workspacePath}
                  fit="fill"
                />
              ) : hasFullPrdDesignSession && fullPrdDesignEntry?.htmlFile && threadId ? (
                <div className="relative h-full w-full">
                  <PrototypeHtmlPreview
                    threadId={threadId}
                    filePath={fullPrdDesignEntry.htmlFile}
                    reloadToken={prdPreviewReloadToken}
                    workspacePath={workspacePath}
                    fit="fill"
                  />
                  <div className="absolute left-2 top-2 z-10">
                    <PrototypeScopeBadge scope="full-prd" />
                  </div>
                </div>
              ) : undefined
            }
            reloadToken={prdPreviewReloadToken}
            onBack={() => setSelectedFunction(null)}
            navigationValue={getPrototypeFunctionKey(selectedFunction)}
            navigationItems={
              requirementSpaceManifest
                ? [
                    { value: "full-prd", label: "完整需求 MD" },
                    ...requirementSpaceManifest.functions.map((functionInfo) => ({
                      value: getPrototypeFunctionKey(functionInfo),
                      label: functionInfo.name || "未命名功能"
                    }))
                  ]
                : undefined
            }
            onNavigate={
              requirementSpaceManifest
                ? (value) => {
                    if (value === "full-prd") {
                      setSelectedFunction(null)
                      setFullPrdWorkspaceOpen(true)
                      return
                    }
                    const nextFunction = requirementSpaceManifest.functions.find(
                      (functionInfo) => getPrototypeFunctionKey(functionInfo) === value
                    )
                    if (nextFunction) setSelectedFunction(nextFunction)
                  }
                : undefined
            }
            onRequestPrototypeDesign={
              hasFullPrdDesignSession
                ? undefined
                : () => {
                    if (selectedPrototypeStatus?.skipped) {
                      updatePrototypeFunctionDesign(selectedFunction, "1")
                    }
                    requestPrototypeDesign(selectedFunction)
                  }
            }
          />
        ) : null}

        <TabsContent
          value="expert-process"
          className={cn(
            "m-0 min-h-0 flex-1 overflow-hidden",
            (selectedFunction || fullPrdWorkspaceOpen) && "hidden"
          )}
        >
          {showExpertProcess ? (
            <SubagentStreamPanel showCloseButton={false} />
          ) : (
            <div className="flex h-full min-h-[260px] items-center justify-center px-6 py-10 text-center">
              <div className="flex max-w-xs flex-col items-center">
                <div className="mb-4 flex size-14 items-center justify-center rounded-full border border-status-info/25 bg-status-info/10 text-status-info">
                  <Brain className="size-7" strokeWidth={1.7} />
                </div>
                <div className="text-sm font-semibold text-foreground">暂无专家执行记录</div>
                <div className="mt-1.5 text-xs leading-5 text-muted-foreground">
                  Agent分析启动后，执行过程会显示在这里
                </div>
              </div>
            </div>
          )}
        </TabsContent>

        <TabsContent
          value="source"
          className={cn(
            "m-0 min-h-0 flex-1 overflow-y-auto",
            (selectedFunction || fullPrdWorkspaceOpen) && "hidden"
          )}
        >
          {sourcePreviewLoading ? (
            <div className="flex h-full min-h-[260px] items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin text-primary" />
              正在读取原始需求
            </div>
          ) : sourcePreviewError ? (
            <div className="flex h-full min-h-[260px] items-center justify-center px-6 text-center">
              <div className="flex max-w-[340px] flex-col items-center gap-3">
                <AlertTriangle className="size-5 text-status-critical" />
                <p className="text-sm leading-5 text-status-critical">{sourcePreviewError}</p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8 text-sm"
                  onClick={() => void loadSourcePreview()}
                >
                  重新读取
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-3 bg-[#fbfcfe] p-4">
              <div className="flex min-h-5 items-center gap-3">
                <h2 className="text-sm font-semibold leading-5 text-foreground">提供需求</h2>
                <p className="text-xs leading-4 text-muted-foreground">
                  原始输入将作为后续所有步骤的依据
                </p>
                <span className="ml-auto rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                  原始输入
                </span>
              </div>

              <section className="rounded-xl border border-border/80 bg-white p-4">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <h3 className="text-sm font-semibold text-foreground">文本描述</h3>
                  <span className="text-[11px] text-muted-foreground">直接输入</span>
                </div>
                <p className="whitespace-pre-wrap text-sm leading-6 text-foreground/85">
                  {requirement.initialDescription.trim() ||
                    sourcePreview.trim() ||
                    "未提供额外文本描述"}
                </p>
              </section>

              <section className="rounded-xl border border-border/80 bg-white p-4">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <h3 className="text-sm font-semibold text-foreground">
                    上传文件（{sourceDocumentFiles.length}）
                  </h3>
                  <span className="text-[11px] text-muted-foreground">原始输入</span>
                </div>
                {sourceDocumentFiles.length > 0 ? (
                  <div className="space-y-2">
                    {sourceDocumentFiles.map((file) => (
                      <button
                        key={file.path}
                        type="button"
                        onClick={() => openWorkspaceFilePreview(file.path)}
                        className="flex w-full items-center gap-3 rounded-lg border border-border/70 bg-[#fbfcfe] px-3 py-2.5 text-left transition-colors hover:border-primary/35 hover:bg-primary/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/35"
                      >
                        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                          <FileText className="size-4" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-foreground">
                            {getDisplayFileName(file.path)}
                          </span>
                          <span className="text-[11px] text-muted-foreground">
                            {file.size ? `${Math.ceil(file.size / 1024)} KB` : "需求附件"}
                          </span>
                        </span>
                        <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="rounded-lg bg-muted/35 px-3 py-4 text-center text-sm text-muted-foreground">
                    本需求未上传文件
                  </p>
                )}
              </section>

              <section className="rounded-xl border border-border/80 bg-white p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold text-foreground">知识库</h3>
                    <p className="mt-1 text-xs text-muted-foreground">
                      当前需求未记录独立知识库引用
                    </p>
                  </div>
                  <span className="rounded-full bg-muted px-2 py-1 text-[11px] text-muted-foreground">
                    未关联
                  </span>
                </div>
              </section>
            </div>
          )}
        </TabsContent>

        <TabsContent
          value="prd"
          className={cn(
            "m-0 min-h-0 flex-1 overflow-y-auto",
            (selectedFunction || fullPrdWorkspaceOpen) && "hidden"
          )}
        >
          {manifestLoading ? (
            <div className="flex h-full min-h-[260px] items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin text-primary" />
              正在读取需求空间数据
            </div>
          ) : manifestError ? (
            <div className="flex h-full min-h-[260px] items-center justify-center px-6 text-center">
              <div className="flex max-w-[340px] flex-col items-center gap-3">
                <AlertTriangle className="size-5 text-status-critical" />
                <p className="text-sm leading-5 text-status-critical">{manifestError}</p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8 text-sm"
                  onClick={() => void loadRequirementSpaceManifest()}
                >
                  重新读取
                </Button>
              </div>
            </div>
          ) : !prdGenerationCompleted ? (
            <div className="flex h-full min-h-[260px] items-center justify-center px-6 py-10 text-center">
              <div className="flex max-w-xs flex-col items-center">
                <div className="mb-4 flex size-14 items-center justify-center rounded-full border border-primary/20 bg-primary/10 text-primary">
                  {conversationLoading ? (
                    <Loader2 className="size-6 animate-spin" />
                  ) : (
                    <FileCheck2 className="size-7" strokeWidth={1.7} />
                  )}
                </div>
                <div className="text-sm font-semibold text-foreground">
                  {conversationLoading ? "正在生成规范 PRD" : "规范 PRD 尚未生成"}
                </div>
                <div className="mt-1.5 text-xs leading-5 text-muted-foreground">
                  {conversationLoading
                    ? "Agent 正在整理需求信息并生成规范 PRD，完成后将在这里展示需求信息、功能清单和原型设计入口。"
                    : "完成需求沟通和专家分析后，将在这里生成规范 PRD，并展示功能清单、原型设计与需求空间发布操作。"}
                </div>
              </div>
            </div>
          ) : requirementSpaceManifest ? (
            <div className="space-y-3 bg-[#fbfcfe] p-4">
              <RequirementPrdSummaryCard
                prd={requirementSpaceManifest.prd}
                fallbackName={requirement.title}
                onOpenFile={() =>
                  openWorkspaceFilePreview(normalizePrdFilePath(requirementSpaceManifest.prd.file))
                }
                onRevealFile={() => revealRequirementFile(requirementSpaceManifest.prd.file)}
                onOpenDetails={() => setFullPrdWorkspaceOpen(true)}
              >
                <div className="mt-3 border-t border-border/70 pt-3">
                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/60 bg-background px-3 py-2.5">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h4 className="text-xs font-semibold text-foreground">原型设计</h4>
                        <span
                          className={cn(
                            "inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold",
                            prototypeDesignCompleted
                              ? "bg-status-nominal/10 text-status-nominal"
                              : "bg-muted text-muted-foreground"
                          )}
                        >
                          {hasFullPrdDesignSession
                            ? fullPrdPrototypeGenerated
                              ? "整个需求原型已完成"
                              : "整个需求原型待生成"
                            : `${completedPrototypeCount}/${prototypeStatuses.length} 已完成`}
                        </span>
                      </div>
                      <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
                        {hasFullPrdDesignSession
                          ? "当前按完整 PRD 统一设计原型"
                          : "可以批量设计全部功能，也可以在下方功能清单中逐项设计"}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                      {hasPrototypeDesignState ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-7 gap-1 px-2 text-[11px] text-destructive hover:bg-destructive/10 hover:text-destructive"
                          disabled={batchStarting || clearStarting}
                          onClick={() => {
                            setClearTargetFunction(null)
                            setClearDialogOpen(true)
                          }}
                        >
                          <Trash2 className="size-3" />
                          重置原型
                        </Button>
                      ) : null}
                      <Button
                        type="button"
                        size="sm"
                        className="h-7 gap-1 px-2 text-[11px]"
                        disabled={
                          batchStarting ||
                          (!hasPrototypeDesignSession && prototypeStatuses.length === 0)
                        }
                        onClick={() => {
                          const existingSelections = prototypeStatuses.filter(
                            (item) => item.functionInfo.needDesign === "1" || item.generated
                          )
                          if (hasPrototypeDesignSession) {
                            void runBatchPrototypeDesign(
                              existingSelections.map((item) => item.functionInfo),
                              hasFullPrdDesignSession ? "full-prd" : "functions"
                            )
                            return
                          }
                          setBatchSelection(new Set())
                          setBatchDialogOpen(true)
                        }}
                      >
                        {batchStarting ? (
                          <Loader2 className="size-3 animate-spin" />
                        ) : (
                          <WandSparkles className="size-3" />
                        )}
                        {hasPrototypeDesignSession
                          ? prototypeDesignCompleted
                            ? "查看原型设计"
                            : "继续原型设计"
                          : "批量设计原型"}
                      </Button>
                      {!hasPrototypeDesignSession ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-7 px-2 text-[11px]"
                          disabled={batchStarting}
                          onClick={() => {
                            setBatchDesignMode("functions")
                            setBatchSelection(new Set())
                            setBatchDialogOpen(true)
                          }}
                        >
                          无需设计
                        </Button>
                      ) : null}
                    </div>
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/60 bg-background px-3 py-2.5">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h4 className="text-xs font-semibold text-foreground">需求空间3.0发布</h4>
                      <span
                        className={cn(
                          "inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold",
                          isRequirementSpacePublished(requirementSpaceManifest)
                            ? "bg-status-nominal/10 text-status-nominal"
                            : "bg-[#fff3dc] text-[#d97706]"
                        )}
                      >
                        {isRequirementSpacePublished(requirementSpaceManifest)
                          ? "已发布"
                          : publishRequestQueued
                            ? "发布中"
                            : "待发布"}
                      </span>
                    </div>
                    <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
                      {isRequirementSpacePublished(requirementSpaceManifest)
                        ? "需求已写入需求空间3.0，可进入详情页查看。"
                        : "完成身份验证后，将需求与原型发布到需求空间3.0。"}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                    {!isRequirementSpacePublished(requirementSpaceManifest) ? (
                      <>
                        <TooltipProvider delayDuration={180}>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="inline-flex">
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  disabled={tokenSaving}
                                  className="h-7 gap-1 rounded-md px-2 text-[11px]"
                                  onClick={() => void handleSendLeanstarToken()}
                                >
                                  {tokenSaving ? (
                                    <Loader2 className="size-3 animate-spin" />
                                  ) : (
                                    <KeyRound className="size-3" />
                                  )}
                                  {hasStoredToken ? "发送Token身份令牌" : "获取Token身份令牌"}
                                </Button>
                              </span>
                            </TooltipTrigger>
                            {tokenSaving ? (
                              <TooltipContent
                                side="top"
                                className="max-w-56 text-xs leading-relaxed"
                              >
                                {tokenSaving
                                  ? "身份验证正在处理中，请稍候。"
                                  : "当前正在处理需求，请稍候再进行身份验证。"}
                              </TooltipContent>
                            ) : null}
                          </Tooltip>
                        </TooltipProvider>
                        <TooltipProvider delayDuration={180}>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="inline-flex">
                                <Button
                                  type="button"
                                  size="sm"
                                  disabled={publishRequestQueued}
                                  className="h-7 gap-1 rounded-md px-2 text-[11px]"
                                  onClick={handlePublishToRequirementSpace}
                                >
                                  {publishRequestQueued ? (
                                    <Loader2 className="size-3 animate-spin" />
                                  ) : (
                                    <Send className="size-3" />
                                  )}
                                  {publishRequestQueued ? "发布请求已发送" : "发布到需求空间3.0"}
                                </Button>
                              </span>
                            </TooltipTrigger>
                            {publishRequestQueued ? (
                              <TooltipContent
                                side="top"
                                className="max-w-56 text-xs leading-relaxed"
                              >
                                {publishRequestQueued
                                  ? "发布请求已提交，请稍候。"
                                  : "当前正在处理需求，请稍候再发布。"}
                              </TooltipContent>
                            ) : null}
                          </Tooltip>
                        </TooltipProvider>
                      </>
                    ) : null}
                    {requirementSpaceManifest.prd.prDetailUrl ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-7 gap-1 rounded-md px-2 text-[11px]"
                        title={requirementSpaceManifest.prd.prDetailUrl}
                        onClick={() => {
                          const url = requirementSpaceManifest.prd.prDetailUrl
                          if (url) void window.electron.openExternal(url)
                        }}
                      >
                        <Eye className="size-3 shrink-0" />
                        查看需求详情
                      </Button>
                    ) : null}
                  </div>
                </div>
              </RequirementPrdSummaryCard>

              {fullPrdDesignEntry?.htmlFile && threadId ? (
                <FullPrdPrototypeCard
                  filePath={fullPrdDesignEntry.htmlFile}
                  threadId={threadId}
                  reloadToken={prdPreviewReloadToken}
                  workspacePath={workspacePath}
                  description="基于完整 PRD 生成，不属于某个单独功能"
                />
              ) : null}

              <section>
                <div className="mb-2 flex items-center justify-between gap-3">
                  <h4 className="text-sm font-semibold text-foreground">功能清单</h4>
                  <span className="text-[11px] tabular-nums text-muted-foreground">
                    {hasFullPrdDesignSession
                      ? `${requirementSpaceManifest.functions.length} 项 · 统一包含在整个需求原型中`
                      : `${requirementSpaceManifest.functions.length} 项 · ${generatedPrototypeCount} 原型展示 · ${skippedPrototypeCount} 无需设计`}
                  </span>
                </div>
                {requirementSpaceManifest.functions.length > 0 ? (
                  <div className="space-y-2">
                    {requirementSpaceManifest.functions.map((functionInfo) => {
                      const prototypeStatus = prototypeStatusByFunction.get(
                        getPrototypeFunctionKey(functionInfo)
                      )
                      return (
                        <RequirementFunctionCard
                          key={`${functionInfo.fr}-${functionInfo.file}`}
                          functionInfo={functionInfo}
                          onRevealFile={revealRequirementFile}
                          onPreviewFile={(filePath) =>
                            openWorkspaceFilePreview(normalizePrdFilePath(filePath))
                          }
                          onOpenDetails={
                            functionInfo.file ? () => setSelectedFunction(functionInfo) : undefined
                          }
                          actions={
                            hasFullPrdDesignSession ? (
                              <FullPrdModeFunctionNotice />
                            ) : prototypeStatus?.generated && threadId && !selectedFunction ? (
                              <div className="absolute inset-0 overflow-hidden bg-white">
                                <PrototypeHtmlPreview
                                  filePath={prototypeStatus.prototypePath}
                                  threadId={threadId}
                                  reloadToken={prdPreviewReloadToken}
                                  workspacePath={workspacePath}
                                />
                                <div className="absolute left-1.5 top-1.5 z-10">
                                  <PrototypeScopeBadge scope="function" />
                                </div>
                                <RequirementPrototypeMenu
                                  needDesign={functionInfo.needDesign}
                                  disabled={false}
                                  onChange={(needDesign) =>
                                    updatePrototypeFunctionDesign(functionInfo, needDesign)
                                  }
                                  onDesign={() => {
                                    updatePrototypeFunctionDesign(functionInfo, "1")
                                    requestPrototypeDesign(functionInfo)
                                  }}
                                  onClear={() => {
                                    setClearTargetFunction(functionInfo)
                                    setClearDialogOpen(true)
                                  }}
                                  className="absolute right-1 top-1 z-10 bg-white/90 shadow-sm backdrop-blur-sm"
                                />
                              </div>
                            ) : (
                              <RequirementPrototypeAction
                                needDesign={functionInfo.needDesign}
                                choiceMade={prototypeStatus?.choiceMade ?? false}
                                disabled={false}
                                onChange={(needDesign) =>
                                  updatePrototypeFunctionDesign(functionInfo, needDesign)
                                }
                                onClear={() => {
                                  setClearTargetFunction(functionInfo)
                                  setClearDialogOpen(true)
                                }}
                                onDesign={() => {
                                  updatePrototypeFunctionDesign(functionInfo, "1")
                                  requestPrototypeDesign(functionInfo)
                                }}
                              />
                            )
                          }
                        />
                      )
                    })}
                  </div>
                ) : (
                  <p className="rounded-xl border border-dashed border-border bg-white py-6 text-center text-sm text-muted-foreground">
                    暂无功能数据
                  </p>
                )}
              </section>
            </div>
          ) : (
            <div className="flex h-full min-h-[260px] items-center justify-center text-sm text-muted-foreground">
              暂无需求空间数据
            </div>
          )}
        </TabsContent>
      </Tabs>
      <Dialog
        open={batchDialogOpen}
        onOpenChange={(open) => {
          if (!batchStarting) setBatchDialogOpen(open)
        }}
      >
        <DialogContent className="max-h-[calc(100vh-2rem)] gap-0 overflow-hidden rounded-2xl border-0 p-0 shadow-2xl sm:max-w-[660px]">
          <div className="overflow-y-auto px-7 pb-5 pt-6">
            <DialogHeader className="space-y-0 pr-8">
              <DialogTitle className="text-xl font-bold leading-7 tracking-tight">
                打包设计原型
              </DialogTitle>
              <div className="mt-3 rounded-lg border border-border/70 bg-slate-50/80 px-3.5 py-3">
                <div className="text-sm font-semibold text-foreground">{requirement.title}</div>
                <DialogDescription className="mt-1.5 line-clamp-2 text-xs leading-5 text-muted-foreground">
                  {requirementSpaceManifest?.prd.description?.trim() ||
                    requirement.initialDescription?.trim() ||
                    "暂无需求描述"}
                </DialogDescription>
              </div>
            </DialogHeader>

            <div className="mt-5">
              <h3 className="text-sm font-semibold text-foreground">选择设计模式</h3>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                <button
                  type="button"
                  aria-pressed={batchDesignMode === "functions"}
                  onClick={() => setBatchDesignMode("functions")}
                  className={cn(
                    "rounded-lg border px-3.5 py-3 text-left transition-colors",
                    batchDesignMode === "functions"
                      ? "border-primary bg-primary/[0.06]"
                      : "border-border hover:bg-slate-50"
                  )}
                >
                  <span className="block text-sm font-semibold">按功能分别设计</span>
                  <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                    选择 function，并为每项创建独立会话
                  </span>
                </button>
                <button
                  type="button"
                  aria-pressed={batchDesignMode === "full-prd"}
                  onClick={() => setBatchDesignMode("full-prd")}
                  className={cn(
                    "rounded-lg border px-3.5 py-3 text-left transition-colors",
                    batchDesignMode === "full-prd"
                      ? "border-primary bg-primary/[0.06]"
                      : "border-border hover:bg-slate-50"
                  )}
                >
                  <span className="block text-sm font-semibold">基于完整 PRD 设计</span>
                  <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                    无需选择 function，仅创建一个设计会话
                  </span>
                </button>
              </div>
            </div>

            {batchDesignMode === "functions" ? (
              <div className="mt-5">
                <h3 className="text-sm font-semibold text-foreground">选择需要设计原型的功能</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  默认无需设计；打开开关即需设计原型并创建独立设计会话
                </p>
              </div>
            ) : null}

            {batchDesignMode === "functions" ? (
              <div className="mt-3 max-h-[260px] space-y-2 overflow-y-auto pr-1">
                {prototypeStatuses.map(({ functionInfo }) => {
                  const functionKey = getPrototypeFunctionKey(functionInfo)
                  const checked = batchSelection.has(functionKey)
                  const functionLabel = [functionInfo.fr, functionInfo.name]
                    .filter(Boolean)
                    .join(" ")
                  return (
                    <div
                      key={functionKey}
                      className={cn(
                        "flex min-h-12 items-center gap-3 rounded-lg bg-slate-50 px-3.5 py-2.5 transition-colors hover:bg-slate-100/90",
                        !checked && "text-muted-foreground"
                      )}
                    >
                      <button
                        type="button"
                        role="switch"
                        aria-checked={checked}
                        aria-label={`${checked ? "取消" : "选择"}${functionLabel}进行原型设计`}
                        onClick={() => {
                          setBatchSelection((current) => {
                            const next = new Set(current)
                            if (next.has(functionKey)) next.delete(functionKey)
                            else next.add(functionKey)
                            return next
                          })
                        }}
                        className={cn(
                          "relative inline-flex h-6 w-10 shrink-0 items-center rounded-full transition-colors",
                          checked ? "bg-primary" : "bg-slate-200"
                        )}
                      >
                        <span
                          className={cn(
                            "absolute left-1 size-4 rounded-full bg-white shadow-sm transition-transform",
                            checked && "translate-x-4"
                          )}
                        />
                      </button>
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">
                        {functionLabel}
                        {functionInfo.description?.trim() ? (
                          <span className="font-normal"> · {functionInfo.description.trim()}</span>
                        ) : null}
                      </span>
                      {!checked ? (
                        <span className="shrink-0 text-xs font-normal text-muted-foreground">
                          无需设计
                        </span>
                      ) : null}
                    </div>
                  )
                })}
              </div>
            ) : null}

            <div className="mt-3 rounded-lg bg-primary/[0.09] px-3.5 py-2.5 text-xs font-medium text-primary">
              {batchDesignMode === "full-prd"
                ? "将传入完整 PRD，并创建 1 个设计会话"
                : `已选 ${batchSelection.size} 个功能 · 确认后将创建 ${batchSelection.size} 个设计会话${batchSelection.size > 0 ? "，默认激活第 1 个" : ""}`}
            </div>
            <div className="mt-3 flex gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-xs leading-5 text-amber-900">
              <Info className="mt-0.5 size-3.5 shrink-0" />
              <span>
                温馨提示：如有与设计原型相关的文件（例如模板、参考图或 URL
                链接），可在跳转到设计会话后再手动上传。
              </span>
            </div>
          </div>
          <DialogFooter className="items-center border-t border-border/70 px-7 py-4 sm:justify-between sm:space-x-4">
            <p className="text-xs text-muted-foreground">
              确认后直接跳转设计模式；再次点击不再弹窗
            </p>
            <div className="flex shrink-0 items-center gap-3">
              <Button
                type="button"
                variant="secondary"
                className="h-9 px-4 text-sm font-medium"
                disabled={batchStarting}
                onClick={() => setBatchDialogOpen(false)}
              >
                取消
              </Button>
              <Button
                type="button"
                className="h-9 px-5 text-sm font-semibold"
                disabled={batchStarting}
                onClick={() => {
                  const selectedFunctions = prototypeStatuses
                    .filter((item) =>
                      batchSelection.has(getPrototypeFunctionKey(item.functionInfo))
                    )
                    .map((item) => item.functionInfo)
                  void runBatchPrototypeDesign(selectedFunctions, batchDesignMode).then(
                    (started) => {
                      if (started) setBatchDialogOpen(false)
                    }
                  )
                }}
              >
                {batchStarting ? <Loader2 className="size-3.5 animate-spin" /> : null}
                {batchDesignMode === "full-prd"
                  ? "基于完整 PRD 开始设计"
                  : batchSelection.size > 0
                    ? `开始设计 · ${batchSelection.size} 个会话`
                    : "确认均无需设计"}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={clearDialogOpen}
        onOpenChange={(open) => {
          if (!clearStarting) setClearDialogOpen(open)
        }}
      >
        <DialogContent className="rounded-2xl sm:max-w-[460px]">
          <DialogHeader>
            <DialogTitle>
              {clearTargetFunction ? "确认重置这个功能的设计？" : "确认重置全部设计？"}
            </DialogTitle>
            <DialogDescription className="pt-2 leading-6">
              {clearTargetFunction
                ? "重置后，你可以重新生成这个功能的设计原型；之前的设计会话和历史记录都会被删除。"
                : "重置后，你可以重新生成设计原型；之前的所有设计会话和历史记录都会被删除。"}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="secondary"
              disabled={clearStarting}
              onClick={() => setClearDialogOpen(false)}
            >
              取消
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={clearStarting}
              onClick={() => {
                setClearStarting(true)
                void Promise.resolve(
                  clearTargetFunction
                    ? clearPrototypeFunction(clearTargetFunction)
                    : clearPrototypeDesign()
                )
                  .then(() => {
                    setClearDialogOpen(false)
                    toast.success("设计已重置")
                  })
                  .catch((error) => {
                    console.error("[RequirementDetailsPanel] Failed to clear design:", error)
                    toast.error(error instanceof Error ? error.message : "重置设计失败")
                  })
                  .finally(() => setClearStarting(false))
              }}
            >
              {clearStarting ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Trash2 className="size-3.5" />
              )}
              确认重置
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </aside>
  )
}
