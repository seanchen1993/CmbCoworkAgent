import { useMemo, useRef, useState } from "react"
import { ArrowLeft, ChevronLeft, ChevronRight, FileText, Loader2, RefreshCw } from "lucide-react"

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import type { ActiveRequirementDesignEntry } from "./use-requirement-design-entry"
import {
  listRequirementDesignEntries,
  returnToRequirementConversation
} from "@/lib/requirement-design-entry"
import { openResourcePanelOverlay } from "@/lib/resource-panel-overlay-events"
import type { SessionMeta } from "./types"
import { getDesignSessionClient } from "./session-client"

export function RequirementDesignContextBar({
  entry,
  html,
  htmlId,
  artifactPath,
  artifactMetadata,
  disabledReason,
  onEntryChange,
  onOpenSession,
  sessions,
  showToast
}: {
  entry: ActiveRequirementDesignEntry
  html: string
  htmlId: string
  artifactPath?: string | null
  artifactMetadata?: Record<string, unknown> | null
  disabledReason?: string
  onEntryChange: (entry: ActiveRequirementDesignEntry) => void
  onOpenSession: (sessionId: string) => void
  sessions: SessionMeta[]
  showToast: (message: string) => void
}): React.JSX.Element {
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const sessionListRef = useRef<HTMLDivElement>(null)
  const requirementName = entry.requirementName?.trim() || "未命名需求"
  const designEntries = useMemo(
    () => listRequirementDesignEntries(entry.requirementId, localStorage, entry.htmlId),
    [entry]
  )
  const sessionStates = useMemo(
    () => new Map(sessions.map((session) => [session.id, session.generationState])),
    [sessions]
  )
  const completedCount = designEntries.filter((designEntry) => designEntry.htmlFile?.trim()).length
  const progress =
    designEntries.length > 0 ? Math.round((completedCount / designEntries.length) * 100) : 0
  const effectiveDisabledReason = saving ? "正在同步设计，请稍候" : disabledReason

  const previewButton = (filePath: string | undefined, title: string): React.JSX.Element => (
    <button
      type="button"
      disabled={!filePath || !entry.previewThreadId}
      onClick={() => {
        if (!filePath || !entry.previewThreadId) return
        openResourcePanelOverlay("preview", {
          filePreview: {
            threadId: entry.previewThreadId,
            filePath,
            workspacePathKind: "absolute"
          }
        })
      }}
      aria-label={`预览${title}`}
      title={filePath ? `在右侧预览${title}` : `暂无${title}文件`}
      className="inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary disabled:cursor-not-allowed disabled:opacity-40"
    >
      <FileText className="size-3" />
    </button>
  )

  const save = async (): Promise<void> => {
    if (savingRef.current) return
    savingRef.current = true
    setSaving(true)
    try {
      if (!html.trim()) throw new Error("请先生成设计内容")
      if (!htmlId) throw new Error("设计会话尚未就绪")

      const artifactId = `${htmlId}_design-main`
      let result = artifactPath
        ? await window.api.design.saveArtifactFile(
            artifactPath,
            html,
            entry.workspacePath,
            artifactMetadata ?? undefined
          )
        : await window.api.design.saveArtifact(
            artifactId,
            html,
            entry.workspacePath,
            artifactMetadata ?? undefined
          )
      if (!result.success && artifactPath) {
        result = await window.api.design.saveArtifact(
          artifactId,
          html,
          entry.workspacePath,
          artifactMetadata ?? undefined
        )
      }
      const htmlFile = result.filePath?.trim()
      if (!result.success || !htmlFile) throw new Error(result.error || "保存设计文件失败")

      await window.api.design.storeHtml(artifactId, html)
      await getDesignSessionClient().patch(htmlId, { artifactPath: htmlFile })
      const synced = await window.api.requirements.updateFunctionHtml({
        reqId: entry.requirementId,
        workspacePath: entry.workspacePath,
        requirementFilePath: entry.requirementFilePath,
        htmlFile,
        htmlId
      })
      if (!synced.success) throw new Error(synced.error || "同步需求 Manifest 失败")
      onEntryChange({ ...entry, htmlId, htmlFile, bindingReady: true })
      showToast("设计已保存并同步到需求 Manifest")
    } catch (error) {
      showToast(error instanceof Error ? error.message : "保存需求设计失败")
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  return (
    <div className="relative z-10 flex h-[58px] shrink-0 items-center border-y border-b-slate-300 border-t-border/70 bg-slate-50/95 px-3 shadow-[0_3px_10px_rgba(15,23,42,0.10)]">
      <div className="w-52 shrink-0 pr-3">
        <div className="flex items-center gap-1.5">
          <strong className="min-w-0 truncate text-xs font-semibold text-foreground ml-1.5">
            {requirementName}
          </strong>
          {previewButton(entry.requirementOverviewFilePath, "需求文件")}
        </div>
        <div className="mt-0.5 flex w-full items-center text-[10px]">
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex w-full cursor-help items-center gap-1.5 rounded  px-1.5 py-0.5 font-medium text-orange-500">
                  <span>设计进度</span>
                  <span
                    role="progressbar"
                    aria-label="设计进度"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={progress}
                    className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-orange-200"
                  >
                    <span
                      className="block h-full rounded-full bg-orange-500 transition-[width] duration-300"
                      style={{ width: `${progress}%` }}
                    />
                  </span>
                  <span className="tabular-nums">{progress}%</span>
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-64">
                <p>
                  已完成 {completedCount}/{designEntries.length} 个功能模块
                </p>
                <p>计算方式：已同步模块数 ÷ 模块总数 × 100%</p>
                <p>设计成功同步到需求后，该模块才计为完成。</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </div>

      <div className="flex min-w-0 flex-1 items-center gap-1.5 border-l border-border/70 pl-2.5">
        <button
          type="button"
          onClick={() => sessionListRef.current?.scrollBy({ left: -260, behavior: "smooth" })}
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label="查看前面的设计会话"
        >
          <ChevronLeft className="size-3.5" />
        </button>
        <div ref={sessionListRef} className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto py-1">
          {designEntries.map((designEntry) => {
            const active = designEntry.htmlId === entry.htmlId
            const completed = Boolean(designEntry.htmlFile?.trim())
            const generationState = sessionStates.get(designEntry.htmlId)
            const generating =
              generationState === "generating" ||
              generationState === "asking" ||
              generationState === "questions_ready" ||
              generationState === "waiting_approval"
            const statusLabel = completed
              ? "已完成"
              : generating
                ? "生成中"
                : generationState === "done"
                  ? "待同步"
                  : "待设计"
            return (
              <div
                key={designEntry.htmlId}
                className={`flex h-8 max-w-52 shrink-0 items-center rounded-md border bg-white shadow-sm transition-colors ${
                  active ? "border-orange-400" : "border-border"
                }`}
              >
                <button
                  type="button"
                  onClick={() => onOpenSession(designEntry.htmlId)}
                  className="flex min-w-0 items-center gap-1.5 pl-2.5"
                  title={designEntry.functionName || "未命名功能"}
                >
                  <span className="relative flex size-2 shrink-0">
                    {generating ? (
                      <span className="absolute inline-flex size-full animate-ping rounded-full bg-orange-400 opacity-60" />
                    ) : null}
                    <span
                      className={`relative inline-flex size-2 rounded-full ${
                        completed
                          ? "bg-emerald-500"
                          : generating
                            ? "animate-pulse bg-orange-500"
                            : "bg-slate-400"
                      }`}
                    />
                  </span>
                  <span className="truncate text-[11px] font-medium text-foreground">
                    {designEntry.functionName || "未命名功能"}
                  </span>
                </button>
                <span className="ml-1.5 flex shrink-0 items-center gap-1 pr-2">
                  {previewButton(designEntry.requirementFilePath, "功能文件")}
                  <span
                    className={`text-[10px] font-medium ${
                      completed
                        ? "text-emerald-600"
                        : generating
                          ? "animate-pulse text-orange-500"
                          : "text-muted-foreground"
                    }`}
                  >
                    {statusLabel}
                  </span>
                </span>
              </div>
            )
          })}
        </div>
        <button
          type="button"
          onClick={() => sessionListRef.current?.scrollBy({ left: 260, behavior: "smooth" })}
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label="查看更多设计会话"
        >
          <ChevronRight className="size-3.5" />
        </button>
      </div>

      <div className="ml-2.5 flex shrink-0 items-center gap-1.5 border-l border-border/70 pl-2.5">
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                tabIndex={effectiveDisabledReason ? 0 : -1}
                className={
                  effectiveDisabledReason ? "inline-flex cursor-not-allowed" : "inline-flex"
                }
              >
                <button
                  type="button"
                  disabled={Boolean(effectiveDisabledReason)}
                  onClick={() => void save()}
                  className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md bg-primary px-2.5 text-[11px] font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-55"
                >
                  {saving ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="size-3" />
                  )}
                  {saving ? "同步中..." : "同步到需求"}
                </button>
              </span>
            </TooltipTrigger>
            {effectiveDisabledReason ? (
              <TooltipContent side="bottom">{effectiveDisabledReason}</TooltipContent>
            ) : null}
          </Tooltip>
        </TooltipProvider>
        <button
          type="button"
          onClick={() => returnToRequirementConversation(entry.requirementId)}
          className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md border border-border bg-white px-2.5 text-[11px] font-medium text-foreground shadow-sm transition-colors hover:bg-muted"
        >
          <ArrowLeft className="size-3" />
          返回需求
        </button>
      </div>
    </div>
  )
}
