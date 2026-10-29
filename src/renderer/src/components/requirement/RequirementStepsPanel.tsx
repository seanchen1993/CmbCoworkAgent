import { useEffect, useState } from "react"
import { toast } from "sonner"
import {
  AlertTriangle,
  Brain,
  CheckCircle2,
  ChevronRight,
  Eye,
  FileText,
  KeyRound,
  Loader2,
  PanelRightClose,
  RotateCcw,
  Send
} from "lucide-react"
import { SubagentStreamPanel } from "@/components/chat/SubagentStreamPanel"
import { Button } from "@/components/ui/button"
import { HtmlThumbnailPreview } from "@/components/ui/html-thumbnail-preview"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { assembleBoundedTextPreview } from "@/lib/text-preview-pages"
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

export type RequirementPreviewTab =
  | "expert-process"
  | "source"
  | "prd"
  | "prototype"
  | "requirement-space"
export type RequirementPrototypeStatus = {
  functionInfo: RequirementPrdManifest["functions"][number]
  prototypePath: string
  generated: boolean
  skipped: boolean
  complete: boolean
  choiceMade: boolean
}

type RequirementStepsPanelProps = {
  requirement: RequirementRecord
  manifest: RequirementPrdManifest | null
  prototypeStatuses: RequirementPrototypeStatus[]
  previewTab: RequirementPreviewTab
  prototypeRoute: "design" | "skip" | null
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
  expertAnalysisStarted: boolean
  expertAnalysisCompleted: boolean
  expertProcessRunning: boolean
  prdGenerationCompleted: boolean
  prototypeStepEnabled: boolean
  prototypeStepCompleted: boolean
  requirementSpaceStepEnabled: boolean
  requirementSpacePublished: boolean
  allPrototypeFunctionsCompleted: boolean
  completedPrototypeCount: number
  generatedPrototypeCount: number
  skippedPrototypeCount: number
  prdFileCount: number
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
  onChoosePrototypeRoute: (route: "design" | "skip") => void
  onRevealRequirementFile: (filePath: string) => void
  onRequestPrototypeDesign: (functionInfo: RequirementPrdManifest["functions"][number]) => void
  onUpdatePrototypeFunctionDesign: (
    functionInfo: RequirementPrdManifest["functions"][number],
    needDesign: NeedDesignChoice
  ) => void
  onCompletePrototypeDesign: () => Promise<void>
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

export function RequirementStepsPanel({
  requirement,
  manifest: requirementSpaceManifest,
  prototypeStatuses,
  previewTab,
  prototypeRoute,
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
  expertAnalysisStarted,
  expertAnalysisCompleted,
  expertProcessRunning,
  prdGenerationCompleted,
  prototypeStepEnabled,
  prototypeStepCompleted,
  requirementSpaceStepEnabled,
  requirementSpacePublished,
  allPrototypeFunctionsCompleted,
  completedPrototypeCount,
  generatedPrototypeCount,
  skippedPrototypeCount,
  prdFileCount,
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
  onChoosePrototypeRoute: choosePrototypeRoute,
  onRevealRequirementFile: revealRequirementFile,
  onRequestPrototypeDesign: requestPrototypeDesign,
  onUpdatePrototypeFunctionDesign: updatePrototypeFunctionDesign,
  onCompletePrototypeDesign: completePrototypeDesign,
  onPublishToRequirementSpace: handlePublishToRequirementSpace,
  onSendLeanstarToken: handleSendLeanstarToken
}: RequirementStepsPanelProps): React.JSX.Element {
  const [selectedFunction, setSelectedFunction] = useState<
    RequirementPrdManifest["functions"][number] | null
  >(null)
  const selectedPrototypeStatus = selectedFunction
    ? prototypeStatuses.find(
        (item) =>
          getPrototypeFunctionKey(item.functionInfo) === getPrototypeFunctionKey(selectedFunction)
      )
    : undefined

  useEffect(() => {
    onFunctionWorkspaceChange(Boolean(selectedFunction))
  }, [onFunctionWorkspaceChange, selectedFunction])

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
            value === "expert-process"
              ? "expert-process"
              : value === "prd"
                ? "prd"
                : value === "prototype"
                  ? "prototype"
                  : value === "requirement-space"
                    ? "requirement-space"
                    : "source"
          onPreviewTabChange(nextTab)
          setSelectedFunction(null)
          if (nextTab === "expert-process") {
            onFocusExpertProcess()
          }
        }}
        className="flex min-h-0 flex-1 flex-col"
      >
        {!selectedFunction ? (
          <div className="flex shrink-0 items-start justify-between gap-2 border-b border-border/70 bg-white px-3 shadow-[0_1px_0_rgba(15,23,42,0.02)]">
            <TabsList
              aria-label="需求处理步骤"
              className="grid h-[76px] min-w-0 flex-1 grid-cols-5 rounded-none bg-transparent p-0"
            >
              {[
                {
                  value: "source",
                  number: 1,
                  label: "提供需求",
                  enabled: true,
                  complete: expertAnalysisStarted,
                  connectorComplete: false,
                  active: previewTab === "source",
                  running: false
                },
                {
                  value: "expert-process",
                  number: 2,
                  label: "Agent分析",
                  enabled: expertAnalysisStarted,
                  complete: expertAnalysisCompleted,
                  connectorComplete: expertAnalysisStarted,
                  active: previewTab === "expert-process",
                  running: previewTab === "expert-process" && expertProcessRunning
                },
                {
                  value: "prd",
                  number: 3,
                  label: "规范PRD",
                  enabled: prdGenerationCompleted,
                  complete: prdGenerationCompleted,
                  connectorComplete: prdGenerationCompleted,
                  active: previewTab === "prd",
                  running: false
                },
                {
                  value: "prototype",
                  number: 4,
                  label: "原型设计",
                  enabled: prototypeStepEnabled,
                  complete: prototypeStepCompleted,
                  connectorComplete: prototypeStepEnabled,
                  active: previewTab === "prototype",
                  running: previewTab === "prototype" && !prototypeStepCompleted
                },
                {
                  value: "requirement-space",
                  number: 5,
                  label: "发布需求空间3.0",
                  enabled: requirementSpaceStepEnabled,
                  complete: requirementSpacePublished,
                  connectorComplete: requirementSpaceStepEnabled,
                  active: previewTab === "requirement-space",
                  running: previewTab === "requirement-space" && !requirementSpacePublished
                }
              ].map((step, index) => (
                <div key={step.value} className="relative flex min-w-0 items-start justify-center">
                  {index > 0 ? (
                    <span
                      className={cn(
                        "absolute left-0 right-[calc(50%+24px)] top-6 h-[2px] -translate-y-1/2",
                        step.connectorComplete ? "bg-primary/75" : "bg-slate-200"
                      )}
                    />
                  ) : null}
                  {index < 4 ? (
                    <span
                      className={cn(
                        "absolute left-[calc(50%+24px)] right-0 top-6 h-[2px] -translate-y-1/2",
                        step.complete ? "bg-primary/75" : "bg-slate-200"
                      )}
                    />
                  ) : null}
                  <TabsTrigger
                    value={step.value}
                    disabled={!step.enabled}
                    aria-label={`步骤 ${step.number}：${step.label}${!step.enabled ? "，尚未解锁" : ""}`}
                    className="group relative z-10 flex h-[72px] min-w-0 flex-col justify-start gap-1.5 rounded-none bg-transparent px-1 pt-2.5 text-xs font-semibold text-slate-400 shadow-none transition-colors data-[state=active]:bg-transparent data-[state=active]:text-primary data-[state=active]:shadow-none disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <span
                      className={cn(
                        "relative flex size-7 items-center justify-center rounded-full border-2 bg-white text-[11px] font-semibold transition-all",
                        step.complete
                          ? "border-primary bg-primary text-primary-foreground"
                          : step.enabled
                            ? "border-primary bg-white text-primary"
                            : "border-slate-100 bg-slate-100 text-slate-400"
                      )}
                    >
                      {step.running ? (
                        <span className="absolute -inset-1 rounded-full border-2 border-transparent border-t-primary border-r-primary/40 motion-safe:animate-spin" />
                      ) : null}
                      {step.number}
                    </span>
                    <span
                      className={cn(
                        "max-w-full truncate leading-4",
                        step.complete && !step.active && "text-foreground"
                      )}
                    >
                      {step.label}
                    </span>
                  </TabsTrigger>
                </div>
              ))}
            </TabsList>
            <div className="flex shrink-0 items-center gap-0.5">
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

        {selectedFunction ? (
          <RequirementFunctionWorkspace
            requirement={requirement}
            functionInfo={selectedFunction}
            filePath={normalizePrdFilePath(selectedFunction.file)}
            threadId={threadId}
            prototypeGenerated={selectedPrototypeStatus?.generated ?? false}
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
              ) : undefined
            }
            reloadToken={prdPreviewReloadToken}
            conversationLoading={conversationLoading}
            onBack={() => setSelectedFunction(null)}
            onRequestPrototypeDesign={() => {
              if (selectedPrototypeStatus?.skipped) {
                updatePrototypeFunctionDesign(selectedFunction, "1")
              }
              requestPrototypeDesign(selectedFunction)
            }}
          />
        ) : null}

        <TabsContent
          value="expert-process"
          className={cn("m-0 min-h-0 flex-1 overflow-hidden", selectedFunction && "hidden")}
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
          className={cn("m-0 min-h-0 flex-1 overflow-y-auto", selectedFunction && "hidden")}
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
          className={cn("m-0 flex min-h-0 flex-1 flex-col", selectedFunction && "hidden")}
        >
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto bg-[#fbfcfe] p-4">
            <div className="flex min-h-5 items-center gap-3">
              <h2 className="text-sm font-semibold leading-5 text-foreground">规范 PRD</h2>
              <p className="text-xs leading-4 text-muted-foreground">
                PRD 已生成，可进入功能详情查看
              </p>
              <span className="ml-auto rounded-full bg-status-info/10 px-2 py-0.5 text-[11px] font-medium text-status-info">
                PRD 已生成
              </span>
            </div>

            {requirementSpaceManifest ? (
              <RequirementPrdSummaryCard
                prd={requirementSpaceManifest.prd}
                fallbackName={requirement.title}
                onOpenFile={() =>
                  openWorkspaceFilePreview(normalizePrdFilePath(requirementSpaceManifest.prd.file))
                }
                onRevealFile={() => revealRequirementFile(requirementSpaceManifest.prd.file)}
              >
                <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-border/70 pt-3">
                  <div>
                    <h4 className="text-xs font-semibold text-foreground">
                      {prototypeRoute || requirementSpacePublished
                        ? "原型路径已选择"
                        : "下一步：是否需要设计原型？"}
                    </h4>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      {prototypeRoute === "design"
                        ? "已选择“需要设计原型”，当前流程进入原型设计步骤。"
                        : prototypeRoute === "skip"
                          ? "已选择“无需设计原型”，原型设计步骤已标记为完成。"
                          : requirementSpacePublished
                            ? "当前流程已经进入发布阶段，原型路径不可重新选择。"
                            : "选择后将进入对应步骤；跳过原型时，原型设计步骤会直接标记为完成。"}
                    </p>
                  </div>
                  {prototypeRoute === null && !requirementSpacePublished ? (
                    <div className="flex shrink-0 items-center gap-2">
                      <Button
                        type="button"
                        size="sm"
                        className="h-8"
                        onClick={() => choosePrototypeRoute("design")}
                      >
                        需要设计原型
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-8 bg-white"
                        onClick={() => choosePrototypeRoute("skip")}
                      >
                        无需设计原型
                      </Button>
                    </div>
                  ) : (
                    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-status-nominal/25 bg-status-nominal/10 px-3 py-1.5 text-xs font-semibold text-status-nominal">
                      <CheckCircle2 className="size-3.5" />
                      {prototypeRoute === "design"
                        ? "已选择：需要设计原型"
                        : prototypeRoute === "skip"
                          ? "已选择：无需设计原型"
                          : "已进入发布阶段"}
                    </span>
                  )}
                </div>
              </RequirementPrdSummaryCard>
            ) : null}

            <section>
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-foreground">功能清单</h3>
                <span className="text-[11px] text-muted-foreground">
                  {requirementSpaceManifest?.functions.length ?? 0} 项
                </span>
              </div>
              <div className="space-y-2">
                {(requirementSpaceManifest?.functions ?? []).map((functionInfo) => (
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
                  />
                ))}
                {(requirementSpaceManifest?.functions.length ?? 0) === 0 ? (
                  <div className="rounded-xl border border-dashed border-border bg-white px-4 py-8 text-center text-sm text-muted-foreground">
                    {prdFileCount > 0 ? "正在读取 PRD 功能清单" : "暂无功能数据"}
                  </div>
                ) : null}
              </div>
            </section>
          </div>
        </TabsContent>

        <TabsContent
          value="prototype"
          className={cn(
            "m-0 min-h-0 flex-1 overflow-y-auto bg-[#fbfcfe] p-4",
            selectedFunction && "hidden"
          )}
        >
          <div className="space-y-3">
            <div className="flex min-h-5 items-center gap-3">
              <h2 className="text-sm font-semibold leading-5 text-foreground">原型设计</h2>
              <p className="text-xs leading-4 text-muted-foreground">
                按功能逐个设计原型，支持查看设计状态
              </p>
            </div>
            {requirementSpaceManifest ? (
              <RequirementPrdSummaryCard
                prd={requirementSpaceManifest.prd}
                fallbackName={requirement.title}
                onOpenFile={() =>
                  openWorkspaceFilePreview(normalizePrdFilePath(requirementSpaceManifest.prd.file))
                }
                onRevealFile={() => revealRequirementFile(requirementSpaceManifest.prd.file)}
              >
                <div className="mt-3 flex items-center justify-between gap-3 border-t border-border/70 pt-3">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h4 className="text-xs font-semibold text-foreground">原型设计进度</h4>
                      <span
                        className={cn(
                          "inline-flex rounded-full px-2.5 py-1 text-[11px] font-semibold",
                          allPrototypeFunctionsCompleted
                            ? "bg-status-nominal/10 text-status-nominal"
                            : "bg-[#fff3dc] text-[#d97706]"
                        )}
                      >
                        {completedPrototypeCount}/{prototypeStatuses.length} 已设计
                        {!allPrototypeFunctionsCompleted ? " · 步骤未完成" : " · 已完成"}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      全部功能“已设计”或“无需原型设计”后，本步骤才算完成
                    </p>
                  </div>
                  {!allPrototypeFunctionsCompleted ? (
                    <Button
                      type="button"
                      size="sm"
                      disabled={
                        conversationLoading || !prototypeStatuses.some((item) => !item.complete)
                      }
                      onClick={() => {
                        const nextFunction = prototypeStatuses.find((item) => !item.complete)
                        if (nextFunction) requestPrototypeDesign(nextFunction.functionInfo)
                      }}
                    >
                      批量设计全部原型
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      size="sm"
                      disabled={conversationLoading}
                      onClick={() => {
                        void completePrototypeDesign().catch((error) => {
                          console.error(
                            "[RequirementConversation] Failed to complete prototype step:",
                            error
                          )
                          toast.error("保存原型设计完成状态失败")
                        })
                      }}
                    >
                      已完成原型设计
                    </Button>
                  )}
                </div>
              </RequirementPrdSummaryCard>
            ) : null}
            <section>
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-foreground">功能清单</h3>
                <span className="text-[11px] text-muted-foreground">
                  {prototypeStatuses.length} 项 · {completedPrototypeCount} 已设计 ·{" "}
                  {prototypeStatuses.length - completedPrototypeCount} 待设计
                </span>
              </div>
              <div className="space-y-2">
                {prototypeStatuses.map(({ functionInfo, prototypePath, generated, choiceMade }) => (
                  <RequirementFunctionCard
                    key={`prototype-${functionInfo.fr}`}
                    functionInfo={functionInfo}
                    onRevealFile={revealRequirementFile}
                    onPreviewFile={(filePath) =>
                      openWorkspaceFilePreview(normalizePrdFilePath(filePath))
                    }
                    onOpenDetails={
                      functionInfo.file ? () => setSelectedFunction(functionInfo) : undefined
                    }
                    actions={
                      generated && threadId && !selectedFunction ? (
                        <div className="absolute inset-0 overflow-hidden bg-white">
                          <PrototypeHtmlPreview
                            filePath={prototypePath}
                            threadId={threadId}
                            reloadToken={prdPreviewReloadToken}
                            workspacePath={workspacePath}
                          />
                          <RequirementPrototypeMenu
                            needDesign={functionInfo.needDesign}
                            disabled={conversationLoading}
                            onChange={(needDesign) =>
                              updatePrototypeFunctionDesign(functionInfo, needDesign)
                            }
                            onDesign={() => {
                              updatePrototypeFunctionDesign(functionInfo, "1")
                              requestPrototypeDesign(functionInfo)
                            }}
                            className="absolute right-1 top-1 z-10 bg-white/90 shadow-sm backdrop-blur-sm"
                          />
                        </div>
                      ) : (
                        <RequirementPrototypeAction
                          needDesign={functionInfo.needDesign}
                          choiceMade={choiceMade}
                          disabled={conversationLoading}
                          onChange={(needDesign) =>
                            updatePrototypeFunctionDesign(functionInfo, needDesign)
                          }
                          onDesign={() => {
                            updatePrototypeFunctionDesign(functionInfo, "1")
                            requestPrototypeDesign(functionInfo)
                          }}
                        />
                      )
                    }
                  />
                ))}
                {prototypeStatuses.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-border bg-white px-4 py-8 text-center text-sm text-muted-foreground">
                    暂无可设计的功能
                  </div>
                ) : null}
              </div>
            </section>
          </div>
        </TabsContent>

        <TabsContent
          value="requirement-space"
          className={cn("m-0 min-h-0 flex-1 overflow-y-auto", selectedFunction && "hidden")}
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
          ) : requirementSpaceManifest ? (
            <div className="space-y-3 bg-[#fbfcfe] p-4">
              <div className="flex min-h-5 items-center gap-3">
                <h2 className="text-sm font-semibold leading-5 text-foreground">发布需求空间3.0</h2>
                <p className="text-xs leading-4 text-muted-foreground">
                  发布后写入需求空间，供研发与测试查阅
                </p>
              </div>
              <RequirementPrdSummaryCard
                prd={requirementSpaceManifest.prd}
                fallbackName={requirement.title}
                onOpenFile={() =>
                  openWorkspaceFilePreview(normalizePrdFilePath(requirementSpaceManifest.prd.file))
                }
                onRevealFile={() => revealRequirementFile(requirementSpaceManifest.prd.file)}
              >
                <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-border/70 pt-3">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h4 className="text-xs font-semibold text-foreground">需求空间发布状态</h4>
                      <span
                        className={cn(
                          "inline-flex rounded-full px-2.5 py-1 text-[11px] font-semibold",
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
                    <p className="mt-1 text-xs text-muted-foreground">
                      {isRequirementSpacePublished(requirementSpaceManifest)
                        ? "需求已写入需求空间3.0，可进入详情页查看。"
                        : "完成身份验证后，将需求与原型发布到需求空间3.0。"}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
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
                                  disabled={conversationLoading || tokenSaving}
                                  className="h-8 gap-1.5 rounded-[7px] px-3 text-sm"
                                  onClick={() => void handleSendLeanstarToken()}
                                >
                                  {tokenSaving ? (
                                    <Loader2 className="size-3.5 animate-spin" />
                                  ) : (
                                    <KeyRound className="size-3.5" />
                                  )}
                                  {hasStoredToken ? "发送Token身份令牌" : "获取Token身份令牌"}
                                </Button>
                              </span>
                            </TooltipTrigger>
                            {conversationLoading || tokenSaving ? (
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
                                  disabled={publishRequestQueued || conversationLoading}
                                  className="h-8 gap-1.5 rounded-[7px] px-3 text-sm"
                                  onClick={handlePublishToRequirementSpace}
                                >
                                  {publishRequestQueued ? (
                                    <Loader2 className="size-3.5 animate-spin" />
                                  ) : (
                                    <Send className="size-3.5" />
                                  )}
                                  {publishRequestQueued ? "发布请求已发送" : "发布到需求空间3.0"}
                                </Button>
                              </span>
                            </TooltipTrigger>
                            {publishRequestQueued || conversationLoading ? (
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
                        className="h-8 gap-1.5 rounded-[7px] px-3 text-sm"
                        title={requirementSpaceManifest.prd.prDetailUrl}
                        onClick={() => {
                          const url = requirementSpaceManifest.prd.prDetailUrl
                          if (url) void window.electron.openExternal(url)
                        }}
                      >
                        <Eye className="size-3.5 shrink-0" />
                        查看需求详情
                      </Button>
                    ) : null}
                  </div>
                </div>
              </RequirementPrdSummaryCard>

              <section>
                <div className="mb-2 flex items-center justify-between gap-3">
                  <h4 className="text-sm font-semibold text-foreground">功能清单</h4>
                  <span className="text-[11px] tabular-nums text-muted-foreground">
                    {requirementSpaceManifest.functions.length} 项 · {generatedPrototypeCount}{" "}
                    原型展示 · {skippedPrototypeCount} 无需设计
                  </span>
                </div>
                {requirementSpaceManifest.functions.length > 0 ? (
                  <div className="space-y-2">
                    {requirementSpaceManifest.functions.map((functionInfo) => {
                      const prototypeStatus = prototypeStatuses.find(
                        (item) =>
                          getPrototypeFunctionKey(item.functionInfo) ===
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
                            prototypeStatus?.generated && threadId && !selectedFunction ? (
                              <div className="absolute inset-0 overflow-hidden bg-white">
                                <PrototypeHtmlPreview
                                  filePath={prototypeStatus.prototypePath}
                                  threadId={threadId}
                                  reloadToken={prdPreviewReloadToken}
                                  workspacePath={workspacePath}
                                />
                                <RequirementPrototypeMenu
                                  needDesign={functionInfo.needDesign}
                                  disabled={conversationLoading}
                                  onChange={(needDesign) =>
                                    updatePrototypeFunctionDesign(functionInfo, needDesign)
                                  }
                                  onDesign={() => {
                                    updatePrototypeFunctionDesign(functionInfo, "1")
                                    requestPrototypeDesign(functionInfo)
                                  }}
                                  className="absolute right-1 top-1 z-10 bg-white/90 shadow-sm backdrop-blur-sm"
                                />
                              </div>
                            ) : (
                              <RequirementPrototypeAction
                                needDesign={functionInfo.needDesign}
                                choiceMade={prototypeStatus?.choiceMade ?? false}
                                disabled={conversationLoading}
                                onChange={(needDesign) =>
                                  updatePrototypeFunctionDesign(functionInfo, needDesign)
                                }
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
    </aside>
  )
}
